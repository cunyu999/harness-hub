# 决策记录

## ADR-001 使用 `node:sqlite` 而非 better-sqlite3

- 背景: 需要本机 SQLite 持久化, 且不希望引入需要本机编译的依赖。
- 决策: 使用 Node 24 内置 `node:sqlite` 的 `DatabaseSync`。
- 理由: 内置、无编译、WAL 与事务可用; P0 已实测建表/写入/查询。
- 代价: 该 API 在 Node 24 仍标注 Release candidate, 必须锁定 Node 版本(>=24), 并只使用基础 API。

## ADR-002 HTTP 服务使用 `node:http` 手写路由

- 背景: 需要最小依赖与明确的安全校验(Host/Origin)。
- 决策: 不使用 express/fastify, 手写方法+路径匹配, 统一错误体 `{code,message,details?,correlationId}`。
- 代价: 路由能力有限, 但接口数量可控(约 20 个)。

## ADR-003 适配器直接驱动原生协议, 不做文本代理

- Codex: 通过 `@openai/codex` 的 `app-server`(JSON-RPC over stdio)驱动真实会话。
- Claude Code: 通过 `@anthropic-ai/claude-agent-sdk` 的 `query()`, 指定项目内 `claude.exe`。
- DSH: 通过 `dsh --profile acp`(Agent Client Protocol over stdio)驱动。
- 理由: 用户明确要求接入完整原生 harness; 三者都保留原生工具、审批、取消与会话恢复能力。

## ADR-004 每个执行配置使用项目内私有 home

- 决策: `<root>/.local/homes/<adapter>-<profileId>`, 由服务端从用户已有配置**复制**(不移动)凭据。
- 理由: 满足"全部写入必须位于项目内"的约束, 同时不修改用户全局配置。
- 代价: 凭据更新需重新 probe/同步; 已在界面提供 `configRefs.resync`。

## ADR-005 事件为唯一真相, UI 只消费事件与快照

- 决策: 所有状态变化先写 `events`(自增 seq)再广播; SSE 用 seq 作为 id, 支持 `Last-Event-ID`/`after`。
- 理由: 断线重连、重启恢复、UI 与后端一致性的基础; 禁止 mock 动画。

## ADR-006 计划批准绑定四元组

- 决策: 批准请求必须携带 `planRevisionId + planHash + participantsRevision + expectedTaskVersion`, 任一不匹配返回 409。
- 理由: 防止"批准的不是当前计划"或参与者被替换后仍用旧授权执行。

## ADR-007 进程退出 0 不等于任务完成

- 决策: 工作项只有在"产物登记 + 验证通过 + 审核通过"后才进入 `accepted`; 任务只有在交付验收后 `completed`。
- 理由: 满足验收要求, 避免把空跑当成功。

## ADR-008 依赖以"产物可用"为就绪条件

- 决策: 上游处于 `produced/verifying/awaiting_review/accepted` 时, 后继即可读取其产物; 审核在全部工作项收敛后统一进行。
- 理由: 若依赖必须"审核通过"才放行, 而审核又在全部完成后进行, 会互相等待形成死锁(SYSTEM_BLUEPRINT 6.4 允许"已满足的产物")。

## ADR-009 修复与重试上限由程序强制

- 默认: 基础设施重试 1 次; 修复循环 2 轮; worker 并行 2; 每 profile 1; 原生进程总并发 4。
- 理由: 保留轮数/重试/超时限制, 不做费用统计与价格路由。
