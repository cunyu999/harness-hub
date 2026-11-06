# 全量验收记录

最后一次全量验收: 2026-11-06。仓库里只放结论与可复跑的命令, 截图与原始证据留在本机 `.local/`(不提交)。

## 怎么复跑

```bash
npm install
npm run build
npm test          # 引擎/存储/HTTP/适配器/工作区/附件/用量 等 64 项单元与集成测试
npm start         # 默认模式: 关掉网页 2.5s 后后台自动退出
node dist/apps/server/src/index.js   # 等价; 入口会自动再套一层 scripts/start.ps1(设 SetErrorMode), 免得弹系统错误框
```

界面类验收用无头浏览器跑页面内断言(需先 `npm start`), 记录在下方表格。

## 一、单元与集成测试: 64/64

覆盖范围(测试文件 → 断言重点):

| 文件 | 覆盖 |
| --- | --- |
| `tests/core.test.ts` | 路径安全(safeJoin/isInside)、计划校验(依赖环/未选参与者/超上限/审核席位强制全员)、调度器(依赖就绪、全局与每配置并发、写入范围冲突、死锁) |
| `tests/engine.mock.test.ts` | 单强模型全链路、双强模型讨论+交叉复核、取消、重启恢复、计划版本与过期批准、范围变化重新规划、同配置回合不重叠 |
| `tests/http.test.ts` | 只接受本机 Host、Origin 校验、非 JSON 415、422 校验错误、计划哈希/版本 409、SSE 快照与游标过期、适配器探针、执行配置增删与被引用保护 |
| `tests/runtime.test.ts` | 关页面心跳、close-intent 宽限期、心跳取消排队关停、无页面时不退出 |
| `tests/exec.test.ts` | PATH 解析、.js→node、.exe 直启、找不到时报安装提示、Claude 回退到 SDK 自带二进制 |
| `tests/exec-env.test.ts` | 子进程环境去重、空值兜底、非法键丢弃 |
| `tests/workspace.test.ts` | 任务/席位工作区解析、项目外目录不自动创建、权限透传、产物落盘 |
| `tests/artifacts.test.ts` | 同路径产物只保留最新修订为“当前” |
| `tests/attachments.test.ts` | 附件落库与读回、契约校验 |
| `tests/recover.test.ts` | 回答澄清后工作项恢复、单工作项重试不新增计划版本 |
| `tests/salvage.test.ts` | 回合崩溃但产物已验证 → 接受该项 |
| `tests/validation-noise.test.ts` | 退出码 0 但输出含 `FINDSTR: Cannot open` 之类 → 判定验证失败 |
| `tests/prompts.test.ts` | 计划提示含 Windows shell 规则、只读复核规则、审核提示含环境限制说明 |
| `tests/usage.test.ts` | Claude/Codex 两套字段名与"已归一化"形状的 token 归一化、无数据返回空、累加 |
| `tests/archive.test.ts` | 归档列表读到 manifest 与文件统计、删除后目录消失、非法 id 与越界路径被拒 |

## 二、接口级验收: 53/53 (`scripts/acceptance-api.mjs`)

用 mock harness 跑真实引擎(不消耗模型额度), 断言 53 项, 分组:

- A 健康与运行时: health/adapters/runtime、单实例锁(第二个进程 exit 0 并提示"服务已在运行")。
- B/C 执行配置: 创建/复制/改名/停用、被任务引用的配置默认只能停用、`?hard=1` 才 409 `profile_in_use`。
- D 主链路: 创建任务、幂等键复用、计划生成待批准、错误哈希 409、参与者版本 409、正确批准后跑到 `delivery/completed`、工作项全部 accepted、产物 sha256、验证记录、token 用量、事件高水位。
- E 返工: 交付后补充要求 → 计划 v2 → 再批准 → 再次完成。
- F 产物操作: reveal/open 路由接受、非法动作 422、未登记产物 404。
- G 附件与对话: 上传附件、统一主对话落库。
- H 归档: 删除任务→归档可列出→彻底删除单个归档→非法归档 id 400。
- I 边界: 非 JSON 415、跨站 Origin 403、未知任务 404、项目外不存在的工作区 422、空标题 422。
- J 控制: 慢速任务的暂停/恢复/取消, 取消后没有 running 尝试。

> 默认不弹任何真实窗口: 真实 reveal/open 需要 `HH_ACCEPT_SHELL=1`。之前验收脚本打开资源管理器后又把任务目录删掉, 会导致 Windows 弹「位置不可用」, 现已默认关闭并写进脚本注释。

## 三、界面级验收: 27/27 (`scripts/acceptance-ui.mjs`, 无头 Edge + CDP)

| 断言 | 结果 |
| --- | --- |
| 计划页「直接执行/补充内容/重新计划」三按钮 | 通过 |
| 阶段步进 7 段 | 通过 |
| 画布卡片渲染(名称/状态/耗时/进度) | 通过 |
| 侧栏不再显示事件高水位, 事件页签显示 | 通过 |
| 浅色/深色切换 | 通过 |
| 执行配置里适配器只读(由分组决定) | 通过 |
| 对话框点空白关闭 | 通过 |
| 点席位卡直接进入与该席位的对话 | 通过 |
| 工作区面板只含工作目录、权限面板只含会话权限(互不影响) | 通过 |
| 浮层点空白/Esc 关闭 | 通过 |
| 拖入文件出现附件 chip | 通过 |
| 对话状态条显示对方此刻在做什么 | 通过(`思考 / 生成中`) |
| 任务行有删除入口 | 通过 |
| 计划表使用列宽模板(目标列占大头) | 通过 |
| 状态列改为"圆点 + 文字", 不再用胶囊 | 通过(断言 `dots>0, chips=0`) |
| 点工作项打开详情, 完整显示原「目标」列的长文本 | 通过 |
| 工作项详情 Esc 可关闭 | 通过 |
| 任务头显示 Σ tokens、席位卡显示 tokens | 通过 |
| 产物按钮齐全(在文件夹中显示/默认应用/新标签/下载) | 通过 |
| 产物类型显示短名(word/markdown/plain…), 二进制不预览 | 通过 |
| 新建任务里每个席位有独立「工作区」「权限」按钮, 权限为三档下拉 | 通过 |
| 归档面板列出条目、每条有「彻底删除」、可关闭 | 通过 |

窗口原生选目录(新版 Windows shell 对话框)无法在无头浏览器里断言, 由 `scripts/pick-folder.ps1` 单独验证: 脚本可编译并弹出对话框, 选中后输出 `SELECTED:<绝对路径>`。

## 四、真实 harness 证据

### 4.1 真实端到端: 9/9 (`scripts/acceptance-live.mjs`)

最近一次: 2026-11-06, Claude Code 主控 + DeepSeek Harness 执行, 任务 1.6 分钟跑完, Σ 130681 tokens / 4 回合。

| 断言 | 结果 |
| --- | --- |
| 真实规划产出计划 | 通过(v1, 1 个工作项) |
| 批准计划(绑定 planHash) | 通过 |
| 任务跑到终态 | 通过(completed) |
| 工作项全部已接受 | 通过(1/1) |
| 没有失败的尝试 | 通过(failed=0) |
| 有产物登记 | 通过(3 个) |
| `check.txt` 内容与要求一致 | 通过(`harness-hub live check 2026`) |
| 报告文件已登记 | 通过(`deliverables/check-report.md`) |

这一轮还揪出一个真缺陷: 主控把验证命令写成 `findstr /x "harness-hub live check 2026" check.txt`,
findstr 会把引号里的空格当成多个模式, 于是报 `FINDSTR: Cannot open live` 并让验证必然失败
(程序的"输出含失败特征即判失败"守卫拦住了它, 没有假通过)。已在 `packages/core/src/prompts.ts`
的 `VALIDATION_SHELL_NOTE` 里写明: 带空格的整行匹配必须 `findstr /x /c:"..."`, 或直接用
`powershell -Command` 比较字符串。

### 4.2 更早的证据

- 探针: Codex 0.166.0(本机 `codex.cmd`)、Claude Code 2.1.318(本机 `claude.exe`)、DeepSeek Harness 0.2.1-rc.5(项目内 `.local/tools`), live 探针均通过。
- 真实任务: `C++ Hello World`(Claude Code 主控 + DeepSeek Harness 执行) → `delivery/completed`, 产物 `hello.cpp` / `deliverables/hello.exe` / `verification.md` / `DELIVERY.md`, 审核 `approve`; 手动运行 `hello.exe` 输出 `Hello, World!`。
- 执行配置里模型/推理是否真的生效: 用非法值反证(DSH 报 `unknown model option` / `unknown reasoning effort`; Claude 报 `unrecognized_model`)。

## 五、已知限制

- 只有 mock harness 跑完整流程时不会花模型额度; 真实 harness 的长回合会真实消耗额度, 因此默认验收用 mock。
- 复核类工作项是只读的, 不会重新执行被复核的程序(提示词里已明确, 依据是产物哈希与验证记录)。
- DSH 无沙箱能力, 权限只能靠提示词约束 + 事后审计; Codex/Claude 走各自的沙箱与权限模式。
- 目前没有价格/费用/自动路由(有意不做)。
