/**
 * HTTP + SSE 服务。
 *
 * 设计约束:
 * - 只监听 127.0.0.1, 校验 Host / Origin, 不暴露到局域网;
 * - 所有视图数据来自 SQLite 与事件表, 不额外调用模型;
 * - SSE 以事件 seq 作为 id, 支持 Last-Event-ID / after 断线续传;
 * - 写请求支持 idempotencyKey, 重复提交返回首次结果。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import {
  ApprovalResolveSchema,
  CreateTaskSchema,
  PlanDecisionSchema,
  PlanRequestSchema,
  ProbeRequestSchema,
  ProfileCreateSchema,
  ProfilePatchSchema,
  ParticipantSettingsSchema,
  TaskControlSchema,
  TaskMessageSchema,
  type ArtifactDto,
  type ProfileDto,
  type SessionDto,
  type TaskListItem,
} from '../../../packages/contracts/src/api.js';
import type { EventEnvelope, TaskSnapshot } from '../../../packages/contracts/src/events.js';
import { EngineError, type Engine } from '../../../packages/core/src/engine.js';
import { isInside, mediaTypeFor, newId, nowIso } from '../../../packages/core/src/util.js';
import type { Repo } from '../../../packages/storage/src/repo.js';
import type { HarnessAdapter } from '../../../packages/adapters/src/types.js';
import type { AppConfig } from './config.js';
import { preparePrivateHome } from './homes.js';
import type { RuntimeControl } from './runtime-control.js';

const HANDLED = Symbol('handled');

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  correlationId: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class ApiServer {
  private readonly routes: Route[] = [];
  private server: http.Server | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly engine: Engine,
    private readonly cfg: AppConfig,
    private readonly adapters: Record<string, HarnessAdapter>,
    private readonly runtime?: RuntimeControl,
  ) {
    this.register();
  }

  /* ------------------------------ routing ------------------------------ */

  private add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private register(): void {
    this.add('GET', '/api/health', () => this.health());
    this.add('GET', '/api/runtime', () => this.runtimeStatus());
    this.add('POST', '/api/runtime/heartbeat', () => this.runtimeHeartbeat());
    this.add('POST', '/api/runtime/close-intent', () => this.runtimeCloseIntent());
    this.add('GET', '/api/profiles', () => this.listProfiles());
    this.add('POST', '/api/profiles', (ctx) => this.createProfile(ctx));
    this.add('PATCH', '/api/profiles/:id', (ctx) => this.patchProfile(ctx));
    this.add('DELETE', '/api/profiles/:id', (ctx) => this.deleteProfile(ctx));
    this.add('POST', '/api/profiles/:id/probe', (ctx) => this.probeProfile(ctx));
    this.add('GET', '/api/adapters', () => this.listAdapters());

    this.add('GET', '/api/tasks', () => this.listTasks());
    this.add('POST', '/api/tasks', (ctx) => this.createTask(ctx));
    this.add('GET', '/api/tasks/:id', (ctx) => this.getTask(ctx));
    this.add('DELETE', '/api/tasks/:id', (ctx) => this.purgeTask(ctx));
    this.add('GET', '/api/tasks/:id/events', (ctx) => this.streamEvents(ctx));
    this.add('POST', '/api/tasks/:id/plan', (ctx) => this.requestPlan(ctx));
    this.add('POST', '/api/tasks/:id/plan-decisions', (ctx) => this.decidePlan(ctx));
    this.add('POST', '/api/tasks/:id/messages', (ctx) => this.postMessage(ctx));
    this.add('POST', '/api/tasks/:id/controls', (ctx) => this.control(ctx));
    this.add('POST', '/api/tasks/:id/work-items/:itemId/retry', (ctx) => this.retryWorkItem(ctx));
    this.add('PATCH', '/api/tasks/:id/participants/:participantId', (ctx) => this.patchParticipant(ctx));
    this.add('GET', '/api/tasks/:id/artifacts', (ctx) => this.listArtifacts(ctx));
    this.add('GET', '/api/tasks/:id/reviews', (ctx) => this.getReviews(ctx));

    this.add('GET', '/api/sessions/:id', (ctx) => this.getSession(ctx));
    this.add('POST', '/api/sessions/:id/cancel', (ctx) => this.cancelSession(ctx));

    this.add('GET', '/api/approvals/:id', (ctx) => this.getApproval(ctx));
    this.add('POST', '/api/approvals/:id/resolve', (ctx) => this.resolveApproval(ctx));
    this.add('GET', '/api/artifacts/:id/content', (ctx) => this.artifactContent(ctx));
  }

  /* ------------------------------- server ------------------------------ */

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** 实际监听地址(测试用 port=0 时取真实端口)。 */
  listenAddress(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  address(): string {
    const live = this.listenAddress();
    return `http://${this.cfg.host}:${live?.port ?? this.cfg.port}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const correlationId = newId('req');
    res.setHeader('X-Correlation-Id', correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const host = (req.headers.host ?? '').toLowerCase();
    if (!this.isLocalHost(host)) {
      this.json(res, 403, { code: 'forbidden_host', message: `只接受本机访问, 收到 Host=${host}`, correlationId });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !this.isAllowedOrigin(origin)) {
        this.json(res, 403, { code: 'forbidden_origin', message: `跨站请求被拒绝: ${origin}`, correlationId });
        return;
      }
      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      // DELETE 通常没有请求体(浏览器不会为它自动加 Content-Type), 只在确实带体时才要求 JSON。
      const hasBody = Number(req.headers['content-length'] ?? '0') > 0 || req.headers['transfer-encoding'] !== undefined;
      const needsJson = req.method === 'POST' || req.method === 'PATCH' || (req.method === 'DELETE' && hasBody);
      if (needsJson) {
        if (!ct.includes('application/json')) {
          this.json(res, 415, { code: 'unsupported_media_type', message: '写请求必须使用 application/json', correlationId });
          return;
        }
      }
    }

    const url = new URL(req.url ?? '/', `http://${host || '127.0.0.1'}`);
    if (!url.pathname.startsWith('/api/')) {
      this.serveStatic(url.pathname, res);
      return;
    }

    const matched = this.match(req.method ?? 'GET', url.pathname);
    if (!matched) {
      this.json(res, 404, { code: 'not_found', message: `未知接口 ${req.method} ${url.pathname}`, correlationId });
      return;
    }
    let body: unknown = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await this.readJson(req);
      } catch (err) {
        this.json(res, 400, { code: 'invalid_json', message: (err as Error).message, correlationId });
        return;
      }
    }
    const ctx: Ctx = { req, res, url, params: matched.params, body, correlationId };
    try {
      const out = await matched.route.handler(ctx);
      if (out === HANDLED) return;
      this.json(res, 200, out ?? { ok: true });
    } catch (err) {
      this.handleError(err, res, correlationId);
    }
  }

  private isLocalHost(host: string): boolean {
    const name = host.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  }

  private isAllowedOrigin(origin: string): boolean {
    try {
      const u = new URL(origin);
      return (
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') &&
        Number(u.port || 80) === Number(this.cfg.port)
      );
    } catch {
      return false;
    }
  }

  private handleError(err: unknown, res: http.ServerResponse, correlationId: string): void {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    if (err instanceof EngineError) {
      this.json(res, err.status, {
        code: err.code,
        message: err.message,
        details: err.details,
        correlationId,
      });
      return;
    }
    if (err instanceof z.ZodError) {
      this.json(res, 422, {
        code: 'validation_failed',
        message: '请求体校验失败',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        correlationId,
      });
      return;
    }
    const message = (err as Error)?.message ?? String(err);
    this.json(res, 500, { code: 'internal_error', message, correlationId });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > 4 * 1024 * 1024) throw new Error('请求体超过 4MB');
      chunks.push(b);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0) return {};
    return JSON.parse(text);
  }

  /* ------------------------------- static ------------------------------ */

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const dist = this.cfg.webDist;
    const indexPath = path.join(dist, 'index.html');
    if (!existsSync(indexPath)) {
      const html = `<!doctype html><meta charset="utf-8"><title>harness-hub</title>
<body style="font-family:system-ui;padding:40px;line-height:1.6">
<h1>harness-hub 后端已启动</h1>
<p>前端尚未构建。运行 <code>npm run build:web</code> 后刷新本页, 或使用 <code>npm run dev</code> 打开 Vite 开发服务器。</p>
<p>健康检查: <a href="/api/health">/api/health</a></p></body>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let abs = path.join(dist, rel);
    if (!isInside(dist, abs) || !existsSync(abs) || !statSync(abs).isFile()) {
      abs = indexPath;
    }
    const ext = path.extname(abs).toLowerCase();
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.css'
            ? 'text/css; charset=utf-8'
            : ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.json'
                ? 'application/json'
                : mediaTypeFor(abs);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    createReadStream(abs).pipe(res);
  }

  /* ------------------------------ handlers ----------------------------- */

  private health() {
    return {
      ok: true,
      version: this.cfg.version,
      uptimeSeconds: this.engine.uptimeSeconds(),
      dbPath: this.cfg.dbPath,
      root: this.cfg.root,
      liveSessions: this.engine.liveSessionCount(),
      adapters: Object.values(this.engineAdapters()).map((a) => ({ id: a.id, displayName: a.displayName, mock: a.mock })),
      time: nowIso(),
    };
  }

  /**
   * 页面存活状态: 是否"关网页即停服务"、上次心跳、排队中的关停。
   * 前端用这个接口判断要不要在关闭时提示。
   */
  private runtimeStatus() {
    if (!this.runtime) {
      return { exitOnUiClose: false, lastHeartbeatAgoMs: null, pendingStopInMs: null, activeSessions: 0, stopped: false };
    }
    return this.runtime.status();
  }

  private runtimeHeartbeat() {
    this.runtime?.noteHeartbeat();
    return { ok: true, ...this.runtimeStatus() };
  }

  private runtimeCloseIntent() {
    if (!this.runtime) return { ok: true, scheduled: false, delayMs: null, reason: 'disabled' };
    return { ok: true, ...this.runtime.requestClose() };
  }

  private engineAdapters(): Record<string, HarnessAdapter> {
    return this.adapters;
  }

  private listAdapters() {
    return Object.values(this.engineAdapters()).map((a) => ({ id: a.id, displayName: a.displayName, mock: a.mock }));
  }

  private listProfiles(): ProfileDto[] {
    return this.repo
      .listProfiles()
      .map((p) => ({
        ...p,
        usage: this.repo.countParticipantsForProfile(p.id),
        lastProbe: this.repo.getLastProbe(p.id) as ProfileDto['lastProbe'],
      }));
  }

  private createProfile(ctx: Ctx): ProfileDto {
    const input = ProfileCreateSchema.parse(ctx.body);
    if (input.adapterId !== 'mock' && !input.executableRef.trim()) {
      throw new EngineError('executable_required', `适配器 ${input.adapterId} 必须提供可执行入口`, 422);
    }
    const now = nowIso();
    const profile = this.repo.insertProfile({
      id: newId('prof'),
      name: input.name,
      adapterId: input.adapterId,
      executableRef: input.executableRef,
      configRefs: input.configRefs,
      secretRefs: input.secretRefs,
      requestedModel: input.requestedModel,
      requestedReasoning: input.requestedReasoning,
      concurrencyGroup: input.concurrencyGroup,
      enabled: input.enabled,
      liveEnabled: input.liveEnabled,
      env: input.env,
      workspaceRoot: input.workspaceRoot,
      sandbox: input.sandbox ?? 'workspace-write',
      capabilitySnapshot: null,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    });
    this.engine.emit('task.updated', { taskId: null, payload: { profileCreated: profile.id } });
    return { ...profile, lastProbe: null };
  }

  private patchProfile(ctx: Ctx): ProfileDto {
    const input = ProfilePatchSchema.parse(ctx.body);
    const updated = this.repo.updateProfile(ctx.params.id, input);
    if (!updated) throw new EngineError('profile_not_found', '执行配置不存在', 404);
    return { ...updated, lastProbe: this.repo.getLastProbe(updated.id) as ProfileDto['lastProbe'] };
  }

  private deleteProfile(ctx: Ctx) {
    const profile = this.repo.getProfile(ctx.params.id);
    if (!profile) throw new EngineError('profile_not_found', '执行配置不存在', 404);
    const hard = ctx.url.searchParams.get('hard') === '1';
    if (!hard) {
      // 默认只停用: 历史任务的快照仍需可追溯, 也避免误删正在用的配置。
      const updated = this.repo.updateProfile(profile.id, { enabled: false });
      return { ok: true, deleted: false, profile: updated };
    }
    const usage = this.repo.countParticipantsForProfile(profile.id);
    if (usage > 0) {
      throw new EngineError(
        'profile_in_use',
        `该执行配置被 ${usage} 个任务参与者引用过, 只能停用, 不能删除`,
        409,
        { usage },
      );
    }
    const result = this.repo.deleteProfile(profile.id);
    if (result !== 'deleted') {
      throw new EngineError('profile_delete_failed', '执行配置未能删除', 409);
    }
    this.engine.emit('task.updated', { taskId: null, payload: { profileDeleted: profile.id } });
    return { ok: true, deleted: true };
  }

  private async probeProfile(ctx: Ctx) {
    const input = ProbeRequestSchema.parse(ctx.body ?? {});
    const idemKey = ctx.req.headers['idempotency-key'];
    const key = typeof idemKey === 'string' ? idemKey : null;
    const profile = this.repo.getProfile(ctx.params.id);
    if (!profile) throw new EngineError('profile_not_found', '执行配置不存在', 404);
    const adapter = this.adapters[profile.adapterId];
    if (!adapter) throw new EngineError('adapter_missing', `未注册适配器 ${profile.adapterId}`);
    const home = preparePrivateHome(this.cfg.root, profile);
    const result = await adapter.probe(profile, input.mode);
    this.repo.setLastProbe(profile.id, result);
    const capability = (result as { capability?: unknown }).capability;
    if (capability) this.repo.updateProfile(profile.id, { capabilitySnapshot: capability as never });
    this.engine.emit('task.updated', {
      taskId: null,
      payload: { profileProbed: profile.id, mode: input.mode, home: home.dir },
    });
    void key;
    return { result, home };
  }

  private listTasks(): TaskListItem[] {
    const tasks = this.repo.listTasks();
    return tasks.map((t) => {
      const participants = this.repo.listParticipants(t.id);
      const plan = t.currentPlanRevisionId ? this.repo.getPlan(t.currentPlanRevisionId) : null;
      return {
        id: t.id,
        title: t.title,
        phase: t.phase,
        lifecycle: t.lifecycle,
        updatedAt: t.updatedAt,
        strongCount: participants.filter((p) => p.role === 'strong').length,
        workerCount: participants.filter((p) => p.role === 'worker').length,
        planNumber: plan?.number ?? null,
        artifactCount: this.repo.listCurrentArtifacts(t.id).length,
      };
    });
  }

  private createTask(ctx: Ctx) {
    const input = CreateTaskSchema.parse(ctx.body);
    const key = input.idempotencyKey;
    if (key) {
      const hit = this.repo.getIdempotent('create-task', key);
      if (hit) return hit.response;
    }
    for (const profileId of [...input.strongProfileIds, ...input.workerProfileIds]) {
      const p = this.repo.getProfile(profileId);
      if (p) preparePrivateHome(this.cfg.root, p);
    }
    const task = this.engine.createTask({
      title: input.title,
      objective: input.objective,
      constraints: input.constraints,
      strongProfileIds: input.strongProfileIds,
      leadProfileId: input.leadProfileId,
      workerProfileIds: input.workerProfileIds,
      limits: input.limits,
      workspace: input.workspace ?? null,
    });
    const out = { task, snapshot: this.engine.snapshot(task.id) };
    if (key) this.repo.putIdempotent('create-task', key, out);
    return out;
  }

  /**
   * 删除任务: 默认把已登记产物归档到 .local/archive/<taskId>/, 再删掉任务记录与全部对话。
   * ?keepArtifacts=0 表示连产物也不留(只删记录)。
   */
  private async purgeTask(ctx: Ctx) {
    const keepArtifacts = ctx.url.searchParams.get('keepArtifacts') !== '0';
    const result = await this.engine.purgeTask(ctx.params.id, { keepArtifacts });
    return { ok: true, ...result };
  }

  private getTask(ctx: Ctx) {
    const snapshot = this.engine.snapshot(ctx.params.id);
    const artifacts: ArtifactDto[] = snapshot.artifacts.map((a) => ({
      ...a,
      contentUrl: `/api/artifacts/${a.id}/content`,
      exists: existsSync(path.join(this.workspaceOf(ctx.params.id), a.relativePath)),
    }));
    const profiles: ProfileDto[] = this.repo.listProfiles().map((p) => ({
      ...p,
      lastProbe: this.repo.getLastProbe(p.id) as ProfileDto['lastProbe'],
    }));
    return { ...snapshot, artifacts, profiles, workspace: this.workspaceOf(ctx.params.id) };
  }

  private workspaceOf(taskId: string): string {
    const task = this.repo.getTask(taskId);
    if (task) return this.engine.workspaceOf(task);
    return this.engine.workspaceDir(taskId);
  }

  private async requestPlan(ctx: Ctx) {
    const input = PlanRequestSchema.parse(ctx.body ?? {});
    const idemKey = input.idempotencyKey;
    if (idemKey) {
      const hit = this.repo.getIdempotent('request-plan', idemKey);
      if (hit) return hit.response;
    }
    const task = await this.engine.requestPlan(ctx.params.id, input.reason, input.supplement);
    const out = { task, snapshot: this.engine.snapshot(task.id) };
    if (idemKey) this.repo.putIdempotent('request-plan', idemKey, out);
    return out;
  }

  private async decidePlan(ctx: Ctx) {
    const input = PlanDecisionSchema.parse(ctx.body);
    const idemKey = input.idempotencyKey;
    if (idemKey) {
      const hit = this.repo.getIdempotent('plan-decision', idemKey);
      if (hit) return hit.response;
    }
    const task = await this.engine.decidePlan(ctx.params.id, {
      decision: input.decision,
      planRevisionId: input.planRevisionId,
      planHash: input.planHash,
      participantsRevision: input.participantsRevision,
      expectedTaskVersion: input.expectedTaskVersion,
      userNote: input.note,
    });
    const out = { task, snapshot: this.engine.snapshot(task.id) };
    if (idemKey) this.repo.putIdempotent('plan-decision', idemKey, out);
    return out;
  }

  private async postMessage(ctx: Ctx) {
    const input = TaskMessageSchema.parse(ctx.body);
    await this.engine.sendUserMessage(ctx.params.id, {
      text: input.text,
      intent: input.intent,
      participantId: input.participantId ?? null,
    });
    return { ok: true, snapshot: this.engine.snapshot(ctx.params.id) };
  }

  private async patchParticipant(ctx: Ctx) {
    const input = ParticipantSettingsSchema.parse(ctx.body);
    const participant = await this.engine.updateParticipantSettings(ctx.params.id, ctx.params.participantId, {
      workspaceRoot: input.workspaceRoot,
      sandbox: input.sandbox,
    });
    return { ok: true, participant, snapshot: this.engine.snapshot(ctx.params.id) };
  }

  private async control(ctx: Ctx) {
    const input = TaskControlSchema.parse(ctx.body);
    const idemKey = input.idempotencyKey;
    if (idemKey) {
      const hit = this.repo.getIdempotent('control', idemKey);
      if (hit) return hit.response;
    }
    const task = await this.engine.control(ctx.params.id, input.action, input.targetSessionId);
    const out = { task, snapshot: this.engine.snapshot(task.id) };
    if (idemKey) this.repo.putIdempotent('control', idemKey, out);
    return out;
  }

  private async retryWorkItem(ctx: Ctx) {
    const body = (ctx.body ?? {}) as { note?: unknown };
    await this.engine.retryWorkItem(ctx.params.id, ctx.params.itemId, typeof body.note === 'string' ? body.note : undefined);
    return this.engine.snapshot(ctx.params.id);
  }

  private listArtifacts(ctx: Ctx): ArtifactDto[] {
    const workspace = this.workspaceOf(ctx.params.id);
    return this.repo
      .listCurrentArtifacts(ctx.params.id)
      .map((a) => ({
        ...a,
        contentUrl: `/api/artifacts/${a.id}/content`,
        exists: existsSync(path.join(workspace, a.relativePath)),
      }));
  }

  private getReviews(ctx: Ctx) {
    const rounds = this.repo.listReviewRounds(ctx.params.id);
    const results = this.repo.listReviewResults(ctx.params.id);
    return {
      rounds,
      results,
      verifications: this.repo.listVerifications(ctx.params.id),
      artifacts: this.repo.listCurrentArtifacts(ctx.params.id),
      artifactSetHash: rounds.length > 0 ? rounds[rounds.length - 1].artifactSetHash : null,
    };
  }

  private getSession(ctx: Ctx): SessionDto {
    const session = this.repo.getSession(ctx.params.id);
    if (!session) throw new EngineError('session_not_found', '会话不存在', 404);
    const participant = session.participantId ? this.repo.getParticipant(session.participantId) : null;
    return {
      ...session,
      participantName: participant?.displayName ?? null,
      participantRole: participant?.role ?? null,
    };
  }

  private async cancelSession(ctx: Ctx) {
    const session = this.repo.getSession(ctx.params.id);
    if (!session) throw new EngineError('session_not_found', '会话不存在', 404);
    const task = await this.engine.control(session.taskId, 'cancel_session', session.id);
    return { task, snapshot: this.engine.snapshot(task.id) };
  }

  private getApproval(ctx: Ctx) {
    const row = this.repo.getApprovalRequest(ctx.params.id);
    if (!row) throw new EngineError('approval_not_found', '审批请求不存在', 404);
    return row;
  }

  private async resolveApproval(ctx: Ctx) {
    const input = ApprovalResolveSchema.parse(ctx.body);
    await this.engine.resolveApproval(ctx.params.id, input.decision, input.answer ?? input.note);
    return { ok: true };
  }

  private artifactContent(ctx: Ctx) {
    const artifact = this.repo.getArtifact(ctx.params.id);
    if (!artifact) throw new EngineError('artifact_not_found', '产物不存在', 404);
    const workspace = this.workspaceOf(artifact.taskId);
    const abs = path.join(workspace, artifact.relativePath);
    if (!isInside(workspace, abs) || !existsSync(abs) || !statSync(abs).isFile()) {
      throw new EngineError('artifact_missing', '产物文件已不存在', 404);
    }
    const stat = statSync(abs);
    const inline = /^(text\/|image\/|application\/pdf|application\/json)/.test(artifact.mediaType);
    ctx.res.writeHead(200, {
      'Content-Type': artifact.mediaType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(path.basename(abs))}"`,
    });
    createReadStream(abs).pipe(ctx.res);
    return HANDLED;
  }

  /* -------------------------------- SSE -------------------------------- */

  private streamEvents(ctx: Ctx): unknown {
    const taskId = ctx.params.id;
    const task = this.repo.getTask(taskId);
    if (!task) throw new EngineError('task_not_found', '任务不存在', 404);
    const { res, req, url } = ctx;

    // 一次性回放(测试/调试用): ?format=json 或 Accept: application/json
    const wantsJson =
      url.searchParams.get('format') === 'json' ||
      (req.headers.accept ?? '').includes('application/json');
    if (wantsJson) {
      const afterRaw = url.searchParams.get('after') ?? '0';
      const after = Number(afterRaw);
      const events = this.repo.listEvents(taskId, Number.isFinite(after) && after > 0 ? after : 0, 5000);
      return { events, highWaterSeq: this.repo.maxSeq() };
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const writeEvent = (event: string, data: unknown, id?: number) => {
      let chunk = '';
      if (typeof id === 'number') chunk += `id: ${id}\n`;
      chunk += `event: ${event}\n`;
      chunk += `data: ${JSON.stringify(data)}\n\n`;
      res.write(chunk);
    };

    const snapshot: TaskSnapshot = this.engine.snapshot(taskId);
    writeEvent('snapshot', { snapshot });

    const afterRaw = url.searchParams.get('after') ?? (req.headers['last-event-id'] as string | undefined) ?? '0';
    let last = Number(afterRaw);
    if (!Number.isFinite(last) || last < 0) last = 0;
    const replay = this.repo.listEvents(taskId, last, 5000);
    const minSeq = this.repo.minSeq(taskId);
    if (last > 0 && minSeq !== null && last < minSeq - 1) {
      writeEvent('resync_required', { reason: 'cursor_too_old', highWaterSeq: snapshot.highWaterSeq });
    }
    for (const env of replay) writeEvent(env.type, env, env.seq);

    const unsubscribe = this.engine.bus.subscribe(taskId, (env: EventEnvelope) => {
      try {
        writeEvent(env.type, env, env.seq);
      } catch {
        /* 连接已关闭 */
      }
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* ignore */
      }
    }, 5000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };
    req.on('close', close);
    return HANDLED;
  }
}
