import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

/**
 * 结束 harness 进程及其全部后代。
 *
 * Windows 上 `child.kill()` 只结束直接子进程, 而 codex / dsh / claude 这类 harness 会再
 * 拉起 node、python、MCP server 等子孙进程。只杀父进程会留下孤儿: 继续占端口、持有锁、
 * 写日志, 下一次启动可能因此失败(也可能让用户看到残留窗口)。所以取消与超时统一走整树清理。
 */
export function killProcessTree(child: ChildProcess | ChildProcessWithoutNullStreams | null | undefined): void {
  if (!child) return;
  const pid = typeof child.pid === 'number' ? child.pid : null;
  if (WINDOWS && pid !== null) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      /* taskkill 不可用时退回 child.kill() */
    }
  }
  try {
    child.kill();
  } catch {
    /* 进程可能已经退出 */
  }
}

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
  fallback: { name?: string; path?: string; installHint?: string } = {},
): Launcher {
  const raw = (ref ?? '').trim();
  if (!raw) {
    const found = fallback.name ? whichSync(fallback.name) : null;
    if (found) return fromPath(found);
    if (fallback.path && isFile(fallback.path)) return fromPath(fallback.path);
    const name = fallback.name ?? 'harness';
    const hint = fallback.installHint ?? name;
    throw new Error(
      `PATH 里找不到 ${name}: 请先安装它(例如 npm i -g ${hint}), 或在「执行配置 → 可执行入口」填绝对路径`,
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
  fallbackPath?: string | null,
): { executable: string | null; source: 'profile' | 'path' | 'sdk'; note?: string } {
  const raw = (ref ?? '').trim();
  const candidate = raw ? (isFile(raw) ? raw : whichSync(raw)) : whichSync('claude');
  if (candidate) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith('.exe')) return { executable: candidate, source: raw ? 'profile' : 'path' };
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const exe = exeFromShim(candidate);
      if (exe) return { executable: exe, source: raw ? 'profile' : 'path', note: `由 ${path.basename(candidate)} 解析` };
      return {
        executable: fallbackPath ?? null,
        source: fallbackPath ? 'profile' : 'sdk',
        note: fallbackPath
          ? `无法从 ${path.basename(candidate)} 解析出真实 exe, 改用配置里的 ${path.basename(fallbackPath)}`
          : `无法从 ${path.basename(candidate)} 解析出真实 exe`,
      };
    }
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
      return {
        executable: fallbackPath ?? null,
        source: fallbackPath ? 'profile' : 'sdk',
        note: 'Claude Code 需要原生可执行文件, 不能指向 js 入口',
      };
    }
    return { executable: candidate, source: raw ? 'profile' : 'path' };
  }
  if (fallbackPath && isFile(fallbackPath)) return { executable: fallbackPath, source: 'profile' };
  return { executable: null, source: 'sdk', note: '未检测到本机 claude, 使用 SDK 自带的可执行文件' };
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

/**
 * Windows 上"进程起不来"的退出码: 0xC0000142(STATUS_DLL_INIT_FAILED)。
 * 表现为系统弹窗「应用程序无法正常启动(0xc0000142)」, 而不是我们代码里的异常。
 */
export const WINDOWS_DLL_INIT_FAILED = -1073741502;

/** 环境块里必须存在的 Windows 变量, 缺了子进程可能起不来。 */
const CRITICAL_ENV = ['SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'];

function pickEnv(source: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(source)) {
    if (k.toLowerCase() === lower && v) return v;
  }
  return null;
}

/**
 * 组装子进程环境: 继承当前进程, 合并执行配置里的变量。
 * - 大小写不敏感去重(Windows 上 `Path`/`PATH` 同时存在会让子进程拿到空 PATH);
 * - 丢掉非法键(空名、含 `=` 或 NUL)与含 NUL 的值, 否则整个环境块会被截断;
 * - 关键变量必须非空, 缺了就从当前进程补回来。
 */
const SANITIZED_ENV = ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONEXECUTABLE'];

export function buildChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const merged = new Map<string, { key: string; value: string }>();
  const put = (key: string, value: string) => {
    if (!key || key.includes('=') || key.includes('\0')) return;
    if (value.includes('\0')) return;
    merged.set(key.toLowerCase(), { key, value });
  };

  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') put(k, v);
  }
  // 继承来的东西可能让 harness 内部的 python 起不来(0xC0000142), 除非执行配置显式覆盖, 一律丢掉
  for (const name of SANITIZED_ENV) merged.delete(name.toLowerCase());

  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') put(k, v);
  }

  const out: Record<string, string> = {};
  for (const { key, value } of merged.values()) out[key] = value;

  // Windows 应用商店的 python3.exe 是 0 字节别名, 从子进程里调用会以 0xC0000142 失败并弹框;
  // 把 WindowsApps 从 harness 子进程的 PATH 里去掉(本机真正的 python 在别处)。
  if (out.PATH) {
    const kept = out.PATH.split(';').filter((x) => x && !x.toLowerCase().includes('\\windowsapps'));
    if (kept.length) out.PATH = kept.join(';');
  }
  if (out.Path) {
    const kept = out.Path.split(';').filter((x) => x && !x.toLowerCase().includes('\\windowsapps'));
    if (kept.length) out.Path = kept.join(';');
  }

  for (const name of CRITICAL_ENV) {
    const current = pickEnv(out, name);
    if (current) continue;
    const fallback = pickEnv(process.env as Record<string, string>, name);
    if (fallback) out[name] = fallback;
  }
  return out;
}

export interface SpawnHarnessOptions {
  cwd?: string;
  env: Record<string, string>;
  /** 起不来时的重试次数(默认 1 次, 用最小可信环境重试) */
  retries?: number;
}

/** 用最小可信环境重试时保留的变量(其余全部丢弃)。 */
function minimalEnv(extra: Record<string, string>): Record<string, string> {
  const keep = [
    'SystemRoot',
    'windir',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ];
  const out: Record<string, string> = {};
  for (const name of keep) {
    const value = pickEnv(extra, name) ?? pickEnv(process.env as Record<string, string>, name);
    if (value) out[name] = value;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (keep.some((n) => n.toLowerCase() === k.toLowerCase())) continue;
    if (k.startsWith('HH_') || k.startsWith('DSH_') || k === 'CODEX_HOME' || k === 'CLAUDE_CONFIG_DIR') out[k] = v;
  }
  return out;
}

/**
 * 启动一个 harness 子进程, 并把"Windows 起不来"(0xC0000142)转成可重试的失败。
 *
 * 真实故障背景: 某些 Windows 会话里子进程会在加载器阶段直接失败(退出码 -1073741502),
 * 系统弹窗提示「应用程序无法正常启动」。这类失败与程序逻辑无关, 换一份干净的环境
 * 重启一次通常就能起来; 两次都失败才算真的起不来。
 */
export function spawnHarness(
  command: string,
  args: string[],
  options: SpawnHarnessOptions,
): Promise<ChildProcessWithoutNullStreams> {
  const retries = options.retries ?? 1;
  const attempt = (index: number, env: Record<string, string>): Promise<ChildProcessWithoutNullStreams> =>
    new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
      } catch (err) {
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const cleanup = () => {
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      const retryOrFail = (detail: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        killProcessTree(child);
        if (index < retries) {
          // 用最小可信环境重试: 排除"环境块被污染导致加载器失败"这一类原因
          void attempt(index + 1, minimalEnv(options.env)).then(resolvePromise, rejectPromise);
          return;
        }
        rejectPromise(
          new Error(
            `${command} 启动失败(${detail})。这是 Windows 加载器初始化失败(0xC0000142), ` +
              '通常与子进程环境或系统资源有关, 与执行配置本身无关; 可重试一次, 或重启本程序后再试。',
          ),
        );
      };
      const onExit = (code: number | null) => {
        if (!settled && code === WINDOWS_DLL_INIT_FAILED) retryOrFail('0xC0000142');
        else if (!settled) {
          settled = true;
          cleanup();
          // 正常启动后立刻退出属于业务问题, 交给调用方按"空结果/提前退出"处理
          resolvePromise(child);
        }
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(err);
      };

      child.once('exit', onExit);
      child.once('error', onError);
      child.once('spawn', () => {
        // 给加载器一点时间暴露 0xC0000142, 之后就把进程交回去
        setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise(child);
        }, 1200);
      });
    });

  return attempt(0, options.env);
}
