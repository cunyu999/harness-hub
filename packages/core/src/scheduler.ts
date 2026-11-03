/**
 * 派发决策(纯函数, 便于单测)。
 * 输入工作项状态与当前活跃尝试, 输出本次可启动的工作项。
 */
import type { WorkItemState } from '../../contracts/src/types.js';
import { scopesOverlap } from './plan.js';

export interface DispatchItem {
  id: string;
  state: WorkItemState;
  dependencies: string[];
  writeScope: string[];
  participantId: string;
  profileId: string;
  riskLevel: string;
}

export interface DispatchInput {
  items: DispatchItem[];
  active: { itemId: string; profileId: string; writeScope: string[] }[];
  limits: {
    workerParallelism: number;
    perProfileParallelism: number;
    nativeProcessConcurrency: number;
  };
}

export interface DispatchDecision {
  start: string[];
  /** 因依赖失败/取消而永远不可能就绪的工作项 */
  deadlocked: { id: string; reason: string }[];
  waiting: { id: string; reason: string }[];
}

/** 上游产物已落盘并登记, 后继即可读取; 审核通过与否在全局审核阶段统一裁决。 */
const ARTIFACT_READY_STATES: WorkItemState[] = ['produced', 'verifying', 'awaiting_review', 'accepted'];

export function dependencyReady(item: DispatchItem, byId: Map<string, DispatchItem>): boolean {
  return item.dependencies.every((d) => {
    const dep = byId.get(d);
    return dep ? ARTIFACT_READY_STATES.includes(dep.state) : false;
  });
}

export function dependencyDead(item: DispatchItem, byId: Map<string, DispatchItem>): string | null {
  for (const d of item.dependencies) {
    const dep = byId.get(d);
    if (!dep) return `依赖不存在: ${d}`;
    if (dep.state === 'failed' || dep.state === 'cancelled' || dep.state === 'invalidated') {
      return `依赖 ${d} 处于 ${dep.state}`;
    }
  }
  return null;
}

export function selectDispatchable(input: DispatchInput): DispatchDecision {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const activeByProfile = new Map<string, number>();
  for (const a of input.active) {
    activeByProfile.set(a.profileId, (activeByProfile.get(a.profileId) ?? 0) + 1);
  }
  let activeTotal = input.active.length;
  const batchScopes: string[][] = input.active.map((a) => a.writeScope);
  const start: string[] = [];
  const waiting: { id: string; reason: string }[] = [];
  const deadlocked: { id: string; reason: string }[] = [];

  const globalCap = Math.min(input.limits.workerParallelism, input.limits.nativeProcessConcurrency);

  // 优先无依赖的项, 其次依赖较少的项, 保证早期能并行铺开
  const candidates = input.items
    .filter((i) => i.state === 'pending' || i.state === 'ready')
    .sort((a, b) => a.dependencies.length - b.dependencies.length || a.id.localeCompare(b.id));

  for (const item of candidates) {
    const dead = dependencyDead(item, byId);
    if (dead) {
      deadlocked.push({ id: item.id, reason: dead });
      continue;
    }
    if (!dependencyReady(item, byId)) {
      waiting.push({ id: item.id, reason: '依赖未完成' });
      continue;
    }
    if (activeTotal >= globalCap) {
      waiting.push({ id: item.id, reason: '达到全局并发上限' });
      continue;
    }
    const profileActive = activeByProfile.get(item.profileId) ?? 0;
    if (profileActive >= input.limits.perProfileParallelism) {
      waiting.push({ id: item.id, reason: '该执行配置已有活跃会话' });
      continue;
    }
    if (batchScopes.some((s) => scopesOverlap(s, item.writeScope))) {
      waiting.push({ id: item.id, reason: '写入范围与其他活跃工作项冲突' });
      continue;
    }
    start.push(item.id);
    batchScopes.push(item.writeScope);
    activeTotal += 1;
    activeByProfile.set(item.profileId, profileActive + 1);
  }

  return { start, deadlocked, waiting };
}

/** 工作项是否已全部进入终态 */
export function allTerminal(items: { state: WorkItemState }[]): boolean {
  return items.every((i) => ['accepted', 'failed', 'cancelled', 'invalidated'].includes(i.state));
}

/** 执行阶段是否已收敛: 全部工作项都已产出待审或已终态, 没有还可派发的活。 */
export function executionSettled(items: { state: WorkItemState }[]): boolean {
  return items.every((i) =>
    ['awaiting_review', 'accepted', 'failed', 'cancelled', 'invalidated'].includes(i.state),
  );
}
