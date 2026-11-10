/**
 * DeepSeek Harness 适配器: 通过官方 `dsh --profile acp` 提供的 ACP(Agent Client
 * Protocol) stdio 服务驱动完整 DSH harness。保留原生工具、权限请求、会话恢复
 * (session/resume)与取消语义。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { CapabilityReport, ExecutionProfile } from '../../contracts/src/types.js';
import { StdioRpc } from './rpc.js';
import {
  AdapterError,
  type AdapterEvent,
  type AdapterHost,
  type AdapterSession,
  type CancelReceipt,
  type HarnessAdapter,
  type OpenSessionOptions,
  type ProbeResult,
  type SessionInspection,
  type TurnOutcome,
  type TurnRequest,
} from './types.js';
import { newId, sha256Text } from '../../core/src/util.js';
import { buildChildEnv, killProcessTree, resolveLauncher, spawnHarness } from './exec.js';
import { openDiagLog, type DiagLog } from './diag.js';

export interface DshAdapterOptions {
  /** dsh CLI 入口 (项目内 node_modules/@deepseek-ai/dsh/lib/bin.js) */
  /** 可选兜底入口; 不填则只用执行配置里填的路径或 PATH 里的 dsh */
  entry?: string;
  /** 项目内私有 DSH_HOME 根目录 */
  homeRoot: string;
  defaultTimeoutMs?: number;
}

interface PromptWaiter {
  resolve: (o: TurnOutcome) => void;
  text: string;
  startedAt: number;
  stopReason: string | null;
  settle: boolean;
  usage: Record<string, unknown> | null;
}

export class DshAdapter implements HarnessAdapter {
  readonly id = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness';
  readonly mock = false;

  constructor(private readonly opts: DshAdapterOptions) {}

  private homeFor(profile: ExecutionProfile): string {
    return path.join(this.opts.homeRoot, `dsh-${profile.id}`);
  }

  private spawnSpec(profile: ExecutionProfile): { command: string; args: string[]; entry: string } {
    // 支持项目内 js 入口 / 本机已安装的 dsh(PATH 或 .cmd/.ps1/.exe) / 留空自动探测
    const launcher = resolveLauncher(profile.executableRef, { name: 'dsh', path: this.opts.entry, installHint: '@deepseek-ai/dsh' });
    return { command: launcher.command, args: [...launcher.prefix, '--profile', 'acp'], entry: launcher.entry };
  }

  private childEnv(profile: ExecutionProfile, extra: Record<string, string>): Record<string, string> {
    return buildChildEnv({
      ...profile.env,
      ...extra,
      DSH_HOME: this.homeFor(profile),
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    });
  }

  async probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult> {
    // 入口解析/进程启动失败必须是"探针失败", 不能把异常冒到 HTTP 层。
    try {
      return await this.probeRuntime(profile, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        mode,
        checkedAt: new Date().toISOString(),
        executableResolved: profile.executableRef?.trim() ? profile.executableRef.trim() : null,
        version: null,
        protocol: null,
        detail: message,
        capability: null,
        warnings: ['无法启动该 harness: 请先在「执行配置」里确认可执行入口, 或先在本机安装它'],
      };
    }
  }

  private async probeRuntime(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const warnings: string[] = [];
    const { command, args, entry } = this.spawnSpec(profile);
    const child = await spawnHarness(command, args, {
      cwd: profile.workspaceRoot ?? process.cwd(),
      env: this.childEnv(profile, {}),
    });
    const stderr: string[] = [];
    const rpc = new StdioRpc(child as ChildProcessWithoutNullStreams, {
      onStderr: (t) => {
        if (stderr.length < 20) stderr.push(t.slice(0, 300));
      },
      onClose: () => undefined,
    });
    try {
      const init = await rpc.call<Record<string, unknown>>(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        },
        30000,
      );
      const agentCaps = (init.agentCapabilities ?? {}) as Record<string, unknown>;
      const protocolVersion = init.protocolVersion ? String(init.protocolVersion) : 'unknown';
      let liveDetail = '未执行真实回合';
      let liveOk = true;
      const liveErrors: string[] = [];
      if (mode === 'live') {
        try {
          const s = await rpc.call<Record<string, unknown>>(
            'session/new',
            { cwd: profile.workspaceRoot ?? process.cwd(), mcpServers: [] },
            60000,
          );
          if (s.sessionId) {
            // 探针也要把执行配置里指定的模型/推理真正设进去: 否则"live 通过"只证明
            // 默认模型能跑, 无法证明面板上的模型字段有效。
            if (profile.requestedModel) {
              await rpc.call(
                'session/set_config_option',
                { sessionId: s.sessionId, configId: 'model', value: profile.requestedModel },
                20000,
              );
            }
            if (profile.requestedReasoning) {
              await rpc.call(
                'session/set_config_option',
                { sessionId: s.sessionId, configId: 'reasoning_effort', value: profile.requestedReasoning },
                20000,
              );
            }
            // live 探针必须证明"认证 + 模型 + 一个真实回合"都能跑通, 否则无法区分
            // "会话建得起来" 和 "模型其实不可用"。
            const turn = await rpc.call<Record<string, unknown> | undefined>(
              'session/prompt',
              { sessionId: s.sessionId, prompt: [{ type: 'text', text: '只输出 OK 两个字符, 不要解释。' }] },
              120000,
            );
            const stopReason = turn && typeof turn === 'object' ? String(turn.stopReason ?? 'unknown') : 'empty_result';
            await rpc.call('session/close', { sessionId: s.sessionId }, 15000).catch(() => undefined);
            liveDetail = `真实回合结束 (stopReason=${stopReason})`;
            if (stopReason !== 'end_turn') {
              liveOk = false;
              liveErrors.push(`回合未正常结束 (stopReason=${stopReason})`);
            }
          } else {
            liveOk = false;
            liveErrors.push('session/new 未返回 sessionId');
          }
        } catch (err) {
          liveOk = false;
          liveErrors.push((err as Error).message.slice(0, 200));
          warnings.push(`live 回合失败: ${(err as Error).message.slice(0, 200)}`);
          liveDetail = '真实回合失败';
        }
      }
      const loadSession = Boolean(agentCaps.loadSession);
      return {
        ok: liveOk,
        mode,
        checkedAt,
        executableResolved: entry,
        version: null,
        protocol: `ACP over stdio (protocolVersion=${protocolVersion})`,
        detail: liveOk ? `握手成功; ${liveDetail}` : `握手成功; ${liveDetail}: ${liveErrors.join('; ').slice(0, 160)}`,
        capability: {
          adapterId: 'dsh',
          checkedAt,
          protocolVersion,
          executable: command,
          capabilities: {
            structuredOutput: { state: 'supported', evidence: '提示层 JSON 约束 + ACP 文本流' },
            streamMessages: { state: 'supported', evidence: 'session/update agent_message_chunk' },
            toolEvents: { state: 'supported', evidence: 'session/update tool_call / tool_call_update' },
            approvals: { state: 'supported', evidence: 'session/request_permission' },
            userInput: { state: 'unknown', evidence: 'ACP elicitation 不支持' },
            cancellation: { state: 'supported', evidence: 'session/cancel + $/cancel_request' },
            nativeResume: { state: 'supported', evidence: 'session/resume' },
            modelSelection: { state: 'supported', evidence: 'session/set_config_option(model)' },
            reasoningSelection: { state: 'supported', evidence: 'session/set_config_option(reasoning_effort)' },
            imageInput: { state: 'supported', evidence: 'ACP prompt content (image)' },
            fileInput: { state: 'supported', evidence: 'ACP resource_link / 工具读取' },
            skills: { state: 'supported', evidence: '由 DSH profile 加载' },
            mcp: { state: 'supported', evidence: 'session/new mcpServers' },
            workspaceRestriction: { state: 'supported', evidence: 'session/new cwd (必须绝对路径)' },
            reportedModelIdentity: { state: loadSession ? 'supported' : 'unknown', evidence: 'profile 配置行 provider/model' },
          },
          notes: [
            '使用 `dsh --profile acp` 的自动化 ACP 入口, 不使用 TUI/headless 文本模式',
            'DSH_HOME 指向项目内私有目录, 需要预先放置凭据副本',
          ],
        },
        warnings,
      };
    } catch (err) {
      return {
        ok: false,
        mode,
        checkedAt,
        executableResolved: entry,
        version: null,
        protocol: null,
        detail: `ACP 握手失败: ${(err as Error).message.slice(0, 300)}${stderr[0] ? `; stderr: ${stderr[0].slice(0, 200)}` : ''}`,
        capability: null,
        warnings,
      };
    } finally {
      killProcessTree(child);
    }
  }

  async capabilities(profile: ExecutionProfile): Promise<CapabilityReport> {
    const r = await this.probe(profile, 'inspect');
    return (
      r.capability ?? {
        adapterId: 'dsh',
        checkedAt: new Date().toISOString(),
        capabilities: {},
        notes: [r.detail],
      }
    );
  }

  async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    return DshSession.open(opts, host, {
      spawnSpec: (p) => this.spawnSpec(p),
      childEnv: (p, extra) => this.childEnv(p, extra),
      defaultTimeoutMs: this.opts.defaultTimeoutMs ?? 30 * 60_000,
      entry: this.opts.entry ?? '',
    });
  }

  privateHomeDir(profile: ExecutionProfile): string {
    return this.homeFor(profile);
  }
}

interface DshSessionDeps {
  spawnSpec: (p: ExecutionProfile) => { command: string; args: string[] };
  childEnv: (p: ExecutionProfile, extra: Record<string, string>) => Record<string, string>;
  defaultTimeoutMs: number;
  entry: string;
}

class DshSession implements AdapterSession {
  readonly adapterId = 'dsh' as const;
  readonly localId: string;
  private nativeId: string | null = null;
  private child: ChildProcessWithoutNullStreams;
  private rpc: StdioRpc;
  private waiter: PromptWaiter | null = null;
  private closed = false;
  private expectedExit = false;
  private activity: SessionInspection['activity'] = 'idle';
  private connection: SessionInspection['connectionState'] = 'connected';
  private observedModel: string | null = null;
  private observedReasoning: string | null = null;
  private detail = '已启动 dsh ACP 服务';
  /** 本次 attempt 的原始 stderr, 仅用于事后诊断。 */
  private readonly stderrLog: DiagLog | null;
  private readonly pendingApprovals = new Map<string, { nativeId: string | number; options: Record<string, unknown>[] }>();
  private toolNames = new Map<string, string>();

  private constructor(
    private readonly opts: OpenSessionOptions,
    private readonly host: AdapterHost,
    private readonly deps: DshSessionDeps,
    child: ChildProcessWithoutNullStreams,
    localId: string,
  ) {
    this.child = child;
    this.localId = localId;
    this.stderrLog = openDiagLog(this.opts.diagnosticsDir, 'stderr.log');
    this.rpc = new StdioRpc(child, {
      onNotification: (m, p) => this.onNotification(m, p),
      onRequest: (id, m, p) => this.onServerRequest(id, m, p),
      onStderr: (t) => {
        this.stderrLog?.write(t);
        if (t.trim().length > 0 && /error|warn/i.test(t)) {
          this.emit({ kind: 'notice', text: t.trim().slice(0, 300) });
        }
      },
      onClose: (code) => {
        this.stderrLog?.close();
        this.connection = 'disconnected';
        this.activity = 'unknown';
        this.detail = `dsh ACP 进程已退出 code=${code}`;
        if (this.waiter && !this.waiter.settle) {
          this.settleWaiter({ status: 'failed', errorClass: 'process_exited', errorMessage: `进程退出 code=${code}` });
        }
        this.host.onExit(this.localId, { code, expected: this.expectedExit });
        this.pushInfo();
      },
    });
  }

  static async open(opts: OpenSessionOptions, host: AdapterHost, deps: DshSessionDeps): Promise<DshSession> {
    const { command, args } = deps.spawnSpec(opts.profile);
    const child = await spawnHarness(command, args, {
      cwd: opts.cwd,
      env: deps.childEnv(opts.profile, opts.env),
    });
    const session = new DshSession(opts, host, deps, child as ChildProcessWithoutNullStreams, newId('dsh'));
    await session.bootstrap();
    return session;
  }

  private async bootstrap(): Promise<void> {
    await this.rpc.call(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      },
      30000,
    );
    await this.ensureSession();
  }

  private async ensureSession(): Promise<string> {
    if (this.nativeId) return this.nativeId;
    if (this.opts.resumeNativeSessionId) {
      try {
        const r = await this.rpc.call<Record<string, unknown>>(
          'session/resume',
          { sessionId: this.opts.resumeNativeSessionId, cwd: this.opts.cwd, mcpServers: [] },
          60000,
        );
        this.nativeId = String(r.sessionId ?? this.opts.resumeNativeSessionId);
        this.emit({ kind: 'notice', text: `已恢复 DSH 会话 ${this.nativeId}` });
      } catch (err) {
        this.emit({ kind: 'notice', text: `原生恢复失败, 新建会话: ${(err as Error).message.slice(0, 200)}` });
      }
    }
    if (!this.nativeId) {
      const r = await this.rpc.call<Record<string, unknown>>(
        'session/new',
        { cwd: this.opts.cwd, mcpServers: [] },
        60000,
      );
      this.nativeId = r.sessionId ? String(r.sessionId) : null;
      this.emit({ kind: 'notice', text: `已创建 DSH 会话 ${this.nativeId}` });
      const configOptions = (r.configOptions ?? []) as Record<string, unknown>[];
      const modelOpt = configOptions.find((c) => c.id === 'model');
      if (modelOpt && modelOpt.currentValue) this.observedModel = String(modelOpt.currentValue);
      const effortOpt = configOptions.find((c) => c.id === 'reasoning_effort');
      if (effortOpt && effortOpt.currentValue) this.observedReasoning = String(effortOpt.currentValue);
    }
    const profile = this.opts.profile;
    if (profile.requestedModel && this.nativeId && this.observedModel !== profile.requestedModel) {
      try {
        const r = await this.rpc.call<Record<string, unknown>>(
          'session/set_config_option',
          { sessionId: this.nativeId, configId: 'model', value: profile.requestedModel },
          30000,
        );
        this.observedModel = profile.requestedModel;
        void r;
      } catch (err) {
        this.emit({ kind: 'notice', text: `设置模型失败: ${(err as Error).message.slice(0, 200)}` });
      }
    }
    if (profile.requestedReasoning && this.nativeId && this.observedReasoning !== profile.requestedReasoning) {
      try {
        await this.rpc.call(
          'session/set_config_option',
          { sessionId: this.nativeId, configId: 'reasoning_effort', value: profile.requestedReasoning },
          30000,
        );
        this.observedReasoning = profile.requestedReasoning;
      } catch (err) {
        this.emit({ kind: 'notice', text: `设置推理等级失败: ${(err as Error).message.slice(0, 200)}` });
      }
    }
    this.detail = `DSH 会话 ${this.nativeId}`;
    this.pushInfo();
    if (!this.nativeId) throw new AdapterError('session_new_failed', 'session/new 未返回 sessionId');
    return this.nativeId;
  }

  private emit(ev: AdapterEvent): void {
    this.host.onEvent(this.localId, ev);
  }

  private pushInfo(): void {
    this.host.onSessionInfo(this.localId, this.inspection);
  }

  get inspection(): SessionInspection {
    const pid = typeof this.child.pid === 'number' ? this.child.pid : null;
    return {
      pid,
      processRef: pid
        ? {
            pid,
            startedAt: new Date().toISOString(),
            runtimeNonce: this.localId,
            command: this.deps.entry,
          }
        : null,
      connectionState: this.connection,
      activity: this.activity,
      nativeSessionId: this.nativeId,
      observedModel: this.observedModel,
      observedReasoning: this.observedReasoning,
      detail: this.detail,
    };
  }

  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const p = (params ?? {}) as Record<string, unknown>;
    const update = (p.update ?? {}) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? '');
    switch (kind) {
      case 'agent_message_chunk': {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = content.type === 'text' ? String(content.text ?? '') : '';
        if (text) {
          if (this.waiter) this.waiter.text += text;
          this.activity = 'generating';
          this.emit({ kind: 'message.delta', text });
        }
        break;
      }
      case 'agent_thought_chunk': {
        this.activity = 'generating';
        break;
      }
      case 'tool_call': {
        const id = String(update.toolCallId ?? '');
        const title = String(update.title ?? 'tool');
        this.toolNames.set(id, title);
        this.activity = 'tool_running';
        this.emit({
          kind: 'tool.started',
          toolName: title,
          callId: id,
          inputSummary: JSON.stringify(update.rawInput ?? {}).slice(0, 500),
        });
        this.pushInfo();
        break;
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '');
        const status = String(update.status ?? '');
        if (status === 'completed' || status === 'failed') {
          this.emit({
            kind: 'tool.completed',
            callId: id,
            ok: status === 'completed',
            outputSummary: JSON.stringify(update.content ?? update.rawOutput ?? '').slice(0, 800),
          });
          this.activity = 'generating';
        } else if (status === 'in_progress') {
          this.emit({ kind: 'tool.progress', callId: id, text: String(update.title ?? '执行中') });
        }
        break;
      }
      case 'plan': {
        this.emit({ kind: 'notice', text: `原生计划更新: ${JSON.stringify(update.entries ?? []).slice(0, 300)}` });
        break;
      }
      case 'current_mode_update': {
        this.emit({ kind: 'notice', text: `原生模式: ${String(update.currentModeId ?? '')}` });
        break;
      }
      case 'available_commands_update': {
        break;
      }
      default:
        break;
    }
  }

  private onServerRequest(id: string | number, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'session/request_permission') {
      const requestId = `perm#${String(id)}`;
      const options = (p.options ?? []) as Record<string, unknown>[];
      this.pendingApprovals.set(requestId, { nativeId: id, options });
      const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
      this.emit({
        kind: 'approval.requested',
        requestId,
        approvalKind: 'acp:request_permission',
        title: String(toolCall.title ?? '原生权限请求'),
        detail: JSON.stringify(toolCall.rawInput ?? toolCall.content ?? {}).slice(0, 800),
        scopeHash: sha256Text(JSON.stringify(toolCall)).slice(0, 16),
      });
      return;
    }
    // 文件系统/终端请求: 明确拒绝, 避免越权
    this.rpc.respondError(id, -32601, `unsupported client method: ${method}`);
  }

  async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
    if (this.closed) throw new AdapterError('session_closed', '会话已关闭');
    if (this.waiter) throw new AdapterError('turn_in_flight', '同一会话已有进行中的回合');
    const sessionId = await this.ensureSession();
    const startedAt = Date.now();
    const waiter: PromptWaiter = {
      resolve: () => undefined,
      text: '',
      startedAt,
      stopReason: null,
      settle: false,
      usage: null,
    };
    const done = new Promise<TurnOutcome>((resolve) => {
      waiter.resolve = resolve;
    });
    this.waiter = waiter;
    const timeoutMs = req.timeoutMs > 0 ? req.timeoutMs : this.deps.defaultTimeoutMs;
    const timer = setTimeout(() => {
      if (this.waiter === waiter && !waiter.settle) {
        void this.cancel().catch(() => undefined);
        this.settleWaiter({ status: 'failed', errorClass: 'turn_timeout' });
      }
    }, timeoutMs);
    try {
      const r = await this.rpc.call<Record<string, unknown> | undefined>(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: req.prompt }] },
        timeoutMs,
      );
      if (!r || typeof r !== 'object') {
        // harness 可能在回合中途退出或回了空 result; 不能当成"正常结束"
        this.settleWaiter({
          status: 'failed',
          errorClass: 'prompt_failed',
          errorMessage: 'session/prompt 返回空结果(harness 可能提前退出)',
        });
        const emptyOutcome = await done;
        clearTimeout(timer);
        return emptyOutcome;
      }
      waiter.stopReason = r.stopReason ? String(r.stopReason) : null;
      const rawUsage = (r.usage ?? r.tokenUsage ?? null) as Record<string, unknown> | null;
      if (rawUsage) {
        waiter.usage = rawUsage;
        this.emit({ kind: 'usage', usage: rawUsage });
      }
    } catch (err) {
      if (!waiter.settle) {
        this.settleWaiter({
          status: 'failed',
          errorClass: 'prompt_failed',
          errorMessage: (err as Error).message.slice(0, 500),
        });
      }
    }
    if (!waiter.settle) {
      const reason = waiter.stopReason;
      const status: TurnOutcome['status'] =
        reason === 'end_turn' || reason === null
          ? 'completed'
          : reason === 'cancelled'
            ? 'cancelled'
            : reason === 'refusal'
              ? 'failed'
              : 'completed';
      this.settleWaiter({
        status,
        errorClass: status === 'failed' ? 'refusal' : null,
      });
    }
    const outcome = await done;
    clearTimeout(timer);
    return outcome;
  }

  private settleWaiter(o: { status: TurnOutcome['status']; errorClass?: string | null; errorMessage?: string | null }): void {
    const w = this.waiter;
    if (!w || w.settle) return;
    w.settle = true;
    if (this.waiter === w) this.waiter = null;
    this.activity = 'idle';
    this.pushInfo();
    if (w.text.length > 0) this.emit({ kind: 'message.completed', text: w.text });
    w.resolve({
      status: o.status,
      text: w.text,
      errorClass: o.errorClass ?? null,
      errorMessage: o.errorMessage ?? null,
      observedModel: this.observedModel,
      reportedReasoning: this.observedReasoning,
      usage: w.usage ?? null,
      durationMs: Date.now() - w.startedAt,
    });
  }

  async cancel(): Promise<CancelReceipt> {
    const at = new Date().toISOString();
    if (this.closed) return { confirmed: true, detail: '会话已关闭', at };
    if (!this.waiter) return { confirmed: true, detail: '当前没有进行中的回合', at };
    if (!this.nativeId) return { confirmed: false, detail: '无原生会话可取消', at };
    try {
      this.rpc.notify('session/cancel', { sessionId: this.nativeId });
    } catch (err) {
      return { confirmed: false, detail: `发送取消失败: ${(err as Error).message.slice(0, 200)}`, at };
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.waiter) return { confirmed: true, detail: '已收到原生取消确认', at };
      await new Promise((r) => setTimeout(r, 250));
    }
    this.expectedExit = true;
    killProcessTree(this.child);
    return { confirmed: false, detail: '未在 15s 内确认取消, 已终止进程', at };
  }

  async respond(requestId: string, decision: 'approve' | 'deny' | 'answer', payload?: string): Promise<void> {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) throw new AdapterError('unknown_request', `未知的权限请求 ${requestId}`);
    this.pendingApprovals.delete(requestId);
    if (decision === 'approve') {
      const allow = entry.options.find((o) => String(o.kind ?? '').startsWith('allow')) ?? entry.options[0];
      const optionId = allow ? String(allow.optionId ?? '') : '';
      this.rpc.respond(entry.nativeId, { outcome: { outcome: 'selected', optionId } });
    } else if (decision === 'deny') {
      const reject = entry.options.find((o) => String(o.kind ?? '').startsWith('reject'));
      if (reject) {
        this.rpc.respond(entry.nativeId, { outcome: { outcome: 'selected', optionId: String(reject.optionId ?? '') } });
      } else {
        this.rpc.respond(entry.nativeId, { outcome: { outcome: 'cancelled' } });
      }
    } else {
      this.rpc.respond(entry.nativeId, { outcome: { outcome: 'cancelled' } });
      void payload;
    }
    this.emit({ kind: 'request.resolved', requestId, outcome: decision });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.expectedExit = true;
    try {
      if (this.nativeId) {
        await this.rpc.call('session/close', { sessionId: this.nativeId }, 5000).catch(() => undefined);
      }
    } finally {
      killProcessTree(this.child);
      this.stderrLog?.close();
    }
  }
}

export function createDshAdapter(opts: DshAdapterOptions): DshAdapter {
  return new DshAdapter(opts);
}
