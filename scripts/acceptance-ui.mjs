// 界面验收: 用无头 Edge + CDP 打开真实页面, 在页面内做交互断言(不依赖人工点击)。
// 用法: 先 `npm start`(建议 HH_EXIT_WITH_UI=0 常驻), 再 `node scripts/acceptance-ui.mjs`
// 说明: 只读取/创建 mock 任务, 不触发 reveal/open 等真实 shell 弹窗; 结束后删除自己造的任务与归档。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.HH_BASE ?? 'http://127.0.0.1:4310';
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 msedge.exe');

const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ------------------------------ 造两个任务 ------------------------------ */
const profiles = (await j('GET', '/api/profiles')).data;
const mock = profiles.filter((p) => p.adapterId === 'mock' && p.enabled);
if (mock.length < 2) throw new Error('需要至少 2 个启用的 mock 配置');

const mk = async (title, strong, lead, workers) =>
  (
    await j('POST', '/api/tasks', {
      title,
      objective: '验收用: 写一段说明并列出验证点, 说明里要包含可复现性的结论。',
      constraints: ['只写任务工作区'],
      strongProfileIds: strong,
      leadProfileId: lead,
      workerProfileIds: workers,
      idempotencyKey: 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    })
  ).data.task.id;

const planTask = await mk('UI验收: 计划待批准', [mock[0].id], mock[0].id, [mock[1].id]);
await j('POST', `/api/tasks/${planTask}/plan`, { reason: 'initial' });
for (let i = 0; i < 60; i++) {
  const d = (await j('GET', `/api/tasks/${planTask}`)).data;
  if (d?.task?.lifecycle === 'awaiting_plan_approval') break;
  await sleep(1000);
}

const runTask = await mk('UI验收: 已完成', [mock[0].id], mock[0].id, [mock[1].id]);
await j('POST', `/api/tasks/${runTask}/plan`, { reason: 'initial' });
let planDoc = null;
for (let i = 0; i < 60; i++) {
  const d = (await j('GET', `/api/tasks/${runTask}`)).data;
  if (d?.plan?.status === 'proposed' && d?.task?.lifecycle === 'awaiting_plan_approval') {
    planDoc = d;
    break;
  }
  await sleep(1000);
}
if (!planDoc) throw new Error('任务没进入待批准状态');
await j('POST', `/api/tasks/${runTask}/plan-decisions`, {
  decision: 'approve',
  planRevisionId: planDoc.plan.id,
  planHash: planDoc.plan.contentHash,
  participantsRevision: planDoc.task.participantsRevision,
  expectedTaskVersion: planDoc.task.version,
});
let completed = null;
for (let i = 0; i < 120; i++) {
  const d = (await j('GET', `/api/tasks/${runTask}`)).data;
  if (d?.task?.lifecycle === 'completed') {
    completed = d;
    break;
  }
  await sleep(1000);
}
record('准备: 任务跑到已完成', Boolean(completed), completed ? `${completed.artifacts.length} 个产物` : '超时');
const objective = completed?.workItems?.[0]?.goal ?? '';

/* -------------------------------- CDP -------------------------------- */
const port = 9455 + (Date.now() % 200);
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=D:\\1hobby\\.local\\tmp\\edge-ui-acc',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    break;
  } catch {
    await sleep(300);
  }
}
if (!wsUrl) throw new Error('Edge 没起来');

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const target = await send('Target.createTarget', { url: 'about:blank' });
const attach = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
const session = attach.result.sessionId;
await send('Page.enable', {}, session);
await send('Runtime.enable', {}, session);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, session);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session);
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? '') };
  }
  return { value: r.result?.result?.value };
};
const go = async (url, wait = 2600) => {
  await send('Page.navigate', { url }, session);
  await sleep(wait);
};

/* ------------------------- Pass A: 计划待批准 ------------------------- */
await go(`${BASE}/?task=${planTask}`, 3200);
const a = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(t));
  const out = {};
  const labels = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
  out.decisions = ['直接执行', '补充内容', '重新计划'].every((t) => labels.some((l) => l.includes(t)));
  out.stepper = document.querySelectorAll('.cy-steps li').length;
  out.cards = document.querySelectorAll('.cy-card').length;
  out.planGrid = !!document.querySelector('table.plan-grid');
  out.themeBefore = document.documentElement.dataset.theme;
  // 头部有两个图标按钮(通知铃铛在前), 按标题选主题那个
  document.querySelector('button[title^="切换到"]')?.click();
  await sleep(300);
  out.themeAfter = document.documentElement.dataset.theme;
  document.querySelector('button[title^="切换到"]')?.click();
  await sleep(200);

  [...document.querySelectorAll('.dock-tab')].find((b) => (b.textContent || '').includes('事件'))?.click();
  await sleep(500);
  out.eventsTabHasHighWater = (document.querySelector('.dock')?.innerText || '').includes('事件高水位');

  btn('执行配置')?.click();
  await sleep(600);
  out.adapterFixed = !!document.querySelector('.pf-adapter-fixed');
  document.querySelector('.modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(400);
  out.modalClosed = !document.querySelector('.modal');
  return out;
})()`);

if (a.error) record('Pass A 执行', false, a.error);
else {
  const v = a.value;
  record('计划页三个决策按钮', v.decisions);
  record('阶段步进渲染 7 段', v.stepper === 7, 'li=' + v.stepper);
  record('画布卡片渲染', v.cards >= 2, 'cards=' + v.cards);
  record('计划表使用列宽模板(plan-grid)', v.planGrid);
  record('主题可切换', v.themeBefore !== v.themeAfter, v.themeBefore + '→' + v.themeAfter);
  record('事件页签显示高水位', v.eventsTabHasHighWater);
  record('执行配置里适配器只读', v.adapterFixed);
  record('对话框点空白关闭', v.modalClosed);
}

/* -------------------- Pass B: 已完成任务(工作项/产物) -------------------- */
await go(`${BASE}/?task=${runTask}`, 3000);
const b = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const tab = (t) => [...document.querySelectorAll('.dock-tab')].find((x) => (x.textContent || '').trim() === t);
  tab('计划')?.click();
  await sleep(700);
  out.stateDots = document.querySelectorAll('td .state').length;
  out.pillLeft = document.querySelectorAll('table.plan-grid td .chip').length;
  const row = document.querySelector('tr.rowclick');
  out.rowClickable = !!row;
  row?.click();
  await sleep(700);
  const dlg = document.querySelector('.modal');
  out.dialogOpen = !!dlg;
  out.goalLen = (dlg?.querySelector('.wi-goal')?.textContent || '').trim().length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  out.dialogClosedByEsc = !document.querySelector('.modal');

  // token 用量: 任务头 Σ 或席位卡 tokens
  out.headerTokens = /Σ/.test(document.querySelector('.taskbar')?.innerText || '');
  out.seatTokens = /tokens/.test(document.querySelector('.cy-card')?.innerText || '');

  // 产物页
  tab('产物')?.click();
  await sleep(700);
  const rows = [...document.querySelectorAll('.artifact-row')];
  rows[0]?.click();
  await sleep(900);
  const dockText = document.querySelector('.dock')?.innerText || '';
  out.artifactButtons = ['在文件夹中显示', '用默认应用打开', '在新标签打开', '下载'].every((t) => dockText.includes(t));
  out.shortChip = [...document.querySelectorAll('.artifact-row .chip')].some((c) => /^(plain|markdown|word|json|binary|text)/.test((c.textContent || '').trim()));
  out.previewShown = !!document.querySelector('.dock pre, .dock .empty');
  return out;
})()`);

if (b.error) record('Pass B 执行', false, b.error);
else {
  const v = b.value;
  record('状态列改为圆点(无胶囊)', v.stateDots > 0 && v.pillLeft === 0, `dots=${v.stateDots} chips=${v.pillLeft}`);
  record('工作项行可点击', v.rowClickable);
  record('工作项详情弹窗能打开', v.dialogOpen);
  record('详情里显示完整目标文本', v.goalLen >= 8, 'len=' + v.goalLen);
  record('详情弹窗 Esc 可关闭', v.dialogClosedByEsc);
  record('任务头显示 Σ tokens', v.headerTokens);
  record('席位卡显示 tokens', v.seatTokens);
  record('产物按钮齐全', v.artifactButtons);
  record('产物类型标签是短名', v.shortChip);
  record('产物预览区渲染(文本或二进制提示)', v.previewShown);
}

/* -------------------- Pass C: 新建任务对话框(席位工作区/权限) -------------------- */
await go(`${BASE}/`, 2400);
const c = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('新建任务'))?.click();
  await sleep(900);
  const chips = [...document.querySelectorAll('.chk')];
  chips[0]?.click();
  await sleep(200);
  chips[1]?.click();
  await sleep(700);
  out.seatCards = document.querySelectorAll('.seat-card').length;
  const btn = (t, root) => [...(root || document).querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t);
  out.hasWsBtn = !!btn('工作区', document.querySelector('.seat-card'));
  out.hasPermBtn = !!btn('权限', document.querySelector('.seat-card'));
  btn('权限', document.querySelector('.seat-card'))?.click();
  await sleep(400);
  out.permSelect = !!document.querySelector('.seat-panel select');
  document.querySelector('.modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(300);
  out.closed = !document.querySelector('.modal');
  return out;
})()`);

if (c.error) record('Pass C 执行', false, c.error);
else {
  const v = c.value;
  record('新建任务出现按席位的卡片', v.seatCards >= 2, 'cards=' + v.seatCards);
  record('席位有「工作区」按钮', v.hasWsBtn);
  record('席位有「权限」按钮', v.hasPermBtn);
  record('权限面板是三档下拉', v.permSelect);
  record('新建任务对话框点空白关闭', v.closed);
}

/* -------------------- Pass D: 归档面板(只看不删) -------------------- */
// 归档面板要有条目可看: 先把已完成的任务删掉(删除会把它移进归档), 再打开面板。
await j('DELETE', `/api/tasks/${runTask}`);
await sleep(400);
const d = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('归档'))?.click();
  await sleep(900);
  out.items = document.querySelectorAll('.arc-item').length;
  out.hasDeleteBtn = [...document.querySelectorAll('.arc-item button')].some((b) => (b.textContent || '').includes('彻底删除'));
  out.hasClose = [...document.querySelectorAll('.modal button')].some((b) => (b.textContent || '').trim() === '关闭');
  [...document.querySelectorAll('.modal button')].find((b) => (b.textContent || '').trim() === '关闭')?.click();
  await sleep(300);
  out.closed = !document.querySelector('.modal');
  return out;
})()`);
if (d.error) record('Pass D 执行', false, d.error);
else {
  const v = d.value;
  record('归档面板能列出条目', v.items > 0, 'items=' + v.items);
  record('归档条目有「彻底删除」', v.hasDeleteBtn);
  record('归档面板可关闭', v.hasClose && v.closed);
}

ws.close();
edge.kill();

/* -------------------------------- 清理 -------------------------------- */
// 先按标题前缀扫掉历史残留(上一次运行被打断时会留下), 再删本次的两条, 最后复查。
async function sweepLeftovers() {
  const list = (await j('GET', '/api/tasks')).data ?? [];
  for (const t of list) {
    if (!/^验收(取消|工作区) /.test(t.title)) continue;
    await j('DELETE', `/api/tasks/${t.id}`);
    await j('DELETE', `/api/archive/${t.id}`);
  }
}
await sweepLeftovers();
for (const id of [planTask, runTask]) {
  await j('DELETE', `/api/tasks/${id}`);
  await j('DELETE', `/api/archive/${id}`);
}
const left = ((await j('GET', '/api/tasks')).data ?? []).filter((t) => /^验收(取消|工作区) /.test(t.title));
if (left.length > 0) record('清理本次任务的临时数据', false, left.map((t) => t.id).join(','));
else record('清理本次任务的临时数据', true);

const failed = results.filter((r) => !r.ok);
console.log(`\n界面验收: 通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
