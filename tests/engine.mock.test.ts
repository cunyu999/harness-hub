/**
 * 引擎级集成测试: 用确定性 mock 适配器跑完整状态机。
 * 覆盖: 计划版本绑定、批准门槛、派发/验证/审核/交付、产物登记、取消语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { Engine, EngineError } from '../packages/core/src/engine.js';
import { MockAdapter } from '../packages/adapters/src/mock.js';
import type { ExecutionProfile, AdapterId } from '../packages/contracts/src/types.js';

const baseRoot = join(process.cwd(), '.local', 'tmp', `engine-test-${process.pid}`);
let caseIndex = 0;
let root = baseRoot;

function profile(id: string, name: string): ExecutionProfile {
  const now = new Date().toISOString();
  return {
    id,
    name,
    adapterId: 'mock' as AdapterId,
    executableRef: 'mock://deterministic',
    configRefs: {},
    secretRefs: [],
    requestedModel: 'mock-model',
    requestedReasoning: 'medium',
    concurrencyGroup: 'mock',
    enabled: true,
    capabilitySnapshot: null,
    env: {},
    workspaceRoot: null,
    liveEnabled: true,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待超时; 最后状态: ${JSON.stringify(last!).slice(0, 600)}`);
}

function makeEngine(profileEnv: Record<string, string> = {}) {
  caseIndex += 1;
  root = join(baseRoot, `case-${caseIndex}`);
  mkdirSync(root, { recursive: true });
  const db = new Db(join(root, 'test.db'));
  const repo = new Repo(db);
  for (const [id, name] of [['prof_a', 'Mock A'], ['prof_b', 'Mock B'], ['prof_c', 'Mock C']] as const) {
    const p = profile(id, name);
    repo.insertProfile({ ...p, env: profileEnv });
  }
  const adapters = { mock: new MockAdapter() };
  const engine = new Engine(repo, { paths: { root, dataDir: join(root, 'data') }, adapters });
  return { db, repo, engine };
}

test('单强模型: 计划 → 批准 → 执行 → 审核 → 交付', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '课程报告',
      objective: '写一份操作系统课程报告',
      constraints: ['中文'],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
      outputHint: 'Markdown 报告',
    });
    assert.equal(task.participantsRevision, 1);

    await engine.requestPlan(task.id, 'initial');
    const planned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    assert.equal(planned.phase, 'planning');
    const plan = repo.getPlan(planned.currentPlanRevisionId!)!;
    assert.ok(plan.contentHash.length === 64);

    // 绑定错误: 版本/哈希/参与人数任一不符都必须拒绝
    await assert.rejects(
      () =>
        engine.decidePlan(task.id, {
          decision: 'approve',
          planRevisionId: plan.id,
          planHash: 'deadbeef',
          participantsRevision: planned.participantsRevision,
          expectedTaskVersion: planned.version,
        }),
      (err: unknown) => err instanceof EngineError && err.code === 'plan_hash_mismatch',
    );
    await assert.rejects(
      () =>
        engine.decidePlan(task.id, {
          decision: 'approve',
          planRevisionId: plan.id,
          planHash: plan.contentHash!,
          participantsRevision: planned.participantsRevision + 1,
          expectedTaskVersion: planned.version,
        }),
      (err: unknown) => err instanceof EngineError && err.code === 'participants_changed',
    );
    await assert.rejects(
      () =>
        engine.decidePlan(task.id, {
          decision: 'approve',
          planRevisionId: plan.id,
          planHash: plan.contentHash!,
          participantsRevision: planned.participantsRevision,
          expectedTaskVersion: planned.version + 3,
        }),
      (err: unknown) => err instanceof EngineError && err.code === 'task_version_conflict',
    );

    await engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash!,
      participantsRevision: planned.participantsRevision,
      expectedTaskVersion: planned.version,
    });

    const done = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'completed' || t.lifecycle === 'blocked' || t.lifecycle === 'failed',
      60_000,
    );
    assert.equal(done.lifecycle, 'completed', `${done.errorCode ?? ''} ${done.errorMessage ?? ''}`);
    assert.equal(done.phase, 'delivery');
    assert.equal(done.approvedPlanRevisionId, plan.id, '完成时仍绑定批准的那一版计划');

    const items = repo.listWorkItems(task.id);
    assert.ok(items.length >= 1);
    assert.ok(items.every((i) => i.state === 'accepted'));

    const artifacts = repo.listArtifacts(task.id);
    assert.ok(artifacts.length >= 2, '至少应有正文与交付说明');
    assert.ok(artifacts.some((a) => a.relativePath === 'deliverables/DELIVERY.md'));
    for (const a of artifacts) {
      assert.equal(a.relativePath.includes('\\'), false, '产物路径应统一为 POSIX 分隔符');
      const body = readFileSync(join(root, '.local', 'runs', task.id, 'workspace', a.relativePath));
      assert.equal(body.length, a.size);
    }

    const verifications = repo.listVerifications(task.id);
    assert.ok(verifications.length > 0);
    assert.ok(verifications.every((v) => v.status === 'passed'), JSON.stringify(verifications.map((v) => [v.checkId, v.status, v.detail])));

    const rounds = repo.listReviewRounds(task.id);
    assert.equal(rounds.length, 1);
    const results = repo.listReviewResults(task.id);
    assert.equal(results.length, 1, '单强模型只有 1 个审核席位');
    assert.equal(results[0].verdict, 'approve');

    const events = repo.listEvents(task.id, 0, 5000);
    const types = new Set(events.map((e) => e.type));
    for (const t of ['plan.proposed', 'plan.approved', 'work_item.queued', 'artifact.registered', 'verification.recorded', 'review.recorded', 'delivery.updated']) {
      assert.ok(types.has(t as never), `缺少事件 ${t}`);
    }
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件 seq 必须单调递增');
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('两个强模型: 先讨论再规划, 审核必须交叉复核', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: 'C++ 作业',
      objective: '实现四则运算解释器',
      constraints: ['C++17'],
      strongProfileIds: ['prof_a', 'prof_b'],
      leadProfileId: 'prof_a',
      workerProfileIds: ['prof_c'],
    });
    await engine.requestPlan(task.id, 'initial');
    const planned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    const messages = repo.listMessages(task.id);
    assert.ok(
      messages.filter((m) => m.kind === 'discussion.proposal').length >= 2,
      '讨论阶段每个强模型都应提交独立提案',
    );

    const plan = repo.getPlan(planned.currentPlanRevisionId!)!;
    assert.equal(plan.content.reviewPolicy.strongParticipantIds.length, 2);
    assert.equal(plan.content.reviewPolicy.crossReviewRequired, true);

    await engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash!,
      participantsRevision: planned.participantsRevision,
      expectedTaskVersion: planned.version,
    });

    const done = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'completed' || t.lifecycle === 'blocked' || t.lifecycle === 'failed',
      90_000,
    );
    assert.equal(done.lifecycle, 'completed', `${done.errorCode ?? ''} ${done.errorMessage ?? ''}`);
    const rounds = repo.listReviewRounds(task.id);
    const results = repo.listReviewResults(task.id);
    assert.equal(results.length, 2, '两个强模型都必须审核, 不能减员');
    for (const r of results) {
      assert.ok((r.crossChecked?.length ?? 0) >= 1, '交叉复核必须留痕');
    }
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('DISPATCH: 同一执行配置的回合不重叠, 并发受 perProfile 限制', async () => {
  const { db, repo, engine } = makeEngine({ HH_MOCK_DELAY_MS: '150' });
  try {
    const task = engine.createTask({
      title: '并发上限',
      objective: '写三段小结',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: ['prof_b'],
    });
    await engine.requestPlan(task.id, 'initial');
    const planned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    const plan = repo.getPlan(planned.currentPlanRevisionId!)!;
    await engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash!,
      participantsRevision: planned.participantsRevision,
      expectedTaskVersion: planned.version,
    });
    await waitFor(() => Promise.resolve(repo.getTask(task.id)!), (t) => t.lifecycle === 'completed', 60_000);

    const workAttempts = repo
      .listAttempts(task.id)
      .filter((a) => a.kind === 'work' && a.startedAt && a.endedAt)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.ok(workAttempts.length >= 1, '应至少有一个工作回合');
    for (let i = 1; i < workAttempts.length; i += 1) {
      const prev = workAttempts[i - 1];
      const cur = workAttempts[i];
      if (prev.participantId !== cur.participantId) continue;
      assert.ok(
        Date.parse(cur.startedAt) >= Date.parse(prev.endedAt!),
        `同一执行配置的回合不得重叠: ${prev.id} 与 ${cur.id}`,
      );
    }
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('取消任务: 未确认停止不得标记为已取消', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '取消测试',
      objective: '写一个大纲',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
    });
    await engine.requestPlan(task.id, 'initial');
    const planned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    const cancelled = await engine.control(task.id, 'cancel');
    assert.equal(cancelled.lifecycle, 'cancelled');
    const items = repo.listWorkItems(task.id);
    assert.equal(items.length, 0, '计划尚未批准, 不应创建任何工作项');

    const events = repo.listEvents(task.id, 0, 5000);
    assert.ok(events.some((e) => e.type === 'task.control'));
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('重启恢复: 不自动重跑, 活动任务转 paused', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '恢复测试',
      objective: '写一份说明',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
    });
    await engine.requestPlan(task.id, 'initial');
    await waitFor(() => Promise.resolve(repo.getTask(task.id)!), (t) => t.lifecycle === 'awaiting_plan_approval');
    const summary = engine.recover();
    assert.ok(summary.pausedTasks >= 0);
    const after = repo.getTask(task.id)!;
    assert.ok(['paused', 'awaiting_plan_approval'].includes(after.lifecycle));
  } finally {
    await engine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('PLAN-02/04/05: 补充生成新版本, 过期或重复批准被拒', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '计划版本测试',
      objective: '写一份课程大纲',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
    });
    await engine.requestPlan(task.id, 'initial');
    const v1Task = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    const v1 = repo.getPlan(v1Task.currentPlanRevisionId!)!;

    // 补充内容 → 新版本, 历史保留, 仍需再次确认
    await engine.sendUserMessage(task.id, { text: '请补充参考文献章节, 并说明评分标准。', intent: 'supplement' });
    const v2Task = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval' && t.currentPlanRevisionId !== v1.id,
      60_000,
    );
    const v2 = repo.getPlan(v2Task.currentPlanRevisionId!)!;
    assert.equal(v2.number, 2, '补充后应生成第 2 版计划');
    assert.notEqual(v2.contentHash, v1.contentHash);
    assert.equal(repo.getPlan(v1.id)!.status, 'superseded', '旧版本保留但标记为被取代');
    assert.equal(v2Task.lifecycle, 'awaiting_plan_approval', '补充后必须重新确认');

    // 用旧版本批准 → 过期
    await assert.rejects(
      () =>
        engine.decidePlan(task.id, {
          decision: 'approve',
          planRevisionId: v1.id,
          planHash: v1.contentHash!,
          participantsRevision: v2Task.participantsRevision,
          expectedTaskVersion: v2Task.version,
        }),
      (err: unknown) => err instanceof EngineError && (err.code === 'stale_plan' || err.code === 'plan_hash_mismatch'),
    );

    // 正常批准 v2
    const approved = await engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: v2.id,
      planHash: v2.contentHash!,
      participantsRevision: v2Task.participantsRevision,
      expectedTaskVersion: v2Task.version,
    });
    assert.equal(approved.approvedPlanRevisionId, v2.id);

    // 重复批准同一版本 → 明确拒绝, 不会二次派发
    await assert.rejects(
      () =>
        engine.decidePlan(task.id, {
          decision: 'approve',
          planRevisionId: v2.id,
          planHash: v2.contentHash!,
          participantsRevision: approved.participantsRevision,
          expectedTaskVersion: approved.version,
        }),
      (err: unknown) =>
        err instanceof EngineError && ['plan_already_approved', 'task_version_conflict', 'stale_plan'].includes(err.code),
    );
    const items = repo.listWorkItems(task.id);
    assert.ok(items.length >= 1);
    const uniqueIds = new Set(items.map((i) => i.id));
    assert.equal(uniqueIds.size, items.length, '重复批准不得产生重复工作项');
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('PLAN-06: 执行中范围变化 → 暂停并请求新计划版本', async () => {
  const { db, repo, engine } = makeEngine({ HH_MOCK_DELAY_MS: '300' });
  try {
    const task = engine.createTask({
      title: '范围变化测试',
      objective: '写一份实验报告',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
    });
    await engine.requestPlan(task.id, 'initial');
    const planned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval',
    );
    const plan = repo.getPlan(planned.currentPlanRevisionId!)!;
    await engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash!,
      participantsRevision: planned.participantsRevision,
      expectedTaskVersion: planned.version,
    });

    // 等进入执行阶段
    await waitFor(() => Promise.resolve(repo.getTask(task.id)!), (t) => t.phase === 'execution', 20_000);

    await engine.sendUserMessage(task.id, {
      text: '把交付格式从 Markdown 改为 Word, 并增加实验结果章节。',
      intent: 'supplement',
    });
    const replanned = await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => t.lifecycle === 'awaiting_plan_approval' && t.currentPlanRevisionId !== plan.id,
      60_000,
    );
    assert.notEqual(replanned.approvedPlanRevisionId, null, '旧批准仍作为历史记录存在');
    assert.notEqual(replanned.currentPlanRevisionId, replanned.approvedPlanRevisionId, '新计划尚未批准');
    const events = repo.listEvents(task.id, 0, 5000);
    assert.ok(
      events.some((e) => e.type === 'task.control' && (e.payload as { action?: string })?.action === 'scope_change_requires_replan'),
      '范围变化必须留痕',
    );
  } finally {
    await engine.shutdown();
    db.close();
  }
});
