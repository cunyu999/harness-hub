import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 稳定序列化: 递归排序对象键, 保证同一内容得到同一 hash。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256Stable(value: unknown): string {
  return sha256Text(stableStringify(value));
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });
}

/** 相对路径统一成 POSIX 形式, 并去掉开头的 ./, 保证跨平台只登记一份。 */
export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

export function safeJoin(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathSafetyError('路径为空');
  }
  if (relativePath.includes('\0')) throw new PathSafetyError('路径包含空字符');
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) throw new PathSafetyError(`拒绝绝对盘符路径: ${relativePath}`);
  if (relativePath.startsWith('\\\\') || relativePath.startsWith('//')) {
    throw new PathSafetyError(`拒绝 UNC 路径: ${relativePath}`);
  }
  if (isAbsolute(relativePath)) throw new PathSafetyError(`拒绝绝对路径: ${relativePath}`);
  const normalized = normalize(relativePath.replace(/\\/g, '/'));
  if (normalized.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new PathSafetyError(`拒绝上跳路径: ${relativePath}`);
  }
  const abs = resolve(root, normalized);
  if (!isInside(root, abs)) throw new PathSafetyError(`路径逃逸: ${relativePath}`);
  return abs;
}

export function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 在文件已存在时做 realpath 校验, 防止符号链接/目录联接逃逸。 */
export function assertRealInside(root: string, target: string): string {
  const abs = resolve(target);
  if (!isInside(root, abs)) throw new PathSafetyError(`路径逃逸: ${target}`);
  if (existsSync(abs)) {
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    const realTarget = realpathSync(abs);
    if (!isInside(realRoot, realTarget)) {
      throw new PathSafetyError(`符号链接逃逸: ${target}`);
    }
    return realTarget;
  }
  return abs;
}

export function fileStatSafe(path: string): { size: number; mtime: string } | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

export function mediaTypeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/plain',
    cpp: 'text/x-c++src',
    cc: 'text/x-c++src',
    cxx: 'text/x-c++src',
    h: 'text/x-c++hdr',
    hpp: 'text/x-c++hdr',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

export const PREVIEWABLE = new Set([
  'text/markdown',
  'text/plain',
  'application/json',
  'text/csv',
  'text/x-c++src',
  'text/x-c++hdr',
  'text/css',
  'text/javascript',
]);

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [已截断, 原长度 ${text.length} 字符]`;
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
