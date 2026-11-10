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
  /** 程序自己的本地目录(工作区/归档/诊断日志的父目录); 便携版等于数据目录本身。 */
  localDir: string;
  dbPath: string;
  host: string;
  port: number;
  webDist: string;
  homesDir: string;
  runsDir: string;
  logsDir: string;
  version: string;
  /** 关闭网页后是否结束后台进程(HH_EXIT_WITH_UI, 默认开)。 */
  exitOnUiClose: boolean;
  /** 收到关闭意图后等待新心跳的时间, 覆盖"刷新页面"的情况(HH_UI_GRACE_MS)。 */
  uiGraceMs: number;
  /** 心跳中断多久后判定页面已消失(HH_UI_IDLE_MS)。 */
  uiIdleTimeoutMs: number;
  /** 从未有页面连上时的宽限; 0 表示一直等(HH_UI_FIRST_MS, 默认 0)。 */
  uiFirstHeartbeatMs: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = overrides.root ?? process.env.HH_ROOT ?? findRoot();
  const dataDir = path.join(root, '.local', 'data');
  // HH_DATA_DIR 允许隔离运行(测试/演练), 默认仍是项目内的 .local/data
  const resolvedDataDir = process.env.HH_DATA_DIR ? path.resolve(process.env.HH_DATA_DIR) : dataDir;
  // 便携版/安装版用 HH_DATA_DIR 把数据挪出程序目录, 此时 homes/runs/logs 也放在同一个
  // 数据目录下(升级或重装程序目录时, 用户的 home 快照、工作区和日志不会被一起清掉)。
  const localDir = process.env.HH_DATA_DIR ? resolvedDataDir : path.join(root, '.local');
  return {
    root,
    dataDir: resolvedDataDir,
    localDir,
    dbPath: path.join(resolvedDataDir, 'harness-hub.db'),
    host: process.env.HH_HOST ?? '127.0.0.1',
    port: Number(process.env.HH_PORT ?? 4310),
    webDist: path.join(root, 'apps', 'web', 'dist'),
    homesDir: process.env.HH_HOMES_DIR ? path.resolve(process.env.HH_HOMES_DIR) : path.join(localDir, 'homes'),
    runsDir: process.env.HH_RUNS_DIR ? path.resolve(process.env.HH_RUNS_DIR) : path.join(localDir, 'runs'),
    logsDir: path.join(localDir, 'logs'),
    version: '0.1.0',
    exitOnUiClose: (process.env.HH_EXIT_WITH_UI ?? '1') !== '0',
    uiGraceMs: Number(process.env.HH_UI_GRACE_MS ?? 2500),
    uiIdleTimeoutMs: Number(process.env.HH_UI_IDLE_MS ?? 12_000),
    uiFirstHeartbeatMs: Number(process.env.HH_UI_FIRST_MS ?? 0),
    ...overrides,
  };
}
