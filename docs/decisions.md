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

## ADR-010 界面双主题与"按容器尺寸布局"的协作图

- 决策: 主题用 CSS 变量双令牌(`:root[data-theme='dark'|'light']`), 由 `index.html` 首帧内联脚本读
  `localStorage['hh.theme']`(缺省跟随 `prefers-color-scheme`)决定, 切换只改 `data-theme` 并写回 localStorage;
  协作图不再用固定 `viewBox` 等比缩放, 而是用 `ResizeObserver` 按容器真实像素重算节点坐标, 点阵背景交给 CSS。
- 理由: 固定 viewBox 在宽画布上会 letterbox(左右留白、节点偏小)或 slice 裁切, 且缩放下小字号等宽字体会出现
  横线穿透、文本被卡片裁切的观感; 按容器布局可让节点保持 1:1 像素、字号稳定, 窄屏重排而不是缩放。
- 取舍: 放弃"整图缩放"的简单实现, 换取可读性; 参与者很多时允许画布纵向滚动而不是压缩卡片。


## ADR-011 后台进程生命周期跟随网页(心跳 + 关闭意图)

- 决策: 默认 HH_EXIT_WITH_UI=1。页面每 2s 发 `POST /api/runtime/heartbeat`; 关闭/刷新时用
  `navigator.sendBeacon` 发 `POST /api/runtime/close-intent`, 服务在 `HH_UI_GRACE_MS`(默认 2500ms)后优雅关停,
  期间收到心跳(刷新场景)则取消。心跳中断 `HH_UI_IDLE_MS`(默认 12000ms)且没有活跃会话时兜底关停。
  关闭前的提示用 `beforeunload`(浏览器自带确认框, 文案不可自定义) + 侧栏常驻提示。
- 理由: 单用户本机工具, 关掉网页后还留一个 node 进程既不直观也容易留下孤儿 harness 子进程;
  但直接 kill 会丢状态, 所以走 `engine.shutdown()` + `settleOnShutdown()`: 关会话、杀子进程、把在跑的尝试记
  `interrupted`、未决审批记 `expired`、活动任务置 `paused`, 下次启动 `recover()` 不会重跑。
- 取舍: 宽限期让刷新不误杀服务, 代价是关页面后约 2.5s 才真正退出; `HH_EXIT_WITH_UI=0` 保留常驻模式,
  便于只用 API 或同时用命令行的场景。

## ADR-012 执行配置在网页内增删, 删除按"是否被引用"分级

- 决策: 「执行配置」做成两栏面板(左列表按 harness 分组 + 右表单), 支持新建、保存、复制一份、停用/启用、
  inspect 与 live 探针、删除。删除分两级: 默认 `enabled:false`(停用, 历史任务快照仍可追溯);
  只有显式 `?hard=1` 且该配置**从未被任何任务参与者引用**时才物理删除, 否则 409 `profile_in_use`。
  `ProfileDto.usage` 暴露引用计数, 列表直接显示"任务 N"。
- 理由: 任务快照绑定的是参与者当时的模型与推理配置, 如果允许删掉被引用过的配置, 历史任务就失去了对照物,
  也无法解释"当时到底用的是哪份配置"。引用计数是唯一能低成本判断的依据, 比"一律禁止删除"更实用。
- 取舍: 想彻底清掉历史引用过的配置需要先删相关任务(目前不提供), 这是有意的 —— 宁可留痕。
- 附带修正: 无请求体的 `DELETE` 不再要求 `Content-Type: application/json`(浏览器不会自动加),
  只在 POST/PATCH 或确实带体的 DELETE 上校验; 否则网页端删除会被 415 挡住。

## ADR-013 协作画布改为"列式编排 + 卡片"模型, 连线只走列间空隙

- 决策: 协作画布从"SVG 矩形 + 文字"改为 **HTML 卡片 + 列布局 + 列间 SVG 连线**(视觉参照 Lancer):
  - 画布按流水段分**列**: 主控/规划 → 执行者 → 审核席位 → 交付; 列内卡片自上而下堆叠, 列头显示该段数量;
  - 每张卡固定四段信息: 头像缩写 + 名称、`角色 · harness · 模型`、当前动作(未配对 `tool.started` 推出的
    工具名 + 提示 / 生成中 / 等待审批 / 队列 / 空闲 Ns 前)、本列工作项清单(最多 3 条 + 还有 N 项)与本次尝试耗时
    (仅在有活动时每 900ms 刷新, 不假造百分比);
  - **连线只画在相邻两列之间的空隙里**: 起点是来源卡右边缘, 终点是目标卡左边缘, 控制点取空隙中线,
    路径 `M x1 y1 C mid y1, mid y2, x2 y2`。因为曲线整体停留在 gutter 内, 结构上**不可能压到任何卡片**,
    这直接解决了前一版"线和框互相遮挡"的问题;
  - 连线默认是点线, 只有源/目标处于运行中才变成流动虚线; 颜色跟随来源席位的色相;
  - 动效仅在活动中出现, `prefers-reduced-motion` 下全部降级;
  - 卡片背景不透明 `var(--surface)`, 避免旧的"半透明卡片让背景连线透成删除线"。
- 理由: 用户明确要求"并列、统一、不要线压框"。列布局把拓扑固定为 DAG 分层, 连线只可能落在列间空白,
  这是**用布局约束消除重叠**, 而不是靠调参把线挪开; 同时一列一角色, 多人并行时对比关系比泳道更直观。
- 取舍:
  - 列布局无法表达"任意跨列依赖", 工作项级别的依赖(如 wi-2 依赖 wi-1)不再逐条画线, 改在卡片内以清单形式呈现;
  - 参与者很多时列宽会被压到最小 168px 并出现横向滚动(宽屏 4 列可完整显示);
  - 画布是 HTML + SVG 的组合, 不能整图导出为单个 SVG 文件。

