import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
 * 规划回合返回一个带"假通过"验证命令的工作项: 命令输出里有 FINDSTR 报错, 但退出码是 0。
 * 引擎必须把它判成失败, 否则"退出码 0"会让错误的检查结果混过去。
 */
class NoisyValidationAdapter extends MockAdapter {
  override async openSession(opts: OpenSessionOptions, host: AdapterHost): Promise<AdapterSession> {
    const inner = await super.openSession(opts, host);
    const plan = {
      objective: '产生一个产物并做一次假通过的检查',
      constraints: [],
      assumptions: [],
      clarificationNeeded: [],
      workItems: [
        {
          id: 'wi-1',
          goal: '写 deliverables/part-1.md',
          dependencies: [],
          assignedParticipantId: null,
          inputs: [],
          expectedOutputs: [
            {
              label: '第一部分',
              format: 'markdown',
              relativePath: 'deliverables/part-1.md',
              template: null,
              validation: 'exists',
              validationCommand: 'echo FINDSTR: Cannot open World!',
            },
          ],
          acceptanceCriteria: ['文件存在且非空'],
          writeScope: ['deliverables/part-1.md'],
          riskLevel: 'low',
        },
      ],
      deliverables: [
        {
          label: '第一部分',
          format: 'markdown',
          templateRef: null,
          destination: 'deliverables',
          validationMethod: '文件存在且内容非空',
          editableSource: null,
        },
      ],
      verificationSteps: ['检查产物存在'],
      reviewPolicy: { strongParticipantIds: [], crossReviewRequired: false },
      changeScope: '',
      risks: [],
      limits: {},
      unresolvedDecisions: [],
    };
    return {
      ...inner,
      async sendTurn(req: TurnRequest): Promise<TurnOutcome> {
        if (req.kind !== 'plan') return inner.sendTurn(req);
        return { ...(await inner.sendTurn(req)), text: JSON.stringify(plan) };
      },
    };
  }
}

test('验证命令输出命中失败特征时, 即使退出码 0 也不记 passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hh-noise-'));
  const dir = join(root, '.local', 'data');
  mkdirSync(dir, { recursive: true });
  const db = new Db(join(dir, 'test.db'));
  const repo = new Repo(db);
  const now = new Date().toISOString();
  const profile: ExecutionProfile = {
    id: 'prof_noise',
    name: 'Noise Profile',
    adapterId: 'mock',
    executableRef: 'mock://noise',
    configRefs: {},
    secretRefs: [],
    requestedModel: 'noise',
    requestedReasoning: 'medium',
    concurrencyGroup: 'noise',
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

  const engine = new Engine(repo, { paths: { root, dataDir: dir }, adapters: { mock: new NoisyValidationAdapter() } });
  const task = engine.createTask({
    title: '假通过检测',
    objective: '检查命令输出噪声',
    constraints: [],
    strongProfileIds: [profile.id],
    leadProfileId: profile.id,
    workerProfileIds: [],
  });

  engine.requestPlan(task.id, 'initial');
  const deadline = Date.now() + 25_000;
  let snap = engine.snapshot(task.id);
  while (Date.now() < deadline && snap.task.lifecycle !== 'awaiting_plan_approval') {
    await new Promise((r) => setTimeout(r, 150));
    snap = engine.snapshot(task.id);
  }
  const plan = snap.plan;
  assert.ok(plan, `规划应产出计划; ${snap.task.lifecycle} ${snap.task.errorMessage ?? ''}`);
  engine.decidePlan(task.id, {
    decision: 'approve',
    planRevisionId: plan.id,
    planHash: plan.contentHash,
    participantsRevision: snap.task.participantsRevision,
    expectedTaskVersion: snap.task.version,
  });

  const settle = Date.now() + 25_000;
  let checks = repo.listVerifications(task.id);
  while (Date.now() < settle && !checks.some((c) => c.checkId === 'cmd:deliverables/part-1.md')) {
    await new Promise((r) => setTimeout(r, 200));
    checks = repo.listVerifications(task.id);
  }
  const cmdCheck = checks.find((c) => c.checkId === 'cmd:deliverables/part-1.md');
  assert.ok(cmdCheck, '应记录验证项');
  assert.equal(cmdCheck.status, 'failed', '输出含 FINDSTR 报错时不能记 passed');
  assert.match(String(cmdCheck.detail ?? ''), /失败特征/, 'detail 要说明为什么不算通过');

  await engine.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
