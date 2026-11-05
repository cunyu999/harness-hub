import { randomUUID } from 'node:crypto';
import type {
  ApprovalRequest,
  ArtifactRevision,
  AttemptStatus,
  CapabilityReport,
  ConnectionState,
  ExecutionProfile,
  ManagedSession,
  MonitorActivity,
  Participant,
  ParticipantRole,
  PlanApproval,
  PlanContent,
  PlanDecision,
  PlanRevision,
  PlanStatus,
  ProcessHealth,
  ProcessRef,
  ProfileSnapshot,
  ReviewFinding,
  ReviewResult,
  ReviewRound,
  ReviewVerdict,
  RunAttempt,
  TaskLimits,
  TaskMessage,
  TaskPhase,
  TaskRecord,
  VerificationResult,
  WorkItem,
  WorkItemState,
} from '../../contracts/src/types.js';
import type { EventEnvelope, EventType } from '../../contracts/src/events.js';
import type { Db, SqlParam } from './db.js';

const J = (v: unknown): string => JSON.stringify(v ?? null);
const PJ = <T>(v: string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const B = (v: unknown): boolean => v === 1 || v === true || v === '1';
const N = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function nowIso(): string {
  return new Date().toISOString();
}

export class Repo {
  constructor(readonly db: Db) {}

  /* ----------------------------- profiles ----------------------------- */

  listProfiles(): ExecutionProfile[] {
    return this.db.all<any>('SELECT * FROM execution_profiles ORDER BY created_at ASC').map(mapProfile);
  }

  getProfile(id: string): ExecutionProfile | null {
    const row = this.db.get<any>('SELECT * FROM execution_profiles WHERE id = ?', id);
    return row ? mapProfile(row) : null;
  }

  insertProfile(p: ExecutionProfile): ExecutionProfile {
    this.db.run(
      `INSERT INTO execution_profiles
       (id, name, adapter_id, executable_ref, config_refs_json, secret_refs_json, requested_model,
        requested_reasoning, concurrency_group, enabled, capability_json, env_json, workspace_root,
        sandbox, live_enabled, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.id,
      p.name,
      p.adapterId,
      p.executableRef,
      J(p.configRefs),
      J(p.secretRefs),
      p.requestedModel,
      p.requestedReasoning,
      p.concurrencyGroup,
      p.enabled ? 1 : 0,
      p.capabilitySnapshot ? J(p.capabilitySnapshot) : null,
      J(p.env),
      p.workspaceRoot,
      p.sandbox,
      p.liveEnabled ? 1 : 0,
      p.notes,
      p.createdAt,
      p.updatedAt,
    );
    return this.getProfile(p.id)!;
  }

  updateProfile(id: string, patch: Partial<ExecutionProfile>): ExecutionProfile | null {
    const current = this.getProfile(id);
    if (!current) return null;
    const next: ExecutionProfile = { ...current, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE execution_profiles SET name=?, executable_ref=?, config_refs_json=?, secret_refs_json=?,
       requested_model=?, requested_reasoning=?, concurrency_group=?, enabled=?, capability_json=?,
       env_json=?, workspace_root=?, sandbox=?, live_enabled=?, notes=?, updated_at=? WHERE id=?`,
      next.name,
      next.executableRef,
      J(next.configRefs),
      J(next.secretRefs),
      next.requestedModel,
      next.requestedReasoning,
      next.concurrencyGroup,
      next.enabled ? 1 : 0,
      next.capabilitySnapshot ? J(next.capabilitySnapshot) : null,
      J(next.env),
      next.workspaceRoot,
      next.sandbox,
      next.liveEnabled ? 1 : 0,
      next.notes,
      next.updatedAt,
      id,
    );
    return this.getProfile(id);
  }

  /**
   * 物理删除执行配置。只有从未被任务引用过才允许, 否则历史快照会失去可追溯的对照物。
   * 返回 'deleted' | 'in_use' | 'not_found'。
   */
  deleteProfile(id: string): 'deleted' | 'in_use' | 'not_found' {
    if (!this.getProfile(id)) return 'not_found';
    const used = this.countParticipantsForProfile(id);
    if (used > 0) return 'in_use';
    this.db.run('DELETE FROM execution_profiles WHERE id = ?', id);
    return 'deleted';
  }

  /** 有多少个任务参与者引用过该执行配置(用于判断能否物理删除)。 */
  countParticipantsForProfile(profileId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM participants WHERE profile_id = ?', profileId);
    return row?.n ?? 0;
  }

  /**
   * 最近一次 probe 结论。单独存储, 避免把运行时检查结果混进不可变配置快照。
   */
  setLastProbe(profileId: string, probe: unknown): void {
    this.db.run(
      'UPDATE execution_profiles SET last_probe_json = ? WHERE id = ?',
      probe === null || probe === undefined ? null : J(probe),
      profileId,
    );
  }

  getLastProbe(profileId: string): unknown | null {
    const row = this.db.get<any>('SELECT last_probe_json FROM execution_profiles WHERE id = ?', profileId);
    if (!row || row.last_probe_json === null || row.last_probe_json === undefined) return null;
    try {
      return JSON.parse(row.last_probe_json);
    } catch {
      return null;
    }
  }

  /* ---------------------------- snapshots ----------------------------- */
  insertSnapshot(s: ProfileSnapshot): void {
    this.db.run(
      `INSERT INTO profile_snapshots (id, task_id, profile_id, adapter_id, name, requested_model,
        requested_reasoning, config_refs_json, capability_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      s.id,
      s.taskId,
      s.profileId,
      s.adapterId,
      s.name,
      s.requestedModel,
      s.requestedReasoning,
      J(s.configRefs),
      s.capabilitySnapshot ? J(s.capabilitySnapshot) : null,
      s.createdAt,
    );
  }

  getSnapshot(id: string): ProfileSnapshot | null {
    const row = this.db.get<any>('SELECT * FROM profile_snapshots WHERE id = ?', id);
    return row ? mapSnapshot(row) : null;
  }

  listSnapshots(taskId: string): ProfileSnapshot[] {
    return this.db
      .all<any>('SELECT * FROM profile_snapshots WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map(mapSnapshot);
  }

  /* ------------------------------- tasks ------------------------------ */

  listTasks(limit = 100): TaskRecord[] {
    return this.db
      .all<any>('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?', limit)
      .map(mapTask);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.get<any>('SELECT * FROM tasks WHERE id = ?', id);
    return row ? mapTask(row) : null;
  }

  insertTask(t: TaskRecord): void {
    this.db.run(
      `INSERT INTO tasks (id, title, objective, constraints_json, phase, lifecycle,
        current_plan_revision_id, approved_plan_revision_id, participants_revision, version,
        limits_json, workspace_root, error_code, error_message, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id,
      t.title,
      t.objective,
      J(t.constraints),
      t.phase,
      t.lifecycle,
      t.currentPlanRevisionId,
      t.approvedPlanRevisionId,
      t.participantsRevision,
      t.version,
      J(t.limits),
      t.workspaceRoot,
      t.errorCode,
      t.errorMessage,
      t.createdAt,
      t.updatedAt,
      t.completedAt,
    );
  }

  /**
   * 乐观并发更新: expectedVersion 为 null 时不校验。成功后 version + 1。
   * 返回 null 表示版本冲突或任务不存在。
   */
  updateTask(id: string, patch: Partial<TaskRecord>, expectedVersion: number | null): TaskRecord | null {
    const cur = this.getTask(id);
    if (!cur) return null;
    if (expectedVersion !== null && cur.version !== expectedVersion) return null;
    const next: TaskRecord = { ...cur, ...patch, version: cur.version + 1, updatedAt: nowIso() };
    this.db.run(
      `UPDATE tasks SET title=?, objective=?, constraints_json=?, phase=?, lifecycle=?,
        current_plan_revision_id=?, approved_plan_revision_id=?, participants_revision=?, version=?,
        limits_json=?, error_code=?, error_message=?, updated_at=?, completed_at=? WHERE id=? AND version=?`,
      next.title,
      next.objective,
      J(next.constraints),
      next.phase,
      next.lifecycle,
      next.currentPlanRevisionId,
      next.approvedPlanRevisionId,
      next.participantsRevision,
      next.version,
      J(next.limits),
      next.errorCode,
      next.errorMessage,
      next.updatedAt,
      next.completedAt,
      id,
      cur.version,
    );
    return this.getTask(id);
  }

  /* --------------------------- participants --------------------------- */

  insertParticipant(p: Participant): void {
    this.db.run(
      `INSERT INTO participants (id, task_id, profile_snapshot_id, profile_id, role, is_lead,
        allowed_phases_json, display_name, created_at, workspace_root, sandbox) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      p.id,
      p.taskId,
      p.profileSnapshotId,
      p.profileId,
      p.role,
      p.isLead ? 1 : 0,
      J(p.allowedPhases),
      p.displayName,
      p.createdAt,
      p.workspaceRoot ?? null,
      p.sandbox ?? null,
    );
  }

  updateParticipant(
    participantId: string,
    patch: { workspaceRoot?: string | null; sandbox?: string | null },
  ): Participant | null {
    const cur = this.getParticipant(participantId);
    if (!cur) return null;
    this.db.run(
      'UPDATE participants SET workspace_root = ?, sandbox = ? WHERE id = ?',
      patch.workspaceRoot !== undefined ? patch.workspaceRoot : (cur.workspaceRoot ?? null),
      patch.sandbox !== undefined ? patch.sandbox : (cur.sandbox ?? null),
      participantId,
    );
    return this.getParticipant(participantId);
  }

  listParticipants(taskId: string): Participant[] {
    return this.db
      .all<any>('SELECT * FROM participants WHERE task_id = ? ORDER BY role DESC, created_at ASC', taskId)
      .map(mapParticipant);
  }

  getParticipant(id: string): Participant | null {
    const row = this.db.get<any>('SELECT * FROM participants WHERE id = ?', id);
    return row ? mapParticipant(row) : null;
  }

  /* ------------------------------- plans ------------------------------ */

  nextPlanNumber(taskId: string): number {
    const row = this.db.get<{ n: number | null }>(
      'SELECT MAX(number) AS n FROM plan_revisions WHERE task_id = ?',
      taskId,
    );
    return (row?.n ?? 0) + 1;
  }

  insertPlan(p: PlanRevision): void {
    this.db.run(
      `INSERT INTO plan_revisions (id, task_id, number, content_json, created_by, content_hash,
        status, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      p.id,
      p.taskId,
      p.number,
      J(p.content),
      p.createdBy,
      p.contentHash,
      p.status,
      p.summary,
      p.createdAt,
    );
  }

  getPlan(id: string): PlanRevision | null {
    const row = this.db.get<any>('SELECT * FROM plan_revisions WHERE id = ?', id);
    return row ? mapPlan(row) : null;
  }

  listPlans(taskId: string): PlanRevision[] {
    return this.db
      .all<any>('SELECT * FROM plan_revisions WHERE task_id = ? ORDER BY number ASC', taskId)
      .map(mapPlan);
  }

  setPlanStatus(id: string, status: PlanStatus): void {
    this.db.run('UPDATE plan_revisions SET status = ? WHERE id = ?', status, id);
  }

  setCurrentPlan(taskId: string, planRevisionId: string | null): void {
    this.db.run(
      'UPDATE tasks SET current_plan_revision_id = ?, updated_at = ? WHERE id = ?',
      planRevisionId,
      nowIso(),
      taskId,
    );
  }

  insertPlanApproval(a: PlanApproval): void {
    this.db.run(
      `INSERT INTO plan_approvals (id, task_id, plan_revision_id, plan_hash, participants_revision,
        decision, user_note, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      a.id,
      a.taskId,
      a.planRevisionId,
      a.planHash,
      a.participantsRevision,
      a.decision,
      a.userNote,
      a.createdAt,
    );
  }

  listPlanApprovals(taskId: string): PlanApproval[] {
    return this.db
      .all<any>('SELECT * FROM plan_approvals WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        planRevisionId: r.plan_revision_id,
        planHash: r.plan_hash,
        participantsRevision: r.participants_revision,
        decision: r.decision as PlanDecision,
        userNote: r.user_note,
        createdAt: r.created_at,
      }));
  }

  /* ----------------------------- work items --------------------------- */

  insertWorkItem(w: WorkItem): void {
    this.db.run(
      `INSERT INTO work_items (id, task_id, plan_revision_id, plan_item_id, goal, dependency_ids_json,
        assigned_participant_id, allowed_profile_ids_json, input_refs_json, output_specs_json,
        acceptance_criteria_json, write_scope_json, state, repair_round, attempt_count, result_json,
        last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      w.id,
      w.taskId,
      w.planRevisionId,
      w.planItemId,
      w.goal,
      J(w.dependencyIds),
      w.assignedParticipantId,
      J(w.allowedProfileIds),
      J(w.inputRefs),
      J(w.outputSpecs),
      J(w.acceptanceCriteria),
      J(w.writeScope),
      w.state,
      w.repairRound,
      w.attemptCount,
      w.result ? J(w.result) : null,
      w.lastError,
      w.createdAt,
      w.updatedAt,
    );
    for (const dep of w.dependencyIds) {
      this.db.run(
        'INSERT OR IGNORE INTO dependencies (work_item_id, depends_on_id) VALUES (?,?)',
        w.id,
        dep,
      );
    }
  }

  listWorkItems(taskId: string): WorkItem[] {
    return this.db
      .all<any>('SELECT * FROM work_items WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map(mapWorkItem);
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.get<any>('SELECT * FROM work_items WHERE id = ?', id);
    return row ? mapWorkItem(row) : null;
  }

  updateWorkItem(id: string, patch: Partial<WorkItem>): WorkItem | null {
    const cur = this.getWorkItem(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE work_items SET state=?, assigned_participant_id=?, repair_round=?, attempt_count=?,
        result_json=?, last_error=?, user_note=?, updated_at=? WHERE id=?`,
      next.state,
      next.assignedParticipantId,
      next.repairRound,
      next.attemptCount,
      next.result ? J(next.result) : null,
      next.lastError,
      next.userNote ?? null,
      next.updatedAt,
      id,
    );
    return this.getWorkItem(id);
  }

  /* ------------------------------ sessions ---------------------------- */

  insertSession(s: ManagedSession): void {
    this.db.run(
      `INSERT INTO managed_sessions (id, task_id, participant_id, attempt_id, adapter_id,
        native_session_id, runtime_id, phase, purpose, last_event_at, observed_model,
        observed_reasoning, process_json, connection_state, process_health, activity, status,
        created_at, closed_at, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.id,
      s.taskId,
      s.participantId,
      s.attemptId,
      s.adapterId,
      s.nativeSessionId,
      s.runtimeId,
      s.phase,
      s.purpose,
      s.lastEventAt,
      s.observedModel,
      s.observedReasoning,
      s.processRef ? J(s.processRef) : null,
      s.connectionState,
      s.processHealth,
      s.activity,
      s.status,
      s.createdAt,
      s.closedAt,
      s.error,
    );
  }

  updateSession(id: string, patch: Partial<ManagedSession>): ManagedSession | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.run(
      `UPDATE managed_sessions SET native_session_id=?, observed_model=?, observed_reasoning=?,
        process_json=?, connection_state=?, process_health=?, activity=?, status=?, last_event_at=?,
        closed_at=?, error=? WHERE id=?`,
      next.nativeSessionId,
      next.observedModel,
      next.observedReasoning,
      next.processRef ? J(next.processRef) : null,
      next.connectionState,
      next.processHealth,
      next.activity,
      next.status,
      next.lastEventAt,
      next.closedAt,
      next.error,
      id,
    );
    return this.getSession(id);
  }

  getSession(id: string): ManagedSession | null {
    const row = this.db.get<any>('SELECT * FROM managed_sessions WHERE id = ?', id);
    return row ? mapSession(row) : null;
  }

  listSessions(taskId: string): ManagedSession[] {
    return this.db
      .all<any>('SELECT * FROM managed_sessions WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map(mapSession);
  }

  listOpenSessions(): ManagedSession[] {
    return this.db
      .all<any>("SELECT * FROM managed_sessions WHERE closed_at IS NULL ORDER BY created_at ASC")
      .map(mapSession);
  }

  countActiveSessions(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM managed_sessions WHERE closed_at IS NULL",
    );
    return Number(row?.n ?? 0);
  }

  countActiveSessionsForProfile(profileId: string, taskId: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM managed_sessions s
       JOIN participants p ON p.id = s.participant_id
       WHERE s.closed_at IS NULL AND s.task_id = ? AND p.profile_id = ?`,
      taskId,
      profileId,
    );
    return Number(row?.n ?? 0);
  }

  /* ------------------------------ attempts ---------------------------- */

  insertAttempt(a: RunAttempt): void {
    this.db.run(
      `INSERT INTO run_attempts (id, task_id, work_item_id, session_id, participant_id, phase, kind,
        attempt_number, status, started_at, ended_at, error_class, error_message,
        cancel_requested_at, cancel_confirmed_at, result_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id,
      a.taskId,
      a.workItemId,
      a.sessionId,
      a.participantId,
      a.phase,
      a.kind,
      a.attemptNumber,
      a.status,
      a.startedAt,
      a.endedAt,
      a.errorClass,
      a.errorMessage,
      a.cancelRequestedAt,
      a.cancelConfirmedAt,
      a.result ? J(a.result) : null,
      a.createdAt,
    );
  }

  updateAttempt(id: string, patch: Partial<RunAttempt>): RunAttempt | null {
    const cur = this.getAttempt(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.run(
      `UPDATE run_attempts SET status=?, ended_at=?, error_class=?, error_message=?,
        cancel_requested_at=?, cancel_confirmed_at=?, result_json=? WHERE id=?`,
      next.status,
      next.endedAt,
      next.errorClass,
      next.errorMessage,
      next.cancelRequestedAt,
      next.cancelConfirmedAt,
      next.result ? J(next.result) : null,
      id,
    );
    return this.getAttempt(id);
  }

  getAttempt(id: string): RunAttempt | null {
    const row = this.db.get<any>('SELECT * FROM run_attempts WHERE id = ?', id);
    return row ? mapAttempt(row) : null;
  }

  listAttempts(taskId: string): RunAttempt[] {
    return this.db
      .all<any>('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map(mapAttempt);
  }

  listActiveAttempts(): RunAttempt[] {
    return this.db
      .all<any>(
        `SELECT * FROM run_attempts WHERE status IN
        ('starting','running','waiting_approval','waiting_user','retry_wait','cancelling')`,
      )
      .map(mapAttempt);
  }

  countRunningAttempts(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM run_attempts WHERE status IN ('starting','running')",
    );
    return Number(row?.n ?? 0);
  }

  nextAttemptNumber(workItemId: string): number {
    const row = this.db.get<{ n: number | null }>(
      'SELECT MAX(attempt_number) AS n FROM run_attempts WHERE work_item_id = ?',
      workItemId,
    );
    return (row?.n ?? 0) + 1;
  }

  countActiveAttemptsForWorkItem(workItemId: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_attempts WHERE work_item_id = ? AND status IN
       ('starting','running','waiting_approval','waiting_user','retry_wait','cancelling')`,
      workItemId,
    );
    return Number(row?.n ?? 0);
  }

  /* ------------------------------- events ----------------------------- */

  appendEvent(input: {
    type: EventType;
    taskId: string | null;
    sessionId?: string | null;
    attemptId?: string | null;
    planRevisionId?: string | null;
    source: string;
    sourceTime?: string | null;
    payload?: Record<string, unknown>;
    eventId?: string;
  }): EventEnvelope {
    const eventId = input.eventId ?? randomUUID();
    const observedAt = nowIso();
    const r = this.db.run(
      `INSERT INTO events (event_id, type, task_id, session_id, attempt_id, plan_revision_id,
        observed_at, source_time, source, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      eventId,
      input.type,
      input.taskId,
      input.sessionId ?? null,
      input.attemptId ?? null,
      input.planRevisionId ?? null,
      observedAt,
      input.sourceTime ?? null,
      input.source,
      J(input.payload ?? {}),
    );
    return {
      seq: r.lastInsertRowid,
      eventId,
      type: input.type,
      taskId: input.taskId,
      sessionId: input.sessionId ?? null,
      attemptId: input.attemptId ?? null,
      planRevisionId: input.planRevisionId ?? null,
      observedAt,
      sourceTime: input.sourceTime ?? null,
      source: input.source,
      payload: input.payload ?? {},
    };
  }

  listEvents(taskId: string, afterSeq: number, limit = 500): EventEnvelope[] {
    return this.db
      .all<any>(
        'SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        taskId,
        afterSeq,
        limit,
      )
      .map(mapEvent);
  }

  maxSeq(): number {
    const row = this.db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM events');
    return Number(row?.n ?? 0);
  }

  /** 该任务仍保留的最小事件序号; 用于判断游标是否过旧。 */
  minSeq(taskId: string): number | null {
    const row = this.db.get<{ n: number | null }>('SELECT MIN(seq) AS n FROM events WHERE task_id = ?', taskId);
    return row?.n ?? null;
  }

  lastEventAt(taskId: string): string | null {
    const row = this.db.get<{ t: string | null }>(
      'SELECT MAX(observed_at) AS t FROM events WHERE task_id = ?',
      taskId,
    );
    return row?.t ?? null;
  }

  /* ------------------------------ messages ---------------------------- */

  insertMessage(m: TaskMessage): void {
    this.db.run(
      `INSERT INTO messages (id, task_id, role, participant_id, session_id, attempt_id, text,
        kind, created_at, incomplete, attachments_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      m.id,
      m.taskId,
      m.role,
      m.participantId,
      m.sessionId,
      m.attemptId,
      m.text,
      m.kind,
      m.createdAt,
      m.incomplete ? 1 : 0,
      m.attachments && m.attachments.length > 0 ? JSON.stringify(m.attachments) : null,
    );
  }

  listMessages(taskId: string, limit = 500): TaskMessage[] {
    const rows = this.db.all<any>(
      'SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
      taskId,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      role: r.role,
      participantId: r.participant_id,
      sessionId: r.session_id,
      attemptId: r.attempt_id,
      text: r.text,
      kind: r.kind,
      createdAt: r.created_at,
      incomplete: B(r.incomplete),
      attachments: r.attachments_json ? (JSON.parse(r.attachments_json) as TaskMessage['attachments']) : null,
    }));
  }

  /* ---------------------------- approvals ----------------------------- */

  insertApprovalRequest(a: ApprovalRequest): void {
    this.db.run(
      `INSERT OR IGNORE INTO approval_requests (id, task_id, session_id, attempt_id, native_request_id,
        kind, title, detail_redacted, scope_hash, state, created_at, resolved_at, resolution_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id,
      a.taskId,
      a.sessionId,
      a.attemptId,
      a.nativeRequestId,
      a.kind,
      a.title,
      a.detailRedacted,
      a.scopeHash,
      a.state,
      a.createdAt,
      a.resolvedAt,
      a.resolutionNote,
    );
  }

  getApprovalRequest(id: string): ApprovalRequest | null {
    const row = this.db.get<any>('SELECT * FROM approval_requests WHERE id = ?', id);
    return row ? mapApproval(row) : null;
  }

  listPendingApprovals(taskId: string): ApprovalRequest[] {
    return this.db
      .all<any>(
        "SELECT * FROM approval_requests WHERE task_id = ? AND state = 'pending' ORDER BY created_at ASC",
        taskId,
      )
      .map(mapApproval);
  }

  listAllPendingApprovals(): ApprovalRequest[] {
    return this.db
      .all<any>("SELECT * FROM approval_requests WHERE state = 'pending' ORDER BY created_at ASC")
      .map(mapApproval);
  }

  resolveApproval(id: string, state: string, note: string | null): void {
    this.db.run(
      'UPDATE approval_requests SET state = ?, resolved_at = ?, resolution_note = ? WHERE id = ?',
      state,
      nowIso(),
      note,
      id,
    );
  }

  /* ------------------------------ artifacts --------------------------- */

  insertArtifact(a: ArtifactRevision): ArtifactRevision {
    const existing = this.db.get<any>(
      'SELECT * FROM artifacts WHERE task_id = ? AND relative_path = ? AND sha256 = ?',
      a.taskId,
      a.relativePath,
      a.sha256,
    );
    if (existing) return mapArtifact(existing);
    this.db.run(
      `INSERT INTO artifacts (id, task_id, work_item_id, attempt_id, relative_path, media_type,
        size, sha256, producer, status, registered_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id,
      a.taskId,
      a.workItemId,
      a.attemptId,
      a.relativePath,
      a.mediaType,
      a.size,
      a.sha256,
      a.producer,
      a.status,
      a.registeredAt,
      a.note,
    );
    return a;
  }

  listArtifacts(taskId: string): ArtifactRevision[] {
    return this.db
      .all<any>('SELECT * FROM artifacts WHERE task_id = ? ORDER BY registered_at ASC', taskId)
      .map(mapArtifact);
  }

  /**
   * 同一个路径只保留最新一版为 registered。
   * 场景: 执行者改了源码后重新编译, 同名产物会出现第二条修订; 不覆盖旧版就无法区分"当前产物"。
   */
  supersedeArtifactRevisions(taskId: string, relativePath: string, keepId: string): void {
    this.db.run(
      "UPDATE artifacts SET status='superseded' WHERE task_id = ? AND relative_path = ? AND id <> ? AND status='registered'",
      taskId,
      relativePath,
      keepId,
    );
  }

  /** 每个路径的最新一版(用于界面展示与"当前产物"语义), 历史修订仍保留在库里。 */
  listCurrentArtifacts(taskId: string): ArtifactRevision[] {
    const rows = this.db
      .all<any>('SELECT * FROM artifacts WHERE task_id = ? ORDER BY registered_at ASC, rowid ASC', taskId)
      .map(mapArtifact);
    const latest = new Map<string, ArtifactRevision>();
    for (const row of rows) latest.set(row.relativePath, row);
    return [...latest.values()];
  }

  getArtifact(id: string): ArtifactRevision | null {
    const row = this.db.get<any>('SELECT * FROM artifacts WHERE id = ?', id);
    return row ? mapArtifact(row) : null;
  }

  supersedeArtifactsExcept(taskId: string, ids: string[]): void {
    if (ids.length === 0) {
      this.db.run("UPDATE artifacts SET status='superseded' WHERE task_id = ? AND status='registered'", taskId);
      return;
    }
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(
      `UPDATE artifacts SET status='superseded' WHERE task_id = ? AND status='registered'
       AND id NOT IN (${placeholders})`,
      taskId,
      ...ids,
    );
  }

  /* --------------------------- verifications -------------------------- */

  insertVerification(v: VerificationResult): void {
    this.db.run(
      `INSERT INTO verification_results (id, task_id, work_item_id, artifact_set_hash, check_id,
        method, status, evidence_json, exit_code, detail, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      v.id,
      v.taskId,
      v.workItemId,
      v.artifactSetHash,
      v.checkId,
      v.method,
      v.status,
      J(v.evidenceRefs),
      v.exitCode,
      v.detail,
      v.checkedAt,
    );
  }

  listVerifications(taskId: string): VerificationResult[] {
    return this.db
      .all<any>('SELECT * FROM verification_results WHERE task_id = ? ORDER BY checked_at ASC', taskId)
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        workItemId: r.work_item_id,
        artifactSetHash: r.artifact_set_hash,
        checkId: r.check_id,
        method: r.method,
        status: r.status,
        evidenceRefs: PJ<string[]>(r.evidence_json, []),
        exitCode: N(r.exit_code),
        detail: r.detail,
        checkedAt: r.checked_at,
      }));
  }

  /* ------------------------------ reviews ----------------------------- */

  insertReviewRound(r: ReviewRound): void {
    this.db.run(
      `INSERT INTO review_rounds (id, task_id, number, artifact_set_hash, status, created_at, completed_at)
       VALUES (?,?,?,?,?,?,?)`,
      r.id,
      r.taskId,
      r.number,
      r.artifactSetHash,
      r.status,
      r.createdAt,
      r.completedAt,
    );
  }

  updateReviewRound(id: string, patch: Partial<ReviewRound>): void {
    const row = this.db.get<any>('SELECT * FROM review_rounds WHERE id = ?', id);
    if (!row) return;
    const next = { ...mapRound(row), ...patch };
    this.db.run(
      'UPDATE review_rounds SET status=?, completed_at=?, artifact_set_hash=? WHERE id=?',
      next.status,
      next.completedAt,
      next.artifactSetHash,
      id,
    );
  }

  getReviewRound(id: string): ReviewRound | null {
    const row = this.db.get<any>('SELECT * FROM review_rounds WHERE id = ?', id);
    return row ? mapRound(row) : null;
  }

  listReviewRounds(taskId: string): ReviewRound[] {
    return this.db
      .all<any>('SELECT * FROM review_rounds WHERE task_id = ? ORDER BY number ASC', taskId)
      .map(mapRound);
  }

  nextReviewNumber(taskId: string): number {
    const row = this.db.get<{ n: number | null }>(
      'SELECT MAX(number) AS n FROM review_rounds WHERE task_id = ?',
      taskId,
    );
    return (row?.n ?? 0) + 1;
  }

  insertReviewResult(r: ReviewResult): void {
    this.db.run(
      `INSERT OR REPLACE INTO review_results (id, task_id, round_id, participant_id, artifact_set_hash,
        verdict, findings_json, summary, cross_checked_json, evidence_json, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      r.id,
      r.taskId,
      r.roundId,
      r.participantId,
      r.artifactSetHash,
      r.verdict,
      J(r.findings),
      r.summary,
      J(r.crossChecked),
      J(r.evidenceRefs),
      r.completedAt,
    );
  }

  listReviewResults(taskId: string): ReviewResult[] {
    return this.db
      .all<any>('SELECT * FROM review_results WHERE task_id = ? ORDER BY completed_at ASC', taskId)
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        roundId: r.round_id,
        participantId: r.participant_id,
        artifactSetHash: r.artifact_set_hash,
        verdict: r.verdict as ReviewVerdict,
        findings: PJ<ReviewFinding[]>(r.findings_json, []),
        summary: r.summary,
        crossChecked: PJ<{ findingId: string; stance: string; note: string }[]>(
          r.cross_checked_json,
          [],
        ),
        evidenceRefs: PJ<string[]>(r.evidence_json, []),
        completedAt: r.completed_at,
      }));
  }

  /* ------------------------------ outbox ------------------------------ */

  enqueueCommand(taskId: string | null, commandType: string, payload: unknown): string {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO command_outbox (id, task_id, command_type, payload_json, state, created_at,
        attempt_count) VALUES (?,?,?,?,'prepared',?,0)`,
      id,
      taskId,
      commandType,
      J(payload),
      nowIso(),
    );
    return id;
  }

  listPendingCommands(): { id: string; taskId: string | null; type: string; payload: any; state: string }[] {
    return this.db
      .all<any>(
        "SELECT * FROM command_outbox WHERE state IN ('prepared','dispatching','uncertain') ORDER BY created_at ASC",
      )
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        type: r.command_type,
        payload: PJ<any>(r.payload_json, {}),
        state: r.state,
      }));
  }

  markCommand(id: string, state: string, error: string | null = null): void {
    this.db.run(
      'UPDATE command_outbox SET state = ?, dispatched_at = ?, attempt_count = attempt_count + 1, error = ? WHERE id = ?',
      state,
      nowIso(),
      error,
      id,
    );
  }

  /* ------------------------------ leases ------------------------------ */

  getLease(leaseId: string): { leaseId: string; ownerPid: number; nonce: string; heartbeatAt: string } | null {
    const row = this.db.get<any>('SELECT * FROM runtime_leases WHERE lease_id = ?', leaseId);
    return row
      ? { leaseId: row.lease_id, ownerPid: row.owner_pid, nonce: row.nonce, heartbeatAt: row.heartbeat_at }
      : null;
  }

  acquireLease(leaseId: string, pid: number, nonce: string, staleMs: number): boolean {    const row = this.db.get<any>('SELECT * FROM runtime_leases WHERE lease_id = ?', leaseId);
    const now = Date.now();
    if (row) {
      const hb = Date.parse(row.heartbeat_at);
      const stale = Number.isFinite(hb) ? now - hb > staleMs : true;
      if (!stale) return false;
    }
    this.db.run(
      `INSERT INTO runtime_leases (lease_id, owner_pid, nonce, acquired_at, heartbeat_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(lease_id) DO UPDATE SET owner_pid=excluded.owner_pid, nonce=excluded.nonce,
         acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at`,
      leaseId,
      pid,
      nonce,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
    return true;
  }

  heartbeatLease(leaseId: string, nonce: string): void {
    this.db.run(
      'UPDATE runtime_leases SET heartbeat_at = ? WHERE lease_id = ? AND nonce = ?',
      new Date().toISOString(),
      leaseId,
      nonce,
    );
  }

  releaseLease(leaseId: string, nonce: string): void {
    this.db.run('DELETE FROM runtime_leases WHERE lease_id = ? AND nonce = ?', leaseId, nonce);
  }

  /* --------------------------- idempotency ---------------------------- */

  getIdempotent(scope: string, key: string): { status: string; response: any } | null {
    const row = this.db.get<any>(
      'SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?',
      scope,
      key,
    );
    if (!row) return null;
    return { status: row.status, response: PJ<any>(row.response_json, null) };
  }

  putIdempotent(scope: string, key: string, response: unknown, status = 'completed'): void {
    this.db.run(
      'INSERT OR REPLACE INTO idempotency_keys (scope, key, status, response_json, created_at) VALUES (?,?,?,?,?)',
      scope,
      key,
      status,
      J(response),
      nowIso(),
    );
  }

  /* ------------------------------ purge ------------------------------- */

  /**
   * 彻底删除一个任务: 任务记录 + 计划/工作项/会话/尝试/消息/审批/审核/验证/产物登记 + 事件。
   * 其它表都通过 tasks 的 ON DELETE CASCADE 跟着走, events 没有外键所以显式删。
   * 产物文件不在这里删 —— 调用方负责先归档到磁盘。
   */
  purgeTask(taskId: string): { events: number; artifacts: number } {
    return this.db.tx(() => {
      const artifacts = this.count('SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ?', taskId);
      const events = this.db.run('DELETE FROM events WHERE task_id = ?', taskId).changes;
      this.db.run('DELETE FROM tasks WHERE id = ?', taskId);
      return { events, artifacts };
    });
  }

  /** 任务是否已收尾(没有未结束的会话), 供删除前检查。 */
  hasOpenSessions(taskId: string): boolean {
    return this.count('SELECT COUNT(*) AS n FROM managed_sessions WHERE task_id = ? AND closed_at IS NULL', taskId) > 0;
  }

  private count(sql: string, ...params: any[]): number {
    const row = this.db.get<{ n: number }>(sql, ...params);
    return row?.n ?? 0;
  }

  /* ---------------------------- acceptance ---------------------------- */

  insertAcceptance(taskId: string, artifactSetHash: string, acceptedBy: string, limitations: string): void {
    this.db.run(
      'INSERT INTO delivery_acceptance (id, task_id, artifact_set_hash, accepted_by, limitations, created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      taskId,
      artifactSetHash,
      acceptedBy,
      limitations,
      nowIso(),
    );
  }

  listAcceptance(taskId: string): { id: string; artifactSetHash: string; acceptedBy: string; limitations: string; createdAt: string }[] {
    return this.db
      .all<any>('SELECT * FROM delivery_acceptance WHERE task_id = ? ORDER BY created_at ASC', taskId)
      .map((r) => ({
        id: r.id,
        artifactSetHash: r.artifact_set_hash,
        acceptedBy: r.accepted_by,
        limitations: r.limitations,
        createdAt: r.created_at,
      }));
  }
}

/* ------------------------------ mappers ------------------------------- */

function mapProfile(r: any): ExecutionProfile {
  return {
    id: r.id,
    name: r.name,
    adapterId: r.adapter_id,
    executableRef: r.executable_ref,
    configRefs: PJ<Record<string, string>>(r.config_refs_json, {}),
    secretRefs: PJ<string[]>(r.secret_refs_json, []),
    requestedModel: r.requested_model,
    requestedReasoning: r.requested_reasoning,
    concurrencyGroup: r.concurrency_group,
    enabled: B(r.enabled),
    capabilitySnapshot: PJ<CapabilityReport | null>(r.capability_json, null),
    env: PJ<Record<string, string>>(r.env_json, {}),
    workspaceRoot: r.workspace_root,
    sandbox: r.sandbox ?? 'workspace-write',
    liveEnabled: B(r.live_enabled),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSnapshot(r: any): ProfileSnapshot {
  return {
    id: r.id,
    taskId: r.task_id,
    profileId: r.profile_id,
    adapterId: r.adapter_id,
    name: r.name,
    requestedModel: r.requested_model,
    requestedReasoning: r.requested_reasoning,
    configRefs: PJ<Record<string, string>>(r.config_refs_json, {}),
    capabilitySnapshot: PJ<CapabilityReport | null>(r.capability_json, null),
    createdAt: r.created_at,
  };
}

function mapTask(r: any): TaskRecord {
  return {
    id: r.id,
    title: r.title,
    objective: r.objective,
    constraints: PJ<string[]>(r.constraints_json, []),
    phase: r.phase as TaskPhase,
    lifecycle: r.lifecycle,
    currentPlanRevisionId: r.current_plan_revision_id,
    approvedPlanRevisionId: r.approved_plan_revision_id,
    participantsRevision: r.participants_revision,
    version: r.version,
    limits: PJ<TaskLimits>(r.limits_json, {
      workerParallelism: 2,
      perProfileParallelism: 1,
      nativeProcessConcurrency: 4,
      infraRetries: 1,
      maxRepairRounds: 2,
      maxWorkItems: 12,
      noEventThresholdMs: 60_000,
      maxDiscussionExtraRounds: 1,
    }),
    workspaceRoot: r.workspace_root ?? null,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

function mapParticipant(r: any): Participant {
  return {
    id: r.id,
    taskId: r.task_id,
    profileSnapshotId: r.profile_snapshot_id,
    profileId: r.profile_id,
    role: r.role as ParticipantRole,
    isLead: B(r.is_lead),
    allowedPhases: PJ<TaskPhase[]>(r.allowed_phases_json, []),
    displayName: r.display_name,
    workspaceRoot: r.workspace_root ?? null,
    sandbox: r.sandbox ?? null,
    createdAt: r.created_at,
  };
}

function mapPlan(r: any): PlanRevision {
  return {
    id: r.id,
    taskId: r.task_id,
    number: r.number,
    content: PJ<PlanContent>(r.content_json, {} as PlanContent),
    createdBy: r.created_by,
    contentHash: r.content_hash,
    status: r.status as PlanStatus,
    summary: r.summary,
    createdAt: r.created_at,
  };
}

function mapWorkItem(r: any): WorkItem {
  return {
    id: r.id,
    taskId: r.task_id,
    planRevisionId: r.plan_revision_id,
    planItemId: r.plan_item_id,
    goal: r.goal,
    dependencyIds: PJ<string[]>(r.dependency_ids_json, []),
    assignedParticipantId: r.assigned_participant_id,
    allowedProfileIds: PJ<string[]>(r.allowed_profile_ids_json, []),
    inputRefs: PJ<string[]>(r.input_refs_json, []),
    outputSpecs: PJ<any[]>(r.output_specs_json, []),
    acceptanceCriteria: PJ<string[]>(r.acceptance_criteria_json, []),
    writeScope: PJ<string[]>(r.write_scope_json, []),
    state: r.state as WorkItemState,
    repairRound: r.repair_round,
    attemptCount: r.attempt_count,
    result: PJ<any>(r.result_json, null),
    lastError: r.last_error,
    userNote: r.user_note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSession(r: any): ManagedSession {
  return {
    id: r.id,
    taskId: r.task_id,
    participantId: r.participant_id,
    attemptId: r.attempt_id,
    adapterId: r.adapter_id,
    nativeSessionId: r.native_session_id,
    runtimeId: r.runtime_id,
    phase: r.phase as TaskPhase,
    purpose: r.purpose,
    lastEventAt: r.last_event_at,
    observedModel: r.observed_model,
    observedReasoning: r.observed_reasoning,
    processRef: PJ<ProcessRef | null>(r.process_json, null),
    connectionState: r.connection_state as ConnectionState,
    processHealth: r.process_health as ProcessHealth,
    activity: r.activity as MonitorActivity,
    status: r.status,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    error: r.error,
  };
}

function mapAttempt(r: any): RunAttempt {
  return {
    id: r.id,
    taskId: r.task_id,
    workItemId: r.work_item_id,
    sessionId: r.session_id,
    participantId: r.participant_id,
    phase: r.phase as TaskPhase,
    kind: r.kind,
    attemptNumber: r.attempt_number,
    status: r.status as AttemptStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    errorClass: r.error_class,
    errorMessage: r.error_message,
    cancelRequestedAt: r.cancel_requested_at,
    cancelConfirmedAt: r.cancel_confirmed_at,
    result: PJ<any>(r.result_json, null),
    createdAt: r.created_at,
  };
}

function mapEvent(r: any): EventEnvelope {
  return {
    seq: Number(r.seq),
    eventId: r.event_id,
    type: r.type,
    taskId: r.task_id,
    sessionId: r.session_id,
    attemptId: r.attempt_id,
    planRevisionId: r.plan_revision_id,
    observedAt: r.observed_at,
    sourceTime: r.source_time,
    source: r.source,
    payload: PJ<Record<string, unknown>>(r.payload_json, {}),
  };
}

function mapApproval(r: any): ApprovalRequest {
  return {
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    attemptId: r.attempt_id,
    nativeRequestId: r.native_request_id,
    kind: r.kind,
    title: r.title,
    detailRedacted: r.detail_redacted,
    scopeHash: r.scope_hash,
    state: r.state,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
  };
}

function mapArtifact(r: any): ArtifactRevision {
  return {
    id: r.id,
    taskId: r.task_id,
    workItemId: r.work_item_id,
    attemptId: r.attempt_id,
    relativePath: r.relative_path,
    mediaType: r.media_type,
    size: Number(r.size),
    sha256: r.sha256,
    producer: r.producer,
    status: r.status,
    registeredAt: r.registered_at,
    note: r.note,
  };
}

function mapRound(r: any): ReviewRound {
  return {
    id: r.id,
    taskId: r.task_id,
    number: r.number,
    artifactSetHash: r.artifact_set_hash,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export type { SqlParam };
