import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import type { ManagedSession, RunAttempt } from '../../../../packages/contracts/src/types';
import type { TaskDetail } from '../api';

export interface LiveStatus {
  tone: 'run' | 'wait' | 'bad' | 'idle';
  label: string;
  detail: string | null;
  since: number | null;
}

const RUNNING = new Set(['starting', 'running', 'waiting_approval', 'waiting_user', 'retry_wait']);

function text(value: unknown, max = 120): string {
  const s = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 由已有事件/尝试/会话推导"这个席位此刻在干什么"。
 * 只读快照与事件流, 不额外问模型; 没有可靠依据时返回 null(界面就不显示状态条)。
 */
export function liveStatus(
  detail: TaskDetail | null,
  events: EventEnvelope[],
  participantId: string | null,
  now: number,
): LiveStatus | null {
  if (!detail || !participantId) return null;

  const attempts = detail.attempts.filter((a) => a.participantId === participantId);
  const sessions = detail.sessions.filter((s) => s.participantId === participantId);

  const activeAttempt = attempts
    .filter((a) => RUNNING.has(a.status))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] as RunAttempt | undefined;
  const activeSession = [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] as ManagedSession | undefined;

  const latest = attempts.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] as RunAttempt | undefined;

  // 最近一次尝试刚失败: 显示一会儿错误, 让用户看得到
  if (!activeAttempt && latest && (latest.status === 'failed' || latest.status === 'interrupted' || latest.status === 'cancelled')) {
    const ended = latest.endedAt ? Date.parse(latest.endedAt) : 0;
    if (ended && now - ended < 120_000) {
      return {
        tone: latest.status === 'failed' ? 'bad' : 'wait',
        label: latest.status === 'failed' ? '上一回合失败' : latest.status === 'cancelled' ? '上一回合已取消' : '上一回合被中断',
        detail: latest.errorMessage ? text(latest.errorMessage, 160) : null,
        since: ended,
      };
    }
    return null;
  }

  if (!activeAttempt) return null;

  // 该尝试下最近的一次工具调用是否还没结束
  const related = events.filter(
    (e) => e.attemptId === activeAttempt.id && (e.type === 'tool.started' || e.type === 'tool.completed'),
  );
  const openTools = new Map<string, EventEnvelope>();
  for (const e of related) {
    const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
    if (!callId) continue;
    if (e.type === 'tool.started') openTools.set(callId, e);
    else openTools.delete(callId);
  }
  const currentTool = [...openTools.values()].sort((a, b) => b.seq - a.seq)[0];

  const lastEventAt = activeSession?.lastEventAt ? Date.parse(activeSession.lastEventAt) : null;
  const startedAt = currentTool?.observedAt
    ? Date.parse(currentTool.observedAt)
    : activeAttempt.startedAt
      ? Date.parse(activeAttempt.startedAt)
      : null;

  if (activeAttempt.status === 'waiting_approval') {
    return { tone: 'wait', label: '等你批准', detail: 'harness 请求了一个需要你确认的操作', since: lastEventAt };
  }
  if (activeAttempt.status === 'waiting_user') {
    return { tone: 'wait', label: '等你回答', detail: 'harness 提问了, 回复后会继续这个工作项', since: lastEventAt };
  }
  if (activeAttempt.status === 'retry_wait') {
    return { tone: 'wait', label: '重试等待中', detail: '上一次是基础设施错误, 程序会自动重试', since: lastEventAt };
  }
  if (activeAttempt.status === 'starting') {
    return { tone: 'run', label: '正在启动会话', detail: null, since: startedAt };
  }

  if (currentTool) {
    const name = text(currentTool.payload?.toolName, 40) || '工具';
    const input = text(currentTool.payload?.inputSummary, 140);
    return { tone: 'run', label: `运行 ${name}`, detail: input || null, since: startedAt };
  }

  const activity = activeSession?.activity ?? 'unknown';
  if (lastEventAt && now - lastEventAt > 60_000) {
    return {
      tone: 'wait',
      label: `已 ${Math.round((now - lastEventAt) / 1000)}s 没有新事件`,
      detail: '进程还活着, 但 harness 暂时没输出',
      since: lastEventAt,
    };
  }
  if (activity === 'generating') return { tone: 'run', label: '思考 / 生成中', detail: null, since: startedAt };
  if (activity === 'tool_running') return { tone: 'run', label: '工具运行中', detail: null, since: startedAt };

  // 最近 4 秒内还有正文增量, 说明模型正在往外吐字
  const lastDelta = [...events]
    .reverse()
    .find((e) => e.attemptId === activeAttempt.id && e.type === 'message.delta');
  if (lastDelta) {
    const at = Date.parse(lastDelta.observedAt);
    if (now - at < 4_000) return { tone: 'run', label: '思考 / 生成中', detail: null, since: startedAt };
  }

  const KIND_LABEL: Record<string, string> = {
    plan: '规划中',
    'plan.synthesize': '汇总计划中',
    'discussion.proposal': '写方案中',
    'discussion.critique': '质询中',
    work: '执行工作项',
    review: '审核中',
    'review.crosscheck': '交叉复核中',
    integrate: '集成中',
    deliver: '写交付说明',
    chat: '回复中',
  };
  const kindLabel = KIND_LABEL[String(activeAttempt.kind ?? '')] ?? '运行中';
  return { tone: 'run', label: kindLabel, detail: text(activeAttempt.kind, 40) === kindLabel ? null : null, since: startedAt };
}
