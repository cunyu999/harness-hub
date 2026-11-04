# 第三方组件与许可

本项目自身代码为原创实现(未整体复制 raylee-ai/lancer 的源码, 仅在视觉与交互上参考其风格; 未拷贝其 Electron/Pi 架构)。
下面是运行时与构建期依赖的许可证信息, 均为随 `node_modules` 安装的原样分发包, 未修改。

## 运行时依赖(直接)

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.317 | 见包内 LICENSE/README (Anthropic 商业条款) | Claude Code 的进程内 SDK 通道 |
| `@agentclientprotocol/sdk` | 1.4.0 | Apache-2.0 | ACP 客户端类型与流工具(DSH 侧的协议参考) |
| `react` / `react-dom` | 19.3.1 | MIT | 前端界面 |
| `zod` | 4.6.7 | MIT | 请求体与计划结构校验 |

## 构建期依赖(开发)

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.7 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `@types/node` | 24.19.2 | MIT |

## 说明与义务

- 上述包的完整许可文本随各自目录内的 `LICENSE` / `README` 分发, 位于
  `D:\1hobby\node_modules\<包名>\`。分发本项目时需一并保留。
- `@anthropic-ai/claude-code` 与 `@anthropic-ai/claude-agent-sdk` 的许可为 Anthropic 自有条款(非标准开源许可),
  使用与再分发前请自行阅读其 README 中的 LICENSE 段落并遵守账号条款。
- 本项目不包含任何模型权重、不代理模型 API 计费, 也不做价格/费用/节省金额计算(按需求刻意不实现)。
- 字体与图标全部使用系统字体与内联 SVG, 未引入外部字体或图标库。
- 若后续引入 raylee-ai/lancer 的具体组件, 需在 `vendor/` 下保留其 LICENSE 并在本文件登记。
