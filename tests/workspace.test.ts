/**
 * 工作区与权限模式的测试: 用户指定目录、缺失目录拒绝、权限模式传到适配器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { Engine, EngineError } from '../packages/core/src/engine.js';
import { MockAdapter } from '../packages/adapters/src/mock.js';
import type { AdapterId, ExecutionProfile, SandboxMode } from '../packages/contracts/src/types.js';
import type { AdapterHost, AdapterSession, OpenSessionOptions } from '../packages/adapters/src/types.js';

const baseRoot = join(process.cwd(), '.local', 'tmp', `workspace-test-${process.pid}`);
let caseIndex = 0;

function profile(id: string, sandbox: SandboxMode): ExecutionProfile {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    adapterId: 'mock' as AdapterId,
    executableRef: 'mock://x',
    configRefs: {},
    secretRefs: [],
    requestedModel: 'mock-model',
    requestedReasoning: 'medium',
    concurrencyGroup: 'mock',
    enabled: true,
    capabilitySnapshot: null,
    env: {},
    workspaceRoot: null,
    sandbox,
    liveEnabled: true,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setup(sandbox: SandboxMode = 'workspace-write') {
  caseIndex += 1;
  const root = join(baseRoot, `case-${caseIndex}`);
  mkdirSync(root, { recursive: true });
  const db = new Db(join(root, 'test.db'));
  const repo = new Repo(db);
  repo.insertProfile(profile('prof_x', sandbox));
  const seen: OpenSessionOptions[] = [];
  const mock = new MockAdapter();
  const adapter = {
    id: mock.id,
    displayName: mock.displayName,
    mock: mock.mock,
    probe: (p: ExecutionProfile, mode: 'inspect' | 'live') => mock.probe(p, mode),
    capabilities: (p: ExecutionProfile) => mock.capabilities(p),
    async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
      seen.push(opts);
      return mock.openSession(opts, host);
    },
  };
  const engine = new Engine(repo, { paths: { root, dataDir: join(root, 'data') }, adapters: { mock: adapter } });
  return { root, db, repo, engine, seen };
}

test('工作区: 未指定时用任务私有目录, 指定后所有会话都用它', async () => {
  const { root, db, engine, seen } = setup();
  try {
    const custom = join(root, 'custom-ws');
    mkdirSync(custom, { recursive: true });
    const task = engine.createTask({
      title: 't',
      objective: 'o',
      constraints: [],
      strongProfileIds: ['prof_x'],
      leadProfileId: 'prof_x',
      workerProfileIds: [],
      workspace: custom,
    });
    assert.equal(task.workspaceRoot, custom);
    assert.equal(engine.workspaceOf(task), custom);

    engine.requestPlan(task.id, 'initial');
    const deadline = Date.now() + 20_000;
    let latest = engine.snapshot(task.id);
    while (Date.now() < deadline && latest.task.lifecycle !== 'awaiting_plan_approval') {
      await new Promise((r) => setTimeout(r, 100));
      latest = engine.snapshot(task.id);
    }
    assert.equal(latest.task.lifecycle, 'awaiting_plan_approval');
    assert.ok(seen.length >= 1, '至少启动过一个会话');
    for (const opts of seen) {
      assert.ok(
        opts.cwd.startsWith(join(custom, 'planner')) || opts.cwd.startsWith(join(custom, 'worker')),
        `会话 cwd 必须在角色的席位目录下: ${opts.cwd}`,
      );
      assert.ok(existsSync(opts.cwd), '席位小工作区必须已创建');
    }
    assert.ok(existsSync(join(custom, 'planner')), '任务下应有 planner 大工作区');
    assert.ok(existsSync(join(custom, 'worker')), '任务下应有 worker 大工作区');
    assert.ok(existsSync(join(custom, 'deliverables')), '任务下应有统一的 deliverables');
    assert.ok(existsSync(join(custom)), '工作区仍然存在');
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('工作区: 项目外不存在的目录直接报错, 不静默创建', () => {
  const { db, engine } = setup();
  try {
    const outside = join('C:', 'definitely-not-here', 'hh-ws-test');
    assert.throws(
      () =>
        engine.createTask({
          title: 't',
          objective: 'o',
          constraints: [],
          strongProfileIds: ['prof_x'],
          leadProfileId: 'prof_x',
          workerProfileIds: [],
          workspace: outside,
        }),
      (err: unknown) => err instanceof EngineError && err.code === 'workspace_missing',
    );
  } finally {
    db.close();
  }
});

test('权限: 席位默认按角色取权限(强模型完全权限), 可再按席位覆盖', async () => {
  const { root, db, repo, engine, seen } = setup('read-only');
  try {
    const task = engine.createTask({
      title: 't',
      objective: 'o',
      constraints: [],
      strongProfileIds: ['prof_x'],
      leadProfileId: 'prof_x',
      workerProfileIds: [],
    });
    engine.requestPlan(task.id, 'initial');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && seen.length === 0) await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.length >= 1);
    // 席位权限优先于执行配置: 强模型默认完全权限
    assert.equal(seen[0].sandbox, 'danger-full-access');
    const lead = repo.listParticipants(task.id)[0];
    await engine.updateParticipantSettings(task.id, lead.id, { sandbox: 'read-only' });
    seen.length = 0;
    await engine.chatWith(task.id, lead.id, '只回一句话确认收到');
    const t2 = Date.now() + 30_000;
    while (Date.now() < t2 && seen.length === 0) await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.length >= 1);
    assert.equal(seen[0].sandbox, 'read-only', '改成只读后新会话应只读');
    assert.ok(existsSync(join(root, '.local', 'runs', task.id, 'workspace')), '默认工作区仍在任务目录');
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('产物: 自定义工作区里的文件能读到内容', async () => {
  const { root, db, engine } = setup();
  try {
    const custom = join(root, 'art-ws');
    mkdirSync(custom, { recursive: true });
    const task = engine.createTask({
      title: 't',
      objective: 'o',
      constraints: [],
      strongProfileIds: ['prof_x'],
      leadProfileId: 'prof_x',
      workerProfileIds: [],
      workspace: custom,
    });
    engine.requestPlan(task.id, 'initial');
    const deadline = Date.now() + 60_000;
    let latest = engine.snapshot(task.id);
    while (Date.now() < deadline && latest.task.lifecycle !== 'awaiting_plan_approval') {
      await new Promise((r) => setTimeout(r, 120));
      latest = engine.snapshot(task.id);
    }
    const plan = latest.plan!;
    engine.decidePlan(task.id, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash,
      participantsRevision: latest.task.participantsRevision,
      expectedTaskVersion: latest.task.version,
    });
    while (Date.now() < deadline && !['completed', 'failed', 'blocked'].includes(engine.snapshot(task.id).task.lifecycle)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const done = engine.snapshot(task.id);
    assert.equal(done.task.lifecycle, 'completed');
    const artifact = done.artifacts[0];
    assert.ok(artifact);
    const abs = join(custom, artifact.relativePath);
    assert.ok(artifact.relativePath.startsWith('deliverables/'), `产物应在 deliverables 下: ${artifact.relativePath}`);
    assert.ok(existsSync(abs), `产物应落在自定义工作区: ${abs}`);
    assert.ok(readFileSync(abs, 'utf8').length > 0);
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test('席位: 角色默认权限与按席位改工作区', async () => {
  const { root, db, repo, engine, seen } = setup();
  try {
    repo.insertProfile({ ...profile('prof_w', 'workspace-write'), name: 'worker-x', sandbox: 'workspace-write' });
    const custom = join(root, 'seat-ws');
    mkdirSync(custom, { recursive: true });
    const task = engine.createTask({
      title: 't',
      objective: 'o',
      constraints: [],
      strongProfileIds: ['prof_x'],
      leadProfileId: 'prof_x',
      workerProfileIds: ['prof_w'],
      workspace: custom,
    });

    const lead = repo.listParticipants(task.id).find((x) => x.role === 'strong')!;
    const worker = repo.listParticipants(task.id).find((x) => x.role === 'worker')!;
    assert.equal(lead.sandbox, 'danger-full-access', 'planner 默认完全权限');
    assert.equal(worker.sandbox, 'workspace-write', 'worker 默认工作区内可写');
    assert.ok(existsSync(join(custom, 'planner')), 'planner 大工作区存在');
    assert.ok(existsSync(join(custom, 'worker')), 'worker 大工作区存在');
    assert.ok(existsSync(engine.participantWorkspace(task, worker)), 'worker 小工作区存在');

    // 按席位改成只读 + 自定义相对工作区
    await engine.updateParticipantSettings(task.id, worker.id, {
      sandbox: 'read-only',
      workspaceRoot: 'worker/custom-w',
    });
    const updated = repo.getParticipant(worker.id)!;
    assert.equal(updated.sandbox, 'read-only');
    assert.ok(updated.workspaceRoot && updated.workspaceRoot.endsWith(join('worker', 'custom-w')));

    // 直接和这个 worker 对话: 会话会立刻用它自己的 cwd 与权限启动
    seen.length = 0;
    await engine.chatWith(task.id, worker.id, '只回一句话确认收到');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && seen.length === 0) await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.length >= 1, '至少启动过一次会话');
    const workerSession = seen.find((o) => o.participantId === worker.id);
    assert.ok(workerSession, 'worker 应有会话');
    assert.equal(workerSession.sandbox, 'read-only', 'worker 会话应使用席位级权限');
    assert.ok(workerSession.cwd.endsWith(join('worker', 'custom-w')), `worker cwd 应换成席位工作区: ${workerSession.cwd}`);
    for (const opts of seen.filter((o) => o.participantId === lead.id)) {
      assert.equal(opts.sandbox, 'danger-full-access', 'planner 保持角色默认完全权限');
      assert.ok(opts.cwd.startsWith(join(custom, 'planner')), `planner cwd 应在 planner 大工作区: ${opts.cwd}`);
    }
  } finally {
    await engine.shutdown();
    db.close();
  }
});
