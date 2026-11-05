import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  /** 当前目录(绝对路径); 为空表示"还没选, 给你几个起点" */
  path: string | null;
  parent: string | null;
  entries: FsEntry[];
  roots: { label: string; path: string }[];
  error?: string;
}

/** 起点: Windows 盘符 + 用户主目录; 其余平台只有主目录与根。 */
function roots(): { label: string; path: string }[] {
  const list: { label: string; path: string }[] = [];
  const home = os.homedir();
  if (home) list.push({ label: `主目录 (${home})`, path: home });
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const dir = `${letter}:\\`;
      if (existsSync(dir)) list.push({ label: `磁盘 ${letter}:`, path: dir });
    }
  } else {
    list.push({ label: '根目录 /', path: '/' });
  }
  return list;
}

/**
 * 只读列目录, 供网页里的"选择工作区"用。
 * 不创建、不删除任何东西; 不跟随符号链接之外的越权行为(只读列举)。
 */
export function listDirectory(input: string | null | undefined): FsListing {
  const raw = (input ?? '').trim();
  if (!raw) return { path: null, parent: null, entries: [], roots: roots() };

  const abs = path.resolve(raw);
  if (!existsSync(abs)) {
    return { path: abs, parent: path.dirname(abs), entries: [], roots: roots(), error: '目录不存在' };
  }
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { path: abs, parent: path.dirname(abs), entries: [], roots: roots(), error: '这不是一个目录' };
  }

  let entries: FsEntry[] = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => ({ name: d.name, path: path.join(abs, d.name), isDir: true }))
      .filter((e) => {
        try {
          return statSync(e.path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch (e) {
    return {
      path: abs,
      parent: path.dirname(abs),
      entries: [],
      roots: roots(),
      error: e instanceof Error ? e.message : '无法读取目录',
    };
  }

  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries, roots: roots() };
}

/** 允许带出来的文件类型(上传用), 其余一律按二进制处理。 */
export function guessMediaType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.cpp': 'text/x-c++src',
    '.cc': 'text/x-c++src',
    '.h': 'text/x-c++hdr',
    '.hpp': 'text/x-c++hdr',
    '.c': 'text/x-csrc',
    '.py': 'text/x-python',
    '.ts': 'text/typescript',
    '.js': 'text/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
