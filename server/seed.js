'use strict';
// 演示数据：3 个排序版本 × 4 个群体（含缺失标签）× 7 天，注入异常流量。
// 用法：node server/seed.js [--db path]（幂等：已有数据时先清空业务表）

const path = require('node:path');
const { open, now, audit } = require('./db');
const { detectAnomalies } = require('./anomaly');

// 确定性伪随机（可复现的演示数据）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = ['new_users', 'returning', 'premium', 'enterprise'];
// 各版本 CTR 画像：v1.1 在 new_users 提升、premium 显著下降（制造约束违规场景）
const CTR_PROFILE = {
  'v1.0-baseline': { new_users: 0.10, returning: 0.16, premium: 0.22, enterprise: 0.13, '(missing)': 0.08 },
  'v1.1-candidate': { new_users: 0.125, returning: 0.165, premium: 0.175, enterprise: 0.132, '(missing)': 0.085 },
  'v1.2-experimental': { new_users: 0.104, returning: 0.19, premium: 0.225, enterprise: 0.15, '(missing)': 0.06 },
};
// 平均位置画像（越小越靠前）
const POS_PROFILE = {
  'v1.0-baseline': 3.4,
  'v1.1-candidate': 3.0,
  'v1.2-experimental': 2.6,
};

function seed(dbPath) {
  const db = open(dbPath);
  const ts = now();

  db.exec('BEGIN');
  try {
    // 清空业务表（保留 schema）
    for (const t of ['audit_log', 'revisions', 'approvals', 'impact_reports', 'eval_constraint_results',
      'eval_comparisons', 'eval_metrics', 'evaluations', 'versions', 'samples', 'datasets', 'users']) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec("DELETE FROM sqlite_sequence");

    // 用户：viewer < analyst < approver < admin
    const insUser = db.prepare('INSERT INTO users (id, name, role) VALUES (?,?,?)');
    insUser.run('admin', '系统管理员', 'admin');
    insUser.run('alice', '分析师 Alice', 'analyst');
    insUser.run('bob', '审批人 Bob', 'approver');
    insUser.run('carol', '访客 Carol', 'viewer');

    // 版本
    const insVer = db.prepare('INSERT INTO versions (name, description, status, created_at, activated_at) VALUES (?,?,?,?,?)');
    insVer.run('v1.0-baseline', '线上基线排序（GBDT+LR）', 'active', ts, ts);
    insVer.run('v1.1-candidate', '候选版本：新增交叉特征', 'candidate', ts, null);
    insVer.run('v1.2-experimental', '实验版本：序列模型重排', 'draft', ts, null);

    // 数据集：最近 7 天
    const rng = mulberry32(20261120);
    const samples = [];
    const end = Date.now();
    const DAY = 24 * 3600 * 1000;
    let reqSeq = 0;

    const versions = Object.keys(CTR_PROFILE);
    const versionWeight = { 'v1.0-baseline': 0.5, 'v1.1-candidate': 0.3, 'v1.2-experimental': 0.2 };

    for (let d = 6; d >= 0; d--) {
      const dayStart = end - d * DAY;
      const perDay = 4000;
      for (let i = 0; i < perDay; i++) {
        // 选版本
        let r = rng(), version = versions[0], acc = 0;
        for (const v of versions) { acc += versionWeight[v]; if (r <= acc) { version = v; break; } }
        // 选群体（约 8% 缺失标签）
        let group = null;
        const gr = rng();
        if (gr >= 0.08) group = GROUPS[Math.floor(rng() * GROUPS.length)];
        const groupKey = group || '(missing)';
        const ctr = CTR_PROFILE[version][groupKey];
        const tsMs = dayStart - Math.floor(rng() * DAY);
        const impressed = rng() < 0.92 ? 1 : 0;
        const clicked = impressed && rng() < ctr ? 1 : 0;
        const posMean = POS_PROFILE[version];
        const position = impressed ? Math.max(1, Math.min(10, Math.round(posMean + (rng() - 0.5) * 5))) : null;
        samples.push({
          request_id: `req-${++reqSeq}`,
          ts: new Date(tsMs).toISOString(),
          version,
          group_key: group,
          item_id: `item-${1 + Math.floor(rng() * 500)}`,
          position,
          impressed,
          clicked,
          session_id: `sess-${Math.floor(rng() * 900)}`,
        });
      }
    }

    // 注入异常流量 1：全点机器人会话
    for (let b = 0; b < 6; b++) {
      const base = end - Math.floor(rng() * 6) * DAY;
      for (let i = 0; i < 8; i++) {
        samples.push({
          request_id: `req-${++reqSeq}`,
          ts: new Date(base - i * 5000).toISOString(),
          version: versions[b % versions.length],
          group_key: GROUPS[b % GROUPS.length],
          item_id: `item-${1 + Math.floor(rng() * 500)}`,
          position: 1,
          impressed: 1,
          clicked: 1,
          session_id: `bot-${b}`,
        });
      }
    }
    // 注入异常流量 2：高频会话（1 分钟 40 请求）
    for (let i = 0; i < 40; i++) {
      samples.push({
        request_id: `req-${++reqSeq}`,
        ts: new Date(end - 2 * DAY - i * 1000).toISOString(),
        version: 'v1.1-candidate',
        group_key: 'returning',
        item_id: `item-${1 + Math.floor(rng() * 500)}`,
        position: 2,
        impressed: 1,
        clicked: rng() < 0.5 ? 1 : 0,
        session_id: 'sess-flood-1',
      });
    }
    // 注入异常流量 3：有点击无曝光 + 非法位置
    for (let i = 0; i < 10; i++) {
      samples.push({
        request_id: `req-${++reqSeq}`,
        ts: new Date(end - 3 * DAY - i * 60000).toISOString(),
        version: 'v1.0-baseline',
        group_key: 'new_users',
        item_id: `item-${1 + Math.floor(rng() * 500)}`,
        position: null,
        impressed: 0,
        clicked: 1,
        session_id: `sess-${900 + i}`,
      });
    }
    for (let i = 0; i < 8; i++) {
      samples.push({
        request_id: `req-${++reqSeq}`,
        ts: new Date(end - 4 * DAY - i * 60000).toISOString(),
        version: 'v1.2-experimental',
        group_key: null,
        item_id: `item-${1 + Math.floor(rng() * 500)}`,
        position: 0,
        impressed: 1,
        clicked: 0,
        session_id: `sess-${950 + i}`,
      });
    }

    // 落库
    const info = db.prepare('INSERT INTO datasets (name, created_by, created_at, sample_count, input_hash) VALUES (?,?,?,?,?)')
      .run('线上流量样本 2026-11-14 ~ 2026-11-20', 'admin', ts, samples.length, 'seed');
    const dsId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO samples
      (dataset_id, request_id, ts, version, group_key, item_id, position, impressed, clicked, session_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const s of samples) {
      ins.run(dsId, s.request_id, s.ts, s.version, s.group_key, s.item_id,
        s.position, s.impressed, s.clicked, s.session_id);
    }

    // 异常检测打标
    const rows = db.prepare('SELECT * FROM samples WHERE dataset_id = ? ORDER BY id').all(dsId);
    const flags = detectAnomalies(rows);
    const upd = db.prepare('UPDATE samples SET is_anomaly = ?, anomaly_reason = ? WHERE id = ?');
    for (const r of rows) {
      const reason = flags.get(r.id) || null;
      upd.run(reason ? 1 : 0, reason, r.id);
    }
    db.prepare('UPDATE datasets SET anomaly_count = ? WHERE id = ?').run(flags.size, dsId);

    audit(db, 'admin', 'seed', 'dataset', dsId, `samples=${samples.length} anomalies=${flags.size}`);
    db.exec('COMMIT');
    console.log(`seed 完成：dataset #${dsId}，样本 ${samples.length} 条，异常 ${flags.size} 条`);
    console.log('用户：admin(admin) / alice(analyst) / bob(approver) / carol(viewer)');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const idx = process.argv.indexOf('--db');
  seed(idx > -1 ? process.argv[idx + 1] : path.join(__dirname, '..', 'data.sqlite'));
}

module.exports = { seed };
