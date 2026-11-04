# Harness Hub · 多 Harness 统一调度

在**本机**统一调度多个原生 AI 编码 harness(Codex、Claude Code、DeepSeek Harness, 可扩展 Hermes 等),
由程序状态机负责计划版本、批准门槛、依赖与并发、审核规则、产物验证与故障恢复, 由模型负责规划判断与执行。

- 技术栈: TypeScript + Node.js + React + SQLite(内置 `node:sqlite`), 本地网页 + 本机后端, 无 Electron。
- 只监听 `127.0.0.1`, 不做多用户、不做云端部署。
- 全部文件(代码、依赖、日志、数据库、工作区、凭据副本)都在本目录内。

## 快速开始

前置: Node.js >= 24(`node:sqlite` 需要), 本机已登录至少一个 harness。

```powershell
git clone https://github.com/cunyu999/harness-hub.git
cd harness-hub
npm install
npm run build                     # 编译后端 + 打包前端
npm start                         # 或: node dist/apps/server/src/index.js
```

浏览器打开 <http://127.0.0.1:4310>。

开发模式(两个终端):

```powershell
npm run build:server; npm run dev:server     # 后端 4310
npm run dev:web                              # 前端 4311, 代理 /api 到 4310
```

常用脚本:

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译 TS 到 `dist/` 并打包前端到 `apps/web/dist` |
| `npm start` | 启动服务(单实例, 端口 4310) |
| `npm test` | 编译并运行 `tests/` 下的自动化测试 |
| `npm run typecheck` | 后端与共享包类型检查 |
| `npm run typecheck:web` | 前端类型检查 |

环境变量(可选): `HH_PORT`(默认 4310)、`HH_HOST`(默认 127.0.0.1)、`HH_ROOT`(默认本目录)、
`HH_SEED_PROFILES=0` 关闭首次启动的示例执行配置。
演练或测试时可用 `HH_DATA_DIR` / `HH_HOMES_DIR` / `HH_RUNS_DIR` 指向隔离目录, 避免污染正式库与工作区。

### 关掉网页就停服务

默认(`HH_EXIT_WITH_UI=1`)后台进程的生命周期跟随网页:

- 关闭页面前, 浏览器会弹出自己的「确定离开?」确认框(文案由浏览器决定, 页面无法自定义);
  左下角也有常驻提示「关闭页面将停止后台服务」。
- 确认离开后, 页面会发一次关闭意图, 服务在 `HH_UI_GRACE_MS`(默认 2500ms)后优雅关停:
  先停调度、关闭原生会话与子进程、把仍在运行的尝试记为 `interrupted`、未决审批记为 `expired`,
  正在执行的任务置为 `paused`, **不会**在下次启动时重跑。
- **刷新页面不会停服务**: 宽限期内新页面发来心跳会取消关停。
- 浏览器崩溃等收不到关闭意图的情况, 由心跳超时兜底: 超过 `HH_UI_IDLE_MS`(默认 12000ms)
  没有心跳且没有活跃会话时关停。
- 如果页面从未连上过, 服务不会自己退出(等你打开浏览器)。
- 需要让服务常驻(例如只用 API、或同时用命令行)时: `HH_EXIT_WITH_UI=0 npm start`。


## 首次使用

1. 打开左下角「执行配置」, 在左侧按 harness 分组选择配置, 或点分组标题旁的 **+** 新建一份
   (选择适配器、填可执行入口与凭据来源目录, 保存即可; 适配器创建后不可改, 避免会话漂移)。
2. 对每份配置点「inspect 探针」确认可执行文件与协议握手正常。
3. 需要真实运行时, 勾选「允许真实调用」并保存; 服务端会把 `~/.codex`、`~/.claude`、`~/.dsh`
   的凭据**复制**到 `.local/homes/<adapter>-<profileId>`(只读复制, 不改动原目录)。
4. 回到主界面「新建任务」: 写标题与目标, 选择强模型(可多选)、主控、执行者。
5. 计划生成后会出现三种选择: **直接执行 / 补充内容 / 重新计划**。批准会绑定
   `planRevisionId + planHash + participantsRevision + expectedTaskVersion`, 计划被改动后旧批准失效。
6. 执行期间左侧协作图实时反映真实会话事件(连接、工具调用、审批、重试、无事件、取消、失败);
   右侧页签可看计划、对话、审批、审核、产物与事件时间线。

### 执行配置可以随时增删(无需改代码)

「执行配置」是一个列表 + 表单的管理面板:

| 操作 | 行为 |
| --- | --- |
| 新建(+) | 在对应 harness 分组下新建一份配置; 同一 harness 可以有任意多份(不同模型/推理/账号 home) |
| 保存 | 修改名称、模型、推理强度、并发组、环境变量、备注 |
| 复制一份 | 以现有配置为模板快速派生一份(live 默认关闭) |
| 停用 / 启用 | 停用后不会被选入新任务, 历史任务快照仍然可追溯 |
| 删除 | 只有**从未被任务引用过**的配置能真正删除; 被引用过的会提示"只能停用"(防止历史失去对照物) |
| inspect / live 探针 | 分别做协议握手与真实短回合, 结论写入该配置并显示在面板底部 |

同一个 harness 的多份配置各有自己的私有 home 与并发组, 可以分别给"主控""审查""执行"用。

**用本机已装的 harness 也可以**: 「可执行入口」既可以填项目内的入口(默认显示在占位符里), 也可以填
`codex` / `claude` / 自己安装的绝对路径。**留空则自动探测**: 只找 PATH 里的同名命令(本项目**不内置**任何 harness 副本)。Windows 的 `.cmd` 垫片会被解析出真实可执行文件(Claude Code 必须指向真实 `.exe`),
所以不会因为"多装了一份"而强迫你换版本, 也不会改动你本机的任何文件。

**关于模型与推理强度**: 面板里的这两项只对**本程序发起的会话**做覆盖, 不会改写 harness 的配置文件
(Codex `config.toml`、Claude `settings.json`/cc-switch、DSH `cordis.yml` 仍归你自己管)。留空即用 harness 自己的配置。
实测结论(详见 `docs/compatibility.md` 与 `docs/evidence/model-override-2026-11-04.json`):
Claude Code 的模型覆盖已验证生效、推理强度填非法值不报错(可能被忽略); DSH 的模型与推理都已验证生效;
Codex 仅代码路径确认, 未做 live 验证。

## 支持的 harness 与版本

| Harness | 接入方式 | 已验证版本 | 说明 |
| --- | --- | --- | --- |
| Codex | `codex app-server`(JSON-RPC over stdio, v2) | 0.166.0 | 完整原生会话: 线程、回合、工具、审批、中断、恢复 |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 驱动项目内 `claude.exe` | 2.1.317 / SDK 0.3.317 | 完整原生 CLI 会话: 工具、权限回调、续接、中断 |
| DeepSeek Harness | `dsh --profile acp`(ACP over stdio) | 0.2.1-rc.5 | 完整原生 ACP 会话: 提示、工具调用、权限请求、取消、恢复 |
| Mock | 进程内确定性适配器 | 1.0.0 | 仅用于规则与状态机测试, UI 中明确标注 mock |

平台: Windows 11(开发机实测)。Node.js 24.15.0 开发/运行, Codex 与 DSH 通过 `node` 启动,
Claude Code 使用随包分发的 Windows 原生可执行文件。

## 已实现 / 已验证 / 未验证

详细的阶段状态与证据见 `docs/progress.md`、`docs/compatibility.md`、`docs/evidence/`。

- **已验证**: 计划版本与三重绑定、批准门槛、派发依赖与并发上限、写入范围隔离判定、产物登记与哈希、
  程序验证记录、单/多强模型审核(含交叉复核留痕)、交付说明生成、取消语义、重启恢复不自动重跑、
  SSE 快照+增量+心跳+resync、mock 全链路端到端。
- **已验证(真实进程)**: Codex / Claude Code / DSH 的 inspect 握手; Claude Code 与 DSH 的 live 真实回合
  (Claude Code completed, DSH `stopReason=end_turn`)。
- **未验证**: 真实模型下完整任务闭环(课程报告、C++ 程序设计)、真实进程取消与重启恢复的实测、
  Codex live 回合(本轮未授权调用)。

## 设计要点

- **模型判断 vs 程序强制**: 模型只能"提出"计划; 依赖无环、路径安全、验收要求、参与者合法、
  审核席位不得缩减等由程序强制(`packages/core/src/plan.ts`)。
- **事件是唯一真相**: 所有状态变化先落库为带 `seq` 的事件, SSE 以 `seq` 作 `id`, 支持
  `Last-Event-ID`/`after` 与 `resync_required`; UI 不在前端重放业务规则。
- **进程退出 0 ≠ 任务完成**: 完成需产物登记 + 验证通过 + 审核通过 + 交付写入。
- **停止请求 ≠ 已停止**: 只有原生协议确认停止才记 `cancelled`, 否则记 `interrupted`。
- **重启不重跑副作用**: 启动时把活动尝试标为 `interrupted`、未决审批标 `expired`、活动任务置 `paused`,
  由用户确认后再继续。

## 界面

真实事件驱动, 下列截图来自 mock 端的完整任务(同一套状态机与 UI 路径)。界面支持**浅色/深色主题**,
侧栏右上角一键切换并记住选择(默认跟随系统); 布局在 1400 / 1180 / 980px 三档断点下重排。

协作画布按 **Lancer 式列布局** 编排, 由服务端事件与会话状态推导, 不含任何模拟动画:

- **阶段步进**: 规划 → 讨论 → 执行 → 集成 → 验证 → 审核 → 交付, 已完成打勾、当前阶段高亮;
- **列 = 流水段**: 主控/规划 → 执行者 → 审核席位 → 交付, 每列内卡片自上而下堆叠,
  列头显示该段数量; 同一执行者的多个工作项收在同一张卡里, 不再挤成一行行胶囊;
- **卡片**: 名称、角色、harness、模型、状态点, 当前动作(工具名 + 提示 / 生成中 / 等待审批 / 进入队列 / 空闲多久),
  当前工作项与**本列工作项清单**(最多 3 条 + "还有 N 项"), 以及本次尝试的**自然增长耗时**;
- **连线**: 只画在列与列之间的空隙里(贝塞尔 + 点线, 颜色跟随来源席位色相),
  因此结构上**不可能压到卡片**; 有活动时才变成流动虚线, 没活动就静止;
- **配色**: 每个席位一个固定色相(用于左侧色条与它的连线), 运行/完成/等待/失败另有语义状态色;
  `prefers-reduced-motion` 下所有动效降级。

计划确认: 统一计划出来后必须由人选择「直接执行 / 补充内容 / 重新计划」, 批准绑定版本哈希。

![计划确认](docs/screenshots/01-plan-approval.png)

多强模型协作图 + 交叉审核结果(每个席位独立结论, 并显示交叉复核条数)。

![协作图与交叉审核](docs/screenshots/02-review-cross-check.png)

产物只按登记 ID 展示, 支持 Markdown / 文本 / 图片 / PDF 内联预览。

![产物预览](docs/screenshots/03-artifact-preview.png)

三个执行者并行时的列布局: 两条在跑、一条排队, 每张卡显示当前工作项与已耗时。

![并发泳道](docs/screenshots/04-concurrent-lanes.png)

统一主对话: 结构化回合按需折叠, 流式增量在尝试结束后清理。

![对话](docs/screenshots/05-conversation.png)

深色主题下的同一泳道视图。

![深色主题](docs/screenshots/06-theme-dark-lanes.png)

1180x860 窄屏: 执行者卡片与工作项改为纵向堆叠, 右侧停靠面板收窄。

![窄屏](docs/screenshots/07-narrow-1180.png)

## 目录

```
apps/server        node:http 服务、SSE、静态资源、私有 home 准备
apps/web           React + Vite 前端(协作图、计划确认、审批、审核、产物、事件)
packages/contracts 实体类型、状态枚举、事件类型、Zod 请求体
packages/storage   node:sqlite 封装、迁移、仓储层
packages/core      计划校验、调度、提示词、事件总线、任务引擎
packages/adapters  codex / claude-code / dsh / mock 适配器与 JSON-RPC 层
tests              node:test 自动化测试
docs               进度、决策(ADR)、兼容性、验收矩阵与证据、界面截图
.local             运行期目录: data/homes/cache/tmp/runs(已 gitignore, 不进仓库)
```

## 仓库不含什么

`.local/`(数据库、工作区、日志、凭据副本)、`node_modules/`、`dist/`、`apps/web/dist/` 均被 `.gitignore`
排除; 仓库只保留源码、测试、文档与截图, 克隆后 `npm install && npm run build` 即可运行。

## 明确不做

- 不实现价格配置、费用计算、节省金额或自动价格路由。
- 不额外调用模型询问进度; 监控状态只来自原生事件、连接与进程检查。
- 不监控本程序之外启动的会话。
- 不自动发布、不自动推送代码(仓库的发布动作由人工执行)。

## 已知限制

- Codex 在 Windows 上的沙箱 `windowsSandbox/readiness` 报 `updateRequired`; 未经管理员准备时命令隔离较弱
  (仍可执行并落盘), 详见 `docs/compatibility.md`。
- `node:sqlite` 在 Node 24 仍为实验 API, 跨大版本升级需回归。
- 真实 harness 的审批请求会原样透传到界面; 若关闭窗口, 待审批请求会在重启后标为 `expired`。
- 第三方许可与再分发要求见 `THIRD-PARTY-NOTICES.md`。
