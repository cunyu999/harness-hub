/**
 * 各阶段的提示构造。真实 harness 读取同一段文本; 结构化上下文只作为参考信息。
 * 指令中明确: 只写 workspace 内且只写本工作项的 writeScope。
 */
import type { ArtifactRevision, Participant, PlanContent, PlanWorkItem, TaskRecord, TaskLimits, VerificationResult } from '../../contracts/src/types.js';
import type { TurnKind } from '../../adapters/src/types.js';
import { buildPrompt, type BuiltPrompt } from '../../adapters/src/envelope.js';
import { truncate, unique } from './util.js';

export interface PromptEnv {
  task: TaskRecord;
  participants: Participant[];
  limits: TaskLimits;
  workspaceRoot: string;
  outputDir: string;
  /** 本次会话的权限模式, 由执行配置决定。 */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** 本次会话自己的工作目录(席位小工作区); 为空表示就是 workspaceRoot。 */
  sessionCwd?: string;
}

const PLAN_SCHEMA = `{
  "objective": string,
  "constraints": string[],
  "assumptions": string[],
  "clarificationNeeded": string[],
  "workItems": [{
    "id": string,                       // 短标识, 如 wi-1
    "goal": string,
    "dependencies": string[],           // 其他 workItem id, 必须无环
    "assignedParticipantId": string,    // 必须是下方 participants 中的 id
    "inputs": string[],
    "expectedOutputs": [{
      "label": string,
      "format": string,                 // 例如 markdown / docx / cpp / pdf
      "relativePath": string,           // 相对 workspace 根目录的安全路径
      "template": string|null,
      "validation": "exists"|"nonempty"|"command"|"none",
      "validationCommand": string|null
    }],
    "acceptanceCriteria": string[],     // 至少一条, 可被检查
    "writeScope": string[],             // 本项允许写入的相对路径前缀
    "riskLevel": "low"|"medium"|"high"
  }],
  "deliverables": [{"label": string, "format": string, "templateRef": string|null,
                    "destination": string, "validationMethod": string, "editableSource": string|null}],
  "verificationSteps": string[],
  "reviewPolicy": {"strongParticipantIds": string[], "crossReviewRequired": boolean},
  "changeScope": string,
  "risks": string[],
  "limits": {},
  "unresolvedDecisions": string[]
}`;

function participantTable(participants: Participant[]): string {
  return participants
    .map(
      (p) =>
        `- id=${p.id} name="${p.displayName}" role=${p.role}${p.isLead ? ' (主控)' : ''}`,
    )
    .join('\n');
}

function commonContext(env: PromptEnv, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: {
      id: env.task.id,
      title: env.task.title,
      objective: env.task.objective,
      constraints: env.task.constraints,
    },
    participants: env.participants.map((p) => ({
      id: p.id,
      name: p.displayName,
      role: p.role,
      isLead: p.isLead,
      profileId: p.profileId,
    })),
    workspace: {
      root: env.workspaceRoot,
      outputDir: env.outputDir,
      rule: '只能写 workspace.root 内的文件; 不得访问或修改其外部路径。',
    },
    limits: env.limits,
    ...extra,
  };
}

const SANDBOX_TEXT: Record<string, string> = {
  'read-only': '只读: 不允许修改任何文件, 需要落盘的内容请在结果里说明, 由主控处理。',
  'workspace-write': '可写工作区: 只能改工作区内的文件, 越界写会被适配器拒绝或要求人工批准。',
  'danger-full-access': '完全权限: 技术上可写工作区之外, 但**仍然只准改工作区**, 越界属于违规。',
};

/**
 * 验证命令的执行环境说明。真实 E2E 里计划给出了 `grep ...` 与 `./hello.exe`,
 * 在 Windows 的 cmd 下分别报"不是内部或外部命令", 导致整个任务卡在验证阶段。
 */
export const VALIDATION_SHELL_NOTE = `validationCommand 的执行环境:
- 在任务 workspace 根目录执行, 由程序调用系统外壳: Windows 是 \`cmd.exe /d /s /c\`, 类 Unix 是 \`/bin/sh -c\`。
- Windows 上没有 \`grep/sed/awk/cat\`; 要匹配文本用 \`findstr /c:"...\`\`\` 或用 powershell。
- Windows 上不要写 \`./hello.exe\`, 会被归一成 \`.\\hello.exe\`, 直接写 \`hello.exe\` 或 \`.\\hello.exe\`。
- 命令必须不交互, 退出码 0 才算通过; 需要多条命令时用 \`&&\` 串联或写成脚本文件。
- 只读复核类工作项不需要重新编译/执行, 用已登记产物与验证记录核对即可。`;

/**
 * 只读复核类工作项(没有声明文件产物)的纪律。
 * 真实 E2E 里复核席位因为"沙箱里执行二进制失败"直接返回 needs_input, 把任务拖死;
 * 这里明确告诉它: 复核的依据是产物与验证记录, 不是"我也跑一遍"。
 */
export const REVIEW_ONLY_RULE = `本项是只读复核: 不要重新编译、不要重新执行二进制, 也不要修改任何文件。
判据按顺序:
  a. 产物是否存在、内容是否满足验收标准(直接读文件);
  b. 程序记录里的验证项是否通过(verification 记录带命令与退出码);
  c. 产物 sha256 与记录是否一致。
如果你确实尝试执行命令但环境不允许(沙箱/权限拒绝, 常见 exit 127 或空输出), 把该检查记为 skipped 并在 summary 里写"未重新执行, 依据程序验证记录", 然后照常给出结论; 环境限制不是 needs_input 的理由。
`;

/** 工作区 + 权限模式说明, 每个回合按实际工作区求值。 */
function workspaceRules(env: PromptEnv): string {
  const base = env.workspaceRoot;
  const cwd = env.sessionCwd ?? base;
  const deliverables = `${base}/deliverables`;
  return `工作区规则:
1. 任务工作区根 = ${base}; 你本次的工作目录(cwd) = ${cwd}。
   交付物必须写到 ${deliverables} 下(用绝对路径写), 不要写到 cwd 里就当成交付物。
   产物引用(artifactRefs)一律用**相对任务工作区根**的路径, 例如 "deliverables/hello.cpp"。
   不得写系统目录、用户主目录或其他项目。
   本次会话权限: ${SANDBOX_TEXT[env.sandbox ?? 'workspace-write']}
2. 只写你被指派工作项的 writeScope 与 expectedOutputs 路径, 不要修改其他并行工作项的产物。
3. 不要执行网络上传、发布、删除用户原始数据等操作; 需要时在结果中说明。
4. 完成后按结果契约输出 JSON, 不要用自然语言声称"已通过"而没有实际文件或命令证据。`;
}

export function buildPlanPrompt(
  env: PromptEnv,
  kind: Extract<TurnKind, 'plan' | 'plan.synthesize'>,
  extra: Record<string, unknown> = {},
): BuiltPrompt {
  const instruction = `你是本次任务的${kind === 'plan' ? '规划者' : '主控(负责综合)'}。
请为下述任务生成一份可执行计划, 只输出一个 JSON 对象, 不要输出其他文字。

必须遵守:
- 计划必须是通用任务计划, 不要把任务硬编码成"报告模式"或"代码模式"。
- 输出格式优先级: 用户本次明确要求 > 用户模板/评分要求 > 项目约定 > 你提出的默认值。未指定格式的普通报告才建议可编辑 Word。
- 工作项数量不超过 ${env.limits.maxWorkItems} 项; 每项必须有可检查的验收标准。
- 依赖必须无环; 同一文件不要交给两个并行工作项同时写入。
- 只能指派给 participants 中列出的 id。
- reviewPolicy.strongParticipantIds 必须包含全部强模型席位。
- 如果 context 里 revisionMode 为 true, 说明这是用户对**已交付成果**提出修改后的修订轮:
  - 只改用户点名或确实不达标的部分; context.existingArtifacts 里没有被点名的文件必须原样保留(同路径、不重写)。
  - 新计划要能独立执行, 但不要推翻已经通过的内容; 在 objectives/assumptions 里写清"这次改了什么、为什么"。
  - 可以在 goal 里引用已有产物的路径作为输入。
- ${VALIDATION_SHELL_NOTE}

计划 JSON 结构:
${PLAN_SCHEMA}

${workspaceRules(env)}`;

  return buildPrompt({
    kind,
    taskId: env.task.id,
    expectsJson: true,
    context: commonContext(env, { outputDirHint: env.outputDir, ...extra }),
    instruction,
  });
}

export function buildDiscussionProposalPrompt(
  env: PromptEnv,
  self: Participant,
  extra: Record<string, unknown> = {},
): BuiltPrompt {
  const instruction = `你是强模型席位「${self.displayName}」。现在进入多强模型讨论的第一阶段: 独立提出候选计划。
其他席位也在独立作答, 你看不到他们的答案, 请给出你自己的判断, 不要假设别人会补充。

请只输出一个 JSON 对象:
{
  "summary": string,                  // 你的方案要点
  "assumptions": string[],
  "approach": string[],
  "workItems": [{ "id": string, "goal": string, "dependencies": string[], "suggestedAssigneeId": string|null, "outputs": string[], "acceptanceCriteria": string[] }],
  "deliverables": [{ "label": string, "format": string, "destination": string }],
  "risks": string[],
  "openQuestions": string[],
  "disagreementsExpected": string[]
}

要求: 说明你对约束、依赖、验收和备选方案的具体判断; 不要只重复任务原文。`;

  return buildPrompt({
    kind: 'discussion.proposal',
    taskId: env.task.id,
    expectsJson: true,
    context: commonContext(env, { self, outputDirHint: env.outputDir, ...extra }),
    instruction,
  });
}

export function buildDiscussionCritiquePrompt(
  env: PromptEnv,
  self: Participant,
  proposals: { participantId: string; name: string; text: string }[],
  extra: Record<string, unknown> = {},
): BuiltPrompt {
  const instruction = `你是强模型席位「${self.displayName}」。现在是相互质询阶段。下面是其他席位(以及你自己)的候选方案。
请只输出一个 JSON 对象:
{
  "critiques": [{"targetParticipantId": string, "point": string, "severity": "blocker"|"major"|"minor", "evidence": string}],
  "agreements": string[],
  "disagreements": string[],
  "revisionSuggestions": string[],
  "mustResolveBeforeExecution": string[]
}

要求: 针对约束、依赖、验收、风险与备选方案提出具体意见; 不要空泛赞同或互相称赞。
若你认为某方案的关键假设不成立, 指出它会导致什么验收问题。`;

  return buildPrompt({
    kind: 'discussion.critique',
    taskId: env.task.id,
    expectsJson: true,
    context: commonContext(env, {
      self,
      proposals: proposals.map((p) => ({
        participantId: p.participantId,
        name: p.name,
        text: truncate(p.text, 6000),
      })),
      ...extra,
    }),
    instruction,
  });
}

export function buildWorkPrompt(
  env: PromptEnv,
  item: PlanWorkItem,
  contextPack: Record<string, unknown>,
): BuiltPrompt {
  const userNoteBlock = contextPack.userNote
    ? '4. 上一轮你请求用户澄清, 用户回答: "' + String(contextPack.userNote) + '" —— 按这个回答继续完成本项, 不要再重复提问。\n'
    : '';
  const outputs = item.expectedOutputs
    .map((o) => `- ${o.relativePath} (${o.format}); 校验: ${o.validation}${o.validationCommand ? ` [${o.validationCommand}]` : ''}`)
    .join('\n');
  const instruction = `你被指派执行工作项「${item.goal}」。

要求:
1. 直接在工作区完成实际工作并写入下列产物(相对 workspace 根目录):
${outputs || '- (本项没有声明文件产物, 请在结果中说明实际完成内容)'}
2. 允许写入范围: ${item.writeScope.join(', ') || '(仅输出文件)'}
${item.expectedOutputs.length === 0 ? REVIEW_ONLY_RULE : ''}
3. 验收标准:
${item.acceptanceCriteria.map((c) => `   - ${c}`).join('\n')}
${userNoteBlock}5. 完成后只输出一个 JSON 对象:
{
  "workItemId": "${item.id}",
  "attemptId": string|null,
  "status": "completed"|"needs_input"|"blocked"|"failed",
  "summary": string,
  "artifactRefs": string[],           // 实际写出的相对路径
  "changes": string[],
  "verificationClaims": [{"check": string, "status": "passed"|"failed"|"skipped", "evidenceRef": string|null}],
  "unresolvedIssues": string[],
  "suggestedNextAction": string|null
}

${workspaceRules(env)}`;

  return buildPrompt({
    kind: 'work',
    taskId: env.task.id,
    workItemId: item.id,
    expectsJson: true,
    context: commonContext(env, {
      workItem: {
        id: item.id,
        goal: item.goal,
        expectedOutputs: item.expectedOutputs,
        acceptanceCriteria: item.acceptanceCriteria,
        writeScope: item.writeScope,
        inputs: item.inputs,
        dependencies: item.dependencies,
      },
      ...contextPack,
    }),
    instruction,
  });
}

export function buildReviewPrompt(
  env: PromptEnv,
  self: Participant,
  args: {
    plan: PlanContent;
    artifacts: ArtifactRevision[];
    verifications: VerificationResult[];
    round: number;
    others?: { participantId: string; name: string; summary: string; findings: unknown[] }[];
    mode: 'initial' | 'crosscheck';
  },
): BuiltPrompt {
  const artifactLines = args.artifacts
    .map((a) => `- ${a.relativePath} (${a.mediaType}, ${a.size} bytes, sha256=${a.sha256.slice(0, 12)}…)`)
    .join('\n');
  const verificationLines = args.verifications
    .map((v) => `- [${v.status}] ${v.checkId} (${v.method}) ${v.detail}`)
    .join('\n');
  const othersBlock =
    args.mode === 'crosscheck' && args.others
      ? `其他席位的审核摘要与问题:\n${args.others
          .map((o) => `### ${o.name}\n${truncate(o.summary, 2000)}\nfindings: ${truncate(JSON.stringify(o.findings), 3000)}`)
          .join('\n\n')}`
      : '';

  const instruction = `你是强模型席位「${self.displayName}」。请基于同一产物集合审核整体需求满足情况。
直接读取工作区中的实际文件与验证证据, 不要只相信执行者的摘要。

产物集合:
${artifactLines || '(无登记产物)'}

程序验证记录:
${verificationLines || '(无)'}

${othersBlock}

请只输出一个 JSON 对象:
{
  "verdict": "approve"|"changes_required"|"needs_user_decision"|"unable_to_review",
  "summary": string,
  "findings": [{"id": string, "severity": "blocker"|"major"|"minor"|"info", "title": string,
                "detail": string, "evidenceRef": string|null, "suggestedFix": string|null}],
  "crossChecked": [{"findingId": string, "stance": "agree"|"disagree"|"cannot_verify", "note": string}]
}

判定规则:
- 只有实际检查过必要内容才可 approve; 无法访问产物时用 unable_to_review。
- 有 blocker/major 问题时用 changes_required, 并给出可执行的修复方向。
- 正确性/验收冲突等重大分歧用 needs_user_decision。
- 环境限制(沙箱/权限不允许执行某个命令)不构成审核阻塞: 用已登记产物 + 程序验证记录判断即可, 只有"产物缺失或无法读取"才用 unable_to_review。
- Windows 上如果要自己跑命令, 用 cmd /c "相对路径"(Claude Code 的 Bash 是 Git Bash, 反斜杠路径会 127)。`;

  return buildPrompt({
    kind: args.mode === 'crosscheck' ? 'review.crosscheck' : 'review',
    taskId: env.task.id,
    expectsJson: true,
    context: commonContext(env, {
      self,
      plan: {
        objective: args.plan.objective,
        deliverables: args.plan.deliverables,
        verificationSteps: args.plan.verificationSteps,
        workItems: args.plan.workItems.map((i) => ({ id: i.id, goal: i.goal, acceptanceCriteria: i.acceptanceCriteria })),
      },
      artifacts: args.artifacts.map((a) => ({ path: a.relativePath, sha256: a.sha256, size: a.size })),
      reviewRound: args.round,
    }),
    instruction,
  });
}

export function buildIntegrationPrompt(
  env: PromptEnv,
  plan: PlanContent,
  artifacts: ArtifactRevision[],
  outcomes: { goal: string; summary: string; status: string }[],
): BuiltPrompt {
  const instruction = `你是主控(集成者)。所有工作项已产出, 请检查整体一致性并给出集成结论。
产物:
${artifacts.map((a) => `- ${a.relativePath}`).join('\n') || '(无)'}

工作项结果:
${outcomes.map((o) => `- [${o.status}] ${o.goal}: ${truncate(o.summary, 300)}`).join('\n') || '(无)'}

请只输出一个 JSON 对象:
{"status": "completed"|"needs_fix", "summary": string, "issues": [{"workItemId": string, "issue": string}]}`;

  return buildPrompt({
    kind: 'integrate',
    taskId: env.task.id,
    expectsJson: true,
    context: commonContext(env, { plan, artifactPaths: artifacts.map((a) => a.relativePath), outcomes }),
    instruction,
  });
}

export function buildDeliveryPrompt(
  env: PromptEnv,
  plan: PlanContent,
  artifacts: ArtifactRevision[],
  reviews: { verdict: string; summary: string }[],
  verifications: VerificationResult[],
  acceptedLimitations: string | null,
): BuiltPrompt {
  const instruction = `你是主控。任务已完成验证与审核, 请生成给用户的最终交付说明(中文, Markdown 文本, 不要输出 JSON)。
必须包含: 交付物清单及用途、验证结果、审核结论、已知限制与未验证项、下一步建议。
不要声称未实际检查的事情; 未验证项要明确写"未验证"。`;

  return buildPrompt({
    kind: 'deliver',
    taskId: env.task.id,
    expectsJson: false,
    context: commonContext(env, {
      plan,
      artifacts: artifacts.map((a) => ({ path: a.relativePath, size: a.size })),
      reviews,
      verifications: verifications.map((v) => ({ check: v.checkId, status: v.status, detail: v.detail })),
      acceptedLimitations,
    }),
    instruction,
  });
}

export function participantSummary(participants: Participant[]): string {
  return participantTable(participants);
}

export function uniquePaths(paths: string[]): string[] {
  return unique(paths);
}
