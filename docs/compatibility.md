# 兼容性与支持版本

## 运行时

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.15.0(开发机) | 必须 >= 24: 使用内置 `node:sqlite`(P0 已验证) |
| 操作系统 | Windows 11(开发机) | 路径安全与 shell 调用按 Windows 语义实现, 同时保留 POSIX 分支 |
| SQLite | 内置(WAL) | `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` |

## 原生 harness

| harness | 项目内安装版本 | 接入方式 | 已核验内容 |
| --- | --- | --- | --- |
| Codex | `@openai/codex` 0.166.0 | `codex app-server`, 行分隔 JSON-RPC 2.0 | initialize / thread/start / turn/start / turn/interrupt / 通知与审批请求形状(真实模型回复与工具执行); `inspect` 握手通过 |
| Claude Code | `@anthropic-ai/claude-code` 2.1.317 + `@anthropic-ai/claude-agent-sdk` 0.3.317 | Agent SDK `query()` | 版本探测、SDK 消息类型、`canUseTool` 审批回调; **live 真实回合通过**(`completed`, 3961ms) |
| DeepSeek Harness | `@deepseek-ai/dsh` 0.2.1-rc.5 + `@agentclientprotocol/sdk` 1.4.0 | `dsh --profile acp`, ACP stdio | 方法集合、`session/update` 与 `session/request_permission`; **live 真实回合通过**(`stopReason=end_turn`, 13443ms) |

### live 探针语义

- Claude Code: 以 `query()` 跑一个 `maxTurns=4` 的最小回合(要求只回 `OK`), 记录 `subtype` 与耗时。
- DSH: `initialize` → `session/new` → `session/prompt`(最小提示) → `session/close`, 记录 `stopReason`。
  只建会话不跑回合无法区分"认证可用"与"模型不可用", 因此 live 探针包含一次真实回合。
- Codex: `initialize` → 可选 `model/list` 校验认证; **本轮未执行 live 回合**(用户仅授权 Claude Code 与 DSH 调用)。

证据文件: `docs/evidence/live-probe-2026-11-03.json`。

### 执行配置里的模型 / 推理强度如何生效

执行配置面板里的**模型**与**推理强度**不会改写 harness 的配置文件, 只对**本程序发起的会话**做覆盖:

| harness | 模型 | 推理强度 | 下发方式 |
| --- | --- | --- | --- |
| Codex | 会话级(代码路径已确认, 未 live 验证) | 会话级(同上) | `thread/start` / `turn/start` 的 `model` / `effort` 字段 |
| Claude Code | **已验证生效**: 填不存在的模型会报 `[claude-code:unrecognized_model] {"model":"..."}` | **未验证**: 填非法值不报错, 可能被忽略 | Agent SDK `query({ options: { model, effort } })` |
| DeepSeek Harness | **已验证生效**: 非法模型报 `unknown model option: ...` | **已验证生效**: 非法值报 `unknown reasoning effort for deepseek-official/deepseek-v4-flash: ...` | ACP `session/set_config_option` 的 `model` / `reasoning_effort` |

- 留空即使用 harness 自己配置里的模型(例如 Codex 的 `config.toml`、Claude 的 `settings.json`/cc-switch、DSH 的 `cordis.yml`), 本程序不代管这些配置。
- 因为 Claude Code 对 `effort` 字符串不校验, web 面板在该字段下如实标注"可能被忽略", 需要精确控制时请用模型别名或 harness 自己的配置。
- 证据: `docs/evidence/model-override-2026-11-04.json`(用非法值反证参数确实下发, 再还原为空值确认恢复)。

live 探针的判定同时在这次核验中收紧: 只有**真实回合成功**才算 `ok`(Claude `result.subtype=success`、DSH `stopReason=end_turn`、Codex `model/list` 非空), 失败会带子进程 stderr 摘要, 不再一律报成功。

## 已知限制

1. Codex Windows 沙箱: `windowsSandbox/readiness` 返回 `updateRequired`, 未以管理员完成准备时隔离较弱。
   命令仍可执行并写入工作区; 本项目依赖"工作区 cwd + 写入范围 + 事后产物校验", 不宣称强制隔离。
2. DSH ACP 不支持 `session/load`、显式 elicitation; 用户输入类请求以 `unknown` 能力记录。
3. Claude Code 每次回合以 `resume` 续接会话; 若原生会话被清理, 会退化为新会话(事件中可见)。
4. 全局配置目录(`~/.codex`、`~/.claude`、`~/.dsh`)只读: 服务端把需要的文件**复制**到 `.local/homes/`, 不写回。
5. 单实例: 通过 `runtime_leases` 表 + 心跳实现; 异常退出后仅当原 PID 不存在才接管。
