# 接入本机的 harness(仓库不含 harness 本体)

这个仓库只包含 Harness Hub 自己的源码与文档。**Codex / Claude Code / DeepSeek Harness 都不在仓库里,
也不随依赖安装在 `node_modules` 里** —— 你需要先在本机把它们装好并登录, 本程序只是调用它们。

程序查找 harness 的顺序(见 `packages/adapters/src/exec.ts`):

1. 执行配置里的「可执行入口」填了绝对路径 → 直接用;
2. 填了命令名(如 `codex`)或留空 → 在本机 `PATH` 里找(Windows 只认 `PATHEXT` 里的扩展名);
3. 找不到 → 探针返回失败并提示怎么装, 不会偷偷下载。

## 1. Codex

```powershell
npm i -g @openai/codex
codex --version          # 期望 0.166.x
codex login              # 或沿用已有的 ~/.codex/auth.json
```

执行配置里:

- 可执行入口: 留空(自动找 `codex.cmd`), 或填 `C:\Users\<你>\AppData\Roaming\npm\codex.cmd`;
- 凭据来源目录: `~/.codex`(程序只复制 `auth.json`/`config.toml` 到项目内私有 home, 不改原文件);
- 模型 / 推理: 留空 = 用 Codex 自己的 `config.toml`; 填了就作为会话级覆盖传给 `thread/start`。

## 2. Claude Code

```powershell
npm i -g @anthropic-ai/claude-code
claude --version         # 期望 2.1.x
```

首次运行会走登录流程, 凭据落在 `~/.claude`。执行配置里:

- 可执行入口: 留空(自动解析 `claude.cmd` 内部的真实 `claude.exe`), 或直接填 `.exe` 路径;
- 凭据来源目录: `~/.claude`;
- 说明: 适配器通过 `@anthropic-ai/claude-agent-sdk` 驱动它, SDK 自带一份二进制作为兜底。

## 3. DeepSeek Harness(DSH)

DSH 需要**带 ACP stdio profile** 的安装, 且可执行文件能被 node 启动:

```powershell
npm i -g @deepseek-ai/dsh
dsh --help               # 能看到 dsh [--profile] <name> ...
```

如果不想装到全局, 也可以装在项目内(`.local` 已被 git 忽略):

```powershell
npm install --prefix .local/tools --no-save @deepseek-ai/dsh@0.2.1-rc.5
```

执行配置里:

- 可执行入口: 填 `<项目>\.local\tools\node_modules\@deepseek-ai\dsh\lib\bin.js`
  或全局安装的 `...\dsh\lib\bin.js`;
- 凭据来源目录: `~/.dsh`(复制 `.credentials.yaml`、`cordis.yml` 等);
- 说明: 适配器用 `dsh --profile acp` 起 ACP 服务器, 通过 JSON-RPC 对话。

## 4. 配好之后

1. 打开 http://127.0.0.1:4310 → 「执行配置」→ 选中配置 → **inspect 探针**(只握手, 不花钱);
2. 勾选「允许真实调用」, 再点 **live 探针**(会真的跑一个极短回合, 消耗额度);
3. 新建任务时选主控 / 强模型 / 执行者 —— 程序不会自己加人、换模型或降推理。

## 5. 仓库里刻意没有的东西

| 不存在 | 原因 |
| --- | --- |
| harness 二进制 / vendor 目录 | 体积大、许可证各异、且与你本机版本强绑定 |
| `node_modules/` | `npm install` 生成, 见 `.gitignore` |
| `.local/`(凭据副本、数据库、工作区、归档、日志) | 含你的账号与本机路径 |
| 任何 API key / token | 只在私有 home 里, 由你本机原有配置提供 |
| 界面截图 | 与源码无关, 会显著撑大仓库 |

依赖只有 `@anthropic-ai/claude-agent-sdk`(Claude 适配器要用它的 SDK 接口)、React、Zod 等运行期库,
版本与许可见 `package.json` 与 `THIRD-PARTY-NOTICES.md`。
