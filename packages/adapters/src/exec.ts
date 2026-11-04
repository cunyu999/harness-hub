import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 可执行入口解析。
 *
 * 目标: 让执行配置既能指向"本机已经装好的" harness(例如 `codex`、`codex.cmd`、
 * `C:\...\claude.exe`), 也能指向项目内随依赖安装的入口(例如 `node_modules/@openai/codex/bin/codex.js`),
 * 并且**不改动**用户本机的任何文件。
 *
 * 之所以需要这一层: Windows 上通过 npm 全局安装的 CLI 往往是 `.cmd` 垫片, 直接
 * `spawn('codex')` 在某些 Node 版本上会失败; `.ps1` 则需要 powershell 执行。
 */
export interface Launcher {
  kind: 'node' | 'direct' | 'cmd' | 'powershell';
  /** 真正要 spawn 的可执行文件 */
  command: string;
  /** 放在用户参数前面的参数, 例如 node 脚本自身路径 */
  prefix: string[];
  /** 解析出来的入口(用于事件与日志) */
  entry: string;
}

const WINDOWS = process.platform === 'win32';

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 里找可执行文件(Windows 会按 PATHEXT 逐个尝试)。 */
export function whichSync(name: string): string | null {
  const exts = WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean)
    : [''];
  // Windows 上同名文件常有 "无扩展名(sh 脚本)" 与 ".cmd/.exe" 两份, 直接 spawn 前者会失败, 只认 PATHEXT 里的真实可执行
  const names = WINDOWS && !path.extname(name) ? exts.map((ext) => name + ext.toLowerCase()) : [name];
  const dirs = (process.env.PATH ?? '').split(WINDOWS ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/**
 * 把执行配置里的 `executableRef` 变成可 spawn 的启动方式。
 * 空值会先用 `fallbackName`(如 `codex`)在 PATH 里找, 找不到再用 `fallbackPath`(项目内依赖)。
 */
export function resolveLauncher(
  ref: string | null | undefined,
  fallback: { name?: string; path?: string } = {},
): Launcher {
  const raw = (ref ?? '').trim();
  if (!raw) {
    const found = fallback.name ? whichSync(fallback.name) : null;
    if (found) return fromPath(found);
    if (fallback.path && isFile(fallback.path)) return fromPath(fallback.path);
    throw new Error(
      `找不到 ${fallback.name ?? 'harness'} 可执行文件: PATH 里没有, 项目内也没有 ${fallback.path ?? ''}`,
    );
  }
  const maybe = isFile(raw) ? raw : whichSync(raw);
  if (!maybe) throw new Error(`可执行入口不存在: ${raw}`);
  return fromPath(maybe);
}

function fromPath(p: string): Launcher {
  const lower = p.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { kind: 'node', command: process.execPath, prefix: [p], entry: p };
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // 用 cmd.exe 执行垫片, 避免 Node 的 spawn 在 Windows 上直接跑 .cmd 失败
    return { kind: 'cmd', command: process.env.COMSPEC ?? 'cmd.exe', prefix: ['/d', '/s', '/c', p], entry: p };
  }
  if (lower.endsWith('.ps1')) {
    return {
      kind: 'powershell',
      command: 'powershell.exe',
      prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
      entry: p,
    };
  }
  return { kind: 'direct', command: p, prefix: [], entry: p };
}

/**
 * Claude Code 需要一个**真正的可执行文件**(SDK 直接 spawn 它, 不能是 `.cmd` 垫片)。
 * 这里从 `.cmd` 垫片内容里读出真实的 exe 路径; 读不出来就退回项目内安装的 exe。
 */
export function resolveClaudeBinary(
  ref: string | null | undefined,
  fallbackPath: string,
): { executable: string; source: 'profile' | 'path' | 'vendored'; note?: string } {
  const raw = (ref ?? '').trim();
  const candidate = raw ? (isFile(raw) ? raw : whichSync(raw)) : whichSync('claude');
  if (candidate) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith('.exe')) return { executable: candidate, source: raw ? 'profile' : 'path' };
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const exe = exeFromShim(candidate);
      if (exe) return { executable: exe, source: raw ? 'profile' : 'path', note: `由 ${path.basename(candidate)} 解析` };
      return {
        executable: fallbackPath,
        source: 'vendored',
        note: `无法从 ${path.basename(candidate)} 解析出真实 exe, 改用项目内安装的版本`,
      };
    }
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
      return {
        executable: fallbackPath,
        source: 'vendored',
        note: 'Claude Code 需要原生可执行文件, 不能指向 js 入口, 已改用项目内安装的版本',
      };
    }
    return { executable: candidate, source: raw ? 'profile' : 'path' };
  }
  if (isFile(fallbackPath)) return { executable: fallbackPath, source: 'vendored' };
  throw new Error(`找不到 Claude Code 可执行文件(PATH 里没有 claude, 项目内也没有 ${fallbackPath})`);
}

/** 从 npm 生成的 `.cmd`/`.bat` 垫片里找出它最终调用的 exe。 */
function exeFromShim(shimPath: string): string | null {
  try {
    const text = readFileSync(shimPath, 'utf8');
    const match = text.match(/%dp0%\\([^"]+?\.exe)/i);
    if (!match) return null;
    const resolved = path.join(path.dirname(shimPath), match[1].replace(/\//g, path.sep));
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
