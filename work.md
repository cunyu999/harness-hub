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
- `exec.ts`: 解析本机可执行文件(`whichSync` 扫 `PATHEXT`、跳过 sh 垫片、`resolveClaudeBinary` 从 .cmd 解析真实 .exe)、`buildChildEnv`(去重、清 `PYTHONPATH/PYTHONHOME/...`、从 PATH 剔除 `\WindowsApps`)、`killProcessTree()`(Windows 用 `taskkill /T /F` 杀整棵树)。
- `diag.ts`: `openDiagLog()` 按目录落 `stderr.log`, 单文件 4MB 封顶; 目录为空时返回 null, 不影响离线/mock 运行。

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
- 等待提醒: 标题显示 `(N) Harness Hub` 徽标; 页面在后台时对"新审批"和"计划待批准"弹桌面通知(需点铃铛授权); 审批页签内 `A` 批准 / `D` 拒绝第一条非输入请求, 焦点在输入框时不拦截。

---

## 3. 当前状态(截至 2026-11-10)

| 项 | 状态 |
| --- | --- |
| 单元/集成测试 `npm test` | **72/72 通过**(home 同步 7 项 + 归档外置 localDir 1 项) |
| 接口验收 `node scripts/acceptance-api.mjs` | **53/53 通过** |
| 界面验收 `node scripts/acceptance-ui.mjs` | **28/28 通过**(含"清理临时数据"断言) |
| 真实 harness `node scripts/acceptance-live.mjs` | **9/9 通过**(Claude Code 主控 + DSH 执行, 1.6 分钟 `completed`, Σ 130681 tokens / 4 回合) |
| 本地 git | HEAD `2655f91`(本轮 handoff); 之后又有未提交改动: home 同步 / Codex 种子不再钉模型 / 进程树取消 / attempt 诊断 / 产物卫生 / 审批通知 |
| 远端 git | 已推送至 **`8019653`**(2026-11-10), 与本地 HEAD 一致 |
| 服务 | 当前**未运行**(默认模式下关页会停), 需要时 `npm start` |
| 任务库 | 1 条真实任务(课程报告, completed)、18 条归档(历史演示与真实证据) |
| 便携版 / 桌面版 | `D:\1hobby\HarnessHub`(808.1 MB / 7750 文件), 双击 `HarnessHub.exe`(Electron 壳)启动, `HarnessHub-Edge.vbs` 是 Edge 备用; 数据都在 `HarnessHub\data`; 未打 zip、未签名、无安装器 |

### 3.1 系统弹窗(已定位, 2026-11-10)

用户多次报"又弹了", 截图可能有三类:
- **`X.exe - 应用程序错误 (0xC0000142)`**: Windows 加载器失败(常见触发是 PATH 里的 python 商店别名 stub)。
- **`Location is not available`("位置不可用")**: 资源管理器窗口指向了已被删除的目录。
- **`electron.exe - 应用程序错误 (0xC0000005, 指令引用了 0x...08 内存)`**: 2026-11-10 桌面版测出来的新问题, 只在 Electron 从后台上下文启动时出现, 已由启动器 `--no-sandbox` + `SetErrorMode` 规避(§3.4)。

已做的三层修复:
1. **不产生"位置不可用"**: 验收脚本默认**不再**打开真实资源管理器窗口(要 `HH_ACCEPT_SHELL=1` 才开), 且打开后先关窗口再删目录。
2. **不产生 0xC0000142 弹框**: `scripts/start.ps1` 调 `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX)`(进程级、子进程继承); `apps/server/src/index.ts` 的 `ensureWindowsErrorMode()` 在检测不到 `HH_ERROR_MODE=1` 时用 `start.ps1` **重新拉起自己**。
3. **不产生 0xC0000005 弹框**: 桌面版统一经 10 KB 启动器拉起(固定 `--no-sandbox`, 并关掉 error mode); 不要再从 `Start-Process`/脚本里直接跑 `HarnessHubCore.exe`。

**剩余风险**: 若用户仍看到弹窗, 先记**弹窗标题**与时间, 再按 §6.2 的方法定位是哪个子进程没继承到 error mode。

### 3.2 推送(已完成, 2026-11-10)

代理恢复后已推送: 远端从 `d36c07f` 快进到 **`8019653`**, 与本地一致(`fb1e29a`、`2655f91`、`8019653` 三个提交都上去了)。核对命令:

```bash
cd D:\1hobby
git fetch origin main && git log --oneline -1 origin/main
git status --porcelain        # 应为空
```

以后再有未推送提交, 先看 `git status` 与 `git log --oneline origin/main..HEAD`; 代理没开就等, 不要强推或改历史。

### 3.3 便携版(2026-11-09 新增, 与开发目录隔离)

- 产物在 `D:\1hobby\HarnessHub`, 自带 `node.exe` 与生产依赖, 目标机不用装 Node; 数据在 `HarnessHub\data`(数据库 / 私有 home / 工作区 / 诊断日志 / 归档), 重打包时保留, 升级只换程序文件。
- 数据路径单一来源: `config.ts` 用 `HH_DATA_DIR` 推出 `localDir`, `homes/runs/logs` 都基于它; `EngineConfig.localDir` 由 `index.ts` 传 `cfg.localDir`, 工作区/归档/诊断目录不再写回程序目录的 `.local`。
- 启动链(Edge 版): `HarnessHub-Edge.vbs` → `powershell -File scripts\start.ps1`(先关硬错误弹窗) → `node dist\apps\server\src\index.js`(HH_PORT=0, 实际端口写 `data\runtime.json`) → `msedge --app=<url>` 无地址栏窗口; 没有 Edge 退回默认浏览器。桌面版链见 §3.4。
- 开发目录(仓库 + `.local`)保持原样当底版: 打包只读构建产物, 不碰现有数据; `HH_DATA_DIR` 只在便携版里设。
- 打包/重建: `npm run pack`(会先 build), `npm run pack -- --skip-build` 跳过构建; 输出目录可用 `HH_PACK_DIR` 覆盖。
- 体积 460 MB(仅 Edge 版)里 343 MB 是 `@anthropic-ai/claude-agent-sdk` 的 vendor, 目前没裁; 只在装了 Edge 的本机验证过。

### 3.4 Windows 桌面版(Electron 壳, 2026-11-10)

- 同一产物目录 `D:\1hobby\HarnessHub` 现在双击 `HarnessHub.exe`: 这是 10 KB 的启动器(源码 `apps/desktop/launcher.cs`, 打包时用系统自带 `csc` 现编), 它拉起 `HarnessHubCore.exe`(Electron 43.3.0, 从本机 `%LOCALAPPDATA%\electron\Cache` 里的 win32-x64 zip 解压, 不联网); 壳进程 `resources/app/main.js` 起包内 `node.exe` 跑后端(随机端口, 数据在 `data\`), 再开 1440×900 窗口。
- 为什么必须加启动器: 这台机器上 Chromium 沙箱初始化会让 Electron 在 app ready 之前 `0xC0000005` 退出(换 42/43 版本、关 GPU 都一样), 必须带 `--no-sandbox`; 而双击 exe 传不了参数。DSH 自己的 dsh-pet 也是带 `--no-sandbox` 跑的, 可作佐证。
- 启动器另外做两件事: `SetErrorMode(0x0001|0x0002|0x8000)` 关掉硬错误弹窗(整棵进程树继承), 设 `HH_ERROR_MODE=1` 让后端不再经 PowerShell 重启自己。
- 关窗流程: 壳拦截 `close` → 查 `/api/runtime` 的 `activeSessions`, 有任务先弹原生确认框("还有 N 个任务在运行") → `win.destroy()` → 后端 `close-intent` 优雅退出(实测 ~2.5s, exit code 0, `runtime.json` 删除); 6s 不退才 `taskkill /T /F`。
- `HarnessHub-Edge.vbs` 保留为备用启动器(不想用 Electron 时); `npm run pack -- --no-electron` 只打 Edge 版。
- 体积 808 MB(Electron 约 190 MB + SDK vendor 343 MB + node_modules)。
- 发行物(2026-11-10 补齐): `npm run pack -- --installer --sign=<证书指纹> --zip` 一次产出
  - `release/HarnessHub-0.1.0-win-x64.zip`(330.6 MB): 整个程序目录, 不含 `data/`, 两个 exe 已签名; 解压即用, 首次启动自动建 `data/`;
  - `release/HarnessHub-0.1.0-win-x64-setup.exe`(327.8 MB): NSIS per-user 安装到 `%LOCALAPPDATA%\Programs\HarnessHub`, 快捷方式 + 卸载入口, 卸载保留 `data/`;
  - 两者各带 `.sha256`(格式 `<hash>  <文件名>`)。
- 签名: 自签名证书 `CN=Harness Hub, O=1hobby, OU=Local Build`(指纹 `501A7EE97BB27F0EDAC77AEB32D83EF976702C6D`, 2029-11 到期; pfx/cer 在 `.local/keys/`, 口令在 `pfx-password.txt`)。`Set-AuthenticodeSignature` 会返回 `UnknownError`(UntrustedRoot), 但签名确实写入; 别人机器上仍显示"未知发布者", 除非先把 `.cer` 装进「受信任的根证书」。
- 打安装包的坑: `scripts/installer.nsi` 必须存成 UTF-8 **带 BOM**(否则 `Bad text encoding`); 只能 `SetCompressor zlib` 并把 `TEMP`/`TMP` 指到项目内(`.local/tmp`), 否则 32 位 makensis 在 300 MB 负载上报 `Internal compiler error #12345: error creating mmap`; makensis 用 `.local/tools/nsis/nsis-3.10/Bin/makensis.exe`(可用 `HH_MAKENSIS` 覆盖)。
- 实测过的安装链路: 静默安装 `/S /D=<dir>` 19 秒 → 启动 → 关窗(server exit 0, `runtime.json` 删除)→ `Uninstall.exe /S` 后只剩 `data/`(数据库保留)。
- **数据全部收进安装目录**(2026-11-10): 启动器启动前建 `data\tmp`, 并把 `TEMP`/`TMP`/`TMPDIR` 指过去 —— Electron、后端、harness 子进程都继承, 不在系统 `%TEMP%` 留文件; 崩溃转储也改到 `data\electron\Crashpad` 并加 `disable-crash-reporter`(否则崩一次就在 `%LOCALAPPDATA%\CrashDumps` 留 `.dmp`)。实测: 删 `data` 后启动 → 全盘扫 `%USERPROFILE%`/`%LOCALAPPDATA%`/`%APPDATA%`/`%TEMP%`(3 层) 新增文件 181 个, 逐个归属全是其它程序(MATLAB、抖音、Edge 临时 profile 等), 没有一个是本程序的。
- 「应用和功能」条目: 安装器装时写 HKCU 卸载键; 桌面壳启动时若同目录有 `Uninstall.exe` 再用 `reg.exe ... /reg:32` 补写一次(补齐 `InstallLocation`/`QuietUninstallString`, 并兜住安装器写失败或用户手动搬目录的情况)。zip 绿色版没有 `Uninstall.exe`, 不写任何注册表。
- 开始菜单/桌面快捷方式改成安装器的可选组件(`Section /o`, 默认不勾), 需要才装。

---

## 4. 下一步计划(按优先级)

1. **(P0) 收尾弹窗**: 拿到用户提供的弹窗标题; 若仍是 0xC0000142, 用 `Get-Process` + 事件时间对齐定位是哪个子进程, 考虑给 `dsh/claude` 再包一层启动器; 若确认是"位置不可用", 只需确认没有自动化脚本再触发 reveal 后删目录。
2. ~~**(P0) 推送**~~: 已完成(远端 == `8019653`, 见 §3.2)。
3. **(P1) 真实 Codex 端到端**: 目前 live 验收只覆盖 Claude Code 主控 + DSH 执行。Codex 已通过探针(0.166.0)与真实回合, 但**没跑过完整任务链**, 需要在用户确认额度后补一轮 `HH_LIVE_LEAD=codex node scripts/acceptance-live.mjs`。
4. **(P2) Hermes 适配器**: 用户提过"后续能通过适配器增加 Hermes"; 本机未安装 Hermes, 需先确认其协议再写 `packages/adapters/src/hermes.ts` + 在 `buildAdapters` 注册 + `docs/adding-a-harness.md` 补一节。
5. **(P2) 归档卫生**: `.local/archive` 仍有历史测试残留(如 `UI验收: 运行态`), 可考虑加"按前缀批量清理"按钮, 或在验收脚本里统一前缀并自动扫除。
6. **(P3) 弹窗长期防护**: 给 `dsh`/`claude` 适配器的子进程也显式继承 `HH_ERROR_MODE`, 并在 `docs/compatibility.md` 记录排查方法。
7. **(P1) 桌面版收尾**: Electron 壳、zip、自签名、NSIS 安装器都已完成(§3.4); 剩余: 让用户信任自签证书(或买正式签名)、瘦身(SDK vendor 343 MB)、自动更新。
8. **(P3) 文档同步**: 每次功能变更后跑一遍 `docs/progress.md` / `docs/acceptance-report.md` / `README.md` 三处, 别只改代码。

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
| 私有 home 每回合择新同步 | cc-switch 切订阅/API 后下一回合自动生效; 判据是"源内容是否变过"(sha1), 不覆盖 harness 刷新过的令牌 |
| 取消/超时一律 `taskkill /T /F` | `child.kill()` 只结束直接子进程, Windows 上 node 包壳与工具进程会留在后台继续写文件; 统一走 `killProcessTree()` |
| 桌面版用 10 KB 启动器而不是直接跑 Electron | 这台机器上 Chromium 沙箱会让 Electron 在 ready 前 `0xC0000005`, 必须 `--no-sandbox`, 而双击传不了参数; 又不想为此引 .NET SDK 或联网装打包器, 所以打包时用系统自带 `csc` 现编一个 WinExe |
| 关窗由壳弹原生确认框, 不用页面 beforeunload | Electron 里 `beforeunload` 会弹浏览器式"离开此网站?"提示, 文案不可控; 壳拦截 `close` 查 `activeSessions` 更准确 |
| 每次 attempt 落诊断目录 | 失败要能事后看原始输出, 不靠复现; `.local/runs/<taskId>/<attemptId>/` 放 `meta.json`、`events.jsonl`、`stderr.log`(各自封顶) |
| 测试库与临时目录放项目内 | 接口测试不再往 `.local/data` 写 `hb-*.db`; 磁盘清理统一交给 `npm run doctor`, 手工删容易误伤 |
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
- **`child.kill()` 在 Windows 上不杀进程树**: 取消/超时后 harness 包壳、`cmd`、工具进程可能还在跑并继续写工作区, 表现为"取消了但文件还在变"。统一用 `packages/adapters/src/exec.ts` 的 `killProcessTree()`(`taskkill /pid <pid> /T /F`, 再兜底 `child.kill()`); 新增取消路径时不要只写 `child.kill()`。
- 取消后仍要等 `close` 事件再回写 attempt 状态; `taskkill` 是异步生效的, 立刻删工作区/改状态会撞上仍在退出的进程。
- `Start-Process npm ...` 起不来(npm 是 `npm.cmd`), 用 `powershell -NoProfile -Command "cd D:\1hobby; npm start"` 或后台 job。
- **Electron 在 harness 的 pwsh 里启动会在 app ready 前 `0xC0000005` 退出**(带 trace 也只到 `electron module loaded`; 换 42/43、关 GPU 都一样)。同一套二进制经 WMI 或 explorer 启动就正常 → 是进程上下文问题, 不是应用代码。稳定做法: 启动器加 `--no-sandbox`(本机 DSH 的 dsh-pet 也这么跑)。
- **node 用管道 stdio 拉起 `scripts/start.ps1` 时 `Add-Type` 会抛 `Win32Exception`**(start.ps1:14), 后端 code=1 退出; 单独在控制台跑同一个 ps1 却成功。桌面壳直接传 `HH_ERROR_MODE=1` 跳过这次重启。
- **从 harness 里用 `Start-Process` / `WScript.Shell.Run` 直接起 `HarnessHub.exe` 会卡住**(ShellExecute 路径); 验证桌面版用 `explorer.exe "<exe>"` 或 `Invoke-CimMethod Win32_Process Create`。
- Electron 窗口在后台启动时可能被系统按最小化创建; `ready-to-show` 里 `isMinimized()` 时补一次 `restore()+focus()`。
- **在 `D:\1hobby` 里直接运行任何 exe, 拿到的是低完整性令牌**(`whoami /groups` 显示 `Mandatory Label\Low Mandatory Level`, 而正常 pwsh 是 High)。低完整性对 `HKCU\Software` 只读, 于是 NSIS 的 `WriteRegStr` 和 `reg.exe add` 都报 `拒绝访问`。**验证安装器/桌面壳要把 exe 放到 `%TEMP%`、Downloads 这类工作区外的路径再跑**: 同一份 setup 从 `%TEMP%` 跑, 卸载键、`data\tmp`、卸载删除全部正常。别把它误判成产品缺陷。

### 6.3 服务生命周期
- 桌面壳里**不要设 `HH_EXIT_WITH_UI=0`**: 它会把 `close-intent` 一起禁掉(`runtime-control.ts:84` 直接返回 disabled), 关窗时后端不退出, 壳只能硬杀。桌面壳保持默认, 由 `win.destroy()` 触发 unload 后的优雅关停。
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
- 直接用全局 `codex` CLI 探测会在 `~/.codex/tmp/arg0-windows/` 建 `codex-arg0*` 临时目录(2026-11-09 实测产生过, 已清理)。以后跑 codex 探针先设 `CODEX_HOME=D:\1hobby\.local\tmp\codex-home`; Claude 同理用 `CLAUDE_CONFIG_DIR`; 这样不会往用户 home 写任何东西。
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
│  ├─ runs/<taskId>/<attemptId>/          诊断: meta.json / events.jsonl / stderr.log(封顶 8MB / 4MB)
│  ├─ archive/<taskId>/                   删任务时的产物归档 + manifest.json
│  ├─ homes/<profileId>/                  各执行配置的私有 home(每回合与源目录择新同步)
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
│  └─ adapters/src/                       codex.ts / claude.ts / dsh.ts / mock.ts / exec.ts(含 killProcessTree) / diag.ts / types.ts
├─ apps/
│  ├─ server/src/                         index.ts(启动/锁/恢复) http.ts(路由) config.ts
│  │                                      runtime-control.ts(心跳关停) fs.ts homes.ts
│  └─ web/                                Vite 前端
│     ├─ src/App.tsx  store.ts  api.ts  styles.css
│     ├─ src/components/  CollabGraph / PlanPanel / WorkItemDetail / NodeDetail
│     │                   Conversation / Panels(产物·归档) / Dialogs(新建任务·配置) / DirectoryPicker
│     └─ src/lib/         format / live(状态条推导) / runtime / theme / notify(桌面通知·标题徽标)
│  └─ desktop/                             Electron 壳: main.js(起后端/开窗/关停确认) / launcher.cs(10 KB 启动器) / package.json
├─ scripts/
│  ├─ start.ps1                           设 SetErrorMode + HH_ERROR_MODE 后启动 node(含 BOM)
│  ├─ make-docx.ps1                       纯 .NET 写 OOXML(宋体小四/黑体三号, 不用 python)
│  ├─ pick-folder.ps1                     原生 IFileOpenDialog(含 DPI 感知)
│  ├─ acceptance-api.mjs                  53 项接口验收(默认不开真实窗口)
│  ├─ acceptance-ui.mjs                   28 项界面验收(无头 Edge + CDP, 自带清理)
│  ├─ acceptance-live.mjs                 9 项真实 harness 验收(消耗额度)
│  ├─ pack-portable.mjs                   打 Windows 版到 HarnessHub\(Edge 版或 Electron 壳, 编译启动器)
│  └─ doctor.mjs                          磁盘体检: 默认只读; --clean 清测试库/孤儿 home; --tmp 清 7 天前 tmp
├─ tests/                                 16 个 node:test 文件, 72 项
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
npm test                    # 72 项(会先 build:server)
npm run doctor              # 磁盘体检(只读); -- --clean 清测试库/孤儿 home; -- --tmp 清 7 天前 tmp
npm run pack                # 打包桌面版到 D:\1hobby\HarnessHub(会先 build); -- --skip-build 跳过构建; -- --no-electron 只打 Edge 版
npm run pack -- --zip       # 额外产出 release\HarnessHub-<ver>-win-x64.zip(+ .sha256), 约 331 MB
npm run pack -- --installer --sign=<证书指纹> --zip   # 全套: 签名两个 exe → 编并签名 NSIS 安装器 → 打 zip

# 验证桌面版(从 harness 里别用 Start-Process, 会卡在 ShellExecute)
explorer.exe "D:\1hobby\HarnessHub\HarnessHub.exe"
Invoke-CimMethod Win32_Process Create -Arguments @{ CommandLine = 'D:\1hobby\HarnessHub\HarnessHub.exe' }
Get-Content 'D:\1hobby\HarnessHub\data\logs\desktop.log' -Encoding utf8 -Tail 5

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
- `.local/tmp` 目前主要由历史验收截图/patch 脚本占用(实测约 1.3GB/2.7 万文件); `npm run doctor -- --clean` 不动它, 要 `-- --tmp` 才清 7 天前的文件, 删前先确认没有还要复用的现场。
- **便携版只在本机验证**: 未在没装 Node / 没装 Edge 的干净机器上试; 依赖本机已登录的 codex/claude/dsh, 没有做安装器与自动更新; 没有代码签名, SmartScreen 会提示未知发布者。
- **桌面版必须带 `--no-sandbox`**: 这台机器上 Chromium 沙箱初始化会让 Electron 在 ready 前 `0xC0000005`, 所以由启动器固定传参; 若哪天换到正常机器, 这个参数仍可用, 但等于放弃了渲染进程沙箱。
- **桌面版体积 808 MB**, 发行 zip 330.6 MB / 安装器 327.8 MB; 已用自签名证书签名(别人机器仍报"未知发布者"); 无自动更新、无托盘/最小化到托盘。silent 安装可用 `/S /D=<dir>`。
- **便携版体积 460 MB**(仅 Edge 版), 其中 SDK vendor 343 MB; 想瘦身要先确认 SDK 是否真的需要 vendor 里的 CLI 副本。
- **安装器的卸载键是从安装器/桌面壳写 HKCU**: 在本项目工作区 `D:\1hobby` 里直接跑 exe 会被降为低完整性令牌, 写注册表一律 `拒绝访问`(见 §6.2 最后一条), 这属于测试环境限制, 不是产品缺陷; 真实验证请把 setup 复制到 `%TEMP%` 或 Downloads 再跑。

---

## 10. 接手第一小时该做什么

1. `cd D:\1hobby && git log --oneline -5 && git status` —— 记下 HEAD, 看清哪些改动还没提交。
2. `npm install && npm run build && npm test` —— 应得 72/72。
3. `npm start` 打开 http://127.0.0.1:4310 , 用 `Mock A` 建一个小任务走完「规划→批准→执行→交付」, 确认界面与事件流正常(不花额度)。
4. `node scripts/acceptance-api.mjs`(服务在跑)→ 53/53; 再 `node scripts/acceptance-ui.mjs` → 28/28。
5. 先确认 `git log --oneline origin/main..HEAD` 为空(已同步), 再按 §4 的 P0/P1 推进; 动代码前先看 `docs/decisions.md` 与 `docs/progress.md` 顶部, 避免推翻既有裁定。
6. 任何涉及"打开真实文件夹/进程序列/额度"的动作, 先跟用户确认。
