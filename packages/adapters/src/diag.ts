/**
 * 单次 attempt 的原始诊断日志。
 *
 * harness 的 stderr 往往包含真正的失败原因(令牌过期、沙箱拒绝、协议不匹配),
 * 但这些内容默认只打印到终端, 不会进入事件流。把它们按回合落盘, 失败后才查得动。
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CAP = 4 * 1024 * 1024;

export interface DiagLog {
  readonly file: string;
  write(text: string): void;
  close(): void;
}

/** 目录不可写时返回 null: 诊断日志永远不能影响主流程。 */
export function openDiagLog(
  dir: string | undefined | null,
  name: string,
  capBytes = DEFAULT_CAP,
): DiagLog | null {
  if (!dir) return null;
  const file = path.join(dir, name);
  let written = 0;
  let closed = false;
  try {
    mkdirSync(dir, { recursive: true });
    written = statSync(file).size;
  } catch {
    written = 0;
  }
  return {
    file,
    write(text: string) {
      if (closed || written >= capBytes) return;
      const bytes = Buffer.byteLength(text, 'utf8');
      const chunk = written + bytes > capBytes ? `…[诊断日志超过 ${capBytes} 字节, 已截断]\n` : text;
      try {
        appendFileSync(file, chunk, 'utf8');
        written += Buffer.byteLength(chunk, 'utf8');
        if (written >= capBytes) closed = true;
      } catch {
        /* 写不进去就放弃, 不影响回合 */
      }
    },
    close() {
      closed = true;
    },
  };
}
