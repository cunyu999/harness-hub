/**
 * 最小 JSON-RPC 2.0 over stdio 客户端(按行分隔)。用于 Codex app-server。
 */
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface RpcHandlers {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (id: number | string, method: string, params: unknown) => void;
  onStderr?: (text: string) => void;
  onClose?: (code: number | null, signal: string | null) => void;
}

export class StdioRpc {
  private readonly pending = new Map<number | string, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: RpcHandlers,
  ) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (buf: Buffer) => handlers.onStderr?.(buf.toString('utf8')));
    child.on('exit', (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`进程已退出 (code=${code}) 导致请求失败: ${p.method}`));
      }
      this.pending.clear();
      handlers.onClose?.(code, signal);
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return; // 忽略非协议输出
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' || typeof msg.id === 'string') {
      if (msg.method && msg.id !== undefined && !this.pending.has(msg.id)) {
        this.handlers.onRequest?.(msg.id, String(msg.method), msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = msg.error as { message?: string; code?: number };
          p.reject(new Error(`RPC ${p.method} 失败: ${err.message ?? JSON.stringify(err)}`));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) this.handlers.onNotification?.(String(msg.method), msg.params);
  }

  call<T = unknown>(method: string, params: unknown, timeoutMs = 120000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.child.stdin.write(payload + '\n');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (v) => resolve(v as T),
        reject,
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
