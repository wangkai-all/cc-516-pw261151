'use strict';
// 异常流量检测：规则打标。被标记的样本在评估中一律排除出正常指标（单独计数）。

const RULES = {
  bot_full_click: '会话曝光≥5 且点击率 100%（疑似机器全点）',
  high_frequency: '会话请求频率过高（>30 次/分钟）',
  invalid_position: '曝光位置非法（position < 1）',
  duplicate_request: '重复 request_id',
  click_without_impression: '有点击无曝光',
};

/**
 * @param samples 数据集样本（需含 id, request_id, ts, session_id, position, impressed, clicked）
 * @returns Map<sampleId, reasonKey>
 */
function detectAnomalies(samples) {
  const flags = new Map();
  const mark = (id, reason) => {
    if (!flags.has(id)) flags.set(id, reason);
  };

  // 规则：重复 request_id（保留第一条，后续标记）
  const seenRequests = new Set();
  for (const s of samples) {
    if (seenRequests.has(s.request_id)) mark(s.id, 'duplicate_request');
    else seenRequests.add(s.request_id);
  }

  // 规则：有点击无曝光 / 非法位置
  for (const s of samples) {
    if (s.clicked && !s.impressed) mark(s.id, 'click_without_impression');
    if (s.impressed && (s.position == null || s.position < 1)) mark(s.id, 'invalid_position');
  }

  // 会话级规则
  const bySession = new Map();
  for (const s of samples) {
    if (!s.session_id) continue;
    if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
    bySession.get(s.session_id).push(s);
  }
  for (const rows of bySession.values()) {
    const impressions = rows.filter((r) => r.impressed).length;
    const clicks = rows.filter((r) => r.clicked).length;
    // 全点机器人：曝光 ≥5 且全部点击
    if (impressions >= 5 && clicks === impressions) {
      for (const r of rows) mark(r.id, 'bot_full_click');
      continue;
    }
    // 高频：任意 60 秒滑动窗口内请求数 > 30
    const times = rows.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    let hi = false;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] > 60_000) j++;
      if (i - j + 1 > 30) { hi = true; break; }
    }
    if (hi) for (const r of rows) mark(r.id, 'high_frequency');
  }

  return flags;
}

module.exports = { RULES, detectAnomalies };
