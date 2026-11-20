'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeEvaluation, wilsonInterval, compareProportions, intrinsicAnomaly, canonical, MISSING_GROUP,
} = require('../server/metrics');

const mk = (over = {}) => ({
  id: 1, request_id: 'r1', ts: '2026-11-20T00:00:00Z', version: 'v1',
  group_key: 'g1', position: 2, impressed: 1, clicked: 0, session_id: 's1',
  is_anomaly: 0, anomaly_reason: null, ...over,
});

test('wilsonInterval: 边界与对称性', () => {
  assert.deepEqual(wilsonInterval(0, 0), [0, 0]);
  const [lo, hi] = wilsonInterval(50, 100);
  assert.ok(lo < 0.5 && hi > 0.5, 'CI 应包含点估计');
  assert.ok(lo > 0.39 && hi < 0.61, 'n=100 时区间应合理收紧');
  const [lo2] = wilsonInterval(0, 100);
  assert.equal(lo2, 0, '0 成功时下界为 0');
});

test('compareProportions 基本行为', () => {
  const r = compareProportions(100, 1000, 160, 1000);
  assert.ok(r.absDiff > 0.05 && r.absDiff < 0.07);
  assert.ok(r.significant, '10% vs 16% (n=1000) 应显著');
  assert.ok(r.pValue < 0.05);
  assert.ok(r.relLift > 0.5 && r.relLift < 0.7);
  const same = compareProportions(100, 1000, 101, 1000);
  assert.equal(same.significant, false);
  assert.equal(compareProportions(0, 0, 1, 10), null, '空组返回 null');
});

test('intrinsicAnomaly: 计算层兜底', () => {
  assert.equal(intrinsicAnomaly(mk({ clicked: 1, impressed: 0 })), 'click_without_impression');
  assert.equal(intrinsicAnomaly(mk({ position: 0 })), 'invalid_position');
  assert.equal(intrinsicAnomaly(mk()), null);
});

test('computeEvaluation: 分组、异常排除、缺失标签独立成桶', () => {
  const samples = [
    ...Array.from({ length: 100 }, (_, i) => mk({ id: i + 1, request_id: `a${i}`, clicked: i < 10 ? 1 : 0 })),
    ...Array.from({ length: 50 }, (_, i) => mk({ id: 100 + i, request_id: `b${i}`, group_key: null })),
    mk({ id: 900, request_id: 'bot', is_anomaly: 1, anomaly_reason: 'bot_full_click', clicked: 1 }),
    mk({ id: 901, request_id: 'bad', clicked: 1, impressed: 0 }), // 内在异常，未打标也应排除
  ];
  const { metrics, versionTotals } = computeEvaluation(samples, {
    versions: ['v1'], baseline: 'v1', missingLabelPolicy: 'separate_bucket',
  });
  const g1 = metrics.find((m) => m.groupKey === 'g1');
  const missing = metrics.find((m) => m.groupKey === MISSING_GROUP);
  assert.equal(g1.requests, 100);
  assert.equal(g1.clicks, 10);
  assert.ok(Math.abs(g1.ctr - 0.1) < 1e-9);
  assert.equal(missing.requests, 50, '缺失标签独立成桶');
  assert.equal(g1.anomalyExcluded, 2, '标记异常 + 内在异常都被剔除');
  assert.equal(versionTotals[0].anomalyExcluded, 2);
});

test('computeEvaluation: 缺失标签 exclude 策略', () => {
  const samples = [
    mk({ id: 1 }), mk({ id: 2, request_id: 'x', group_key: null }),
  ];
  const { metrics } = computeEvaluation(samples, {
    versions: ['v1'], baseline: 'v1', missingLabelPolicy: 'exclude',
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].groupKey, 'g1');
});

test('computeEvaluation: 差异证据与位置分布', () => {
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    samples.push(mk({ id: i, request_id: `b${i}`, version: 'base', clicked: i < 100 ? 1 : 0, position: 3 }));
    samples.push(mk({ id: 1000 + i, request_id: `c${i}`, version: 'cand', clicked: i < 160 ? 1 : 0, position: 1 }));
  }
  const { metrics, comparisons } = computeEvaluation(samples, {
    versions: ['base', 'cand'], baseline: 'base',
  });
  const cmp = comparisons.find((c) => c.candidate === 'cand' && c.groupKey === 'g1');
  assert.ok(cmp.significant && cmp.absDiff > 0);
  const cand = metrics.find((m) => m.version === 'cand');
  assert.equal(cand.avgPosition, 1);
  assert.equal(cand.posHist[0], 1000, '位置 1 桶计数');
});

test('canonical: 键序无关、数值精度固定', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(canonical(0.1 + 0.2), canonical(0.3), '浮点噪声被吸收');
});
