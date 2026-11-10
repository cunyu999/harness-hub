/**
 * HTTP / SSE 请求与响应契约。所有写请求都经由 zod 校验, 错误统一为 {code, message, details?, correlationId}。
 */
import { z } from 'zod';
import type {
  AdapterId,
  ArtifactRevision,
  CapabilityReport,
  ExecutionProfile,
  ManagedSession,
  PlanWorkItem,
  TaskLimits,
  TaskPhase,
} from './types.js';
import { ADAPTER_IDS } from './types.js';

/** 适配器 id 的单一事实来源: 新增 harness 时只需改 types.ts 的 AdapterId / ADAPTER_IDS。 */
const adapterIdSchema = z.enum(ADAPTER_IDS as [AdapterId, ...AdapterId[]]);

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  correlationId: string;
}

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'correlationId' in value
  );
}

/* ---------------------------- profiles ---------------------------- */

export const ProfileCreateSchema = z.object({
  name: z.string().min(1).max(120),
  adapterId: adapterIdSchema,
  executableRef: z.string().max(400).default(''),
  configRefs: z.record(z.string(), z.string()).default({}),
  secretRefs: z.array(z.string()).default([]),
  requestedModel: z.string().max(200).nullable().default(null),
  requestedReasoning: z.string().max(80).nullable().default(null),
  /** 该 harness 的工作目录; 留空表示用任务自己的工作区。 */
  workspaceRoot: z.string().max(400).nullable().default(null),
  /** 会话权限: 只读 / 工作区内可写 / 完全权限。 */
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  concurrencyGroup: z.string().min(1).max(80).default('default'),
  enabled: z.boolean().default(true),
  liveEnabled: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  notes: z.string().max(2000).nullable().default(null),
});
export type ProfileCreateInput = z.infer<typeof ProfileCreateSchema>;

export const ProfilePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  executableRef: z.string().max(400).optional(),
  configRefs: z.record(z.string(), z.string()).optional(),
  secretRefs: z.array(z.string()).optional(),
  requestedModel: z.string().max(200).nullable().optional(),
  requestedReasoning: z.string().max(80).nullable().optional(),
  concurrencyGroup: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  liveEnabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type ProfilePatchInput = z.infer<typeof ProfilePatchSchema>;

export const ProbeRequestSchema = z.object({
  mode: z.enum(['inspect', 'live']).default('inspect'),
});
export type ProbeRequestInput = z.infer<typeof ProbeRequestSchema>;

export interface ProfileDto extends ExecutionProfile {
  /** 由 probe 产生的最近一次检查结论。 */
  lastProbe: ProbeResultDto | null;
  /** 被多少个任务参与者引用过(只读, 决定能否物理删除)。 */
  usage?: number;
  /** 私有 home 与源目录的同步状态(只读, 用于确认外部配置是否已生效)。 */
  homeSync?: HomeSyncStatus | null;
}

/* ------------------------ harness detection ------------------------ */

/** 「执行配置」里的本机安装探测结果; 前端据此显示一个可点的「已检测到, 是否使用」。 */
export interface DetectResultDto {
  adapterId: string;
  displayName: string;
  found: boolean;
  /** 检测到的可执行入口绝对路径, 可直接填进 profile.executableRef。 */
  executableRef: string | null;
  version: string | null;
  /** 检测到的默认凭据来源目录(存在才给)。 */
  sourceHome: string | null;
  /** 从哪儿找到的: PATH / 项目内工具目录 / npm 全局目录 / 用户指定文件夹。 */
  source: 'path' | 'project' | 'npm' | 'manual' | null;
  checkedAt: string;
  detail?: string;
}

export interface HomeSyncStatus {
  dir: string;
  sourceHome: string | null;
  /** 最近一次同步检查的时间。 */
  checkedAt: string | null;
  /** 最近一次真正写入私有 home 的时间。 */
  updatedAt: string | null;
  /** 源目录内容与上次同步不同, 下一回合会被同步进私有 home。 */
  pendingSourceChange: boolean;
  /** 内容有差异但保留了私有版本的文件名(通常是 harness 刷新过的凭据)。 */
  keptPrivate: string[];
}

export interface ProbeResultDto {
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

/* ------------------------------ tasks ----------------------------- */

export const ParticipantSelectionSchema = z.object({
  strongProfileIds: z.array(z.string().min(1)).min(1).max(6),
  leadProfileId: z.string().min(1),
  workerProfileIds: z.array(z.string().min(1)).max(8).default([]),
});

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(20000),
  constraints: z.array(z.string().max(2000)).max(50).default([]),
  strongProfileIds: z.array(z.string().min(1)).min(1).max(6),
  leadProfileId: z.string().min(1),
  workerProfileIds: z.array(z.string().min(1)).max(8).default([]),
  limits: z
    .object({
      workerParallelism: z.number().int().min(1).max(8).optional(),
      perProfileParallelism: z.number().int().min(1).max(4).optional(),
      nativeProcessConcurrency: z.number().int().min(1).max(12).optional(),
      infraRetries: z.number().int().min(0).max(3).optional(),
      maxRepairRounds: z.number().int().min(0).max(5).optional(),
      maxWorkItems: z.number().int().min(1).max(40).optional(),
      noEventThresholdMs: z.number().int().min(5000).max(600000).optional(),
      maxDiscussionExtraRounds: z.number().int().min(0).max(2).optional(),
    })
    .default({}),
  /** 任务工作区(绝对路径或相对项目根); 留空用任务私有目录。 */
  workspace: z.string().max(400).nullable().optional(),
  /** 逐个席位的工作区/权限覆盖; 不填按角色默认(planner 完全权限, worker 工作区内可写)。 */
  seats: z
    .array(
      z.object({
        profileId: z.string().min(1).max(80),
        workspaceRoot: z.string().max(600).nullable().optional(),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(),
      }),
    )
    .max(24)
    .default([]),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const PlanRequestSchema = z.object({
  reason: z.enum(['initial', 'replan', 'supplement']).default('initial'),
  supplement: z.string().max(20000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type PlanRequestInput = z.infer<typeof PlanRequestSchema>;

export const PlanDecisionSchema = z.object({
  decision: z.enum(['approve', 'supplement', 'replan']),
  planRevisionId: z.string().min(1),
  planHash: z.string().min(1),
  participantsRevision: z.number().int().min(0),
  expectedTaskVersion: z.number().int().min(0),
  note: z.string().max(20000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type PlanDecisionInput = z.infer<typeof PlanDecisionSchema>;

const AttachmentSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1).max(1000),
  relativePath: z.string().min(1).max(1000),
  mediaType: z.string().max(160),
  size: z.number().int().nonnegative(),
  isImage: z.boolean(),
});

export const TaskMessageSchema = z.object({
  text: z.string().min(1).max(20000),
  intent: z.enum(['chat', 'answer', 'supplement', 'instruction']).default('chat'),
  /** 指定和哪个席位对话(留空 = 主控)。 */
  participantId: z.string().max(80).nullable().optional(),
  attachments: z.array(AttachmentSchema).max(12).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type TaskMessageInput = z.infer<typeof TaskMessageSchema>;

export const ParticipantSettingsSchema = z.object({
  /** 席位自己的工作目录: 绝对路径, 或相对任务工作区的路径; null 表示回到自动分配。 */
  workspaceRoot: z.string().max(600).nullable().optional(),
  /** 席位级权限覆盖; null 表示沿用执行配置。 */
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(),
});
export type ParticipantSettingsInput = z.infer<typeof ParticipantSettingsSchema>;

export const TaskControlSchema = z.object({
  action: z.enum(['pause_dispatch', 'resume', 'cancel', 'cancel_session']),
  targetSessionId: z.string().min(1).optional(),
  reason: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type TaskControlInput = z.infer<typeof TaskControlSchema>;

export const ApprovalResolveSchema = z.object({
  decision: z.enum(['approve', 'deny', 'cancel', 'answer']),
  answer: z.string().max(20000).optional(),
  note: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type ApprovalResolveInput = z.infer<typeof ApprovalResolveSchema>;

/* ---------------------------- view models -------------------------- */

export interface SessionDto extends ManagedSession {
  participantName: string | null;
  participantRole: string | null;
  adapterId: AdapterId;
  taskTitle?: string;
}

export interface ArtifactDto extends ArtifactRevision {
  contentUrl: string;
  exists: boolean;
}

export interface ReviewBundle {
  rounds: import('./types.js').ReviewRound[];
  results: import('./types.js').ReviewResult[];
  verifications: import('./types.js').VerificationResult[];
  artifacts: import('./types.js').ArtifactRevision[];
  artifactSetHash: string | null;
}

export interface TaskListItem {
  id: string;
  title: string;
  phase: TaskPhase;
  lifecycle: import('./types.js').TaskLifecycle;
  updatedAt: string;
  strongCount: number;
  workerCount: number;
  planNumber: number | null;
  artifactCount: number;
}

export interface LimitsDto extends TaskLimits {}

export interface PlanWorkItemDto extends PlanWorkItem {}

export const SUPPLEMENT_HINT = '补充内容后系统会生成新的计划版本, 旧批准失效。';
