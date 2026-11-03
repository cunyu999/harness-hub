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

function buildAdapters(cfg: AppConfig): Record<string, HarnessAdapter> {
  const nm = path.join(cfg.root, 'node_modules');
  return {
    codex: new CodexAdapter({
      entry: path.join(nm, '@openai', 'codex', 'bin', 'codex.js'),
      homeRoot: cfg.homesDir,
    }),
    'claude-code': new ClaudeAdapter({
      executable: path.join(nm, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      configRoot: cfg.homesDir,
    }),
    dsh: new DshAdapter({
      entry: path.join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      homeRoot: cfg.homesDir,
    }),
    mock: new MockAdapter(),
  };
}

/** 首次运行时给出三个真实适配器的配置骨架, 默认不启用真实调用。 */
function seedProfiles(repo: Repo, cfg: AppConfig): void {
  if (process.env.HH_SEED_PROFILES === '0') return;
  if (repo.listProfiles().length > 0) return;
  const nm = path.join(cfg.root, 'node_modules');
  const home = os.homedir();
  const now = nowIso();
  const seeds = [
    {
      name: 'Codex (gpt-6.1-sol)',
      adapterId: 'codex' as const,
      executableRef: path.join(nm, '@openai', 'codex', 'bin', 'codex.js'),
      configRefs: { sourceHome: path.join(home, '.codex') },
      requestedModel: 'gpt-6.1-sol',
      requestedReasoning: 'medium',
      notes: '首次运行自动探测生成。凭据从 ~/.codex 复制到项目内私有 home; 探针通过后再启用真实运行。',
    },
    {
      name: 'Claude Code',
      adapterId: 'claude-code' as const,
      executableRef: path.join(nm, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      configRefs: { sourceHome: path.join(home, '.claude') },
      requestedModel: null,
      requestedReasoning: null,
      notes: '首次运行自动探测生成。凭据从 ~/.claude 复制到项目内私有 home; 模型留空表示沿用 Claude Code 默认。',
    },
    {
      name: 'DeepSeek Harness',
      adapterId: 'dsh' as const,
      executableRef: path.join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      configRefs: { sourceHome: path.join(home, '.dsh') },
      requestedModel: null,
      requestedReasoning: null,
      notes: '首次运行自动探测生成。通过 dsh --profile acp 接入; 凭据从 ~/.dsh 复制到项目内私有 home。',
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
    if (ownerAlive || !repo.acquireLease('server', process.pid, nonce, 0)) {
      // eslint-disable-next-line no-console
      console.error(
        `[harness-hub] 已有实例持有单实例锁 (pid=${held?.ownerPid ?? '?'}), 本次启动中止。`,
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

  const api = new ApiServer(repo, engine, cfg, adapters);
  await api.start();

  // eslint-disable-next-line no-console
  console.log(`[harness-hub] 服务已启动: ${api.address()}`);
  // eslint-disable-next-line no-console
  console.log(
    `[harness-hub] 数据库: ${cfg.dbPath}\n[harness-hub] 工作区根: ${path.join(cfg.runsDir, '<taskId>', 'workspace')}\n[harness-hub] 恢复: 中断尝试 ${recovery.interruptedAttempts}, 失效审批 ${recovery.expiredApprovals}, 暂停任务 ${recovery.pausedTasks}`,
  );

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[harness-hub] 收到 ${signal}, 正在停止...`);
    // 先停后台流程再关库: 否则还在跑的回合会撞上 "database is not open"
    await engine.shutdown(15_000);
    clearInterval(heartbeat);
    await api.stop();
    repo.releaseLease('server', nonce);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[harness-hub] 启动失败:', err);
  process.exit(1);
});
