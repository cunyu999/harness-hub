/**
 * 任务引擎: 把"模型判断"和"程序状态机"分开。
 * - 模型只负责生成计划、执行工作、审核结论(通过适配器);
 * - 引擎负责阶段转换、计划版本绑定、依赖与并发、重试上限、产物验证、
 *   审核版本绑定、取消确认与重启恢复。
 * 所有状态变化都写入数据库并广播事件; UI 只消费事件与快照。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LIMITS,
  type ArtifactRevision,
  type ExecutionProfile,
  type ManagedSession,
  type Participant,
  type PlanContent,
  type PlanRevision,
  type ReviewFinding,
  type ReviewResult,
  type ReviewVerdict,
  type RunAttempt,
  type TaskLimits,
  type TaskPhase,
  type TaskRecord,
  type VerificationResult,
  type WorkItem,
  type WorkItemResult,
  type WorkItemState,
} from '../../contracts/src/types.js';
import type { EventEnvelope, EventType, TaskSnapshot } from '../../contracts/src/events.js';
import type { Repo } from '../../storage/src/repo.js';
import type {
  AdapterEvent,
  AdapterHost,
  AdapterSession,
  HarnessAdapter,
  SessionInspection,
  TurnKind,
  TurnOutcome,
} from '../../adapters/src/types.js';
import { extractJson } from '../../adapters/src/envelope.js';
import { EventBus } from './bus.js';
import { selectDispatchable, allTerminal, executionSettled, type DispatchItem } from './scheduler.js';
import {
  buildDeliveryPrompt,
  buildDiscussionCritiquePrompt,
  buildDiscussionProposalPrompt,
  buildIntegrationPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
  type PromptEnv,
} from './prompts.js';
import { validatePlan } from './plan.js';
import {
  isInside,
  newId,
  normalizeRelPath,
  nowIso,
  safeJoin,
  sha256File,
  sha256Stable,
  truncate,
  unique,
} from './util.js';

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface EnginePaths {
  /** 项目根目录 D:\1hobby */
  root: string;
  dataDir: string;
}

export interface EngineConfig {
  paths: EnginePaths;
  adapters: Record<string, HarnessAdapter>;
  defaultTurnTimeoutMs?: number;
  /** 一次任务里允许的最长回合数, 防止无限循环。 */
  maxTurnsPerTask?: number;
}

interface LiveSession {
  localId: string;
  sessionRowId: string;
  taskId: string;
  attemptId: string;
  participantId: string;
  workItemId: string | null;
  session: AdapterSession;
  cancelRequested: boolean;
  purpose: string;
}

interface DeltaBuffer {
  text: string;
  timer: NodeJS.Timeout | null;
  sessionId: string;
  attemptId: string;
  taskId: string;
}

const PHASE_ORDER: TaskPhase[] = [
  'intake',
  'planning',
  'discussion',
  'execution',
  'integration',
  'verification',
  'review',
  'delivery',
];

export class Engine implements AdapterHost {
  readonly bus = new EventBus();
  private readonly live = new Map<string, LiveSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly pumping = new Set<string>();
  private readonly stageBusy = new Set<string>();
  private readonly deltas = new Map<string, DeltaBuffer>();
  private readonly workerPromises = new Map<string, Set<Promise<void>>>();
  private readonly noEventMarked = new Set<string>();
  private readonly startTs = Date.now();
  private monitorTimer: NodeJS.Timeout | null = null;
  /** 关闭后所有后台流程立即收敛, 不再写库或派发新回合。 */
  private stopped = false;
  private readonly defaultTurnTimeoutMs: number;
  private readonly maxTurnsPerTask: number;

  constructor(
    private readonly repo: Repo,
    private readonly cfg: EngineConfig,
  ) {
    this.defaultTurnTimeoutMs = cfg.defaultTurnTimeoutMs ?? 25 * 60_000;
    this.maxTurnsPerTask = cfg.maxTurnsPerTask ?? 200;
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * 停止后台流程: 停监控、等正在跑的 worker 收敛、标记 stopped。
   * 必须在关闭数据库前调用, 否则后台流程会撞上"database is not open"。
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    this.stopMonitoring();
    for (const pending of this.deltas.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.deltas.clear();
    const running: Promise<unknown>[] = [];
    for (const set of this.workerPromises.values()) running.push(...set);
    for (const p of this.locks.values()) running.push(p);
    if (running.length > 0) {
      await Promise.race([
        Promise.allSettled(running),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]);
    }
    this.workerPromises.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 路径                                                                */
  /* ------------------------------------------------------------------ */

  workspaceDir(taskId: string): string {
    return path.join(this.cfg.paths.root, '.local', 'runs', taskId, 'workspace');
  }

  taskTmpDir(taskId: string): string {
    return path.join(this.cfg.paths.root, '.local', 'runs', taskId, 'tmp');
  }

  private taskSessionEnv(taskId: string, extra: Record<string, string> = {}): Record<string, string> {
    const tmp = this.taskTmpDir(taskId);
    mkdirSync(tmp, { recursive: true });
    return {
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
      XDG_CACHE_HOME: path.join(tmp, 'cache'),
      npm_config_cache: path.join(tmp, 'npm-cache'),
      HH_TASK_ID: taskId,
      ...extra,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 事件与快照                                                          */
  /* ------------------------------------------------------------------ */

  emit(
    type: EventType,
    opts: {
      taskId: string | null;
      sessionId?: string | null;
      attemptId?: string | null;
      planRevisionId?: string | null;
      source?: string;
      payload?: Record<string, unknown>;
    },
  ): EventEnvelope {
    const env = this.repo.appendEvent({
      type,
      taskId: opts.taskId,
      sessionId: opts.sessionId ?? null,
      attemptId: opts.attemptId ?? null,
      planRevisionId: opts.planRevisionId ?? null,
      source: opts.source ?? 'engine',
      payload: opts.payload ?? {},
    });
    this.bus.publish(env);
    return env;
  }

  private touchTask(taskId: string, patch: Partial<TaskRecord> = {}, expectedVersion: number | null = null): TaskRecord {
    const updated = this.repo.updateTask(taskId, { ...patch, updatedAt: nowIso() }, expectedVersion);
    if (!updated) throw new EngineError('task_version_conflict', '任务版本已变化, 请刷新后重试', 409);
    this.emit('task.updated', {
      taskId,
      payload: {
        phase: updated.phase,
        lifecycle: updated.lifecycle,
        version: updated.version,
        errorCode: updated.errorCode,
        errorMessage: updated.errorMessage,
      },
    });
    return updated;
  }

  snapshot(taskId: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    const plan = task.currentPlanRevisionId ? this.repo.getPlan(task.currentPlanRevisionId) : null;
    const highWaterSeq = this.repo.maxSeq();
    return {
      task,
      participants: this.repo.listParticipants(taskId),
      profiles: this.repo.listSnapshots(taskId),
      plan,
      planHistory: this.repo.listPlans(taskId),
      approvals: this.repo.listPlanApprovals(taskId),
      workItems: this.repo.listWorkItems(taskId),
      sessions: this.repo.listSessions(taskId),
      attempts: this.repo.listAttempts(taskId),
      artifacts: this.repo.listCurrentArtifacts(taskId),
      verifications: this.repo.listVerifications(taskId),
      reviewRounds: this.repo.listReviewRounds(taskId),
      reviewResults: this.repo.listReviewResults(taskId),
      approvalsPending: this.repo.listPendingApprovals(taskId),
      messages: this.repo.listMessages(taskId, 200),
      highWaterSeq,
      limits: task.limits,
    };
  }

  private requireTask(taskId: string): TaskRecord {
    const t = this.repo.getTask(taskId);
    if (!t) throw new EngineError('task_not_found', `任务 ${taskId} 不存在`, 404);
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* 任务创建                                                            */
  /* ------------------------------------------------------------------ */

  createTask(input: {
    title: string;
    objective: string;
    constraints: string[];
    strongProfileIds: string[];
    leadProfileId: string;
    workerProfileIds: string[];
    limits?: Partial<TaskLimits>;
    outputHint?: string;
  }): TaskRecord {
    const strongIds = unique(input.strongProfileIds);
    if (strongIds.length === 0) throw new EngineError('invalid_participants', '至少需要一个强模型配置');
    if (!strongIds.includes(input.leadProfileId)) {
      throw new EngineError('invalid_participants', '主控必须来自强模型配置列表');
    }
    const profiles = new Map<string, ExecutionProfile>();
    for (const id of unique([...strongIds, ...input.workerProfileIds])) {
      const p = this.repo.getProfile(id);
      if (!p) throw new EngineError('profile_not_found', `执行配置 ${id} 不存在`, 404);
      if (!p.enabled) throw new EngineError('profile_disabled', `执行配置 ${p.name} 已禁用`);
      profiles.set(id, p);
    }
    const taskId = newId('task');
    const now = nowIso();
    const limits: TaskLimits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
    const task: TaskRecord = {
      id: taskId,
      title: input.title,
      objective: input.objective,
      constraints: input.constraints,
      phase: 'intake',
      lifecycle: 'draft',
      currentPlanRevisionId: null,
      approvedPlanRevisionId: null,
      participantsRevision: 1,
      version: 1,
      limits,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.repo.db.tx(() => {
      this.repo.insertTask(task);
      const mkParticipant = (profileId: string, role: 'strong' | 'worker', isLead: boolean): Participant => {
        const profile = profiles.get(profileId)!;
        const snapshotId = newId('psnp');
        this.repo.insertSnapshot({
          id: snapshotId,
          taskId,
          profileId,
          adapterId: profile.adapterId,
          name: profile.name,
          requestedModel: profile.requestedModel,
          requestedReasoning: profile.requestedReasoning,
          configRefs: profile.configRefs,
          capabilitySnapshot: profile.capabilitySnapshot,
          createdAt: now,
        });
        const participant: Participant = {
          id: newId('part'),
          taskId,
          profileSnapshotId: snapshotId,
          profileId,
          role,
          isLead,
          allowedPhases: PHASE_ORDER,
          displayName: profile.name,
          createdAt: now,
        };
        this.repo.insertParticipant(participant);
        return participant;
      };
      for (const id of strongIds) mkParticipant(id, 'strong', id === input.leadProfileId);
      for (const id of unique(input.workerProfileIds)) {
        if (strongIds.includes(id)) continue;
        mkParticipant(id, 'worker', false);
      }
    });

    mkdirSync(this.workspaceDir(taskId), { recursive: true });
    mkdirSync(path.join(this.workspaceDir(taskId), 'deliverables'), { recursive: true });
    this.emit('task.updated', { taskId, payload: { created: true, phase: task.phase, lifecycle: task.lifecycle } });
    return this.repo.getTask(taskId)!;
  }

  /* ------------------------------------------------------------------ */
  /* 参与者与配置一致性                                                   */
  /* ------------------------------------------------------------------ */

  private participantsOf(taskId: string): Participant[] {
    return this.repo.listParticipants(taskId);
  }

  private leadOf(taskId: string): Participant {
    const lead = this.participantsOf(taskId).find((p) => p.role === 'strong' && p.isLead);
    if (!lead) throw new EngineError('invalid_participants', '任务缺少主控席位');
    return lead;
  }

  private profileFor(participant: Participant): ExecutionProfile {
    const profile = this.repo.getProfile(participant.profileId);
    if (!profile) throw new EngineError('profile_not_found', `执行配置 ${participant.profileId} 已不存在`);
    const snap = this.repo.listSnapshots(participant.taskId).find((s) => s.id === participant.profileSnapshotId);
    if (!snap) throw new EngineError('snapshot_missing', '参与者缺少配置快照');
    if (snap.adapterId !== profile.adapterId) {
      throw new EngineError('profile_drift', `配置 ${profile.name} 的 adapter 已变化, 不能静默换模型`);
    }
    if ((snap.requestedModel ?? null) !== (profile.requestedModel ?? null)) {
      throw new EngineError('profile_drift', `配置 ${profile.name} 的模型已变化, 需要重新确认参与者`);
    }
    if ((snap.requestedReasoning ?? null) !== (profile.requestedReasoning ?? null)) {
      throw new EngineError('profile_drift', `配置 ${profile.name} 的推理等级已变化, 需要重新确认参与者`);
    }
    if (!profile.liveEnabled && profile.adapterId !== 'mock') {
      throw new EngineError('profile_not_live', `配置 ${profile.name} 未启用真实运行`);
    }
    return profile;
  }

  private adapterFor(profile: ExecutionProfile): HarnessAdapter {
    const adapter = this.cfg.adapters[profile.adapterId];
    if (!adapter) throw new EngineError('adapter_missing', `未注册适配器 ${profile.adapterId}`);
    return adapter;
  }

  private promptEnv(task: TaskRecord): PromptEnv {
    return {
      task,
      participants: this.participantsOf(task.id),
      limits: task.limits,
      workspaceRoot: this.workspaceDir(task.id),
      outputDir: 'deliverables',
    };
  }

  /* ------------------------------------------------------------------ */
  /* 会话与回合                                                          */
  /* ------------------------------------------------------------------ */

  private async runTurn(
    task: TaskRecord,
    participant: Participant,
    phase: TaskPhase,
    kind: TurnKind,
    prompt: { text: string; context: Record<string, unknown> },
    opts: { workItemId?: string | null; expectsJson?: boolean; timeoutMs?: number; purpose?: string } = {},
  ): Promise<{ outcome: TurnOutcome; attempt: RunAttempt; sessionRow: ManagedSession }> {
    if (this.stopped) throw new EngineError('engine_stopped', '引擎已关闭, 不再启动新回合', 503);
    const profile = this.profileFor(participant);
    const adapter = this.adapterFor(profile);
    const workspace = this.workspaceDir(task.id);
    mkdirSync(workspace, { recursive: true });
    const attemptId = newId('att');
    const sessionRowId = newId('ses');
    const now = nowIso();
    const attempt: RunAttempt = {
      id: attemptId,
      taskId: task.id,
      workItemId: opts.workItemId ?? null,
      sessionId: sessionRowId,
      participantId: participant.id,
      phase,
      kind,
      attemptNumber: opts.workItemId
        ? this.repo.nextAttemptNumber(opts.workItemId)
        : this.repo.nextAttemptNumber(`stage:${task.id}:${kind}`),
      status: 'starting',
      startedAt: now,
      endedAt: null,
      errorClass: null,
      errorMessage: null,
      cancelRequestedAt: null,
      cancelConfirmedAt: null,
      result: null,
      createdAt: now,
    };
    const sessionRow: ManagedSession = {
      id: sessionRowId,
      taskId: task.id,
      participantId: participant.id,
      attemptId,
      adapterId: profile.adapterId,
      nativeSessionId: null,
      runtimeId: null,
      phase,
      purpose: opts.purpose ?? kind,
      lastEventAt: now,
      observedModel: profile.requestedModel,
      observedReasoning: profile.requestedReasoning,
      processRef: null,
      connectionState: 'unknown',
      processHealth: 'unknown',
      activity: 'idle',
      status: 'starting',
      createdAt: now,
      closedAt: null,
      error: null,
    };
    this.repo.insertAttempt(attempt);
    this.repo.insertSession(sessionRow);
    this.emit('attempt.starting', {
      taskId: task.id,
      attemptId,
      sessionId: sessionRowId,
      payload: { kind, participantId: participant.id, phase },
    });

    let session: AdapterSession | null = null;
    try {
      session = await adapter.openSession(
        {
          profile,
          taskId: task.id,
          attemptId,
          participantId: participant.id,
          cwd: workspace,
          purpose: opts.purpose ?? kind,
          env: { ...profile.env, ...this.taskSessionEnv(task.id, { HH_PARTICIPANT: participant.id }) },
          writeScope: [workspace],
          resumeNativeSessionId: this.reusableNativeSession(task.id, participant.id, phase),
        },
        this,
      );
      const live: LiveSession = {
        localId: session.localId,
        sessionRowId,
        taskId: task.id,
        attemptId,
        participantId: participant.id,
        workItemId: opts.workItemId ?? null,
        session,
        cancelRequested: false,
        purpose: opts.purpose ?? kind,
      };
      this.live.set(session.localId, live);
      this.repo.updateSession(sessionRowId, {
        status: 'running',
        connectionState: 'connected',
        processHealth: 'alive',
        nativeSessionId: session.nativeSessionId,
        observedModel: session.inspection.observedModel,
        observedReasoning: session.inspection.observedReasoning,
        processRef: session.inspection.processRef,
        runtimeId: session.localId,
      });
      this.repo.updateAttempt(attemptId, { status: 'running' });
      this.emit('runtime.started', {
        taskId: task.id,
        attemptId,
        sessionId: sessionRowId,
        payload: {
          adapter: profile.adapterId,
          pid: session.inspection.pid,
          nativeSessionId: session.nativeSessionId,
          observedModel: session.inspection.observedModel,
        },
      });
      this.emit('attempt.started', { taskId: task.id, attemptId, sessionId: sessionRowId, payload: { kind } });

      const outcome = await session.sendTurn({
        kind,
        prompt: prompt.text,
        context: prompt.context,
        expectsJson: opts.expectsJson ?? true,
        timeoutMs: opts.timeoutMs ?? this.defaultTurnTimeoutMs,
      });
      this.flushDelta(attemptId);
      const status: RunAttempt['status'] =
        outcome.status === 'completed'
          ? 'completed'
          : outcome.status === 'cancelled'
            ? live.cancelRequested
              ? 'cancelled'
              : 'interrupted'
            : 'failed';
      this.repo.updateAttempt(attemptId, {
        status,
        endedAt: nowIso(),
        errorClass: outcome.errorClass,
        errorMessage: outcome.errorMessage,
        result: { text: truncate(outcome.text, 20000), observedModel: outcome.observedModel, usage: outcome.usage },
      });
      this.emit(outcome.status === 'completed' ? 'attempt.completed' : outcome.status === 'cancelled' ? 'attempt.interrupted' : 'attempt.failed', {
        taskId: task.id,
        attemptId,
        sessionId: sessionRowId,
        payload: {
          status,
          errorClass: outcome.errorClass,
          errorMessage: outcome.errorMessage,
          durationMs: outcome.durationMs,
        },
      });
      const updatedSession = this.repo.updateSession(sessionRowId, {
        status: 'closed',
        connectionState: 'disconnected',
        processHealth: 'exited',
        activity: 'idle',
        closedAt: nowIso(),
        lastEventAt: nowIso(),
      });
      this.emit('session.closed', { taskId: task.id, attemptId, sessionId: sessionRowId, payload: { sessionId: sessionRowId } });
      void updatedSession;
      return { outcome, attempt: this.repo.getAttempt(attemptId)!, sessionRow: this.repo.getSession(sessionRowId)! };
    } catch (err) {
      this.flushDelta(attemptId);
      const message = (err as Error).message.slice(0, 800);
      const code = err instanceof Error && 'code' in err ? String((err as { code?: string }).code ?? 'session_error') : 'session_error';
      this.repo.updateAttempt(attemptId, {
        status: session ? 'failed' : 'failed',
        endedAt: nowIso(),
        errorClass: code,
        errorMessage: message,
      });
      this.repo.updateSession(sessionRowId, {
        status: 'failed',
        connectionState: 'disconnected',
        processHealth: 'unknown',
        closedAt: nowIso(),
        error: message,
      });
      this.emit('attempt.failed', {
        taskId: task.id,
        attemptId,
        sessionId: sessionRowId,
        payload: { errorClass: code, errorMessage: message },
      });
      this.emit('error.reported', { taskId: task.id, attemptId, sessionId: sessionRowId, payload: { code, message } });
      return {
        outcome: {
          status: 'failed',
          text: '',
          errorClass: code,
          errorMessage: message,
          observedModel: null,
          reportedReasoning: null,
          usage: null,
          durationMs: 0,
        },
        attempt: this.repo.getAttempt(attemptId)!,
        sessionRow: this.repo.getSession(sessionRowId)!,
      };
    } finally {
      if (session) {
        this.live.delete(session.localId);
        await session.close().catch(() => undefined);
      }
    }
  }

  /** 原生恢复仅在同一任务、同一参与者、同一阶段的最近会话上启用。 */
  private reusableNativeSession(taskId: string, participantId: string, phase: TaskPhase): string | null {
    const sessions = this.repo
      .listSessions(taskId)
      .filter(
        (s) =>
          s.participantId === participantId &&
          s.phase === phase &&
          s.nativeSessionId !== null &&
          s.closedAt !== null &&
          s.status !== 'failed',
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return sessions[0]?.nativeSessionId ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* AdapterHost 实现                                                    */
  /* ------------------------------------------------------------------ */

  private flushDelta(attemptId: string): void {
    const buf = this.deltas.get(attemptId);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    this.deltas.delete(attemptId);
    if (buf.text.length === 0) return;
    this.emit('message.delta', {
      taskId: buf.taskId,
      attemptId,
      sessionId: buf.sessionId,
      payload: { text: buf.text },
    });
  }

  onEvent(localId: string, ev: AdapterEvent): void {
    const live = this.live.get(localId);
    if (!live) return;
    const now = nowIso();
    this.repo.updateSession(live.sessionRowId, { lastEventAt: now });
    this.noEventMarked.delete(live.sessionRowId);
    const base = { taskId: live.taskId, sessionId: live.sessionRowId, attemptId: live.attemptId };
    switch (ev.kind) {
      case 'message.delta': {
        let buf = this.deltas.get(live.attemptId);
        if (!buf) {
          buf = { text: '', timer: null, sessionId: live.sessionRowId, attemptId: live.attemptId, taskId: live.taskId };
          this.deltas.set(live.attemptId, buf);
        }
        buf.text += ev.text;
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
          const b = this.deltas.get(live.attemptId);
          if (!b) return;
          this.deltas.delete(live.attemptId);
          if (b.text.length > 0) {
            this.emit('message.delta', {
              taskId: b.taskId,
              attemptId: b.attemptId,
              sessionId: b.sessionId,
              payload: { text: b.text },
            });
          }
        }, 120);
        break;
      }
      case 'message.completed': {
        this.repo.insertMessage({
          id: newId('msg'),
          taskId: live.taskId,
          role: live.participantId === this.leadOf(live.taskId).id ? 'lead' : 'participant',
          participantId: live.participantId,
          sessionId: live.sessionRowId,
          attemptId: live.attemptId,
          text: ev.text,
          kind: live.purpose,
          createdAt: now,
          incomplete: false,
        });
        this.emit('message.completed', { ...base, payload: { text: truncate(ev.text, 20000), kind: live.purpose } });
        break;
      }
      case 'tool.started': {
        this.emit('tool.started', { ...base, payload: { toolName: ev.toolName, callId: ev.callId, inputSummary: ev.inputSummary } });
        break;
      }
      case 'tool.progress': {
        this.emit('tool.progress', { ...base, payload: { callId: ev.callId, text: ev.text } });
        break;
      }
      case 'tool.completed': {
        this.emit('tool.completed', { ...base, payload: { callId: ev.callId, ok: ev.ok, outputSummary: ev.outputSummary } });
        break;
      }
      case 'activity': {
        this.repo.updateSession(live.sessionRowId, { activity: ev.activity });
        this.emit('monitor.health_changed', { ...base, payload: { activity: ev.activity } });
        break;
      }
      case 'notice': {
        this.repo.insertMessage({
          id: newId('msg'),
          taskId: live.taskId,
          role: 'system',
          participantId: null,
          sessionId: live.sessionRowId,
          attemptId: live.attemptId,
          text: ev.text,
          kind: 'notice',
          createdAt: now,
          incomplete: false,
        });
        this.emit('message.completed', { ...base, payload: { text: ev.text, kind: 'notice' } });
        break;
      }
      case 'error': {
        this.emit('error.reported', { ...base, payload: { message: ev.message, errorClass: ev.errorClass } });
        break;
      }
      case 'approval.requested':
      case 'user_input.requested': {
        const approvalId = newId('apv');
        const kind =
          ev.kind === 'user_input.requested'
            ? 'user_input'
            : /file|patch/i.test(ev.approvalKind)
              ? 'file_change'
              : /permission/i.test(ev.approvalKind)
                ? 'permissions'
                : /command|exec/i.test(ev.approvalKind)
                  ? 'command_execution'
                  : 'other';
        this.repo.insertApprovalRequest({
          id: approvalId,
          taskId: live.taskId,
          sessionId: live.sessionRowId,
          attemptId: live.attemptId,
          nativeRequestId: ev.requestId,
          kind,
          title: ev.kind === 'user_input.requested' ? '模型请求用户输入' : ev.title,
          detailRedacted: ev.kind === 'user_input.requested' ? ev.prompt : ev.detail,
          scopeHash: ev.kind === 'user_input.requested' ? 'user_input' : ev.scopeHash,
          state: 'pending',
          createdAt: now,
          resolvedAt: null,
          resolutionNote: null,
        });
        this.repo.updateAttempt(live.attemptId, { status: 'waiting_approval' });
        this.emit(ev.kind === 'user_input.requested' ? 'request.user_input' : 'request.approval', {
          ...base,
          payload: {
            approvalId,
            requestId: ev.requestId,
            title: ev.kind === 'user_input.requested' ? '模型请求用户输入' : ev.title,
            detail: ev.kind === 'user_input.requested' ? ev.prompt : ev.detail,
            kind,
          },
        });
        break;
      }
      case 'request.resolved': {
        this.repo.updateAttempt(live.attemptId, { status: 'running' });
        this.emit('request.resolved', { ...base, payload: { requestId: ev.requestId, outcome: ev.outcome } });
        break;
      }
      default:
        break;
    }
  }

  onSessionInfo(localId: string, info: SessionInspection): void {
    const live = this.live.get(localId);
    if (!live) return;
    const row = this.repo.getSession(live.sessionRowId);
    if (!row) return;
    const activityChanged = row.activity !== info.activity;
    const connChanged = row.connectionState !== info.connectionState;
    this.repo.updateSession(live.sessionRowId, {
      connectionState: info.connectionState,
      activity: info.activity,
      nativeSessionId: info.nativeSessionId,
      observedModel: info.observedModel,
      observedReasoning: info.observedReasoning,
      processRef: info.processRef,
      processHealth: info.pid ? 'alive' : row.processHealth,
      lastEventAt: nowIso(),
    });
    if (connChanged) {
      this.emit('runtime.connection_changed', {
        taskId: live.taskId,
        sessionId: live.sessionRowId,
        attemptId: live.attemptId,
        payload: { connectionState: info.connectionState, detail: info.detail },
      });
    }
    if (info.observedModel && info.observedModel !== row.observedModel) {
      this.emit('session.configuration_observed', {
        taskId: live.taskId,
        sessionId: live.sessionRowId,
        attemptId: live.attemptId,
        payload: {
          observedModel: info.observedModel,
          observedReasoning: info.observedReasoning,
          requestedModel: row.observedModel,
        },
      });
    }
    if (activityChanged) {
      this.emit('monitor.health_changed', {
        taskId: live.taskId,
        sessionId: live.sessionRowId,
        attemptId: live.attemptId,
        payload: { activity: info.activity, detail: info.detail },
      });
    }
  }

  onExit(localId: string, info: { code: number | null; expected: boolean }): void {
    const live = this.live.get(localId);
    if (!live) return;
    this.repo.updateSession(live.sessionRowId, {
      connectionState: 'disconnected',
      processHealth: 'exited',
      activity: 'unknown',
      closedAt: nowIso(),
    });
    this.emit('runtime.exited', {
      taskId: live.taskId,
      sessionId: live.sessionRowId,
      attemptId: live.attemptId,
      payload: { code: info.code, expected: info.expected },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 规划阶段                                                            */
  /* ------------------------------------------------------------------ */

  async requestPlan(taskId: string, reason: 'initial' | 'replan' | 'supplement', note?: string): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    if (['completed', 'cancelled', 'cancelling'].includes(task.lifecycle)) {
      throw new EngineError('invalid_state', `任务处于 ${task.lifecycle}, 不能重新规划`);
    }
    if (task.approvedPlanRevisionId && reason === 'initial') {
      throw new EngineError('plan_already_approved', '任务已有批准的计划');
    }
    if (note) {
      this.repo.insertMessage({
        id: newId('msg'),
        taskId,
        role: 'user',
        participantId: null,
        sessionId: null,
        attemptId: null,
        text: note,
        kind: reason === 'supplement' ? 'supplement' : 'plan_note',
        createdAt: nowIso(),
        incomplete: false,
      });
    }
    const updated = this.touchTask(taskId, { phase: 'planning', lifecycle: 'active', errorCode: null, errorMessage: null });
    void this.runStage(taskId, 'planning', () => this.planningStage(updated.id, reason, note));
    return updated;
  }

  private async planningStage(taskId: string, reason: 'initial' | 'replan' | 'supplement', note?: string): Promise<void> {
    const task = this.requireTask(taskId);
    const participants = this.participantsOf(taskId);
    const strong = participants.filter((p) => p.role === 'strong');
    const lead = this.leadOf(taskId);
    let extra: Record<string, unknown> = {};
    if (strong.length >= 2 && reason === 'initial') {
      this.touchTask(taskId, { phase: 'discussion' });
      extra = await this.discussionStage(task, strong, lead);
    }
    if (note) extra = { ...extra, userNote: note };

    const env = this.promptEnv(task);
    const kind = extra.discussionSummary ? 'plan.synthesize' : 'plan';
    let attemptNo = 0;
    let lastErrors: string[] = [];
    while (attemptNo < 2) {
      attemptNo += 1;
      const prompt = buildPlanPrompt(env, kind as 'plan' | 'plan.synthesize', {
        ...extra,
        previousErrors: lastErrors,
      });
      const { outcome } = await this.runTurn(task, lead, 'planning', kind as TurnKind, prompt, {
        purpose: 'plan',
        expectsJson: true,
      });
      if (outcome.status !== 'completed') {
        if (attemptNo >= 2) {
          this.failTask(taskId, 'plan_failed', outcome.errorMessage ?? '规划回合失败');
          return;
        }
        lastErrors = [outcome.errorMessage ?? '回合失败'];
        continue;
      }
      const parsed = extractJson(outcome.text);
      const result = validatePlan(parsed, {
        task,
        participants,
        limits: task.limits,
        workspaceRoot: this.workspaceDir(taskId),
        outputDir: 'deliverables',
      });
      if (!result.ok || !result.plan) {
        lastErrors = result.errors;
        if (attemptNo >= 2) {
          this.failTask(taskId, 'invalid_plan', `计划校验失败: ${result.errors.slice(0, 5).join('; ')}`);
          return;
        }
        continue;
      }
      const content = note ? { ...result.plan, revisionNote: note } : result.plan;
      this.persistPlan(
        task,
        content,
        note ? sha256Stable(content) : (result.contentHash ?? sha256Stable(content)),
        lead,
        kind === 'plan.synthesize' ? `${lead.displayName} 综合` : lead.displayName,
      );
      return;
    }
  }

  private async discussionStage(
    task: TaskRecord,
    strong: Participant[],
    lead: Participant,
  ): Promise<Record<string, unknown>> {
    const env = this.promptEnv(task);
    const proposals: { participantId: string; name: string; text: string }[] = [];
    const results = await Promise.all(
      strong.map(async (p) => {
        const prompt = buildDiscussionProposalPrompt(env, p);
        const { outcome } = await this.runTurn(task, p, 'discussion', 'discussion.proposal', prompt, {
          purpose: 'discussion.proposal',
        });
        return { p, outcome };
      }),
    );
    for (const { p, outcome } of results) {
      const text = outcome.status === 'completed' ? outcome.text : `(方案生成失败: ${outcome.errorMessage ?? outcome.errorClass})`;
      proposals.push({ participantId: p.id, name: p.displayName, text });
      this.repo.insertMessage({
        id: newId('msg'),
        taskId: task.id,
        role: p.isLead ? 'lead' : 'participant',
        participantId: p.id,
        sessionId: null,
        attemptId: null,
        text: truncate(text, 12000),
        kind: 'discussion.proposal',
        createdAt: nowIso(),
        incomplete: outcome.status !== 'completed',
      });
    }
    const critiques: { participantId: string; name: string; text: string }[] = [];
    const critiqueResults = await Promise.all(
      strong.map(async (p) => {
        const prompt = buildDiscussionCritiquePrompt(env, p, proposals);
        const { outcome } = await this.runTurn(task, p, 'discussion', 'discussion.critique', prompt, {
          purpose: 'discussion.critique',
        });
        return { p, outcome };
      }),
    );
    for (const { p, outcome } of critiqueResults) {
      const text = outcome.status === 'completed' ? outcome.text : `(质询失败: ${outcome.errorMessage ?? outcome.errorClass})`;
      critiques.push({ participantId: p.id, name: p.displayName, text });
      this.repo.insertMessage({
        id: newId('msg'),
        taskId: task.id,
        role: p.isLead ? 'lead' : 'participant',
        participantId: p.id,
        sessionId: null,
        attemptId: null,
        text: truncate(text, 12000),
        kind: 'discussion.critique',
        createdAt: nowIso(),
        incomplete: outcome.status !== 'completed',
      });
    }
    const summary = `${strong.length} 个强模型完成 1 轮独立提案与 1 轮相互质询, 由主控综合。`;
    this.emit('plan.revised', {
      taskId: task.id,
      payload: { stage: 'discussion', proposalCount: proposals.length, critiqueCount: critiques.length, summary },
    });
    return {
      discussionSummary: summary,
      proposals: proposals.map((p) => ({ participantId: p.participantId, name: p.name, text: truncate(p.text, 4000) })),
      critiques: critiques.map((c) => ({ participantId: c.participantId, name: c.name, text: truncate(c.text, 4000) })),
    };
  }

  private persistPlan(
    task: TaskRecord,
    plan: PlanContent,
    contentHash: string,
    lead: Participant,
    createdBy: string,
  ): PlanRevision {
    const number = this.repo.nextPlanNumber(task.id);
    const revision: PlanRevision = {
      id: newId('plan'),
      taskId: task.id,
      number,
      content: plan,
      createdBy,
      contentHash,
      status: 'proposed',
      summary: `${plan.workItems.length} 个工作项; 交付物: ${plan.deliverables
        .map((d) => `${d.label}(${d.format})`)
        .join(', ') || '未指定'}`,
      createdAt: nowIso(),
    };
    this.repo.db.tx(() => {
      const prev = this.repo.listPlans(task.id).filter((p) => p.status === 'proposed');
      for (const p of prev) this.repo.setPlanStatus(p.id, 'superseded');
      this.repo.insertPlan(revision);
      this.repo.setCurrentPlan(task.id, revision.id);
      this.touchTask(
        task.id,
        {
          phase: 'planning',
          lifecycle: 'awaiting_plan_approval',
          currentPlanRevisionId: revision.id,
          version: task.version,
        },
        null,
      );
    });
    this.emit('plan.proposed', {
      taskId: task.id,
      planRevisionId: revision.id,
      payload: {
        number,
        contentHash,
        summary: revision.summary,
        workItemCount: plan.workItems.length,
        clarificationNeeded: plan.clarificationNeeded,
        unresolvedDecisions: plan.unresolvedDecisions,
      },
    });
    this.repo.insertMessage({
      id: newId('msg'),
      taskId: task.id,
      role: 'lead',
      participantId: lead.id,
      sessionId: null,
      attemptId: null,
      text: `计划 v${number} 已生成, 等待确认。${revision.summary}`,
      kind: 'plan.proposed',
      createdAt: nowIso(),
      incomplete: false,
    });
    return revision;
  }

  /* ------------------------------------------------------------------ */
  /* 计划决策                                                            */
  /* ------------------------------------------------------------------ */

  async decidePlan(
    taskId: string,
    input: {
      decision: 'approve' | 'supplement' | 'replan';
      planRevisionId: string;
      planHash: string;
      participantsRevision: number;
      expectedTaskVersion: number;
      userNote?: string;
    },
  ): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    const plan = this.repo.getPlan(input.planRevisionId);
    if (!plan || plan.taskId !== taskId) throw new EngineError('plan_not_found', '计划版本不存在', 404);
    // 幂等与状态门禁: 已批准/已作废的计划不能再决策一次, 否则会重复创建工作项与重复派发
    if (plan.status === 'approved') {
      throw new EngineError('plan_already_approved', '该计划版本已批准, 不会重复执行', 409);
    }
    if (plan.status !== 'proposed') {
      throw new EngineError('stale_plan', '该计划版本已失效, 请基于最新计划决策', 409);
    }
    if (task.currentPlanRevisionId !== plan.id) {
      throw new EngineError('stale_plan', '该计划已不是当前版本, 请基于最新计划决策', 409);
    }
    if (plan.contentHash !== input.planHash) {
      throw new EngineError('plan_hash_mismatch', '计划内容与批准时的哈希不一致', 409);
    }
    if (task.participantsRevision !== input.participantsRevision) {
      throw new EngineError('participants_changed', '参与者已变化, 请重新确认计划', 409);
    }
    if (task.version !== input.expectedTaskVersion) {
      throw new EngineError('task_version_conflict', '任务版本已变化, 请刷新后重试', 409);
    }

    this.repo.insertPlanApproval({
      id: newId('pap'),
      taskId,
      planRevisionId: plan.id,
      planHash: plan.contentHash,
      participantsRevision: task.participantsRevision,
      decision: input.decision,
      userNote: input.userNote ?? null,
      createdAt: nowIso(),
    });

    if (input.decision !== 'approve') {
      this.repo.setPlanStatus(plan.id, 'rejected');
      this.emit('plan.rejected', {
        taskId,
        planRevisionId: plan.id,
        payload: { decision: input.decision, note: input.userNote ?? null },
      });
      const updated = this.touchTask(taskId, { lifecycle: 'active', phase: 'planning' });
      void this.runStage(taskId, 'planning', () =>
        this.planningStage(taskId, input.decision === 'replan' ? 'replan' : 'supplement', input.userNote),
      );
      return updated;
    }

    this.repo.db.tx(() => {
      this.repo.setPlanStatus(plan.id, 'approved');
      const latest = this.repo.getTask(taskId)!;
      this.touchTask(
        taskId,
        {
          approvedPlanRevisionId: plan.id,
          currentPlanRevisionId: plan.id,
          phase: 'execution',
          lifecycle: 'active',
          completedAt: null,
        },
        latest.version,
      );
      this.createWorkItems(taskId, plan);
    });
    this.emit('plan.approved', {
      taskId,
      planRevisionId: plan.id,
      payload: { planHash: plan.contentHash, approvedAt: nowIso(), decision: 'approve' },
    });
    void this.pump(taskId);
    return this.requireTask(taskId);
  }

  private createWorkItems(taskId: string, plan: PlanRevision): void {
    for (const item of plan.content.workItems) {
      const now = nowIso();
      const wi: WorkItem = {
        id: newId('wi'),
        taskId,
        planRevisionId: plan.id,
        planItemId: item.id,
        goal: item.goal,
        dependencyIds: [],
        assignedParticipantId: item.assignedParticipantId,
        allowedProfileIds: [],
        inputRefs: item.inputs,
        outputSpecs: item.expectedOutputs,
        acceptanceCriteria: item.acceptanceCriteria,
        writeScope: item.writeScope,
        state: 'pending',
        repairRound: 0,
        attemptCount: 0,
        result: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      const idByPlanId = new Map<string, string>();
      for (const existing of this.repo.listWorkItems(taskId)) idByPlanId.set(existing.planItemId, existing.id);
      wi.dependencyIds = item.dependencies
        .map((d) => idByPlanId.get(d))
        .filter((v): v is string => typeof v === 'string');
      this.repo.insertWorkItem(wi);
      this.emit('work_item.updated', { taskId, planRevisionId: plan.id, payload: { workItemId: wi.id, state: 'pending' } });
    }
    // 依赖中指向尚未创建的计划项时, 补一次映射
    const items = this.repo.listWorkItems(taskId).filter((w) => w.planRevisionId === plan.id);
    const byPlanId = new Map(items.map((w) => [w.planItemId, w.id]));
    for (const w of items) {
      const planItem = plan.content.workItems.find((p) => p.id === w.planItemId);
      if (!planItem) continue;
      const deps = planItem.dependencies.map((d) => byPlanId.get(d)).filter((v): v is string => typeof v === 'string');
      if (deps.length !== w.dependencyIds.length) {
        this.repo.updateWorkItem(w.id, { dependencyIds: deps });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 执行调度                                                            */
  /* ------------------------------------------------------------------ */

  private async pump(taskId: string): Promise<void> {
    if (this.stopped || this.pumping.has(taskId)) return;
    this.pumping.add(taskId);
    try {
      for (;;) {
        if (this.stopped) return;
        const task = this.repo.getTask(taskId);
        if (!task) return;
        if (task.lifecycle !== 'active' || task.phase !== 'execution') return;
        if (!task.approvedPlanRevisionId) return;
        const items = this.repo.listWorkItems(taskId).filter((w) => w.planRevisionId === task.approvedPlanRevisionId);
        if (items.length === 0) return;
        const active = items.filter((w) => ['queued', 'running', 'verifying'].includes(w.state));
        if (allTerminal(items)) {
          await this.afterExecution(taskId);
          return;
        }
        // 所有工作项都已产出待审/终态, 且没有在跑的尝试 -> 进入审核阶段
        if (executionSettled(items) && (this.workerPromises.get(taskId)?.size ?? 0) === 0) {
          await this.afterExecution(taskId);
          return;
        }
        const toDispatch = (w: WorkItem): DispatchItem => ({
          id: w.id,
          state: w.state,
          dependencies: w.dependencyIds,
          writeScope: w.writeScope,
          participantId: w.assignedParticipantId ?? '',
          profileId: this.participantProfileId(w.assignedParticipantId),
          riskLevel: 'medium',
        });
        const dispatchItems: DispatchItem[] = items.map(toDispatch);
        const decision = selectDispatchable({
          items: dispatchItems,
          active: active.map((w) => ({
            itemId: w.id,
            profileId: this.participantProfileId(w.assignedParticipantId),
            writeScope: w.writeScope,
          })),
          limits: task.limits,
        });
        if (decision.start.length > 0) {
          for (const startId of decision.start) {
            const item = items.find((w) => w.id === startId);
            if (!item) continue;
            this.repo.updateWorkItem(item.id, { state: 'queued', updatedAt: nowIso() });
            this.emit('work_item.queued', { taskId, payload: { workItemId: item.id, state: 'queued' } });
            const p = this.runWorkAttempt(taskId, item.id).finally(() => {
              this.workerPromises.get(taskId)?.delete(p);
            });
            let set = this.workerPromises.get(taskId);
            if (!set) {
              set = new Set();
              this.workerPromises.set(taskId, set);
            }
            set.add(p);
          }
          continue;
        }
        const running = Array.from(this.workerPromises.get(taskId) ?? []);
        if (running.length === 0) {
          if (decision.deadlocked.length > 0) {
            this.blockTask(taskId, 'deadlock', `依赖无法满足: ${decision.deadlocked.join(', ')}`);
          } else if (decision.waiting.length > 0) {
            this.blockTask(taskId, 'blocked_dependencies', decision.waiting.map((w) => `${w.id}: ${w.reason}`).join('; '));
          }
          return;
        }
        await Promise.race(running.map((p) => p.catch(() => undefined)));
      }
    } finally {
      this.pumping.delete(taskId);
      const remaining = this.workerPromises.get(taskId);
      if (remaining && remaining.size > 0) {
        void this.pump(taskId);
      }
    }
  }

  private participantProfileId(participantId: string | null): string {
    if (!participantId) return 'unassigned';
    const p = this.repo.getParticipant(participantId);
    return p?.profileId ?? 'unassigned';
  }

  private async runWorkAttempt(taskId: string, workItemId: string): Promise<void> {
    const task = this.requireTask(taskId);
    const item = this.repo.getWorkItem(workItemId);
    if (!item) return;
    if (item.state !== 'queued') return;
    this.repo.updateWorkItem(item.id, { state: 'running', updatedAt: nowIso() });
    this.emit('work_item.updated', { taskId, payload: { workItemId: item.id, state: 'running' } });

    let participant = item.assignedParticipantId ? this.repo.getParticipant(item.assignedParticipantId) : null;
    if (!participant || participant.taskId !== taskId) participant = this.leadOf(taskId);
    const env = this.promptEnv(task);
    const planItem = {
      id: item.planItemId,
      goal: item.goal,
      dependencies: item.dependencyIds,
      assignedParticipantId: item.assignedParticipantId,
      inputs: item.inputRefs,
      expectedOutputs: item.outputSpecs,
      acceptanceCriteria: item.acceptanceCriteria,
      writeScope: item.writeScope,
      riskLevel: 'medium' as const,
    };
    const prompt = buildWorkPrompt(env, planItem, {
      repairRound: item.repairRound,
      lastError: item.lastError,
      priorResult: item.result,
      previousArtifacts: this.repo
        .listArtifacts(taskId)
        .filter((a) => a.workItemId !== item.id && a.status === 'registered')
        .map((a) => a.relativePath),
    });
    const { outcome } = await this.runTurn(task, participant, 'execution', 'work', prompt, {
      workItemId: item.id,
      purpose: `work:${item.planItemId}`,
      expectsJson: true,
    });
    this.repo.updateWorkItem(item.id, { attemptCount: item.attemptCount + 1 });

    if (outcome.status !== 'completed') {
      await this.handleAttemptFailure(task, this.repo.getWorkItem(item.id)!, outcome);
      return;
    }
    const parsed = extractJson(outcome.text) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      await this.handleAttemptFailure(task, this.repo.getWorkItem(item.id)!, {
        ...outcome,
        status: 'failed',
        errorClass: 'invalid_result',
        errorMessage: '工作项结果不是可解析的 JSON',
      });
      return;
    }
    const result: WorkItemResult = {
      workItemId: String(parsed.workItemId ?? item.planItemId),
      attemptId: String(parsed.attemptId ?? ''),
      status: (parsed.status as WorkItemResult['status']) ?? 'failed',
      summary: String(parsed.summary ?? ''),
      artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs.map(String) : [],
      changes: Array.isArray(parsed.changes) ? parsed.changes.map(String) : [],
      verificationClaims: Array.isArray(parsed.verificationClaims)
        ? (parsed.verificationClaims as WorkItemResult['verificationClaims'])
        : [],
      unresolvedIssues: Array.isArray(parsed.unresolvedIssues) ? parsed.unresolvedIssues.map(String) : [],
      suggestedNextAction: parsed.suggestedNextAction ? String(parsed.suggestedNextAction) : undefined,
    };
    this.repo.updateWorkItem(item.id, { result });
    this.emit('work_item.result', { taskId, payload: { workItemId: item.id, result } });

    if (result.status === 'needs_input' || result.status === 'blocked') {
      this.repo.updateWorkItem(item.id, { state: 'waiting_input', lastError: result.unresolvedIssues.join('; ') || null });
      this.touchTask(taskId, { lifecycle: 'waiting_user', phase: 'execution' });
      this.emit('error.reported', {
        taskId,
        payload: { code: 'needs_input', message: result.unresolvedIssues.join('; ') || result.summary },
      });
      return;
    }
    if (result.status === 'failed') {
      await this.handleAttemptFailure(task, this.repo.getWorkItem(item.id)!, {
        ...outcome,
        status: 'failed',
        errorClass: 'worker_reported_failure',
        errorMessage: result.summary || '工作项报告失败',
      });
      return;
    }

    // 登记产物并验证
    const paths = unique([
      ...result.artifactRefs,
      ...item.outputSpecs.map((s) => s.relativePath),
    ]);
    this.registerArtifacts(task, item, this.latestAttemptId(item.id), result.summary, paths);
    await this.verifyWorkItem(task, this.repo.getWorkItem(item.id)!);
  }

  private latestAttemptId(workItemId: string): string | null {
    const attempts = this.repo
      .listAttempts(this.repo.getWorkItem(workItemId)?.taskId ?? '')
      .filter((a) => a.workItemId === workItemId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return attempts[0]?.id ?? null;
  }

  private async handleAttemptFailure(task: TaskRecord, item: WorkItem, outcome: TurnOutcome): Promise<void> {
    const errorClass = outcome.errorClass ?? 'turn_failed';
    const infra = ['process_exited', 'turn_timeout', 'session_open_failed', 'prompt_failed', 'sdk_error', 'turn_start_failed', 'session_error'].includes(
      errorClass,
    );
    const failedAttempts = this.repo
      .listAttempts(task.id)
      .filter((a) => a.workItemId === item.id && a.status === 'failed').length;
    if (infra && failedAttempts <= task.limits.infraRetries) {
      this.repo.updateWorkItem(item.id, { state: 'pending', lastError: `基础设施错误, 重试: ${errorClass}` });
      this.emit('attempt.retry_wait', {
        taskId: task.id,
        payload: { workItemId: item.id, errorClass, retryCount: failedAttempts },
      });
      return;
    }
    if (item.repairRound < task.limits.maxRepairRounds) {
      this.repo.updateWorkItem(item.id, {
        state: 'pending',
        repairRound: item.repairRound + 1,
        lastError: `${errorClass}: ${trim(outcome.errorMessage ?? '')}`.slice(0, 500),
      });
      this.emit('work_item.updated', {
        taskId: task.id,
        payload: { workItemId: item.id, state: 'pending', repairRound: item.repairRound + 1 },
      });
      return;
    }
    this.repo.updateWorkItem(item.id, {
      state: 'failed',
      lastError: `${errorClass}: ${trim(outcome.errorMessage ?? '')}`.slice(0, 500),
    });
    this.emit('work_item.updated', { taskId: task.id, payload: { workItemId: item.id, state: 'failed' } });
    this.touchTask(task.id, {
      lifecycle: 'blocked',
      errorCode: 'work_item_failed',
      errorMessage: `工作项 ${item.goal.slice(0, 60)} 失败: ${outcome.errorClass ?? ''}`,
    });
  }

  private registerArtifacts(
    task: TaskRecord,
    item: WorkItem | null,
    attemptId: string | null,
    producer: string,
    relativePaths: string[],
  ): ArtifactRevision[] {
    const workspace = this.workspaceDir(task.id);
    const out: ArtifactRevision[] = [];
    for (const rawRel of relativePaths) {
      if (!rawRel || rawRel.trim().length === 0) continue;
      // 统一成 POSIX 分隔符, 避免 Windows 下同一文件被登记两次
      const rel = normalizeRelPath(rawRel);
      let abs: string;
      try {
        abs = safeJoin(workspace, rel);
      } catch {
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const size = statSync(abs).size;
      if (size === 0) continue;
      const sha = sha256FileSync(abs);
      const artifact: ArtifactRevision = {
        id: newId('art'),
        taskId: task.id,
        workItemId: item?.id ?? null,
        attemptId,
        relativePath: rel,
        mediaType: mediaTypeForPath(rel),
        size,
        sha256: sha,
        producer,
        status: 'registered',
        registeredAt: nowIso(),
        note: null,
      };
      const saved = this.repo.insertArtifact(artifact);
      // 同名产物只让最新一版留在 registered 状态, 否则"当前产物集合"会同时包含旧版本
      if (saved.status === 'registered') {
        this.repo.supersedeArtifactRevisions(task.id, saved.relativePath, saved.id);
      }
      this.emit('artifact.registered', {
        taskId: task.id,
        payload: {
          artifactId: saved.id,
          workItemId: item?.id ?? null,
          relativePath: saved.relativePath,
          sha256: saved.sha256,
          size: saved.size,
          mediaType: saved.mediaType,
        },
      });
      out.push(saved);
    }
    return out;
  }

  private async verifyWorkItem(task: TaskRecord, item: WorkItem): Promise<void> {
    this.repo.updateWorkItem(item.id, { state: 'verifying', updatedAt: nowIso() });
    const workspace = this.workspaceDir(task.id);
    const artifacts = this.repo.listArtifacts(task.id).filter((a) => a.workItemId === item.id && a.status === 'registered');
    const setHash = sha256Stable(artifacts.map((a) => `${a.relativePath}:${a.sha256}`).sort());
    let allPassed = true;
    const results: VerificationResult[] = [];
    for (const spec of item.outputSpecs) {
      let abs: string;
      try {
        abs = safeJoin(workspace, spec.relativePath);
      } catch {
        allPassed = false;
        results.push(
          this.recordVerification(task, item, setHash, `path:${spec.relativePath}`, 'path_safety', 'failed', '', null, '路径越界'),
        );
        continue;
      }
      const exists = existsSync(abs) && statSync(abs).isFile();
      if (spec.validation !== 'none') {
        const passed = exists && (!spec.validation || spec.validation === 'exists' || statSync(abs).size > 0);
        if (!passed) allPassed = false;
        results.push(
          this.recordVerification(
            task,
            item,
            setHash,
            `exists:${spec.relativePath}`,
            'file_exists',
            passed ? 'passed' : 'failed',
            '',
            null,
            passed ? `${spec.relativePath} 存在` : `${spec.relativePath} 缺失或为空`,
          ),
        );
      }
      if (spec.validationCommand && abs && exists) {
        const cmd = await this.runValidationCommand(workspace, spec.validationCommand);
        if (cmd.exitCode !== 0) allPassed = false;
        results.push(
          this.recordVerification(
            task,
            item,
            setHash,
            `cmd:${spec.relativePath}`,
            spec.validationCommand,
            cmd.exitCode === 0 ? 'passed' : 'failed',
            '',
            cmd.exitCode,
            trim(cmd.output).slice(0, 1000),
          ),
        );
      }
    }
    for (const r of results) {
      this.emit('verification.recorded', {
        taskId: task.id,
        payload: { verificationId: r.id, workItemId: item.id, checkId: r.checkId, status: r.status, detail: r.detail },
      });
    }
    if (allPassed && artifacts.length > 0) {
      this.repo.updateWorkItem(item.id, { state: 'awaiting_review', updatedAt: nowIso() });
      this.emit('work_item.updated', { taskId: task.id, payload: { workItemId: item.id, state: 'awaiting_review' } });
    } else {
      const detail = allPassed ? '没有登记到产物' : '验证未通过';
      if (item.repairRound < task.limits.maxRepairRounds) {
        this.repo.updateWorkItem(item.id, {
          state: 'pending',
          repairRound: item.repairRound + 1,
          lastError: detail,
          updatedAt: nowIso(),
        });
      } else {
        this.repo.updateWorkItem(item.id, { state: 'failed', lastError: detail, updatedAt: nowIso() });
        this.touchTask(task.id, { lifecycle: 'blocked', errorCode: 'verification_failed', errorMessage: detail });
      }
    }
  }

  private recordVerification(
    task: TaskRecord,
    item: WorkItem | null,
    setHash: string,
    checkId: string,
    method: string,
    status: VerificationResult['status'],
    evidence: string,
    exitCode: number | null,
    detail: string,
  ): VerificationResult {
    const v: VerificationResult = {
      id: newId('ver'),
      taskId: task.id,
      workItemId: item?.id ?? null,
      artifactSetHash: setHash,
      checkId,
      method,
      status,
      evidenceRefs: evidence ? [evidence] : [],
      exitCode,
      detail,
      checkedAt: nowIso(),
    };
    this.ensureVerificationTable(v);
    return v;
  }

  private ensureVerificationTable(v: VerificationResult): void {
    this.repo.insertVerification(v);
    // 表列名与契约字段对齐, 由 repo 负责映射
  }

  private runValidationCommand(cwd: string, command: string): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
      const child = spawn(shell, args, {
        cwd,
        windowsHide: true,
        env: { ...this.taskSessionEnv(path.basename(path.dirname(cwd))) },
      });
      let output = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 120_000);
      child.stdout?.on('data', (b: Buffer) => {
        output += b.toString('utf8');
      });
      child.stderr?.on('data', (b: Buffer) => {
        output += b.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, output: `${output}\n${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, output });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 执行后: 审核 / 集成 / 交付                                          */
  /* ------------------------------------------------------------------ */

  private async afterExecution(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (task.lifecycle !== 'active') return;
    const items = this.repo.listWorkItems(taskId);
    if (items.some((w) => w.state === 'failed')) return;
    await this.runStage(taskId, 'review', () => this.reviewStage(taskId));
  }

  private async reviewStage(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    const participants = this.participantsOf(taskId);
    const strong = participants.filter((p) => p.role === 'strong');
    const lead = this.leadOf(taskId);
    const plan = task.approvedPlanRevisionId ? this.repo.getPlan(task.approvedPlanRevisionId) : null;
    if (!plan) return;
    this.touchTask(taskId, { phase: 'review' });

    const artifacts = this.repo.listArtifacts(taskId).filter((a) => a.status === 'registered');
    if (artifacts.length === 0) {
      this.blockTask(taskId, 'no_artifacts', '执行完成但没有登记到任何产物');
      return;
    }
    const setHash = sha256Stable(artifacts.map((a) => `${a.relativePath}:${a.sha256}`).sort());
    const verifications = this.repo.listVerifications(taskId);
    const roundNumber = this.repo.nextReviewNumber(taskId);
    const roundId = newId('rnd');
    this.repo.insertReviewRound({
      id: roundId,
      taskId,
      number: roundNumber,
      artifactSetHash: setHash,
      status: 'running',
      createdAt: nowIso(),
      completedAt: null,
    });
    const env = this.promptEnv(task);
    const results: ReviewResult[] = [];

    const first = await Promise.all(
      strong.map(async (p) => {
        const prompt = buildReviewPrompt(env, p, {
          plan: plan.content,
          artifacts,
          verifications,
          round: roundNumber,
          others: [],
          mode: 'initial',
        });
        const { outcome } = await this.runTurn(task, p, 'review', 'review', prompt, { purpose: 'review' });
        return { p, outcome };
      }),
    );
    for (const { p, outcome } of first) {
      const parsed = outcome.status === 'completed' ? (extractJson(outcome.text) as Record<string, unknown> | null) : null;
      const verdict = (parsed?.verdict as ReviewVerdict) ?? 'unable_to_review';
      results.push(
        this.insertReviewResult(task, roundId, p, setHash, verdict, parsed, outcome.errorMessage ?? null),
      );
    }

    if (strong.length >= 2) {
      const othersSummary = results.map((r) => ({
        participantId: r.participantId,
        name: this.participantName(r.participantId),
        verdict: r.verdict,
        summary: r.summary,
        findings: r.findings,
      }));
      const cross = await Promise.all(
        strong.map(async (p) => {
          const own = results.find((r) => r.participantId === p.id);
          const prompt = buildReviewPrompt(env, p, {
            plan: plan.content,
            artifacts,
            verifications,
            round: roundNumber,
            others: othersSummary.filter((o) => o.participantId !== p.id),
            mode: 'crosscheck',
          });
          const { outcome } = await this.runTurn(task, p, 'review', 'review.crosscheck', prompt, {
            purpose: 'review.crosscheck',
          });
          return { p, own, outcome };
        }),
      );
      for (const { p, own, outcome } of cross) {
        if (!own) continue;
        if (outcome.status !== 'completed') continue;
        const parsed = extractJson(outcome.text) as Record<string, unknown> | null;
        if (!parsed) continue;
        const verdict = (parsed.verdict as ReviewVerdict) ?? own.verdict;
        const findings = this.parseFindings(parsed);
        const crossChecked = Array.isArray(parsed.crossChecked)
          ? (parsed.crossChecked as { findingId: string; stance: string; note: string }[])
          : [];
        this.repo.db.run('DELETE FROM review_results WHERE round_id = ? AND participant_id = ?', roundId, p.id);
        const updated = this.insertReviewResult(task, roundId, p, setHash, verdict, parsed, null, crossChecked);
        const idx = results.findIndex((r) => r.participantId === p.id);
        if (idx >= 0) results[idx] = updated;
        void findings;
      }
    }

    const anyUnable = results.some((r) => r.verdict === 'unable_to_review');
    const anyNeedsUser = results.some((r) => r.verdict === 'needs_user_decision');
    const anyChanges = results.some((r) => r.verdict === 'changes_required');
    const allApprove = results.every((r) => r.verdict === 'approve');

    this.repo.updateReviewRound(roundId, {
      status: 'completed',
      completedAt: nowIso(),
    });
    this.emit('review.recorded', {
      taskId,
      payload: {
        round: roundNumber,
        roundId,
        artifactSetHash: setHash,
        verdicts: results.map((r) => ({ participantId: r.participantId, verdict: r.verdict })),
      },
    });
    this.repo.insertMessage({
      id: newId('msg'),
      taskId,
      role: 'lead',
      participantId: lead.id,
      sessionId: null,
      attemptId: null,
      text: `审核第 ${roundNumber} 轮结果: ${results.map((r) => `${this.participantName(r.participantId)}:${r.verdict}`).join(', ')}`,
      kind: 'review.summary',
      createdAt: nowIso(),
      incomplete: false,
    });

    if (allApprove && !anyUnable) {
      for (const w of this.repo.listWorkItems(taskId).filter((w) => w.state === 'awaiting_review')) {
        this.repo.updateWorkItem(w.id, { state: 'accepted', updatedAt: nowIso() });
        this.emit('work_item.updated', { taskId, payload: { workItemId: w.id, state: 'accepted' } });
      }
      await this.integrationStage(taskId);
      return;
    }
    if (anyNeedsUser) {
      this.touchTask(taskId, { lifecycle: 'waiting_user', phase: 'review' });
      return;
    }
    if (anyUnable) {
      this.touchTask(taskId, {
        lifecycle: 'blocked',
        errorCode: 'review_unavailable',
        errorMessage: '有强模型无法完成审核',
      });
      return;
    }
    // changes_required
    const maxRound = Math.max(...this.repo.listReviewRounds(taskId).map((r) => r.number));
    const repairRounds = this.repo.listWorkItems(taskId).reduce((m, w) => Math.max(m, w.repairRound), 0);
    if (anyChanges && repairRounds < task.limits.maxRepairRounds) {
      const blocking = results.flatMap((r) => r.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major'));
      for (const w of this.repo.listWorkItems(taskId).filter((w) => w.state === 'awaiting_review')) {
        const relevant = blocking.slice(0, 3).map((f) => `${f.title}: ${f.detail}`).join('; ');
        this.repo.updateWorkItem(w.id, {
          state: 'pending',
          repairRound: w.repairRound + 1,
          lastError: `审核第 ${maxRound} 轮要求修改: ${relevant}`.slice(0, 1000),
          updatedAt: nowIso(),
        });
      }
      this.touchTask(taskId, { phase: 'execution', lifecycle: 'active' });
      void this.pump(taskId);
      return;
    }
    this.blockTask(taskId, 'review_changes_required', '审核要求修改且已达修复轮数上限');
  }

  private insertReviewResult(
    task: TaskRecord,
    roundId: string,
    p: Participant,
    setHash: string,
    verdict: ReviewVerdict,
    parsed: Record<string, unknown> | null,
    error: string | null,
    crossChecked: { findingId: string; stance: string; note: string }[] = [],
  ): ReviewResult {
    const result: ReviewResult = {
      id: newId('rev'),
      taskId: task.id,
      roundId,
      participantId: p.id,
      artifactSetHash: setHash,
      verdict,
      findings: parsed ? this.parseFindings(parsed) : [],
      summary: parsed ? String(parsed.summary ?? '') : (error ?? '审核未能完成'),
      crossChecked,
      evidenceRefs: parsed && Array.isArray(parsed.evidenceRefs) ? (parsed.evidenceRefs as string[]).map(String) : [],
      completedAt: nowIso(),
    };
    this.repo.insertReviewResult(result);
    return result;
  }

  private parseFindings(parsed: Record<string, unknown>): ReviewFinding[] {
    const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
    return raw.map((f, i) => {
      const o = (f ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? `f${i + 1}`),
        severity: (['blocker', 'major', 'minor', 'info'].includes(String(o.severity))
          ? String(o.severity)
          : 'minor') as ReviewFinding['severity'],
        title: String(o.title ?? '问题'),
        detail: String(o.detail ?? ''),
        evidenceRef: o.evidenceRef ? String(o.evidenceRef) : undefined,
        suggestedFix: o.suggestedFix ? String(o.suggestedFix) : undefined,
      };
    });
  }

  private participantName(participantId: string): string {
    return this.repo.getParticipant(participantId)?.displayName ?? participantId.slice(0, 8);
  }

  private async integrationStage(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    this.touchTask(taskId, { phase: 'integration' });
    const plan = task.approvedPlanRevisionId ? this.repo.getPlan(task.approvedPlanRevisionId) : null;
    const artifacts = this.repo.listArtifacts(taskId).filter((a) => a.status === 'registered');
    const lead = this.leadOf(taskId);
    const env = this.promptEnv(task);
    if (plan) {
      const outcomes = this.repo
        .listWorkItems(taskId)
        .map((w) => ({ goal: w.goal, summary: w.result?.summary ?? '', status: w.state }));
      const prompt = buildIntegrationPrompt(env, plan.content, artifacts, outcomes);
      const { outcome } = await this.runTurn(task, lead, 'integration', 'integrate', prompt, {
        purpose: 'integrate',
        expectsJson: false,
      });
      if (outcome.status !== 'completed') {
        this.emit('error.reported', {
          taskId,
          payload: { code: 'integration_failed', message: outcome.errorMessage ?? '集成回合失败' },
        });
      }
    }
    // 重新登记可能的集成产物
    const extraPaths = artifacts.map((a) => a.relativePath).filter((p) => existsSync(safeJoin(this.workspaceDir(taskId), p)));
    this.registerArtifacts(task, null, null, 'integration', extraPaths);
    await this.deliveryStage(taskId);
  }

  private async deliveryStage(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    this.touchTask(taskId, { phase: 'delivery' });
    const plan = task.approvedPlanRevisionId ? this.repo.getPlan(task.approvedPlanRevisionId) : null;
    const artifacts = this.repo.listArtifacts(taskId).filter((a) => a.status === 'registered');
    const setHash = sha256Stable(artifacts.map((a) => `${a.relativePath}:${a.sha256}`).sort());
    const lines: string[] = [];
    lines.push(`# 交付说明: ${task.title}`);
    lines.push('');
    lines.push(`任务目标: ${task.objective}`);
    lines.push(`计划版本: v${plan?.number ?? '?'} (${plan?.contentHash ?? ''})`);
    lines.push(`审核产物集: ${setHash}`);
    lines.push('');
    lines.push('## 产物');
    for (const a of artifacts) {
      lines.push(`- ${a.relativePath} (${a.mediaType}, ${a.size} bytes, sha256 ${a.sha256.slice(0, 16)}…)`);
    }
    lines.push('');
    lines.push('## 验证');
    for (const v of this.repo.listVerifications(taskId)) {
      lines.push(`- ${v.checkId}: ${v.status} ${v.detail.slice(0, 200)}`);
    }
    lines.push('');
    lines.push('## 审核');
    for (const r of this.repo.listReviewResults(taskId)) {
      lines.push(`- ${this.participantName(r.participantId)}: ${r.verdict} — ${r.summary.slice(0, 200)}`);
    }
    const workspace = this.workspaceDir(taskId);
    const deliveryPath = path.join(workspace, 'deliverables', 'DELIVERY.md');
    mkdirSync(path.dirname(deliveryPath), { recursive: true });
    writeFileSync(deliveryPath, lines.join('\n'), 'utf8');
    this.registerArtifacts(task, null, null, 'harness-hub', ['deliverables/DELIVERY.md']);

    if (plan) {
      const reviews = this.repo.listReviewResults(taskId).map((r) => ({ verdict: r.verdict, summary: r.summary }));
      const prompt = buildDeliveryPrompt(
        this.promptEnv(task),
        plan.content,
        artifacts,
        reviews,
        this.repo.listVerifications(taskId),
        null,
      );
      const lead = this.leadOf(taskId);
      const { outcome } = await this.runTurn(task, lead, 'delivery', 'deliver', prompt, {
        purpose: 'deliver',
        expectsJson: false,
      });
      if (outcome.status === 'completed' && outcome.text.trim().length > 0) {
        this.repo.insertMessage({
          id: newId('msg'),
          taskId,
          role: 'lead',
          participantId: lead.id,
          sessionId: null,
          attemptId: null,
          text: truncate(outcome.text, 20000),
          kind: 'delivery',
          createdAt: nowIso(),
          incomplete: false,
        });
      }
    }
    this.repo.insertAcceptance(taskId, setHash, 'harness-hub', '格式/可运行性限制见交付说明');
    this.emit('delivery.updated', { taskId, payload: { artifactSetHash: setHash, artifacts: artifacts.length } });
    this.touchTask(taskId, { phase: 'delivery', lifecycle: 'completed', completedAt: nowIso() });
  }

  /* ------------------------------------------------------------------ */
  /* 用户消息与控制                                                      */
  /* ------------------------------------------------------------------ */

  async sendUserMessage(taskId: string, input: { text: string; intent: string }): Promise<void> {
    const task = this.requireTask(taskId);
    this.repo.insertMessage({
      id: newId('msg'),
      taskId,
      role: 'user',
      participantId: null,
      sessionId: null,
      attemptId: null,
      text: input.text,
      kind: input.intent,
      createdAt: nowIso(),
      incomplete: false,
    });
    if (task.lifecycle === 'awaiting_plan_approval') {
      const updated = this.touchTask(taskId, { lifecycle: 'active', phase: 'planning' });
      void this.runStage(taskId, 'planning', () => this.planningStage(taskId, 'supplement', input.text));
      void updated;
      return;
    }
    // 已进入执行阶段后用户要求"补充"(通常意味着范围变化): 先停止新派发, 生成新计划版本,
    // 重新走批准门槛, 而不是在旧批准下继续改文件。
    if (
      input.intent === 'supplement' &&
      ['execution', 'integration', 'verification', 'review'].includes(task.phase) &&
      !['completed', 'cancelled', 'cancelling'].includes(task.lifecycle)
    ) {
      this.touchTask(taskId, { lifecycle: 'paused' });
      this.emit('task.control', {
        taskId,
        payload: { action: 'scope_change_requires_replan', note: input.text.slice(0, 400) },
      });
      void this.runStage(taskId, 'planning', () => this.planningStage(taskId, 'supplement', input.text));
      return;
    }
    if (task.lifecycle === 'waiting_user') {
      this.touchTask(taskId, { lifecycle: 'active' });
    }
    const liveTask = this.requireTask(taskId);
    if (['completed', 'cancelled', 'cancelling'].includes(liveTask.lifecycle)) return;
    const lead = this.leadOf(taskId);
    const env = this.promptEnv(liveTask);
    const prompt = {
      text: `### HARNESS-HUB TURN v1\nkind: chat\ntask: ${taskId}\nwork_item: -\nexpects_json: false\n\n### CONTEXT (JSON)\n${JSON.stringify(
        { task: { id: task.id, title: task.title, objective: task.objective }, workspace: env.workspaceRoot, userMessage: input.text },
        null,
        2,
      )}\n\n### INSTRUCTION\n用户发来消息, 请在当前任务范围内回应。只输出自然语言回复, 不要修改工作区文件。`,
      context: { userMessage: input.text },
    };
    void this.runStage(taskId, 'chat', async () => {
      const { outcome } = await this.runTurn(liveTask, lead, liveTask.phase, 'chat', prompt, {
        purpose: 'chat',
        expectsJson: false,
      });
      if (outcome.status === 'completed' && outcome.text.trim().length > 0) {
        // runTurn 已通过事件记录 message.completed
      }
    });
  }

  async control(taskId: string, action: 'pause_dispatch' | 'resume' | 'cancel' | 'cancel_session', sessionId?: string): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    switch (action) {
      case 'pause_dispatch': {
        if (!['active'].includes(task.lifecycle)) throw new EngineError('invalid_state', `当前状态 ${task.lifecycle} 不能暂停`);
        const t = this.touchTask(taskId, { lifecycle: 'paused' });
        this.emit('task.control', { taskId, payload: { action } });
        return t;
      }
      case 'resume': {
        if (!['paused', 'waiting_user', 'blocked'].includes(task.lifecycle)) {
          throw new EngineError('invalid_state', `当前状态 ${task.lifecycle} 不能恢复`);
        }
        const t = this.touchTask(taskId, { lifecycle: 'active', errorCode: null, errorMessage: null });
        this.emit('task.control', { taskId, payload: { action } });
        if (t.phase === 'execution') void this.pump(taskId);
        return t;
      }
      case 'cancel': {
        if (['completed', 'cancelled'].includes(task.lifecycle)) return task;
        this.touchTask(taskId, { lifecycle: 'cancelling' });
        this.emit('task.control', { taskId, payload: { action } });
        const sessions = Array.from(this.live.values()).filter((l) => l.taskId === taskId);
        for (const l of sessions) {
          l.cancelRequested = true;
          this.emit('attempt.cancel_requested', {
            taskId,
            attemptId: l.attemptId,
            sessionId: l.sessionRowId,
            payload: { requestedAt: nowIso() },
          });
          const receipt = await l.session.cancel().catch((err: Error) => ({ confirmed: false, detail: err.message, at: nowIso() }));
          this.repo.updateAttempt(l.attemptId, {
            cancelRequestedAt: nowIso(),
            cancelConfirmedAt: receipt.confirmed ? nowIso() : null,
            status: receipt.confirmed ? 'cancelled' : 'interrupted',
            endedAt: nowIso(),
          });
          this.emit(receipt.confirmed ? 'attempt.cancel_confirmed' : 'attempt.interrupted', {
            taskId,
            attemptId: l.attemptId,
            sessionId: l.sessionRowId,
            payload: { confirmed: receipt.confirmed, detail: receipt.detail },
          });
        }
        for (const w of this.repo.listWorkItems(taskId).filter((w) => ['pending', 'ready', 'queued', 'running'].includes(w.state))) {
          this.repo.updateWorkItem(w.id, { state: 'cancelled', updatedAt: nowIso() });
        }
        const unconfirmed = sessions.filter((s) => s.cancelRequested).length;
        void unconfirmed;
        this.touchTask(taskId, { lifecycle: 'cancelled' });
        this.emit('task.control', { taskId, payload: { action: 'cancel_confirmed' } });
        return this.requireTask(taskId);
      }
      case 'cancel_session': {
        if (!sessionId) throw new EngineError('invalid_request', '缺少 sessionId');
        const liveEntry = Array.from(this.live.values()).find((l) => l.sessionRowId === sessionId);
        if (!liveEntry) throw new EngineError('session_not_live', '该会话不在本进程管理中', 404);
        liveEntry.cancelRequested = true;
        this.emit('attempt.cancel_requested', { taskId, attemptId: liveEntry.attemptId, sessionId, payload: {} });
        const receipt = await liveEntry.session.cancel().catch((err: Error) => ({
          confirmed: false,
          detail: err.message,
          at: nowIso(),
        }));
        this.emit(receipt.confirmed ? 'attempt.cancel_confirmed' : 'attempt.interrupted', {
          taskId,
          attemptId: liveEntry.attemptId,
          sessionId,
          payload: { detail: receipt.detail },
        });
        return this.requireTask(taskId);
      }
      default:
        throw new EngineError('invalid_action', `未知控制动作 ${action}`);
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: 'approve' | 'deny' | 'cancel' | 'answer',
    payload?: string,
  ): Promise<void> {
    const row = this.repo.getApprovalRequest(approvalId);
    if (!row) throw new EngineError('approval_not_found', '审批请求不存在', 404);
    if (row.state !== 'pending') throw new EngineError('approval_resolved', '该审批已处理', 409);
    const liveEntry = Array.from(this.live.values()).find((l) => l.sessionRowId === row.sessionId);
    const state = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : decision === 'answer' ? 'approved' : 'cancelled';
    if (liveEntry && row.nativeRequestId) {
      const mapped = decision === 'approve' ? 'approve' : decision === 'deny' ? 'deny' : decision === 'answer' ? 'answer' : 'deny';
      try {
        await liveEntry.session.respond(row.nativeRequestId, mapped, payload);
      } catch (err) {
        this.repo.resolveApproval(approvalId, 'expired', `会话已不可用: ${(err as Error).message.slice(0, 200)}`);
        throw new EngineError('session_gone', '会话已不可用, 审批无法送达原生进程', 409);
      }
    } else {
      this.repo.resolveApproval(approvalId, 'expired', '对应会话已不在本进程管理中');
      throw new EngineError('session_gone', '对应会话已不在本进程管理中', 409);
    }
    this.repo.resolveApproval(approvalId, state, payload ?? null);
    this.emit('request.resolved', {
      taskId: row.taskId,
      sessionId: row.sessionId,
      attemptId: row.attemptId,
      payload: { approvalId, decision, state },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 故障恢复                                                            */
  /* ------------------------------------------------------------------ */

  recover(): { interruptedAttempts: number; expiredApprovals: number; pausedTasks: number } {
    return this.settleInterrupted({
      errorClass: 'service_restart',
      errorCode: 'restart_recovered',
      sessionError: '服务重启: 原进程连接已丢失, 未自动重跑',
      attemptMessage: '服务重启导致尝试中断; 未自动重跑有副作用的操作',
      taskMessage: '服务重启后任务已暂停; 请检查会话与产物后手动恢复, 不会自动重跑。',
      workItemMessage: '服务重启: 该次尝试已中断, 恢复后需重新执行',
    });
  }

  /**
   * 服务随网页关闭而停止时调用: 与重启恢复同样的语义 —— 记录中断, 不假装成功, 不自动重跑。
   * 必须在 engine.shutdown() 之后执行, 这样遗留的进程内回合已经不再写入。
   */
  settleOnShutdown(reason: string): { interruptedAttempts: number; expiredApprovals: number; pausedTasks: number } {
    return this.settleInterrupted({
      errorClass: reason,
      errorCode: reason === 'ui_closed' ? 'closed_with_page' : 'service_shutdown',
      sessionError: '网页关闭导致服务停止: 会话已断开, 未自动重跑',
      attemptMessage: '网页关闭导致服务停止, 该次尝试被中断; 重启后不会自动重跑有副作用的操作',
      taskMessage: '后台服务已随网页关闭而停止; 未完成的任务保持暂停, 重启后请手动恢复。',
      workItemMessage: '服务停止: 该次尝试已中断, 恢复后需重新执行',
    });
  }

  private settleInterrupted(opts: {
    errorClass: string;
    errorCode: string;
    sessionError: string;
    attemptMessage: string;
    taskMessage: string;
    workItemMessage: string;
  }): { interruptedAttempts: number; expiredApprovals: number; pausedTasks: number } {
    const openSessions = this.repo.listOpenSessions();
    const activeAttempts = this.repo.listActiveAttempts();
    const tasksTouched = new Set<string>();
    for (const s of openSessions) {
      this.repo.updateSession(s.id, {
        connectionState: 'disconnected',
        processHealth: s.processRef?.pid && isProcessAlive(s.processRef.pid) ? 'unknown' : 'exited',
        activity: 'unknown',
        status: 'orphaned',
        error: opts.sessionError,
        closedAt: nowIso(),
      });
      tasksTouched.add(s.taskId);
      this.emit('runtime.connection_changed', {
        taskId: s.taskId,
        sessionId: s.id,
        attemptId: s.attemptId,
        payload: { connectionState: 'disconnected', recovered: true },
      });
    }
    for (const a of activeAttempts) {
      this.repo.updateAttempt(a.id, {
        status: 'interrupted',
        endedAt: nowIso(),
        errorClass: opts.errorClass,
        errorMessage: opts.attemptMessage,
      });
      tasksTouched.add(a.taskId);
      this.emit('attempt.interrupted', {
        taskId: a.taskId,
        attemptId: a.id,
        sessionId: a.sessionId,
        payload: { reason: opts.errorClass },
      });
    }
    let expired = 0;
    for (const ap of this.repo.listAllPendingApprovals()) {
      this.repo.resolveApproval(ap.id, 'expired', '服务停止, 原生请求已失效');
      expired += 1;
    }
    let pausedTasks = 0;
    for (const taskId of tasksTouched) {
      const t = this.repo.getTask(taskId);
      if (!t) continue;
      if (['active', 'cancelling'].includes(t.lifecycle)) {
        this.repo.updateTask(
          taskId,
          {
            lifecycle: 'paused',
            errorCode: opts.errorCode,
            errorMessage: opts.taskMessage,
            updatedAt: nowIso(),
          },
          null,
        );
        this.emit('task.updated', { taskId, payload: { lifecycle: 'paused', recovered: true } });
        pausedTasks += 1;
      }
      // 中断时仍处于 queued/running/verifying 的工作项: 回到 pending 等待用户显式恢复后重新派发,
      // 避免"看起来在跑、实际没有进程"的死状态; 已产出的工作项保持原状, 不回退。
      for (const item of this.repo.listWorkItems(taskId)) {
        if (['queued', 'running', 'verifying'].includes(item.state)) {
          this.repo.updateWorkItem(item.id, {
            state: 'pending',
            lastError: opts.workItemMessage,
            updatedAt: nowIso(),
          });
          this.emit('work_item.updated', {
            taskId,
            payload: { workItemId: item.id, state: 'pending', recoveredFrom: item.state },
          });
        }
      }
    }
    return { interruptedAttempts: activeAttempts.length, expiredApprovals: expired, pausedTasks };
  }

  startMonitoring(intervalMs = 15_000): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      try {
        this.monitorTick();
      } catch {
        /* 监控失败不阻塞主流程 */
      }
    }, intervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitoring(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  private monitorTick(): void {
    for (const live of this.live.values()) {
      const row = this.repo.getSession(live.sessionRowId);
      if (!row) continue;
      const task = this.repo.getTask(live.taskId);
      if (!task) continue;
      const last = Date.parse(row.lastEventAt);
      const threshold = task.limits.noEventThresholdMs;
      if (Number.isFinite(last) && Date.now() - last > threshold && !this.noEventMarked.has(row.id)) {
        this.noEventMarked.add(row.id);
        this.repo.updateSession(row.id, { activity: 'no_recent_event' });
        this.emit('monitor.no_recent_event', {
          taskId: live.taskId,
          sessionId: row.id,
          attemptId: live.attemptId,
          payload: { sinceMs: Date.now() - last, threshold },
        });
      }
      const pid = row.processRef?.pid ?? null;
      if (pid) {
        const alive = isProcessAlive(pid);
        if (!alive && row.processHealth === 'alive') {
          this.repo.updateSession(row.id, { processHealth: 'exited', connectionState: 'disconnected' });
          this.emit('monitor.health_changed', {
            taskId: live.taskId,
            sessionId: row.id,
            attemptId: live.attemptId,
            payload: { processHealth: 'exited', pid },
          });
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  private failTask(taskId: string, code: string, message: string): void {
    this.touchTask(taskId, { lifecycle: 'failed', errorCode: code, errorMessage: message });
    this.emit('error.reported', { taskId, payload: { code, message } });
  }

  private blockTask(taskId: string, code: string, message: string): void {
    const t = this.touchTask(taskId, { lifecycle: 'blocked', errorCode: code, errorMessage: message });
    void t;
    this.emit('error.reported', { taskId, payload: { code, message } });
  }

  /** 串行执行阶段任务, 同一任务同一阶段不并发。 */
  private runStage(taskId: string, name: string, fn: () => Promise<void>): Promise<void> {
    const key = `${taskId}:${name}`;
    if (this.stopped || this.stageBusy.has(key)) return Promise.resolve();
    this.stageBusy.add(key);
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => {
        if (this.stopped) return;
        return fn();
      })
      .catch((err: Error) => {
        if (this.stopped) return;
        const task = this.repo.getTask(taskId);
        if (!task) return;
        if (task.lifecycle === 'cancelled' || task.lifecycle === 'cancelling') return;
        if (err instanceof EngineError && ['profile_drift', 'profile_not_live', 'adapter_missing'].includes(err.code)) {
          this.touchTask(taskId, { lifecycle: 'blocked', errorCode: err.code, errorMessage: err.message });
        } else {
          this.failTask(taskId, 'internal_error', err.message.slice(0, 500));
        }
      })
      .finally(() => {
        this.stageBusy.delete(key);
      });
    this.locks.set(taskId, next);
    return next;
  }

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.startTs) / 1000);
  }

  liveSessionCount(): number {
    return this.live.size;
  }
}

function sha256FileSync(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function isProcessAlive(pid: number): boolean {  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trim(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function mediaTypeForPath(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.cpp': 'text/x-c++src',
    '.cc': 'text/x-c++src',
    '.h': 'text/x-c++hdr',
    '.hpp': 'text/x-c++hdr',
    '.py': 'text/x-python',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

void isInside;
void DEFAULT_LIMITS;
void statSync;

