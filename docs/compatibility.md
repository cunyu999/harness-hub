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

## 已知限制

1. Codex Windows 沙箱: `windowsSandbox/readiness` 返回 `updateRequired`, 未以管理员完成准备时隔离较弱。
   命令仍可执行并写入工作区; 本项目依赖"工作区 cwd + 写入范围 + 事后产物校验", 不宣称强制隔离。
2. DSH ACP 不支持 `session/load`、显式 elicitation; 用户输入类请求以 `unknown` 能力记录。
3. Claude Code 每次回合以 `resume` 续接会话; 若原生会话被清理, 会退化为新会话(事件中可见)。
4. 全局配置目录(`~/.codex`、`~/.claude`、`~/.dsh`)只读: 服务端把需要的文件**复制**到 `.local/homes/`, 不写回。
5. 单实例: 通过 `runtime_leases` 表 + 心跳实现; 异常退出后仅当原 PID 不存在才接管。
