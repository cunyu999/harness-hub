# 交接文档(work.md)

> 写于 2026-11-09。给"完全没有上文"的下一个对话看: 说明我们在做什么、做到哪、卡在哪、下一步、千万别踩的坑、以及项目长什么样。
> 项目根目录: **D:\1hobby**(Windows, 所有代码/依赖/数据/日志都必须在这个目录内)

---

## 0. 一句话概括

我们在做一个**本机运行的多 Harness 统一调度系统**(代号 Harness Hub): 用户在网页上建任务、选主控/强模型/执行者, 程序驱动**真实安装的 Codex、Claude Code、DeepSeek Harness** 去规划→讨论→执行→验证→交叉审核→交付, 并把全过程用事件流实时画出来。
不是"几个模型 API 拼一个聊天框", 而是把原生 harness 当子进程接进来, 保留它们自己的工具、沙箱、审批与技能。

技术栈: **TypeScript + Node 24 + React + SQLite(内置 node:sqlite)**; 后端 `node:http` 手写路由; 前端 Vite + React; 无 Electron、无 express、无 better-sqlite3。

---

## 1. 用户目标与不可违反的硬约束

来自最初的需求文档(`START_HERE.md`、`SYSTEM_BLUEPRINT.md`)与后续对话裁定:

1. **参与者由用户每次指定**: 主控、强模型集合、执行者。程序不得擅自加人、换模型、降推理档、砍工具能力。
2. **只有 1 个强模型**: 它自己规划 + 调度 + 终审。**≥2 个强模型**: 必须先讨论方案, 执行后**交叉复核**(不允许某个强模型失败就悄悄减人)。
3. **计划必须用户批准**: 三选一「直接执行 / 补充内容 / 重新计划」; 批准**绑定确切版本**——必须同时带 `planRevisionId + planHash + participantsRevision + expectedTaskVersion`。批准后范围内自主执行, 范围变化要重新确认。
4. **任务类型/输出格式通用**: 不写死"报告模式/代码模式"; 用户指定模板优先; 未指定格式的报告才建议 Word。
5. **状态只来自真实信号**: 原生事件 + 连接 + 进程检查。**不额外调模型问进度**, 不编造百分比, 不监控本程序之外启动的会话。
6. **图形由真实事件驱动**, 不能用动画/mock 冒充。
7. **不做价格/费用/节省额/自动价格路由**(有意不做)。
8. **所有产物留在项目内**: 代码、依赖、缓存、虚拟环境、日志、临时文件、测试、构建产物一律在 `D:\1hobby`; 不全局安装、不改外部全局配置、不写系统文件; harness 认证目录只读探测, 需要时**复制**进项目内私有 home。
9. 删除/覆盖用户数据、Git push、发布需另行确认; 只说"停止"不等于已停止; 进程 0 退出不等于任务完成。
10. 全程中文沟通; 如实区分「已实现 / 已验证 / 未验证 / 受阻」。

---

## 2. 已完成的系统(功能层面)

### 2.1 引擎与状态机(`packages/core`)
- `phase` 与 `lifecycle` **正交**: phase ∈ intake/planning/discussion/execution/integration/verification/review/delivery; lifecycle ∈ draft/awaiting_plan_approval/active/waiting_user/paused/blocked/cancelled/completed/failed。
- 计划校验(`plan.ts`): 依赖必须存在、无环、写入范围冲突检测、审核席位必须覆盖全部强模型、工作项上限。
- 调度器(`scheduler.ts` 的 `selectDispatchable`): 依赖就绪 + 写入范围互斥 + 每配置并发上限 + 全局并发。
- 计划版本: 每次 `plan` 产生新 revision; 批准记录哈希; 返工产生 v2 时**旧批准留痕**(`approvedPlanRevisionId` 仍指 v1), 新的 v2 是 `proposed`, 需再次批准。
- 失败处理: 单项重试、`needs_input`(用户回答后恢复)、salvage(harness 崩但产物已通过验证就接受)、`VALIDATION_NOISE` 守卫(退出码 0 但输出含 `FINDSTR: Cannot open` 等一律判失败)。
- token 用量: 只取 harness 原生上报(`usage` 事件/outcome), 归一化后聚合到任务与每个席位; 界面实时显示「Σ tokens」「进行中 +N tokens」。

### 2.2 存储(`packages/storage`)
- `node:sqlite` 的 `DatabaseSync`, WAL, `busy_timeout=5000`; 迁移 1–5(`schema_migrations`)。
- 主要表: `tasks, participants, plan_revisions, plan_approvals, work_items, dependencies, managed_sessions, run_attempts, events, messages, approval_requests, artifacts, verification_results, review_rounds, review_results, command_outbox, runtime_leases, idempotency_keys, delivery_acceptance, execution_profiles, profile_snapshots`。
- 事件表 `seq` 单调自增, 作 SSE 的 id, 支持 `after/Last-Event-ID` 与 resync。

### 2.3 适配器(`packages/adapters`)
- `codex.ts`: `codex app-server` 换行分隔 JSON-RPC(`initialize` / `thread/start` / `turn/start` / `turn/interrupt`; 通知 `item/agentMessage/delta`、`turn/completed`; 审批走 server→client 请求)。
- `claude.ts`: `@anthropic-ai/claude-agent-sdk` 的 `query()`(原生 harness; `canUseTool` 处理审批; `permissionMode` 映射三档权限)。
- `dsh.ts`: `dsh --profile acp` 的 ACP stdio(`session/new|prompt|set_config_option`, 权限走 `session/request_permission`)。
- `mock.ts`: 确定性离线适配器, 用于测试与演示(可用 `HH_MOCK_DELAY_MS` 放慢以便观察)。
- `exec.ts`: 解析本机可执行文件(`whichSync` 扫 `PATHEXT`、跳过 sh 垫片、`resolveClaudeBinary` 从 .cmd 解析真实 .exe)、`buildChildEnv`(去重、清 `PYTHONPATH/PYTHONHOME/...`、从 PATH 剔除 `\WindowsApps`)。

### 2.4 服务(`apps/server`)
- `index.ts`: 单实例锁(`runtime_leases` + PID 存活检查)、恢复未完成状态、装配适配器、`UiWatchdog`、`ensureWindowsErrorMode()`(见坑 §6.5)。
- `http.ts`: 手写路由 + 校验; 关键接口:
  - `GET /api/health`、`GET /api/runtime`(关停策略/心跳)、`GET /api/tasks`、`GET /api/tasks/:id`
  - `POST /api/tasks`、`POST /api/tasks/:id/plan`、`POST /api/tasks/:id/plan-decisions`
  - `POST /api/tasks/:id/cancel|pause|resume`、`POST /api/tasks/:id/messages`、附件上传
  - `POST /api/approvals/:id/resolve`
  - `GET /api/tasks/:id/events`(**SSE**, 不要当普通查询用)
  - `GET /api/archive`、`DELETE /api/archive/:taskId`
  - `GET /api/artifacts/:id/content`、`POST /api/artifacts/:id/open`(`{action:'reveal'|'open'}`)
  - `POST /api/pick-directory`(原生选目录, 走 `scripts/pick-folder.ps1`)
  - 安全: 只接受本机 Host、Origin 校验、非 JSON body 415。
- `runtime-control.ts`: 页面心跳(2s)、close-intent、12s 空闲兜底 → 默认关页约 2.5s 后优雅关停; `HH_EXIT_WITH_UI=0` 常驻。

### 2.5 前端(`apps/web`)
- 单页三栏: 左任务列表 + 中协作画布 + 右 dock(计划/对话/审批/审核/产物/事件)。
- 画布是**树形卡片图**: 根卡(主控)+ 计划卡 + 席位行 + 交付卡; 连线是独立 SVG 层(贝塞尔 + 活动光点), 坐标用 `[data-ck]` 实测, 卡片是 HTML。
- 计划面板: 列宽模板(目标 auto / 执行者 96 / 状态 72), 状态列是「彩色圆点 + 中性文字」(`.state`), 点任意行打开**工作项详情**弹窗(完整目标、输入、验收标准、执行记录、产物、验证、执行结论), Esc 关闭。
- 席位交互: 点画布席位卡直接与该席位对话; 每席位可单独改「工作区」「权限」(两项独立保存, 运行中改会提示"立即重启会话")。
- 其他: 新建任务里每个 harness 一张席位卡(工作区/权限两个按钮 + 原生选目录)、产物四个按钮(在文件夹中显示 / 用默认应用打开 / 新标签 / 下载)、归档面板(列出 + 逐条彻底删除)、双主题、事件页签。

---

## 3. 当前状态(截至 2026-11-09)

| 项 | 状态 |
| --- | --- |
| 单元/集成测试 `npm test` | **64/64 通过** |
| 接口验收 `node scripts/acceptance-api.mjs` | **53/53 通过** |
| 界面验收 `node scripts/acceptance-ui.mjs` | **28/28 通过**(含"清理临时数据"断言) |
| 真实 harness `node scripts/acceptance-live.mjs` | **9/9 通过**(Claude Code 主控 + DSH 执行, 1.6 分钟 `completed`, Σ 130681 tokens / 4 回合) |
| 本地 git | `f6d9356`(本文档) / `fb1e29a`(清理脚本改进), 工作树干净 |
| 远端 git | 上一次成功推送到 `d36c07f`; **`fb1e29a`、`f6d9356` 尚未推送** |
| 服务 | 当前**未运行**(默认模式下关页会停), 需要时 `npm start` |
| 任务库 | 1 条真实任务(课程报告, completed)、18 条归档(历史演示与真实证据) |

### 3.1 卡点一: 系统弹窗(未闭环, 需要用户确认)

用户多次报"又弹了", 截图有两种可能:
- **`X.exe - 应用程序错误 (0xC0000142)`**: Windows 加载器失败(常见触发是 PATH 里的 python 商店别名 stub)。
- **`Location is not available`("位置不可用")**: 资源管理器窗口指向了已被删除的目录。

已做的两层修复:
1. **不产生"位置不可用"**: 验收脚本默认**不再**打开真实资源管理器窗口(要 `HH_ACCEPT_SHELL=1` 才开), 且打开后先关窗口再删目录。
2. **不产生 0xC0000142 弹框**: `scripts/start.ps1` 调 `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX)`(进程级、子进程继承); `apps/server/src/index.ts` 的 `ensureWindowsErrorMode()` 在检测不到 `HH_ERROR_MODE=1` 时用 `start.ps1` **重新拉起自己**, 因此 `npm start` / IDE 直跑 / `node dist/apps/server/src/index.js` 都安全。

**当前卡点**: 我这边枚举所有顶层窗口与资源管理器窗口, 都**查不到**任何残留弹窗; 需要用户下次复现时告诉我**弹窗标题**(是 `python.exe/cmd.exe - 应用程序错误` 还是 `Location is not available`), 才能确定是否还有一条子进程链没继承到 error mode。

### 3.2 另一个待办: 推送

GitHub 直连被 reset、系统代理 `127.0.0.1:7897` 未开。代理恢复后执行:

```bash
cd D:\1hobby
git log --oneline -3                          # 应看到 f6d9356 / fb1e29a / d36c07f
git -c http.proxy= -c https.proxy= push      # 代理开着就直接 git push
```

然后 `git -c http.proxy= -c https.proxy= ls-remote --heads origin main` 确认远端 HEAD == `f6d9356`。

---

## 4. 下一步计划(按优先级)

1. **(P0) 收尾弹窗**: 拿到用户提供的弹窗标题; 若仍是 0xC0000142, 用 `Get-Process` + 事件时间对齐定位是哪个子进程, 考虑给 `dsh/claude` 再包一层启动器; 若确认是"位置不可用", 只需确认没有自动化脚本再触发 reveal 后删目录。
2. **(P0) 推送 `fb1e29a` + `f6d9356`** 并核对远端。
3. **(P1) 真实 Codex 端到端**: 目前 live 验收只覆盖 Claude Code 主控 + DSH 执行。Codex 已通过探针(0.166.0)与真实回合, 但**没跑过完整任务链**, 需要在用户确认额度后补一轮 `HH_LIVE_LEAD=codex node scripts/acceptance-live.mjs`。
4. **(P2) Hermes 适配器**: 用户提过"后续能通过适配器增加 Hermes"; 本机未安装 Hermes, 需先确认其协议再写 `packages/adapters/src/hermes.ts` + 在 `buildAdapters` 注册 + `docs/adding-a-harness.md` 补一节。
5. **(P2) 归档卫生**: `.local/archive` 仍有历史测试残留(如 `UI验收: 运行态`), 可考虑加"按前缀批量清理"按钮, 或在验收脚本里统一前缀并自动扫除。
6. **(P3) 弹窗长期防护**: 给 `dsh`/`claude` 适配器的子进程也显式继承 `HH_ERROR_MODE`, 并在 `docs/compatibility.md` 记录排查方法。
7. **(P3) 文档同步**: 每次功能变更后跑一遍 `docs/progress.md` / `docs/acceptance-report.md` / `README.md` 三处, 别只改代码。

---

## 5. 关键设计与"为什么这样"

| 决定 | 理由 |
| --- | --- |
| `node:sqlite` 而非 better-sqlite3 | 免原生编译, 不引入构建工具链; 代价是 Node 24 仍标实验 API |
| `node:http` 手写路由而非 express | 依赖越少越好; 40 个端点, 手写更可控, 也方便精确控制 415/403/409 |
| 不内置 harness 副本 | 用户明确要求用他自己装的 harness, 认证/模型配置都在本机; 项目内只放 DSH CLI(装在 `.local/tools`) |
| 三级工作区 | 任务大工作区 + 每席位小工作区(`planner/<slug>`、`worker/<slug>`)+ `deliverables/`; 避免席位互相踩文件 |
| 权限三档由 harness 原生实现 | Codex 用 sandbox+approvalPolicy, Claude 用 permissionMode(+canUseTool), DSH 只能靠提示词+事后审计 |
| 计划批准绑定四个值 | 防止"计划被悄悄改过"与"参与者换人"后沿用旧批准 |
| 返工保留旧批准 | 审计需要知道"当时批的是哪版"; 当前生效版本由 `currentPlanRevisionId` 决定 |
| 事件表 seq 作 SSE id | 断线重连可精确续传, 也能检测游标过期后整体 resync |
| 不做价格/计费 | 用户明确不要; token 只报真实用量, 不折算金额 |

---

## 6. 踩过的坑(绝对不要重踩)

### 6.1 文本编码
- **不要用 PowerShell 的 `Get-Content/Set-Content` 改源码**——PS 5.1 默认按 ANSI 解码 UTF-8, 中文会变 mojibake(项目里真实发生过)。改文件用 `edit` 工具或 Node 脚本(`readFileSync/writeFileSync(..., 'utf8')`)。
- **`.ps1` 文件含中文必须 UTF-8 with BOM**, 否则 PowerShell 按 ANSI 解析, 字符串/正则会坏(曾导致 `Add-Type` 里的 C# 代码编译失败)。
- PowerShell 里内联 `node -e "...'...'"`、`$sh`/`$w` 这类变量很容易被外层引号吃掉 → 一律写成 `.local/tmp/*.mjs` 或 `.ps1` 脚本文件再执行。

### 6.2 弹窗与进程
- **0xC0000142 的根因**是 Windows 加载器失败, 常见于 `C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\python3.exe`(商店 0 字节别名 stub)。只清洗 PATH 不够; 必须让**进程树的 error mode** 被关掉(SetErrorMode 进程级、子进程继承)。现已由 `ensureWindowsErrorMode()` + `start.ps1` 覆盖所有启动路径。
- **不要 `reveal` 打开资源管理器后立刻删那个目录** → Windows 弹「位置不可用」。验收脚本已默认不开真实窗口(`HH_ACCEPT_SHELL=1` 才开)。
- `EnumWindows` + `FindWindow('Location is not available')` 关不掉这类框(窗口可能不在当前桌面/已随进程退出); 唯一可靠做法是**从源头不产生**。
- `Start-Process npm ...` 起不来(npm 是 `npm.cmd`), 用 `powershell -NoProfile -Command "cd D:\1hobby; npm start"` 或后台 job。

### 6.3 服务生命周期
- 默认模式(`npm start`)是**关页即停**: 页面关掉约 2.5s 后服务 `exit 0`。所以:
  - 做截图/接口验收时先 `$env:HH_EXIT_WITH_UI='0'` 起服务, 结束再切回默认;
  - **后台 job 显示 completed 不代表服务在跑**;
  - `GET /api/health` 看不到关停策略, 要看 `GET /api/runtime` 的 `exitOnUiClose / pageSeen`。
- 杀服务进程要用 `-match 'apps[\\/]server[\\/]src[\\/]index\.js'`; 用 `-like '*dist/apps/server*'` 匹配不到反斜杠路径(曾经杀不干净, 出现两个实例抢锁)。
- `node dist/apps/server/src/index.js` 现在会自动套一层 `start.ps1`, 于是**外层 node + 内层 node** 两个进程是正常的, 不是重复启动。

### 6.4 接口与数据语义
- `POST /api/tasks` **不会自动规划**, 必须再 `POST /api/tasks/:id/plan`。
- 批准计划必须带 `planRevisionId + planHash + participantsRevision + expectedTaskVersion`; 缺字段 422, 哈希/版本过期 409。
- 删除被任务引用的执行配置默认 **200 + `{ok:true,deleted:false,profile.enabled=false}`**(软停用); 只有 `?hard=1` 才 409 `profile_in_use`。
- 消息字段是 `text`(不是 `content`); 批准结果看 `task.approvedPlanRevisionId`(没有 `planApprovalId`)。
- **不要把 `GET /api/tasks/:id/events` 当普通查询**: 它是 SSE, 会一直挂着。查事件请读库(`events` 表)或用快照。
- 返工 v2 之后 `approvedPlanRevisionId` 仍指向 v1 是**正确语义**(历史留痕), 不要"修正"成 superseded——`tests/engine.mock.test.ts` 的 PLAN-06 明确锁住它。

### 6.5 前端
- 不要用 CDP 注入 DOM 改 React 页面来做"设计稿": 下一次 state 更新就把它冲掉, 还会抛未捕获异常。设计稿要么写独立 HTML, 要么真改代码重建。
- 给 `TaskSnapshot` 加**必填**字段时必须同步改 `engine.snapshot()`, 否则 TS2741; 给 store 加状态时, 所有 `useMemo` 依赖数组要同步加(曾报 TS2741)。
- 产物预览要用**白名单**判断是否文本: 曾用 `/(json|xml|…)/` 匹配整个 mime, `openxmlformats` 里含 "xml", 于是 docx 被当文本渲染成一坨 PK 乱码。
- `openxmlformats|officedocument` 之类的长 mime 要用 `shortType()` 显示成 `word/excel/slides/pdf`, 否则标签撑爆一行。
- 「在文件夹中显示」要用 `explorer.exe /select,<abs>` 且**把 `/select,<path>` 作为同一个参数**传(Node 会自动补引号), 才能选中高亮; explorer 恒返回 1, 不要看退出码。

### 6.6 验证与提示词
- `findstr /x "带空格的内容" file` 是**错的**: findstr 把引号内空格当多个模式, 报 `FINDSTR: Cannot open live`。必须 `findstr /x /c:"..."`, 或改用 `powershell -Command` 比字符串。真实 live 验收就是被这个卡住的。
- 验证不能只看退出码: 输出含 `FINDSTR: Cannot open` 等噪音时退出码可能是 0, 仍要判失败(`VALIDATION_NOISE`)。
- 只读复核类工作项**不要**要求产物(`needsFiles = outputSpecs.length > 0`), 否则会被判 `verification_failed`。
- 计划提示词里必须写明 Windows 没有 grep/sed/awk、`./x.exe` 要写 `.\x.exe`、不交互、多条命令用 `&&`。

### 6.7 环境与仓库
- 工作区 `.local\runs` 上有一条**继承来的 ACL**: `Everyone:(DENY)(DC)` 与一个 sandbox SID(`S-1-4-...`), 会让子进程写入受限, 需要 harness 侧的宽权限审批; 不要以为是程序 bug。
- git 走系统代理 `127.0.0.1:7897`; 代理未开时直连常被 reset, 用 `git -c http.proxy= -c https.proxy= push` 重试, 仍失败就等代理。
- `.local/`、`node_modules/`、`dist/` 已在 `.gitignore`; **截图与验收原始证据不要提交**, 放 `.local/tmp`。
- 清理测试残留要用**标题前缀**识别(如 `验收取消`、`验收工作区`), 并且删前确认不是用户真实数据; `acceptance-ui.mjs` 已内置扫描+复查。
- 不要修改系统文件/全局配置/外部 harness 目录; 只读探测(Get-Command、注册表、npm ls -g)可以, 写入一律限制在 `D:\1hobby`。
- Claude SDK 会警告 `canUseTool will not be invoked: permissionMode 'bypassPermissions'`: 该模式下审批回调不生效, 只读语义要靠 deny 规则或 PreToolUse, 别以为回调在把关。

---

## 7. 项目结构

```
D:\1hobby
├─ START_HERE.md / SYSTEM_BLUEPRINT.md     最初的需求与架构文档(权威, 别改)
├─ README.md                              安装、启动、功能、验收、限制
├─ THIRD-PARTY-NOTICES.md                 第三方许可
├─ package.json                           scripts: build / start / test / dev:web / typecheck:web
├─ tsconfig.json                          后端编译到 dist/(含 tests/)
├─ .local/                                全部本机数据(已 gitignore)
│  ├─ data/harness-hub.db                 SQLite
│  ├─ runs/<taskId>/workspace/            任务工作区(planner/<slug> worker/<slug> deliverables/)
│  ├─ archive/<taskId>/                   删任务时的产物归档 + manifest.json
│  ├─ homes/<profileId>/                  各执行配置的私有 home(从 ~/.codex 等复制)
│  ├─ tools/                              项目内安装的 DSH CLI
│  ├─ logs/ tmp/ cache/ evidence/ screenshots/
├─ packages/
│  ├─ contracts/src/                      types.ts / events.ts(事件与快照契约, 含 TaskUsage)
│  ├─ core/src/
│  │  ├─ engine.ts                        引擎: 状态机、派发、恢复、审核、交付、归档
│  │  ├─ plan.ts                          计划校验(依赖/环/写范围/审核席位)
│  │  ├─ scheduler.ts                     依赖+写范围+并发的可派发计算
│  │  ├─ prompts.ts                       规划/执行/审核提示词(含 Windows shell、docx、findstr 规则)
│  │  ├─ usage.ts                         token 归一化与累加
│  │  ├─ bus.ts / util.ts                 事件总线、id/时间工具
│  ├─ storage/src/                        db.ts(迁移) / repo.ts(查询与写入)
│  └─ adapters/src/                       codex.ts / claude.ts / dsh.ts / mock.ts / exec.ts / types.ts
├─ apps/
│  ├─ server/src/                         index.ts(启动/锁/恢复) http.ts(路由) config.ts
│  │                                      runtime-control.ts(心跳关停) fs.ts homes.ts
│  └─ web/                                Vite 前端
│     ├─ src/App.tsx  store.ts  api.ts  styles.css
│     ├─ src/components/  CollabGraph / PlanPanel / WorkItemDetail / NodeDetail
│     │                   Conversation / Panels(产物·归档) / Dialogs(新建任务·配置) / DirectoryPicker
│     └─ src/lib/         format / live(状态条推导) / runtime / theme
├─ scripts/
│  ├─ start.ps1                           设 SetErrorMode + HH_ERROR_MODE 后启动 node(含 BOM)
│  ├─ make-docx.ps1                       纯 .NET 写 OOXML(宋体小四/黑体三号, 不用 python)
│  ├─ pick-folder.ps1                     原生 IFileOpenDialog(含 DPI 感知)
│  ├─ acceptance-api.mjs                  53 项接口验收(默认不开真实窗口)
│  ├─ acceptance-ui.mjs                   28 项界面验收(无头 Edge + CDP, 自带清理)
│  └─ acceptance-live.mjs                 9 项真实 harness 验收(消耗额度)
├─ tests/                                 15 个 node:test 文件, 64 项
└─ docs/
   ├─ progress.md                         进度流水(按时间倒序, 顶部最新)
   ├─ decisions.md                        架构决策记录(ADR)
   ├─ acceptance-report.md                验收结论(64/53/28/9 + 已知限制)
   ├─ acceptance-checklist.md             需求→证据逐条对照(30 条 + 界面细节)
   ├─ compatibility.md                    Windows/Node/各 harness 兼容性与限制
   ├─ harness-setup.md                    如何自行安装配置三种 harness
   └─ adding-a-harness.md                 新增适配器的步骤
```

---

## 8. 常用命令

```powershell
cd D:\1hobby

npm install                 # 首次
npm run build               # 后端 tsc + 前端 vite
npm start                   # 默认: 关网页 2.5s 后停; 端口 4310
$env:HH_EXIT_WITH_UI='0'; npm start   # 常驻(截图/验收时用)
npm test                    # 64 项(会先 build:server)

node scripts/acceptance-api.mjs       # 53 项接口(需服务在跑)
node scripts/acceptance-ui.mjs        # 28 项界面(自带无头浏览器)
node scripts/acceptance-live.mjs      # 9 项真实 harness(要额度; 失败会保留现场到 .local/tmp/live-failure.json)

# 换端口/隔离数据
$env:HH_PORT=4400; $env:HH_DATA_DIR='.local/data-test'; npm start

# 查状态
curl http://127.0.0.1:4310/api/health
curl http://127.0.0.1:4310/api/runtime      # 看 exitOnUiClose / pageSeen
```

环境变量: `HH_PORT`(4310) `HH_HOST`(127.0.0.1) `HH_ROOT` `HH_DATA_DIR` `HH_HOMES_DIR` `HH_RUNS_DIR`
`HH_EXIT_WITH_UI`(0=常驻) `HH_UI_GRACE_MS`(2500) `HH_UI_IDLE_MS`(12000) `HH_UI_FIRST_MS`(0=一直等首个页面) `HH_SEED_PROFILES`(0=不建示例配置)
`HH_ACCEPT_SHELL`(1=验收时打开真实窗口) `HH_ERROR_MODE`(内部用) `HH_MOCK_DELAY_MS`(放慢 mock)。

---

## 9. 已知限制(如实记录)

- **Codex 没有跑完整任务链**: 只做过探针与真实回合; 完整端到端只有 Claude Code + DSH。
- **DSH 无沙箱**: 三档权限对 DSH 只是提示词 + 事后审计, 不能强制。
- **Codex 在 Windows 上的沙箱** 报 `windowsSandbox/readiness: updateRequired`; 未经管理员准备时命令隔离较弱。
- **`node:sqlite` 是实验 API**(Node 24), 升级大版本需回归。
- 原生选目录框(新版 shell 对话框)无法在无头浏览器断言, 只验证脚本能弹出并输出路径。
- 真实 harness 长回合会真实消耗额度, 因此默认验收用 mock; live 脚本只在用户同意时跑。
- 关卡: 归档目录里的历史测试残留未做批量清理 UI。

---

## 10. 接手第一小时该做什么

1. `cd D:\1hobby && git log --oneline -5 && git status` —— 确认在 `fb1e29a`, 工作树干净。
2. `npm install && npm run build && npm test` —— 应得 64/64。
3. `npm start` 打开 http://127.0.0.1:4310 , 用 `Mock A` 建一个小任务走完「规划→批准→执行→交付」, 确认界面与事件流正常(不花额度)。
4. `node scripts/acceptance-api.mjs`(服务在跑)→ 53/53; 再 `node scripts/acceptance-ui.mjs` → 28/28。
5. 先处理 §3.2 的推送, 再按 §4 的 P0/P1 推进; 动代码前先看 `docs/decisions.md` 与 `docs/progress.md` 顶部, 避免推翻既有裁定。
6. 任何涉及"打开真实文件夹/进程序列/额度"的动作, 先跟用户确认。
