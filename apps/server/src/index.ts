/**
 * 服务入口: 打开数据库、抢占单实例锁、装配适配器、恢复未完成状态、启动 HTTP。
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../../../packages/adapters/src/claude.js';
import { CodexAdapter } from '../../../packages/adapters/src/codex.js';
import { DshAdapter } from '../../../packages/adapters/src/dsh.js';
import { MockAdapter } from '../../../packages/adapters/src/mock.js';
import type { HarnessAdapter } from '../../../packages/adapters/src/types.js';
import { Engine } from '../../../packages/core/src/engine.js';
import { newId, nowIso } from '../../../packages/core/src/util.js';
import { Db } from '../../../packages/storage/src/db.js';
import { Repo } from '../../../packages/storage/src/repo.js';
import { loadConfig, type AppConfig } from './config.js';
import { ApiServer } from './http.js';
import { UiWatchdog } from './runtime-control.js';

function buildAdapters(cfg: AppConfig): Record<string, HarnessAdapter> {
  // 不内置任何 harness 副本: 默认只用本机已安装的 codex / claude / dsh(PATH 或执行配置里填的路径)。
  // 这样用户的认证与模型配置都在自己那份安装里, 不会出现"项目里又下了一份"的问题。
  void cfg;
  return {
    codex: new CodexAdapter({ homeRoot: cfg.homesDir }),
    'claude-code': new ClaudeAdapter({ configRoot: cfg.homesDir }),
    dsh: new DshAdapter({ homeRoot: cfg.homesDir }),
    mock: new MockAdapter(),
  };
}

/** 首次运行时给出三个真实适配器的配置骨架, 默认不启用真实调用。 */
function seedProfiles(repo: Repo, cfg: AppConfig): void {
  if (process.env.HH_SEED_PROFILES === '0') return;
  if (repo.listProfiles().length > 0) return;
  const home = os.homedir();
  const now = nowIso();
  const seeds = [
    {
      name: 'Codex (gpt-6.1-sol)',
      adapterId: 'codex' as const,
      executableRef: '',
      configRefs: { sourceHome: path.join(home, '.codex') },
      requestedModel: 'gpt-6.1-sol',
      requestedReasoning: 'medium',
      notes: '首次运行自动探测生成。凭据从 ~/.codex 复制到项目内私有 home; 探针通过后再启用真实运行。',
    },
    {
      name: 'Claude Code',
      adapterId: 'claude-code' as const,
      executableRef: '',
      configRefs: { sourceHome: path.join(home, '.claude') },
      requestedModel: null,
      requestedReasoning: null,
      notes: '首次运行自动探测生成。凭据从 ~/.claude 复制到项目内私有 home; 模型留空表示沿用 Claude Code 默认。',
    },
    {
      name: 'DeepSeek Harness',
      adapterId: 'dsh' as const,
      executableRef: '',
      configRefs: { sourceHome: path.join(home, '.dsh') },
      requestedModel: null,
      requestedReasoning: null,
      notes:
        '首次运行自动探测生成。通过 dsh --profile acp 接入; 需要本机已安装 dsh(npm i -g @deepseek-ai/dsh); 凭据从 ~/.dsh 复制到项目内私有 home。',
    },
  ];
  for (const s of seeds) {
    repo.insertProfile({
      id: newId('prof'),
      name: s.name,
      adapterId: s.adapterId,
      executableRef: s.executableRef,
      configRefs: s.configRefs,
      secretRefs: [],
      requestedModel: s.requestedModel,
      requestedReasoning: s.requestedReasoning,
      concurrencyGroup: 'default',
      enabled: true,
      liveEnabled: false,
      env: {},
      workspaceRoot: null,
      sandbox: 'workspace-write' as const,
      capabilitySnapshot: null,
      notes: s.notes,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  for (const dir of [cfg.dataDir, cfg.logsDir, cfg.homesDir, cfg.runsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Db(cfg.dbPath); // 构造时自动迁移
  const repo = new Repo(db);

  const nonce = newId('boot');
  if (!repo.acquireLease('server', process.pid, nonce, 20_000)) {
    // 上一进程崩溃后可能残留未到期的锁; 只有在原持有进程确实不存在时才接管。
    const held = repo.getLease('server');
    let ownerAlive = false;
    if (held) {
      try {
        process.kill(held.ownerPid, 0);
        ownerAlive = true;
      } catch {
        ownerAlive = false;
      }
    }
    if (ownerAlive) {
      // 已经在跑: 这是重复启动, 不是错误。告诉用户去哪里访问即可。
      // eslint-disable-next-line no-console
      console.log(
        `[harness-hub] 服务已在运行: http://${cfg.host}:${cfg.port} (pid=${held?.ownerPid ?? '?'}), 无需重复启动。`,
      );
      db.close();
      return;
    }
    if (!repo.acquireLease('server', process.pid, nonce, 0)) {
      // eslint-disable-next-line no-console
      console.error(
        `[harness-hub] 无法取得单实例锁 (原 pid=${held?.ownerPid ?? '?'}), 本次启动中止。`,
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn(`[harness-hub] 接管了已失效的单实例锁 (原 pid=${held?.ownerPid ?? '?'})。`);
  }
  const heartbeat = setInterval(() => {
    try {
      repo.heartbeatLease('server', nonce);
    } catch {
      /* ignore */
    }
  }, 5000);
  heartbeat.unref?.();

  const adapters = buildAdapters(cfg);
  const engine = new Engine(repo, {
    paths: { root: cfg.root, dataDir: cfg.dataDir },
    adapters,
  });

  seedProfiles(repo, cfg);
  const recovery = engine.recover();
  engine.startMonitoring(15_000);

  // 网页关掉就停服务: 页面会先发 close-intent, 心跳消失则由空闲超时兜底; 都走优雅关停。
  let shuttingDown = false;
  const watchdog = new UiWatchdog({
    enabled: cfg.exitOnUiClose,
    graceMs: cfg.uiGraceMs,
    idleTimeoutMs: cfg.uiIdleTimeoutMs,
    firstHeartbeatTimeoutMs: cfg.uiFirstHeartbeatMs,
    activeSessions: () => repo.countActiveSessions(),
    onStop: (reason) => shutdown(reason),
    log: (message) => console.log(`[harness-hub] ${message}`),
  });
  const watchdogTimer = setInterval(() => watchdog.tick(), 1000);
  watchdogTimer.unref?.();

  const api = new ApiServer(repo, engine, cfg, adapters, watchdog);
  await api.start();

  // eslint-disable-next-line no-console
  console.log(`[harness-hub] 服务已启动: ${api.address()}`);
  // eslint-disable-next-line no-console
  console.log(
    `[harness-hub] 数据库: ${cfg.dbPath}\n[harness-hub] 工作区根: ${path.join(cfg.runsDir, '<taskId>', 'workspace')}\n[harness-hub] 恢复: 中断尝试 ${recovery.interruptedAttempts}, 失效审批 ${recovery.expiredApprovals}, 暂停任务 ${recovery.pausedTasks}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    cfg.exitOnUiClose
      ? '[harness-hub] 关闭网页会结束后台进程(可在网页上关闭前确认); 如需常驻设 HH_EXIT_WITH_UI=0。'
      : '[harness-hub] HH_EXIT_WITH_UI=0: 关闭网页不影响后台进程。',
  );

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[harness-hub] 开始关停 (${reason})...`);
    clearInterval(watchdogTimer);
    // 先停后台流程再关库: 否则还在跑的回合会撞上 "database is not open"
    await engine.shutdown(15_000);
    // 关停后仍留在 running 的尝试/未决审批: 如实记为中断, 不假装成功, 也不自动重跑
    try {
      const settled = engine.settleOnShutdown(reason);
      // eslint-disable-next-line no-console
      console.log(
        `[harness-hub] 收尾: 中断尝试 ${settled.interruptedAttempts}, 失效审批 ${settled.expiredApprovals}, 暂停任务 ${settled.pausedTasks}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[harness-hub] 收尾失败: ${(err as Error).message}`);
    }
    clearInterval(heartbeat);
    await api.stop();
    repo.releaseLease('server', nonce);
    db.close();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[harness-hub] 启动失败:', err);
  process.exit(1);
});
