/**
 * Harness 适配器契约。对应 SYSTEM_BLUEPRINT.md 第 8 节。
 * 适配器只负责原生进程/协议与事件归一化, 不做业务状态判断。
 */
import type {
  AdapterId,
  CapabilityReport,
  ExecutionProfile,
  MonitorActivity,
  ProcessRef,
} from '../../contracts/src/types.js';

export type TurnKind =
  | 'chat'
  | 'plan'
  | 'discussion.proposal'
  | 'discussion.critique'
  | 'plan.synthesize'
  | 'work'
  | 'review'
  | 'review.crosscheck'
  | 'integrate'
  | 'deliver';

export interface TurnRequest {
  kind: TurnKind;
  /** 人可读的完整提示, 由 core 生成; 含 envelope 标记与 JSON 上下文。 */
  prompt: string;
  /** 结构化上下文, 便于 mock 逻辑与调试; 真实适配器只使用 prompt。 */
  context: Record<string, unknown>;
  /** 期望的 JSON 输出 schema 描述(仅提示用途)。 */
  expectsJson: boolean;
  /** 该轮的最长允许时间, 0 表示不限制。 */
  timeoutMs: number;
}

export type TurnStatus = 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface TurnOutcome {
  status: TurnStatus;
  text: string;
  errorClass: string | null;
  errorMessage: string | null;
  observedModel: string | null;
  reportedReasoning: string | null;
  usage: Record<string, unknown> | null;
  durationMs: number;
}

export type AdapterEvent =
  | { kind: 'message.delta'; text: string }
  | { kind: 'message.completed'; text: string }
  | { kind: 'tool.started'; toolName: string; callId: string; inputSummary: string }
  | { kind: 'tool.progress'; callId: string; text: string }
  | { kind: 'tool.completed'; callId: string; ok: boolean; outputSummary: string }
  | {
      kind: 'approval.requested';
      requestId: string;
      approvalKind: string;
      title: string;
      detail: string;
      scopeHash: string;
    }
  | { kind: 'user_input.requested'; requestId: string; prompt: string }
  | { kind: 'request.resolved'; requestId: string; outcome: string }
  | { kind: 'activity'; activity: MonitorActivity; note?: string }
  | { kind: 'error'; message: string; errorClass: string }
  | { kind: 'notice'; text: string };

export interface AdapterHost {
  onEvent(sessionLocalId: string, ev: AdapterEvent): void;
  onSessionInfo(sessionLocalId: string, info: SessionInspection): void;
  onExit(sessionLocalId: string, info: { code: number | null; expected: boolean }): void;
}

export interface SessionInspection {
  pid: number | null;
  processRef: ProcessRef | null;
  connectionState: 'connected' | 'disconnected' | 'unknown';
  activity: MonitorActivity;
  nativeSessionId: string | null;
  observedModel: string | null;
  observedReasoning: string | null;
  detail: string;
}

export interface OpenSessionOptions {
  profile: ExecutionProfile;
  taskId: string;
  attemptId: string | null;
  participantId: string | null;
  /** 任务工作目录(项目内绝对路径)。 */
  cwd: string;
  purpose: string;
  /** 仅本程序拥有的环境变量, 已包含 TEMP/TMP 等项目内路径。 */
  env: Record<string, string>;
  /** 允许写入的根目录, 用于原生 sandbox 参数。 */
  writeScope: string[];
  /** 会话权限: 只读 / 工作区内可写 / 完全权限。 */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** 原生 resume 时给出。 */
  resumeNativeSessionId?: string | null;
  /** 适配器补充选项, 来自 profile.configRefs。 */
  options?: Record<string, string>;
}

export interface CancelReceipt {
  /** 是否已确认原生停止; false 表示停止结果无法确认。 */
  confirmed: boolean;
  detail: string;
  at: string;
}

export interface AdapterSession {
  readonly localId: string;
  readonly nativeSessionId: string | null;
  readonly adapterId: AdapterId;
  readonly inspection: SessionInspection;
  sendTurn(req: TurnRequest): Promise<TurnOutcome>;
  cancel(): Promise<CancelReceipt>;
  respond(requestId: string, decision: 'approve' | 'deny' | 'answer', payload?: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProbeResult {
  ok: boolean;
  mode: 'inspect' | 'live';
  checkedAt: string;
  executableResolved: string | null;
  version: string | null;
  protocol: string | null;
  detail: string;
  capability: CapabilityReport | null;
  warnings: string[];
}

export interface HarnessAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  readonly mock: boolean;
  probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult>;
  capabilities(profile: ExecutionProfile): Promise<CapabilityReport>;
  openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession>;
  /** 本适配器需要的私有 home 目录(项目内), null 表示不需要。 */
  privateHomeDir?(profile: ExecutionProfile): string | null;
}

export class AdapterError extends Error {
  constructor(
    readonly errorClass: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
