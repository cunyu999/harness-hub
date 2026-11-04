# 验收矩阵对照表

> 对照 `SYSTEM_BLUEPRINT.md` 第 17 节。状态口径: **已验证**(有可复现证据)、**已实现未验证**(代码在, 缺真实证据)、
> **未实现**、**受阻**(需用户授权或外部条件)。证据位置见文末。

| ID | 结论 | 证据 / 说明 |
| --- | --- | --- |
| REQ-01 同种 harness 两份配置 | 已实现未验证 | `execution_profiles` 各自独立私有 home(`.local/homes/<adapter>-<profileId>`), 只复制不修改 `~/.codex` 等全局目录; 真实双配置并行未跑 |
| REQ-02 新增测试适配器 | 已验证 | `MockAdapter` 仅实现 `HarnessAdapter` 即可注册, 调度/状态机未改动; `tests/engine.mock.test.ts` 全程使用它 |
| REQ-03 只选一个强模型 | 已验证 | 单强模型测试: 无讨论回合, 由主控规划与最终审核(`tests/engine.mock.test.ts` 第 1 项) |
| REQ-04 选两个/三个强模型 | 已验证(mock) | 双强模型测试: 讨论阶段 ≥2 条独立提案, 审核 2 席位且各自 `crossChecked` ≥1 |
| REQ-05 一个强模型缺席 | 已实现未验证 | 适配器失败 → `attempt.failed`, 任务 `blocked`/`error_reported`, 不降级为单模型; 真实缺席未演练 |
| REQ-06 零个 worker | 已验证 | 单强模型任务即零 worker: 主控自己执行工作项 |
| PLAN-01 计划未批准 | 已验证 | 取消测试断言"未批准时 0 个工作项"; 计划阶段不写业务文件 |
| PLAN-02 补充计划 | 已验证 | PLAN-02/04/05 测试: v2 生成, v1 `superseded`, 仍需再次确认 |
| PLAN-03 重新计划 | 已验证 | 重新决策走 `plan.rejected` → 重新规划, 新方案不沿用旧批准 |
| PLAN-04 过期计划执行 | 已验证 | HTTP 测试: `plan_hash_mismatch` / `task_version_conflict` / `stale_plan` 均 409 |
| PLAN-05 重复点击执行 | 已验证 | `plan_already_approved` 409, 工作项不重复创建 |
| PLAN-06 执行中范围变化 | 已验证(mock) | supplement 在执行阶段 → `task.control(scope_change_requires_replan)` + 暂停 + 新版本待批 |
| FORMAT-01 报告未指定格式 | 已实现未验证 | 计划提示要求"未指定时建议 Word 并可改", 真实规划回合未跑 |
| FORMAT-02 指定其他格式 | 已实现未验证 | 格式来自任务/模板, 无内置"报告模式"分支 |
| FORMAT-03 提供模板 | 已实现未验证 | `Deliverable.templateRef`/`OutputSpec.template` 进入计划与验证上下文 |
| FORMAT-04 不可用格式工具 | 已实现未验证 | 验证阶段按实际文件检查, 不伪造文件; 缺工具时报 `verification_failed` |
| DISPATCH-01 两个独立 worker 并行 | 已验证(mock) | 调度器并发上限 + `DISPATCH` 测试(同配置回合不重叠) |
| DISPATCH-02 前置依赖 | 已验证 | `dependencyReady` 测试 + 计划依赖环拒绝 |
| DISPATCH-03 争抢最后名额 | 已验证 | `selectDispatchable` 单元测试: 全局/每配置名额在启动前预留 |
| DISPATCH-04 启动失败 | 已验证(mock) | `session_open_failed` 分类重试 1 次后置 failed, 名额随 attempt 结束释放 |
| DISPATCH-05 DAG 有环 | 已验证 | `findCycle` 单测 + 计划校验拒绝并给出环路径 |
| DISPATCH-06 worker 提议未选模型 | 已验证 | `profileFor` 快照校验 → `profile_drift`, 拒绝换模型 |
| DISPATCH-07 限流与重试叠加 | 已实现未验证 | 外层基础设施重试上限 1(`infraRetries`), 内层归 harness; 真实限流未演练 |
| DISPATCH-08 修复轮上限 | 已验证(mock) | `repairRound < maxRepairRounds` 后置 `failed` 并 `blocked`, 不无限循环 |
| MON-01 全部会话可见 | 已验证(mock) | 快照 `sessions` 覆盖主控/讨论者/worker/审核者; UI 协作图与节点详情按会话渲染 |
| MON-02 工具长运行 | 已实现未验证 | `tool.started/progress/completed` 事件与时长展示; 真实长工具未观测 |
| MON-03 等待审批 | 已验证(mock) | `request.approval` → 审批页; 不自动同意, 过期即 `expired` |
| MON-04 长时间无事件 | 已验证 | `monitorTick` 超阈值发 `monitor.no_recent_event`, 不判失败 |
| MON-05 进程异常退出 | 已实现未验证 | `onExit` → `runtime.exited` + 会话 disconnected/exited; 真实崩溃未演练 |
| MON-06 状态更新 p95 ≤ 2s | 未验证 | 事件驱动即时推送 + 220ms 合并刷新; 尚未做系统性时延测量 |
| MON-07 原生不报进度 | 已验证 | 无百分比字段; 无事件时显示 `no_recent_event`, 不估算 |
| MON-08 前端断线重连 | 已验证 | SSE 测试: 快照 + `id: seq` + 过旧游标 `resync_required` |
| MON-09 不额外调用模型问进度 | 已验证 | 监控只读数据库/进程与原生事件, 无"心跳回合" |
| CANCEL-01 停止单个 worker | 已验证(mock) | `cancel_session` → 仅目标会话 `cancel()`, 记 `attempt.cancel_confirmed` |
| CANCEL-02 取消整个任务 | 已验证(mock) | 演练 `docs/evidence/p6-cancel-resume-2026-11-04.json`: 停止派发 + 会话取消 + `cancelled` |
| CANCEL-03 原生停止失败 | 已实现未验证 | `cancel()` 返回 `confirmed:false` 时保持 `interrupted`/cancelling 语义, 不显示已停止 |
| CANCEL-04 取消中请求恢复 | 已实现未验证 | `cancelling` 生命周期拒绝 resume 派发 |
| RESUME-01 仅刷新网页 | 已验证 | UI 从快照重建(SSE 快照事件), 不重启会话 |
| RESUME-02 服务端重启 | 已验证(mock) | 演练: 重启后 `paused`/`restart_recovered`, 0 未关闭会话, 恢复需手动确认 |
| RESUME-03 PID 复用 | 已实现未验证 | 记录 `pid+startedAt+runtimeNonce`, 存活仅作参考; 未构造 PID 复用场景 |
| RESUME-04 原生无法恢复 | 已实现未验证 | `resumeNativeSessionId` 失败即新建会话并留痕; 真实 harness 未演练 |
| REVIEW-01 自报通过无证据 | 已验证 | 审核前重新校验产物存在/非空/哈希; `verification_results` 独立于 worker 声明 |
| REVIEW-02 多强模型独立+交叉 | 已验证(mock) | 2 席位独立 verdict + 各自 `crossChecked` 留痕 |
| REVIEW-03 审核期间产物变化 | 已验证 | `artifactSetHash` 绑定轮次; 变化则旧审核不匹配 |
| REVIEW-04 重大分歧交用户 | 已验证(mock) | `needs_user_decision` → `waiting_user`; 其余分歧由主控裁决 |
| REVIEW-05 用户接受限制 | 已实现未验证 | `delivery_acceptance` 记录接受人与限制文本; UI 入口未接 |
| FILE-01 并行改代码 | 已验证(mock) | `writeScope` 重叠串行 + 每项独立 workspace 子路径 |
| FILE-02 集成分支整体测试 | 已验证(mock) | 集成阶段重新登记并重跑验证, 不只看各分支 |
| FILE-03 越界/UNC 路径 | 已验证 | `safeJoin` 单测覆盖 `..`/绝对/盘符/UNC; 产物接口只接受登记 ID |
| FILE-04 缓存与认证写入位置 | 部分验证 | 私有 home + 任务级 TEMP/TMP/XDG/npm cache 已在真实 Codex/Claude/DSH 探针确认可运行; 写入位置证据见 `docs/compatibility.md` |
| PERM-01 审批跨会话误用 | 已验证(mock) | 审批绑定 attempt/session, 会话不在则 `session_gone` 409 |
| PERM-02 外部上传/发布 | 已验证 | 无上传/发布/推送代码路径; 提示词禁止网络上传 |
| UI-01 计划卡片三操作 | 已验证 | 截图: 直接执行/补充内容/重新计划 + 绑定说明 |
| UI-02 协作图刷新 | 已验证 | 节点/边由快照与事件推导, 历史不当作实时动画 |
| UI-03 长标题/窄窗口/键盘 | 部分验证 | 有省略与滚动; 窄屏未系统测试 |
| UI-04 真实与 mock 标识 | 已验证 | 节点显示 adapterId/`mock-model`, 任务标题标注 mock |
| SECURITY-01 非法来源请求 | 已验证 | `tests/http.test.ts`: 非本机 Host 403、跨站 Origin 403、非 JSON 415 |
| SECURITY-02 日志无凭据 | 已验证 | 日志与事件不含 token; 凭据文件只在私有 home, 不复制进仓库 |
| E2E-01 真实课程报告 | 未验证 | 用户本轮未授权真实任务 |
| E2E-02 真实 C++ 任务 | 未验证 | 用户本轮未授权真实任务 |

## 证据位置

- 自动化测试: `npm test`(31 项) — `tests/core.test.ts`(14)、`tests/engine.mock.test.ts`(7)、`tests/http.test.ts`(5)、`tests/runtime.test.ts`(5)。
- 故障演练: `docs/evidence/p6-cancel-resume-2026-11-04.json`。
- 真实 harness 探针: `docs/evidence/live-probe-2026-11-03.json`(Claude Code、DSH 真实回合)。
- 界面截图: `.local/tmp/ui-1.png` … `ui-11.png`(空态、计划确认、完成态、产物预览、多模型图、对话折叠)。

## 已知限制

1. 真实 harness 的完整任务链路(E2E-01/02)尚未在授权范围内执行, 因此真实执行、真实审核、真实取消/恢复仍属"已实现未验证"。
2. Windows Codex 沙箱 `readiness=updateRequired`, 未经管理员准备时命令隔离较弱(可执行、可落盘), 详见 `docs/compatibility.md`。
3. `node:sqlite` 在 Node 24 仍是实验 API; 升级大版本需回归。
4. 时延统计(MON-06)与窄屏/无障碍(UI-03)未做系统测量。
