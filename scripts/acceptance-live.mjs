// 真实 harness 端到端(会消耗模型额度): Claude Code 主控 + DeepSeek Harness 执行。
// 用法: 先启动服务, 再 `node scripts/acceptance-live.mjs`
// 环境变量: HH_BASE、HH_LIVE_LEAD(默认 claude-code)、HH_LIVE_WORKER(默认 dsh)
// 断言: 计划被批准 → 执行 → 审核 → 交付; 产物内容与要求完全一致; 全程无失败尝试。
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.HH_BASE ?? 'http://127.0.0.1:4310';
const LEAD_ADAPTER = process.env.HH_LIVE_LEAD ?? 'claude-code';
const WORKER_ADAPTER = process.env.HH_LIVE_WORKER ?? 'dsh';

const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
};

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/**
 * 无人值守地处理原生权限请求。
 * 判据: 同一个任务、请求种类是 permissions、且请求内容里没有 workspace 之外的绝对路径。
 * 只要看不明白就拒绝(宁可任务失败, 也不替用户放开权限)。
 */
async function settleApprovals(taskId, workspaceRoot) {
  const d = (await j('GET', `/api/tasks/${taskId}`)).data;
  const pending = d?.approvalsPending ?? [];
  for (const apv of pending) {
    const detail = apv.detailRedacted ?? '{}';
    const paths = (detail.match(/[A-Za-z]:\\\\[^"',\\s]+/g) ?? []).map((p) => p.replace(/\\\\/g, '\\'));
    const outside = paths.filter((p) => workspaceRoot && !p.toLowerCase().startsWith(workspaceRoot.toLowerCase()));
    const safeKind = apv.kind === 'permissions' || apv.kind === 'tool';
    const decision = safeKind && outside.length === 0 ? 'approve' : 'deny';
    const r = await j('POST', `/api/approvals/${apv.id}/resolve`, {
      decision,
      note: decision === 'approve' ? 'acceptance-live: 工作区内操作, 自动批准' : `acceptance-live: 越界或未知请求(${outside.join(',')})`,
    });
    console.log(`  审批 ${apv.id} → ${decision} (${r.status})`);
  }
}

const profiles = (await j('GET', '/api/profiles')).data ?? [];
const lead = profiles.find((p) => p.adapterId === LEAD_ADAPTER && p.enabled && p.liveEnabled);
const worker = profiles.find((p) => p.adapterId === WORKER_ADAPTER && p.enabled && p.liveEnabled);
if (!lead || !worker) throw new Error(`找不到可用的 live 配置(${LEAD_ADAPTER}/${WORKER_ADAPTER})`);
console.log(`使用配置: 主控=${lead.name} 执行=${worker.name}`);

const want = 'harness-hub live check 2026';
const created = await j('POST', '/api/tasks', {
  title: '真实接入验收: 写一个文件',
  objective: `在当前任务工作区里创建 check.txt, 内容必须恰好是 "${want}"(不含引号, 末尾一个换行可选), 然后用命令行读取它并把读取结果写进 deliverables/check-report.md。不要联网, 不要生成其它文件。`,
  constraints: ['只写任务工作区', '只创建要求的两个文件'],
  strongProfileIds: [lead.id],
  leadProfileId: lead.id,
  workerProfileIds: [worker.id],
  idempotencyKey: 'live-' + Date.now(),
});
const taskId = created.data?.task?.id;
if (!taskId) throw new Error('创建任务失败: ' + created.text);
console.log(`任务 ${taskId} 已创建, 等待计划...`);

await j('POST', `/api/tasks/${taskId}/plan`, { reason: 'initial' });
let planDoc = null;
for (let i = 0; i < 180; i++) {
  const d = (await j('GET', `/api/tasks/${taskId}`)).data;
  if (d?.plan?.status === 'proposed' && d?.task?.lifecycle === 'awaiting_plan_approval') {
    planDoc = d;
    break;
  }
  if (d?.task?.lifecycle === 'failed') break;
  await sleep(2000);
}
record('真实规划产出计划', Boolean(planDoc), planDoc ? `v${planDoc.plan.number}, ${planDoc.plan.content.workItems.length} 个工作项` : '超时/失败');

if (planDoc) {
  const appr = await j('POST', `/api/tasks/${taskId}/plan-decisions`, {
    decision: 'approve',
    planRevisionId: planDoc.plan.id,
    planHash: planDoc.plan.contentHash,
    participantsRevision: planDoc.task.participantsRevision,
    expectedTaskVersion: planDoc.task.version,
  });
  record('批准计划', appr.status === 200, String(appr.status));

  const started = Date.now();
  const workspaceRoot = (await j('GET', `/api/tasks/${taskId}`)).data?.task?.workspaceRoot ?? null;
  let done = null;
  for (let i = 0; i < 600; i++) {
    await settleApprovals(taskId, workspaceRoot);
    const d = (await j('GET', `/api/tasks/${taskId}`)).data;
    if (d?.task?.lifecycle === 'waiting_user') {
      // 工作项要人回答时不该干等: 记下它要什么, 立刻判失败
      const ask = (d.workItems ?? []).find((w) => w.state === 'needs_input');
      done = d;
      record('执行阶段不需要人工介入', false, ask?.lastError ?? '任务进入 waiting_user');
      break;
    }
    if (d?.task?.lifecycle === 'completed' || d?.task?.lifecycle === 'failed' || d?.task?.lifecycle === 'blocked') {
      done = d;
      break;
    }
    await sleep(2000);
  }
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  record('任务跑到终态', Boolean(done), done ? `${done.task.lifecycle} (${minutes} min)` : '超时');
  if (done) {
    record('终态是已完成', done.task.lifecycle === 'completed', done.task.lifecycle + (done.task.errorCode ? ` / ${done.task.errorCode}` : ''));
    const accepted = done.workItems.filter((w) => w.state === 'accepted').length;
    record('工作项全部已接受', accepted === done.workItems.length && accepted > 0, `${accepted}/${done.workItems.length}`);
    const failedAttempts = done.attempts.filter((a) => a.status === 'failed').length;
    record('没有失败的尝试', failedAttempts === 0, `failed=${failedAttempts}`);
    record('有产物登记', done.artifacts.length > 0, `${done.artifacts.length} 个`);

    const check = done.artifacts.find((a) => /check\.txt$/.test(a.relativePath));
    if (check) {
      const body = await fetch(`${BASE}/api/artifacts/${check.id}/content`).then((r) => r.text());
      record('check.txt 内容与要求一致', body.trim() === want, JSON.stringify(body.trim()));
    } else {
      record('check.txt 已登记', false, '没有找到 check.txt');
    }
    const report = done.artifacts.find((a) => /check-report\.md$/.test(a.relativePath));
    record('报告文件已登记', Boolean(report), report?.relativePath ?? '');
    console.log(`用量: Σ ${done.usage.total.total} tokens / ${done.usage.turns} 回合`);
  }
}

// 失败时留下现场: 把详情写到 .local/tmp/live-failure.json, 不删任务(方便复盘), 并打印原因
const failedNow = results.filter((r) => !r.ok);
if (failedNow.length > 0) {
  const dump = (await j('GET', `/api/tasks/${taskId}`)).data;
  try {
    writeFileSync('.local/tmp/live-failure.json', JSON.stringify(dump, null, 2), 'utf8');
  } catch {
    /* 忽略写盘失败 */
  }
  console.log('\n失败现场:');
  for (const w of dump?.workItems ?? []) {
    console.log(`  工作项 ${w.id} state=${w.state} lastError=${w.lastError ?? '-'}`);
    for (const v of w.verification ?? []) console.log(`    验证 ${v.check} → ${v.status} ${v.detail ?? ''}`);
  }
  for (const a of dump?.attempts ?? []) {
    if (a.status !== 'failed') continue;
    console.log(`  失败尝试 ${a.id} kind=${a.kind} error=${a.error ?? '-'}`);
  }
  console.log(`  任务保留: ${taskId} (详情已写到 .local/tmp/live-failure.json)`);
} else {
  // 清理: 删除任务与它的归档
  await j('DELETE', `/api/tasks/${taskId}`);
  await j('DELETE', `/api/archive/${taskId}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n真实任务验收: 通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
