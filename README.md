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
npm start                         # 也可以用 node dist/apps/server/src/index.js(会自动套一层不弹框的启动器)
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

任务创建时会按角色划分目录, 每个席位在自己的小工作区里干活:

```
<任务工作区>/
  deliverables/        # 所有交付物都写到这里(唯一对外承诺的目录)
  planner/             # 强模型(planner)大工作区
    <席位 slug>/       # 每个 harness 一份, 同种 harness 多份配置也各自独立
  worker/              # 执行者(worker)大工作区
    <席位 slug>/
```

默认权限: planner 完全权限, worker 工作区内可写; 新建任务时可以在对话框里按角色改默认值, 建好后还能在对话栏逐个席位改(见上一节)。

### 选择工作区与上传附件

- 新建任务、以及对话栏的「工作区 / 权限」里, 工作目录都可以点 **选择…** 打开目录选择器: 只读浏览本机目录(盘符 / 主目录 → 逐级进入), 选中后填绝对路径, 不需要手敲。
- 对话栏支持附件: **+ 附件** 按钮、直接把文件拖进输入区、或粘贴截图。文件会存到该任务工作区的 uploads/ 下, 消息里保留文件名与大小, 发给模型时把绝对路径写进正文, 各 harness 用自己的读文件工具打开即可。单文件上限 30MB, 一次最多 8 个。
- 输入体验对齐普通 harness: **Enter 发送, Shift+Enter 换行**, 输入法组合期间不会误发。

### 工作区的三层结构

新建任务时填的「工作目录」就是**大工作区**, 程序会在里面建三个中层目录, 再给每个席位建小工作区:

```
<大工作区>/
├─ planner/<席位>/        每个强模型自己的 cwd
├─ worker/<席位>/         每个执行者自己的 cwd
├─ deliverables/          所有产物与交付说明(跨席位共享, 只读引用)
└─ uploads/               对话里上传的附件
```

- 席位卡 → 对话栏 → 「工作区」可以随时改这个席位的 cwd(留空 = 自动分配), 也可以点「选择…」从目录树里挑;
- 改动对**下一回合**生效; 席位正在跑时面板会多一个「立即重启会话」, 点了会取消当前会话并让它用新目录重开(事件里能看到 `attempt.cancel_requested` / `attempt.cancel_confirmed`);
- 「权限」与「工作区」是两个独立按钮、各自保存, 互不影响。

### 工作区与权限

- **任务级**: 新建任务时可以填「工作目录」。留空则每个任务用 `.local/runs/<taskId>/workspace` 作为工作区, 所有参与者(主控/讨论者/执行者/审核者)共用它。
- **配置级**: 执行配置里的「工作目录」优先于任务级——同一个 harness 可以固定指向某个真实项目目录, 于是你平时用 IDE 打开的那个目录就是它工作的地方, 产物也落在那里。
- **不静默造目录**: 填了不存在的路径且该路径在项目外时, 建任务会返回 `422 workspace_missing`, 让你先手动创建; 只有项目内的路径会自动 `mkdir -p`。
- **会话权限** 三档, 按 harness 原生能力生效:

  | 档位 | Codex | Claude Code | DeepSeek Harness |
  | --- | --- | --- | --- |
  | 只读 `read-only` | `sandbox: read-only` + 审批 `never` | `permissionMode: plan` + 写类工具直接拒绝 | 只能靠提示词(无沙箱), 越界靠事后审计 |
  | 工作区内可写 `workspace-write`(默认) | `sandbox: workspace-write` + 审批 `on-request` | `permissionMode: default`, 逐次审批 | 同上 |
  | 完全权限 `danger-full-access` | `sandbox: danger-full-access` + 审批 `never` | `permissionMode: bypassPermissions` | 同上 |

  作用范围是**该 harness 发起的会话**, 不改它的配置文件; DSH 的 ACP 协议没有沙箱参数, 所以它在界面上如实标注为"只能靠提示词与事后审计", 不假装有隔离。

### 和任意席位直接对话

对话页顶部的「对话对象」下拉里, 除了主控, 每个强模型和执行者都在列表里。选中谁, 消息就只发给谁; 勾选「只看与它的对话」可以滤掉其他席位的发言。点画布上的任意卡片 → 「和它对话」也会直接切过去。

对话栏右侧的「工作区 / 权限」可以就地改这个席位的:

| 字段 | 含义 |
| --- | --- |
| 工作目录 | 该席位会话的 cwd。可以写绝对路径, 也可以写相对**任务工作区**的路径(例如 `worker/reviewer`); 留空 = 按角色自动分配 |
| 会话权限 | 只读 / 工作区内可写 / 完全权限。只影响这个席位之后的会话, 正在跑的回合不受影响 |

权限由 harness 原生生效: Codex 用沙箱, Claude Code 用 permissionMode + 工具拦截, DSH 只能靠提示词与事后审计(界面上也这么写)。

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
| Claude Code | `@anthropic-ai/claude-agent-sdk` 驱动本机安装的 `claude.exe` | 2.1.318 / SDK 0.3.317 | 完整原生 CLI 会话: 工具、权限回调、续接、中断 |
| DeepSeek Harness | `dsh --profile acp`(ACP over stdio) | 0.2.1-rc.5 | 完整原生 ACP 会话: 提示、工具调用、权限请求、取消、恢复 |
| Mock | 进程内确定性适配器 | 1.0.0 | 仅用于规则与状态机测试, UI 中明确标注 mock |

平台: Windows 11(开发机实测)。Node.js 24.15.0 开发/运行。

**这三个 harness 都不在仓库里**, 需要你先在本机装好并登录; 装法与执行配置见
[docs/harness-setup.md](docs/harness-setup.md)。

## 已实现 / 已验证 / 未验证

详细的阶段状态与证据见 `docs/progress.md`、`docs/compatibility.md`、`docs/evidence/`。

- **已验证**: 计划版本与三重绑定、批准门槛、派发依赖与并发上限、写入范围隔离判定、产物登记与哈希、
  程序验证记录、单/多强模型审核(含交叉复核留痕)、交付说明生成、取消语义、重启恢复不自动重跑、
  SSE 快照+增量+心跳+resync、mock 全链路端到端。
- **已验证(真实进程)**: Codex / Claude Code / DSH 的 inspect 握手; Claude Code 与 DSH 的 live 真实回合
  (Claude Code completed, DSH `stopReason=end_turn`)。
- **已验证(真实任务闭环)**: 课程报告(Word, 宋体小四, ≤500 字)、C++ 程序设计、C++ Hello World
  (Claude Code 主控 + DSH 执行)都跑到 `delivery/completed`, 产物经程序验证与人工查阅。
- **未验证**: Codex live 回合(需要你先授权调用)、真实进程"取消"在长回合中途的实测。
- **自动化验收**: `npm test` 64 项、`scripts/acceptance-api.mjs` 53 项、`scripts/acceptance-ui.mjs` 27 项,
  见 `docs/acceptance-report.md` 与 `docs/acceptance-checklist.md`(需求 → 证据对照)。

## 设计要点

- **模型判断 vs 程序强制**: 模型只能"提出"计划; 依赖无环、路径安全、验收要求、参与者合法、
  审核席位不得缩减等由程序强制(`packages/core/src/plan.ts`)。
- **事件是唯一真相**: 所有状态变化先落库为带 `seq` 的事件, SSE 以 `seq` 作 `id`, 支持
  `Last-Event-ID`/`after` 与 `resync_required`; UI 不在前端重放业务规则。
- **进程退出 0 ≠ 任务完成**: 完成需产物登记 + 验证通过 + 审核通过 + 交付写入。
- **停止请求 ≠ 已停止**: 只有原生协议确认停止才记 `cancelled`, 否则记 `interrupted`。
- **重启不重跑副作用**: 启动时把活动尝试标为 `interrupted`、未决审批标 `expired`、活动任务置 `paused`,
  由用户确认后再继续。

### 画布上什么都能点开

席位卡、计划卡、交付物卡都可以点: 右侧会变成详情面板(参与布局, 不遮画布), 再点一次同一个卡片就收起。

- 席位卡: 配置与模型、运行状态、计划(主控)、工作统计、工作项明细、活动会话、最近尝试、该节点产出、最近事件。
- 计划卡: 版本与批准记录、目标与假设、工作项清单、交付物、审核策略、验证步骤、风险。
- 交付物卡: 文件清单与哈希、验证记录、各席位审核结论、工作区路径。

### 复核类工作项是只读的

计划里"独立复核/验收核对"这类工作项不产出文件, 程序会把它们当**只读复核**处理: 不允许重新编译、不允许执行二进制、不允许改文件, 判据是产物内容 + 程序验证记录 + sha256。

这样做是因为真实 E2E 里复核席位在沙箱内执行二进制拿到 exit 127, 然后一直要求"到沙箱外重跑", 把任务拖死。现在它在环境受限时会写"未重新执行, 依据验证记录"并照常给结论。

## 卡住的时候: 回答澄清 / 单项重试

- 工作项自己说"需要确认"时, 任务会停在 `waiting_user`; 在对话里把 intent 选成 **回答**, 内容会送回那个工作项并让它继续(不会当成闲聊丢掉)。
- 某一项因环境限制失败时, 可以只重跑这一项: `POST /api/tasks/:id/work-items/:itemId/retry`(body 可带 `{"note":"..."}`), 不产生新的计划版本, 已接受的其他项不受影响。

## 交付之后不满意怎么办

任务跑到 `delivery/completed` 就会**停下等你**, 不会自己继续。想改的时候不用新建任务:

1. 打开「对话」页, 底部会出现提示条 —— 点「我要改成果」(会自动把意图切成"补充 / 要求修改")。
2. 写清楚要改哪里, 例如"第二节太笼统, 换成带步骤的版本"。
3. 发送后会**重新出计划(v2/v3…)**, 并且仍然要你批准: 「直接执行 / 补充内容 / 重新计划」。
4. 批准后重新走 **派发 → 执行 → 验证 → 审核 → 交付**, 最后一版计划成为当前生效版本。

修订轮会把**上一版计划、现有产物清单(路径+大小+sha256)和你的原话**一起交给主控, 并要求它只改被点名的部分、其余产物原样保留。同样适用于 `blocked` / `failed` 的任务(修掉问题再来一轮)。

## 任务管理

左侧任务列表会越堆越多, 所以每个任务卡右上角有一个删除按钮(鼠标移上去才显示), 侧栏标题旁还有「清理已完成 N」可以一次清掉所有已结束的任务。

删除的语义是**清理记录、保留成果**:

- 删除: 任务、计划版本、工作项、会话与**全部对话消息**、事件流、审批/审核/验证记录、产物登记。
- 保留: 已登记的**成果产物**会被复制到 `.local/archive/<taskId>/`, 同目录下生成 `manifest.json`(标题、目标、参与者、计划版本、文件清单与 sha256)。
- 如果任务用的是你自己的目录, 那里面的文件不会被改动; 只有程序自己的临时工作区(`.local/runs/<taskId>`)会被删掉。
- 任务还有未结束的会话时拒绝删除(409), 先取消任务。

### 归档

删除任务时保留的成果放在 `.local/archive/<taskId>/`。侧栏「归档」按钮可以查看这些归档项目(标题、任务 ID、文件数、大小、归档时间与目标摘要), 并对**单个**归档点「彻底删除」——它会把那个目录连同里面的文件一起删掉, 不做二次留存, 也不进回收站。

```bash
GET    /api/archive              # 列出归档
DELETE /api/archive/:taskId      # 彻底删除一个归档(只接受 task_xxx 这类目录名)
```

### 产物操作

「产物」页签里选中任一产物后, 除了在网页里预览(文本、图片、PDF), 还可以交给系统处理:

- **在文件夹中显示** —— 打开产物所在目录并**选中高亮该文件**(`explorer.exe /select,<绝对路径>`), 和 Codex 点产物后的行为一致;
- **用默认应用打开** —— 走 Windows ShellExecute(`rundll32 url.dll,FileProtocolHandler <绝对路径>`, 失败再退 `powershell Start-Process -FilePath`), 适合 docx/xlsx/exe 这类网页里不该渲染的文件; 命令非 0 退出会把真实 stderr 返回给前端(`500 open_failed`), 不再假装成功。

两个动作都只在**已登记且工作区内存在**的产物上生效, 越界、未登记、文件已删除分别返回 `409 artifact_outside_workspace` / `404 artifact_not_found` / `409 artifact_missing`。
二进制文件(如 docx)不会在网页里被当文本渲染, 而是提示改用默认应用打开。

```bash
POST /api/artifacts/:id/open     # body: {"action":"reveal"|"open"}
```

### 计划栏与工作项详情

计划页签的「工作项」表格只留三列(目标 / 执行者 / 状态), 列宽按内容分配: 目标拿 ~60%, 执行者 96px, 状态 72px。
状态用**彩色圆点 + 中性文字**(不铺底色), 一屏多行时更安静, 也不至于只靠颜色分辨。

**点表格里的任意一行**(或聚焦后按 Enter / 空格)会打开工作项详情, 里面是完整信息:
原始「目标」全文(不再被列宽挤压)、依赖、写入范围、输入、预期产物、验收标准、
执行记录(阶段/状态/起止时间)、该项产出的产物、验证记录, 以及最后一轮的执行结论与未解决问题。
数据全部来自任务快照, 详情里不额外调用模型。

### token 用量

工作过程和结果都能看到真实用量, 全部来自 harness 原生上报, 不估算、不计费:

- **任务头**: `Σ 12.3K tokens` 是已结算回合的累计; 回合进行中额外显示青色 `进行中 +362 tokens`;
- **席位卡**: 卡片脚注显示该席位累计用量(如 `已完成 · 1s 前 · 1.5K tokens`);
- **席位详情**: 「token 用量」一行给出总数与 `输入 / 输出 / 缓存命中` 拆分;
- **对话状态条**: 正在跑的那个回合显示 `· 1.2K tokens`, 随事件即时增长。

归一化在 `packages/core/src/usage.ts`: Claude 的 `input_tokens/cache_read_input_tokens/...`、
Codex 的 `thread/tokenUsage/updated`(`last` 优先)、DSH 的 `session/prompt` 返回用量、
mock 的确定性数字都统一成 `{input, output, cached, total}`; 认不出的形状返回 `null`, 不编造 0。

事件流里有一条 `usage.updated`, 任务快照里多了 `usage: { total, byParticipant, turns }`。

## 界面

真实事件驱动: 画布上的每个状态、每条连线都来自服务端事件与会话快照, 不含模拟动画。
界面支持**浅色/深色主题**(侧栏右上角切换并记住选择, 默认跟随系统),
布局在 1400 / 1180 / 980px 三档断点下重排。

协作画布是**树形卡片 + 彩色曲线**, 自上而下三层:

- **第一层**: 主控席位卡居中, 计划卡与它并排;
- **第二层**: 其余席位(强模型与执行者)平铺;
- **第三层**: 交付卡(已有审核轮次或任务完成时出现);
- **卡片内容**: 彩色圆点 + 名称(运行中显示「当前」且圆点带呼吸光)、角色 · harness · 模型、
  本次耗时与工作项数、按工作项状态分段的细进度条、底部状态与最后活动时间、右侧绿色百分比(已接受比例);
- **曲线**: 父卡底边中点 → 子卡顶边中点的三次贝塞尔, 颜色取子席位色相, 彼此错开不压卡片;
  只做审核、没有工作项的席位显示为「审核 / 已完成」, 不会误标成「未启动」;
- **活动光效**: 只在有活动会话时, 对应曲线变成流动虚线并有一颗沿曲线移动的光点;
  没有活动就完全静止, `prefers-reduced-motion` 下停用动效;
- **阶段步进**: 规划 → 讨论 → 执行 → 集成 → 验证 → 审核 → 交付, 已完成打勾、当前阶段高亮;
- 参与者或返工变多时整体纵向滚动, 不会横向挤压。

交互:

- **点席位卡**直接进入与它的对话; 点计划卡 / 交付卡打开右侧详情面板;
- **详情面板参与布局**(用一列替代停靠栏), 不会盖住画布; 关闭后回到原来的页签;
- 右侧页签: 计划 / 对话 / 审批 / 审核 / 产物 / 事件。

计划确认: 统一计划出来后必须由人选择「直接执行 / 补充内容 / 重新计划」, 批准绑定版本哈希。

## 自动化验收

```bash
npm run build
npm test                            # 64 项单元/集成
npm start                           # 另开一个终端; 截图与验收期间可设 HH_EXIT_WITH_UI=0 常驻
node scripts/acceptance-api.mjs     # 53 项接口契约(用 mock, 不花额度)
node scripts/acceptance-ui.mjs      # 27 项界面断言(无头 Edge + CDP)
node scripts/acceptance-live.mjs    # 真实 harness 闭环(会消耗额度, 需要你点头)
```

接口验收默认**不弹任何真实窗口**: 想看"在文件夹中显示/用默认应用打开"的真实行为, 加 `HH_ACCEPT_SHELL=1`。
这样做是因为早期脚本会打开资源管理器、随后又删掉任务目录, Windows 会留下一个「位置不可用」的模态框。

## 目录

```
apps/server        node:http 服务、SSE、静态资源、私有 home 准备
apps/web           React + Vite 前端(协作图、计划确认、审批、审核、产物、事件)
packages/contracts 实体类型、状态枚举、事件类型、Zod 请求体
packages/storage   node:sqlite 封装、迁移、仓储层
packages/core      计划校验、调度、提示词、事件总线、任务引擎
packages/adapters  codex / claude-code / dsh / mock 适配器与 JSON-RPC 层
tests              node:test 自动化测试
docs               进度、决策(ADR)、兼容性、验收矩阵、证据、harness 接入说明
.local             运行期目录: data/homes/cache/tmp/runs(已 gitignore, 不进仓库)
```

## 仓库不含什么

仓库只保留**能跑起来的最小源码 + 说明**: `apps/`、`packages/`、`tests/`、`docs/`、
`package.json`、`tsconfig.json`、`README.md`、`THIRD-PARTY-NOTICES.md`。

| 不在仓库里 | 说明 |
| --- | --- |
| Codex / Claude Code / DSH 本体 | 各自体积大、许可证不同、且与你本机版本绑定; 装法见 [docs/harness-setup.md](docs/harness-setup.md) |
| `node_modules/`、`dist/`、`apps/web/dist/` | `npm install && npm run build` 生成 |
| `.local/` | 数据库、私有 home(凭据副本)、工作区、`.local/tools` 里的 DSH、日志、归档 |
| 任何密钥 / token | 只存在你本机原有配置与项目内私有 home, 不进仓库 |
| 界面截图 | 与运行无关, 会显著撑大仓库 |

历史提交里仍有早期截图, 当前 HEAD 已不再跟踪(需要彻底瘦身要重写提交历史)。

历史提交里仍有早期截图, 当前 HEAD 已不再跟踪(需要彻底瘦身要重写提交历史)。

克隆后的最小步骤: `npm install` → `npm run build` → `npm start`, 然后按
[docs/harness-setup.md](docs/harness-setup.md) 把本机 harness 接上。

## 明确不做

- 不实现价格配置、费用计算、节省金额或自动价格路由。
- 不额外调用模型询问进度; 监控状态只来自原生事件、连接与进程检查。
- 不监控本程序之外启动的会话。
- 不自动发布、不自动推送代码(仓库的发布动作由人工执行)。

## 遇到「应用程序无法正常启动 (0xC0000142)」/「位置不可用」

这两类弹窗都来自 Windows 自己, 不是本程序的界面, 现在都已从源头处理:

- **0xC0000142**: 加载器失败(常见于 PATH 里的 python 商店别名 stub)。`scripts/start.ps1` 启动时调
  `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX)`, 这个开关是进程级且被
  **子进程继承**, 于是 node → harness → python/cmd 这条链上再失败只会拿到退出码, 不再弹框。
  为避免"必须记住用哪个命令启动", 服务入口 `apps/server/src/index.ts` 在 `main()` 第一行检查
  `HH_ERROR_MODE`; 没置位就用 `start.ps1` 重新拉起自己再转发退出码 —— 所以 `npm start`、IDE 直接运行、
  `node dist/apps/server/src/index.js` 三种启动方式都安全(会看到外层 node + 内层 node 两个进程, 属正常)。
- **「位置不可用 / Location is not available」**: 资源管理器窗口指向了已被删除的目录。原因通常是
  "打开了某个产物所在文件夹之后, 那个任务被删除/归档清理"。现在没有自动清理会去删正在被浏览的目录;
  验收脚本默认不弹真实窗口(`HH_ACCEPT_SHELL=1` 才弹), 且打开后会先关掉再清理。
  若你看到残留窗口, 直接点 OK 关掉即可, 不影响数据。

## 已知限制

- Codex 在 Windows 上的沙箱 `windowsSandbox/readiness` 报 `updateRequired`; 未经管理员准备时命令隔离较弱
  (仍可执行并落盘), 详见 `docs/compatibility.md`。
- `node:sqlite` 在 Node 24 仍为实验 API, 跨大版本升级需回归。
- 真实 harness 的审批请求会原样透传到界面; 若关闭窗口, 待审批请求会在重启后标为 `expired`。
- 第三方许可与再分发要求见 `THIRD-PARTY-NOTICES.md`。

### 心跳与 Content-Type(实现注记)

关闭网页能停掉后台服务, 靠的是页面每 2 秒一次的 `POST /api/runtime/heartbeat`:

- 页面关闭时先发 `sendBeacon('/api/runtime/close-intent')`, 服务等 2.5 秒宽限(刷新不算关闭), 到期优雅关停;
- 兜底: 页面连着过但心跳停了 12 秒, 也会关停;
- **空体 POST 不能要求 Content-Type** —— 浏览器的心跳不带 `Content-Type`, 如果服务端一律要求 `application/json`, 心跳会全部 415, 服务会以为"页面从没连上", 于是关页面也不退出。这个问题真实发生过, 现在有回归测试锁住(`tests/http.test.ts` 的"心跳"用例)。
