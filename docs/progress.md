## 新建任务: 每个席位的工作区/权限改成两个独立按钮

- 以前每个席位是一行「权限下拉 + 路径输入框」, 不知道填什么; 现在每个席位是一张卡: 顶部 `强模型·主控 / 名字` + 两个按钮「工作区」「权限」, 下方摘要行直接写出当前生效值, 例如 `planner/claude-code · 跟随角色默认(完全权限)`。
- 「工作区」展开后: 输入框(相对任务工作区或绝对路径) + 「选择目录…」 + 「用默认」; 选择目录与大工作区一致, 先调 Windows 原生文件夹对话框(`POST /api/fs/pick-directory`), 失败才回退网页内 DirectoryPicker。
- 「权限」展开后是三档下拉(跟随角色默认/只读/工作区内可写/完全权限), 并注明各 harness 的生效方式。
- 留空含义显式化: 强模型默认 `danger-full-access`, 执行者默认 `workspace-write`, 工作区默认 `planner|worker/<席位名>`。

## 产物在资源管理器中定位 / 用默认应用打开

- 产物页选中任一产物后有两个系统动作: 「打开所在文件夹」(`explorer.exe <目录>`, 直接打开父目录)与「用默认应用打开」(Windows 走 `rundll32 url.dll,FileProtocolHandler <绝对路径>`, 失败退回 `powershell Start-Process -FilePath`; 非 0 退出返回 500 open_failed 并带上 stderr)。
- 接口 POST /api/artifacts/:id/open, body `{action:'reveal'|'open'}`; 只对已登记产物生效, 越界 409 artifact_outside_workspace、未登记 404 artifact_not_found、文件已消失 409 artifact_missing, action 非法 422 invalid_action。
- 网页预览收紧为白名单: 只有 text/* 与 json/yaml/toml/csv/xml(+xml) 直接渲染; docx/xlsx/pptx 等(openxmlformats|officedocument)与二进制不再当文本显示, 改为提示用默认应用打开。产物列表的类型标签也从完整 mime 串改为 word/excel/slides/plain 这类短名。
- 验证: 真机点过两个按钮(docx 产物), 资源管理器选中成功、Word 默认关联成功, 提示文案分别为「已在文件管理器中选中该文件」「已交给系统默认应用打开」; API 侧 200/422/404 均已覆盖。

## 归档项目可查看与彻底删除

- .local/archive/<taskId>/ 里放的是删除任务时保留的成果产物与 manifest.json。
- 侧栏「归档」打开列表: 标题、任务 ID、文件数、总大小、归档时间、目标摘要; 每条可「彻底删除」(二次确认), 删除后目录立即消失, 不做二次留存。
- 接口 GET /api/archive 与 DELETE /api/archive/:taskId; 后者只接受 ^[A-Za-z0-9_-]{1,80}$ 且必须落在归档根目录内, 非法返回 400、不存在返回 404。
- 测试 tests/archive.test.ts(2 项): 列表读 manifest 与统计、删除后目录消失、../etc 之类被拒。

## 席位工作区/权限入口拆分

- 对话栏把合并的「工作区 / 权限」拆成两个独立入口, 与「普通消息」选择器并排放置; 两个面板各自带保存按钮, 互斥展开。

## 选择工作区与上传附件

- 工作目录支持目录选择器(GET /api/fs/list 只读列目录 + 前端 DirectoryPicker), 新建任务与对话栏两处都能用。
- 对话支持附件: POST /api/tasks/:id/attachments 把 base64 落盘到任务工作区 uploads/, 消息带 attachments(迁移 6 新增 messages.attachments_json); 发模型时把绝对路径写进正文。
- 测试 57 项(tests/attachments.test.ts 覆盖落库与 schema 校验)。

# 进度记录

> 每次会话结束前更新本文件, 保证中断后可继续。状态标记: 已实现 / 已验证 / 未验证 / 受阻。

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 环境与协议可行性(Codex app-server / DSH ACP / Claude Agent SDK / node:sqlite) | 已验证 |
| P1 | 骨架、契约、SQLite、计划版本、幂等、SSE、mock 端到端 | 已验证 |
| P2 | 三种真实适配器 + 监控 | 适配器已实现; 三者在 inspect 模式下握手成功, 真实回合未验证 |
| P3 | 单强模型闭环(规划→批准→执行→验证→交付) | mock 已验证; 真实会话未验证 |
| P4 | 多强模型讨论 + 交叉审核 | mock 已验证(讨论 2 提案 + 2 席位交叉复核留痕); 真实未验证 |
| P5 | Lancer 风格 UI | 已实现, 列式编排画布 + 双主题 + 响应式已截图验证 |
| P6 | 故障恢复 + 课程报告/C++ 真实验收 | 恢复/取消/并发隔离已验证(mock); 真实 harness 验收未开始(需授权) |
| P7 | 开源准备(不发布) | 未开始 |

## 已完成

- 目录与依赖: `package.json` workspaces(packages/*, apps/*), 依赖全部装在 `D:\1hobby\node_modules`,
  npm cache 指向 `.local/cache/npm`, TEMP/TMP 指向 `.local/tmp`。
- 契约层 `packages/contracts`: 实体类型、状态枚举、事件类型、Zod 请求体、API DTO。
- 存储层 `packages/storage`: `node:sqlite` DatabaseSync + WAL + 迁移(schema_migrations, 已到 v2),
  覆盖 execution_profiles / profile_snapshots / tasks / participants / plan_revisions / plan_approvals /
  work_items / dependencies / managed_sessions / run_attempts / events / messages / approval_requests /
  artifacts / verification_results / review_rounds / review_results / command_outbox / runtime_leases /
  idempotency_keys / delivery_acceptance。
- 核心层 `packages/core`: 路径安全(safeJoin/assertRealInside/normalizeRelPath)、计划校验与哈希、
  提示词构建、纯函数调度器、事件总线、任务引擎(阶段机、计划版本绑定、派发、验证、审核、集成、交付、
  取消、恢复、监控)。
- 适配器 `packages/adapters`: mock(确定性)、Codex(app-server JSON-RPC)、Claude Code(Agent SDK)、DSH(ACP stdio)。
- 服务端 `apps/server`: node:http 路由(含 Host/Origin/Content-Type 校验)、SSE(快照 + 增量 + 心跳 + resync)、
  私有 home 准备、静态资源、单实例租约(失效锁可接管)。
- 前端 `apps/web`: React + Vite, Lancer 风格双主题界面(浅色 / 深色, 侧栏一键切换并记忆, 首帧无闪白);
  统一主对话、协作图、节点详情、计划确认(直接执行/补充/重新计划)、审批、审核结果、交付物预览、
  事件时间线、执行配置探针面板。布局在 1400/1180/980px 三档断点重排。
- 界面重做(m03169 之后): `apps/web/src/lib/theme.ts` 新增主题钩子; `index.html` 内联脚本在首帧前定主题;
  `styles.css` 重写为双主题令牌(深色 #0a0b10 / 浅色 #f6f7fb, 强调色与语义色各一套);
  协作图改为按容器真实尺寸布局(`ResizeObserver` + CSS 点阵背景 + 节点投影), 修掉了 SVG 等比缩放导致的
  文字误穿与左右留白, 以及等宽字体在 10.5px 下出现横线穿透的渲染问题;
  修复任务列表/标题/表格/产物预览处的文字裁切(ellipsis + `overflow-wrap`), 产物预览改为整段可读(不再半行截断)。
- 关网页即停服务(ADR-011): `apps/web/src/lib/runtime.ts` 每 2s 心跳, 关闭/刷新时 `sendBeacon` 发关闭意图;
  `apps/server/src/runtime-control.ts` 的 `UiWatchdog` 在宽限期(默认 2.5s)后优雅关停, 刷新由新心跳取消,
  心跳中断 12s 且无活跃会话时兜底; `beforeunload` 触发浏览器自带确认框, 侧栏常驻提示"关闭页面将停止后台服务"。
  关停走 `engine.shutdown()` + 新增的 `Engine.settleOnShutdown()`: 关会话/杀子进程/记 `interrupted`/审批置 `expired`/
  任务置 `paused`, 不自动重跑。`HH_EXIT_WITH_UI=0` 可恢复常驻模式。
- 协作画布重做(m04290 / m04786 / m04829 三次反馈后, ADR-013):
  `apps/web/src/components/CollabGraph.tsx` 重写为 **Lancer 式列布局** ——
  阶段步进条(规划→讨论→执行→集成→验证→审核→交付)、按流水段分列(主控/规划 → 执行者 → 审核席位 → 交付)、
  列内卡片堆叠(名称 / 角色 / harness / 模型 / 状态点 / 当前动作 / 列内工作项清单 / 自然增长耗时)、
  **连线只走列间空隙并带贝塞尔 + 点线**(结构上不会压到卡片)、活动时才有流动虚线 + 光点 + 呼吸光晕
  (`prefers-reduced-motion` 全降级)、每席位固定色相用于色条与连线。
  `styles.css` 以 `.cx-*` 体系替换旧 `.cv-*`(旧段已删除); `lib/format.ts` 增加 `duration()` 与 `initials()`;
  `lib/theme.ts` 提供 `useTheme()` 切换; 节点详情浮层改为不透明背景 + 400px 宽。
  mock 适配器在"≥2 个执行者"时生成互不依赖的工作项(`planFor()`), 用于演示并发, 单执行者仍串行。

- 执行配置的"模型 / 推理强度"经真实调用核验并如实标注: 两字段都是**会话级覆盖**(Codex `thread/start`+`turn/start`、
  Claude SDK `query({model, effort})`、DSH `session/set_config_option`), 不改 harness 配置文件; 留空即用 harness 自己的配置。
  用非法值反证: Claude 模型报 `[claude-code:unrecognized_model]`(生效)、Claude `effort` 填非法值不报错(未验证/可能被忽略)、
  DSH 模型与推理都报 `Invalid params: unknown ...`(均生效)、Codex 仅代码路径确认。证据在
  `docs/evidence/model-override-2026-11-04.json`, 结论写进 `docs/compatibility.md` 与 web 面板字段提示。
  同时收紧 live 探针: 只有真实回合成功才算通过(此前 Claude/Codex 无论成败都报 `ok:true`), 失败时带子进程 stderr 摘要。

- 节点详情面板改为**贴着被点的卡片**浮动(优先右侧, 放不下换左侧, 两侧都不够就放到卡片下方/上方), 并被限制在画布区域内, 不再固定停在右下角挡住卡片。
- 不再内置 harness 副本(移除了 579 个包), 执行入口只解析本机安装; 入口解析失败会变成 `ok:false` 的探针结果而不是 500。
- 执行入口不再绑定项目内副本: 新增 `packages/adapters/src/exec.ts`(绝对路径 / PATH 命令名 / 留空自动探测;
  `.js`→node、`.exe`→直接、`.cmd|.bat`→cmd.exe、`.ps1`→powershell; Claude 从 `.cmd` 解析真实 exe)。
  本机实测: `codex` → 全局 0.166.0 握手通过; `claude` → 全局 2.1.318 live 通过; DSH 无全局安装 → 退回项目内。
  `PATCH /api/profiles/:id` 允许把入口清空回到自动探测。

- 自动化测试 `tests/`: 36 项通过(`npm test`)。
  - `tests/core.test.ts` 14 项: 路径安全、计划校验(强制全部强模型审核/越界拒绝/未选参与者报错/依赖环/数量上限)、
    调度(依赖就绪、并发上限、每配置串行、写入范围冲突、死锁判定)。
  - `tests/engine.mock.test.ts` 7 项: 单强模型全链路、双强模型讨论+交叉复核、同配置回合不重叠、
    取消语义、重启恢复不自动重跑、PLAN-02/04/05(补充生成 v2、旧版本作废、过期/重复批准被拒)、
    PLAN-06(执行中范围变化 → 暂停并请求新版本)。
  - `tests/runtime.test.ts` 5 项: 关闭意图到期关停、心跳取消关停、心跳超时兜底(有活跃会话时不关停)、
    开关关闭时只报告状态。
  - `tests/http.test.ts` 4 项: SECURITY-01(非本机 Host 403、跨站 Origin 403、非 JSON 415)、
    API 校验(422/404/未知产物 404)、PLAN-03/05(幂等、哈希与版本冲突 409、重复批准 409)、
    SSE(首帧快照、事件 seq 作 id、过旧游标 `resync_required`)。
- P6 故障演练(mock, 证据 `docs/evidence/p6-cancel-resume-2026-11-04.json`):
  - 执行中取消 → `attempt.cancel_requested` + `attempt.cancel_confirmed`, 任务 `cancelled`, 不再登记产物。
  - 执行中强制结束服务进程 → 重启后任务 `paused`/`restart_recovered`, 0 个未关闭会话, 中断尝试记 `service_restart`,
    被中断的工作项回到 `pending`(不再出现"卡在 running 但没有进程")。
  - 用户手动恢复 → 重新派发 → `delivery/completed`, 3 个产物, 1 轮审核, 已有产物不重复登记。
- 计划生命周期加固: `decidePlan` 增加状态门禁(已批准 → `plan_already_approved`, 已作废 → `stale_plan`),
  防止重复批准导致重复建工作项与重复派发; `PlanContent.revisionNote` 记录补充原因并参与 contentHash。
- 引擎可关闭: `Engine.shutdown()` 停监控、收敛在跑回合、标记 stopped; 服务停机与测试均先 `await shutdown()` 再关库,
  避免 "database is not open" 的后台异步错误。
- 执行配置的 `env` 现在会传给适配器(任务级 TEMP/缓存仍然覆盖, 保证隔离), 便于按配置设置 harness 环境变量。
- 新增 `HH_DATA_DIR` / `HH_HOMES_DIR` / `HH_RUNS_DIR`: 演练与测试可用隔离数据目录, 不污染正式库。
- 端到端 mock 闭环(HTTP 层): 建任务 → 规划 → 批准 → 派发 → 产物登记 → 验证 → 审核 → 交付 `DELIVERY.md` → completed。
- 三种真实 harness 的 inspect 探针均成功(不消耗模型额度): Codex 0.166.0 握手 app-server v2、
  Claude Code 2.1.317 版本探测、DSH 0.2.1-rc.5 ACP 握手(protocolVersion=1)。
- 真实回合探针(用户授权范围 m01557: "只做 live 探针", Claude Code 强模型 + DSH 弱模型, 不调用 Codex):
  Claude Code 真实回合 3961ms 返回; DSH 真实回合 13443ms(`stopReason=end_turn`)。
  证据 `docs/evidence/live-probe-2026-11-03.json`, 说明见 `docs/compatibility.md` "live 探针语义"。
- 文档: `README.md`(启动/脚本/环境变量/首次使用/支持版本/限制)、`docs/acceptance.md`(逐条验收矩阵)、
  `docs/decisions.md`(ADR-001..012)、`docs/compatibility.md`、`docs/adding-a-harness.md`、`THIRD-PARTY-NOTICES.md`。
- 执行配置可在网页内增删(ADR-012, m03960): 「执行配置」重做为两栏面板 —— 左侧按 harness 分组并可 `+` 新建,
  右侧表单编辑名称/可执行入口/凭据来源/模型/推理/并发组/环境变量/备注, 支持保存、复制一份、停用-启用、
  inspect 与 live 探针、删除。删除分两种: 默认只停用(`enabled:false`); `?hard=1` 才真正删除, 且仅限
  **从未被任务参与者引用**的配置(引用数 > 0 返回 409 `profile_in_use`)。`ProfileDto.usage` 暴露引用计数。
  同时修掉服务端"无请求体的 DELETE 被 415 拒绝"的缺陷(只在确实带体时才要求 `application/json`)。

## 交付后的返工循环

- `sendUserMessage` 在 `completed / blocked / failed` 且无活跃会话时, 收到 `intent='supplement'` 会把任务拉回 `planning`: 发 `task.control{action:'revision_requested'}`, 生成新计划版本(仍走批准门槛), 批准后重新执行/审核/交付。
- `planningStage` 在存在已批准版本时附带 `previousPlan`、`existingArtifacts`(路径+大小+sha 前缀)、`revisionMode:true` 与 `revisionInstructions`, 提示词要求"只改被点名的部分, 其余产物原样保留"。
- 修掉一个真实缺陷: `verifyWorkItem` 原来按 `workItemId` 找产物, 返工时同内容文件被 `insertArtifact` 去重成上一轮记录, 于是"文件明明在却报没有登记到产物"; 改为按本工作项声明的**输出路径**归属。
- 前端: 对话页在终态显示提示条「我要改成果」(切到"补充 / 要求修改"并聚焦输入框), 输入框占位文案随状态变化。
- 测试: 新增"交付后提修改: 生成新计划版本并重新走 执行 → 审核 → 交付", 现在 **43 项**。

## 任务清理(删除任务只留产物)

- 新增 `DELETE /api/tasks/:id`(`?keepArtifacts=0` 可连产物一起丢): 先把当前登记的产物复制到 `.local/archive/<taskId>/` 并写 `manifest.json`, 再在一个事务里删掉任务与全部从属记录(事件表没有外键, 显式删), 最后删掉程序自己的临时工作区。任务仍有未结束会话时返回 409 task_busy。
- 侧栏每个任务卡右上角加了悬浮删除按钮, 标题旁加「清理已完成 N」批量入口; 删除后自动清空当前选中并刷新列表。
- 测试: 新增"删除任务: 归档产物、清空对话与记录"用例, 现在 **42 项**。

## 协作画布: 竖向阶段流 + 阶段间曲线连线

- 画布改为竖向阶段流(主控/规划 → 执行者 → 审核席位 → 交付), 阶段内部网格自动换行, 画布纵向滚动;
- 阶段之间用贝塞尔曲线连接: 连线画在卡片背后的 SVG 里(以容器为坐标系测量每张卡的位置),
  控制点只落在阶段空隙; 同一张卡发出多条时起点沿底边铺开; 活动时曲线变流动虚线 + 光点, 无活动静止;
- 顺带修掉一次真实 bug: `CardModel.key`(带 `seat-` 前缀)与卡片上的 `data-ck` 不一致, 导致连线一条都取不到坐标 —— 统一用 `ck` 传参;
- reduced-motion 下停动画并隐藏光点。

## 协作画布改为竖向阶段流

- 阶段自上而下(主控/规划 → 执行者 → 审核席位 → 交付), 阶段内部网格自动换行, 画布整块纵向滚动;
  参与者多、返工轮次多时不再横向溢出。
- 阶段之间只保留一个居中箭头, 带动作名(派发 / 提交审核 / 交付), 有活动时流动虚线, 无活动静止。
- 清掉列布局遗留的常量与 `workerCardHeight`, 断开 `ResizeObserver` 依赖(网格自己排版)。

## 节点详情不再遮挡画布

- 点画布上的卡片后, 详情以**右侧面板**打开, 参与布局而不是浮在画布上; 打开期间它替代停靠栏(计划/对话/审批/审核/产物/事件), 关闭后停靠栏回来。这样画布一直是完整宽度, 四列不会被挤窄, 也不会盖住任何卡片或面板。
- 之前的做法是按卡片位置浮出(会遮挡相邻卡片或停靠栏), 已删除相关的定位测量代码。

## 工作区与权限

- 任务可指定工作目录(`tasks.workspace_root`), 留空用 `.local/runs/<taskId>/workspace`; 执行配置可按 harness 再覆盖(`execution_profiles.workspace_root`), 于是同一个 harness 可以固定指向真实项目目录。
- 执行配置新增 `sandbox`: `read-only` / `workspace-write` / `danger-full-access`(迁移 3)。Codex 映射到原生沙箱与审批策略; Claude Code 映射到 `permissionMode` 并对写类工具做只读硬拒绝; DSH 的 ACP 没有沙箱字段, 如实标注"只能靠提示词与事后审计"。
- 项目外不存在的目录不会被静默创建(返回 422 `workspace_missing`), 避免在用户机器上到处建目录。
- 新增 `tests/workspace.test.ts`(4 项): 自定义工作区生效、缺失目录被拒、sandbox 透传、产物落在自定义工作区; 测试总数 37 → 41。

## 协作画布: 树形卡片重做 + 席位状态修正

- 按参考图把中间画布改成「根卡 → 其余席位 → 交付卡」的树形布局, 卡片自带彩色圆点、耗时、分段进度条与已接受百分比;
  连线是细的彩色贝塞尔曲线, 活动时流动虚线 + 沿曲线光点, reduced-motion 下降级;
- 修掉一次 React #185(无限渲染): 测量 effect 依赖了每次渲染新建的数组;
- 只做审核的强模型(有历史尝试但没有工作项)此前显示「未启动」, 改为按最后一次尝试状态显示 已完成 / 失败 / 等待;
- 没有工作项的席位, 大字改为角色语义(主控「调度」/ 强模型「审核」/ 执行者「待派发」), 不再写「0 项」;
- 用「双强模型 + 执行者」的 mock 任务回归: 计划 → 讨论 → 交叉审核 → 交付全部走通, 两席位 approve 且各交叉复核 1 条。

## 真实 E2E: C++ Hello World(Claude Code 主控 + DeepSeek Harness 执行)

- 任务 `task_1f0752f6cfb74a81be85`: 计划 v1(1 个工作项) → Claude 规划并批准 → DSH 写 hello.cpp、
  用 g++ 编译成 `deliverables\hello.exe`、运行并记录真实输出 → Claude 审核 approve → 交付;
- 结果: `delivery/completed`, 工作项 1/1 accepted, 4 个产物(hello.cpp 97B、hello.exe 53.4KB、
  verification.md、DELIVERY.md); 我在工作区直接运行 `deliverables\hello.exe` 得到 `Hello, World!`、退出码 0;
- 过程中暴露并修掉两个真问题:
  - **harness 崩溃但产物已齐**: DSH 最后一回合返回空结果(`prompt_failed`), 原先直接判工作项失败;
    现在只要本工作项声明的输出都存在且验证通过, 就以"产物为准"接受, 并记
    `error.reported{code:'harness_crashed_but_verified'}` 便于追溯(单测 `tests/salvage.test.ts`);
  - **验证命令假通过**: 模型把 `findstr "Hello, World!" file` 写进 validationCommand, cmd 把引号拆成多个
    文件参数 → 打印 `FINDSTR: Cannot open World!"` 但退出码仍是 0, 旧逻辑记 passed。现在除退出码外还检查
    输出里的失败特征(FINDSTR 打不开、不是内部或外部命令、拒绝访问等), 命中即判失败并写清原因
    (单测 `tests/validation-noise.test.ts`);
- 计划提示同步补了一条: `findstr` 必须写 `/c:"整串"`, 只写 `findstr "Hello, World!" file` 必然报错。

## 进行中

- 无。真实任务验收(E2E-01/E2E-02)等待用户明确授权(m01951 选择"暂不授权")。

## 待办

1. 真实任务验收(课程报告 / C++ 程序设计): 需用户给出执行配置与范围; 建议 Claude Code 主控+强模型、DSH 执行者。
2. 真实 harness 下的取消/重启/并行写入实测(目前只有 mock 演练)。
3. MON-06 时延测量与 UI-03 窄屏/无障碍系统测试。
4. 前端细节: 单参与者时协作图仍偏空, 可考虑补充阶段时间轴或运行指标条。

## 已知问题

- Windows 下 Codex 沙箱 `windowsSandbox/readiness` 报 `updateRequired`, 未经管理员准备时隔离较弱(命令可执行、可落盘)。
- 事件接口默认 SSE; 一次性回放使用 `?format=json` 或 `Accept: application/json`。
- `node:sqlite` 在 Node 24 仍是实验 API, 跨大版本升级需回归。

## 仓库

- 源码仓库: <https://github.com/cunyu999/harness-hub>(public, 默认分支 `main`), 2026-11-04 由用户授权后首次推送。
- 纳入版本控制: 源码(`apps/`、`packages/`)、测试(`tests/`)、文档与截图(`docs/`)、`package.json` + `package-lock.json`、`tsconfig.json`、`SYSTEM_BLUEPRINT.md`、`THIRD-PARTY-NOTICES.md`。
- 排除: `.local/`(数据库、工作区、日志、凭据副本)、`node_modules/`、`dist/`、`apps/web/dist/`、`.npmrc`(含本机绝对缓存路径)、`START_HERE.md`(对话交接说明)。

## 真实 E2E 暴露的问题(hello world)

用 Claude Code(主控/强模型) + DeepSeek Harness(执行者) 连跑 hello world, 每轮暴露一个真实缺陷, 均已修复:

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 适配器报 `prompt_failed: Cannot read properties of undefined (reading 'stopReason')` | DSH 的 `session/prompt` 返回空结果时直接读字段 | 空结果按 `prompt_failed` 处理, live 探针同样回退为 `empty_result` |
| 2 | 验证命令全部失败但只显示"验证未通过" | 失败分支没带出检查项与输出 | 失败信息改为 `验证未通过 (<checkId>: <detail 前 300 字>)` |
| 3 | Windows 弹 `cmd.exe 0xc0000142`, 验证永远失败 | `runValidationCommand` 只传任务级临时目录环境, 丢了 `SystemRoot`/`PATH`/`ComSpec` | 改为 `{ ...process.env, ...taskSessionEnv(taskId) }`, 并显式传 taskId |
| 4 | `./hello.exe` 在 cmd 下报 `'.' 不是内部或外部命令` | 模型按 Unix 习惯写验证命令 | Windows 上把 `./` 归一成 `.\\`, 并在计划提示里写明规则 |
| 5 | 只读/复核类工作项永远 `verification_failed` | 判定要求"有产物", 而复核项本来不产出文件 | 改为"声明了输出路径才要求产物" |

同时补了两条运行期补救能力(真实 E2E 卡住后必须有出口):

- **回答澄清并继续**: 工作项进入 `waiting_input` 后, 用户在对话里选"回答"(intent=answer), 回答会写进该工作项的 `user_note`(迁移 4), 该项回到 `pending` 继续执行, 不再被当成闲聊。
- **单项重试**: `POST /api/tasks/:id/work-items/:itemId/retry`, 就地重跑某一项(可附 note), 不产生新计划版本, 已接受的其他项不受影响; 交付后重试会重新走审核与交付。

测试: 新增 `tests/recover.test.ts`(2 项), 合计 **48/48**。

## 复核席位不再被环境限制拖死

真实 E2E 里, 复核类工作项(没有声明文件产物)尝试在沙箱内执行二进制, 拿到 exit 127 / 空输出后返回 `needs_input`, 任务停在 `waiting_user` 等人来救。这不是模型能力问题, 是提示词没给它"只读复核"的角色边界。

修复(纯提示词层, 不改状态机):

- 新增 `REVIEW_ONLY_RULE`: 只读复核项不得重新编译/执行/改文件, 判据是"产物内容 + 验证记录 + sha256"; 环境受限时把检查记为 skipped, 照常给结论, **环境限制不是 needs_input 的理由**。
- 新增 `VALIDATION_SHELL_NOTE`: 计划阶段就要知道 `validationCommand` 在 Windows 上是 `cmd.exe /d /s /c`、没有 grep/sed、`./x` 会被归一成 `.\\x`。
- 审核提示补两条: 环境限制不构成审核阻塞(只有"产物缺失/无法读取"才 `unable_to_review`); Windows 上要跑命令用 `cmd /c "相对路径"`(Claude Code 的 Bash 是 Git Bash, 反斜杠路径会 127)。

实测: 对已交付任务 `task_aa47d176ed1142dc9206` 的复核项执行单项重试, **90 秒**内完成(此前是 18 分钟反复执行 + 永久阻塞), 复核结论自述"read-only review, did not re-execute anything, relying on the program verification record", 任务重新走到 `delivery/completed`, 两轮审核均 approve。

测试: 新增 `tests/prompts.test.ts`(3 项, 锁住这三条提示词约束), 合计 **48/48**。

## 计划卡与交付物卡也能点开

画布上之前只有"席位卡"能点开右侧详情; 计划卡和交付物卡是死的, 只能去页签里翻。现在:

- 计划卡 → 右侧显示: 版本/状态/内容哈希/规划者/生成时间/历史版本/批准记录、目标与假设、**待你确认**、工作项清单(含运行时状态与验收标准)、交付物、审核策略、验证步骤、风险与未决问题。
- 交付物卡 → 右侧显示: 已登记文件数、工作项接受数、验证通过数、审核轮次与结论、工作区路径、文件清单(大小/类型/sha256/登记时间)、验证记录、各席位审核结论。
- 两张卡都可点: 悬停出现"查看详情 ›", 选中态有强调色描边; **再点一次同一个节点/卡片即收起**, 不必去按右上角关闭。

界面验证: 计划卡 / 交付卡都能在右侧打开详情(截图仅本地留存, 不随仓库分发)。

## 角色大工作区 + 席位小工作区, 以及与任意席位对话

- 任务目录结构: `deliverables/` + `planner/<席位>/` + `worker/<席位>/`; 会话 cwd 从"任务工作区根"改为"席位小工作区", 交付物仍统一写到 `<base>/deliverables`(提示词里给绝对路径, mock 适配器也照此写)。
- 席位(participants)新增 `workspace_root` 与 `sandbox` 两列(迁移 5), 支持逐个席位改工作区与权限; 权限优先级: 席位 > 执行配置。
- 新建任务默认按角色给权限: planner = 完全权限, worker = 工作区内可写, 对话框里可改(API: `plannerSandbox` / `workerSandbox`)。
- 对话页重做: 可选对话对象(主控或任一席位)、可就地改该席位的工作目录与会话权限、可只看与它的对话; 画布卡片详情里加「和它对话」。
- 新增 `GET/PATCH /api/tasks/:id/participants/:participantId`; `POST /messages` 支持 `participantId`。
- 修掉两个实现缺陷: `mapParticipant` 漏读新列导致 API 看不到沙箱/工作区; mock 适配器把产物写到了席位 cwd 而不是 `deliverables`。

## 修: 关掉网页后后台没退出

- 症状: 关掉标签页后服务仍在, 重新打开网址还能进。
- 根因: 页面心跳是无请求体的 `POST /api/runtime/heartbeat`, 服务端的写请求校验要求 `Content-Type: application/json`, 于是心跳全部 415; `pageSeen` 一直是 false, 关闭意图与空闲兜底都失效。
- 修复: 只有"确实带请求体"的写请求才要求 JSON; 前端心跳显式带 `{}`; 新增回归测试(空体 POST 200, 带体但非 JSON 仍 415)。
- 实测: 打开页面 → `/api/runtime` 显示 `pageSeen:true`; 关闭页面 → 服务 2.5 秒后退出(脚本 `.local/tmp/verify-close.mjs`)。

## 抗 0xC0000142(Windows 子进程起不来)

- 现象: 偶发系统弹窗「应用程序无法正常启动 (0xC0000142)」, 对应的可能是 `node.exe` 或 `cmd.exe`。
- 定位: 该码是 `STATUS_DLL_INIT_FAILED`, 发生在加载器阶段; 已知诱因包括子进程环境块被污染(Path/PATH 重复、关键变量为空)、以及从"控制台已失效"的父进程继承句柄。实测本机 11 轮 spawn(带 detached 与不带)均正常, 未复现, 因此按"加固 + 自愈"处理。
- 改动: `packages/adapters/src/exec.ts` 新增 `buildChildEnv()`(去重/清洗/关键变量兜底)与 `spawnHarness()`(0xC0000142 时用最小可信环境重试一次); codex/dsh 的两处 `spawn` 全部改走 `spawnHarness`; `engine.runValidationCommand` 对同一退出码重试一次。
- 测试: `tests/exec-env.test.ts`(3 项)覆盖去重、空值兜底、非法键丢弃; `npm test` 55/55。

## 工作区三层结构 + 运行中改目录

- 新建任务填的目录作为大工作区, 自动生成 `planner/<席位>`、`worker/<席位>`、`deliverables/`、`uploads/`;
- 对话栏「工作区」「权限」两个独立按钮(各自保存), 支持目录浏览选择;
- 席位正在跑时提供「立即重启会话」: 取消当前会话 → 用新目录重开(实测事件 `attempt.cancel_requested` / `attempt.cancel_confirmed`, 会话从 closed 变 open 且任务继续执行)。
