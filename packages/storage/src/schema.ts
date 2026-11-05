/**
 * SQLite 迁移。每个迁移版本只追加, 不修改历史迁移的 SQL。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE execution_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  executable_ref TEXT NOT NULL,
  config_refs_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '[]',
  requested_model TEXT,
  requested_reasoning TEXT,
  concurrency_group TEXT NOT NULL DEFAULT 'default',
  enabled INTEGER NOT NULL DEFAULT 1,
  capability_json TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  workspace_root TEXT,
  live_enabled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profile_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  name TEXT NOT NULL,
  requested_model TEXT,
  requested_reasoning TEXT,
  config_refs_json TEXT NOT NULL DEFAULT '{}',
  capability_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_profile_snapshots_task ON profile_snapshots(task_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  phase TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  current_plan_revision_id TEXT,
  approved_plan_revision_id TEXT,
  participants_revision INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  limits_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_snapshot_id TEXT NOT NULL REFERENCES profile_snapshots(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0,
  allowed_phases_json TEXT NOT NULL DEFAULT '[]',
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_participants_task ON participants(task_id);

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, number)
);

CREATE TABLE plan_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_revision_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  participants_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  user_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_plan_approvals_task ON plan_approvals(task_id);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_revision_id TEXT NOT NULL,
  plan_item_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  assigned_participant_id TEXT,
  allowed_profile_ids_json TEXT NOT NULL DEFAULT '[]',
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  output_specs_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  write_scope_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  repair_round INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, plan_revision_id, plan_item_id)
);
CREATE INDEX idx_work_items_task_state ON work_items(task_id, state);

CREATE TABLE dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, depends_on_id)
);

CREATE TABLE managed_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  participant_id TEXT,
  attempt_id TEXT,
  adapter_id TEXT NOT NULL,
  native_session_id TEXT,
  runtime_id TEXT,
  phase TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  last_event_at TEXT NOT NULL,
  observed_model TEXT,
  observed_reasoning TEXT,
  process_json TEXT,
  connection_state TEXT NOT NULL DEFAULT 'unknown',
  process_health TEXT NOT NULL DEFAULT 'unknown',
  activity TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'starting',
  created_at TEXT NOT NULL,
  closed_at TEXT,
  error TEXT
);
CREATE INDEX idx_sessions_task ON managed_sessions(task_id);

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  work_item_id TEXT,
  session_id TEXT,
  participant_id TEXT,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_class TEXT,
  error_message TEXT,
  cancel_requested_at TEXT,
  cancel_confirmed_at TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attempts_task ON run_attempts(task_id, status);
CREATE INDEX idx_attempts_work_item ON run_attempts(work_item_id, status);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  attempt_id TEXT,
  plan_revision_id TEXT,
  observed_at TEXT NOT NULL,
  source_time TEXT,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_task_seq ON events(task_id, seq);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  participant_id TEXT,
  session_id TEXT,
  attempt_id TEXT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL,
  incomplete INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_task ON messages(task_id, created_at);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT,
  attempt_id TEXT,
  native_request_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_redacted TEXT NOT NULL DEFAULT '',
  scope_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE UNIQUE INDEX idx_approvals_native ON approval_requests(session_id, native_request_id) WHERE native_request_id IS NOT NULL;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  work_item_id TEXT,
  attempt_id TEXT,
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  producer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TEXT NOT NULL,
  note TEXT,
  UNIQUE(task_id, relative_path, sha256)
);

CREATE TABLE verification_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  work_item_id TEXT,
  artifact_set_hash TEXT NOT NULL,
  check_id TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  exit_code INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);

CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  artifact_set_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(task_id, number)
);

CREATE TABLE review_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  artifact_set_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  cross_checked_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT NOT NULL,
  UNIQUE(round_id, participant_id, artifact_set_hash)
);

CREATE TABLE command_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE runtime_leases (
  lease_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE delivery_acceptance (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_set_hash TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  limitations TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'profile-last-probe',
    sql: `
ALTER TABLE execution_profiles ADD COLUMN last_probe_json TEXT;
`,
  },
  {
    version: 3,
    name: 'workspace-and-sandbox',
    sql: `
ALTER TABLE execution_profiles ADD COLUMN sandbox TEXT NOT NULL DEFAULT 'workspace-write';
ALTER TABLE tasks ADD COLUMN workspace_root TEXT;
`,
  },
  {
    version: 4,
    name: 'work-note',
    // 执行者/审核者中途提问后, 用户回答的原话; 下一轮工作项回合会把它带进提示。
    sql: 'ALTER TABLE work_items ADD COLUMN user_note TEXT;',
  },
  {
    version: 5,
    name: 'participant-workspace',
    sql: `ALTER TABLE participants ADD COLUMN workspace_root TEXT;
ALTER TABLE participants ADD COLUMN sandbox TEXT;`,
  },
  {
    version: 6,
    name: 'message-attachments',
    // 用户在对话里上传的文件/图片; 存引用(相对任务工作区), 文件本身在 uploads/ 下。
    sql: 'ALTER TABLE messages ADD COLUMN attachments_json TEXT;',
  },
];
