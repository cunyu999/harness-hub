/**
 * 「执行配置」里的本机安装探测。
 *
 * 只回答「装没装、装在哪、大概什么版本」, 不建立会话、不碰凭据:
 * 1. 先按 PATH 找(`whichSync` 会按 PATHEXT 处理 .cmd / .ps1 垫片);
 * 2. 再找项目内 `.local/tools/node_modules/.bin`(dsh 之类的项目内安装);
 * 3. 再找 npm 全局目录(`%APPDATA%\npm`)。
 *
 * 版本只是锦上添花: `--version` 失败不影响「已检测到」, 前端仍给出可点的提示。
 *
 * 版本探测会把该 harness 的 home 指到 `<数据目录>/tmp/detect/<adapter>`:
 * codex 的 `--version` 会在 home 下建 `tmp/arg0-*` 临时目录, 不隔离就会写到用户主目录。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLauncher, whichSync } from '../../../packages/adapters/src/exec.js';
import type { DetectResultDto } from '../../../packages/contracts/src/api.js';
import type { AdapterId } from '../../../packages/contracts/src/types.js';

interface HarnessSpec {
  /** PATH / npm 里的命令名。 */
  command: string;
  /** 默认凭据目录名(在用户主目录下)。 */
  homeDirName: string;
  /** 把 home 指到别处用的环境变量; 探测版本时用来隔离临时文件。 */
  homeEnv: string;
  displayName: string;
}

const HARNESSES: Partial<Record<AdapterId, HarnessSpec>> = {
  codex: { command: 'codex', homeDirName: '.codex', homeEnv: 'CODEX_HOME', displayName: 'Codex' },
  'claude-code': {
    command: 'claude',
    homeDirName: '.claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    displayName: 'Claude Code',
  },
  dsh: { command: 'dsh', homeDirName: '.dsh', homeEnv: 'DSH_HOME', displayName: 'DeepSeek Harness' },
};

/** 同一适配器的探测结果缓存 30 秒: 切换配置时不重复跑 `--version`。 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; result: DetectResultDto }>();

export function detectHarness(
  adapterId: AdapterId,
  root: string,
  localDir?: string,
  force = false,
): DetectResultDto {
  const spec = HARNESSES[adapterId];
  const checkedAt = new Date().toISOString();
  if (!spec) {
    return emptyResult(adapterId, checkedAt, `未知适配器: ${adapterId}`);
  }

  const cacheKey = `${adapterId}\u0000${root}\u0000${localDir ?? ''}`;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const candidates = findCandidates(spec.command, root);
  const chosen = candidates[0] ?? null;
  const sourceHome = path.join(os.homedir(), spec.homeDirName);
  const result: DetectResultDto = {
    adapterId,
    displayName: spec.displayName,
    found: chosen !== null,
    executableRef: chosen?.file ?? null,
    version: chosen ? readVersion(chosen.file, probeEnv(spec, root, localDir)) : null,
    sourceHome: existsSync(sourceHome) ? sourceHome : null,
    source: chosen?.source ?? null,
    checkedAt,
  };
  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/**
 * 「强力检索」: 只在用户指定的文件夹里找。会做一次浅层 BFS(最多 10 层 / 3 万项),
 * 优先 `命令.cmd` / `.exe` / `.ps1`, 其次是裸文件名, 跳过 `.git`。
 */
export function scanHarness(
  adapterId: AdapterId,
  dir: string,
  root: string,
  localDir?: string,
): DetectResultDto {
  const spec = HARNESSES[adapterId];
  const checkedAt = new Date().toISOString();
  if (!spec) return emptyResult(adapterId, checkedAt, `未知适配器: ${adapterId}`);

  const target = path.resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { ...emptyResult(adapterId, checkedAt, `目录不存在: ${target}`), displayName: spec.displayName };
  }

  const hit = walkForCommand(target, spec.command);
  const sourceHome = path.join(os.homedir(), spec.homeDirName);
  return {
    adapterId,
    displayName: spec.displayName,
    found: hit !== null,
    executableRef: hit,
    version: hit ? readVersion(hit, probeEnv(spec, root, localDir)) : null,
    sourceHome: existsSync(sourceHome) ? sourceHome : null,
    source: hit ? 'manual' : null,
    checkedAt,
    detail: hit ? `在所选文件夹里找到 ${path.basename(hit)}` : `在所选文件夹里没有找到 ${spec.command}`,
  };
}

const SCAN_MAX_DEPTH = 10;
const SCAN_MAX_ENTRIES = 30_000;
const SKIP_DIRS = new Set(['.git']);

function walkForCommand(root: string, command: string): string | null {
  const names = [`${command}.cmd`, `${command}.exe`, `${command}.ps1`, command].map((n) => n.toLowerCase());
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < SCAN_MAX_ENTRIES) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = new Map<string, string>();
    for (const e of entries) {
      seen += 1;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      } else if (e.isFile()) {
        files.set(e.name.toLowerCase(), full);
      }
    }
    for (const name of names) {
      const found = files.get(name);
      if (found) return found;
    }
  }
  return null;
}

function probeEnv(spec: HarnessSpec, root: string, localDir?: string): NodeJS.ProcessEnv {
  const base = localDir ?? path.join(root, '.local');
  const home = path.join(base, 'tmp', 'detect', spec.homeEnv.toLowerCase());
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    return {};
  }
  return { [spec.homeEnv]: home };
}

function emptyResult(adapterId: AdapterId, checkedAt: string, detail: string): DetectResultDto {
  return {
    adapterId,
    displayName: adapterId,
    found: false,
    executableRef: null,
    version: null,
    sourceHome: null,
    source: null,
    checkedAt,
    detail,
  };
}

function findCandidates(
  command: string,
  root: string,
): { file: string; source: 'path' | 'project' | 'npm' }[] {
  const out: { file: string; source: 'path' | 'project' | 'npm' }[] = [];
  const seen = new Set<string>();
  const push = (file: string, source: 'path' | 'project' | 'npm') => {
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (!statSync(file).isFile()) return;
    } catch {
      return;
    }
    out.push({ file, source });
  };

  const onPath = whichSync(command);
  if (onPath) push(onPath, 'path');

  const projectBin = path.join(root, '.local', 'tools', 'node_modules', '.bin');
  for (const ext of ['.cmd', '.exe', '']) push(path.join(projectBin, `${command}${ext}`), 'project');

  const appData = process.env.APPDATA;
  if (appData) {
    for (const ext of ['.cmd', '.exe']) push(path.join(appData, 'npm', `${command}${ext}`), 'npm');
  }
  return out;
}

/** 跑一次 `--version` 取版本号; 超时 / 失败返回 null, 不影响「已检测到」。 */
function readVersion(file: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const launcher = resolveLauncher(file);
    const res = spawnSync(launcher.command, [...launcher.prefix, '--version'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    if (!text) return null;
    const first = text.split(/\r?\n/)[0]?.trim() ?? '';
    if (!first) return null;
    return /(\d+\.\d+\.\d+(?:[-+][\w.\-]+)?)/.exec(first)?.[1] ?? first.slice(0, 60);
  } catch {
    return null;
  }
}
