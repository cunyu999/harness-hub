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

- 自动化测试 `tests/`: 31 项通过(`npm test`)。
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
