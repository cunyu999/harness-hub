import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type TaskDetail } from './api';
import type { EventEnvelope } from '../../../packages/contracts/src/events';

export interface StreamDelta {
  key: string;
  sessionId: string | null;
  attemptId: string | null;
  role: 'assistant' | 'system';
  text: string;
  updatedAt: number;
}

export interface LiveUsage {
  attemptId: string;
  participantId: string | null;
  input: number;
  output: number;
  cached: number;
  total: number;
  at: number;
}

export type ConnState = 'connecting' | 'live' | 'reconnecting';

export interface TaskState {
  detail: TaskDetail | null;
  events: EventEnvelope[];
  deltas: StreamDelta[];
  conn: ConnState;
  error: string | null;
  lastEventAt: number | null;
  /** 还没结算的回合最近一次上报的用量(用于"进行中"实时显示)。 */
  usageLive: LiveUsage[];
  reload: () => void;
}

const MAX_EVENTS = 4000;

/**
 * 订阅任务事件流。状态一律来自服务端快照: 收到结构性事件后拉取最新快照,
 * 增量文本单独累积, 避免在前端重放业务规则。
 */
export function useTask(taskId: string | null): TaskState {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [deltas, setDeltas] = useState<StreamDelta[]>([]);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [usageLive, setUsageLive] = useState<LiveUsage[]>([]);
  const cursor = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(
    async (id: string) => {
      try {
        const d = await api.getTask(id);
        setDetail(d);
        setError(null);
        return d;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        // 任务已被删除: 清掉本地记住的 id, 不要把"不存在"当成错误一直挂着
        if (/不存在|not_found|404/.test(text)) {
          localStorage.removeItem('hh.taskId');
          setDetail(null);
          setError(null);
          return null;
        }
        setError(text);
        return null;
      }
    },
    [],
  );

  const scheduleReload = useCallback(
    (id: string) => {
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void load(id);
      }, 220);
    },
    [load],
  );

  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      setEvents([]);
      setDeltas([]);
      return;
    }
    let closed = false;
    cursor.current = 0;
    setEvents([]);
    setDeltas([]);
    setUsageLive([]);
    setConn('connecting');

    void load(taskId).then(() => {
      if (closed) return;
      const es = new EventSource(`/api/tasks/${taskId}/events?after=0`);
      esRef.current = es;
      es.onopen = () => setConn('live');
      es.onerror = () => setConn('reconnecting');
      es.addEventListener('snapshot', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { snapshot: TaskDetail };
          setDetail((prev) => ({ ...(prev ?? ({} as TaskDetail)), ...data.snapshot }));
        } catch {
          /* ignore */
        }
      });
      es.onmessage = () => {
        /* 命名事件已覆盖, 忽略默认 message */
      };
      // 所有事件都带 event: <type>, 逐个注册会遗漏新类型, 改用 SSE 的命名事件通配不可行;
      // 因此后端同时以事件类型命名发送, 这里对已知类型统一注册。
      const types = [
        'runtime.started',
        'runtime.exited',
        'runtime.connection_changed',
        'session.created',
        'session.resumed',
        'session.closed',
        'session.configuration_observed',
        'attempt.starting',
        'attempt.started',
        'attempt.completed',
        'attempt.failed',
        'attempt.interrupted',
        'attempt.retry_wait',
        'attempt.cancel_requested',
        'attempt.cancel_confirmed',
        'message.delta',
        'message.completed',
        'tool.started',
        'tool.progress',
        'tool.completed',
        'request.approval',
        'request.user_input',
        'request.resolved',
        'monitor.no_recent_event',
        'monitor.health_changed',
        'usage.updated',
        'plan.proposed',
        'plan.revised',
        'plan.approved',
        'plan.rejected',
        'work_item.queued',
        'work_item.updated',
        'work_item.result',
        'artifact.registered',
        'verification.recorded',
        'review.recorded',
        'delivery.updated',
        'task.updated',
        'task.control',
        'error.reported',
        'resync_required',
      ];
      const handle = (raw: MessageEvent) => {
        let env: EventEnvelope | null = null;
        try {
          env = JSON.parse(raw.data) as EventEnvelope;
        } catch {
          return;
        }
        if (!env || typeof env.seq !== 'number') return;
        if (env.seq <= cursor.current) return;
        cursor.current = env.seq;
        setLastEventAt(Date.now());
        setEvents((prev) => {
          const next = prev.concat(env as EventEnvelope);
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
        if (env.type === 'usage.updated') {
          const p = env.payload as { participantId?: string; tokens?: Record<string, number> };
          const t = p.tokens ?? {};
          const attemptId = env.attemptId ?? '';
          if (attemptId) {
            const entry: LiveUsage = {
              attemptId,
              participantId: p.participantId ?? null,
              input: Number(t.input ?? 0),
              output: Number(t.output ?? 0),
              cached: Number(t.cached ?? 0),
              total: Number(t.total ?? 0),
              at: Date.now(),
            };
            setUsageLive((prev) => {
              const idx = prev.findIndex((x) => x.attemptId === attemptId);
              if (idx < 0) return prev.concat(entry).slice(-12);
              const copy = prev.slice();
              copy[idx] = entry;
              return copy;
            });
          }
        }
        if (env.type === 'message.delta') {
          const p = env.payload as { text?: string; role?: string };
          const text = p.text ?? '';
          const key = `${env.attemptId ?? env.sessionId ?? 'unknown'}`;
          setDeltas((prev) => {
            const idx = prev.findIndex((d) => d.key === key);
            const next: StreamDelta = {
              key,
              sessionId: env?.sessionId ?? null,
              attemptId: env?.attemptId ?? null,
              role: p.role === 'system' ? 'system' : 'assistant',
              text: (idx >= 0 ? prev[idx].text : '') + text,
              updatedAt: Date.now(),
            };
            if (idx < 0) return prev.concat(next).slice(-20);
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
          });
        }
        if (env.type === 'message.completed') {
          const key = `${env.attemptId ?? env.sessionId ?? 'unknown'}`;
          setDeltas((prev) => prev.filter((d) => d.key !== key));
        }
        // 回合结束(含失败/中断)后增量气泡没有意义: 结构化结果已进快照与消息
        if (env.type === 'attempt.completed' || env.type === 'attempt.failed' || env.type === 'attempt.interrupted') {
          const attemptId = env.attemptId;
          if (attemptId) {
            setDeltas((prev) => prev.filter((d) => d.attemptId !== attemptId));
            setUsageLive((prev) => prev.filter((u) => u.attemptId !== attemptId));
          }
        }
        if ((env.type as string) === 'resync_required') {
          cursor.current = 0;
          void load(taskId);
          return;
        }
        scheduleReload(taskId);
      };
      for (const t of types) es.addEventListener(t, handle as EventListener);
      es.addEventListener('snapshot', () => {
        /* snapshot 已单独处理 */
      });
    });

    return () => {
      closed = true;
      esRef.current?.close();
      esRef.current = null;
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
    };
  }, [taskId, load, scheduleReload]);

  const reload = useCallback(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  return useMemo(
    () => ({ detail, events, deltas, conn, error, lastEventAt, usageLive, reload }),
    [detail, events, deltas, conn, error, lastEventAt, usageLive, reload],
  );
}

/** 任务列表轮询(列表页无需实时)。 */
export function useTaskList(): { tasks: Awaited<ReturnType<typeof api.listTasks>>; reload: () => void } {
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof api.listTasks>>>([]);
  const reload = useCallback(() => {
    void api.listTasks().then(setTasks).catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [reload]);
  return { tasks, reload };
}
