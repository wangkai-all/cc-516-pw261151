'use strict';
// 约束阈值校验：对评估结果逐条检查，输出通过/违规明细。

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
};

const METRICS = ['ctr', 'rel_lift', 'avg_position', 'anomaly_rate', 'missing_label_rate', 'impressions'];

/**
 * @param constraint { metric, group: '*'|群体名, op, value, version?: 指定版本（默认：rel_lift 作用于 candidate，其余作用于全部版本） }
 * @param ctx { metrics, comparisons, versionTotals, baseline }
 */
function checkConstraint(c, ctx) {
  const results = [];
  const op = OPS[c.op];
  if (!op) return [{ error: `不支持的运算符: ${c.op}` }];
  if (!METRICS.includes(c.metric)) return [{ error: `不支持的指标: ${c.metric}` }];

  const groupMatch = (gk) => c.group === '*' || c.group === gk;

  if (c.metric === 'rel_lift') {
    // 相对提升：仅 candidate 版本有意义
    for (const cmp of ctx.comparisons) {
      if (!groupMatch(cmp.groupKey)) continue;
      if (c.version && cmp.candidate !== c.version) continue;
      const actual = cmp.relLift;
      results.push({
        version: cmp.candidate,
        groupKey: cmp.groupKey,
        metric: c.metric,
        op: c.op,
        threshold: c.value,
        actual,
        passed: actual != null && op(actual, c.value),
        detail: actual == null ? '数据不足，无法计算相对提升' : '',
      });
    }
    return results;
  }

  if (c.metric === 'anomaly_rate' || c.metric === 'missing_label_rate') {
    // 版本级比率
    for (const vt of ctx.versionTotals) {
      if (c.version && vt.version !== c.version) continue;
      const actual = c.metric === 'anomaly_rate' ? vt.anomalyRate : vt.missingLabelRate;
      results.push({
        version: vt.version,
        groupKey: '(all)',
        metric: c.metric,
        op: c.op,
        threshold: c.value,
        actual,
        passed: op(actual, c.value),
        detail: '',
      });
    }
    return results;
  }

  // 组级指标：ctr / avg_position / impressions
  for (const m of ctx.metrics) {
    if (!groupMatch(m.groupKey)) continue;
    if (c.version && m.version !== c.version) continue;
    const actual = c.metric === 'ctr' ? m.ctr : c.metric === 'avg_position' ? m.avgPosition : m.impressions;
    results.push({
      version: m.version,
      groupKey: m.groupKey,
      metric: c.metric,
      op: c.op,
      threshold: c.value,
      actual,
      passed: actual != null && op(actual, c.value),
      detail: actual == null ? '无曝光样本，指标缺失' : '',
    });
  }
  return results;
}

function checkAll(constraints, ctx) {
  const out = [];
  for (const c of constraints || []) out.push(...checkConstraint(c, ctx));
  return out;
}

module.exports = { checkAll, METRICS, OPS };
