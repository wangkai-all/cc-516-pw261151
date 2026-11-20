'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkAll } = require('../server/constraints');

const ctx = {
  baseline: 'base',
  metrics: [
    { version: 'cand', groupKey: 'g1', ctr: 0.12, avgPosition: 2.5, impressions: 1000 },
    { version: 'cand', groupKey: 'g2', ctr: 0.05, avgPosition: 4.1, impressions: 500 },
    { version: 'base', groupKey: 'g1', ctr: 0.10, avgPosition: 3.0, impressions: 1000 },
  ],
  comparisons: [
    { candidate: 'cand', groupKey: 'g1', relLift: 0.2 },
    { candidate: 'cand', groupKey: 'g2', relLift: -0.3 },
  ],
  versionTotals: [
    { version: 'cand', anomalyRate: 0.03, missingLabelRate: 0.12 },
  ],
};

test('ctr 阈值：分组命中与通配', () => {
  const r = checkAll([{ metric: 'ctr', group: 'g1', op: '>=', value: 0.1 }], ctx);
  assert.equal(r.length, 2, 'g1 的两个版本都被校验');
  assert.equal(r.find((x) => x.version === 'cand').passed, true);
  assert.equal(r.find((x) => x.version === 'base').passed, true);
  const r2 = checkAll([{ metric: 'ctr', group: '*', op: '>=', value: 0.06 }], ctx);
  assert.equal(r2.find((x) => x.groupKey === 'g2').passed, false, 'g2 CTR 0.05 违规');
});

test('rel_lift 只作用于 candidate', () => {
  const r = checkAll([{ metric: 'rel_lift', group: '*', op: '>=', value: -0.1 }], ctx);
  assert.equal(r.length, 2);
  assert.equal(r.find((x) => x.groupKey === 'g1').passed, true);
  assert.equal(r.find((x) => x.groupKey === 'g2').passed, false);
});

test('版本级比率约束', () => {
  const r = checkAll([
    { metric: 'anomaly_rate', group: '*', op: '<=', value: 0.05 },
    { metric: 'missing_label_rate', group: '*', op: '<=', value: 0.1 },
  ], ctx);
  assert.equal(r[0].passed, true);
  assert.equal(r[1].passed, false, '缺失标签率 0.12 超阈值');
});

test('非法配置返回错误', () => {
  const r = checkAll([{ metric: 'nope', group: '*', op: '>=', value: 1 }], ctx);
  assert.ok(r[0].error);
});
