import type { MonitorActivity, TaskLifecycle, TaskPhase, WorkItemState } from '../../../../packages/contracts/src/types';

export const PHASES: TaskPhase[] = [
  'intake',
  'planning',
  'discussion',
  'execution',
  'integration',
  'verification',
  'review',
  'delivery',
];

export const PHASE_LABEL: Record<TaskPhase, string> = {
  intake: '受理',
  planning: '规划',
  discussion: '讨论',
  execution: '执行',
  integration: '集成',
  verification: '验证',
  review: '审核',
  delivery: '交付',
};

export const LIFECYCLE_LABEL: Record<TaskLifecycle, string> = {
  draft: '草稿',
  active: '进行中',
  awaiting_plan_approval: '等待计划确认',
  waiting_user: '等待用户',
  paused: '已暂停',
  cancelling: '取消中',
  cancelled: '已取消',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
};

export const LIFECYCLE_TONE: Record<TaskLifecycle, 'green' | 'amber' | 'red' | 'violet' | 'muted' | 'cyan'> = {
  draft: 'muted',
  active: 'cyan',
  awaiting_plan_approval: 'violet',
  waiting_user: 'amber',
  paused: 'amber',
  cancelling: 'amber',
  cancelled: 'muted',
  blocked: 'red',
  completed: 'green',
  failed: 'red',
};

export const ITEM_LABEL: Record<WorkItemState, string> = {
  pending: '待处理',
  ready: '就绪',
  queued: '排队中',
  running: '执行中',
  waiting_input: '等待输入',
  produced: '已产出',
  verifying: '验证中',
  awaiting_review: '等待审核',
  accepted: '已接受',
  failed: '失败',
  cancelled: '已取消',
  invalidated: '已失效',
};

export const ITEM_TONE: Record<WorkItemState, 'green' | 'amber' | 'red' | 'violet' | 'muted' | 'cyan'> = {
  pending: 'muted',
  ready: 'muted',
  queued: 'muted',
  running: 'cyan',
  waiting_input: 'amber',
  produced: 'violet',
  verifying: 'cyan',
  awaiting_review: 'violet',
  accepted: 'green',
  failed: 'red',
  cancelled: 'muted',
  invalidated: 'muted',
};

export const ACTIVITY_LABEL: Record<MonitorActivity, string> = {
  generating: '生成中',
  tool_running: '工具执行中',
  idle: '空闲',
  no_recent_event: '长时间无事件',
  unknown: '未知',
};

export const VERDICT_LABEL: Record<string, string> = {
  approve: '通过',
  changes_required: '需要修改',
  needs_user_decision: '需要用户决策',
  unable_to_review: '无法审核',
};

export const VERDICT_TONE: Record<string, 'green' | 'amber' | 'red' | 'violet' | 'muted'> = {
  approve: 'green',
  changes_required: 'amber',
  needs_user_decision: 'violet',
  unable_to_review: 'red',
};

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '—';
  return id.length <= n ? id : id.slice(0, n);
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  return `${Math.round(s / 3600)}h 前`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'strong':
      return '强模型';
    case 'worker':
      return '执行者';
    default:
      return role;
  }
}
