/**
 * Claude Code 适配器: 通过官方 @anthropic-ai/claude-agent-sdk 驱动项目内安装的
 * Claude Code 原生 CLI (claude.exe)。保留原生工具、权限审批、流式消息、
 * 会话恢复与中断能力, 不使用模型 API 直接替代 harness。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { accessSync, constants } from 'node:fs';
import type { CapabilityReport, ExecutionProfile } from '../../contracts/src/types.js';
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
import { newId } from '../../core/src/util.js';
import { resolveClaudeBinary } from './exec.js';

/**
 * 权限模式 → Claude Code 的 permissionMode。
 * read-only 用 plan(只读规划, 不落盘), danger-full-access 用 bypassPermissions,
 * workspace-write 用 default(由 canUseTool 决定放行或询问)。
 */
function claudePermission(mode: ExecutionProfile['sandbox']): 'plan' | 'default' | 'bypassPermissions' {
  if (mode === 'read-only') return 'plan';
  if (mode === 'danger-full-access') return 'bypassPermissions';
  return 'default';
}

/** 会改动磁盘的工具名。只读模式下这些一律拒绝。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'bash']);

export interface ClaudeAdapterOptions {
  /** 可选兜底可执行文件; 不填时优先执行配置/PATH, 都没有就用 SDK 自带的可执行文件 */
  executable?: string;
  /** 项目内私有配置根目录 */
  configRoot: string;
  defaultTimeoutMs?: number;
}

type PendingApproval = {
  resolve: (v: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }) => void;
  input: Record<string, unknown>;
};

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly mock = false;

  constructor(private readonly opts: ClaudeAdapterOptions) {}

  private configDirFor(profile: ExecutionProfile): string {
    return path.join(this.opts.configRoot, `claude-${profile.id}`);
  }

  /**
   * Claude Code 的 SDK 需要真正的可执行文件, 不能是 .cmd/.ps1 垫片。
   * 这里允许执行配置指向本机已装的 claude(.cmd 会自动解析出真实 exe), 留空则先找 PATH, 再退回项目内安装的版本。
   */
  private resolveExe(profile: ExecutionProfile): {
    executable: string | null;
    source: 'profile' | 'path' | 'sdk';
    note?: string;
  } {
    return resolveClaudeBinary(profile.executableRef, this.opts.executable);
  }

  private executableFor(profile: ExecutionProfile): string | null {
    return this.resolveExe(profile).executable;
  }

  async probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const resolved = this.resolveExe(profile);
    const exe = resolved.executable;
    const warnings: string[] = [];
    if (resolved.note) warnings.push(resolved.note);
    if (!exe) warnings.push('未检测到本机 claude, 使用 SDK 自带的可执行文件');
    let version: string | null = null;
    let versionDetail = '';
    if (exe) {
      try {
        accessSync(exe, constants.X_OK);
      } catch {
        // Windows 上 X_OK 检查经常失败, 交给后续执行判断
      }
      try {
        const out = await new Promise<string>((resolve, reject) => {
          execFile(exe, ['--version'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out.trim().slice(0, 40);
        versionDetail = out.trim().split('\n')[0] ?? '';
      } catch (err) {
        return {
          ok: false,
          mode,
          checkedAt,
          executableResolved: exe,
          version: null,
          protocol: null,
          detail: `无法执行 ${exe}: ${(err as Error).message.slice(0, 300)}`,
          capability: null,
          warnings,
        };
      }
    } else {
      versionDetail = 'SDK 自带可执行文件';
    }

    const capability: CapabilityReport = {
      adapterId: 'claude-code',
      checkedAt,
      protocolVersion: 'agent-sdk/0.3',
      executable: exe ?? undefined,
      version: version ?? undefined,
      capabilities: {
        structuredOutput: { state: 'supported', evidence: 'outputFormat/json_schema 与提示层约束' },
        streamMessages: { state: 'supported', evidence: 'includePartialMessages + stream_event' },
        toolEvents: { state: 'supported', evidence: 'assistant tool_use / user tool_result' },
        approvals: { state: 'supported', evidence: 'canUseTool 回调' },
        userInput: { state: 'supported', evidence: 'canUseTool 输入请求' },
        cancellation: { state: 'supported', evidence: 'abortController + interrupt()' },
        nativeResume: { state: 'supported', evidence: 'options.resume = session_id' },
        modelSelection: { state: 'supported', evidence: 'options.model / setModel' },
        reasoningSelection: { state: 'supported', evidence: 'options.effort / thinking' },
        imageInput: { state: 'supported', evidence: '内容块支持图片' },
        fileInput: { state: 'supported', evidence: 'Read 工具与附件' },
        skills: { state: 'supported', evidence: 'options.skills / settingSources' },
        mcp: { state: 'supported', evidence: 'options.mcpServers' },
        workspaceRestriction: { state: 'supported', evidence: 'cwd + canUseTool 路径校验 + 原生 sandbox 设置' },
        reportedModelIdentity: { state: 'supported', evidence: 'system/init 的 model 与 session_id' },
      },
      notes: [
        '使用项目内 claude.exe, 配置目录指向 .local/homes 下的私有目录',
        'Windows 上 Bash 工具可用性取决于本机 Git Bash / WSL 环境',
      ],
    };

    let liveOk = true;
    let liveError = '';
    if (mode === 'live') {
      try {
        const res = await this.runOneShot(profile, '只回复 OK 两个字母, 不要使用任何工具。', 90000);
        // 只有真实回合成功才算 live 通过: 进程能起来、认证能过, 但模型名不对时回合会失败,
        // 这种情况必须报 ok:false, 否则"探针通过"会掩盖真实错误。
        liveOk = res.status === 'completed';
        warnings.push(liveOk ? `live 回合状态: ${res.status}` : `live 回合状态: ${res.status} ${res.errorMessage ?? ''}`.trim());
        if (!liveOk) liveError = res.errorMessage ?? `回合状态 ${res.status}`;
      } catch (err) {
        liveOk = false;
        liveError = (err as Error).message;
        warnings.push(`live 回合失败: ${liveError.slice(0, 200)}`);
      }
    }

    return {
      ok: liveOk,
      mode,
      checkedAt,
      executableResolved: exe,
      version,
      protocol: 'claude-agent-sdk (原生 CLI 子进程)',
      detail: liveOk
        ? `${versionDetail}${mode === 'live' ? '; 已执行真实回合' : '; 仅版本探测'}`
        : `${versionDetail}; live 回合失败: ${liveError.slice(0, 160)}`,
      capability,
      warnings,
    };
  }

  async capabilities(profile: ExecutionProfile): Promise<CapabilityReport> {
    const r = await this.probe(profile, 'inspect');
    return (
      r.capability ?? {
        adapterId: 'claude-code',
        checkedAt: new Date().toISOString(),
        capabilities: {},
        notes: [r.detail],
      }
    );
  }

  private sessionEnv(profile: ExecutionProfile, extra: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v;
    }
    delete base.CLAUDE_CONFIG_DIR;
    return {
      ...base,
      ...profile.env,
      ...extra,
      CLAUDE_CONFIG_DIR: this.configDirFor(profile),
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
    };
  }

  /** 一次性回合, 供 live 探测使用。 */
  private async runOneShot(profile: ExecutionProfile, prompt: string, timeoutMs: number): Promise<TurnOutcome> {
    const cfgDir = this.configDirFor(profile);
    const controller = new AbortController();
    let text = '';
    let status: TurnOutcome['status'] = 'unknown';
    let errorMessage: string | null = null;
    let stderrTail = '';
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const q = query({
        prompt,
        options: {
          cwd: profile.workspaceRoot,
          model: profile.requestedModel ?? undefined,
          ...(this.executableFor(profile) ? { pathToClaudeCodeExecutable: this.executableFor(profile) as string } : {}),
          env: this.sessionEnv(profile, {}),
          abortController: controller,
          permissionMode: claudePermission(profile.sandbox),
          includePartialMessages: false,
          settingSources: ['user', 'project'],
          maxTurns: 4,
          // 把子进程 stderr 留下来: 模型名/鉴权失败时 CLI 只往 stderr 写原因,
          // SDK 自己抛的往往只是 "Operation aborted"。
          stderr: (line: string) => {
            stderrTail = (stderrTail + line).slice(-600);
          },
        } as never,
      });
      try {
        for await (const msg of q) {
          if (msg.type === 'assistant') {
            const blocks = ((msg.message?.content ?? []) as unknown) as Record<string, unknown>[];
            for (const b of blocks) if (b.type === 'text') text += String(b.text ?? '');
          } else if (msg.type === 'result') {
            const r = msg as unknown as Record<string, unknown>;
            if (typeof r.result === 'string' && r.result.length > 0) text = r.result;
            status = r.subtype === 'success' ? 'completed' : 'failed';
            if (status === 'failed') errorMessage = String(r.subtype ?? 'result_error');
          }
        }
      } catch (err) {
        status = 'failed';
        const base = (err as Error).message || 'query_failed';
        const tail = stderrTail.trim().replace(/\s+/g, ' ').slice(-240);
        errorMessage = tail ? `${base}: ${tail}` : base;
      }
      void cfgDir;
      if (status === 'unknown') status = 'failed';
      return {
        status,
        text,
        errorClass: errorMessage,
        errorMessage,
        observedModel: null,
        reportedReasoning: null,
        usage: null,
        durationMs: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    return new ClaudeSession(opts, host, {
      executable: this.executableFor(opts.profile) ?? undefined,
      env: this.sessionEnv(opts.profile, opts.env),
      defaultTimeoutMs: this.opts.defaultTimeoutMs ?? 30 * 60_000,
    });
  }

  privateHomeDir(profile: ExecutionProfile): string {
    return this.configDirFor(profile);
  }
}

interface ClaudeSessionDeps {
  executable?: string;
  env: Record<string, string>;
  defaultTimeoutMs: number;
}

class ClaudeSession implements AdapterSession {
  readonly adapterId = 'claude-code' as const;
  readonly localId: string;
  private nativeId: string | null = null;
  private readonly approvals = new Map<string, PendingApproval>();
  private controller: AbortController | null = null;
  private active = false;
  private closed = false;
  private observedModel: string | null = null;
  private observedEffort: string | null = null;
  private activity: SessionInspection['activity'] = 'idle';
  private detail = '已创建 Claude Code 会话包装';
  private lastPid: number | null = null;
  private turnCount = 0;

  constructor(
    private readonly opts: OpenSessionOptions,
    private readonly host: AdapterHost,
    private readonly deps: ClaudeSessionDeps,
  ) {
    this.localId = newId('ccl');
    this.nativeId = opts.resumeNativeSessionId ?? null;
  }

  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  get inspection(): SessionInspection {
    return {
      pid: this.lastPid,
      processRef: this.lastPid
        ? {
            pid: this.lastPid,
            startedAt: new Date().toISOString(),
            runtimeNonce: this.localId,
            command: this.deps.executable ?? 'claude (SDK 内置)',
          }
        : null,
      connectionState: this.closed ? 'disconnected' : 'connected',
      activity: this.activity,
      nativeSessionId: this.nativeId,
      observedModel: this.observedModel,
      observedReasoning: this.observedEffort,
      detail: this.detail,
    };
  }

  private emit(ev: AdapterEvent): void {
    this.host.onEvent(this.localId, ev);
  }

  private info(): void {
    this.host.onSessionInfo(this.localId, this.inspection);
  }

  async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
    if (this.closed) throw new AdapterError('session_closed', '会话已关闭');
    if (this.active) throw new AdapterError('turn_in_flight', '同一会话已有进行中的回合');
    this.active = true;
    const started = Date.now();
    const controller = new AbortController();
    this.controller = controller;
    const timeoutMs = req.timeoutMs > 0 ? req.timeoutMs : this.deps.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = '';
    let status: TurnOutcome['status'] = 'unknown';
    let errorClass: string | null = null;
    let errorMessage: string | null = null;
    let usage: Record<string, unknown> | null = null;
    let sawResult = false;

    this.activity = 'generating';
    this.info();

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const options: Record<string, unknown> = {
        cwd: this.opts.cwd,
        model: this.opts.profile.requestedModel ?? undefined,
        pathToClaudeCodeExecutable: this.deps.executable,
        env: this.deps.env,
        abortController: controller,
        includePartialMessages: true,
        permissionMode: claudePermission(this.opts.profile.sandbox),
        settingSources: ['user', 'project'],
        stderr: (data: string) => {
          if (/error/i.test(data) && data.trim().length > 0) {
            this.emit({ kind: 'notice', text: data.trim().slice(0, 300) });
          }
        },
        canUseTool: async (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown>) => {
          const mode = this.opts.profile.sandbox;
          // 只读配置: 写类工具直接拒, 不浪费一次人工审批
          if (mode === 'read-only' && WRITE_TOOLS.has(toolName)) {
            return { behavior: 'deny', message: '当前执行配置是只读权限, 不允许修改文件或执行命令' };
          }
          const requestId = newId('apr');
          this.activity = 'idle';
          this.info();
          this.emit({
            kind: 'approval.requested',
            requestId,
            approvalKind: `claude:${toolName}`,
            title: `允许执行 ${toolName}?`,
            detail: JSON.stringify(input).slice(0, 800),
            scopeHash: requestId,
          });
          const decision = await new Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }>(
            (resolve) => {
              this.approvals.set(requestId, { resolve, input });
              const signal = extra.signal as AbortSignal | undefined;
              signal?.addEventListener('abort', () => {
                if (this.approvals.delete(requestId)) {
                  resolve({ behavior: 'deny', message: '已取消' });
                }
              });
            },
          );
          this.activity = 'tool_running';
          this.info();
          return decision;
        },
      };
      if (this.opts.profile.requestedReasoning) {
        options.effort = this.opts.profile.requestedReasoning;
      }
      if (this.nativeId) options.resume = this.nativeId;
      const prompt = req.prompt;
      this.turnCount += 1;
      const q = query({ prompt, options: options as never });
      for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
        const type = String(msg.type ?? '');
        if (type === 'system') {
          const subtype = String(msg.subtype ?? '');
          if (subtype === 'init') {
            if (typeof msg.session_id === 'string') this.nativeId = msg.session_id;
            if (typeof msg.model === 'string') this.observedModel = msg.model;
            this.detail = `Claude Code 会话 ${this.nativeId}`;
            this.emit({ kind: 'notice', text: `原生会话已建立: ${this.nativeId}` });
            this.info();
          } else if (subtype === 'status') {
            const st = String(msg.status ?? '');
            if (st === 'compacting' || st === 'requesting') this.activity = 'generating';
            this.info();
          }
        } else if (type === 'stream_event') {
          const ev = (msg.event ?? {}) as Record<string, unknown>;
          if (ev.type === 'content_block_delta') {
            const delta = (ev.delta ?? {}) as Record<string, unknown>;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              text += delta.text;
              this.activity = 'generating';
              this.emit({ kind: 'message.delta', text: delta.text });
            }
          } else if (ev.type === 'content_block_start') {
            const block = (ev.content_block ?? {}) as Record<string, unknown>;
            if (block.type === 'tool_use') {
              this.activity = 'tool_running';
              this.emit({
                kind: 'tool.started',
                toolName: String(block.name ?? 'tool'),
                callId: String(block.id ?? ''),
                inputSummary: JSON.stringify(block.input ?? {}).slice(0, 500),
              });
              this.info();
            }
          }
        } else if (type === 'assistant') {
          const message = (msg.message ?? {}) as Record<string, unknown>;
          if (typeof message.model === 'string') this.observedModel = message.model;
          const blocks = (message.content ?? []) as Record<string, unknown>[];
          for (const b of blocks) {
            if (b.type === 'tool_use') {
              this.emit({
                kind: 'tool.started',
                toolName: String(b.name ?? 'tool'),
                callId: String(b.id ?? ''),
                inputSummary: JSON.stringify(b.input ?? {}).slice(0, 500),
              });
            } else if (b.type === 'text' && text.length === 0) {
              // 没有流式增量时(例如 aborted 前), 用完整块保底
              text += String(b.text ?? '');
            }
          }
        } else if (type === 'user') {
          const message = (msg.message ?? {}) as Record<string, unknown>;
          const blocks = (message.content ?? []) as Record<string, unknown>[];
          for (const b of blocks) {
            if (b.type === 'tool_result') {
              const content = b.content;
              const summary =
                typeof content === 'string'
                  ? content.slice(0, 800)
                  : JSON.stringify(content ?? '').slice(0, 800);
              this.emit({
                kind: 'tool.completed',
                callId: String(b.tool_use_id ?? ''),
                ok: !b.is_error,
                outputSummary: summary,
              });
            }
          }
          this.activity = 'generating';
        } else if (type === 'tool_progress') {
          this.emit({
            kind: 'tool.progress',
            callId: String(msg.tool_use_id ?? ''),
            text: String(msg.message ?? '').slice(0, 300),
          });
        } else if (type === 'result') {
          sawResult = true;
          const subtype = String(msg.subtype ?? '');
          if (typeof msg.result === 'string' && msg.result.length > 0) text = msg.result;
          usage = (msg.usage ?? null) as Record<string, unknown> | null;
          if (subtype === 'success') status = 'completed';
          else if (subtype === 'error_max_turns') {
            status = 'failed';
            errorClass = 'max_turns';
          } else if (subtype === 'error_during_execution') {
            status = controller.signal.aborted ? 'cancelled' : 'failed';
            errorClass = controller.signal.aborted ? null : 'execution_error';
          } else {
            status = 'failed';
            errorClass = subtype || 'result_error';
          }
          if (typeof msg.total_cost_usd === 'number') {
            // 按产品要求不计算/展示费用, 仅忽略该字段
          }
        } else if (type === 'auth_status') {
          const msgText = String((msg as Record<string, unknown>).message ?? '认证状态变化');
          this.emit({ kind: 'notice', text: msgText.slice(0, 200) });
        }
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      status = aborted ? 'cancelled' : 'failed';
      errorClass = aborted ? null : 'sdk_error';
      errorMessage = (err as Error).message.slice(0, 500);
      if (!aborted) this.emit({ kind: 'error', message: errorMessage, errorClass: 'sdk_error' });
    } finally {
      clearTimeout(timer);
      this.active = false;
      this.controller = null;
      this.activity = 'idle';
      this.info();
    }

    if (!sawResult && status === 'unknown') status = controller.signal.aborted ? 'cancelled' : 'failed';
    if (status === 'cancelled') this.emit({ kind: 'notice', text: 'Claude Code 回合已中断' });
    if (text.length > 0) this.emit({ kind: 'message.completed', text });
    return {
      status,
      text,
      errorClass,
      errorMessage,
      observedModel: this.observedModel,
      reportedReasoning: this.observedEffort,
      usage,
      durationMs: Date.now() - started,
    };
  }

  async cancel(): Promise<CancelReceipt> {
    const at = new Date().toISOString();
    if (!this.active || !this.controller) {
      return { confirmed: true, detail: '当前没有进行中的回合', at };
    }
    this.controller.abort();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.active) return { confirmed: true, detail: '已确认回合中断', at };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { confirmed: false, detail: 'abort 后 15s 内未确认结束', at };
  }

  async respond(requestId: string, decision: 'approve' | 'deny' | 'answer', payload?: string): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) throw new AdapterError('unknown_request', `未知的审批请求 ${requestId}`);
    this.approvals.delete(requestId);
    if (decision === 'approve') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: 'deny', message: payload ?? '用户在 Harness Hub 中拒绝' });
    }
    this.emit({ kind: 'request.resolved', requestId, outcome: decision });
    this.info();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.controller) this.controller.abort();
    for (const [, p] of this.approvals) p.resolve({ behavior: 'deny', message: '会话关闭' });
    this.approvals.clear();
    this.activity = 'unknown';
    this.info();
    this.host.onExit(this.localId, { code: 0, expected: true });
  }
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ClaudeAdapter {
  return new ClaudeAdapter(opts);
}
