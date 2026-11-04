/**
 * 提示词的硬性约束: 这两条是真实 E2E 换来的教训, 不能悄悄丢。
 * - 只读复核项必须被告知"不要重新执行, 依据验证记录";
 * - 计划阶段必须知道 validationCommand 在 Windows 的 cmd 里怎么跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanPrompt, buildWorkPrompt, buildReviewPrompt, type PromptEnv } from '../packages/core/src/prompts.js';
import { DEFAULT_LIMITS } from '../packages/contracts/src/types.js';
import type { Participant, PlanWorkItem, TaskRecord, PlanContent, ExecutionProfile } from '../packages/contracts/src/types.js';

const now = new Date().toISOString();

const task = {
  id: 'task_test',
  title: '测试任务',
  objective: '写点东西',
  constraints: [],
  phase: 'planning',
  lifecycle: 'active',
  version: 1,
  participantsRevision: 1,
  limits: DEFAULT_LIMITS,
  currentPlanRevisionId: null,
  approvedPlanRevisionId: null,
  errorCode: null,
  errorMessage: null,
  workspaceRoot: null,
  createdAt: now,
  updatedAt: now,
} as unknown as TaskRecord;

const participant = {
  id: 'part_a',
  taskId: task.id,
  profileId: 'prof_a',
  displayName: 'Mock A',
  adapterId: 'mock',
  role: 'strong',
  isLead: true,
  allowedPhases: ['planning', 'execution', 'review'],
  createdAt: now,
} as unknown as Participant;

const env: PromptEnv = {
  task,
  participants: [participant],
  limits: DEFAULT_LIMITS,
  workspaceRoot: process.cwd(),
  outputDir: 'deliverables',
  sandbox: 'workspace-write',
};

function item(withOutputs: boolean): PlanWorkItem {
  return {
    id: 'wi-1',
    goal: '写 hello.cpp',
    dependencies: [],
    assignedParticipantId: participant.id,
    inputs: [],
    expectedOutputs: withOutputs
      ? [
          {
            label: '源码',
            format: 'cpp',
            relativePath: 'hello.cpp',
            template: null,
            validation: 'exists' as const,
            validationCommand: null,
          },
        ]
      : [],
    acceptanceCriteria: ['能编译'],
    writeScope: ['hello.cpp'],
    riskLevel: 'medium',
  };
}

test('计划提示: 明确 validationCommand 在 Windows cmd 下的写法', () => {
  const built = buildPlanPrompt(env, 'plan');
  assert.match(built.text, /cmd\.exe \/d \/s \/c/, '要说清用哪个 shell 跑验证命令');
  assert.match(built.text, /findstr/, '要给出 Windows 上可用的文本匹配方式');
  assert.match(built.text, /不要写/, '要提醒不要写 ./x 这种 Unix 路径');
});

test('工作项提示: 只读复核项不得要求重新执行', () => {
  const reviewItem = buildWorkPrompt(env, item(false), {});
  assert.match(reviewItem.text, /只读复核/, '没有输出产物的工作项应当被告知这是只读复核');
  assert.match(reviewItem.text, /依据.*验证记录|验证记录/, '要说明判据是验证记录');
  assert.match(reviewItem.text, /不是 needs_input 的理由/, '环境限制不应导致卡住');

  const writeItem = buildWorkPrompt(env, item(true), {});
  assert.doesNotMatch(writeItem.text, /只读复核/, '有产物的工作项不该套用复核纪律');
});

test('审核提示: 环境限制不构成审核阻塞', () => {
  const plan = {
    objective: '写点东西',
    constraints: [],
    assumptions: [],
    clarificationNeeded: null,
    workItems: [item(true)],
    deliverables: [],
    verificationSteps: [],
    reviewPolicy: { strongParticipantIds: [participant.id], crossReviewRequired: false },
    changeScope: [],
    risks: [],
    limits: DEFAULT_LIMITS,
    unresolvedDecisions: [],
  } as unknown as PlanContent;
  const built = buildReviewPrompt(env, participant, {
    plan,
    artifacts: [],
    verifications: [],
    round: 1,
    mode: 'initial',
  });
  assert.match(built.text, /环境限制/, '要说明沙箱/权限拒绝不算审核阻塞');
  assert.match(built.text, /unable_to_review/, '要说清什么情况才用 unable_to_review');
});
