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
| P5 | Lancer 风格 UI | 已实现, 主要界面已截图验证, 细节待打磨 |
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
- 前端 `apps/web`: React + Vite, 深色 Lancer 风格; 统一主对话、协作图、节点详情、计划确认(直接执行/补充/重新计划)、
  审批、审核结果、交付物预览、事件时间线、执行配置探针面板。
- 自动化测试 `tests/`: 25 项通过(`npm test`)。
  - `tests/core.test.ts` 14 项: 路径安全、计划校验(强制全部强模型审核/越界拒绝/未选参与者报错/依赖环/数量上限)、
    调度(依赖就绪、并发上限、每配置串行、写入范围冲突、死锁判定)。
  - `tests/engine.mock.test.ts` 7 项: 单强模型全链路、双强模型讨论+交叉复核、同配置回合不重叠、
    取消语义、重启恢复不自动重跑、PLAN-02/04/05(补充生成 v2、旧版本作废、过期/重复批准被拒)、
    PLAN-06(执行中范围变化 → 暂停并请求新版本)。
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
  `docs/decisions.md`(ADR-001..009)、`docs/compatibility.md`、`THIRD-PARTY-NOTICES.md`。

## 进行中

- 无。真实任务验收(E2E-01/E2E-02)等待用户明确授权(m01951 选择"暂不授权")。

## 待办

1. 真实任务验收(课程报告 / C++ 程序设计): 需用户给出执行配置与范围; 建议 Claude Code 主控+强模型、DSH 执行者。
2. 真实 harness 下的取消/重启/并行写入实测(目前只有 mock 演练)。
3. MON-06 时延测量与 UI-03 窄屏/无障碍系统测试。
4. 前端细节: 协作图在 1 个参与者时偏空, 可再优化布局。

## 已知问题

- Windows 下 Codex 沙箱 `windowsSandbox/readiness` 报 `updateRequired`, 未经管理员准备时隔离较弱(命令可执行、可落盘)。
- 事件接口默认 SSE; 一次性回放使用 `?format=json` 或 `Accept: application/json`。
- `node:sqlite` 在 Node 24 仍是实验 API, 跨大版本升级需回归。
