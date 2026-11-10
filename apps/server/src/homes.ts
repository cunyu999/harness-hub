/**
 * 私有 home 准备。
 *
 * Codex / Claude Code / DSH 都会往自己的 home 目录写会话、缓存与凭据刷新结果。
 * 为了不修改用户全局配置, 我们为每个 profile 建一个项目内 home, 首次使用时
 * 从用户指定的源目录"复制"凭据与配置(只读源, 不移动、不删除、不改写)。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HomeSyncStatus } from '../../../packages/contracts/src/api.js';
import type { ExecutionProfile } from '../../../packages/contracts/src/types.js';
import { isInside } from '../../../packages/core/src/util.js';

/** 每个适配器需要从源 home 复制的文件。 */
const COPY_FILES: Record<string, string[]> = {
  codex: ['auth.json', 'config.toml'],
  'claude-code': ['.credentials.json', 'settings.json', 'settings.local.json', '.claude.json'],
  dsh: ['.credentials.yaml', 'cordis.yml', 'config.yml'],
};

/** 需要整体复制的子目录(浅层, 保持结构)。 */
const COPY_DIRS: Record<string, string[]> = {
  dsh: ['profiles'],
};

export interface HomeInfo {
  dir: string;
  /** 本次从源写入私有 home 的文件(新增或覆盖)。 */
  copied: string[];
  warnings: string[];
  sourceHome: string | null;
  /** 内容有差异但保留了私有版本的文件(通常是 harness 刷新过的凭据)。 */
  kept: string[];
  /** 最近一次同步尝试的时间; 没有记录时为 null。 */
  syncedAt: string | null;
}

/** 记录"上次同步时源文件是什么内容", 用来区分"源变了"和"私有 home 变了"。 */
const SYNC_STATE_FILE = '.sync-state.json';

interface SyncStateFile {
  version: 1;
  sourceHome: string | null;
  syncedAt: string | null;
  files: Record<string, { hash: string; size: number; syncedAt: string }>;
  /** 上一次同步时保留私有版本的文件名(仅用于界面提示)。 */
  kept?: string[];
}

function readSyncState(dir: string): SyncStateFile {
  const empty: SyncStateFile = { version: 1, sourceHome: null, syncedAt: null, files: {} };
  try {
    const file = path.join(dir, SYNC_STATE_FILE);
    if (!existsSync(file)) return empty;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncStateFile>;
    if (!parsed || parsed.version !== 1 || typeof parsed.files !== 'object' || !parsed.files) return empty;
    return {
      version: 1,
      sourceHome: parsed.sourceHome ?? null,
      syncedAt: parsed.syncedAt ?? null,
      files: parsed.files as SyncStateFile['files'],
    };
  } catch {
    // 状态文件损坏时退化为"没有历史", 下一次按 mtime 保守处理
    return empty;
  }
}

function writeSyncState(dir: string, state: SyncStateFile): void {
  try {
    writeFileSync(path.join(dir, SYNC_STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // 状态文件写失败不影响本次同步结果
  }
}

/** 默认私有 home 根目录(开发版): 与 cfg.homesDir 的默认值一致。 */
export function homesDirFor(root: string): string {
  return path.join(root, '.local', 'homes');
}

/**
 * 私有 home 目录。homesRoot 由调用方传入 cfg.homesDir: 便携版/安装版把数据放在
 * data\ 下时, 这里必须跟着走, 否则适配器读的和同步写的会是两个目录。
 */
export function homeDirFor(root: string, profile: ExecutionProfile, homesRoot?: string): string {
  const prefix =
    profile.adapterId === 'claude-code' ? 'claude' : profile.adapterId === 'codex' ? 'codex' : profile.adapterId;
  return path.join(homesRoot ?? homesDirFor(root), `${prefix}-${profile.id}`);
}

function resolveSource(root: string, raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
}

/**
 * 择新同步单个文件。
 *
 * 规则(逐文件 last-write-wins 的语义, 但以"源内容是否变过"为主判据):
 * - 源不存在: 跳过(不删除私有 home 里已有文件)
 * - 私有 home 没有: 复制
 * - 内容一致: 跳过
 * - 源内容与上次同步记录不同(用户在 cc-switch 等方法改了配置): 覆盖私有
 * - 源内容没变、私有 home 更新(harness 刷新了凭据): 保留私有
 * - 没有同步记录(老目录): 按 mtime 决定, 源不旧于私有才覆盖
 *
 * resync='true' 是显式"强制以源为准", 会覆盖私有版本; 平时不要常开。
 */
function syncFile(
  from: string,
  to: string,
  force: boolean,
  state: SyncStateFile,
  copied: string[],
  kept: string[],
  warnings: string[],
): void {
  try {
    if (!existsSync(from)) return;
    const fromStat = statSync(from);
    if (!fromStat.isFile()) return;
    mkdirSync(path.dirname(to), { recursive: true });
    const srcBuf = readFileSync(from);
    const hash = createHash('sha1').update(srcBuf).digest('hex');
    const prev = state.files[from];

    if (!existsSync(to)) {
      copyFileSync(from, to);
      copied.push(to);
      state.files[from] = { hash, size: fromStat.size, syncedAt: new Date().toISOString() };
      return;
    }

    const dstBuf = readFileSync(to);
    if (srcBuf.equals(dstBuf)) {
      state.files[from] = { hash, size: fromStat.size, syncedAt: new Date().toISOString() };
      return;
    }

    let apply: boolean;
    if (force) apply = true;
    else if (prev) apply = prev.hash !== hash;
    else apply = fromStat.mtimeMs >= statSync(to).mtimeMs;

    if (apply) {
      copyFileSync(from, to);
      copied.push(to);
      state.files[from] = { hash, size: fromStat.size, syncedAt: new Date().toISOString() };
    } else {
      kept.push(to);
    }
  } catch (err) {
    warnings.push(`同步 ${from} 失败: ${(err as Error).message}`);
  }
}

function copyDirShallow(
  from: string,
  to: string,
  force: boolean,
  state: SyncStateFile,
  copied: string[],
  kept: string[],
  warnings: string[],
): void {
  if (!existsSync(from)) return;
  let names: string[] = [];
  try {
    names = readdirSync(from);
  } catch (err) {
    warnings.push(`读取目录 ${from} 失败: ${(err as Error).message}`);
    return;
  }
  for (const name of names) {
    const src = path.join(from, name);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      copyDirShallow(src, path.join(to, name), force, state, copied, kept, warnings);
    } else if (st.isFile() && st.size < 4 * 1024 * 1024) {
      syncFile(src, path.join(to, name), force, state, copied, kept, warnings);
    }
  }
}

/**
 * 确保 profile 的私有 home 存在, 并与源目录择新同步。
 *
 * 源目录由 configRefs.sourceHome 指定; 留空则只创建空 home(用户需自行放入凭据)。
 * 每次调用都会比较源与私有 home: 源变了就更新, 私有 home 变了就保留,
 * 因此可以每个回合调用一次, 让 cc-switch 之类的外部修改在下一回合生效。
 */
export function preparePrivateHome(root: string, profile: ExecutionProfile, homesRoot?: string): HomeInfo {
  const dir = homeDirFor(root, profile, homesRoot);
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];
  const source = resolveSource(root, profile.configRefs?.sourceHome);
  const force = profile.configRefs?.resync === 'true';
  const state = readSyncState(dir);

  if (source) {
    if (!existsSync(source)) {
      warnings.push(`源配置目录不存在: ${source}`);
    } else if (!path.isAbsolute(source)) {
      warnings.push(`源配置目录必须是绝对路径: ${source}`);
    } else {
      for (const name of COPY_FILES[profile.adapterId] ?? []) {
        syncFile(path.join(source, name), path.join(dir, name), force, state, copied, kept, warnings);
      }
      for (const name of COPY_DIRS[profile.adapterId] ?? []) {
        copyDirShallow(path.join(source, name), path.join(dir, name), force, state, copied, kept, warnings);
      }
    }
  }

  state.sourceHome = source;
  state.syncedAt = new Date().toISOString();
  state.kept = kept.map((file) => path.basename(file));
  writeSyncState(dir, state);

  const readme = path.join(dir, 'README-harness-hub.txt');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        '此目录是 harness-hub 为单个执行配置准备的私有 home。',
        `来源: ${source ?? '(未配置 sourceHome)'}`,
        '首次使用时会从来源复制凭据与配置; 之后每回合开始前会择新同步: 来源有变化就更新,',
        'harness 在本目录刷新过的凭据则保留(不会被旧来源覆盖)。',
        '不要在这里放置需要版本管理的内容; 删除本目录会丢失该配置的本地会话记录。',
        '本目录位于程序的数据目录内(便携版在 data\\homes), 不影响用户全局配置。',
      ].join('\n'),
      'utf8',
    );
  }

  if (!isInside(homesRoot ?? homesDirFor(root), dir)) {
    warnings.push('私有 home 路径越界, 已拒绝使用');
  }
  return { dir, copied, warnings, sourceHome: source, kept, syncedAt: state.syncedAt };
}

/** 列出参与同步的源文件(顶层文件 + 目录里的一层文件), 用于判断源是否已更新。 */
function listSyncCandidates(profile: ExecutionProfile, source: string): string[] {
  const files: string[] = [];
  for (const name of COPY_FILES[profile.adapterId] ?? []) files.push(path.join(source, name));
  for (const dirName of COPY_DIRS[profile.adapterId] ?? []) {
    const dir = path.join(source, dirName);
    try {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          if (statSync(file).isFile()) files.push(file);
        } catch {
          /* 单个文件不可读时忽略 */
        }
      }
    } catch {
      /* 目录不存在时忽略 */
    }
  }
  return files;
}

/**
 * 只读地描述私有 home 的同步状态, 供界面确认"外部改的配置有没有生效"。
 * 不写任何文件; 需要写入时走 preparePrivateHome。
 */
export function homeSyncStatus(root: string, profile: ExecutionProfile, homesRoot?: string): HomeSyncStatus {
  const dir = homeDirFor(root, profile, homesRoot);
  const source = resolveSource(root, profile.configRefs?.sourceHome);
  const state = readSyncState(dir);

  let updatedAt: string | null = null;
  for (const record of Object.values(state.files)) {
    if (!updatedAt || record.syncedAt > updatedAt) updatedAt = record.syncedAt;
  }

  let pendingSourceChange = false;
  if (source && existsSync(source)) {
    for (const file of listSyncCandidates(profile, source)) {
      try {
        const prev = state.files[file];
        const hash = createHash('sha1').update(readFileSync(file)).digest('hex');
        if (!prev || prev.hash !== hash) {
          pendingSourceChange = true;
          break;
        }
      } catch {
        /* 源文件暂时读不到, 视为暂无可判定变化 */
      }
    }
  }

  return {
    dir,
    sourceHome: source,
    checkedAt: state.syncedAt,
    updatedAt,
    pendingSourceChange,
    keptPrivate: state.kept ?? [],
  };
}
