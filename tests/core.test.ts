import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeRelPath, safeJoin, isInside, PathSafetyError } from '../packages/core/src/util.js';
import { validatePlan, findCycle, scopesOverlap } from '../packages/core/src/plan.js';
import { selectDispatchable, executionSettled } from '../packages/core/src/scheduler.js';
import { DEFAULT_LIMITS, type Participant, type TaskRecord, type WorkItemState } from '../packages/contracts/src/types.js';

const root = mkdtempSync(join(tmpdir(), 'hh-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_t',
    title: 't',
    objective: 'o',
    constraints: [],
    phase: 'planning',
    lifecycle: 'active',
    currentPlanRevisionId: null,
    approvedPlanRevisionId: null,
    participantsRevision: 1,
    version: 1,
    limits: DEFAULT_LIMITS,
    workspaceRoot: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...over,
  };
}

function participant(id: string, role: 'strong' | 'worker'): Participant {
  return {
    id,
    taskId: 'task_t',
    profileId: `prof_${id}`,
    profileSnapshotId: `snap_${id}`,
    role,
    displayName: id,
    isLead: role === 'strong',
    allowedPhases: role === 'strong' ? ['planning', 'discussion', 'integration', 'review', 'delivery'] : ['execution', 'verification'],
    createdAt: new Date().toISOString(),
  };
}

test('normalizeRelPath 统一分隔符并折叠冗余段', () => {
  assert.equal(normalizeRelPath('deliverables\\part-1.md'), 'deliverables/part-1.md');
  assert.equal(normalizeRelPath('./a//b/../c'), 'a/b/../c');
  assert.equal(normalizeRelPath('  x/y.md '), 'x/y.md');
});

test('safeJoin 拒绝越界路径', () => {
  assert.equal(safeJoin(root, 'a/b.md'), join(root, 'a/b.md'));
  for (const bad of ['', '..', '../x', '/abs', 'C:/x', '\\\\server\\share', 'a/../../b']) {
    assert.throws(() => safeJoin(root, bad), PathSafetyError, `应当拒绝: ${bad}`);
  }
});

test('isInside 只认目录前缀', () => {
  assert.equal(isInside(root, join(root, 'a')), true);
  assert.equal(isInside(root, root + '-evil'), false);
  assert.equal(isInside(root, 'D:/other'), false);
});

test('findCycle 检测环', () => {
  assert.deepEqual(
    findCycle([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ]),
    ['a', 'b', 'a'],
  );
  assert.equal(
    findCycle([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: [] },
    ]),
    null,
  );
});

test('scopesOverlap 按路径前缀判断写入冲突', () => {
  assert.equal(scopesOverlap(['src/'], ['src/main.cpp']), true);
  assert.equal(scopesOverlap(['src/'], ['docs/']), false);
});

const planCtx = () => ({
  task: task(),
  participants: [participant('strong-a', 'strong'), participant('strong-b', 'strong'), participant('worker-a', 'worker')],
  limits: DEFAULT_LIMITS,
  workspaceRoot: root,
  outputDir: join(root, 'deliverables'),
});

function rawPlan(over: Record<string, unknown> = {}) {
  return {
    objective: '写一份报告',
    constraints: [],
    assumptions: [],
    clarificationNeeded: [],
    workItems: [
      {
        id: 'wi-1',
        goal: '写正文',
        dependencies: [],
        assignedParticipantId: 'worker-a',
        inputs: [],
        expectedOutputs: [
          { label: '正文', format: 'markdown', relativePath: 'deliverables/body.md', validation: 'nonempty' },
        ],
        acceptanceCriteria: ['正文非空'],
        writeScope: ['deliverables/body.md'],
        riskLevel: 'low',
      },
    ],
    deliverables: [],
    verificationSteps: [],
    reviewPolicy: { strongParticipantIds: [], crossReviewRequired: true },
    changeScope: '',
    risks: [],
    limits: {},
    unresolvedDecisions: [],
    ...over,
  };
}

test('validatePlan 接受合法计划并强制全部强模型参与审核', () => {
  const r = validatePlan(rawPlan(), planCtx());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.plan!.reviewPolicy.strongParticipantIds.sort(), ['strong-a', 'strong-b']);
  assert.equal(r.plan!.reviewPolicy.crossReviewRequired, true);
  assert.ok(r.contentHash && r.contentHash.length === 64);
});

test('validatePlan 拒绝越界写入与自造执行者', () => {
  const escape = validatePlan(
    rawPlan({
      workItems: [
        {
          ...(rawPlan().workItems as Record<string, unknown>[])[0],
          writeScope: ['../outside'],
          expectedOutputs: [{ label: 'x', format: 'markdown', relativePath: '../outside.md', validation: 'none' }],
        },
      ],
    }),
    planCtx(),
  );
  assert.equal(escape.ok, false);
  assert.ok(escape.errors.some((e) => /路径|越界|拒绝/.test(e)), escape.errors.join('; '));

  const unknown = validatePlan(
    rawPlan({
      workItems: [
        { ...(rawPlan().workItems as Record<string, unknown>[])[0], assignedParticipantId: 'ghost' },
      ],
    }),
    planCtx(),
  );
  assert.equal(unknown.ok, false, '未选参与者必须报错, 不能悄悄换人');
  assert.ok(unknown.errors.some((e) => /未选参与者/.test(e)), unknown.errors.join('; '));
  assert.equal(unknown.plan, null, '非法计划不会被采纳, 因而不存在"被换人"后的计划');
});

test('validatePlan 检测依赖环并限制工作项数量', () => {
  const base = (rawPlan().workItems as Record<string, unknown>[])[0];
  const cyc = validatePlan(
    rawPlan({
      workItems: [
        { ...base, id: 'a', dependencies: ['b'] },
        { ...base, id: 'b', dependencies: ['a'], expectedOutputs: [{ label: 'x', format: 'markdown', relativePath: 'deliverables/b.md', validation: 'none' }] },
      ],
    }),
    planCtx(),
  );
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some((e) => /循环|环/.test(e)), cyc.errors.join('; '));

  const many = Array.from({ length: DEFAULT_LIMITS.maxWorkItems + 1 }, (_, i) => ({
    ...base,
    id: `w${i}`,
    expectedOutputs: [{ label: 'x', format: 'markdown', relativePath: `deliverables/${i}.md`, validation: 'none' }],
  }));
  const tooMany = validatePlan(rawPlan({ workItems: many }), planCtx());
  assert.equal(tooMany.ok, false);
});

function item(id: string, over: Partial<{ state: WorkItemState; dependencies: string[]; writeScope: string[]; participantId: string }> = {}) {
  return {
    id,
    state: (over.state ?? 'pending') as WorkItemState,
    dependencies: over.dependencies ?? [],
    writeScope: over.writeScope ?? [`out/${id}`],
    participantId: over.participantId ?? 'worker-a',
    profileId: `prof_${over.participantId ?? 'worker-a'}`,
    riskLevel: 'low',
  };
}
test('selectDispatchable 遵守依赖与并发上限', () => {
  const r = selectDispatchable({
    items: [item('a'), item('b', { dependencies: ['a'] }), item('c', { participantId: 'worker-b' })],
    active: [],
    limits: { ...DEFAULT_LIMITS, workerParallelism: 2 },
  });
  assert.deepEqual(r.start.sort(), ['a', 'c']);
  assert.equal(r.deadlocked.length, 0);

  const waiting = selectDispatchable({
    items: [item('a', { state: 'running' }), item('b', { dependencies: ['a'] })],
    active: [{ itemId: 'a', profileId: 'prof_worker-a', writeScope: ['out/a'] }],
    limits: DEFAULT_LIMITS,
  });
  assert.equal(waiting.start.length, 0);
  assert.equal(waiting.waiting.length, 1);
});

test('selectDispatchable 串行化写入范围重叠的工作项', () => {
  const r = selectDispatchable({
    items: [item('a'), item('b', { writeScope: ['out/a'], participantId: 'worker-b' })],
    active: [],
    limits: DEFAULT_LIMITS,
  });
  assert.deepEqual(r.start, ['a']);
});

test('selectDispatchable 在依赖失败时判定死锁', () => {
  const r = selectDispatchable({
    items: [item('a', { state: 'failed' }), item('b', { dependencies: ['a'] })],
    active: [],
    limits: DEFAULT_LIMITS,
  });
  assert.equal(r.start.length, 0);
  assert.equal(r.deadlocked.length, 1);
});

test('selectDispatchable 每配置并发上限为 1', () => {
  const r = selectDispatchable({
    items: [item('a'), item('b'), item('c', { participantId: 'worker-b' })],
    active: [{ itemId: 'x', profileId: 'prof_worker-a', writeScope: ['other/'] }],
    limits: { ...DEFAULT_LIMITS, workerParallelism: 4 },
  });
  assert.deepEqual(r.start, ['c']);
});

test('executionSettled 只认终态或待审核', () => {
  assert.equal(executionSettled([{ state: 'awaiting_review' }, { state: 'accepted' }]), true);
  assert.equal(executionSettled([{ state: 'awaiting_review' }, { state: 'running' }]), false);
});

test('写文件工具函数在临时目录内可用', () => {
  const p = safeJoin(root, 'a/b.md');
  writeFileSync(join(root, 'a-marker.txt'), 'x');
  assert.ok(p.endsWith('b.md'));
});
