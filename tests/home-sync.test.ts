/**
 * 私有 home 择新同步的测试:
 * - 首次同步复制源配置
 * - 源变了(cc-switch 切换)覆盖私有 home
 * - 私有 home 变了(harness 刷新凭据)不被旧来源覆盖
 * - resync='true' 强制以源为准
 * - 子目录(DSH profiles)同样参与同步
 * - 自定义 homesRoot(便携版 data 目录)时私有 home 跟着数据目录走
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { homeDirFor, preparePrivateHome } from '../apps/server/src/homes.js';
import type { AdapterId, ExecutionProfile } from '../packages/contracts/src/types.js';

const baseRoot = join(process.cwd(), '.local', 'tmp', `home-sync-${process.pid}`);
const T = 1_700_000_000; // 固定时间戳, 避免依赖当前时钟
let caseIndex = 0;

function profile(id: string, adapterId: AdapterId, sourceHome: string, resync = false): ExecutionProfile {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    adapterId,
    executableRef: 'codex',
    configRefs: resync ? { sourceHome, resync: 'true' } : { sourceHome },
    secretRefs: [],
    requestedModel: null,
    requestedReasoning: null,
    concurrencyGroup: 'default',
    enabled: true,
    capabilitySnapshot: null,
    env: {},
    workspaceRoot: null,
    sandbox: 'workspace-write',
    liveEnabled: false,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

function newRoot(): string {
  caseIndex += 1;
  const root = join(baseRoot, `case-${caseIndex}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeAt(file: string, content: string, seconds: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  const t = new Date(seconds * 1000);
  utimesSync(file, t, t);
}

test('首次同步复制源配置并记录同步时间', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"chatgpt"}\n', T);
  writeAt(join(source, 'config.toml'), 'model = "x"\n', T);

  const p = profile('prof_sync', 'codex', source);
  const info = preparePrivateHome(root, p);
  const dir = homeDirFor(root, p);

  assert.equal(info.copied.length, 2);
  assert.equal(info.kept.length, 0);
  assert.ok(info.syncedAt);
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"mode":"chatgpt"}\n');
  assert.equal(readFileSync(join(dir, 'config.toml'), 'utf8'), 'model = "x"\n');
});

test('内容没变时重复调用不重复写', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"chatgpt"}\n', T);

  const p = profile('prof_sync', 'codex', source);
  preparePrivateHome(root, p);
  const again = preparePrivateHome(root, p);

  assert.equal(again.copied.length, 0);
  assert.equal(again.kept.length, 0);
});

test('源变了(cc-switch 切换)覆盖私有 home', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"chatgpt"}\n', T);

  const p = profile('prof_sync', 'codex', source);
  const dir = homeDirFor(root, p);
  preparePrivateHome(root, p);

  // 模拟用户在 cc-switch 里切到 API key
  writeAt(join(source, 'auth.json'), '{"mode":"apikey","key":"sk-test"}\n', T + 10);
  const info = preparePrivateHome(root, p);

  assert.ok(info.copied.includes(join(dir, 'auth.json')));
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"mode":"apikey","key":"sk-test"}\n');
});

test('私有 home 被 harness 刷新后不被旧来源覆盖', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"chatgpt"}\n', T);

  const p = profile('prof_sync', 'codex', source);
  const dir = homeDirFor(root, p);
  preparePrivateHome(root, p);

  // 模拟 harness 在私有 home 里刷新了令牌(源没动)
  writeAt(join(dir, 'auth.json'), '{"mode":"chatgpt","tokens":"fresh"}\n', T + 20);
  const info = preparePrivateHome(root, p);

  assert.ok(info.kept.includes(join(dir, 'auth.json')));
  assert.equal(info.copied.length, 0);
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"mode":"chatgpt","tokens":"fresh"}\n');
});

test("resync='true' 强制以源为准", () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"chatgpt"}\n', T);

  const base = profile('prof_sync', 'codex', source);
  const dir = homeDirFor(root, base);
  preparePrivateHome(root, base);
  writeAt(join(dir, 'auth.json'), '{"mode":"chatgpt","tokens":"fresh"}\n', T + 20);

  const forced = profile('prof_sync', 'codex', source, true);
  const info = preparePrivateHome(root, forced);

  assert.ok(info.copied.includes(join(dir, 'auth.json')));
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"mode":"chatgpt"}\n');
});

test('DSH profiles 子目录同样参与择新同步', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'profiles', 'acp.json'), '{"a":1}\n', T);

  const p = profile('prof_dsh', 'dsh', source);
  const dir = homeDirFor(root, p);
  const first = preparePrivateHome(root, p);
  assert.equal(first.copied.length, 1);
  assert.equal(readFileSync(join(dir, 'profiles', 'acp.json'), 'utf8'), '{"a":1}\n');

  writeAt(join(source, 'profiles', 'acp.json'), '{"a":2}\n', T + 10);
  const second = preparePrivateHome(root, p);
  assert.ok(second.copied.includes(join(dir, 'profiles', 'acp.json')));
  assert.equal(readFileSync(join(dir, 'profiles', 'acp.json'), 'utf8'), '{"a":2}\n');
});

test('自定义 homesRoot(便携版数据目录)时同步与适配器看到的是同一个目录', () => {
  const root = newRoot();
  const source = join(root, 'source');
  writeAt(join(source, 'auth.json'), '{"mode":"api"}\n', T);
  const homesRoot = join(root, 'data', 'homes');

  const p = profile('prof_portable', 'codex', source);
  const info = preparePrivateHome(root, p, homesRoot);
  const dir = homeDirFor(root, p, homesRoot);

  assert.equal(dir, join(homesRoot, 'codex-prof_portable'));
  assert.equal(info.dir, dir);
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"mode":"api"}\n');
  // 默认位置(程序目录下的 .local/homes)不应被写
  assert.equal(existsSync(join(root, '.local', 'homes', 'codex-prof_portable')), false);
});
