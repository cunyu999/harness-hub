# 需求 → 验收对照表

这份表把你说过的每条要求落到"用什么证明"。自动化脚本都能在本项目内复跑, 截图与原始证据留在 `.local/tmp/`(不提交)。

## 一、自动化复跑

```bash
npm run build          # 前后端编译 + 前端打包
npm test               # 单元与集成: 64 项
npm start              # 另开一个终端(截图/验收期间建议 HH_EXIT_WITH_UI=0 常驻)
node scripts/acceptance-api.mjs    # 接口级: 53 项
node scripts/acceptance-ui.mjs     # 界面级: 27 项(无头 Edge + CDP)
node scripts/acceptance-live.mjs   # 真实 harness: 会消耗额度, 默认不建议反复跑
```

## 二、逐条对照

| # | 你的要求 | 怎么验证 | 位置 |
| --- | --- | --- | --- |
| 1 | TypeScript + Node + React + SQLite, 本地网页 + 本机后端 | `npm run build`、`npm test`、`/api/health` | `packages/*`, `apps/*` |
| 2 | 参考 Lancer 的视觉与交互, 不接管其 Electron 架构 | 界面验收 27 项 + 截图 | `apps/web`, `.local/tmp/*.png` |
| 3 | 接入 Codex / Claude Code / DeepSeek Harness 完整原生 harness | `node scripts/acceptance-live.mjs`(Claude 主控 + DSH 执行); Codex 由探针与真实回合验证 | `packages/adapters` |
| 4 | 每次由我选主控/强模型/执行者, 支持同 harness 多配置、多会话 | 执行配置增删改 + 新建任务席位选择(API B 组 / UI Pass C) | `scripts/acceptance-api.mjs`, `scripts/acceptance-ui.mjs` |
| 5 | 不得擅自增加参与者、换模型、降低推理、移除工具能力 | 计划校验(未选参与者/审核席位) + 批准绑定哈希 | `tests/core.test.ts`, API C9 |
| 6 | 单强模型=规划+调度+终审; ≥2 强模型先讨论再交叉复核 | 双强模型链路与 crossChecked 断言 | `tests/engine.mock.test.ts`, API D 组 |
| 7 | 计划必须我选"直接执行/补充内容/重新计划", 批准绑定确切版本 | UI Pass A 三按钮 + API 错误哈希/重复批准 409 | `scripts/acceptance-ui.mjs`, API C 组 |
| 8 | 任务类型与输出格式通用; 报告未指定才建议 Word | 课程报告真实任务(docx 生成) + 提示词规则 | `docs/progress.md`, `scripts/make-docx.ps1` |
| 9 | 实时监控本程序启动的全部会话(状态不由模型询问) | 对话状态条 + 事件页签 + 席位详情 | UI Pass B, `apps/web/src/lib/live.ts` |
| 10 | 统一主对话 + Lancer 风格协作图 + 计划确认/审批/审核/交付物 | UI Pass A/B、截图 | `apps/web/src/components/CollabGraph.tsx` |
| 11 | 图形由真实任务事件驱动, 不用动画冒充 | 卡片状态来自快照与 SSE; 无 mock 动画 | `CollabGraph.tsx` |
| 12 | 持久化、取消、恢复、并行写入隔离、产物验证、审核版本绑定 | `npm test` 的恢复/取消/调度/writeScope/审核用例 | `tests/*.test.ts` |
| 13 | 进程/回合"成功"不等于任务完成; 停止请求不等于已停止 | 验证阶段 + `needsFiles` 规则 + 取消终态断言 | `tests/salvage.test.ts`, API J 组 |
| 14 | 服务重启不盲目重跑有副作用的操作 | `tests/recover.test.ts`; 启动日志"恢复: 中断尝试 N" | `apps/server/src/index.ts` |
| 15 | 不实现价格/费用/节省额/自动价格路由 | 代码中无价格字段与路由; 界面无金额 | 全仓库 |
| 16 | 保留并发、轮数、重试、超时限制 | `limits` 字段 + 调度器并发断言 | `tests/core.test.ts` |
| 17 | 代码/依赖/缓存/日志/测试/构建产物都在 D:\1hobby 内 | 所有路径来自 `paths.root`; `.local/` 全部在本目录 | `packages/core/src/config.ts` |
| 18 | 不全局安装、不改外部全局配置 | harness 从本机 PATH 解析; DSH CLI 装在 `.local/tools` | `packages/adapters/src/exec.ts` |
| 19 | 只读检查环境, 不输出密钥 | 探针只报告版本/路径; 日志不含 token | `scripts/*.mjs` |
| 20 | 删除/覆盖用户数据、Git push、发布需另行确认 | 仅在本仓库 push; 归档删除需二次确认 | `docs/progress.md` |
| 21 | 失败坦诚说明, 不静默放宽 | 本表"已知限制"与验收报告 | `docs/acceptance-report.md` |
| 22 | 从 P0 环境验证开始, 按 P0–P7 推进 | 进度记录按阶段编号 | `docs/progress.md` |
| 23 | 复用现有实现、最小修改 | 增量提交历史 | `git log --oneline` |
| 24 | 关键方向/授权边界问题先问我 | 对话记录中的询问与你的裁定 | 本会话 |
| 25 | 最终必须完成三种真实 harness 接入, 不能拿 mock 交差 | live 验收跑 Claude + DSH; Codex 探针 + 真实回合 | `scripts/acceptance-live.mjs` |
| 26 | 只使用我配置并允许的 live 配置 | live 脚本只挑 `enabled && liveEnabled` 的配置 | `scripts/acceptance-live.mjs` |
| 27 | 保留真实证据, 区分已实现/已验证/未验证/受阻 | 验收报告的"证据"与"限制"两节 | `docs/acceptance-report.md` |
| 28 | 中断后可继续: 项目内记录进度与决策 | `docs/progress.md`、`docs/decisions.md` | `docs/` |
| 29 | 全程中文沟通, 不虚报完成 | 本表与对话 | — |
| 30 | 交付可运行系统 + 启动说明 + 支持版本 + 限制, 不自动发布 | `README.md`、`docs/harness-setup.md` | `README.md` |

## 三、界面细节(逐项)

| 你提出的点 | 结果 | 证据 |
| --- | --- | --- |
| 双主题(浅/深) | 通过 | UI Pass A 主题切换; `plan-cols3/4.png` |
| 协作图按参考图改为树形卡片(根/计划/席位/交付) | 通过 | `wi-plan.png`、`cv-harness.png` |
| 连线在独立 SVG 层, 不穿字 | 通过 | 截图目视 + `CollabGraph.tsx` |
| 点席位卡直接与该席位对话 | 通过 | UI Pass B |
| 对话顶栏显示角色/权限/工作区, Enter 发送 | 通过 | 截图 `split1/2.png` |
| 状态条显示"思考/运行工具/等待审批/重试/无事件" | 通过 | UI Pass B, `lib/live.ts` |
| 计划表列宽、状态列改圆点(B 方案) | 通过 | UI Pass B(`dots>0, chips=0`) |
| 点工作项看完整目标与执行细节 | 通过 | UI Pass B(详情弹窗 + Esc) |
| 产物: 在文件夹中显示(选中高亮) / 用默认应用打开 / 新标签 / 下载 | 通过 | API F 组 + 手工用默认应用打开过 docx |
| 二进制产物不在网页里预览(避免乱码) | 通过 | UI Pass B 预览断言; `art-open9.png` |
| 归档可查看、可按单个任务彻底删除 | 通过 | UI Pass D + API H 组 |
| 新建任务: 每个席位独立的"工作区/权限"按钮 + 原生选目录 | 通过 | UI Pass C; `seat1/3.png`, `pick3.png` |
| 关掉网页后后台自动退出(可设常驻) | 通过 | `tests/runtime.test.ts` + `/api/runtime` |
| 0xC0000142 弹窗不再出现 | 通过 | `scripts/start.ps1` 的 SetErrorMode + 子进程 PATH 清理; 复验课程报告任务无弹窗 |

## 四、没做到的 / 需要你知道的

- 真实 harness 长回合会真的花额度; 自动化默认用 mock, live 需要你点头再跑。
- DSH 没有沙箱, 权限只靠提示词与事后审计; Codex/Claude 走各自原生沙箱。
- 复核类工作项是只读的, 不会重跑被复核的程序(依据是产物哈希 + 验证记录)。
- 原生选目录对话框、资源管理器选中高亮属于系统级行为, 无头浏览器断言不了; 由脚本 + 手工各验一次。
