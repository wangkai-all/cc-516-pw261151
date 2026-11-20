'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.RANK_EVAL_DB || path.join(__dirname, '..', 'data.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','analyst','approver','admin'))
);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL
);

-- 样本：导入后本体不可变；仅 is_anomaly / anomaly_reason / group_key 可经“样本修订”流程修改（全程审计）
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  request_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  version TEXT NOT NULL,
  group_key TEXT,                 -- NULL = 缺失标签
  item_id TEXT,
  position REAL,
  impressed INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  is_anomaly INTEGER NOT NULL DEFAULT 0,
  anomaly_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_dataset ON samples(dataset_id, version, group_key);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(dataset_id, ts);
CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(dataset_id, session_id);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','candidate','active','archived')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  archived_at TEXT
);

-- 评估：结果快照不可变。回放生成新的 evaluation（replay_of 指向原评估），旧结果保留
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  versions TEXT NOT NULL,               -- json array
  baseline TEXT NOT NULL,
  time_start TEXT,                      -- 时间窗口（含）
  time_end TEXT,                        -- 时间窗口（含）
  missing_label_policy TEXT NOT NULL DEFAULT 'separate_bucket'
    CHECK (missing_label_policy IN ('separate_bucket','exclude')),
  constraints_json TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL,             -- 参与计算的输入快照 hash（含当时异常/标签状态）
  result_hash TEXT NOT NULL,            -- 结果快照 hash（可复现性校验）
  replay_of INTEGER REFERENCES evaluations(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_metrics (
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id),
  version TEXT NOT NULL,
  group_key TEXT NOT NULL,
  requests INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  ctr REAL NOT NULL,
  ctr_ci_low REAL NOT NULL,
  ctr_ci_high REAL NOT NULL,
  avg_position REAL,
  pos_hist TEXT NOT NULL,               -- json array, 位置 1..10 桶
  anomaly_excluded INTEGER NOT NULL DEFAULT 0,
  missing_labels INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (evaluation_id, version, group_key)
);

CREATE TABLE IF NOT EXISTS eval_comparisons (
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id),
  group_key TEXT NOT NULL,
  baseline TEXT NOT NULL,
  candidate TEXT NOT NULL,
  ctr_base REAL,
  ctr_cand REAL,
  abs_diff REAL,
  rel_lift REAL,
  z REAL,
  p_value REAL,
  ci_low REAL,
  ci_high REAL,
  significant INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (evaluation_id, group_key, candidate)
);

CREATE TABLE IF NOT EXISTS eval_constraint_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id),
  version TEXT NOT NULL,
  group_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  op TEXT NOT NULL,
  threshold REAL NOT NULL,
  actual REAL,
  passed INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS impact_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id),
  summary TEXT NOT NULL,                -- json：受益/受损群体、约束状态、异常与缺失标签说明、建议
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES impact_reports(id),
  action TEXT NOT NULL DEFAULT 'version_switch',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT
);

-- 样本修订审计：谁、何时、把哪个字段从什么改成什么、为什么
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id INTEGER NOT NULL REFERENCES samples(id),
  field TEXT NOT NULL CHECK (field IN ('is_anomaly','anomaly_reason','group_key')),
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  revised_by TEXT NOT NULL,
  revised_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
`;

function open(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function now() {
  return new Date().toISOString();
}

function audit(db, actor, action, entity, entityId, detail = '') {
  db.prepare(
    'INSERT INTO audit_log (actor, action, entity, entity_id, detail, at) VALUES (?,?,?,?,?,?)'
  ).run(actor, action, entity, String(entityId ?? ''), detail, now());
}

module.exports = { open, now, audit, DB_PATH };
