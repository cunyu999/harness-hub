/**
 * HTTP 层验收: 安全边界、错误体、SSE、幂等、版本冲突。
 * 只使用 mock 适配器, 不调用任何真实模型。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { MockAdapter } from '../packages/adapters/src/mock.js';
import { Engine } from '../packages/core/src/engine.js';
import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { loadConfig } from '../apps/server/src/config.js';
import { ApiServer } from '../apps/server/src/http.js';
import { nowIso } from '../packages/core/src/util.js';

const baseRoot = join(process.cwd(), '.local', 'tmp', `http-test-${process.pid}`);

async function boot() {
  const root = join(baseRoot, randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });
  const db = new Db(join(root, 'test.db'));
  const repo = new Repo(db);
  const now = nowIso();
  repo.insertProfile({
    id: 'prof_mock',
    name: 'Mock A',
    adapterId: 'mock',
    executableRef: '',
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
  });
  const engine = new Engine(repo, { paths: { root, dataDir: join(root, 'data') }, adapters: { mock: new MockAdapter() } });
  const cfg = loadConfig({ root, port: 0, host: '127.0.0.1' });
  const api = new ApiServer(repo, engine, cfg, { mock: new MockAdapter() });
  await api.start();
  const addr = api.listenAddress();
  assert.ok(addr, '服务应已监听');
  const base = `http://127.0.0.1:${addr.port}`;
  return { db, repo, engine, api, base, root };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json };
}

async function rawRequest(
  base: string,
  headers: Record<string, string>,
  method: string,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method, path, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('SECURITY-01: 只接受本机 Host, 写请求校验 Origin 与 Content-Type', async () => {
  const { db, engine, api, base } = await boot();
  try {
    // 正常健康检查
    const health = await call(base, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal((health.json as { ok: boolean }).ok, true);

    // 非本机 Host(fetch 不允许覆盖 Host, 这里用 http.request 直接发)
    const badHost = await rawRequest(base, { host: 'evil.example.com' }, 'GET', '/api/health');
    assert.equal(badHost.status, 403);
    assert.equal((badHost.json as { code: string }).code, 'forbidden_host');

    // 跨站 Origin
    const badOrigin = await call(base, 'POST', '/api/tasks', { title: 'x' }, { origin: 'https://evil.example.com' });
    assert.equal(badOrigin.status, 403);
    assert.equal((badOrigin.json as { code: string }).code, 'forbidden_origin');

    // 非 JSON 写请求
    const res = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    assert.equal(res.status, 415);
    const body = (await res.json()) as { code: string; correlationId: string };
    assert.equal(body.code, 'unsupported_media_type');
    assert.ok(body.correlationId, '错误体必须带 correlationId');
  } finally {
    await engine.shutdown();
    await api.stop();
    db.close();
  }
});

test('API: 校验错误返回 422, 未知路由 404, 未知产物 404', async () => {
  const { db, engine, api, base } = await boot();
  try {
    const invalid = await call(base, 'POST', '/api/tasks', { title: '' });
    assert.equal(invalid.status, 422);
    assert.equal((invalid.json as { code: string }).code, 'validation_failed');

    const notFound = await call(base, 'GET', '/api/tasks/task_missing');
    assert.equal(notFound.status, 404);

    const artifact = await call(base, 'GET', '/api/artifacts/art_missing/content');
    assert.equal(artifact.status, 404, '产物接口只接受登记 ID, 不接受任意路径');
  } finally {
    await engine.shutdown();
    await api.stop();
    db.close();
  }
});

test('PLAN-03/05: 计划批准绑定版本与哈希, 过期版本 409', async () => {
  const { db, repo, engine, api, base } = await boot();
  try {
    const created = await call(base, 'POST', '/api/tasks', {
      title: '绑定校验',
      objective: '写一份说明',
      constraints: [],
      strongProfileIds: ['prof_mock'],
      leadProfileId: 'prof_mock',
      workerProfileIds: [],
      idempotencyKey: 'bind-1',
    });
    assert.ok(created.status === 200 || created.status === 201, `建任务状态码应为 2xx, 实际 ${created.status}`);
    const taskId = (created.json as { task: { id: string } }).task.id;

    // 同一幂等键重复创建不产生新任务
    const again = await call(base, 'POST', '/api/tasks', {
      title: '绑定校验',
      objective: '写一份说明',
      constraints: [],
      strongProfileIds: ['prof_mock'],
      leadProfileId: 'prof_mock',
      workerProfileIds: [],
      idempotencyKey: 'bind-1',
    });
    assert.equal((again.json as { task: { id: string } }).task.id, taskId, '幂等键必须复用同一任务');

    await call(base, 'POST', `/api/tasks/${taskId}/plan`, { reason: 'initial' });
    type Snap = {
      task: { lifecyle?: string; lifecycle: string; version: number; participantsRevision: number; currentPlanRevisionId: string | null };
      plan: { id: string; contentHash: string } | null;
    };
    let snapshot: Snap | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res = await call(base, 'GET', `/api/tasks/${taskId}`);
      snapshot = res.json as Snap;
      if (snapshot?.task.lifecycle === 'awaiting_plan_approval' && snapshot.plan) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(snapshot?.plan, '应生成计划');
    const plan = snapshot!.plan!;

    // 哈希不匹配
    const badHash = await call(base, 'POST', `/api/tasks/${taskId}/plan-decisions`, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: 'deadbeef',
      participantsRevision: snapshot!.task.participantsRevision,
      expectedTaskVersion: snapshot!.task.version,
    });
    assert.equal(badHash.status, 409);
    assert.equal((badHash.json as { code: string }).code, 'plan_hash_mismatch');

    // 任务版本过期
    const stale = await call(base, 'POST', `/api/tasks/${taskId}/plan-decisions`, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash,
      participantsRevision: snapshot!.task.participantsRevision,
      expectedTaskVersion: snapshot!.task.version - 1,
    });
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { code: string }).code, 'task_version_conflict');

    // 正确批准
    const ok = await call(base, 'POST', `/api/tasks/${taskId}/plan-decisions`, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash,
      participantsRevision: snapshot!.task.participantsRevision,
      expectedTaskVersion: snapshot!.task.version,
    });
    assert.equal(ok.status, 200);

    // 重复批准同一版本
    const dup = await call(base, 'POST', `/api/tasks/${taskId}/plan-decisions`, {
      decision: 'approve',
      planRevisionId: plan.id,
      planHash: plan.contentHash,
      participantsRevision: snapshot!.task.participantsRevision,
      expectedTaskVersion: (ok.json as { task: { version: number } }).task.version,
    });
    assert.equal(dup.status, 409);
    assert.equal((dup.json as { code: string }).code, 'plan_already_approved');
    assert.equal(repo.listWorkItems(taskId).length > 0, true);
  } finally {
    await engine.shutdown();
    await api.stop();
    db.close();
  }
});

test('SSE: 先发快照, 事件带 seq; 过旧游标要求重同步', async () => {
  const { db, engine, api, base } = await boot();
  try {
    // 先制造一些事件, 让被测任务的 minSeq 明显大于 1(否则无法构造"游标过旧")
    const warmup = await call(base, 'POST', '/api/tasks', {
      title: '预热',
      objective: '占位',
      constraints: [],
      strongProfileIds: ['prof_mock'],
      leadProfileId: 'prof_mock',
      workerProfileIds: [],
    });
    const warmupId = (warmup.json as { task: { id: string } }).task.id;
    await call(base, 'POST', `/api/tasks/${warmupId}/plan`, { reason: 'initial' });
    await new Promise((r) => setTimeout(r, 600));

    const created = await call(base, 'POST', '/api/tasks', {
      title: 'SSE 测试',
      objective: '写一句话',
      constraints: [],
      strongProfileIds: ['prof_mock'],
      leadProfileId: 'prof_mock',
      workerProfileIds: [],
    });
    const taskId = (created.json as { task: { id: string } }).task.id;
    await call(base, 'POST', `/api/tasks/${taskId}/plan`, { reason: 'initial' });

    const controller = new AbortController();
    const res = await fetch(`${base}/api/tasks/${taskId}/events?after=0`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes('event: snapshot') && buffer.includes('event: plan.proposed')) break;
    }
    controller.abort();
    assert.match(buffer, /event: snapshot/, '连接建立后先推送快照');
    assert.match(buffer, /highWaterSeq/, '快照包含 highWaterSeq');
    assert.match(buffer, /id: \d+/, '业务事件以 seq 作为 SSE id');
    assert.match(buffer, /event: plan\.proposed/);

    // 一次性回放
    const replay = await call(base, 'GET', `/api/tasks/${taskId}/events?format=json`);
    assert.equal(replay.status, 200);
    const payload = replay.json as { events: { seq: number; type: string }[]; highWaterSeq: number };
    assert.ok(payload.events.length > 0);
    assert.equal(payload.events[0].seq <= payload.highWaterSeq, true);

    // 过旧游标 → 要求重新同步而不是静默补齐
    const firstSeq = payload.events[0].seq;
    const staleAfter = Math.max(1, firstSeq - 5);
    const staleController = new AbortController();
    const staleRes = await fetch(`${base}/api/tasks/${taskId}/events?after=${staleAfter}`, {
      headers: { accept: 'text/event-stream' },
      signal: staleController.signal,
    });
    const staleReader = staleRes.body!.getReader();
    let staleBuffer = '';
    const staleDeadline = Date.now() + 10_000;
    while (Date.now() < staleDeadline) {
      const chunk = await staleReader.read();
      if (chunk.done) break;
      staleBuffer += decoder.decode(chunk.value, { stream: true });
      if (staleBuffer.includes('resync_required')) break;
    }
    staleController.abort();
    assert.match(staleBuffer, /resync_required/, '游标过旧必须要求重新同步');
  } finally {
    await engine.shutdown();
    await api.stop();
    db.close();
  }
});

test('PROFILE: 可新增/删除执行配置; 被任务引用过的只能停用', async () => {
  const { db, engine, api, base } = await boot();
  try {
    // 新增一份未被引用的配置 → 可物理删除
    const created = await call(base, 'POST', '/api/profiles', {
      name: '临时配置',
      adapterId: 'mock',
      executableRef: '',
      requestedModel: 'mock-model',
    });
    assert.equal(created.status, 200);
    const tempId = (created.json as { id: string }).id;
    const list = await call(base, 'GET', '/api/profiles');
    const temp = (list.json as { id: string; usage?: number }[]).find((p) => p.id === tempId);
    assert.ok(temp, '新增的配置应出现在列表里');
    assert.equal(temp.usage, 0);

    // 浏览器发 DELETE 不会带 Content-Type, 这里必须放行
    const removed = await rawRequest(base, {}, 'DELETE', `/api/profiles/${tempId}?hard=1`);
    assert.equal(removed.status, 200);
    assert.equal((removed.json as { deleted: boolean }).deleted, true);
    const afterRemove = await call(base, 'GET', '/api/profiles');
    assert.equal((afterRemove.json as { id: string }[]).some((p) => p.id === tempId), false);

    // 被任务引用的配置: 物理删除 409, 默认删除退化为停用
    const task = await call(base, 'POST', '/api/tasks', {
      title: '引用配置的任务',
      objective: '验证删除保护',
      constraints: [],
      strongProfileIds: ['prof_mock'],
      leadProfileId: 'prof_mock',
      workerProfileIds: [],
      idempotencyKey: `profile-usage-${Date.now()}`,
    });
    assert.equal(task.status, 200);

    const blocked = await call(base, 'DELETE', `/api/profiles/prof_mock?hard=1`);
    assert.equal(blocked.status, 409);
    assert.equal((blocked.json as { code: string }).code, 'profile_in_use');

    const soft = await call(base, 'DELETE', '/api/profiles/prof_mock');
    assert.equal(soft.status, 200);
    assert.equal((soft.json as { deleted: boolean }).deleted, false);
    const softProfile = (soft.json as { profile: { enabled: boolean } }).profile;
    assert.equal(softProfile.enabled, false, '默认删除只停用, 保留历史可追溯');
  } finally {
    await engine.shutdown();
    await api.stop();
    db.close();
  }
});

test.after(() => {
  rmSync(baseRoot, { recursive: true, force: true });
});
