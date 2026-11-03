/**
 * 应用配置。所有路径都落在项目目录内, 不写全局配置。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 从 dist/apps/server/src 或 apps/server/src 向上找到含 package.json 的项目根。 */
function findRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export interface AppConfig {
  root: string;
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  webDist: string;
  homesDir: string;
  runsDir: string;
  logsDir: string;
  version: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = overrides.root ?? process.env.HH_ROOT ?? findRoot();
  const dataDir = path.join(root, '.local', 'data');
  // HH_DATA_DIR 允许隔离运行(测试/演练), 默认仍是项目内的 .local/data
  const resolvedDataDir = process.env.HH_DATA_DIR ? path.resolve(process.env.HH_DATA_DIR) : dataDir;
  return {
    root,
    dataDir: resolvedDataDir,
    dbPath: path.join(resolvedDataDir, 'harness-hub.db'),
    host: process.env.HH_HOST ?? '127.0.0.1',
    port: Number(process.env.HH_PORT ?? 4310),
    webDist: path.join(root, 'apps', 'web', 'dist'),
    homesDir: process.env.HH_HOMES_DIR ? path.resolve(process.env.HH_HOMES_DIR) : path.join(root, '.local', 'homes'),
    runsDir: process.env.HH_RUNS_DIR ? path.resolve(process.env.HH_RUNS_DIR) : path.join(root, '.local', 'runs'),
    logsDir: path.join(root, '.local', 'logs'),
    version: '0.1.0',
    ...overrides,
  };
}
