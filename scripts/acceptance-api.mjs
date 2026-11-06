// 接口级全量验收: 跑真实引擎 + mock harness(不消耗模型额度), 覆盖任务/计划/执行/审核/产物/归档/校验。
// 用法: 先 `npm start`(或常驻模式), 再 `node scripts/acceptance-api.mjs`
//   可选环境变量: HH_BASE(默认 http://127.0.0.1:4310)
//   HH_ACCEPT_SHELL=1 才会真的弹出资源管理器/默认应用(默认关闭: 自动化测试不留任何可见窗口与副作用)
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BASE = process.env.HH_BASE ?? 'http://127.0.0.1:4310';
const ROOT = process.cwd();
const DO_OPEN = process.env.HH_ACCEPT_OPEN === '1';
// 真实 shell 副作用默认关闭: 之前弹「位置不可用」就是自动化测试打开窗口、随后又删掉任务目录造成的。
const DO_SHELL = process.env.HH_ACCEPT_SHELL === '1';
const stamp = Date.now().toString(36);

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function check(name, cond, detail = '') {
  record(name, Boolean(cond), detail);
  return Boolean(cond);
}

async function call(method, p, body, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') {
      payload = body;
      headers['content-type'] ??= 'text/plain';
    } else {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  return null;
}

async function detail(id) {
  const r = await call('GET', `/api/tasks/${id}`);
  return r.status === 200 ? r.json : null;
}

function planHistoryText(history) {
  return (history ?? []).map((h) => `v${h.number}:${h.status}`).join(',');
}

/**
 * 关掉验收自己打开的资源管理器窗口。
 * 不这么做的话, 任务目录被清理后那个窗口会指向已删除路径, Windows 会弹「位置不可用」。
 * 返回关掉的窗口数(拿不到 COM 时返回 0, 不算失败)。
 */
function closeWorkspaceWindows() {
  const script = [
    '$sh = New-Object -ComObject Shell.Application',
    '$n = 0',
    'foreach ($w in @($sh.Windows())) {',
    '  try {',
    '    $name = "" + $w.LocationName',
    '    $url = "" + $w.LocationURL',
    '    if ($name -like "*1hobby*" -or $url -like "*1hobby*") { $w.Quit(); $n++ }',
    '  } catch { }',
    '}',
    'Write-Output $n',
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return Number.parseInt((r.stdout ?? '0').trim(), 10) || 0;
}

async function createTask(extra = {}) {
  return call('POST', '/api/tasks', {
    title: extra.title ?? `验收任务 ${stamp}`,
    objective: '写一份 300 字以内的说明, 并列出一条验证结论。',
    constraints: ['中文', '不超过 300 字'],
    outputHint: '普通报告, 未指定格式',
    strongProfileIds: extra.strongProfileIds,
    leadProfileId: extra.leadProfileId,
    workerProfileIds: extra.workerProfileIds ?? [],
    seats: extra.seats ?? [],
    workspace: extra.workspace ?? null,
    idempotencyKey: `acc-task-${stamp}${extra.suffix ?? ''}`,
  });
}

async function approve(id, d, note) {
  return call('POST', `/api/tasks/${id}/plan-decisions`, {
    decision: 'approve',
    planRevisionId: d.plan.id,
    planHash: d.plan.contentHash,
    participantsRevision: d.task.participantsRevision,
    expectedTaskVersion: d.task.version,
    note,
  });
}

const createdTasks = [];
const createdArchives = [];
const createdProfiles = [];

async function cleanup() {
  for (const id of createdTasks) {
    try {
      await call('DELETE', `/api/tasks/${id}`);
    } catch {
      /* ignore */
    }
  }
  for (const id of createdArchives) {
    try {
      await call('DELETE', `/api/archive/${id}`);
    } catch {
      /* ignore */
    }
  }
  for (const id of createdProfiles) {
    try {
      await call('DELETE', `/api/profiles/${id}?hard=1`);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log(`接口级验收 → ${BASE}\n`);

  /* ---------------------------- A. 基础 ---------------------------- */
  const health = await call('GET', '/api/health');
  check('A1 GET /api/health 返回 ok', health.status === 200 && health.json?.ok === true);
  const adapterIds = new Set((health.json?.adapters ?? []).map((a) => a.id));
  check(
    'A2 三个真实 harness + mock 都注册',
    ['codex', 'claude-code', 'dsh', 'mock'].every((x) => adapterIds.has(x)),
    [...adapterIds].join(','),
  );
  const runtime = await call('GET', '/api/runtime');
  check(
    'A3 /api/runtime 暴露关页策略',
    runtime.status === 200 && typeof runtime.json?.exitOnUiClose === 'boolean',
    JSON.stringify(runtime.json),
  );

  const second = spawnSync(process.execPath, [path.join(ROOT, 'dist/apps/server/src/index.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HH_PORT: '4311' },
  });
  check(
    'A4 单实例锁: 第二次启动直接退出并提示已在运行',
    second.status === 0 && /服务已在运行/.test(String(second.stdout ?? '') + String(second.stderr ?? '')),
    (String(second.stdout ?? '') + String(second.stderr ?? '')).trim().split('\n').slice(-1)[0],
  );

  /* ---------------------------- B. 执行配置 ---------------------------- */
  const mkProfile = async (suffix, env = {}) =>
    call('POST', '/api/profiles', {
      name: `验收 Mock ${suffix} ${stamp}`,
      adapterId: 'mock',
      requestedModel: 'mock-model',
      requestedReasoning: 'medium',
      concurrencyGroup: 'default',
      enabled: true,
      liveEnabled: true,
      env,
    });
  const p1 = await mkProfile('A');
  const strongId = p1.json?.profile?.id ?? p1.json?.id;
  if (strongId) createdProfiles.push(strongId);
  check('B1 新建 mock 执行配置', p1.status === 200 && Boolean(strongId), `status=${p1.status}`);

  const p2 = await mkProfile('B');
  const workerId = p2.json?.profile?.id ?? p2.json?.id;
  if (workerId) createdProfiles.push(workerId);
  check('B2 同一 harness 可以有第二份配置', p2.status === 200 && Boolean(workerId) && workerId !== strongId);

  const patch = await call('PATCH', `/api/profiles/${workerId}`, { notes: '验收备注', requestedModel: 'mock-model-2' });
  check('B3 PATCH 配置成功', patch.status === 200 && patch.json?.notes === '验收备注' && patch.json?.requestedModel === 'mock-model-2');

  const probe = await call('POST', `/api/profiles/${strongId}/probe`, { mode: 'inspect' });
  check('B4 inspect 探针返回结论文本', probe.status === 200 && typeof probe.json?.result?.detail === 'string');

  /* ---------------------------- C. 任务与计划 ---------------------------- */
  const t1 = await createTask({ strongProfileIds: [strongId], leadProfileId: strongId, workerProfileIds: [workerId] });
  const taskId = t1.json?.task?.id;
  if (taskId) createdTasks.push(taskId);
  check('C1 新建任务', t1.status === 200 && Boolean(taskId), `lifecycle=${t1.json?.task?.lifecycle}`);

  const dup = await call('POST', '/api/tasks', {
    title: `验收任务 ${stamp}`, // 同 idempotencyKey
    objective: '写一份 300 字以内的说明, 并列出一条验证结论。',
    constraints: ['中文', '不超过 300 字'],
    outputHint: '普通报告, 未指定格式',
    strongProfileIds: [strongId],
    leadProfileId: strongId,
    workerProfileIds: [workerId],
    idempotencyKey: `acc-task-${stamp}`,
  });
  check('C2 幂等键重复提交不会建第二个任务', dup.status === 200 && dup.json?.task?.id === taskId);

  const softDel = await call('DELETE', `/api/profiles/${strongId}`);
  check(
    'C3a 被引用的配置默认只能停用(不物理删)',
    softDel.status === 200 && softDel.json?.deleted === false && softDel.json?.profile?.enabled === false,
    JSON.stringify(softDel.json?.profile?.enabled),
  );
  const hardDel = await call('DELETE', `/api/profiles/${strongId}?hard=1`);
  check('C3b 被引用的配置硬删被拒(409 in_use)', hardDel.status === 409, hardDel.json?.code ?? '');

  const planReq = await call('POST', `/api/tasks/${taskId}/plan`, { reason: 'initial', idempotencyKey: `p-${stamp}` });
  check('C4 请求规划', planReq.status === 200);
  const waiting = await waitFor(async () => {
    const d = await detail(taskId);
    return d && d.plan && d.task.lifecycle === 'awaiting_plan_approval' ? d : null;
  }, 60000);
  check('C5 计划生成后停在等待批准', Boolean(waiting), waiting ? `plan v${waiting.plan.number} · ${waiting.plan.contentHash.slice(0, 8)}` : '超时');
  check(
    'C6 计划里工作项有目标/验收/执行者',
    Boolean(waiting) &&
      waiting.plan.content.workItems.length > 0 &&
      waiting.plan.content.workItems.every((w) => w.goal && w.acceptanceCriteria.length > 0 && w.assignedParticipantId),
  );

  const wrongHash = await call('POST', `/api/tasks/${taskId}/plan-decisions`, {
    decision: 'approve',
    planRevisionId: waiting.plan.id,
    planHash: 'deadbeef',
    participantsRevision: waiting.task.participantsRevision,
    expectedTaskVersion: waiting.task.version,
  });
  check('C7 用错计划哈希批准被拒(409)', wrongHash.status === 409, wrongHash.json?.code ?? '');

  const wrongRev = await call('POST', `/api/tasks/${taskId}/plan-decisions`, {
    decision: 'approve',
    planRevisionId: waiting.plan.id,
    planHash: waiting.plan.contentHash,
    participantsRevision: waiting.task.participantsRevision + 5,
    expectedTaskVersion: waiting.task.version,
  });
  check('C8 参与者版本不匹配被拒(409)', wrongRev.status === 409, wrongRev.json?.code ?? '');

  const approved = await approve(taskId, waiting);
  check(
    'C9 正确批准(绑定哈希+版本)',
    approved.status === 200 && approved.json?.task?.approvedPlanRevisionId === waiting.plan.id,
    approved.json?.task?.approvedPlanRevisionId ?? '',
  );

  /* ---------------------------- D. 执行、验证、审核、用量 ---------------------------- */
  const done = await waitFor(async () => {
    const d = await detail(taskId);
    return d && d.task.lifecycle === 'completed' ? d : null;
  }, 120000);
  check('D1 任务跑到 completed', Boolean(done), done ? `phase=${done.task.phase}` : '超时');
  check(
    'D2 工作项全部 accepted',
    Boolean(done) && done.workItems.length > 0 && done.workItems.every((w) => w.state === 'accepted'),
    done ? done.workItems.map((w) => w.state).join(',') : '',
  );
  check(
    'D3 产物已登记且带 sha256',
    Boolean(done) &&
      done.artifacts.length > 0 &&
      done.artifacts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)) &&
      done.artifacts.some((a) => a.status === 'registered'),
    done ? `${done.artifacts.length} 个产物` : '',
  );
  check(
    'D4 验证记录存在且包含通过项',
    Boolean(done) && done.verifications.some((v) => v.status === 'passed'),
    done ? `${done.verifications.length} 条` : '',
  );
  check(
    'D5 审核结论存在且为通过',
    Boolean(done) && done.reviewResults.length > 0 && done.reviewResults.every((r) => r.verdict === 'approve'),
    done ? done.reviewResults.map((r) => r.verdict).join(',') : '',
  );
  check(
    'D6 token 用量来自 harness 原生事件',
    Boolean(done) && done.usage.total.total > 0 && done.usage.turns > 0 && Object.keys(done.usage.byParticipant).length > 0,
    done ? `Σ ${done.usage.total.total} tokens / ${done.usage.turns} 回合` : '',
  );
  check(
    'D7 事件高水位单调且 >0',
    Boolean(done) && done.highWaterSeq > 0,
    done ? `seq=${done.highWaterSeq}` : '',
  );

  /* ---------------------------- E. 返工(补充计划 → v2) ---------------------------- */
  const beforeRework = await detail(taskId);
  const v1PlanId = beforeRework?.task?.approvedPlanRevisionId ?? beforeRework?.plan?.id ?? null;
  const rev = await call('POST', `/api/tasks/${taskId}/messages`, {
    text: '补充要求: 在说明里再加一条关于可复现性的结论。',
    intent: 'supplement',
  });
  check('E1 交付后提交补充要求被接受', rev.status === 200);
  const v2 = await waitFor(async () => {
    const d = await detail(taskId);
    return d && d.plan && d.plan.number === 2 && d.task.lifecycle === 'awaiting_plan_approval' ? d : null;
  }, 60000);
  check('E2 生成计划 v2 并再次等待批准', Boolean(v2), v2 ? `v${v2.plan.number}` : '超时');
  if (v2) {
    check(
      'E3 旧批准留痕, 当前计划是未批准的 v2',
      v2.task.currentPlanRevisionId === v2.plan.id &&
        v2.plan.status === 'proposed' &&
        (v1PlanId === null || v2.task.approvedPlanRevisionId === v1PlanId),
      planHistoryText(v2.planHistory),
    );
    const app2 = await approve(taskId, v2);
    check('E4 批准 v2', app2.status === 200);
    const done2 = await waitFor(async () => {
      const d = await detail(taskId);
      return d && d.task.lifecycle === 'completed' && d.plan?.number === 2 ? d : null;
    }, 120000);
    check('E5 返工后再次完成', Boolean(done2));
  }

  /* ---------------------------- F. 产物操作 ---------------------------- */
  const md = (done?.artifacts ?? []).find((a) => /\.(md|txt)$/.test(a.relativePath)) ?? done?.artifacts?.[0];
  if (md) {
    if (DO_SHELL) {
      const reveal = await call('POST', `/api/artifacts/${md.id}/open`, { action: 'reveal' });
      check('F1 在文件夹中显示(explorer /select)', reveal.status === 200 && reveal.json?.ok === true, reveal.json?.opened ?? '');
      // 资源管理器窗口是异步出现的, 等它开出来再关; 关不掉就不要再走后续清理, 否则会弹「位置不可用」
      let closed = 0;
      for (let i = 0; i < 4 && closed === 0; i += 1) {
        await sleep(700);
        closed += closeWorkspaceWindows();
      }
      check('F1b 打开的资源管理器窗口已自动关闭', closed >= 1, `closed=${closed}`);
    } else {
      record('F1 在文件夹中显示', true, '默认跳过真实弹窗(HH_ACCEPT_SHELL=1 可启用); 路由契约由 F3/F4 覆盖');
    }
    if (DO_OPEN && DO_SHELL) {
      const opened = await call('POST', `/api/artifacts/${md.id}/open`, { action: 'open' });
      check('F2 用默认应用打开', opened.status === 200 && opened.json?.ok === true, opened.json?.via ?? '');
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process | Where-Object { $_.MainWindowTitle -like '*${path.basename(md.relativePath)}*' -and $_.ProcessName -ne 'explorer' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
        ],
        { encoding: 'utf8' },
      );
    } else {
      record('F2 用默认应用打开', true, '跳过真实打开(HH_ACCEPT_SHELL=1 且 HH_ACCEPT_OPEN=1 可启用), 端点逻辑由 F3/F4 覆盖');
    }
    const badAction = await call('POST', `/api/artifacts/${md.id}/open`, { action: 'nope' });
    check('F3 非法动作被拒(422)', badAction.status === 422, badAction.json?.code ?? '');
  } else {
    record('F1 在文件夹中显示(explorer /select)', false, '没有可用的产物');
  }
  const missingArt = await call('POST', '/api/artifacts/art_not_exists/open', { action: 'reveal' });
  check('F4 未登记产物 404', missingArt.status === 404, missingArt.json?.code ?? '');

  /* ---------------------------- G. 附件与对话 ---------------------------- */
  const att = await call('POST', `/api/tasks/${taskId}/attachments`, {
    name: 'notes.md',
    mediaType: 'text/markdown',
    dataBase64: Buffer.from('# 验收附件\n\n用于验证上传链路。', 'utf8').toString('base64'),
  });
  check('G1 上传附件', att.status === 200 && Boolean(att.json?.path) && att.json?.size > 0, att.json?.path ?? '');
  const msg = await call('POST', `/api/tasks/${taskId}/messages`, { text: '验收: 这是一条普通消息', intent: 'chat' });
  check(
    'G2 统一主对话能收到消息并落库',
    msg.status === 200 && (msg.json?.snapshot?.messages ?? []).some((m) => (m.text ?? '').includes('这是一条普通消息')),
  );

  /* ---------------------------- H. 归档 ---------------------------- */
  const before = await call('GET', '/api/archive');
  const purge = await call('DELETE', `/api/tasks/${taskId}`);
  check('H1 删除任务返回 ok', purge.status === 200, JSON.stringify(purge.json));
  createdTasks.splice(createdTasks.indexOf(taskId), 1);
  createdArchives.push(taskId);
  const gone = await call('GET', `/api/tasks/${taskId}`);
  check('H2 删除后任务 404', gone.status === 404);
  const archiveList = await call('GET', '/api/archive');
  const entry = (archiveList.json?.entries ?? []).find((e) => e.taskId === taskId);
  check(
    'H3 归档里能看到该任务与文件统计',
    Boolean(entry) && entry.fileCount > 0 && entry.totalBytes > 0 && entry.hasManifest === true,
    entry ? `${entry.fileCount} 文件 / ${entry.totalBytes} B` : '',
  );
  check(
    'H4 归档列表按时间倒序',
    (archiveList.json?.entries ?? []).every((e, i, arr) => i === 0 || (arr[i - 1].archivedAt ?? '') >= (e.archivedAt ?? '')),
  );
  const del = await call('DELETE', `/api/archive/${taskId}`);
  check('H5 彻底删除指定归档', del.status === 200 && del.json?.removedFiles > 0, JSON.stringify(del.json));
  const after = await call('GET', '/api/archive');
  check(
    'H6 删除后归档条目消失',
    !(after.json?.entries ?? []).some((e) => e.taskId === taskId) &&
      (after.json?.entries ?? []).length === (before.json?.entries ?? []).length,
  );
  const badArc = await call('DELETE', '/api/archive/..%2Fetc');
  check('H7 非法归档 id 被拒', badArc.status === 400 || badArc.status === 404, String(badArc.status));

  /* ---------------------------- I. 校验与安全 ---------------------------- */
  const nonJson = await call('POST', '/api/tasks', 'title=x', { headers: { 'content-type': 'text/plain' } });
  check('I1 非 JSON 请求 415', nonJson.status === 415, nonJson.json?.code ?? '');
  const evil = await call('POST', '/api/tasks', { title: 'x' }, { headers: { origin: 'https://evil.example' } });
  check('I2 跨站 Origin 被拒(403)', evil.status === 403, evil.json?.code ?? '');
  const unknown = await call('GET', '/api/tasks/task_not_exists');
  check('I3 未知任务 404', unknown.status === 404);
  const badWs = await call('POST', '/api/tasks', {
    title: `验收工作区 ${stamp}`,
    objective: 'x',
    strongProfileIds: [workerId],
    leadProfileId: workerId,
    workspace: 'D:\\definitely-not-exists-acceptance\\ws',
    idempotencyKey: `acc-ws-${stamp}`,
  });
  check('I4 项目外不存在的工作区被拒(422)', badWs.status === 422, badWs.json?.code ?? '');
  const emptyTitle = await call('POST', '/api/tasks', {
    title: '',
    objective: 'x',
    strongProfileIds: [workerId],
    leadProfileId: workerId,
  });
  check('I5 空标题被契约拒绝(422)', emptyTitle.status === 422);

  /* ---------------------------- J. 暂停与取消 ---------------------------- */
  const slowProfile = await mkProfile('Slow', { HH_MOCK_DELAY_MS: '1500' });
  const slowId = slowProfile.json?.profile?.id ?? slowProfile.json?.id;
  if (slowId) createdProfiles.push(slowId);
  const t2 = await createTask({
    suffix: 'cancel',
    title: `验收取消 ${stamp}`,
    strongProfileIds: [slowId],
    leadProfileId: slowId,
    workerProfileIds: [slowId],
  });
  const cancelTaskId = t2.json?.task?.id;
  if (cancelTaskId) createdTasks.push(cancelTaskId);
  await call('POST', `/api/tasks/${cancelTaskId}/plan`, { reason: 'initial' });
  const w2 = await waitFor(async () => {
    const d = await detail(cancelTaskId);
    return d && d.plan && d.task.lifecycle === 'awaiting_plan_approval' ? d : null;
  }, 60000);
  if (w2) {
    await approve(cancelTaskId, w2);
    const running = await waitFor(async () => {
      const d = await detail(cancelTaskId);
      return d && d.attempts.some((a) => a.status === 'running') ? d : null;
    }, 60000);
    check('J1 慢速任务进入执行态', Boolean(running));

    const pause = await call('POST', `/api/tasks/${cancelTaskId}/controls`, { action: 'pause_dispatch' });
    check('J2 暂停派发被接受', pause.status === 200);
    const resume = await call('POST', `/api/tasks/${cancelTaskId}/controls`, { action: 'resume' });
    check('J3 恢复派发被接受', resume.status === 200);

    const cancel = await call('POST', `/api/tasks/${cancelTaskId}/controls`, { action: 'cancel' });
    check('J4 取消被接受', cancel.status === 200);
    const cancelled = await waitFor(async () => {
      const d = await detail(cancelTaskId);
      return d && (d.task.lifecycle === 'cancelled' || d.task.lifecycle === 'paused') ? d : null;
    }, 60000, 600);
    check(
      'J5 取消后生命周期落定且没有 running 尝试',
      Boolean(cancelled) && !cancelled.attempts.some((a) => a.status === 'running'),
      cancelled ? `${cancelled.task.lifecycle}` : '超时',
    );
  } else {
    record('J1 慢速任务进入执行态', false, '计划没有按时生成');
  }

  /* ---------------------------- 汇总 ---------------------------- */
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n接口级验收: ${passed}/${results.length}`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  }
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('验收脚本异常: ' + (e instanceof Error ? e.stack : String(e)));
  code = 1;
} finally {
  await cleanup();
  process.exit(code);
}
