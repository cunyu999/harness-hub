/**
 * 核心实体类型。字段与 SYSTEM_BLUEPRINT.md 第 4 节一致。
 * 仅类型与纯常量, 不引入运行时依赖。
 */

export type AdapterId = 'codex' | 'claude-code' | 'dsh' | 'mock';

export const ADAPTER_IDS: AdapterId[] = ['codex', 'claude-code', 'dsh', 'mock'];

/* ------------------------------------------------------------------ */
/* 能力报告                                                            */
/* ------------------------------------------------------------------ */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export type CapabilityName =
  | 'structuredOutput'
  | 'streamMessages'
  | 'toolEvents'
  | 'approvals'
  | 'userInput'
  | 'cancellation'
  | 'nativeResume'
  | 'modelSelection'
  | 'reasoningSelection'
  | 'imageInput'
  | 'fileInput'
  | 'skills'
  | 'mcp'
  | 'workspaceRestriction'
  | 'reportedModelIdentity';

export const CAPABILITY_NAMES: CapabilityName[] = [
  'structuredOutput',
  'streamMessages',
  'toolEvents',
  'approvals',
  'userInput',
  'cancellation',
  'nativeResume',
  'modelSelection',
  'reasoningSelection',
  'imageInput',
  'fileInput',
  'skills',
  'mcp',
  'workspaceRestriction',
  'reportedModelIdentity',
];

export interface CapabilityEntry {
  state: CapabilityState;
  evidence?: string;
}

export interface CapabilityReport {
  adapterId: AdapterId;
  checkedAt: string;
  protocolVersion?: string;
  executable?: string;
  version?: string;
  capabilities: Partial<Record<CapabilityName, CapabilityEntry>>;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* 执行配置                                                            */
/* ------------------------------------------------------------------ */

/** 会话权限模式, 与 Codex 的 sandbox 取值保持一致。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export interface ExecutionProfile {
  id: string;
  name: string;
  adapterId: AdapterId;
  /** 启动入口引用, 不含密钥。 */
  executableRef: string;
  /** 原生配置引用, 例如 {"profile":"desktop"}。 */
  configRefs: Record<string, string>;
  /** 仅保存标签, 不保存明文密钥。 */
  secretRefs: string[];
  requestedModel: string | null;
  requestedReasoning: string | null;
  concurrencyGroup: string;
  enabled: boolean;
  capabilitySnapshot: CapabilityReport | null;
  /** 非敏感补充环境变量, 名字必须通过校验。 */
  env: Record<string, string>;
  /** 该 harness 的工作目录; 为空表示用任务自己的工作区。 */
  workspaceRoot: string | null;
  /** 该 harness 的会话权限: 只读 / 工作区内可写 / 完全权限。 */
  sandbox: SandboxMode;
  /** 是否允许该配置运行真实原生进程。 */
  liveEnabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileSnapshot {
  id: string;
  taskId: string;
  profileId: string;
  adapterId: AdapterId;
  name: string;
  requestedModel: string | null;
  requestedReasoning: string | null;
  configRefs: Record<string, string>;
  capabilitySnapshot: CapabilityReport | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 任务与状态                                                          */
/* ------------------------------------------------------------------ */

export type TaskPhase =
  | 'intake'
  | 'planning'
  | 'discussion'
  | 'execution'
  | 'integration'
  | 'verification'
  | 'review'
  | 'delivery';

export type TaskLifecycle =
  | 'draft'
  | 'active'
  | 'awaiting_plan_approval'
  | 'waiting_user'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'blocked'
  | 'completed'
  | 'failed';

export type WorkItemState =
  | 'pending'
  | 'ready'
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'produced'
  | 'verifying'
  | 'awaiting_review'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'invalidated';

export type AttemptStatus =
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'retry_wait'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export type ConnectionState = 'connected' | 'disconnected' | 'unknown';
export type ProcessHealth = 'alive' | 'exited' | 'unknown';
export type MonitorActivity =
  | 'generating'
  | 'tool_running'
  | 'idle'
  | 'no_recent_event'
  | 'unknown';

export const PHASES: TaskPhase[] = [
  'intake',
  'planning',
  'discussion',
  'execution',
  'integration',
  'verification',
  'review',
  'delivery',
];

export const LIFECYCLES: TaskLifecycle[] = [
  'draft',
  'active',
  'awaiting_plan_approval',
  'waiting_user',
  'paused',
  'cancelling',
  'cancelled',
  'blocked',
  'completed',
  'failed',
];

export const WORK_ITEM_STATES: WorkItemState[] = [
  'pending',
  'ready',
  'queued',
  'running',
  'waiting_input',
  'produced',
  'verifying',
  'awaiting_review',
  'accepted',
  'failed',
  'cancelled',
  'invalidated',
];

export const ATTEMPT_STATUSES: AttemptStatus[] = [
  'starting',
  'running',
  'waiting_approval',
  'waiting_user',
  'retry_wait',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
];

export interface TaskRecord {
  id: string;
  title: string;
  objective: string;
  constraints: string[];
  phase: TaskPhase;
  lifecycle: TaskLifecycle;
  currentPlanRevisionId: string | null;
  approvedPlanRevisionId: string | null;
  participantsRevision: number;
  version: number;
  limits: TaskLimits;
  /** 用户指定的任务工作区(绝对路径); 为空表示 .local/runs/<taskId>/workspace。 */
  workspaceRoot: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskLimits {
  workerParallelism: number;
  perProfileParallelism: number;
  nativeProcessConcurrency: number;
  infraRetries: number;
  maxRepairRounds: number;
  maxWorkItems: number;
  noEventThresholdMs: number;
  maxDiscussionExtraRounds: number;
}

export const DEFAULT_LIMITS: TaskLimits = {
  workerParallelism: 2,
  perProfileParallelism: 1,
  nativeProcessConcurrency: 4,
  infraRetries: 1,
  maxRepairRounds: 2,
  maxWorkItems: 12,
  noEventThresholdMs: 60_000,
  maxDiscussionExtraRounds: 1,
};

export type ParticipantRole = 'strong' | 'worker';

export interface Participant {
  id: string;
  taskId: string;
  profileSnapshotId: string;
  profileId: string;
  role: ParticipantRole;
  isLead: boolean;
  allowedPhases: TaskPhase[];
  displayName: string;
  createdAt: string;
  /** 该席位自己的工作目录(绝对路径, 或相对任务工作区); 为空表示按角色自动分配。 */
  workspaceRoot?: string | null;
  /** 该席位的会话权限覆盖; 为空表示沿用执行配置的 sandbox。 */
  sandbox?: SandboxMode | null;
}

/* ------------------------------------------------------------------ */
/* 计划                                                                */
/* ------------------------------------------------------------------ */

export type OutputValidation = 'exists' | 'nonempty' | 'command' | 'none';

export interface OutputSpec {
  label: string;
  format: string;
  /** 相对任务产物根目录的安全路径。 */
  relativePath: string;
  template: string | null;
  validation: OutputValidation;
  validationCommand: string | null;
}

export interface PlanWorkItem {
  id: string;
  goal: string;
  dependencies: string[];
  assignedParticipantId: string | null;
  inputs: string[];
  expectedOutputs: OutputSpec[];
  acceptanceCriteria: string[];
  writeScope: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface Deliverable {
  label: string;
  format: string;
  templateRef: string | null;
  destination: string;
  validationMethod: string;
  editableSource: string | null;
}

export interface PlanReviewPolicy {
  strongParticipantIds: string[];
  crossReviewRequired: boolean;
}

export interface PlanContent {
  objective: string;
  constraints: string[];
  assumptions: string[];
  clarificationNeeded: string[];
  workItems: PlanWorkItem[];
  deliverables: Deliverable[];
  verificationSteps: string[];
  reviewPolicy: PlanReviewPolicy;
  changeScope: string;
  risks: string[];
  limits: Partial<TaskLimits>;
  unresolvedDecisions: string[];
  /** 本版本相对上一版的用户补充/重规划说明; 参与 contentHash, 便于追溯"为什么改了计划"。 */
  revisionNote?: string | null;
}

export type PlanStatus = 'proposed' | 'approved' | 'superseded' | 'rejected';

export interface PlanRevision {
  id: string;
  taskId: string;
  number: number;
  content: PlanContent;
  createdBy: string;
  contentHash: string;
  status: PlanStatus;
  summary: string;
  createdAt: string;
}

export type PlanDecision = 'approve' | 'supplement' | 'replan';

export interface PlanApproval {
  id: string;
  taskId: string;
  planRevisionId: string;
  planHash: string;
  participantsRevision: number;
  decision: PlanDecision;
  userNote: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 工作项 / 尝试 / 会话                                                */
/* ------------------------------------------------------------------ */

export interface WorkItem {
  id: string;
  taskId: string;
  planRevisionId: string;
  planItemId: string;
  goal: string;
  dependencyIds: string[];
  assignedParticipantId: string | null;
  allowedProfileIds: string[];
  inputRefs: string[];
  outputSpecs: OutputSpec[];
  acceptanceCriteria: string[];
  writeScope: string[];
  state: WorkItemState;
  repairRound: number;
  attemptCount: number;
  result: WorkItemResult | null;
  lastError: string | null;
  /** 用户针对本工作项提问给出的回答; 恢复该工作项时带进下一轮提示。 */
  userNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemResult {
  workItemId: string;
  attemptId: string;
  status: 'completed' | 'needs_input' | 'blocked' | 'failed';
  summary: string;
  artifactRefs: string[];
  changes: string[];
  verificationClaims: { check: string; status: string; evidenceRef?: string }[];
  unresolvedIssues: string[];
  suggestedNextAction?: string;
}

export interface ManagedSession {
  id: string;
  taskId: string;
  participantId: string | null;
  attemptId: string | null;
  adapterId: AdapterId;
  nativeSessionId: string | null;
  runtimeId: string | null;
  phase: TaskPhase;
  purpose: string;
  lastEventAt: string;
  observedModel: string | null;
  observedReasoning: string | null;
  processRef: ProcessRef | null;
  connectionState: ConnectionState;
  processHealth: ProcessHealth;
  activity: MonitorActivity;
  status: string;
  createdAt: string;
  closedAt: string | null;
  error: string | null;
}

export interface ProcessRef {
  pid: number | null;
  /** 进程创建时间(ISO 或平台原始值), 用于防止 PID 复用误杀。 */
  startedAt: string | null;
  runtimeNonce: string | null;
  command: string;
}

export interface RunAttempt {
  id: string;
  taskId: string;
  workItemId: string | null;
  sessionId: string | null;
  participantId: string | null;
  phase: TaskPhase;
  kind: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  endedAt: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  cancelConfirmedAt: string | null;
  result: unknown;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 产物 / 验证 / 审核                                                  */
/* ------------------------------------------------------------------ */

export interface ArtifactRevision {
  id: string;
  taskId: string;
  workItemId: string | null;
  attemptId: string | null;
  relativePath: string;
  mediaType: string;
  size: number;
  sha256: string;
  producer: string;
  status: 'registered' | 'superseded' | 'invalid' | 'missing';
  registeredAt: string;
  note: string | null;
}

export interface VerificationResult {
  id: string;
  taskId: string;
  workItemId: string | null;
  artifactSetHash: string;
  checkId: string;
  method: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  evidenceRefs: string[];
  exitCode: number | null;
  detail: string;
  checkedAt: string;
}

export type ReviewVerdict =
  | 'approve'
  | 'changes_required'
  | 'needs_user_decision'
  | 'unable_to_review';

export interface ReviewRound {
  id: string;
  taskId: string;
  number: number;
  artifactSetHash: string;
  status: 'running' | 'completed' | 'superseded' | 'failed';
  createdAt: string;
  completedAt: string | null;
}

export interface ReviewResult {
  id: string;
  taskId: string;
  roundId: string;
  participantId: string;
  artifactSetHash: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  summary: string;
  crossChecked: { findingId: string; stance: string; note: string }[];
  evidenceRefs: string[];
  completedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: 'blocker' | 'major' | 'minor' | 'info';
  title: string;
  detail: string;
  evidenceRef?: string;
  suggestedFix?: string;
}

/* ------------------------------------------------------------------ */
/* 审批                                                                */
/* ------------------------------------------------------------------ */

export type ApprovalKind =
  | 'command_execution'
  | 'file_change'
  | 'permissions'
  | 'user_input'
  | 'mcp_elicitation'
  | 'other';

export interface ApprovalRequest {
  id: string;
  taskId: string;
  sessionId: string | null;
  attemptId: string | null;
  nativeRequestId: string | null;
  kind: ApprovalKind;
  title: string;
  detailRedacted: string;
  scopeHash: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'lead' | 'participant' | 'system';

export interface TaskMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  participantId: string | null;
  sessionId: string | null;
  attemptId: string | null;
  text: string;
  kind: string;
  createdAt: string;
  incomplete: boolean;
}
