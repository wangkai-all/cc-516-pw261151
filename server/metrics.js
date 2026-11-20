'use strict';
// 指标计算核心：分组指标（曝光/点击/CTR/位置分布）、差异证据（两比例 z 检验）、
// 缺失标签策略、异常样本排除。全部为纯函数，保证同一输入 → 同一结果（可回放复现）。

const MISSING_GROUP = '(missing)';
const POS_BUCKETS = 10;

// ---------- 统计基础 ----------

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Wilson score interval（CTR 的 95% 置信区间，小样本稳健）
function wilsonInterval(successes, n, z = 1.959963984540054) {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = successes === 0 ? 0 : Math.max(0, center - half);
  const hi = successes === n ? 1 : Math.min(1, center + half);
  return [lo, hi];
}

// 两比例 z 检验：candidate(2) 相对 baseline(1) 的差异证据
function compareProportions(clicks1, n1, clicks2, n2) {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = clicks1 / n1;
  const p2 = clicks2 / n2;
  const pooled = (clicks1 + clicks2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const seUnpooled = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const diff = p2 - p1;
  return {
    ctrBase: p1,
    ctrCand: p2,
    absDiff: diff,
    relLift: p1 > 0 ? diff / p1 : null,
    z,
    pValue,
    ciLow: diff - 1.959963984540054 * seUnpooled,
    ciHigh: diff + 1.959963984540054 * seUnpooled,
    significant: pValue < 0.05,
  };
}

// ---------- 样本内在异常（计算层兜底，异常流量绝不计入正常样本） ----------

// 不依赖打标流程、在计算时强制执行的硬规则
function intrinsicAnomaly(s) {
  if (s.clicked && !s.impressed) return 'click_without_impression';
  if (s.impressed && (s.position == null || s.position < 1)) return 'invalid_position';
  return null;
}

// ---------- 分组指标 ----------

/**
 * @param samples 已按时间窗过滤的样本（含 is_anomaly 标记）
 * @param opts { versions, baseline, missingLabelPolicy, constraints }
 */
function computeEvaluation(samples, opts) {
  const versions = opts.versions;
  const baseline = opts.baseline;
  const policy = opts.missingLabelPolicy || 'separate_bucket';
  const versionSet = new Set(versions);

  const groups = new Map(); // version + groupKey -> agg
  const anomalyByVersion = new Map(); // version -> count（含标记异常 + 内在异常）
  const anomalyByGroup = new Map(); // version|groupKey -> count（按样本自身群体归属，可加总）
  const totalsByVersion = new Map(); // version -> 全部样本数（含异常，用于 anomaly_rate）

  for (const s of samples) {
    if (!versionSet.has(s.version)) continue;
    totalsByVersion.set(s.version, (totalsByVersion.get(s.version) || 0) + 1);

    const intrinsic = intrinsicAnomaly(s);
    if (s.is_anomaly || intrinsic) {
      anomalyByVersion.set(s.version, (anomalyByVersion.get(s.version) || 0) + 1);
      const rawGroup = s.group_key == null || s.group_key === '' ? MISSING_GROUP : s.group_key;
      const akey = s.version + '|' + rawGroup;
      anomalyByGroup.set(akey, (anomalyByGroup.get(akey) || 0) + 1);
      continue; // 异常流量不进入正常样本指标
    }

    let gk = s.group_key;
    if (gk == null || gk === '') {
      if (policy === 'exclude') continue; // 缺失标签：从指标剔除（单独计数）
      gk = MISSING_GROUP; // 默认：独立成桶，不污染任何已知群体
    }

    const key = s.version + '|' + gk;
    let agg = groups.get(key);
    if (!agg) {
      agg = {
        version: s.version,
        groupKey: gk,
        requests: 0,
        impressions: 0,
        clicks: 0,
        posSum: 0,
        posCount: 0,
        posHist: new Array(POS_BUCKETS).fill(0),
        missing: 0,
      };
      groups.set(key, agg);
    }
    agg.requests += 1;
    if (gk === MISSING_GROUP) agg.missing += 1;
    if (s.impressed) {
      agg.impressions += 1;
      if (s.position != null && s.position >= 1) {
        agg.posSum += s.position;
        agg.posCount += 1;
        const bucket = Math.min(POS_BUCKETS, Math.max(1, Math.ceil(s.position)));
        agg.posHist[bucket - 1] += 1;
      }
      if (s.clicked) agg.clicks += 1;
    }
  }

  const metrics = [...groups.values()]
    .map((agg) => {
      const ctr = agg.impressions > 0 ? agg.clicks / agg.impressions : 0;
      const [ciLow, ciHigh] = wilsonInterval(agg.clicks, agg.impressions);
      return {
        version: agg.version,
        groupKey: agg.groupKey,
        requests: agg.requests,
        impressions: agg.impressions,
        clicks: agg.clicks,
        ctr,
        ctrCiLow: ciLow,
        ctrCiHigh: ciHigh,
        avgPosition: agg.posCount > 0 ? agg.posSum / agg.posCount : null,
        posHist: agg.posHist,
        anomalyExcluded: anomalyByGroup.get(agg.version + '|' + agg.groupKey) || 0,
        missingLabels: agg.missing,
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version) || a.groupKey.localeCompare(b.groupKey));

  // 版本级汇总（约束的 anomaly_rate / missing_label_rate 用）
  const versionTotals = versions.map((v) => {
    const rows = metrics.filter((m) => m.version === v);
    const total = totalsByVersion.get(v) || 0;
    const anomaly = anomalyByVersion.get(v) || 0;
    const missing = rows.reduce((acc, r) => acc + r.missingLabels, 0);
    const impressions = rows.reduce((acc, r) => acc + r.impressions, 0);
    const clicks = rows.reduce((acc, r) => acc + r.clicks, 0);
    return {
      version: v,
      totalSamples: total,
      anomalyExcluded: anomaly,
      anomalyRate: total > 0 ? anomaly / total : 0,
      missingLabels: missing,
      missingLabelRate: total - anomaly > 0 ? missing / (total - anomaly) : 0,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
    };
  });

  // ---------- 差异证据：baseline vs 每个 candidate，按群体 ----------
  const groupKeys = [...new Set(metrics.map((m) => m.groupKey))].sort();
  const comparisons = [];
  for (const gk of groupKeys) {
    const baseRow = metrics.find((m) => m.version === baseline && m.groupKey === gk);
    for (const cand of versions) {
      if (cand === baseline) continue;
      const candRow = metrics.find((m) => m.version === cand && m.groupKey === gk);
      const cmp =
        baseRow && candRow
          ? compareProportions(baseRow.clicks, baseRow.impressions, candRow.clicks, candRow.impressions)
          : null;
      comparisons.push({
        groupKey: gk,
        baseline,
        candidate: cand,
        ctrBase: baseRow ? baseRow.ctr : null,
        ctrCand: candRow ? candRow.ctr : null,
        absDiff: cmp ? cmp.absDiff : null,
        relLift: cmp ? cmp.relLift : null,
        z: cmp ? cmp.z : null,
        pValue: cmp ? cmp.pValue : null,
        ciLow: cmp ? cmp.ciLow : null,
        ciHigh: cmp ? cmp.ciHigh : null,
        significant: cmp ? cmp.significant : false,
        evidence: cmp ? 'two_proportion_z' : 'insufficient_data',
      });
    }
  }

  return { metrics, comparisons, versionTotals };
}

// ---------- 结果 hash（可复现性） ----------

function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null';
    return String(Math.round(v * 1e12) / 1e12); // 固定精度，保证跨次运行 hash 稳定
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

module.exports = {
  MISSING_GROUP,
  POS_BUCKETS,
  normalCdf,
  wilsonInterval,
  compareProportions,
  intrinsicAnomaly,
  computeEvaluation,
  canonical,
};
