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
  concurrencyGroup: z.string().min(1).max(80).default('default'),
  enabled: z.boolean().default(true),
  liveEnabled: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  workspaceRoot: z.string().nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
});
export type ProfileCreateInput = z.infer<typeof ProfileCreateSchema>;

export const ProfilePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  executableRef: z.string().min(1).max(400).optional(),
  configRefs: z.record(z.string(), z.string()).optional(),
  secretRefs: z.array(z.string()).optional(),
  requestedModel: z.string().max(200).nullable().optional(),
  requestedReasoning: z.string().max(80).nullable().optional(),
  concurrencyGroup: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  liveEnabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  workspaceRoot: z.string().nullable().optional(),
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

export const TaskMessageSchema = z.object({
  text: z.string().min(1).max(20000),
  intent: z.enum(['chat', 'answer', 'supplement', 'instruction']).default('chat'),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type TaskMessageInput = z.infer<typeof TaskMessageSchema>;

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
