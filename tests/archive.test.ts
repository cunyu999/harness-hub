/**
 * 归档的测试: 列出、按名字删除、拒绝路径穿越。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { Engine, EngineError } from '../packages/core/src/engine.js';
import { MockAdapter } from '../packages/adapters/src/mock.js';

function freshEngine(label: string) {
  const root = join(process.cwd(), '.local', 'tmp', `archive-test-${process.pid}-${label}`);
  mkdirSync(join(root, '.local', 'data'), { recursive: true });
  const db = new Db(join(root, '.local', 'data', 'test.db'));
  const repo = new Repo(db);
  const engine = new Engine(repo, { paths: { root, dataDir: join(root, '.local', 'data') }, adapters: { mock: new MockAdapter() } });
  return { root, db, engine };
}

test('归档: 列出 manifest 与大小, 删除后目录消失', () => {
  const { root, db, engine } = freshEngine('crud');
  const dir = join(root, '.local', 'archive', 'task_demo1');
  mkdirSync(join(dir, 'deliverables'), { recursive: true });
  writeFileSync(join(dir, 'deliverables', 'a.md'), 'hello', 'utf8');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ taskId: 'task_demo1', title: '演示任务', objective: '把事做完', archivedAt: '2026-11-06T00:00:00.000Z' }),
    'utf8',
  );

  const entries = engine.listArchives();
  const entry = entries.find((e) => e.taskId === 'task_demo1');
  assert.ok(entry, '应该列出刚才创建的归档');
  assert.equal(entry?.title, '演示任务');
  assert.equal(entry?.hasManifest, true);
  assert.equal(entry?.fileCount, 1, '只统计产物文件, 不含 manifest');
  assert.equal(entry?.totalBytes, 5);

  const res = engine.deleteArchive('task_demo1');
  assert.equal(res.removedFiles, 2); // 1 个产物 + manifest.json
  assert.equal(existsSync(dir), false, '目录应被彻底删除');
  assert.equal(engine.listArchives().length, 0);
  db.close();
});

test('归档: 非法标识与路径穿越都被拒绝', () => {
  const { db, engine } = freshEngine('guard');
  for (const bad of ['../etc', 'a/b', '', 'task ']) {
    assert.throws(
      () => engine.deleteArchive(bad),
      (e: unknown) => e instanceof EngineError && ['invalid_archive_id', 'archive_not_found'].includes(e.code),
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => engine.deleteArchive('task_missing_1'),
    (e: unknown) => e instanceof EngineError && e.code === 'archive_not_found',
  );
  db.close();
});
