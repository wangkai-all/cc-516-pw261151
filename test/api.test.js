'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createServer } = require('../server/index');

let db, server, base;

const call = async (path, { method = 'GET', user = 'alice', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

before(async () => {
  db = open(':memory:');
  const ins = db.prepare('INSERT INTO users (id, name, role) VALUES (?,?,?)');
  ins.run('admin', '管理员', 'admin');
  ins.run('alice', '分析师', 'analyst');
  ins.run('bob', '审批人', 'approver');
  ins.run('carol', '访客', 'viewer');
  const insV = db.prepare("INSERT INTO versions (name, status, created_at) VALUES (?,?,?)");
  insV.run('v1-base', 'active', '2026-11-01T00:00:00Z');
  insV.run('v2-cand', 'candidate', '2026-11-01T00:00:00Z');

  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;

  // 导入数据集：2 版本 × 2 群体 + 缺失标签 + 异常样本
  const samples = [];
  let n = 0;
  for (const [version, groups] of [['v1-base', { g1: 0.10, g2: 0.20 }], ['v2-cand', { g1: 0.15, g2: 0.18 }]]) {
    for (const [g, ctr] of Object.entries(groups)) {
      for (let i = 0; i < 400; i++) {
        samples.push({
          request_id: `r${++n}`, ts: new Date(Date.parse('2026-11-19T10:00:00Z') + n * 7000).toISOString(),
          version, group_key: g,
          position: 1 + (i % 5), impressed: 1, clicked: i < 400 * ctr ? 1 : 0, session_id: `s-${n}`,
        });
      }
    }
  }
  for (let i = 0; i < 40; i++) { // 缺失标签
    samples.push({ request_id: `r${++n}`, ts: new Date(Date.parse('2026-11-19T11:00:00Z') + n * 7000).toISOString(), version: 'v2-cand', group_key: null, position: 2, impressed: 1, clicked: i % 4 === 0 ? 1 : 0, session_id: `s-${n}` });
  }
  for (let i = 0; i < 8; i++) { // 全点机器人
    samples.push({ request_id: `r${++n}`, ts: '2026-11-19T12:00:00Z', version: 'v2-cand', group_key: 'g1', position: 1, impressed: 1, clicked: 1, session_id: 'bot-1' });
  }
  const r = await call('/api/datasets', { method: 'POST', body: { name: '测试集', samples } });
  assert.equal(r.status, 201);
  global.dsId = r.data.id;
  await call(`/api/datasets/${global.dsId}/detect-anomalies`, { method: 'POST' });
});

after(() => { server.close(); db.close(); });

test('RBAC：viewer 只读，写操作被拒', async () => {
  const r1 = await call('/api/datasets', { method: 'POST', user: 'carol', body: { name: 'x', samples: [{ request_id: 'a', ts: '2026-11-19T00:00:00Z', version: 'v1-base' }] } });
  assert.equal(r1.status, 403);
  const r2 = await call('/api/evaluations', { method: 'GET', user: 'carol' });
  assert.equal(r2.status, 200);
  const r3 = await call('/api/datasets', { method: 'POST', user: 'nobody', body: {} });
  assert.equal(r3.status, 401, '未知用户视为未认证');
});

test('异常流量检测：机器人会话被标记，不计入指标', async () => {
  const det = await call(`/api/datasets/${global.dsId}/detect-anomalies`, { method: 'POST' });
  assert.equal(det.data.flagged, 8);
  assert.equal(det.data.by_reason.bot_full_click, 8);

  const r = await call('/api/evaluations', {
    method: 'POST',
    body: {
      name: '对照评估', dataset_id: global.dsId,
      versions: ['v1-base', 'v2-cand'], baseline: 'v1-base',
      constraints: [{ metric: 'rel_lift', group: '*', op: '>=', value: -0.5 }],
    },
  });
  assert.equal(r.status, 201);
  global.evalId = r.data.id;

  const ev = (await call(`/api/evaluations/${global.evalId}`)).data;
  const candG1 = ev.metrics.find((m) => m.version === 'v2-cand' && m.group_key === 'g1');
  assert.equal(candG1.impressions, 400, '机器人 8 条曝光被剔除');
  assert.equal(candG1.anomaly_excluded, 8);
  assert.ok(Math.abs(candG1.ctr - 0.15) < 1e-9, 'CTR 不被异常流量污染');

  const missing = ev.metrics.find((m) => m.group_key === '(missing)');
  assert.equal(missing.requests, 40, '缺失标签独立成桶');
});

test('回放同一输入：结果完全一致（可复现）', async () => {
  const r = await call(`/api/evaluations/${global.evalId}/replay`, { method: 'POST' });
  assert.equal(r.status, 201);
  assert.equal(r.data.input_hash_same, true);
  assert.equal(r.data.result_hash_same, true);
  assert.match(r.data.note, /完全一致/);
  global.replayId = r.data.replay_id;
});

test('样本修订：权限、审计、旧结果保留', async () => {
  // viewer 无权修订
  const denied = await call('/api/samples/1/revisions', { method: 'POST', user: 'carol', body: { field: 'group_key', new_value: 'g2', reason: 'x' } });
  assert.equal(denied.status, 403);
  // 无理由被拒
  const noReason = await call('/api/samples/1/revisions', { method: 'POST', body: { field: 'group_key', new_value: 'g2' } });
  assert.equal(noReason.status, 400);
  // analyst 修订成功
  const ok = await call('/api/samples/1/revisions', { method: 'POST', body: { field: 'group_key', new_value: 'g2', reason: '标签补录' } });
  assert.equal(ok.status, 200);
  const rev = (await call('/api/revisions')).data.revisions;
  assert.equal(rev.length, 1);
  assert.equal(rev[0].old_value, 'g1');
  assert.equal(rev[0].revised_by, 'alice');

  // 旧评估快照不变
  const old = (await call(`/api/evaluations/${global.evalId}`)).data;
  const g1 = old.metrics.find((m) => m.version === 'v1-base' && m.group_key === 'g1');
  assert.equal(g1.requests, 400, '历史评估不受修订影响');

  // 回放反映修订：结果指纹变化，旧结果仍保留
  const replay = await call(`/api/evaluations/${global.evalId}/replay`, { method: 'POST' });
  assert.equal(replay.data.result_hash_same, false);
  const again = (await call(`/api/evaluations/${global.evalId}`)).data;
  assert.equal(again.metrics.find((m) => m.version === 'v1-base' && m.group_key === 'g1').requests, 400);
});

test('影响报告 → 审批 → 激活全流程', async () => {
  // 无批准时激活被阻止
  const blocked = await call('/api/versions/v2-cand/activate', { method: 'POST', user: 'admin' });
  assert.equal(blocked.status, 403);

  // 生成影响报告
  const rep = await call('/api/impact-reports', {
    method: 'POST',
    body: { from_version: 'v1-base', to_version: 'v2-cand', evaluation_id: global.evalId },
  });
  assert.equal(rep.status, 201);
  assert.ok(['recommended', 'caution', 'blocked'].includes(rep.data.summary.recommendation));
  assert.ok(rep.data.summary.data_quality.anomaly_excluded >= 8);
  global.reportId = rep.data.id;

  // 提交审批
  const ap = await call('/api/approvals', { method: 'POST', body: { report_id: global.reportId } });
  assert.equal(ap.status, 201);
  const apId = ap.data.id;

  // 申请人不能审批自己的单子（职责分离）
  const self = await call(`/api/approvals/${apId}/decide`, { method: 'POST', user: 'alice', body: { approve: true } });
  assert.equal(self.status, 403);
  // analyst 无审批权
  const noPerm = await call(`/api/approvals/${apId}/decide`, { method: 'POST', user: 'alice' });
  assert.equal(noPerm.status, 403);
  // approver 批准
  const ok = await call(`/api/approvals/${apId}/decide`, { method: 'POST', user: 'bob', body: { approve: true, reason: '指标达标' } });
  assert.equal(ok.status, 200);
  // 重复决定被拒
  const again = await call(`/api/approvals/${apId}/decide`, { method: 'POST', user: 'bob', body: { approve: false } });
  assert.equal(again.status, 409);

  // admin 激活：旧版本归档，历史保留
  const act = await call('/api/versions/v2-cand/activate', { method: 'POST', user: 'admin' });
  assert.equal(act.status, 200);
  assert.equal(act.data.switched_from, 'v1-base');
  const versions = (await call('/api/versions')).data.versions;
  assert.equal(versions.find((v) => v.name === 'v2-cand').status, 'active');
  assert.equal(versions.find((v) => v.name === 'v1-base').status, 'archived');
  // 旧评估结果仍在
  const ev = (await call(`/api/evaluations/${global.evalId}`)).data;
  assert.ok(ev.metrics.length > 0);
});

test('时间窗口过滤', async () => {
  // 样本时间戳 = 10:00:00 + n*7s（n 从 1 开始）；窗口 10:00~10:30 命中 n ≤ 257
  const r = await call('/api/evaluations', {
    method: 'POST',
    body: {
      name: '窗口评估', dataset_id: global.dsId,
      versions: ['v1-base'], baseline: 'v1-base',
      time_start: '2026-11-19T10:00:00Z', time_end: '2026-11-19T10:30:00Z',
    },
  });
  assert.equal(r.status, 201);
  const ev = (await call(`/api/evaluations/${r.data.id}`)).data;
  const total = ev.metrics.reduce((a, m) => a + m.requests, 0);
  assert.equal(total, 257, '窗口只命中 10:00~10:30 的样本');
});

test('审计日志记录敏感操作', async () => {
  const { audit } = (await call('/api/audit')).data;
  const actions = new Set(audit.map((a) => a.action));
  for (const expected of ['import_dataset', 'detect_anomalies', 'create_evaluation', 'replay_evaluation', 'revise_sample', 'create_impact_report', 'approve', 'activate_version']) {
    assert.ok(actions.has(expected), `缺少审计动作 ${expected}`);
  }
});
