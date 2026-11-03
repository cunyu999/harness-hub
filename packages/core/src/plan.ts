/**
 * 计划的结构化校验与归一化。
 * 模型只能"提出"计划; 依赖无环、路径安全、验收要求、参与者合法等由程序强制。
 */
import type {
  Deliverable,
  OutputSpec,
  Participant,
  PlanContent,
  PlanWorkItem,
  TaskLimits,
  TaskRecord,
} from '../../contracts/src/types.js';
import { PathSafetyError, safeJoin, sha256Stable, unique } from './util.js';

export interface PlanValidationContext {
  task: TaskRecord;
  participants: Participant[];
  limits: TaskLimits;
  workspaceRoot: string;
  outputDir: string;
}

export interface PlanValidationResult {
  ok: boolean;
  plan: PlanContent | null;
  errors: string[];
  warnings: string[];
  contentHash: string | null;
}

const RISK_LEVELS = ['low', 'medium', 'high'];

function asStringArray(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeOutput(raw: unknown, errors: string[], itemId: string): OutputSpec | null {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`工作项 ${itemId}: expectedOutputs 项不是对象`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const relativePath = asString(o.relativePath);
  if (!relativePath) {
    errors.push(`工作项 ${itemId}: 输出缺少 relativePath`);
    return null;
  }
  const label = asString(o.label) || relativePath;
  const format = asString(o.format) || relativePath.split('.').pop() || 'unknown';
  const validationRaw = asString(o.validation);
  const validation = (['exists', 'nonempty', 'command', 'none'] as const).includes(
    validationRaw as 'exists',
  )
    ? (validationRaw as OutputSpec['validation'])
    : 'exists';
  return {
    label,
    format,
    relativePath,
    template: o.template ? asString(o.template) : null,
    validation,
    validationCommand: o.validationCommand ? asString(o.validationCommand) : null,
  };
}

export function validatePlan(raw: unknown, ctx: PlanValidationContext): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, plan: null, errors: ['计划不是 JSON 对象'], warnings, contentHash: null };
  }
  const r = raw as Record<string, unknown>;
  const objective = asString(r.objective) || ctx.task.objective;
  const rawItems = Array.isArray(r.workItems) ? r.workItems : [];
  if (rawItems.length === 0) errors.push('计划没有 workItems');
  if (rawItems.length > ctx.limits.maxWorkItems) {
    errors.push(`工作项数量 ${rawItems.length} 超过上限 ${ctx.limits.maxWorkItems}`);
  }

  const participantIds = new Set(ctx.participants.map((p) => p.id));
  const strongIds = ctx.participants.filter((p) => p.role === 'strong').map((p) => p.id);
  const lead = ctx.participants.find((p) => p.isLead);

  const items: PlanWorkItem[] = [];
  const seenIds = new Set<string>();
  rawItems.forEach((rawItem, idx) => {
    if (typeof rawItem !== 'object' || rawItem === null) {
      errors.push(`工作项 #${idx + 1} 不是对象`);
      return;
    }
    const it = rawItem as Record<string, unknown>;
    const id = asString(it.id) || `wi-${idx + 1}`;
    if (seenIds.has(id)) {
      errors.push(`工作项 id 重复: ${id}`);
      return;
    }
    seenIds.add(id);
    const goal = asString(it.goal);
    if (!goal) errors.push(`工作项 ${id}: goal 为空`);
    const acceptance = asStringArray(it.acceptanceCriteria, 20);
    if (acceptance.length === 0) errors.push(`工作项 ${id}: 缺少 acceptanceCriteria`);
    const dependencies = unique(asStringArray(it.dependencies, 20).filter((d) => d !== id));

    let assigned = asString(it.assignedParticipantId) || null;
    if (assigned && !participantIds.has(assigned)) {
      errors.push(`工作项 ${id}: 指派给未选参与者 ${assigned}`);
      assigned = null;
    }
    if (!assigned) assigned = lead?.id ?? ctx.participants[0]?.id ?? null;

    const outputs: OutputSpec[] = [];
    for (const rawOut of Array.isArray(it.expectedOutputs) ? it.expectedOutputs : []) {
      const out = normalizeOutput(rawOut, errors, id);
      if (out) outputs.push(out);
    }

    const writeScope: string[] = [];
    for (const p of asStringArray(it.writeScope, 20)) {
      try {
        safeJoin(ctx.workspaceRoot, p);
        writeScope.push(p);
      } catch (err) {
        errors.push(`工作项 ${id}: writeScope 不可用 (${(err as PathSafetyError).message})`);
      }
    }
    for (const out of outputs) {
      try {
        safeJoin(ctx.workspaceRoot, out.relativePath);
      } catch (err) {
        errors.push(`工作项 ${id}: 输出路径不可用 (${(err as PathSafetyError).message})`);
      }
      if (writeScope.length > 0 && !writeScope.includes(out.relativePath)) {
        warnings.push(`工作项 ${id}: 输出 ${out.relativePath} 不在 writeScope 内, 已自动加入`);
        writeScope.push(out.relativePath);
      }
    }
    if (writeScope.length === 0 && outputs.length > 0) {
      writeScope.push(...outputs.map((o) => o.relativePath));
    }

    const risk = asString(it.riskLevel).toLowerCase();
    items.push({
      id,
      goal,
      dependencies,
      assignedParticipantId: assigned,
      inputs: asStringArray(it.inputs, 20),
      expectedOutputs: outputs,
      acceptanceCriteria: acceptance,
      writeScope: unique(writeScope),
      riskLevel: (RISK_LEVELS.includes(risk) ? risk : 'low') as PlanWorkItem['riskLevel'],
    });
  });

  // 依赖必须存在且无环
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const item of items) {
    for (const dep of item.dependencies) {
      if (!byId.has(dep)) errors.push(`工作项 ${item.id}: 依赖不存在 ${dep}`);
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(items);
    if (cycle) errors.push(`依赖图存在环: ${cycle.join(' -> ')}`);
  }

  const deliverables: Deliverable[] = (Array.isArray(r.deliverables) ? r.deliverables : [])
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .slice(0, 20)
    .map((d) => ({
      label: asString(d.label) || '交付物',
      format: asString(d.format) || 'unknown',
      templateRef: d.templateRef ? asString(d.templateRef) : null,
      destination: asString(d.destination) || ctx.outputDir,
      validationMethod: asString(d.validationMethod) || '文件存在且可读',
      editableSource: d.editableSource ? asString(d.editableSource) : null,
    }));
  if (deliverables.length === 0 && items.length > 0) {
    warnings.push('计划没有声明 deliverables, 已根据输出推导');
    for (const item of items) {
      for (const out of item.expectedOutputs) {
        deliverables.push({
          label: out.label,
          format: out.format,
          templateRef: out.template,
          destination: out.relativePath,
          validationMethod: '文件存在且非空',
          editableSource: null,
        });
      }
    }
  }

  const reviewPolicyRaw = (r.reviewPolicy ?? {}) as Record<string, unknown>;
  const requestedStrong = asStringArray(reviewPolicyRaw.strongParticipantIds, 8).filter((id) =>
    participantIds.has(id),
  );
  const reviewPolicy = {
    // 不信任模型随意缩减审核席位: 始终使用本次实际选定的全部强模型。
    strongParticipantIds: strongIds,
    crossReviewRequired:
      typeof reviewPolicyRaw.crossReviewRequired === 'boolean'
        ? reviewPolicyRaw.crossReviewRequired
        : strongIds.length >= 2,
  };
  if (requestedStrong.length !== strongIds.length) {
    warnings.push('计划中的 strongParticipantIds 与本次参与者不一致, 已使用实际参与者');
  }

  const limitsRaw = (r.limits ?? {}) as Record<string, unknown>;
  const limits: Partial<TaskLimits> = {};
  for (const key of Object.keys(ctx.limits) as (keyof TaskLimits)[]) {
    const v = limitsRaw[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      limits[key] = Math.max(1, Math.floor(v)) as never;
    }
  }
  if (limits.workerParallelism && limits.workerParallelism > ctx.limits.nativeProcessConcurrency) {
    limits.workerParallelism = ctx.limits.workerParallelism;
    warnings.push('workerParallelism 超过原生进程并发上限, 已收敛');
  }

  const plan: PlanContent = {
    objective,
    constraints: asStringArray(r.constraints, 50).length
      ? asStringArray(r.constraints, 50)
      : ctx.task.constraints,
    assumptions: asStringArray(r.assumptions, 30),
    clarificationNeeded: asStringArray(r.clarificationNeeded, 20),
    workItems: items.slice(0, ctx.limits.maxWorkItems),
    deliverables,
    verificationSteps: asStringArray(r.verificationSteps, 30),
    reviewPolicy,
    changeScope: asString(r.changeScope) || '仅限计划声明的 writeScope',
    risks: asStringArray(r.risks, 30),
    limits,
    unresolvedDecisions: asStringArray(r.unresolvedDecisions, 20),
  };

  if (plan.workItems.length !== items.length) {
    warnings.push(`工作项数量超过上限, 已截断到 ${plan.workItems.length} 项`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    plan: ok ? plan : null,
    errors,
    warnings,
    contentHash: ok ? sha256Stable(plan) : null,
  };
}

export function findCycle(items: { id: string; dependencies: string[] }[]): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const visit = (id: string): string[] | null => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    if (s === 2) return null;
    state.set(id, 1);
    stack.push(id);
    const item = byId.get(id);
    for (const dep of item?.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      const res = visit(dep);
      if (res) return res;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const item of items) {
    const res = visit(item.id);
    if (res) return res;
  }
  return null;
}

/** 两个工作项的写入范围是否冲突(前缀重叠或文件相同)。 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const na = a.map(norm).filter(Boolean);
  const nb = b.map(norm).filter(Boolean);
  for (const x of na) {
    for (const y of nb) {
      if (x === y) return true;
      if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}
