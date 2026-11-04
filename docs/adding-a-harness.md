# 新增一个 Harness(适配器)

本文说明怎样把一个**完整原生 harness**接进 Harness Hub。核心只有一句:实现 `HarnessAdapter`,
让引擎像驱动 Codex / Claude Code / DSH 那样驱动它 —— 引擎负责状态机、派发、审核、持久化,
适配器只负责"启动原生进程、发一轮提示、把原生事件翻译成统一事件"。

> 不是接模型 API。适配器必须复用该 harness 自己的进程/协议(stdio JSON-RPC、SDK、CLI),
> 这样工具调用、审批、沙箱、取消、原生会话续接才是真的。

## 0. 涉及的文件(只有这几处)

| 位置 | 要做什么 | 是否必须 |
| --- | --- | --- |
| `packages/contracts/src/types.ts:6-8` | `AdapterId` 联合类型 + `ADAPTER_IDS` 数组加新 id | 必须 |
| `packages/adapters/src/<id>.ts` | 新建适配器文件(实现 `HarnessAdapter`) | 必须 |
| `apps/server/src/index.ts:20` `buildAdapters()` | 注册实例 | 必须 |
| `apps/server/src/index.ts:40` `seedProfiles()` | 首次启动的示例执行配置(可跳过) | 可选 |
| `apps/server/src/homes.ts:14-23` | 私有 home 的凭据复制表(有独立配置目录才需要) | 可选 |
| `README.md` / `docs/compatibility.md` / `THIRD-PARTY-NOTICES.md` | 支持版本、限制、许可证 | 必须 |

前端、引擎、存储、调度、审核都不需要改:UI 的 `adapterId` 是泛化展示的,
`packages/contracts/src/api.ts` 的 `adapterId` 校验已经从 `ADAPTER_IDS` 派生。

## 1. 契约层:登记 id

`packages/contracts/src/types.ts`:

```ts
export type AdapterId = 'codex' | 'claude-code' | 'dsh' | 'hermes' | 'mock';

export const ADAPTER_IDS: AdapterId[] = ['codex', 'claude-code', 'dsh', 'hermes', 'mock'];
```

这两行是单一事实来源,API 的 Zod 校验会自动跟着变。

## 2. 适配器:必须实现的四个方法

`packages/adapters/src/types.ts` 里的接口(逐字):

```ts
export interface HarnessAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  readonly mock: boolean;
  probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult>;
  capabilities(profile: ExecutionProfile): Promise<CapabilityReport>;
  openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession>;
  privateHomeDir?(profile: ExecutionProfile): string | null;
}

export interface AdapterSession {
  readonly localId: string;
  readonly nativeSessionId: string | null;
  readonly adapterId: AdapterId;
  readonly inspection: SessionInspection;
  sendTurn(req: TurnRequest): Promise<TurnOutcome>;
  cancel(): Promise<CancelReceipt>;      // confirmed:false 表示"没确认到真的停了"
  respond(requestId: string, decision: 'approve' | 'deny' | 'answer', payload?: string): Promise<void>;
  close(): Promise<void>;
}
```

四条硬要求(验收会看):

1. **`probe(inspect)` 不花额度**:只握手/读版本;`probe(live)` 才真跑一个最小回合。
   两者结果都要写进 `ProbeResult.capability`。
2. **`cancel()` 必须诚实**:只有原生确认停止才 `confirmed: true`;超时未确认就返回
   `confirmed: false`(然后可杀进程),引擎据此把尝试记成 `interrupted` 而不是 `cancelled`。
3. **`inspection` 必须反映真实状态**:`connectionState` / `processHealth` / `activity` /
   `observedModel` 都从原生事件与进程检查推,不猜。
4. **进程退出码 0 不等于任务完成**:完成与否只看 `TurnOutcome.status` 与结果契约。

## 3. 骨架文件

`packages/adapters/src/hermes.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { newId, nowIso } from '../../core/src/util.js';
import type {
  AdapterEvent, AdapterHost, AdapterSession, CancelReceipt, CapabilityReport,
  ExecutionProfile, HarnessAdapter, OpenSessionOptions, ProbeResult,
  SessionInspection, TurnOutcome, TurnRequest,
} from './types.js';
import { AdapterError } from './types.js';

export interface HermesOptions {
  /** 可执行入口(项目内绝对路径), 由 apps/server 的 buildAdapters 传入。 */
  executable: string;
  /** 私有 home 的根目录(<root>/.local/homes), 每个执行配置一个子目录。 */
  homeRoot: string;
  defaultTimeoutMs?: number;
}

export class HermesAdapter implements HarnessAdapter {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes';
  readonly mock = false;

  constructor(private readonly opts: HermesOptions) {}

  private homeDir(profile: ExecutionProfile): string {
    return path.join(this.opts.homeRoot, `hermes-${profile.id}`);
  }

  privateHomeDir(profile: ExecutionProfile): string | null {
    return this.homeDir(profile);
  }

  async probe(profile: ExecutionProfile, mode: 'inspect' | 'live'): Promise<ProbeResult> {
    // 1) 握手: 起进程 → initialize → 读协议版本/模型 → (live) 跑一个最小回合 → 关闭。
    // 2) 错误要分类: executable_missing / auth_failed / protocol_mismatch / model_unavailable。
  }

  async capabilities(_profile: ExecutionProfile): Promise<CapabilityReport> {
    // 15 项逐条给 supported / unsupported / unknown, 并写 notes 说明证据。
  }

  async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    // spawn 原生进程, env 用 opts.env + 私有 home + 关闭遥测;
    // 返回 new HermesSession(...), 并在初始化完成后 host.onSessionInfo(localId, inspection)。
  }
}
```

会话内部要点:

```ts
class HermesSession implements AdapterSession {
  readonly localId = newId('chs');
  nativeSessionId: string | null = null;
  readonly adapterId = 'hermes' as const;
  inspection: SessionInspection = { /* pid, connectionState:'connecting', ... */ };

  async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
    // 发一轮提示 → 收集流式事件(host.onEvent) → 等本轮到终态 → 返回 TurnOutcome。
    // 结构化回合(req.expectsJson)通常不需要特殊处理: 引擎会给提示加信封并要求只输出 JSON。
  }
}
```

## 4. 事件翻译表

原生事件 → `AdapterEvent`,引擎据此发 `message.delta` / `tool.*` / `request.approval` 等持久化事件:

| 原生 | AdapterEvent |
| --- | --- |
| 增量文本 | `{ kind:'message.delta', text }` |
| 一轮完整文本 | `{ kind:'message.completed', text }` |
| 工具开始 | `{ kind:'tool.started', toolName, callId, inputSummary }` |
| 工具进度 | `{ kind:'tool.progress', callId, text }` |
| 工具结束 | `{ kind:'tool.completed', callId, ok, outputSummary }` |
| 审批请求 | `{ kind:'approval.requested', requestId, approvalKind, title, detail, scopeHash }` |
| 需要用户输入 | `{ kind:'user_input.requested', requestId, prompt }` |
| 审批已决 | `{ kind:'request.resolved', requestId, outcome }` |
| 活动变化 | `{ kind:'activity', activity:'generating'|'tool_running'|'idle' }` |
| 其它提示 | `{ kind:'notice', text }` |
| 原生错误 | `{ kind:'error', message, errorClass }` |

审批回填:引擎调 `respond(requestId, 'approve'|'deny'|'answer', payload)` →
适配器把决定翻译成该 harness 自己协议的响应(Codex 是 `{decision:'accept'}`,
ACP 是 optionId,Claude Code 是 `{behavior:'allow'}`)。

## 5. 注册

`apps/server/src/index.ts`:

```ts
import { HermesAdapter } from '../../../packages/adapters/src/hermes.js';

function buildAdapters(cfg: AppConfig): Record<string, HarnessAdapter> {
  const nm = path.join(cfg.root, 'node_modules');
  return {
    // ...
    hermes: new HermesAdapter({
      executable: path.join(nm, 'hermes-cli', 'bin', 'hermes.js'),
      homeRoot: cfg.homesDir,
    }),
  };
}
```

`seedProfiles()` 里可以再加一条**示例执行配置**(只在空库时写入),但真实使用建议在界面上
"新建执行配置":填 `adapterId`、`executableRef`、`configRefs.sourceHome`、`requestedModel`。

## 6. 私有 home 与凭据(隔离要求)

harness 往往把凭据、会话、缓存写在用户目录。本程序要求**全部写进项目内**:

1. 适配器把该 harness 的 home 环境变量指到 `privateHomeDir(profile)`
   (例如 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `DSH_HOME`);
2. 首次使用时由 `apps/server/src/homes.ts` 从原目录**只复制不移动**到私有 home,
   在 `COPY_FILES` / `COPY_DIRS` 里登记要复制哪些文件;
3. 环境里再注入 `TEMP` / `TMP` / 缓存目录(引擎已注入任务级路径),并关掉遥测/自动更新。

## 7. 上线前自检

1. `npx tsc -p tsconfig.json --noEmit` 通过;
2. 界面 → 执行配置 → 该配置 **inspect 探针** 返回 `ok:true` 且能力表齐全;
3. 打开 `liveEnabled` → **live 探针** 真跑一个短回合并成功(这是"认证可用"的唯一证据);
4. 建一个任务,只用这一个强模型跑通 `规划 → 批准 → 派发 → 产物登记 → 验证 → 审核 → 交付`;
5. `npm test` 全绿;把版本号、已知限制写进 `docs/compatibility.md`,
   许可证写进 `THIRD-PARTY-NOTICES.md`。

## 8. 常见坑

- **stdout 只放协议**:原生进程的日志必须走 stderr,否则 JSON 解析会被日志打断。
- **换行分隔 vs 长度前缀**:Codex app-server 与 ACP 都是 newline-delimited JSON-RPC,
  每条消息一行、不能换行。
- **请求 id 冲突**:服务端 → 客户端的请求(审批/输入)与客户端的调用要分开处理,
  收到没有 `method` 的 `id` 消息就是响应。
- **进程退出要先 reject 挂起的调用**,再标记 `connectionState='disconnected'`、
  `processHealth='exited'`,发 `notice`,否则引擎会一直等。
- **Windows 沙箱**:`workspace-write` 语义由各 harness 自己实现,能力不同;
  `capabilities.workspaceRestriction` 要如实标注,别默认 supported。
- **不要在适配器里做业务判断**(比如"要不要重试""谁审核"):那是引擎的事,
  适配器只如实报告本轮结果与错误分类。
