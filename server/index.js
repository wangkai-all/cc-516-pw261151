'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, now, audit } = require('./db');
const { computeEvaluation, canonical, MISSING_GROUP } = require('./metrics');
const { detectAnomalies, RULES } = require('./anomaly');
const { checkAll } = require('./constraints');
const { getUser, requireRole, HttpError } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------- 评估核心：取数 → 计算 → 持久化快照（事务） ----------

function loadSamples(db, datasetId, versions, timeStart, timeEnd) {
  const clauses = ['dataset_id = ?'];
  const args = [datasetId];
  if (timeStart) { clauses.push('ts >= ?'); args.push(timeStart); }
  if (timeEnd) { clauses.push('ts <= ?'); args.push(timeEnd); }
  const rows = db
    .prepare(`SELECT * FROM samples WHERE ${clauses.join(' AND ')} ORDER BY id`)
    .all(...args);
  const vset = new Set(versions);
  return rows.filter((r) => vset.has(r.version));
}

function runEvaluation(db, cfg, user) {
  // cfg: { name, dataset_id, versions, baseline, time_start, time_end, missing_label_policy, constraints, replay_of }
  const samples = loadSamples(db, cfg.dataset_id, cfg.versions, cfg.time_start, cfg.time_end);
  if (samples.length === 0) throw new HttpError(400, '时间窗口内没有匹配所选版本的样本');

  // 输入快照 hash：同一输入（数据集+窗口+配置+样本当前状态）→ 同一 hash
  const inputHash = sha256(canonical(samples.map((s) => [
    s.id, s.request_id, s.ts, s.version, s.group_key, s.position,
    s.impressed, s.clicked, s.is_anomaly, s.anomaly_reason,
  ])));

  const { metrics, comparisons, versionTotals } = computeEvaluation(samples, cfg);
  const constraintResults = checkAll(cfg.constraints || [], {
    metrics, comparisons, versionTotals, baseline: cfg.baseline,
  });

  const resultHash = sha256(canonical({ metrics, comparisons, constraintResults }));

  const ts = now();
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO evaluations (name, dataset_id, versions, baseline, time_start, time_end,
        missing_label_policy, constraints_json, input_hash, result_hash, replay_of, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cfg.name, cfg.dataset_id, JSON.stringify(cfg.versions), cfg.baseline,
      cfg.time_start || null, cfg.time_end || null,
      cfg.missing_label_policy || 'separate_bucket', JSON.stringify(cfg.constraints || []),
      inputHash, resultHash, cfg.replay_of || null, user.id, ts);

    const evalId = Number(info.lastInsertRowid);
    const insM = db.prepare(`
      INSERT INTO eval_metrics (evaluation_id, version, group_key, requests, impressions, clicks,
        ctr, ctr_ci_low, ctr_ci_high, avg_position, pos_hist, anomaly_excluded, missing_labels)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const m of metrics) {
      insM.run(evalId, m.version, m.groupKey, m.requests, m.impressions, m.clicks,
        m.ctr, m.ctrCiLow, m.ctrCiHigh, m.avgPosition, JSON.stringify(m.posHist),
        m.anomalyExcluded, m.missingLabels);
    }
    const insC = db.prepare(`
      INSERT INTO eval_comparisons (evaluation_id, group_key, baseline, candidate,
        ctr_base, ctr_cand, abs_diff, rel_lift, z, p_value, ci_low, ci_high, significant)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of comparisons) {
      insC.run(evalId, c.groupKey, c.baseline, c.candidate, c.ctrBase, c.ctrCand,
        c.absDiff, c.relLift, c.z, c.pValue, c.ciLow, c.ciHigh, c.significant ? 1 : 0);
    }
    const insK = db.prepare(`
      INSERT INTO eval_constraint_results (evaluation_id, version, group_key, metric, op, threshold, actual, passed, detail)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const k of constraintResults) {
      if (k.error) continue;
      insK.run(evalId, k.version, k.groupKey, k.metric, k.op, k.threshold, k.actual, k.passed ? 1 : 0, k.detail || '');
    }
    audit(db, user.id, cfg.replay_of ? 'replay_evaluation' : 'create_evaluation', 'evaluation', evalId,
      `dataset=${cfg.dataset_id} versions=${cfg.versions.join(',')} window=${cfg.time_start || '-'}~${cfg.time_end || '-'}`);
    db.exec('COMMIT');
    return { id: evalId, inputHash, resultHash, metrics, comparisons, constraintResults, versionTotals };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getEvaluationDetail(db, id) {
  const ev = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(id);
  if (!ev) throw new HttpError(404, `评估 ${id} 不存在`);
  const metrics = db.prepare('SELECT * FROM eval_metrics WHERE evaluation_id = ? ORDER BY version, group_key').all(id);
  const comparisons = db.prepare('SELECT * FROM eval_comparisons WHERE evaluation_id = ? ORDER BY group_key, candidate').all(id);
  const constraints = db.prepare('SELECT * FROM eval_constraint_results WHERE evaluation_id = ?').all(id);
  return {
    ...ev,
    versions: JSON.parse(ev.versions),
    constraints_config: JSON.parse(ev.constraints_json),
    metrics: metrics.map((m) => ({ ...m, pos_hist: JSON.parse(m.pos_hist) })),
    comparisons,
    constraint_results: constraints,
  };
}

// ---------- HTTP 基础设施 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

// ---------- 路由 ----------

function createServer(db) {
  const routes = [];
  const route = (method, pattern, minRole, handler) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, minRole, handler });
  };

  // --- 身份 ---
  route('GET', '/api/me', null, (req, res, _p, user) => send(res, 200, { user }));
  route('GET', '/api/users', null, (req, res) => {
    send(res, 200, { users: db.prepare('SELECT id, name, role FROM users ORDER BY id').all() });
  });

  // --- 数据集 ---
  route('GET', '/api/datasets', 'viewer', (req, res) => {
    send(res, 200, { datasets: db.prepare('SELECT * FROM datasets ORDER BY id DESC').all() });
  });

  route('POST', '/api/datasets', 'analyst', async (req, res, _p, user) => {
    const body = await readBody(req);
    if (!body.name || !Array.isArray(body.samples) || body.samples.length === 0) {
      throw new HttpError(400, '需要 name 与非空 samples 数组');
    }
    const required = ['request_id', 'ts', 'version'];
    for (const [i, s] of body.samples.entries()) {
      for (const f of required) {
        if (s[f] == null || s[f] === '') throw new HttpError(400, `样本 #${i} 缺少字段 ${f}`);
      }
      if (Number.isNaN(Date.parse(s.ts))) throw new HttpError(400, `样本 #${i} 的 ts 无法解析: ${s.ts}`);
    }
    // 数据集不可变：导入即定稿，hash 固化输入
    const inputHash = sha256(canonical(body.samples));
    const ts = now();
    db.exec('BEGIN');
    try {
      const info = db.prepare('INSERT INTO datasets (name, created_by, created_at, sample_count, input_hash) VALUES (?,?,?,?,?)')
        .run(body.name, user.id, ts, body.samples.length, inputHash);
      const dsId = Number(info.lastInsertRowid);
      const ins = db.prepare(`INSERT INTO samples
        (dataset_id, request_id, ts, version, group_key, item_id, position, impressed, clicked, session_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const s of body.samples) {
        ins.run(dsId, String(s.request_id), s.ts, String(s.version),
          s.group_key == null || s.group_key === '' ? null : String(s.group_key),
          s.item_id == null ? null : String(s.item_id),
          s.position == null ? null : Number(s.position),
          s.impressed ? 1 : 0, s.clicked ? 1 : 0,
          s.session_id == null ? null : String(s.session_id));
      }
      audit(db, user.id, 'import_dataset', 'dataset', dsId, `name=${body.name} samples=${body.samples.length}`);
      db.exec('COMMIT');
      send(res, 201, { id: dsId, sample_count: body.samples.length, input_hash: inputHash });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  route('GET', '/api/datasets/:id', 'viewer', (req, res, p) => {
    const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(p.id);
    if (!ds) throw new HttpError(404, '数据集不存在');
    const stats = db.prepare(`SELECT version, COUNT(*) n, SUM(is_anomaly) anomalies,
      SUM(CASE WHEN group_key IS NULL THEN 1 ELSE 0 END) missing
      FROM samples WHERE dataset_id = ? GROUP BY version`).all(p.id);
    send(res, 200, { dataset: ds, version_stats: stats, anomaly_rules: RULES });
  });

  route('GET', '/api/datasets/:id/samples', 'viewer', (req, res, p, _u, query) => {
    const clauses = ['dataset_id = ?'];
    const args = [p.id];
    if (query.get('anomaly') === '1') clauses.push('is_anomaly = 1');
    if (query.get('anomaly') === '0') clauses.push('is_anomaly = 0');
    if (query.get('missing') === '1') clauses.push('group_key IS NULL');
    if (query.get('version')) { clauses.push('version = ?'); args.push(query.get('version')); }
    const limit = Math.min(Number(query.get('limit') || 200), 1000);
    const offset = Number(query.get('offset') || 0);
    const rows = db.prepare(`SELECT * FROM samples WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM samples WHERE ${clauses.join(' AND ')}`).get(...args).n;
    send(res, 200, { samples: rows, total });
  });

  // 异常流量检测：规则打标（可重复执行，幂等）
  route('POST', '/api/datasets/:id/detect-anomalies', 'analyst', async (req, res, p, user) => {
    const rows = db.prepare('SELECT * FROM samples WHERE dataset_id = ? ORDER BY id').all(p.id);
    if (!rows.length) throw new HttpError(404, '数据集不存在或为空');
    const flags = detectAnomalies(rows);
    db.exec('BEGIN');
    try {
      const upd = db.prepare('UPDATE samples SET is_anomaly = ?, anomaly_reason = ? WHERE id = ?');
      for (const r of rows) {
        const reason = flags.get(r.id) || null;
        upd.run(reason ? 1 : 0, reason, r.id);
      }
      db.prepare('UPDATE datasets SET anomaly_count = ? WHERE id = ?').run(flags.size, p.id);
      audit(db, user.id, 'detect_anomalies', 'dataset', p.id, `flagged=${flags.size}/${rows.length}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const byReason = {};
    for (const r of flags.values()) byReason[r] = (byReason[r] || 0) + 1;
    send(res, 200, { flagged: flags.size, total: rows.length, by_reason: byReason });
  });

  // --- 版本 ---
  route('GET', '/api/versions', 'viewer', (req, res) => {
    send(res, 200, { versions: db.prepare('SELECT * FROM versions ORDER BY id').all() });
  });

  route('POST', '/api/versions', 'analyst', async (req, res, _p, user) => {
    const body = await readBody(req);
    if (!body.name) throw new HttpError(400, '需要 name');
    try {
      const info = db.prepare('INSERT INTO versions (name, description, status, created_at) VALUES (?,?,?,?)')
        .run(body.name, body.description || '', body.status || 'draft', now());
      audit(db, user.id, 'create_version', 'version', info.lastInsertRowid, body.name);
      send(res, 201, { id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, `版本 ${body.name} 已存在`);
      throw e;
    }
  });

  // --- 评估 ---
  route('GET', '/api/evaluations', 'viewer', (req, res) => {
    send(res, 200, {
      evaluations: db.prepare('SELECT * FROM evaluations ORDER BY id DESC').all()
        .map((e) => ({ ...e, versions: JSON.parse(e.versions) })),
    });
  });

  route('POST', '/api/evaluations', 'analyst', async (req, res, _p, user) => {
    const body = await readBody(req);
    validateEvalConfig(body);
    const result = runEvaluation(db, body, user);
    send(res, 201, { id: result.id, input_hash: result.inputHash, result_hash: result.resultHash });
  });

  route('GET', '/api/evaluations/:id', 'viewer', (req, res, p) => {
    send(res, 200, getEvaluationDetail(db, Number(p.id)));
  });

  // 回放：同一输入（数据集+窗口+配置）重跑，旧结果保留；hash 对比验证可复现性
  route('POST', '/api/evaluations/:id/replay', 'analyst', async (req, res, p, user) => {
    const orig = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(p.id);
    if (!orig) throw new HttpError(404, '原评估不存在');
    const cfg = {
      name: `${orig.name}（回放 #${orig.id}）`,
      dataset_id: orig.dataset_id,
      versions: JSON.parse(orig.versions),
      baseline: orig.baseline,
      time_start: orig.time_start,
      time_end: orig.time_end,
      missing_label_policy: orig.missing_label_policy,
      constraints: JSON.parse(orig.constraints_json),
      replay_of: orig.id,
    };
    const result = runEvaluation(db, cfg, user);
    send(res, 201, {
      replay_id: result.id,
      original_id: orig.id,
      input_hash_same: result.inputHash === orig.input_hash,
      result_hash_same: result.resultHash === orig.result_hash,
      original_result_hash: orig.result_hash,
      replay_result_hash: result.resultHash,
      note: result.resultHash === orig.result_hash
        ? '同一输入重放，结果完全一致（可复现）'
        : '输入已发生修订（样本标签/异常标记变化），旧评估结果保留不变，回放结果基于当前输入',
    });
  });

  // --- 样本修订（权限 + 审计；已生成的评估快照不受影响） ---
  route('POST', '/api/samples/:id/revisions', 'analyst', async (req, res, p, user) => {
    const body = await readBody(req);
    const sample = db.prepare('SELECT * FROM samples WHERE id = ?').get(p.id);
    if (!sample) throw new HttpError(404, '样本不存在');
    const { field, new_value, reason } = body;
    if (!['is_anomaly', 'anomaly_reason', 'group_key'].includes(field)) {
      throw new HttpError(400, '仅允许修订 is_anomaly / anomaly_reason / group_key');
    }
    if (!reason || !String(reason).trim()) throw new HttpError(400, '修订必须填写理由（审计要求）');
    const oldValue = sample[field];
    const normalized = field === 'is_anomaly' ? (new_value ? 1 : 0) : (new_value === '' ? null : new_value);
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE samples SET ${field} = ? WHERE id = ?`).run(normalized, sample.id);
      db.prepare('INSERT INTO revisions (sample_id, field, old_value, new_value, reason, revised_by, revised_at) VALUES (?,?,?,?,?,?,?)')
        .run(sample.id, field, oldValue == null ? null : String(oldValue),
          normalized == null ? null : String(normalized), String(reason), user.id, now());
      audit(db, user.id, 'revise_sample', 'sample', sample.id, `${field}: ${oldValue} -> ${normalized} (${reason})`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true, sample_id: sample.id, field, old_value: oldValue, new_value: normalized });
  });

  route('GET', '/api/revisions', 'viewer', (req, res, _p, _u, query) => {
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    send(res, 200, {
      revisions: db.prepare('SELECT * FROM revisions ORDER BY id DESC LIMIT ?').all(limit),
    });
  });

  // --- 影响报告（版本切换前必须生成） ---
  route('POST', '/api/impact-reports', 'analyst', async (req, res, _p, user) => {
    const body = await readBody(req);
    const { from_version, to_version, evaluation_id } = body;
    if (!from_version || !to_version || !evaluation_id) {
      throw new HttpError(400, '需要 from_version / to_version / evaluation_id');
    }
    const detail = getEvaluationDetail(db, Number(evaluation_id));
    if (!detail.versions.includes(from_version) || !detail.versions.includes(to_version)) {
      throw new HttpError(400, `评估 #${evaluation_id} 不包含 ${from_version} 与 ${to_version} 的对照`);
    }
    const summary = buildImpactSummary(detail, from_version, to_version);
    db.exec('BEGIN');
    try {
      const info = db.prepare('INSERT INTO impact_reports (from_version, to_version, evaluation_id, summary, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(from_version, to_version, evaluation_id, JSON.stringify(summary), user.id, now());
      audit(db, user.id, 'create_impact_report', 'impact_report', info.lastInsertRowid,
        `${from_version} -> ${to_version} eval=${evaluation_id} recommendation=${summary.recommendation}`);
      db.exec('COMMIT');
      send(res, 201, { id: Number(info.lastInsertRowid), summary });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  route('GET', '/api/impact-reports', 'viewer', (req, res) => {
    send(res, 200, {
      reports: db.prepare('SELECT * FROM impact_reports ORDER BY id DESC').all()
        .map((r) => ({ ...r, summary: JSON.parse(r.summary) })),
    });
  });

  route('GET', '/api/impact-reports/:id', 'viewer', (req, res, p) => {
    const r = db.prepare('SELECT * FROM impact_reports WHERE id = ?').get(p.id);
    if (!r) throw new HttpError(404, '报告不存在');
    send(res, 200, { ...r, summary: JSON.parse(r.summary) });
  });

  // --- 审批 ---
  route('POST', '/api/approvals', 'analyst', async (req, res, _p, user) => {
    const body = await readBody(req);
    const report = db.prepare('SELECT * FROM impact_reports WHERE id = ?').get(body.report_id);
    if (!report) throw new HttpError(404, '影响报告不存在');
    const dup = db.prepare("SELECT id FROM approvals WHERE report_id = ? AND status = 'pending'").get(report.id);
    if (dup) throw new HttpError(409, `报告 #${report.id} 已有待审批申请 (#${dup.id})`);
    const info = db.prepare("INSERT INTO approvals (report_id, action, requested_by, requested_at) VALUES (?,?,?,?)")
      .run(report.id, 'version_switch', user.id, now());
    audit(db, user.id, 'request_approval', 'approval', info.lastInsertRowid, `report=${report.id}`);
    send(res, 201, { id: Number(info.lastInsertRowid) });
  });

  route('POST', '/api/approvals/:id/decide', 'approver', async (req, res, p, user) => {
    const body = await readBody(req);
    const ap = db.prepare('SELECT * FROM approvals WHERE id = ?').get(p.id);
    if (!ap) throw new HttpError(404, '审批单不存在');
    if (ap.status !== 'pending') throw new HttpError(409, `审批单已是 ${ap.status} 状态`);
    if (ap.requested_by === user.id) throw new HttpError(403, '不能审批自己提交的申请（职责分离）');
    if (typeof body.approve !== 'boolean') throw new HttpError(400, '需要 approve: true/false');
    db.prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?')
      .run(body.approve ? 'approved' : 'rejected', user.id, now(), body.reason || '', ap.id);
    audit(db, user.id, body.approve ? 'approve' : 'reject', 'approval', ap.id, body.reason || '');
    send(res, 200, { ok: true, status: body.approve ? 'approved' : 'rejected' });
  });

  route('GET', '/api/approvals', 'viewer', (req, res) => {
    const rows = db.prepare(`
      SELECT a.*, r.from_version, r.to_version, r.evaluation_id
      FROM approvals a JOIN impact_reports r ON r.id = a.report_id
      ORDER BY a.id DESC`).all();
    send(res, 200, { approvals: rows });
  });

  // --- 版本切换：需 admin + 已批准的审批单；旧版本归档，历史结果全部保留 ---
  route('POST', '/api/versions/:name/activate', 'admin', async (req, res, p, user) => {
    const target = db.prepare('SELECT * FROM versions WHERE name = ?').get(p.name);
    if (!target) throw new HttpError(404, `版本 ${p.name} 不存在`);
    if (target.status === 'active') throw new HttpError(409, `${p.name} 已是 active`);
    const approved = db.prepare(`
      SELECT a.* FROM approvals a
      JOIN impact_reports r ON r.id = a.report_id
      WHERE r.to_version = ? AND a.status = 'approved'
      ORDER BY a.id DESC LIMIT 1`).get(p.name);
    if (!approved) {
      throw new HttpError(403, `版本切换被阻止：${p.name} 没有已批准的影响报告（需先生成影响报告并通过审批）`);
    }
    const ts = now();
    db.exec('BEGIN');
    try {
      const current = db.prepare("SELECT * FROM versions WHERE status = 'active'").get();
      if (current) {
        db.prepare("UPDATE versions SET status = 'archived', archived_at = ? WHERE id = ?").run(ts, current.id);
      }
      db.prepare("UPDATE versions SET status = 'active', activated_at = ? WHERE id = ?").run(ts, target.id);
      audit(db, user.id, 'activate_version', 'version', target.id,
        `${current ? current.name : '(none)'} -> ${target.name}, approval=#${approved.id}`);
      db.exec('COMMIT');
      send(res, 200, { ok: true, switched_from: current ? current.name : null, switched_to: target.name, approval_id: approved.id });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  // --- 审计日志 ---
  route('GET', '/api/audit', 'viewer', (req, res, _p, _u, query) => {
    const limit = Math.min(Number(query.get('limit') || 200), 1000);
    send(res, 200, { audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) });
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const m = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
        if (!m) throw new HttpError(404, `${req.method} ${url.pathname} 不存在`);
        const user = getUser(db, req);
        if (m.minRole) requireRole(user, m.minRole);
        const match = url.pathname.match(m.rx);
        const params = {};
        m.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
        await m.handler(req, res, params, user, url.searchParams);
      } else {
        serveStatic(req, res, url.pathname);
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e.message || 'internal error' });
    }
  });
}

function validateEvalConfig(body) {
  if (!body.name) throw new HttpError(400, '需要 name');
  if (!body.dataset_id) throw new HttpError(400, '需要 dataset_id');
  if (!Array.isArray(body.versions) || body.versions.length < 1) throw new HttpError(400, '需要 versions 数组');
  if (!body.baseline || !body.versions.includes(body.baseline)) {
    throw new HttpError(400, 'baseline 必须包含在 versions 中');
  }
  if (body.missing_label_policy && !['separate_bucket', 'exclude'].includes(body.missing_label_policy)) {
    throw new HttpError(400, 'missing_label_policy 仅支持 separate_bucket / exclude');
  }
  if (body.time_start && Number.isNaN(Date.parse(body.time_start))) throw new HttpError(400, 'time_start 无法解析');
  if (body.time_end && Number.isNaN(Date.parse(body.time_end))) throw new HttpError(400, 'time_end 无法解析');
  if (body.time_start && body.time_end && body.time_start > body.time_end) {
    throw new HttpError(400, 'time_start 不能晚于 time_end');
  }
  if (body.constraints) {
    if (!Array.isArray(body.constraints)) throw new HttpError(400, 'constraints 必须是数组');
    for (const [i, c] of body.constraints.entries()) {
      if (!c.metric || !c.op || c.value == null || !c.group) {
        throw new HttpError(400, `约束 #${i} 需要 metric/group/op/value`);
      }
    }
  }
}

// 影响报告汇总：受益/受损群体、差异证据、约束状态、异常与缺失标签说明
function buildImpactSummary(detail, fromVersion, toVersion) {
  const comps = detail.comparisons.filter(
    (c) => c.baseline === fromVersion && c.candidate === toVersion);
  const benefited = comps.filter((c) => c.significant && c.abs_diff > 0);
  const harmed = comps.filter((c) => c.significant && c.abs_diff < 0);
  const inconclusive = comps.filter((c) => !c.significant);

  const violations = detail.constraint_results.filter(
    (r) => !r.passed && r.version === toVersion);
  const toMetrics = detail.metrics.filter((m) => m.version === toVersion);
  const anomalyExcluded = toMetrics.reduce((a, m) => a + m.anomaly_excluded, 0);
  const totalReq = toMetrics.reduce((a, m) => a + m.requests, 0) + anomalyExcluded;
  const missing = toMetrics.filter((m) => m.group_key === MISSING_GROUP)
    .reduce((a, m) => a + m.requests, 0);

  const recommendation = violations.length > 0 ? 'blocked'
    : harmed.length > 0 ? 'caution' : 'recommended';

  return {
    from_version: fromVersion,
    to_version: toVersion,
    evaluation_id: detail.id,
    baseline: detail.baseline,
    time_window: { start: detail.time_start, end: detail.time_end },
    benefited_groups: benefited.map(fmtComp),
    harmed_groups: harmed.map(fmtComp),
    inconclusive_groups: inconclusive.map(fmtComp),
    constraint_violations: violations.map((v) => ({
      version: v.version, group: v.group_key, metric: v.metric,
      op: v.op, threshold: v.threshold, actual: v.actual,
    })),
    data_quality: {
      anomaly_excluded: anomalyExcluded,
      anomaly_rate: totalReq > 0 ? anomalyExcluded / totalReq : 0,
      missing_label_samples: missing,
      missing_label_note: detail.missing_label_policy === 'exclude'
        ? '缺失标签样本已从指标中剔除'
        : `缺失标签样本归入 ${MISSING_GROUP} 桶单独统计`,
    },
    recommendation,
    recommendation_note: {
      recommended: '所有约束通过且无显著受损群体，建议切换',
      caution: '存在显著受损群体，建议谨慎评估后决定',
      blocked: '存在约束违规，不建议切换',
    }[recommendation],
  };
}

function fmtComp(c) {
  return {
    group: c.group_key, ctr_base: c.ctr_base, ctr_cand: c.ctr_cand,
    abs_diff: c.abs_diff, rel_lift: c.rel_lift, p_value: c.p_value,
    ci: [c.ci_low, c.ci_high],
  };
}

if (require.main === module) {
  const db = open();
  const server = createServer(db);
  server.listen(PORT, () => console.log(`rank-eval listening on http://localhost:${PORT}`));
}

module.exports = { createServer, runEvaluation, buildImpactSummary };
