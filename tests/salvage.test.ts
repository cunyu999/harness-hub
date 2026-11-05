import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { Engine } from '../packages/core/src/engine.js';
import { MockAdapter } from '../packages/adapters/src/mock.js';
import type { AdapterHost, AdapterSession, OpenSessionOptions, TurnOutcome, TurnRequest } from '../packages/adapters/src/types.js';
import type { ExecutionProfile } from '../packages/contracts/src/types.js';

/**
 * 复用 MockAdapter 的规划/会话实现, 只把"工作回合"改成: 先把产物写出来, 再返回 prompt_failed。
 * 用来锁住"harness 崩溃但产物齐备且验证通过时, 按产物接受"的兜底逻辑。
 */
class CrashAfterWriteAdapter extends MockAdapter {
  override async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    const inner = await super.openSession(opts, host);
    return {
      ...inner,
      async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
        if (req.kind !== 'work') return inner.sendTurn(req);
        const ctx = req.context as { workItem?: { expectedOutputs?: { relativePath: string }[] } };
        // 按契约, 产物路径相对任务工作区根(HH_WORKSPACE), 交付物统一落在 <base>/deliverables
        const outRoot = String(opts.env.HH_WORKSPACE ?? opts.cwd);
        for (const spec of ctx.workItem?.expectedOutputs ?? []) {
          const abs = join(outRoot, spec.relativePath);
          mkdirSync(join(abs, '..'), { recursive: true });
          writeFileSync(abs, '# 内容\n\n由崩溃适配器写入, 用于验证"产物齐备即接受"。\n', 'utf8');
        }
        return {
          status: 'failed',
          text: '',
          errorClass: 'prompt_failed',
          errorMessage: 'session/prompt 返回空结果(测试模拟)',
          observedModel: 'crash',
          reportedReasoning: null,
          usage: null,
          durationMs: 5,
        };
      },
    };
  }
}

test('harness 崩溃但产物齐备且验证通过时, 按产物接受工作项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hh-salvage-'));
  const dir = join(root, '.local', 'data');
  mkdirSync(dir, { recursive: true });
  const db = new Db(join(dir, 'test.db'));
  const repo = new Repo(db);
  const now = new Date().toISOString();
  const profile: ExecutionProfile = {
    id: 'prof_crash',
    name: 'Crash Profile',
    adapterId: 'mock',
    executableRef: 'mock://crash',
    configRefs: {},
    secretRefs: [],
    requestedModel: 'crash',
    requestedReasoning: 'medium',
    concurrencyGroup: 'crash',
    enabled: true,
    capabilitySnapshot: null,
    env: {},
    workspaceRoot: null,
    sandbox: 'workspace-write',
    liveEnabled: true,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertProfile(profile);

  const engine = new Engine(repo, {
    paths: { root, dataDir: dir },
    adapters: { mock: new CrashAfterWriteAdapter() },
  });

  const task = engine.createTask({
    title: '崩溃兜底测试',
    objective: '写一个文件, 然后 harness 崩掉',
    constraints: [],
    strongProfileIds: [profile.id],
    leadProfileId: profile.id,
    workerProfileIds: [],
  });

  engine.requestPlan(task.id, 'initial');

  const deadline = Date.now() + 25_000;
  let current = engine.snapshot(task.id);
  while (Date.now() < deadline && current.task.lifecycle !== 'awaiting_plan_approval') {
    await new Promise((r) => setTimeout(r, 150));
    current = engine.snapshot(task.id);
  }
  const plan = current.plan;
  assert.ok(plan, `规划回合应产出计划; 当前 ${current.task.lifecycle} ${current.task.errorMessage ?? ''}`);

  engine.decidePlan(task.id, {
    decision: 'approve',
    planRevisionId: plan.id,
    planHash: plan.contentHash,
    participantsRevision: current.task.participantsRevision,
    expectedTaskVersion: current.task.version,
  });

  let item = repo.listWorkItems(task.id)[0];
  const settle = Date.now() + 25_000;
  while (Date.now() < settle && !['accepted', 'failed', 'awaiting_review'].includes(item.state)) {
    await new Promise((r) => setTimeout(r, 200));
    item = repo.listWorkItems(task.id)[0];
  }

  assert.notEqual(item.state, 'failed', `产物齐备时不应被判失败; lastError=${item.lastError ?? ''}`);
  const errors = repo.listEvents(task.id, 0, 500).filter((e) => e.type === 'error.reported');
  assert.ok(
    errors.some((e) => (e.payload as { code?: string })?.code === 'harness_crashed_but_verified'),
    '应记录 harness_crashed_but_verified 事件',
  );

  await engine.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
