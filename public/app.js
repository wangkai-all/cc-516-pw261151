'use strict';
/* 排序结果评估平台前端：分组指标 / 差异证据 / 版本对照 / 影响报告 / 审批 / 样本修订 */

// ---------- 基础 ----------

const state = {
  user: localStorage.getItem('rank-eval-user') || 'carol',
  tab: location.hash.slice(1) || 'datasets',
  users: [],
  datasets: [],
  versions: [],
  evaluations: [],
  currentEvalId: null,
  evalCache: {},
};

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const versionColor = new Map(); // 颜色跟随版本实体，不随筛选变化

function colorForVersion(v) {
  if (!versionColor.has(v)) versionColor.set(v, SERIES_COLORS[versionColor.size % 3]);
  return versionColor.get(v);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': state.user,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

async function guard(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

// ---------- 格式化 ----------

const fmtPct = (x, digits = 2) => (x == null ? '—' : (x * 100).toFixed(digits) + '%');
const fmtNum = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));
const fmtCompact = (x) => {
  if (x == null) return '—';
  if (Math.abs(x) >= 1e6) return (x / 1e6).toFixed(1) + 'M';
  if (Math.abs(x) >= 1e4) return (x / 1e3).toFixed(1) + 'K';
  return String(Math.round(x * 100) / 100);
};
const fmtSigned = (x, digits = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(digits) + '%');
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
const shortHash = (h) => (h ? h.slice(0, 12) : '—');

// ---------- DOM 工具 ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------- Tooltip（textContent 渲染，不注入 HTML） ----------

const tooltip = () => document.getElementById('tooltip');

function showTooltip(x, y, rows) {
  const tt = tooltip();
  tt.replaceChildren();
  for (const row of rows) {
    if (row.header) tt.append(el('div', { class: 'tt-label' }, row.header));
    else {
      const line = el('div', { class: 'tt-row' });
      if (row.color) line.append(el('span', { class: 'tt-key', style: `background:${row.color}` }));
      line.append(el('span', { class: 'tt-value' }, row.value), el('span', { class: 'tt-label' }, row.label || ''));
      tt.append(line);
    }
  }
  tt.hidden = false;
  const rect = tt.getBoundingClientRect();
  tt.style.left = Math.min(x + 12, innerWidth - rect.width - 8) + 'px';
  tt.style.top = Math.max(8, y - rect.height - 10) + 'px';
}

function hideTooltip() { tooltip().hidden = true; }

function attachTooltip(mark, rowsFn) {
  mark.setAttribute('tabindex', '0');
  const show = (evt) => {
    const p = evt.touches ? evt.touches[0] : evt;
    showTooltip(p.clientX, p.clientY, rowsFn());
  };
  mark.addEventListener('pointermove', show);
  mark.addEventListener('focus', () => {
    const r = mark.getBoundingClientRect();
    showTooltip(r.left + r.width / 2, r.top, rowsFn());
  });
  mark.addEventListener('pointerleave', hideTooltip);
  mark.addEventListener('blur', hideTooltip);
}

// ---------- SVG 图表 ----------

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/**
 * 分组柱状图：x 轴类别 × 多系列（版本）。
 * 规范：柱 ≤24px、数据端 4px 圆角、基线端方形、相邻柱 2px 表面色间隔、图例、逐柱 tooltip。
 */
function groupedBarChart({ categories, series, yLabel, valueFmt = fmtPct, height = 260 }) {
  // series: [{ name, color, values: [number|null] }]
  const W = 720, H = height, padL = 56, padR = 12, padT = 14, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...series.flatMap((s) => s.values.filter((v) => v != null)), 0.0001);
  const yMax = maxV * 1.15;
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img' });
  svg.style.maxWidth = '760px';

  // 网格线 + y 轴刻度（4 条，整洁数值）
  const grid = svgEl('g', { class: 'grid' });
  const axis = svgEl('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const gy = y(v);
    grid.append(svgEl('line', { x1: padL, x2: W - padR, y1: gy, y2: gy }));
    const t = svgEl('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end' });
    t.textContent = valueFmt(v, true);
    axis.append(t);
  }
  // 基线
  svg.append(grid, svgEl('line', {
    class: 'baseline-line', x1: padL, x2: W - padR, y1: y(0), y2: y(0),
  }), axis);

  const slotW = plotW / categories.length;
  const nSeries = series.length;
  const gap = 2; // 2px 表面色间隔
  const barW = Math.min(24, (slotW * 0.72 - gap * (nSeries - 1)) / nSeries);
  const groupW = barW * nSeries + gap * (nSeries - 1);

  categories.forEach((cat, ci) => {
    const cx = padL + slotW * ci + slotW / 2;
    const x0 = cx - groupW / 2;
    series.forEach((s, si) => {
      const v = s.values[ci];
      if (v == null) return;
      const bx = x0 + si * (barW + gap);
      const by = y(v);
      const bh = y(0) - by;
      const bar = svgEl('path', {
        class: 'mark',
        d: roundedTopRect(bx, by, barW, Math.max(bh, 1), 4),
        fill: s.color,
      });
      attachTooltip(bar, () => [
        { header: `${cat} · ${s.name}` },
        { value: valueFmt(v), label: yLabel, color: s.color },
      ]);
      svg.append(bar);
      // 命中区域（≥24px 宽）
      const hit = svgEl('rect', {
        x: bx - Math.max(0, (24 - barW) / 2), y: padT, width: Math.max(24, barW), height: plotH,
        fill: 'transparent', class: 'mark',
      });
      attachTooltip(hit, () => [
        { header: `${cat} · ${s.name}` },
        { value: valueFmt(v), label: yLabel, color: s.color },
      ]);
      svg.append(hit);
    });
    const label = svgEl('text', { x: cx, y: H - padB + 18, 'text-anchor': 'middle' });
    label.textContent = cat;
    axis.append(label);
  });

  return { svg, legend: buildLegend(series.map((s) => ({ name: s.name, color: s.color }))) };
}

// 数据端 4px 圆角、基线端方形
function roundedTopRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function buildLegend(items) {
  const row = el('div', { class: 'legend', role: 'list' });
  for (const it of items) {
    row.append(el('span', { class: 'key', role: 'listitem' },
      el('span', { class: 'swatch', style: `background:${it.color}` }), it.name));
  }
  return row;
}

/**
 * 差异森林图：每个群体一行，点 = CTR 差值，横线 = 95% CI。
 * 发散编码：负 = 红，正 = 蓝，0 为中性基线。
 */
function forestPlot({ rows, height }) {
  // rows: [{ label, diff, ciLow, ciHigh, significant, color }]
  const W = 720, rowH = 34, padL = 130, padR = 30, padT = 16, padB = 30;
  const H = height || padT + padB + rows.length * rowH;
  const plotW = W - padL - padR;
  const extent = Math.max(0.005, ...rows.flatMap((r) => [Math.abs(r.ciLow ?? 0), Math.abs(r.ciHigh ?? 0)])) * 1.15;
  const x = (v) => padL + ((v + extent) / (2 * extent)) * plotW;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img' });
  svg.style.maxWidth = '760px';

  // 网格 + 轴
  const grid = svgEl('g', { class: 'grid' });
  const axis = svgEl('g', { class: 'axis' });
  const ticks = 4;
  for (let i = -ticks; i <= ticks; i += 2) {
    const v = (extent / ticks) * i;
    const gx = x(v);
    grid.append(svgEl('line', { x1: gx, x2: gx, y1: padT, y2: H - padB }));
    const t = svgEl('text', { x: gx, y: H - padB + 16, 'text-anchor': 'middle' });
    t.textContent = fmtSigned(v, 1);
    axis.append(t);
  }
  svg.append(grid, axis);
  // 0 基线（中性）
  svg.append(svgEl('line', {
    class: 'baseline-line', x1: x(0), x2: x(0), y1: padT - 4, y2: H - padB, 'stroke-width': 1.5,
  }));

  rows.forEach((r, i) => {
    const cy = padT + rowH * i + rowH / 2;
    const label = svgEl('text', { x: padL - 10, y: cy + 4, 'text-anchor': 'end', fill: 'var(--text-secondary)', 'font-size': 12 });
    label.textContent = r.label;
    svg.append(label);
    if (r.diff == null) {
      const na = svgEl('text', { x: x(0), y: cy + 4, 'text-anchor': 'middle', fill: 'var(--text-muted)', 'font-size': 11 });
      na.textContent = '数据不足';
      svg.append(na);
      return;
    }
    const color = r.diff >= 0 ? 'var(--diverging-pos)' : 'var(--diverging-neg)';
    // CI 横线（2px）
    const ci = svgEl('line', {
      x1: x(r.ciLow), x2: x(r.ciHigh), y1: cy, y2: cy,
      stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', class: 'mark',
    });
    // 点估计（r=5，带 2px 表面色环）
    const dot = svgEl('circle', {
      cx: x(r.diff), cy, r: 5, fill: color,
      stroke: 'var(--surface-1)', 'stroke-width': 2, class: 'mark',
    });
    const rowsFn = () => [
      { header: r.label },
      { value: fmtSigned(r.diff), label: 'CTR 差值（候选−基线）', color },
      { value: `${fmtSigned(r.ciLow)} ~ ${fmtSigned(r.ciHigh)}`, label: '95% 置信区间' },
      { value: r.significant ? '显著 (p<0.05)' : '不显著', label: '统计结论' },
    ];
    attachTooltip(ci, rowsFn);
    attachTooltip(dot, rowsFn);
    // 命中区域
    const hit = svgEl('rect', { x: padL, y: cy - rowH / 2, width: plotW, height: rowH, fill: 'transparent', class: 'mark' });
    attachTooltip(hit, rowsFn);
    svg.append(ci, dot, hit);
  });

  return { svg };
}

// ---------- 通用渲染 ----------

function statTile(label, value, deltaText, deltaClass) {
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value),
    deltaText ? el('div', { class: `delta ${deltaClass || 'neutral'}` }, deltaText) : null);
}

function badge(text, kind) {
  return el('span', { class: `badge ${kind}` }, text);
}

function dataTable(headers, rows) {
  const table = el('table', { class: 'data' });
  const thead = el('thead');
  thead.append(el('tr', {}, headers.map((h) => el('th', {}, h))));
  const tbody = el('tbody');
  for (const r of rows) tbody.append(r);
  table.append(thead, tbody);
  return table;
}

// ---------- Tab: 数据集 ----------

async function renderDatasets(main) {
  const [{ datasets }] = await Promise.all([api('/api/datasets')]);
  state.datasets = datasets;

  const card = el('div', { class: 'card' },
    el('h2', {}, '数据集'),
    el('p', { class: 'sub' }, '导入的样本日志不可变；异常流量经规则打标后不计入正常指标。'));

  if (!datasets.length) {
    card.append(el('div', { class: 'empty' }, '暂无数据集。可运行 npm run seed 生成演示数据，或在下方导入。'));
  }

  for (const ds of datasets) {
    const detail = await api(`/api/datasets/${ds.id}`);
    const tileRow = el('div', { class: 'stat-row' },
      statTile('样本总量', fmtNum(ds.sample_count)),
      statTile('异常流量', fmtNum(ds.anomaly_count),
        ds.sample_count ? fmtPct(ds.anomaly_count / ds.sample_count, 1) + ' 已剔除' : '', 'neutral'),
      statTile('输入指纹', shortHash(ds.input_hash)),
      statTile('导入时间', fmtTime(ds.created_at).slice(0, 10)));

    const verRows = detail.version_stats.map((v) => el('tr', {},
      el('td', {}, v.version),
      el('td', {}, fmtNum(v.n)),
      el('td', {}, fmtNum(v.anomalies)),
      el('td', {}, fmtNum(v.missing)),
      el('td', {}, v.n ? fmtPct(v.missing / v.n, 1) : '—')));

    const detectBtn = el('button', {
      class: 'btn',
      onclick: () => guard(async () => {
        const r = await api(`/api/datasets/${ds.id}/detect-anomalies`, { method: 'POST' });
        toast(`异常检测完成：${r.flagged}/${r.total} 条被标记`);
        render();
      }),
    }, '重新检测异常流量');
    const browseBtn = el('button', {
      class: 'btn',
      onclick: () => guard(async () => { await renderSampleBrowser(main, ds.id); }),
    }, '浏览样本');

    card.append(el('div', { class: 'section-gap' },
      el('h3', {}, `#${ds.id} ${ds.name}`),
      tileRow,
      el('h3', {}, '版本分布'),
      dataTable(['版本', '样本数', '异常数', '缺失标签数', '缺失率'], verRows),
      el('div', { class: 'form-row', style: 'margin-top:10px' }, detectBtn, browseBtn)));
  }

  // 导入区
  const importArea = el('textarea', {
    rows: 5, style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
    placeholder: '[{"request_id":"r1","ts":"2026-11-20T08:00:00Z","version":"v1.0-baseline","group_key":"new_users","item_id":"i1","position":2,"impressed":1,"clicked":0,"session_id":"s1"}]',
  });
  const nameInput = el('input', { placeholder: '数据集名称' });
  card.append(el('div', { class: 'section-gap' },
    el('h3', {}, '导入新数据集（JSON 数组）'),
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, '名称'), nameInput)),
    importArea,
    el('div', { class: 'form-row', style: 'margin-top:8px' },
      el('button', {
        class: 'btn primary',
        onclick: () => guard(async () => {
          const samples = JSON.parse(importArea.value);
          const r = await api('/api/datasets', { method: 'POST', body: { name: nameInput.value, samples } });
          toast(`导入成功：数据集 #${r.id}，${r.sample_count} 条样本`);
          render();
        }),
      }, '导入'))));

  main.replaceChildren(card);
}

async function renderSampleBrowser(main, datasetId, filters = {}) {
  const q = new URLSearchParams({ limit: '200', ...filters });
  const { samples, total } = await api(`/api/datasets/${datasetId}/samples?${q}`);

  const anomalySel = el('select', {},
    el('option', { value: '' }, '全部样本'),
    el('option', { value: '1' }, '仅异常'),
    el('option', { value: '0' }, '仅正常'));
  anomalySel.value = filters.anomaly ?? '';
  const missingSel = el('select', {},
    el('option', { value: '' }, '标签：全部'),
    el('option', { value: '1' }, '仅缺失标签'));
  missingSel.value = filters.missing ?? '';
  const applyBtn = el('button', {
    class: 'btn',
    onclick: () => guard(() => renderSampleBrowser(main, datasetId, {
      anomaly: anomalySel.value, missing: missingSel.value,
    })),
  }, '筛选');

  const rows = samples.map((s) => el('tr', { class: s.is_anomaly ? 'row-anomaly' : s.group_key == null ? 'row-missing' : '' },
    el('td', {}, `#${s.id}`),
    el('td', {}, s.request_id),
    el('td', {}, fmtTime(s.ts)),
    el('td', {}, s.version),
    el('td', {}, s.group_key ?? '(缺失)'),
    el('td', {}, s.position ?? '—'),
    el('td', {}, s.impressed ? '是' : '否'),
    el('td', {}, s.clicked ? '是' : '否'),
    el('td', {}, s.is_anomaly ? `异常：${s.anomaly_reason}` : '正常')));

  main.replaceChildren(el('div', { class: 'card' },
    el('h2', {}, `数据集 #${datasetId} 样本浏览`),
    el('p', { class: 'sub' }, `共 ${fmtNum(total)} 条（显示前 ${samples.length} 条）。红色 = 异常流量（不计入指标）；斜体 = 缺失标签。`),
    el('div', { class: 'filter-row' },
      el('div', { class: 'field' }, el('label', {}, '异常状态'), anomalySel),
      el('div', { class: 'field' }, el('label', {}, '标签'), missingSel),
      applyBtn,
      el('button', { class: 'btn', onclick: () => render() }, '返回')),
    dataTable(['ID', '请求', '时间', '版本', '群体', '位置', '曝光', '点击', '判定'], rows)));
}

// ---------- Tab: 评估 ----------

async function renderEvaluations(main) {
  const [{ evaluations }, { versions }, { datasets }] = await Promise.all([
    api('/api/evaluations'), api('/api/versions'), api('/api/datasets')]);
  state.evaluations = evaluations;
  state.versions = versions;
  state.datasets = datasets;

  // 新建评估后直接进入详情
  if (state.currentEvalId) {
    const id = state.currentEvalId;
    state.currentEvalId = null;
    return renderEvalDetail(main, id);
  }

  const main_ = el('div');
  main_.append(buildEvalForm(versions, datasets));

  const listCard = el('div', { class: 'card' },
    el('h2', {}, '评估记录'),
    el('p', { class: 'sub' }, '评估结果生成后不可变；回放会基于同一输入配置生成新评估，旧结果完整保留。'));
  if (!evaluations.length) listCard.append(el('div', { class: 'empty' }, '暂无评估，请在上方创建。'));
  for (const ev of evaluations) {
    const row = el('div', {
      class: 'form-row', style: 'justify-content:space-between;border-bottom:1px solid var(--gridline);padding:8px 0',
    },
      el('div', {},
        el('strong', {}, `#${ev.id} ${ev.name} `),
        ev.replay_of ? badge(`回放自 #${ev.replay_of}`, 'muted') : null,
        el('div', { class: 'muted', style: 'font-size:12px' },
          `版本 ${ev.versions.join(' / ')} · 基线 ${ev.baseline} · 窗口 ${ev.time_start ? ev.time_start.slice(0, 10) : '全部'} ~ ${ev.time_end ? ev.time_end.slice(0, 10) : '全部'} · ${fmtTime(ev.created_at)} · 结果指纹 `,
        ),
        el('span', { class: 'hash-pill' }, shortHash(ev.result_hash))),
      el('div', { class: 'form-row' },
        el('button', { class: 'btn primary', onclick: () => guard(() => renderEvalDetail(main, ev.id)) }, '查看'),
        el('button', {
          class: 'btn',
          onclick: () => guard(async () => {
            const r = await api(`/api/evaluations/${ev.id}/replay`, { method: 'POST' });
            toast(r.note, !r.result_hash_same);
            render();
          }),
        }, '回放同一输入')));
    listCard.append(row);
  }
  main_.append(listCard);
  main.replaceChildren(main_);
}

function buildEvalForm(versions, datasets) {
  const nameInput = el('input', { placeholder: '例如：v1.1 上线前评估' });
  const dsSel = el('select', {}, datasets.map((d) => el('option', { value: d.id }, `#${d.id} ${d.name}`)));
  const verNames = versions.map((v) => v.name);
  const verBoxes = verNames.map((v) => {
    const cb = el('input', { type: 'checkbox', value: v, checked: true });
    return { cb, node: el('label', { style: 'display:inline-flex;gap:4px;align-items:center;margin-right:12px;font-weight:400' }, cb, v) };
  });
  const baseSel = el('select', {}, verNames.map((v) => el('option', { value: v }, v)));
  const startInput = el('input', { type: 'date' });
  const endInput = el('input', { type: 'date' });
  const policySel = el('select', {},
    el('option', { value: 'separate_bucket' }, '缺失标签独立成桶 (missing)'),
    el('option', { value: 'exclude' }, '缺失标签从指标剔除'));
  const constraintsInput = el('textarea', {
    rows: 3, style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
    placeholder: '[{"metric":"rel_lift","group":"*","op":">=","value":-0.05},{"metric":"ctr","group":"premium","op":">=","value":0.18},{"metric":"anomaly_rate","group":"*","op":"<=","value":0.1}]',
  });
  constraintsInput.value = '[{"metric":"rel_lift","group":"*","op":">=","value":-0.05},{"metric":"anomaly_rate","group":"*","op":"<=","value":0.1}]';

  return el('div', { class: 'card' },
    el('h2', {}, '创建评估'),
    el('p', { class: 'sub' }, '选择版本集合与时间窗口，配置约束阈值；异常流量自动排除，缺失标签按策略处理。'),
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, '名称'), nameInput),
      el('div', { class: 'field' }, el('label', {}, '数据集'), dsSel),
      el('div', { class: 'field' }, el('label', {}, '基线版本'), baseSel),
      el('div', { class: 'field' }, el('label', {}, '窗口起'), startInput),
      el('div', { class: 'field' }, el('label', {}, '窗口止'), endInput),
      el('div', { class: 'field' }, el('label', {}, '缺失标签策略'), policySel)),
    el('div', { class: 'field', style: 'margin-bottom:10px' }, el('label', {}, '参与版本'), el('div', {}, verBoxes.map((b) => b.node))),
    el('div', { class: 'field' }, el('label', {}, '约束阈值（JSON 数组，可为空）'), constraintsInput),
    el('div', { class: 'form-row', style: 'margin-top:10px' },
      el('button', {
        class: 'btn primary',
        onclick: () => guard(async () => {
          const selected = verBoxes.filter((b) => b.cb.checked).map((b) => b.cb.value);
          const constraints = constraintsInput.value.trim() ? JSON.parse(constraintsInput.value) : [];
          const r = await api('/api/evaluations', {
            method: 'POST',
            body: {
              name: nameInput.value || '未命名评估',
              dataset_id: Number(dsSel.value),
              versions: selected,
              baseline: baseSel.value,
              time_start: startInput.value ? `${startInput.value}T00:00:00.000Z` : null,
              time_end: endInput.value ? `${endInput.value}T23:59:59.999Z` : null,
              missing_label_policy: policySel.value,
              constraints,
            },
          });
          toast(`评估 #${r.id} 已生成，结果指纹 ${shortHash(r.result_hash)}`);
          state.currentEvalId = r.id;
          render();
        }),
      }, '运行评估')));
}

async function renderEvalDetail(main, evalId) {
  const ev = await api(`/api/evaluations/${evalId}`);
  state.evalCache[evalId] = ev;
  const wrap = el('div');

  // 头部统计
  const totalAnomaly = ev.metrics.reduce((a, m) => a + m.anomaly_excluded, 0);
  const missingRow = ev.metrics.filter((m) => m.group_key === '(missing)');
  const missingCount = missingRow.reduce((a, m) => a + m.requests, 0);
  const violations = ev.constraint_results.filter((c) => !c.passed);

  wrap.append(el('div', { class: 'card' },
    el('h2', {}, `#${ev.id} ${ev.name}`),
    el('p', { class: 'sub' },
      `基线 ${ev.baseline} · 缺失标签策略 ${ev.missing_label_policy} · 窗口 ${ev.time_start ? ev.time_start.slice(0, 10) : '全部'} ~ ${ev.time_end ? ev.time_end.slice(0, 10) : '全部'} · 创建于 ${fmtTime(ev.created_at)}`),
    el('div', { class: 'stat-row' },
      statTile('参与版本', ev.versions.length),
      statTile('异常流量剔除', fmtNum(totalAnomaly), '未计入任何指标', 'neutral'),
      statTile('缺失标签样本', fmtNum(missingCount),
        ev.missing_label_policy === 'exclude' ? '已从指标剔除' : '归入 (missing) 桶', 'neutral'),
      statTile('约束校验', violations.length ? `${violations.length} 项违规` : '全部通过',
        '', violations.length ? 'down-bad' : 'up-good')),
    el('div', { class: 'form-row' },
      el('span', { class: 'muted' }, '输入指纹 ', ),
      el('span', { class: 'hash-pill' }, shortHash(ev.input_hash)),
      el('span', { class: 'muted' }, '结果指纹 '),
      el('span', { class: 'hash-pill' }, shortHash(ev.result_hash)),
      el('button', { class: 'btn', onclick: () => render() }, '返回列表'))));

  // 分组指标表
  const groupKeys = [...new Set(ev.metrics.map((m) => m.group_key))].sort();
  const metricRows = ev.metrics.map((m) => el('tr', { class: m.group_key === '(missing)' ? 'row-missing' : '' },
    el('td', {}, m.version),
    el('td', {}, m.group_key),
    el('td', {}, fmtNum(m.impressions)),
    el('td', {}, fmtNum(m.clicks)),
    el('td', {}, fmtPct(m.ctr)),
    el('td', {}, `${fmtPct(m.ctr_ci_low)} ~ ${fmtPct(m.ctr_ci_high)}`),
    el('td', {}, m.avg_position == null ? '—' : m.avg_position.toFixed(2)),
    el('td', {}, fmtNum(m.anomaly_excluded))));

  // CTR 分组对比图（版本为系列）
  const ctrChart = groupedBarChart({
    categories: groupKeys,
    series: ev.versions.map((v) => ({
      name: v,
      color: colorForVersion(v),
      values: groupKeys.map((g) => {
        const m = ev.metrics.find((r) => r.version === v && r.group_key === g);
        return m ? m.ctr : null;
      }),
    })),
    yLabel: 'CTR',
    valueFmt: fmtPct,
  });

  // 位置分布图（选中群体）
  const groupSel = el('select', {}, groupKeys.map((g) => el('option', { value: g }, g)));
  const posChartBox = el('div');
  const renderPosChart = () => {
    const g = groupSel.value;
    const chart = groupedBarChart({
      categories: Array.from({ length: 10 }, (_, i) => `位置${i + 1}`),
      series: ev.versions.map((v) => {
        const m = ev.metrics.find((r) => r.version === v && r.group_key === g);
        return { name: v, color: colorForVersion(v), values: m ? m.pos_hist : Array(10).fill(null) };
      }),
      yLabel: '曝光数',
      valueFmt: (v, axis) => (axis ? fmtCompact(v) : fmtNum(v)),
    });
    posChartBox.replaceChildren(chart.legend, chart.svg);
  };
  groupSel.addEventListener('change', renderPosChart);
  renderPosChart();

  wrap.append(el('div', { class: 'card' },
    el('h2', {}, '分组指标'),
    el('p', { class: 'sub' }, 'CTR 含 Wilson 95% 置信区间；异常样本已剔除，缺失标签按策略单列。'),
    ctrChart.legend,
    el('div', { class: 'chart-wrap' }, ctrChart.svg),
    dataTable(['版本', '群体', '曝光', '点击', 'CTR', 'CTR 95% CI', '平均位置', '异常剔除'], metricRows)));

  wrap.append(el('div', { class: 'card' },
    el('h2', {}, '位置分布'),
    el('p', { class: 'sub' }, '各版本在选定群体上的曝光位置直方图（位置 1 = 最靠前）。'),
    el('div', { class: 'filter-row' },
      el('div', { class: 'field' }, el('label', {}, '群体'), groupSel)),
    posChartBox));

  // 差异证据
  const compGroups = [...new Set(ev.comparisons.map((c) => c.group_key))];
  const candidates = [...new Set(ev.comparisons.map((c) => c.candidate))];
  const evidenceCard = el('div', { class: 'card' },
    el('h2', {}, '差异证据'),
    el('p', { class: 'sub' }, `候选版本相对基线 ${ev.baseline} 的 CTR 差异（两比例 z 检验，95% CI）。蓝 = 提升，红 = 下降，横线 = 置信区间。`));
  for (const cand of candidates) {
    const rows = ev.comparisons.filter((c) => c.candidate === cand);
    const forest = forestPlot({
      rows: rows.map((c) => ({
        label: c.group_key,
        diff: c.abs_diff,
        ciLow: c.ci_low,
        ciHigh: c.ci_high,
        significant: !!c.significant,
      })),
    });
    const compRows = rows.map((c) => el('tr', {},
      el('td', {}, c.group_key),
      el('td', {}, fmtPct(c.ctr_base)),
      el('td', {}, fmtPct(c.ctr_cand)),
      el('td', {}, fmtSigned(c.abs_diff)),
      el('td', {}, c.rel_lift == null ? '—' : fmtSigned(c.rel_lift, 1)),
      el('td', {}, c.p_value == null ? '—' : c.p_value < 0.001 ? '<0.001' : c.p_value.toFixed(3)),
      el('td', {}, c.ci_low == null ? '—' : `${fmtSigned(c.ci_low)} ~ ${fmtSigned(c.ci_high)}`),
      el('td', {}, c.significant ? badge('显著', c.abs_diff > 0 ? 'good' : 'bad') : badge('不显著', 'muted'))));
    evidenceCard.append(
      el('h3', {}, `${cand} vs ${ev.baseline}`),
      el('div', { class: 'chart-wrap' }, forest.svg),
      dataTable(['群体', '基线 CTR', '候选 CTR', '绝对差', '相对提升', 'p 值', '95% CI', '结论'], compRows));
  }
  wrap.append(evidenceCard);

  // 约束校验
  if (ev.constraint_results.length) {
    const kRows = ev.constraint_results.map((k) => el('tr', {},
      el('td', {}, k.version),
      el('td', {}, k.group_key),
      el('td', {}, k.metric),
      el('td', {}, `${k.op} ${k.threshold}`),
      el('td', {}, k.actual == null ? '—' : k.metric.includes('rate') || k.metric === 'ctr' || k.metric === 'rel_lift' ? fmtPct(k.actual) : Number(k.actual).toFixed(2)),
      el('td', {}, k.passed ? badge('通过', 'good') : badge('违规', 'bad')),
      el('td', {}, k.detail || '')));
    wrap.append(el('div', { class: 'card' },
      el('h2', {}, '约束阈值校验'),
      violations.length
        ? el('div', { class: 'notice bad' }, `存在 ${violations.length} 项约束违规，版本切换的影响报告将被标记为“不建议切换”。`)
        : el('div', { class: 'notice good' }, '全部约束通过。'),
      dataTable(['版本', '群体', '指标', '阈值', '实际值', '结论', '说明'], kRows)));
  }

  main.replaceChildren(wrap);
}

// ---------- Tab: 版本对照 ----------

async function renderCompare(main) {
  const [{ versions }, { evaluations }] = await Promise.all([api('/api/versions'), api('/api/evaluations')]);

  const sel = el('select', {},
    el('option', { value: '' }, '选择评估…'),
    evaluations.map((e) => el('option', { value: e.id }, `#${e.id} ${e.name}`)));
  if (evaluations.length) sel.value = String(evaluations[0].id);
  const box = el('div');

  const renderOne = async () => {
    if (!sel.value) { box.replaceChildren(el('div', { class: 'empty' }, '请先创建评估。')); return; }
    const ev = state.evalCache[sel.value] || await api(`/api/evaluations/${sel.value}`);
    state.evalCache[sel.value] = ev;
    const groupKeys = [...new Set(ev.metrics.map((m) => m.group_key))].sort();

    // 每版本总体 CTR
    const totals = ev.versions.map((v) => {
      const rows = ev.metrics.filter((m) => m.version === v && m.group_key !== '(missing)');
      const imp = rows.reduce((a, r) => a + r.impressions, 0);
      const clk = rows.reduce((a, r) => a + r.clicks, 0);
      return { version: v, impressions: imp, clicks: clk, ctr: imp ? clk / imp : 0 };
    });
    const base = totals.find((t) => t.version === ev.baseline);

    const ctrChart = groupedBarChart({
      categories: groupKeys,
      series: ev.versions.map((v) => ({
        name: v, color: colorForVersion(v),
        values: groupKeys.map((g) => {
          const m = ev.metrics.find((r) => r.version === v && r.group_key === g);
          return m ? m.ctr : null;
        }),
      })),
      yLabel: 'CTR', valueFmt: fmtPct,
    });

    const totalRows = totals.map((t) => {
      const delta = base && t.version !== base.version && base.ctr ? (t.ctr - base.ctr) / base.ctr : null;
      return el('tr', {},
        el('td', {}, t.version, t.version === ev.baseline ? ' （基线）' : ''),
        el('td', {}, fmtNum(t.impressions)),
        el('td', {}, fmtNum(t.clicks)),
        el('td', {}, fmtPct(t.ctr)),
        el('td', {}, delta == null ? '—' : fmtSigned(delta, 1)));
    });

    const verStatus = versions.map((v) => el('tr', {},
      el('td', {}, v.name),
      el('td', {}, v.status === 'active' ? badge('active 线上', 'good')
        : v.status === 'candidate' ? badge('candidate 候选', 'info')
        : v.status === 'archived' ? badge('archived 已归档', 'muted') : badge('draft 草稿', 'warn')),
      el('td', {}, fmtTime(v.activated_at)),
      el('td', {}, fmtTime(v.archived_at))));

    box.replaceChildren(
      el('div', { class: 'card' },
        el('h2', {}, '版本状态'),
        dataTable(['版本', '状态', '上线时间', '归档时间'], verStatus)),
      el('div', { class: 'card' },
        el('h2', {}, `版本对照（评估 #${ev.id}）`),
        el('p', { class: 'sub' }, '总体 CTR 相对基线的提升幅度；分组明细见下表。'),
        el('div', { class: 'stat-row' },
          totals.map((t) => {
            const delta = base && t.version !== base.version && base.ctr ? (t.ctr - base.ctr) / base.ctr : null;
            return statTile(t.version, fmtPct(t.ctr),
              delta == null ? (t.version === ev.baseline ? '基线' : '') : `相对基线 ${fmtSigned(delta, 1)}`,
              delta == null ? 'neutral' : delta >= 0 ? 'up-good' : 'down-bad');
          })),
        ctrChart.legend,
        el('div', { class: 'chart-wrap' }, ctrChart.svg),
        dataTable(['版本', '总曝光', '总点击', '总体 CTR', '相对基线'], totalRows)));
  };
  sel.addEventListener('change', () => guard(renderOne));

  main.replaceChildren(el('div', {},
    el('div', { class: 'card' },
      el('div', { class: 'filter-row' },
        el('div', { class: 'field' }, el('label', {}, '评估'), sel))),
    box));
  await renderOne();
}

// ---------- Tab: 影响报告 ----------

async function renderReports(main) {
  const [{ reports }, { evaluations }, { versions }] = await Promise.all([
    api('/api/impact-reports'), api('/api/evaluations'), api('/api/versions')]);

  const wrap = el('div');

  // 生成表单
  const evalSel = el('select', {}, evaluations.map((e) => el('option', { value: e.id }, `#${e.id} ${e.name}`)));
  const fromSel = el('select', {}, versions.map((v) => el('option', { value: v.name }, v.name)));
  const toSel = el('select', {}, versions.map((v) => el('option', { value: v.name }, v.name)));
  if (versions.length > 1) toSel.value = versions[1].name;
  wrap.append(el('div', { class: 'card' },
    el('h2', {}, '生成影响报告'),
    el('p', { class: 'sub' }, '版本切换前必须基于评估生成影响报告；报告是审批与切换的前置条件。'),
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, '依据评估'), evalSel),
      el('div', { class: 'field' }, el('label', {}, '从版本'), fromSel),
      el('div', { class: 'field' }, el('label', {}, '切换到'), toSel),
      el('button', {
        class: 'btn primary',
        onclick: () => guard(async () => {
          const r = await api('/api/impact-reports', {
            method: 'POST',
            body: { evaluation_id: Number(evalSel.value), from_version: fromSel.value, to_version: toSel.value },
          });
          toast(`影响报告 #${r.id} 已生成：${r.summary.recommendation_note}`);
          render();
        }),
      }, '生成报告'))));

  // 报告列表
  for (const r of reports) {
    const s = r.summary;
    const recBadge = s.recommendation === 'recommended' ? badge('建议切换', 'good')
      : s.recommendation === 'caution' ? badge('谨慎切换', 'warn') : badge('不建议切换', 'bad');

    const groupLine = (g) => `${g.group}：CTR ${fmtPct(g.ctr_base)} → ${fmtPct(g.ctr_cand)}（${fmtSigned(g.rel_lift, 1)}）`;
    const card = el('div', { class: 'card' },
      el('h2', {}, `#${r.id} ${r.from_version} → ${r.to_version} `, recBadge),
      el('p', { class: 'sub' }, `依据评估 #${r.evaluation_id} · ${r.created_by} 创建于 ${fmtTime(r.created_at)}`),
      el('div', { class: `notice ${s.recommendation === 'blocked' ? 'bad' : s.recommendation === 'caution' ? 'warn' : 'good'}` }, s.recommendation_note),
      el('div', { class: 'grid-2' },
        el('div', {},
          el('h3', {}, `受益群体（${s.benefited_groups.length}）`),
          s.benefited_groups.length
            ? el('ul', {}, s.benefited_groups.map((g) => el('li', {}, groupLine(g))))
            : el('div', { class: 'empty' }, '无显著受益群体'),
          el('h3', {}, `受损群体（${s.harmed_groups.length}）`),
          s.harmed_groups.length
            ? el('ul', {}, s.harmed_groups.map((g) => el('li', {}, groupLine(g))))
            : el('div', { class: 'empty' }, '无显著受损群体')),
        el('div', {},
          el('h3', {}, `约束违规（${s.constraint_violations.length}）`),
          s.constraint_violations.length
            ? el('ul', {}, s.constraint_violations.map((v) => el('li', {},
                `${v.version} / ${v.group}：${v.metric} 要求 ${v.op} ${v.threshold}，实际 ${v.actual == null ? '—' : Number(v.actual).toFixed(4)}`)))
            : el('div', { class: 'empty' }, '无约束违规'),
          el('h3', {}, '数据质量'),
          el('ul', {},
            el('li', {}, `异常流量剔除 ${fmtNum(s.data_quality.anomaly_excluded)} 条（${fmtPct(s.data_quality.anomaly_rate, 1)}），未计入指标`),
            el('li', {}, `缺失标签样本 ${fmtNum(s.data_quality.missing_label_samples)} 条：${s.data_quality.missing_label_note}`)))),
      el('div', { class: 'form-row' },
        el('button', {
          class: 'btn',
          onclick: () => guard(async () => {
            const rr = await api('/api/approvals', { method: 'POST', body: { report_id: r.id } });
            toast(`审批申请 #${rr.id} 已提交，等待审批人处理`);
            render();
          }),
        }, '提交切换审批')));
    wrap.append(card);
  }
  if (!reports.length) wrap.append(el('div', { class: 'card' }, el('div', { class: 'empty' }, '暂无影响报告。')));

  main.replaceChildren(wrap);
}

// ---------- Tab: 审批记录 ----------

async function renderApprovals(main) {
  const [{ approvals }, { versions }] = await Promise.all([api('/api/approvals'), api('/api/versions')]);
  const me = state.users.find((u) => u.id === state.user);

  const rows = approvals.map((a) => {
    const statusBadge = a.status === 'approved' ? badge('已批准', 'good')
      : a.status === 'rejected' ? badge('已拒绝', 'bad') : badge('待审批', 'warn');
    const canDecide = a.status === 'pending' && me && ['approver', 'admin'].includes(me.role) && a.requested_by !== me.id;
    const target = versions.find((v) => v.name === a.to_version);
    const canActivate = a.status === 'approved' && me && me.role === 'admin' && target && target.status !== 'active';
    return el('tr', {},
      el('td', {}, `#${a.id}`),
      el('td', {}, `${a.from_version} → ${a.to_version}`),
      el('td', {}, `报告 #${a.report_id} / 评估 #${a.evaluation_id}`),
      el('td', {}, `${a.requested_by} · ${fmtTime(a.requested_at)}`),
      el('td', {}, statusBadge),
      el('td', {}, a.decided_by ? `${a.decided_by} · ${fmtTime(a.decided_at)}${a.decision_reason ? ' · ' + a.decision_reason : ''}` : '—'),
      el('td', {},
        canDecide ? el('span', { class: 'form-row', style: 'margin:0' },
          el('button', {
            class: 'btn primary',
            onclick: () => guard(async () => {
              const reason = prompt('批准理由（可选）') || '';
              await api(`/api/approvals/${a.id}/decide`, { method: 'POST', body: { approve: true, reason } });
              toast('已批准'); render();
            }),
          }, '批准'),
          el('button', {
            class: 'btn danger',
            onclick: () => guard(async () => {
              const reason = prompt('拒绝理由') || '';
              await api(`/api/approvals/${a.id}/decide`, { method: 'POST', body: { approve: false, reason } });
              toast('已拒绝'); render();
            }),
          }, '拒绝')) : null,
        canActivate ? el('button', {
          class: 'btn primary',
          onclick: () => guard(async () => {
            const r = await api(`/api/versions/${encodeURIComponent(a.to_version)}/activate`, { method: 'POST' });
            toast(`版本已切换：${r.switched_from ?? '(无)'} → ${r.switched_to}（旧版本结果全部保留）`);
            render();
          }),
        }, `激活 ${a.to_version}`) : null));
  });

  main.replaceChildren(el('div', { class: 'card' },
    el('h2', {}, '审批记录'),
    el('p', { class: 'sub' }, '版本切换流程：影响报告 → 提交审批 → 审批人批准（不能审批自己的申请）→ 管理员激活。'),
    approvals.length
      ? dataTable(['单号', '切换', '依据', '申请人', '状态', '审批决定', '操作'], rows)
      : el('div', { class: 'empty' }, '暂无审批记录。')));
}

// ---------- Tab: 样本修订 ----------

async function renderRevisions(main) {
  const [{ revisions }, { audit }, { datasets }] = await Promise.all([
    api('/api/revisions'), api('/api/audit?limit=100'), api('/api/datasets')]);

  const sampleIdInput = el('input', { type: 'number', placeholder: '样本 ID', min: 1 });
  const fieldSel = el('select', {},
    el('option', { value: 'is_anomaly' }, '异常标记 is_anomaly'),
    el('option', { value: 'group_key' }, '群体标签 group_key'),
    el('option', { value: 'anomaly_reason' }, '异常原因 anomaly_reason'));
  const valueInput = el('input', { placeholder: '新值（is_anomaly 用 1/0，空 = 清除）' });
  const reasonInput = el('input', { placeholder: '修订理由（必填，写入审计）', style: 'min-width:260px' });
  const lookupBox = el('div', { style: 'width:100%' });

  const lookup = async () => {
    const id = Number(sampleIdInput.value);
    if (!id) return;
    for (const ds of datasets) {
      const { samples } = await api(`/api/datasets/${ds.id}/samples?limit=1000`);
      const s = samples.find((x) => x.id === id);
      if (s) {
        lookupBox.replaceChildren(el('div', { class: 'notice' },
          `样本 #${s.id}：版本 ${s.version} · 群体 ${s.group_key ?? '(缺失)'} · 曝光 ${s.impressed} · 点击 ${s.clicked} · ${s.is_anomaly ? `异常（${s.anomaly_reason}）` : '正常'}`));
        return;
      }
    }
    lookupBox.replaceChildren(el('div', { class: 'notice bad' }, `样本 #${id} 不存在`));
  };
  sampleIdInput.addEventListener('change', () => guard(lookup));

  const revRows = revisions.map((r) => el('tr', {},
    el('td', {}, `#${r.id}`),
    el('td', {}, `样本 #${r.sample_id}`),
    el('td', {}, r.field),
    el('td', {}, r.old_value ?? '(空)'),
    el('td', {}, r.new_value ?? '(空)'),
    el('td', {}, r.reason),
    el('td', {}, `${r.revised_by} · ${fmtTime(r.revised_at)}`)));

  const auditRows = audit.map((a) => el('tr', {},
    el('td', {}, fmtTime(a.at)),
    el('td', {}, a.actor),
    el('td', {}, a.action),
    el('td', {}, `${a.entity} ${a.entity_id}`),
    el('td', {}, a.detail)));

  main.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, '样本修订'),
      el('p', { class: 'sub' },
        '修订需要 analyst 及以上权限，全程审计。修订只影响之后创建的评估；已生成的评估快照保持不变（可用“回放同一输入”对比修订前后）。'),
      el('div', { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, '样本 ID'), sampleIdInput),
        el('div', { class: 'field' }, el('label', {}, '字段'), fieldSel),
        el('div', { class: 'field' }, el('label', {}, '新值'), valueInput),
        el('div', { class: 'field' }, el('label', {}, '理由'), reasonInput),
        el('button', {
          class: 'btn primary',
          onclick: () => guard(async () => {
            const raw = valueInput.value.trim();
            const body = {
              field: fieldSel.value,
              new_value: fieldSel.value === 'is_anomaly' ? Number(raw || 0) : (raw === '' ? null : raw),
              reason: reasonInput.value,
            };
            await api(`/api/samples/${sampleIdInput.value}/revisions`, { method: 'POST', body });
            toast('修订已记录并写入审计');
            render();
          }),
        }, '提交修订')),
      lookupBox),
    el('div', { class: 'card' },
      el('h2', {}, '修订历史'),
      revisions.length
        ? dataTable(['ID', '样本', '字段', '旧值', '新值', '理由', '操作人'], revRows)
        : el('div', { class: 'empty' }, '暂无修订记录。')),
    el('div', { class: 'card' },
      el('h2', {}, '审计日志'),
      dataTable(['时间', '操作人', '动作', '对象', '详情'], auditRows)));
}

// ---------- 路由与初始化 ----------

const TABS = {
  datasets: renderDatasets,
  evaluations: renderEvaluations,
  compare: renderCompare,
  reports: renderReports,
  approvals: renderApprovals,
  revisions: renderRevisions,
};

async function render() {
  const main = document.getElementById('main');
  document.querySelectorAll('.tab').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  });
  location.hash = state.tab;
  main.replaceChildren(el('div', { class: 'empty' }, '加载中…'));
  await guard(() => TABS[state.tab](main));
}

async function init() {
  const { users } = await api('/api/users');
  state.users = users;
  const sel = document.getElementById('user-select');
  sel.replaceChildren(...users.map((u) => el('option', { value: u.id }, `${u.name}（${u.role}）`)));
  if (!users.some((u) => u.id === state.user)) state.user = 'carol';
  sel.value = state.user;
  updateRoleBadge();
  sel.addEventListener('change', () => {
    state.user = sel.value;
    localStorage.setItem('rank-eval-user', state.user);
    updateRoleBadge();
    render();
  });

  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); });
  });
  await render();
}

function updateRoleBadge() {
  const u = state.users.find((x) => x.id === state.user);
  const badgeEl = document.getElementById('role-badge');
  badgeEl.textContent = u ? u.role : 'unknown';
  badgeEl.dataset.role = u ? u.role : '';
}

init().catch((e) => toast(e.message, true));
