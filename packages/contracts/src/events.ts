/**
 * 归一化事件契约。事件是唯一的事实来源: 前端只投影事件与快照, 不自行推断业务状态。
 */

export type EventType =
  | 'runtime.started'
  | 'runtime.exited'
  | 'runtime.connection_changed'
  | 'session.created'
  | 'session.resumed'
  | 'session.configuration_observed'
  | 'session.closed'
  | 'attempt.starting'
  | 'attempt.started'
  | 'message.delta'
  | 'message.completed'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'request.approval'
  | 'request.user_input'
  | 'request.resolved'
  | 'attempt.retry_wait'
  | 'attempt.cancel_requested'
  | 'attempt.cancel_confirmed'
  | 'attempt.completed'
  | 'attempt.failed'
  | 'attempt.interrupted'
  | 'monitor.no_recent_event'
  | 'monitor.health_changed'
  | 'plan.proposed'
  | 'plan.revised'
  | 'plan.approved'
  | 'plan.rejected'
  | 'work_item.queued'
  | 'work_item.updated'
  | 'work_item.result'
  | 'artifact.registered'
  | 'verification.recorded'
  | 'review.recorded'
  | 'delivery.updated'
  | 'task.updated'
  | 'task.control'
  | 'error.reported';

export interface EventEnvelope {
  seq: number;
  eventId: string;
  type: EventType;
  taskId: string | null;
  sessionId: string | null;
  attemptId: string | null;
  planRevisionId: string | null;
  observedAt: string;
  sourceTime: string | null;
  source: string;
  payload: Record<string, unknown>;
}

export interface TaskSnapshot {
  task: import('./types.js').TaskRecord;
  participants: import('./types.js').Participant[];
  profiles: import('./types.js').ProfileSnapshot[];
  plan: import('./types.js').PlanRevision | null;
  planHistory: import('./types.js').PlanRevision[];
  approvals: import('./types.js').PlanApproval[];
  workItems: import('./types.js').WorkItem[];
  sessions: import('./types.js').ManagedSession[];
  attempts: import('./types.js').RunAttempt[];
  artifacts: import('./types.js').ArtifactRevision[];
  verifications: import('./types.js').VerificationResult[];
  reviewRounds: import('./types.js').ReviewRound[];
  reviewResults: import('./types.js').ReviewResult[];
  approvalsPending: import('./types.js').ApprovalRequest[];
  messages: import('./types.js').TaskMessage[];
  highWaterSeq: number;
  limits: import('./types.js').TaskLimits;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  dataDir: string;
  adapters: { id: string; available: boolean; note: string }[];
  mockMode: boolean;
  highWaterSeq: number;
}
