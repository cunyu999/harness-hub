/**
 * 进程内事件总线: 持久化事件写入数据库后广播给 SSE 连接。
 * 事件按 taskId 订阅; 订阅者拿到的是已落库的 EventEnvelope(带 seq)。
 */
import type { EventEnvelope } from '../../contracts/src/events.js';

type Listener = (env: EventEnvelope) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(taskId);
    };
  }

  publish(env: EventEnvelope): void {
    if (!env.taskId) return;
    const set = this.listeners.get(env.taskId);
    if (!set) return;
    for (const l of set) {
      try {
        l(env);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  subscriberCount(taskId: string): number {
    return this.listeners.get(taskId)?.size ?? 0;
  }
}
