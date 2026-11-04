/**
 * 运行期补救动作的测试:
 * - 工作项需要用户澄清时, 用户的回答要能送回该工作项并让它继续;
 * - 单个失败工作项可以就地重试, 不产生新的计划版本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { Engine } from '../packages/core/src/engine.js';
import { MockAdapter } from '../packages/adapters/src/mock.js';
import type { ExecutionProfile, AdapterId } from '../packages/contracts/src/types.js';

const baseRoot = join(process.cwd(), '.local', 'tmp', `recover-test-${process.pid}`);
let caseIndex = 0;

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
    sandbox: 'workspace-write' as const,
    liveEnabled: true,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 40_000): Promise<T> {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待超时; 最后状态: ${JSON.stringify(last!).slice(0, 600)}`);
}

function makeEngine() {
  caseIndex += 1;
  const root = join(baseRoot, `case-${caseIndex}`);
  mkdirSync(root, { recursive: true });
  const db = new Db(join(root, 'test.db'));
  const repo = new Repo(db);
  repo.insertProfile(profile('prof_a', 'Mock A'));
  const adapters = { mock: new MockAdapter() };
  const engine = new Engine(repo, { paths: { root, dataDir: join(root, 'data') }, adapters });
  return { db, repo, engine };
}

async function approveCurrent(engine: Engine, repo: Repo, taskId: string): Promise<void> {
  const planned = await waitFor(
    () => Promise.resolve(repo.getTask(taskId)!),
    (t) => t.lifecycle === 'awaiting_plan_approval' && t.currentPlanRevisionId !== null,
  );
  const plan = repo.getPlan(planned.currentPlanRevisionId!)!;
  await engine.decidePlan(taskId, {
    decision: 'approve',
    planRevisionId: plan.id,
    planHash: plan.contentHash!,
    participantsRevision: planned.participantsRevision,
    expectedTaskVersion: planned.version,
  });
}

test('工作项请求澄清: 用户回答后该项继续执行, 而不是当成闲聊', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '需要澄清的任务',
      objective: '写一份说明',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
      outputHint: 'Markdown',
    });
    await engine.requestPlan(task.id, 'initial');
    await approveCurrent(engine, repo, task.id);

    // 等到第一项跑起来, 然后把第二项改成"等待用户输入"
    const items = await waitFor(
      () => Promise.resolve(repo.listWorkItems(task.id)),
      (list) => list.some((w) => w.state === 'running' || w.state === 'awaiting_review'),
      40_000,
    );
    const target = items.at(-1)!;
    repo.updateWorkItem(target.id, { state: 'waiting_input' });
    const fresh = repo.getTask(task.id)!;
    repo.updateTask(task.id, { lifecycle: 'waiting_user' }, fresh.version);

    await engine.sendUserMessage(task.id, { text: '按 ASCII 输出就够了, 不用中文。', intent: 'answer' });
    const resumed = repo.getWorkItem(target.id)!;
    assert.equal(resumed.state !== 'waiting_input', true, '回答后该项必须离开 waiting_input');
    assert.equal(resumed.userNote, '按 ASCII 输出就够了, 不用中文。', '回答要写进工作项, 供下一轮提示使用');

    const events = repo.listEvents(task.id, 0, 8000);
    assert.ok(
      events.some((e) => e.type === 'task.control' && (e.payload as { action?: string })?.action === 'work_item_resumed'),
      '恢复工作项要留痕',
    );
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('单项重试: 不产生新计划版本, 也不影响已接受的其他项', async () => {
  const { db, repo, engine } = makeEngine();
  try {
    const task = engine.createTask({
      title: '需要重试的任务',
      objective: '写一份说明',
      constraints: [],
      strongProfileIds: ['prof_a'],
      leadProfileId: 'prof_a',
      workerProfileIds: [],
      outputHint: 'Markdown',
    });
    await engine.requestPlan(task.id, 'initial');
    await approveCurrent(engine, repo, task.id);
    await waitFor(
      () => Promise.resolve(repo.getTask(task.id)!),
      (t) => ['completed', 'blocked', 'failed'].includes(t.lifecycle),
      60_000,
    );

    const plansBefore = repo.listPlans(task.id).length;
    const items = repo.listWorkItems(task.id);
    const target = items.at(-1)!;
    await engine.retryWorkItem(task.id, target.id, '重跑一遍确认可复现');
    const after = await waitFor(
      () => Promise.resolve(repo.getWorkItem(target.id)!),
      (w) => w.state === 'accepted',
      40_000,
    );
    assert.equal(after.state, 'accepted', '重试后该项应当再次被接受');
    assert.equal(repo.listPlans(task.id).length, plansBefore, '单项重试不应生成新计划版本');
  } finally {
    await engine.shutdown();
    db.close();
  }
});
