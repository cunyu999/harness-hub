/**
 * Codex 适配器: 通过 `codex app-server` 的原生 JSON-RPC 协议驱动完整 Codex harness。
 * 保留原生审批、工具事件、中断与线程恢复能力。
 */
import { spawn } from 'node:child_process';
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
import { resolveLauncher } from './exec.js';

export interface CodexAdapterOptions {
  /** 可选兜底入口; 不填则只用执行配置里填的路径或 PATH 里的 codex */
  entry?: string;
  /** 项目内私有 CODEX_HOME 根目录 */
  homeRoot: string;
  defaultTimeoutMs?: number;
}

interface PendingTurn {
  turnId: string | null;
  resolve: (o: TurnOutcome) => void;
  startedAt: number;
  text: string;
  usage: Record<string, unknown> | null;
  errorMessage: string | null;
  errorClass: string | null;
  settled: boolean;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly mock = false;

  constructor(private readonly opts: CodexAdapterOptions) {}

  private homeDirFor(profile: ExecutionProfile): string {
    return path.join(this.opts.homeRoot, `codex-${profile.id}`);
  }

  private spawnArgs(profile: ExecutionProfile): { command: string; args: string[]; entry: string } {
    // 支持三种来源: 项目内 js 入口 / 本机已安装的 codex(PATH 或 .cmd/.ps1/.exe) / 留空自动探测
    const launcher = resolveLauncher(profile.executableRef, { name: 'codex', path: this.opts.entry, installHint: '@openai/codex' });
    return { command: launcher.command, args: [...launcher.prefix, 'app-server'], entry: launcher.entry };
  }

  private childEnv(profile: ExecutionProfile, extra: Record<string, string>): Record<string, string> {
    const home = this.homeDirFor(profile);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v;
    }
    // 去掉可能把凭据带出项目目录的变量
    delete base.CODEX_HOME;
    return {
      ...base,
      ...profile.env,
      ...extra,
      CODEX_HOME: home,
      RUST_LOG: 'error',
    };
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
    const { command, args, entry } = this.spawnArgs(profile);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: this.childEnv(profile, {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderrChunks: string[] = [];
    let closeReason = '';
    const rpc = new StdioRpc(child as never, {
      onStderr: (t) => {
        if (stderrChunks.length < 20) stderrChunks.push(t.slice(0, 300));
      },
      onClose: (code) => {
        closeReason = `进程退出 code=${code}`;
      },
    });
    try {
      const init = await rpc.call<Record<string, unknown>>(
        'initialize',
        { clientInfo: { name: 'harness-hub', version: '0.1.0' }, capabilities: { experimentalApi: true } },
        20000,
      );
      const ua = String(init.userAgent ?? '');
      const version = /codex\/([\w.\-]+)/.exec(ua)?.[1] ?? /(\d+\.\d+\.\d+[\w.\-]*)/.exec(ua)?.[1] ?? null;
      let liveDetail = '未执行真实回合';
      let liveOk = true;
      let liveError = '';
      if (mode === 'live') {
        try {
          const models = await rpc.call<Record<string, unknown>>('model/list', {}, 20000);
          const arr = (models.data ?? models.models ?? []) as unknown[];
          liveDetail = `model/list 返回 ${arr.length} 个模型`;
          // 有认证但一个模型都拿不到, 说明 provider/账号配置有问题, 不能算 live 通过。
          if (arr.length === 0) {
            liveOk = false;
            liveError = 'model/list 返回 0 个模型';
          }
        } catch (err) {
          liveOk = false;
          liveError = (err as Error).message;
          warnings.push(`model/list 失败: ${liveError.slice(0, 200)}`);
          liveDetail = '认证或网络问题, 未能列出模型';
        }
      }
      return {
        ok: liveOk,
        mode,
        checkedAt,
        executableResolved: entry,
        version,
        protocol: 'codex app-server v2 (JSON-RPC over stdio)',
        detail: liveOk ? `handshake 成功; ${liveDetail}` : `handshake 成功; ${liveDetail}: ${liveError.slice(0, 160)}`,
        capability: {
          adapterId: 'codex',
          checkedAt,
          protocolVersion: 'v2',
          executable: command,
          version: version ?? undefined,
          capabilities: {
            structuredOutput: { state: 'supported', evidence: 'turn/start.outputSchema' },
            streamMessages: { state: 'supported', evidence: 'item/agentMessage/delta' },
            toolEvents: { state: 'supported', evidence: 'item/started(item/completed) 含 commandExecution/fileChange' },
            approvals: { state: 'supported', evidence: 'CommandExecutionRequestApproval / FileChangeRequestApproval' },
            userInput: { state: 'supported', evidence: 'ToolRequestUserInput' },
            cancellation: { state: 'supported', evidence: 'turn/interrupt' },
            nativeResume: { state: 'supported', evidence: 'thread/resume + sessions rollout' },
            modelSelection: { state: 'supported', evidence: 'thread/start.model & turn/start.model' },
            reasoningSelection: { state: 'supported', evidence: 'turn/start.effort' },
            imageInput: { state: 'supported', evidence: 'UserInput.local_image' },
            fileInput: { state: 'unknown' },
            skills: { state: 'unknown' },
            mcp: { state: 'supported', evidence: 'mcpServer/* 与 config.toml' },
            workspaceRestriction: { state: 'supported', evidence: 'sandbox: workspace-write + cwd' },
            reportedModelIdentity: { state: 'supported', evidence: 'thread.model/modelProvider' },
          },
          notes: ['Windows 沙箱需要一次性准备; 未准备时命令仍在 cwd 内执行但隔离较弱'],
        },
        warnings,
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        ok: false,
        mode,
        checkedAt,
        executableResolved: command,
        version: null,
        protocol: null,
        detail: `启动或握手失败: ${msg}${closeReason ? `; ${closeReason}` : ''}${stderrChunks.length ? `; stderr: ${stderrChunks[0].slice(0, 200)}` : ''}`,
        capability: null,
        warnings,
      };
    } finally {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  async capabilities(profile: ExecutionProfile): Promise<CapabilityReport> {
    const r = await this.probe(profile, 'inspect');
    if (r.capability) return r.capability;
    return {
      adapterId: 'codex',
      checkedAt: new Date().toISOString(),
      capabilities: {},
      notes: [r.detail],
    };
  }

  async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    return CodexSession.open(opts, host, {
      entry: this.opts.entry ?? '',
      homeDir: this.homeDirFor(opts.profile),
      spawnArgs: (p) => this.spawnArgs(p),
      childEnv: (p, extra) => this.childEnv(p, extra),
      defaultTimeoutMs: this.opts.defaultTimeoutMs ?? 30 * 60_000,
    });
  }

  privateHomeDir(profile: ExecutionProfile): string {
    return this.homeDirFor(profile);
  }
}

interface CodexSessionDeps {
  entry: string;
  homeDir: string;
  spawnArgs: (p: ExecutionProfile) => { command: string; args: string[] };
  childEnv: (p: ExecutionProfile, extra: Record<string, string>) => Record<string, string>;
  defaultTimeoutMs: number;
}

class CodexSession implements AdapterSession {
  readonly adapterId = 'codex' as const;
  readonly localId: string;
  private nativeThreadId: string | null = null;
  private rpc: StdioRpc;
  private child: ReturnType<typeof spawn>;
  private pending: PendingTurn | null = null;
  private closed = false;
  private expectedExit = false;
  private lastEventAt = Date.now();
  private activity: SessionInspection['activity'] = 'idle';
  private connection: SessionInspection['connectionState'] = 'connected';
  private observedModel: string | null = null;
  private observedReasoning: string | null = null;
  private readonly pendingRequests = new Map<string, { nativeId: number | string; method: string; params: Record<string, unknown> }>();
  private detail = '已启动 codex app-server';

  private constructor(
    private readonly opts: OpenSessionOptions,
    private readonly host: AdapterHost,
    private readonly deps: CodexSessionDeps,
    child: ReturnType<typeof spawn>,
    localId: string,
  ) {
    this.child = child;
    this.localId = localId;
    this.rpc = new StdioRpc(child as never, {
      onNotification: (m, p) => this.onNotification(m, p),
      onRequest: (id, m, p) => this.onServerRequest(id, m, p),
      onStderr: (t) => {
        if (/ERROR/.test(t) && /sandbox|approval|permission/.test(t)) {
          this.emit({ kind: 'notice', text: t.trim().slice(0, 300) });
        }
      },
      onClose: (code) => {
        this.connection = 'disconnected';
        this.activity = 'unknown';
        this.detail = `codex app-server 已退出 code=${code}`;
        const p = this.pending;
        if (p && !p.settled) this.settle(p, { status: 'failed', errorClass: 'process_exited' });
        this.host.onExit(this.localId, { code, expected: this.expectedExit });
        this.pushInfo();
      },
    });
  }

  static async open(opts: OpenSessionOptions, host: AdapterHost, deps: CodexSessionDeps): Promise<CodexSession> {
    const { command, args } = deps.spawnArgs(opts.profile);
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: deps.childEnv(opts.profile, opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const session = new CodexSession(opts, host, deps, child, newId('csx'));
    await session.handshake();
    return session;
  }

  private async handshake(): Promise<void> {
    await this.rpc.call(
      'initialize',
      { clientInfo: { name: 'harness-hub', version: '0.1.0' }, capabilities: { experimentalApi: true } },
      30000,
    );
    this.detail = 'app-server 握手完成';
    this.pushInfo();
    await this.startThread();
  }

  private emit(ev: AdapterEvent): void {
    this.lastEventAt = Date.now();
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
        ? { pid, startedAt: new Date().toISOString(), runtimeNonce: this.localId, command: this.deps.entry }
        : null,
      connectionState: this.connection,
      activity: this.activity,
      nativeSessionId: this.nativeThreadId,
      observedModel: this.observedModel,
      observedReasoning: this.observedReasoning,
      detail: this.detail,
    };
  }

  get nativeSessionId(): string | null {
    return this.nativeThreadId;
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started': {
        const th = p.thread as Record<string, unknown> | undefined;
        if (th?.id) this.nativeThreadId = String(th.id);
        if (th?.model) this.observedModel = String(th.model);
        this.detail = `线程 ${this.nativeThreadId} 已就绪`;
        this.pushInfo();
        break;
      }
      case 'turn/started': {
        this.activity = 'generating';
        this.emit({ kind: 'activity', activity: 'generating' });
        this.pushInfo();
        break;
      }
      case 'item/agentMessage/delta': {
        const d = String(p.delta ?? '');
        if (d) {
          if (this.pending) this.pending.text += d;
          this.activity = 'generating';
          this.emit({ kind: 'message.delta', text: d });
        }
        break;
      }
      case 'item/started': {
        const item = (p.item ?? {}) as Record<string, unknown>;
        const type = String(item.type ?? '');
        if (type === 'commandExecution') {
          this.activity = 'tool_running';
          this.emit({
            kind: 'tool.started',
            toolName: 'shell',
            callId: String(item.id ?? ''),
            inputSummary: String(item.command ?? '').slice(0, 500),
          });
          this.pushInfo();
        } else if (type === 'fileChange') {
          this.emit({
            kind: 'tool.started',
            toolName: 'apply_patch',
            callId: String(item.id ?? ''),
            inputSummary: JSON.stringify(item.changes ?? []).slice(0, 500),
          });
        } else if (type === 'reasoning') {
          this.activity = 'generating';
        }
        break;
      }
      case 'item/completed': {
        const item = (p.item ?? {}) as Record<string, unknown>;
        const type = String(item.type ?? '');
        if (type === 'commandExecution') {
          const ok = item.status === 'completed' && (item.exit_code === 0 || item.exit_code == null);
          this.emit({
            kind: 'tool.completed',
            callId: String(item.id ?? ''),
            ok,
            outputSummary: String(item.aggregated_output ?? '').slice(0, 1000),
          });
          this.activity = 'generating';
        } else if (type === 'fileChange') {
          this.emit({
            kind: 'tool.completed',
            callId: String(item.id ?? ''),
            ok: item.status === 'completed',
            outputSummary: JSON.stringify(item.changes ?? []).slice(0, 500),
          });
        } else if (type === 'error') {
          this.emit({ kind: 'error', message: String(item.message ?? '未知错误'), errorClass: 'native_item_error' });
        }
        break;
      }
      case 'turn/completed': {
        const turn = (p.turn ?? {}) as Record<string, unknown>;
        const status = String(turn.status ?? 'completed');
        const items = (turn.items ?? []) as Record<string, unknown>[];
        const finalText = [...items]
          .reverse()
          .filter((i) => i.type === 'agentMessage' && (i.phase === 'final_answer' || i.phase == null))
          .map((i) => String(i.text ?? ''))[0];
        if (this.pending) {
          if (finalText) this.pending.text = finalText;
          this.settle(this.pending, {
            status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed',
            errorClass: status === 'failed' ? 'native_turn_failed' : null,
          });
        }
        if (finalText) this.emit({ kind: 'message.completed', text: finalText });
        this.activity = 'idle';
        this.pushInfo();
        break;
      }
      case 'thread/status/changed': {
        const st = (p.status ?? {}) as Record<string, unknown>;
        const t = String(st.type ?? '');
        this.activity = t === 'active' ? 'generating' : 'idle';
        this.pushInfo();
        break;
      }
      case 'error': {
        const err = (p.error ?? {}) as Record<string, unknown>;
        const willRetry = Boolean(p.willRetry);
        const msg = String(err.message ?? '未知错误');
        if (willRetry) {
          this.activity = 'generating';
          this.emit({ kind: 'activity', activity: 'generating', note: `原生重试中: ${msg.slice(0, 120)}` });
        } else {
          this.emit({ kind: 'error', message: msg.slice(0, 500), errorClass: 'native_error' });
          if (this.pending) this.pending.errorMessage = msg;
        }
        break;
      }
      case 'warning': {
        this.emit({ kind: 'notice', text: String(p.message ?? '').slice(0, 300) });
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (this.pending) this.pending.usage = (p.tokenUsage ?? null) as Record<string, unknown> | null;
        break;
      }
      default:
        break;
    }
  }

  private onServerRequest(id: number | string, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const requestId = `${method}#${String(id)}`;
    this.pendingRequests.set(requestId, { nativeId: id, method, params: p });
    if (method === 'ToolRequestUserInput') {
      const questions = (p.questions ?? []) as Record<string, unknown>[];
      this.emit({
        kind: 'user_input.requested',
        requestId,
        prompt: questions.map((q) => String(q.question ?? '')).join('\n') || '原生请求用户输入',
      });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      this.emit({ kind: 'user_input.requested', requestId, prompt: String(p.message ?? 'MCP 请求输入') });
      return;
    }
    const titleMap: Record<string, string> = {
      'CommandExecutionRequestApproval': '命令执行审批',
      'ExecCommandApproval': '命令执行审批',
      'FileChangeRequestApproval': '文件修改审批',
      'ApplyPatchApproval': '补丁应用审批',
      'PermissionsRequestApproval': '扩展权限审批',
    };
    const detailParts = [p.command, p.reason, p.cwd].filter(Boolean).map(String);
    this.emit({
      kind: 'approval.requested',
      requestId,
      approvalKind: method,
      title: titleMap[method] ?? method,
      detail: detailParts.join(' | ').slice(0, 800) || method,
      scopeHash: sha256Text(JSON.stringify({ method, params: p })).slice(0, 16),
    });
    this.activity = 'idle';
    this.pushInfo();
  }

  async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
    if (this.closed) throw new AdapterError('session_closed', '会话已关闭');
    if (this.pending) throw new AdapterError('turn_in_flight', '同一会话已有进行中的回合');
    const startedAt = Date.now();
    if (!this.nativeThreadId) {
      await this.startThread();
    }
    const pending: PendingTurn = {
      turnId: null,
      resolve: () => undefined,
      startedAt,
      text: '',
      usage: null,
      errorMessage: null,
      errorClass: null,
      settled: false,
    };
    const done = new Promise<TurnOutcome>((resolve) => {
      pending.resolve = resolve;
    });
    this.pending = pending;
    const timeoutMs = req.timeoutMs > 0 ? req.timeoutMs : this.deps.defaultTimeoutMs;
    const timer = setTimeout(() => {
      if (this.pending === pending && !pending.settled) {
        void this.cancel().catch(() => undefined);
        this.settle(pending, { status: 'failed', errorClass: 'turn_timeout' });
      }
    }, timeoutMs);

    try {
      const res = await this.rpc.call<Record<string, unknown>>(
        'turn/start',
        {
          threadId: this.nativeThreadId,
          input: [{ type: 'text', text: req.prompt }],
        },
        60000,
      );
      const turn = (res.turn ?? {}) as Record<string, unknown>;
      pending.turnId = turn.id ? String(turn.id) : null;
      this.activity = 'generating';
      this.pushInfo();
    } catch (err) {
      this.settle(pending, { status: 'failed', errorClass: 'turn_start_failed', errorMessage: (err as Error).message });
    }
    const outcome = await done;
    clearTimeout(timer);
    return outcome;
  }

  private settle(
    pending: PendingTurn,
    o: { status: TurnOutcome['status']; errorClass?: string | null; errorMessage?: string | null },
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    if (this.pending === pending) this.pending = null;
    pending.resolve({
      status: o.status,
      text: pending.text,
      errorClass: o.errorClass ?? pending.errorClass,
      errorMessage: o.errorMessage ?? pending.errorMessage,
      observedModel: this.observedModel,
      reportedReasoning: this.observedReasoning,
      usage: pending.usage,
      durationMs: Date.now() - pending.startedAt,
    });
  }

  private async startThread(): Promise<void> {
    const profile = this.opts.profile;
    const params: Record<string, unknown> = {
      cwd: this.opts.cwd,
      approvalPolicy: profile.configRefs.approvalPolicy ?? 'on-request',
      sandbox: profile.configRefs.sandbox ?? 'workspace-write',
      cwdCompat: undefined,
    };
    delete params.cwdCompat;
    if (profile.requestedModel) params.model = profile.requestedModel;
    if (profile.configRefs.modelProvider) params.modelProvider = profile.configRefs.modelProvider;

    const resumeId = this.opts.resumeNativeSessionId;
    if (resumeId) {
      try {
        const r = await this.rpc.call<Record<string, unknown>>('thread/resume', { threadId: resumeId, ...params }, 60000);
        const th = (r.thread ?? {}) as Record<string, unknown>;
        this.nativeThreadId = String(th.id ?? resumeId);
        this.observedModel = th.model ? String(th.model) : null;
        this.detail = `已恢复线程 ${this.nativeThreadId}`;
        this.emit({ kind: 'notice', text: `已恢复原生线程 ${this.nativeThreadId}` });
        this.pushInfo();
        return;
      } catch (err) {
        this.emit({
          kind: 'notice',
          text: `原生恢复失败, 重建线程: ${(err as Error).message.slice(0, 200)}`,
        });
      }
    }
    const r = await this.rpc.call<Record<string, unknown>>('thread/start', params, 60000);
    const th = (r.thread ?? {}) as Record<string, unknown>;
    this.nativeThreadId = th.id ? String(th.id) : null;
    this.observedModel = th.model ? String(th.model) : null;
    this.observedReasoning = th.reasoningEffort ? String(th.reasoningEffort) : null;
    this.detail = `已创建线程 ${this.nativeThreadId}`;
    this.pushInfo();
  }

  async cancel(): Promise<CancelReceipt> {
    const at = new Date().toISOString();
    if (this.closed) return { confirmed: true, detail: '会话已关闭', at };
    if (!this.pending || !this.pending.turnId) {
      return { confirmed: true, detail: '当前没有进行中的回合', at };
    }
    const turnId = this.pending.turnId;
    try {
      await this.rpc.call('turn/interrupt', { threadId: this.nativeThreadId, turnId }, 15000);
    } catch (err) {
      return { confirmed: false, detail: `interrupt 请求失败: ${(err as Error).message.slice(0, 200)}`, at };
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.pending || this.pending.turnId !== turnId) {
        return { confirmed: true, detail: '已收到原生 turn/completed (中断)', at };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // 无法确认时终止进程
    this.expectedExit = true;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    return { confirmed: false, detail: '未在 15s 内确认中断, 已终止进程', at };
  }

  async respond(requestId: string, decision: 'approve' | 'deny' | 'answer', payload?: string): Promise<void> {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) throw new AdapterError('unknown_request', `未知的原生请求 ${requestId}`);
    this.pendingRequests.delete(requestId);
    let result: unknown;
    if (entry.method === 'ToolRequestUserInput') {
      const questions = (entry.params.questions ?? []) as Record<string, unknown>[];
      const answers: Record<string, unknown> = {};
      for (const q of questions) {
        const qid = String(q.id ?? '');
        answers[qid] = { answers: decision === 'answer' ? [payload ?? ''] : [] };
      }
      result = { answers };
    } else if (entry.method === 'mcpServer/elicitation/request') {
      result = { action: decision === 'approve' ? 'accept' : 'decline', content: payload ?? null };
    } else if (entry.method === 'PermissionsRequestApproval') {
      const requested = (entry.params.permissions ?? {}) as Record<string, unknown>;
      result = decision === 'approve' ? { permissions: requested, scope: 'turn' } : { permissions: {}, scope: 'turn' };
    } else {
      result = { decision: decision === 'approve' ? 'accept' : 'decline' };
    }
    this.rpc.respond(entry.nativeId, result);
    this.emit({ kind: 'request.resolved', requestId, outcome: decision });
    this.pushInfo();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.expectedExit = true;
    try {
      if (this.nativeThreadId) {
        await this.rpc.call('thread/close', { threadId: this.nativeThreadId }, 5000).catch(() => undefined);
      }
    } finally {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export function createCodexAdapter(opts: CodexAdapterOptions): CodexAdapter {
  return new CodexAdapter(opts);
}
