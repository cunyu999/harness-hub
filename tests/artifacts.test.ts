import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import type { ArtifactRevision } from '../packages/contracts/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '.local', 'tmp', 'artifacts-test-' + process.pid);

function artifact(id: string, sha: string): ArtifactRevision {
  return {
    id,
    taskId: 'task_1',
    workItemId: null,
    attemptId: null,
    relativePath: 'hello.exe',
    mediaType: 'application/octet-stream',
    size: 10,
    sha256: sha,
    producer: 'worker',
    status: 'registered',
    registeredAt: new Date(Date.now() + Number(id.slice(-1)) * 1000).toISOString(),
    note: null,
  };
}

test('ARTIFACT: 同名产物重新生成时只保留最新一版为当前版本', () => {
  mkdirSync(dir, { recursive: true });
  const db = new Db(path.join(dir, 'test.db'));
  const repo = new Repo(db);

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, objective, constraints_json, phase, lifecycle, participants_revision, version, limits_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'task_1',
    't',
    'o',
    '[]',
    'execution',
    'active',
    1,
    1,
    '{}',
    now,
    now,
  );

  repo.insertArtifact(artifact('art_1', 'aaa'));
  repo.insertArtifact(artifact('art_2', 'bbb'));

  // 未做 supersede 前: 两条都是 registered, 当前集合里就会同时出现两条
  assert.equal(repo.listArtifacts('task_1').filter((a) => a.status === 'registered').length, 2);

  repo.supersedeArtifactRevisions('task_1', 'hello.exe', 'art_2');

  const rows = repo.listArtifacts('task_1');
  assert.equal(rows.find((a) => a.id === 'art_1')?.status, 'superseded');
  assert.equal(rows.find((a) => a.id === 'art_2')?.status, 'registered');

  const current = repo.listCurrentArtifacts('task_1');
  assert.equal(current.length, 1, '当前产物集合只能有一条');
  assert.equal(current[0].id, 'art_2', '应为最新一版');
  assert.equal(rows.length, 2, '历史修订仍保留, 不删除');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
