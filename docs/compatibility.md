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

### 工作区与权限模式如何下发

| 能力 | Codex | Claude Code | DSH |
| --- | --- | --- | --- |
| 工作目录 | `thread/start` 的 `cwd` | `query({cwd})` | ACP `session/new` 的 `cwd`(必须绝对路径) |
| 只读 | `sandbox: read-only`; 审批 `never` 让写操作直接失败 | `permissionMode: plan` + `canUseTool` 对 Write/Edit/Bash 直接 deny | 无协议支持 |
| 工作区内可写 | `sandbox: workspace-write` | `permissionMode: default`(逐次审批) | 无协议支持 |
| 完全权限 | `sandbox: danger-full-access`; 审批 `never` | `permissionMode: bypassPermissions` | 无协议支持 |

结论: Codex 与 Claude Code 的权限是**真生效**的(前者由 Rust 侧沙箱执行, 后者由 CLI 的 permissionMode + 我们的 `canUseTool` 兜底); DSH 的 ACP 没有沙箱字段, 只能靠提示词约束与产物审计, 界面上已如实标注。

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

### 可执行入口的解析顺序

「执行配置 → 可执行入口」按下面的顺序解析, 因此**本机已经装好的 harness 可以直接用**(本项目不自带副本):

1. 填了绝对路径 → 直接用(会校验存在)。
2. 填了命令名(如 `codex`) → 在 `PATH` 里按 `PATHEXT` 查找, 跳过同名的无扩展名 sh 脚本。
3. 留空 → 只按适配器名在 `PATH` 里找; 找不到就明确报错(提示装哪个 npm 包), 不会回落到项目内副本 —— 本项目不再内置任何 harness。

包装细节: `.js/.mjs/.cjs` 用当前 Node 执行; `.cmd/.bat` 经 `cmd.exe /d /s /c` 执行; `.ps1` 经
`powershell -NoProfile -ExecutionPolicy Bypass -File`; `.exe` 直接 spawn。Claude Code 的 SDK 需要真实
可执行文件, 所以 `.cmd` 垫片会被解析出内部 `claude.exe`, 指向 `.js` 时会退回项目内安装的版本并给出警告。

本机实测(2026-11-04): 入口填 `codex` → 解析到 `E:\nodejs\node_global\codex.cmd`, app-server 握手通过(0.166.0);
入口填 `claude` → 解析到全局 `claude.exe`(2.1.318)并跑通 live 回合; DSH 本机没有全局安装, 自动退回项目内 0.2.1-rc.5。
`tests/exec.test.ts` 覆盖了名字解析、js/exe 分支、留空回退与"入口不存在要报错"。

## 已知限制

1. Codex Windows 沙箱: `windowsSandbox/readiness` 返回 `updateRequired`, 未以管理员完成准备时隔离较弱。
   命令仍可执行并写入工作区; 本项目依赖"工作区 cwd + 写入范围 + 事后产物校验", 不宣称强制隔离。
2. DSH ACP 不支持 `session/load`、显式 elicitation; 用户输入类请求以 `unknown` 能力记录。
3. Claude Code 每次回合以 `resume` 续接会话; 若原生会话被清理, 会退化为新会话(事件中可见)。
4. 全局配置目录(`~/.codex`、`~/.claude`、`~/.dsh`)只读: 服务端把需要的文件**复制**到 `.local/homes/`, 不写回。
5. 单实例: 通过 `runtime_leases` 表 + 心跳实现; 异常退出后仅当原 PID 不存在才接管。

### 验证命令的执行环境

`validationCommand` 在任务工作区根目录执行, 通过系统外壳运行:

| 平台 | 执行方式 | 环境变量 | 注意 |
| --- | --- | --- | --- |
| Windows | `cmd.exe /d /s /c` | 继承本进程环境, 仅覆盖 TEMP/TMP/TMPDIR/XDG_CACHE_HOME/npm_config_cache/HH_TASK_ID | 没有 `grep/sed/awk/cat`; 路径分隔符要用 `\\`, `./x` 会被归一成 `.\\x` |
| Linux/macOS | `/bin/sh -c` | 同上 | 命令必须不交互, 退出码 0 才算通过 |

这条约束会写进计划提示(`VALIDATION_SHELL_NOTE`), 让模型按平台给出可执行的命令。
