# 全量验收记录

最后一次全量验收: 2026-11-06。仓库里只放结论与可复跑的命令, 截图与原始证据留在本机 `.local/`(不提交)。

## 怎么复跑

```bash
npm install
npm run build
npm test          # 引擎/存储/HTTP/适配器/工作区/附件 等 57 项单元与集成测试
npm start         # 默认模式: 关掉网页 2.5s 后后台自动退出
```

界面类验收用无头浏览器跑页面内断言(需先 `npm start`), 记录在下方表格。

## 一、单元与集成测试: 57/57

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

## 二、接口级验收: 23/23

用 mock harness 跑真实引擎(不消耗模型额度), 断言 23 项: 配置可用、创建任务、幂等键复用、计划生成待批准、错误哈希 409、正确批准、跑到 `delivery/completed`、工作项全部 accepted、双强模型各一条 crossChecked、讨论阶段独立提案、产物 sha256、验证记录、三层工作区、交付后返工出计划 v2 并再次完成、事件高水位与 seq 单调、删除任务归档产物并 404、跨站 Origin 403、非 JSON 415、未知任务 404。

## 三、界面级验收: 16/16

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

窗口原生选目录(新版 Windows shell 对话框)无法在无头浏览器里断言, 由 `scripts/pick-folder.ps1` 单独验证: 脚本可编译并弹出对话框, 选中后输出 `SELECTED:<绝对路径>`。

## 四、真实 harness 证据(此前已跑)

- 探针: Codex 0.166.0(本机 `codex.cmd`)、Claude Code 2.1.318(本机 `claude.exe`)、DeepSeek Harness 0.2.1-rc.5(项目内 `.local/tools`), live 探针均通过。
- 真实任务: `C++ Hello World`(Claude Code 主控 + DeepSeek Harness 执行) → `delivery/completed`, 产物 `hello.cpp` / `deliverables/hello.exe` / `verification.md` / `DELIVERY.md`, 审核 `approve`; 手动运行 `hello.exe` 输出 `Hello, World!`。
- 执行配置里模型/推理是否真的生效: 用非法值反证(DSH 报 `unknown model option` / `unknown reasoning effort`; Claude 报 `unrecognized_model`)。

## 五、已知限制

- 只有 mock harness 跑完整流程时不会花模型额度; 真实 harness 的长回合会真实消耗额度, 因此默认验收用 mock。
- 复核类工作项是只读的, 不会重新执行被复核的程序(提示词里已明确, 依据是产物哈希与验证记录)。
- DSH 无沙箱能力, 权限只能靠提示词约束 + 事后审计; Codex/Claude 走各自的沙箱与权限模式。
- 目前没有价格/费用/自动路由(有意不做)。
