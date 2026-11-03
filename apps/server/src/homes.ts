/**
 * 私有 home 准备。
 *
 * Codex / Claude Code / DSH 都会往自己的 home 目录写会话、缓存与凭据刷新结果。
 * 为了不修改用户全局配置, 我们为每个 profile 建一个项目内 home, 首次使用时
 * 从用户指定的源目录"复制"凭据与配置(只读源, 不移动、不删除、不改写)。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  copied: string[];
  warnings: string[];
  sourceHome: string | null;
}

export function homeDirFor(root: string, profile: ExecutionProfile): string {
  const prefix =
    profile.adapterId === 'claude-code' ? 'claude' : profile.adapterId === 'codex' ? 'codex' : profile.adapterId;
  return path.join(root, '.local', 'homes', `${prefix}-${profile.id}`);
}

function resolveSource(root: string, raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
}

function copyIfMissing(from: string, to: string, overwrite: boolean, copied: string[], warnings: string[]): void {
  try {
    if (!existsSync(from)) return;
    if (existsSync(to) && !overwrite) return;
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(to);
  } catch (err) {
    warnings.push(`复制 ${from} 失败: ${(err as Error).message}`);
  }
}

function copyDirShallow(from: string, to: string, overwrite: boolean, copied: string[], warnings: string[]): void {
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
      copyDirShallow(src, path.join(to, name), overwrite, copied, warnings);
    } else if (st.isFile() && st.size < 4 * 1024 * 1024) {
      copyIfMissing(src, path.join(to, name), overwrite, copied, warnings);
    }
  }
}

/**
 * 确保 profile 的私有 home 存在。
 * 源目录由 configRefs.sourceHome 指定; 留空则只创建空 home(用户需自行放入凭据)。
 */
export function preparePrivateHome(root: string, profile: ExecutionProfile): HomeInfo {
  const dir = homeDirFor(root, profile);
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const warnings: string[] = [];
  const source = resolveSource(root, profile.configRefs?.sourceHome);
  const overwrite = profile.configRefs?.resync === 'true';

  if (source) {
    if (!existsSync(source)) {
      warnings.push(`源配置目录不存在: ${source}`);
    } else if (!path.isAbsolute(source)) {
      warnings.push(`源配置目录必须是绝对路径: ${source}`);
    } else {
      for (const name of COPY_FILES[profile.adapterId] ?? []) {
        copyIfMissing(path.join(source, name), path.join(dir, name), overwrite, copied, warnings);
      }
      for (const name of COPY_DIRS[profile.adapterId] ?? []) {
        copyDirShallow(path.join(source, name), path.join(dir, name), overwrite, copied, warnings);
      }
    }
  }

  const readme = path.join(dir, 'README-harness-hub.txt');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        '此目录是 harness-hub 为单个执行配置准备的私有 home。',
        `来源: ${source ?? '(未配置 sourceHome)'}`,
        '首次使用时会从来源复制凭据与配置; 之后 harness 会在此写会话/缓存/刷新后的凭据。',
        '不要在这里放置需要版本管理的内容; 删除本目录会丢失该配置的本地会话记录。',
        '本目录位于项目 D:\\1hobby 内, 不影响用户全局配置。',
      ].join('\n'),
      'utf8',
    );
  }

  if (!isInside(path.join(root, '.local'), dir)) {
    warnings.push('私有 home 路径越界, 已拒绝使用');
  }
  return { dir, copied, warnings, sourceHome: source };
}
