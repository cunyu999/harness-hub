/**
 * 确定性 mock 适配器: 用于核心规则测试与无模型演示。
 * 所有输出都可预测; UI 与事件必须标注 mock 模式, 不能与真实运行混淆。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import type {
  AdapterId,
  CapabilityReport,
  ExecutionProfile,
  MonitorActivity,
} from '../../contracts/src/types.js';
import { parsePrompt } from './envelope.js';
import type {
  AdapterEvent,
  AdapterHost,
  AdapterSession,
  CancelReceipt,
  HarnessAdapter,
  OpenSessionOptions,
  ProbeResult,
  SessionInspection,
  TurnOutcome,
  TurnRequest,
} from './types.js';

interface MockSessionState {
  localId: string;
  cancelled: boolean;
  busy: boolean;
  inspection: SessionInspection;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function planFor(context: Record<string, unknown>): Record<string, unknown> {
  if (typeof context.mockPlan === 'object' && context.mockPlan !== null) {
    return context.mockPlan as Record<string, unknown>;
  }
  const participants = (context.participants as { id: string; role: string; isLead: boolean; name: string }[]) ?? [];
  const strong = participants.filter((p) => p.role === 'strong');
  const workers = participants.filter((p) => p.role === 'worker');
  const lead = strong.find((p) => p.isLead) ?? strong[0];
  const seeds = (context.workItemSeeds as string[]) ?? null;
  // 多个执行者时给出互不依赖的工作项, 用于演示并发泳道; 单个执行者保持串行。
  const parallel = workers.length >= 2;
  const count = seeds
    ? seeds.length
    : parallel
      ? Math.min(6, workers.length * 2)
      : Math.max(1, Math.min(2, workers.length || 2));
  const items = Array.from({ length: count }, (_, i) => {
    const assignee = workers[i % Math.max(1, workers.length)] ?? lead;
    const path = `${(context.outputDir as string) ?? 'deliverables'}/part-${i + 1}.md`;
    return {
      id: `wi-${i + 1}`,
      goal: seeds ? seeds[i] : `完成第 ${i + 1} 部分工作`,
      dependencies: parallel || i === 0 ? [] : [`wi-${i}`],
      assignedParticipantId: assignee ? assignee.id : null,
      inputs: [],
      expectedOutputs: [
        {
          label: `第 ${i + 1} 部分`,
          format: 'markdown',
          relativePath: path,
          template: null,
          validation: 'exists',
          validationCommand: null,
        },
      ],
      acceptanceCriteria: ['文件存在且内容非空', '覆盖分配的目标'],
      writeScope: [path],
      riskLevel: 'low',
    };
  });
  return {
    objective: context.objective ?? 'mock objective',
    constraints: context.constraints ?? [],
    assumptions: ['mock 适配器生成的确定性计划'],
    clarificationNeeded: [],
    workItems: items,
    deliverables: [
      {
        label: '汇总产物',
        format: (context.reportFormat as string) ?? 'markdown',
        templateRef: null,
        destination: (context.outputDir as string) ?? 'deliverables',
        validationMethod: '文件存在且内容非空',
        editableSource: null,
      },
    ],
    verificationSteps: ['检查每个承诺产物存在'],
    reviewPolicy: {
      strongParticipantIds: strong.map((p) => p.id),
      crossReviewRequired: strong.length >= 2,
    },
    changeScope: 'mock scope',
    risks: [],
    limits: {},
    unresolvedDecisions: [],
  };
}

export class MockAdapter implements HarnessAdapter {
  readonly id: AdapterId = 'mock';
  readonly displayName = 'Mock (确定性测试适配器)';
  readonly mock = true;

  constructor(private readonly host: AdapterHost | null = null) {}

  async probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult> {
    return {
      ok: true,
      mode,
      checkedAt: new Date().toISOString(),
      executableResolved: 'mock://deterministic',
      version: '1.0.0',
      protocol: 'in-process',
      detail: 'mock 适配器不启动任何原生进程',
      capability: await this.capabilities(profile),
      warnings: ['mock 模式, 不会调用真实模型'],
    };
  }

  async capabilities(_profile: ExecutionProfile): Promise<CapabilityReport> {
    const supported = {
      state: 'supported' as const,
      evidence: 'mock adapter contract test',
    };
    return {
      adapterId: 'mock',
      checkedAt: new Date().toISOString(),
      protocolVersion: '1.0.0',
      executable: 'mock://deterministic',
      version: '1.0.0',
      capabilities: {
        structuredOutput: supported,
        streamMessages: supported,
        toolEvents: supported,
        approvals: supported,
        userInput: supported,
        cancellation: supported,
        nativeResume: supported,
        modelSelection: { state: 'supported', evidence: 'requestedModel 原样回显' },
        reasoningSelection: { state: 'supported', evidence: 'requestedReasoning 原样回显' },
        imageInput: { state: 'unsupported' },
        fileInput: { state: 'unsupported' },
        skills: { state: 'unsupported' },
        mcp: { state: 'unsupported' },
        workspaceRestriction: { state: 'unsupported' },
        reportedModelIdentity: { state: 'supported', evidence: 'mock 直接报告请求值' },
      },
      notes: ['mock 适配器用于规则验证, 不代表任何真实 harness 能力'],
    };
  }

  async openSession(opts: OpenSessionOptions, hostArg?: AdapterHost): Promise<AdapterSession> {
    const host = hostArg ?? this.host;
    if (!host) throw new Error('MockAdapter 需要 AdapterHost');
    const state: MockSessionState = {
      localId: `mock-${Math.random().toString(36).slice(2, 10)}`,
      cancelled: false,
      busy: false,
      inspection: {
        pid: null,
        processRef: null,
        connectionState: 'connected',
        activity: 'idle',
        nativeSessionId: `mock-native-${Math.random().toString(36).slice(2, 10)}`,
        observedModel: opts.profile.requestedModel ?? 'mock-model',
        observedReasoning: opts.profile.requestedReasoning,
        detail: 'mock session',
      },
    };
    const self = this;
    const settleActivity = (a: MonitorActivity) => {
      state.inspection = { ...state.inspection, activity: a };
      host.onSessionInfo(state.localId, state.inspection);
    };

    const session: AdapterSession = {
      get localId() {
        return state.localId;
      },
      get nativeSessionId() {
        return state.inspection.nativeSessionId;
      },
      get adapterId() {
        return 'mock' as AdapterId;
      },
      get inspection() {
        return state.inspection;
      },
      async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
        const started = Date.now();
        const parsed = parsePrompt(req.prompt);
        const delay = Number(opts.env.HH_MOCK_DELAY_MS ?? '2');
        state.busy = true;
        state.cancelled = false;
        settleActivity('generating');
        const failMode = opts.env.HH_MOCK_FAIL ?? '';
        const emit = (ev: AdapterEvent) => host.onEvent(state.localId, ev);

        try {
          if (failMode === parsed.kind) {
            await sleep(delay);
            return {
              status: 'failed',
              text: '',
              errorClass: 'mock_failure',
              errorMessage: `mock 注入失败: ${failMode}`,
              observedModel: state.inspection.observedModel,
              reportedReasoning: null,
              usage: null,
              durationMs: Date.now() - started,
            };
          }

          const text = self.renderTurn(parsed, opts, emit, settleActivity);
          for (let i = 0; i < text.length; i += 120) {
            if (state.cancelled) return self.cancelledOutcome(started, state);
            await sleep(delay);
            emit({ kind: 'message.delta', text: text.slice(i, i + 120) });
          }
          if (state.cancelled) return self.cancelledOutcome(started, state);
          emit({ kind: 'message.completed', text });
          settleActivity('idle');
          return {
            status: 'completed',
            text,
            errorClass: null,
            errorMessage: null,
            observedModel: state.inspection.observedModel,
            reportedReasoning: null,
            usage: null,
            durationMs: Date.now() - started,
          };
        } finally {
          state.busy = false;
        }
      },
      async cancel(): Promise<CancelReceipt> {
        if (!state.busy) {
          return { confirmed: true, detail: 'mock 会话空闲, 无需停止', at: new Date().toISOString() };
        }
        state.cancelled = true;
        return { confirmed: true, detail: 'mock 会话已取消', at: new Date().toISOString() };
      },
      async respond(): Promise<void> {
        /* mock 无需回应 */
      },
      async close(): Promise<void> {
        state.inspection = {
          ...state.inspection,
          connectionState: 'disconnected',
          activity: 'unknown',
        };
        host.onSessionInfo(state.localId, state.inspection);
        host.onExit(state.localId, { code: 0, expected: true });
      },
    };
    host.onSessionInfo(state.localId, state.inspection);
    return session;
  }

  private cancelledOutcome(started: number, state: MockSessionState): TurnOutcome {
    return {
      status: 'cancelled',
      text: '',
      errorClass: null,
      errorMessage: null,
      observedModel: state.inspection.observedModel,
      reportedReasoning: null,
      usage: null,
      durationMs: Date.now() - started,
    };
  }

  private renderTurn(
    parsed: ReturnType<typeof parsePrompt>,
    opts: OpenSessionOptions,
    emit: (ev: AdapterEvent) => void,
    settleActivity: (a: MonitorActivity) => void,
  ): string {
    const ctx = parsed.context;
    switch (parsed.kind) {
      case 'plan':
      case 'plan.synthesize':
        emit({ kind: 'tool.started', toolName: 'mock.plan', callId: 'mock-plan', inputSummary: '生成计划' });
        emit({ kind: 'tool.completed', callId: 'mock-plan', ok: true, outputSummary: '计划已生成' });
        return JSON.stringify(planFor(ctx), null, 2);
      case 'discussion.proposal':
        return JSON.stringify(
          {
            summary: `基于目标提出方案 (${opts.profile.name})`,
            assumptions: ['mock 假设'],
            approach: ['拆分工作项', '验证产物'],
            workItems: (ctx.participants as unknown[])?.length ?? 0,
            risks: ['mock 风险'],
            openQuestions: [],
          },
          null,
          2,
        );
      case 'discussion.critique':
        return JSON.stringify(
          {
            critiques: [{ target: 'proposal', point: 'mock 质询: 需要明确验收', severity: 'minor' }],
            agreements: ['同意基本拆分'],
            disagreements: [],
            revisionSuggestions: ['补充验收标准'],
          },
          null,
          2,
        );
      case 'work': {
        const wi = (ctx.workItem ?? {}) as Record<string, unknown>;
        const outputs = (wi.expectedOutputs as { relativePath: string }[]) ?? [];
        emit({
          kind: 'tool.started',
          toolName: 'mock.write_file',
          callId: 'mock-write',
          inputSummary: outputs.map((o) => o.relativePath).join(', '),
        });
        settleActivity('tool_running');
        const written: string[] = [];
        for (const spec of outputs) {
          const rel = sanitizeRel(spec.relativePath);
          const abs = join(opts.cwd, rel);
          if (!isInside(opts.cwd, abs)) {
            emit({ kind: 'tool.completed', callId: 'mock-write', ok: false, outputSummary: '路径越界' });
            return JSON.stringify(
              {
                workItemId: parsed.workItemId,
                attemptId: opts.attemptId,
                status: 'failed',
                summary: '输出路径越界',
                artifactRefs: [],
                changes: [],
                verificationClaims: [],
                unresolvedIssues: ['输出路径越界'],
              },
              null,
              2,
            );
          }
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(
            abs,
            `# ${(wi.goal as string) ?? 'mock output'}\n\n由 ${opts.profile.name} 的 mock 会话生成。\n`,
            'utf8',
          );
          written.push(rel);
        }
        emit({ kind: 'tool.completed', callId: 'mock-write', ok: true, outputSummary: written.join(', ') });
        settleActivity('idle');
        if (opts.env.HH_MOCK_APPROVAL === '1') {
          emit({
            kind: 'approval.requested',
            requestId: `mock-req-${Date.now()}`,
            approvalKind: 'command_execution',
            title: 'mock: 请求执行命令',
            detail: 'mock 审批请求, 仅用于验证审批链路',
            scopeHash: 'mock-scope',
          });
        }
        return JSON.stringify(
          {
            workItemId: parsed.workItemId,
            attemptId: opts.attemptId,
            status: 'completed',
            summary: `已完成 ${(wi.goal as string) ?? '工作项'}`,
            artifactRefs: written,
            changes: written,
            verificationClaims: [{ check: '文件写入', status: 'passed' }],
            unresolvedIssues: [],
          },
          null,
          2,
        );
      }
      case 'review': {
        return JSON.stringify(
          {
            verdict: 'approve',
            summary: 'mock 审核通过',
            findings: [],
            crossChecked: [],
          },
          null,
          2,
        );
      }
      case 'review.crosscheck': {
        // 交叉复核: 对提示里列出的其它席位摘要逐条表态, 便于验证"交叉复核真的发生过"。
        const section = parsed.instruction.split('其他席位的审核摘要与问题:')[1] ?? '';
        const names = section
          .split('\n')
          .filter((line) => line.startsWith('### '))
          .map((line) => line.replace(/^###\s+/, '').trim());
        const crossChecked = names.map((name) => ({
          findingId: `${name}:verdict`,
          stance: 'agree',
          note: `mock 复核席位「${name}」的结论: 已对照产物与验证记录, 无补充异议。`,
        }));
        return JSON.stringify(
          {
            verdict: 'approve',
            summary: names.length > 0 ? `mock 交叉复核 ${names.length} 个席位结论, 全部认同` : 'mock 审核通过',
            findings: [],
            crossChecked,
          },
          null,
          2,
        );
      }
      case 'integrate':
        return JSON.stringify({ status: 'completed', summary: 'mock 集成完成', issues: [] }, null, 2);
      case 'deliver':
        return JSON.stringify({ status: 'completed', summary: 'mock 交付说明' }, null, 2);
      default:
        return `mock 回复: ${parsed.instruction.slice(0, 200)}`;
    }
  }
}

function sanitizeRel(p: string): string {
  return normalize(p).replace(/^([/\\])+/, '').split('..').join('_');
}

function isInside(root: string, target: string): boolean {
  const r = normalize(root).toLowerCase();
  const t = normalize(target).toLowerCase();
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}
