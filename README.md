# 排序结果评估平台

比较多个排序版本在不同群体上的曝光、点击与位置分布，支持约束阈值、缺失标签策略与时间窗口；
版本切换前生成影响报告并走审批流；评估快照不可变、同一输入可回放复现；异常流量不计入正常样本。

## 快速开始

```bash
npm run seed    # 生成演示数据（3 版本 × 4 群体 × 7 天，含注入的异常流量）
npm start       # http://localhost:3000
npm test        # 23 个单元 + 端到端测试
```

零外部依赖：Node 24 内置 `node:http` + `node:sqlite`。

## 演示角色（页面右上角切换，经 `x-user-id` 请求头传递）

| 用户 | 角色 | 权限 |
|---|---|---|
| carol | viewer | 只读 |
| alice | analyst | 导入数据集、创建评估、回放、样本修订、生成影响报告、提交审批 |
| bob | approver | 审批决定（不能审批自己的申请） |
| admin | admin | 全部 + 激活版本（需已批准的审批单） |

## 核心概念

- **数据集不可变**：导入即定稿并固化输入指纹（sha256）。
- **异常流量**：规则检测（全点机器人 / 高频会话 / 重复请求 / 有点击无曝光 / 非法位置）打标后
  一律排除出指标，单独计数；计算层还有内在异常兜底，异常样本永远不会被当成正常样本。
- **缺失标签**：默认归入 `(missing)` 桶单独统计（不污染已知群体），也可配置为从指标剔除。
- **差异证据**：CTR 差异用两比例 z 检验，给出绝对差、相对提升、95% CI、p 值与显著性；
  组内 CTR 用 Wilson 区间。
- **约束阈值**：`ctr / rel_lift / avg_position / anomaly_rate / missing_label_rate / impressions`
  × `>=, <=, >, <, ==` × 分组或通配 `*`，违规在评估与影响报告中标红。
- **评估快照不可变**：结果（含指标、对照、约束结论）持久化并生成结果指纹；
  **回放同一输入**会基于当前样本状态重算——输入未变则指纹完全一致（可复现），
  样本有过修订则指纹分叉，旧评估结果原样保留。
- **样本修订**：仅 `is_anomaly / anomaly_reason / group_key` 可修订，需 analyst 以上且必须填写理由，
  全程写入修订表与审计日志；修订只影响之后创建的评估。
- **版本切换门禁**：影响报告（受益/受损群体、约束违规、数据质量、切换建议）→ 提交审批 →
  审批人批准（职责分离，不能自审）→ 管理员激活；旧版本自动归档，历史评估全部保留。

## 页面

数据集（导入/异常检测/样本浏览）· 评估（创建、分组指标、位置分布、差异证据、约束校验、回放）·
版本对照（状态与总体提升）· 影响报告 · 审批记录 · 样本修订（含修订历史与审计日志）

## API 摘要

```
POST /api/datasets                         导入数据集（analyst）
POST /api/datasets/:id/detect-anomalies    异常流量打标（analyst，幂等）
POST /api/evaluations                      创建评估（analyst）
POST /api/evaluations/:id/replay           回放同一输入（analyst）
POST /api/samples/:id/revisions            样本修订（analyst，需理由）
POST /api/impact-reports                   生成影响报告（analyst）
POST /api/approvals                        提交审批（analyst）
POST /api/approvals/:id/decide             审批决定（approver+，不能自审）
POST /api/versions/:name/activate          激活版本（admin，需已批准审批单）
GET  /api/evaluations/:id                  评估详情（指标/对照/约束）
GET  /api/revisions · /api/audit           修订历史 · 审计日志
```

## 目录

```
server/    index.js(路由) db.js(schema) metrics.js(指标+统计) anomaly.js(异常规则)
           constraints.js(约束校验) auth.js(RBAC) seed.js(演示数据)
public/    index.html app.js styles.css   （单页应用，SVG 图表，light/dark）
test/      metrics / anomaly / constraints / api(端到端)
```
