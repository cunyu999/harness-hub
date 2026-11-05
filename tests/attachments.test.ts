import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../packages/storage/src/db.js';
import { Repo } from '../packages/storage/src/repo.js';
import { TaskMessageSchema } from '../packages/contracts/src/api.js';
import type { MessageAttachment, TaskMessage } from '../packages/contracts/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '.local', 'tmp', 'attachments-test-' + process.pid);

const attachment: MessageAttachment = {
  name: 'notes.md',
  path: 'D:\\tmp\\notes.md',
  relativePath: 'uploads/abc-notes.md',
  mediaType: 'text/markdown',
  size: 12,
  isImage: false,
};

test('ATTACH: 消息附件能落库并按原样读回', () => {
  mkdirSync(dir, { recursive: true });
  const db = new Db(path.join(dir, 'test.db'));
  const repo = new Repo(db);

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, objective, constraints_json, phase, lifecycle, participants_revision, version, limits_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'task_att',
    't',
    'o',
    '[]',
    'intake',
    'active',
    1,
    1,
    '{}',
    now,
    now,
  );

  const message: TaskMessage = {
    id: 'msg_att_1',
    taskId: 'task_att',
    role: 'user',
    participantId: null,
    sessionId: null,
    attemptId: null,
    text: '看看这两个附件',
    kind: 'chat',
    createdAt: now,
    incomplete: false,
    attachments: [attachment],
  };

  repo.insertMessage(message);
  const rows = repo.listMessages('task_att');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.attachments, [attachment]);

  // 没有附件的消息读回来是 null, 不要变成 []
  repo.insertMessage({ ...message, id: 'msg_att_2', attachments: null });
  const plain = repo.listMessages('task_att').find((m) => m.id === 'msg_att_2');
  assert.equal(plain?.attachments, null);

  db.close();
});

test('ATTACH: 接口层接受附件字段, 缺字段会被拒绝', () => {
  const ok = TaskMessageSchema.safeParse({
    text: 'hi',
    intent: 'chat',
    attachments: [
      { name: 'a.png', path: '/tmp/a.png', relativePath: 'uploads/a.png', mediaType: 'image/png', size: 10, isImage: true },
    ],
  });
  assert.equal(ok.success, true);

  const bad = TaskMessageSchema.safeParse({
    text: 'hi',
    intent: 'chat',
    attachments: [{ name: 'a.png' }],
  });
  assert.equal(bad.success, false);
});
