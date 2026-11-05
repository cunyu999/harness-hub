import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChildEnv } from '../packages/adapters/src/exec.js';

/**
 * 这些用例保护的是 0xC0000142 那一类"子进程起不来"的根因:
 * 环境块里同时有 Path/PATH、关键变量为空、或混入非法键(含 `=`/NUL)时,
 * 子进程在 Windows 加载器阶段就会失败。
 */

test('环境块大小写去重: 只保留一个 PATH, 且关键变量非空', () => {
  const env = buildChildEnv({ Path: 'C:\\only-here' });
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  assert.equal(pathKeys.length, 1, 'PATH/Path 不能同时存在');
  assert.equal(env[pathKeys[0]], 'C:\\only-here');
  if (process.platform === 'win32') {
    assert.ok(env.SystemRoot || env.windir, 'SystemRoot/windir 必须存在');
  }
});

test('空的关键变量会用当前进程的值兜底', () => {
  const env = buildChildEnv({ PATH: '' });
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  assert.equal(pathKeys.length, 1);
  if (process.env.PATH) assert.equal(env[pathKeys[0]], process.env.PATH);
});

test('非法键与含 NUL 的值被丢弃, 其它变量照常合并', () => {
  const env = buildChildEnv({
    'A=B': 'x',
    GOOD_KEY: 'value',
    BAD_VALUE: 'a\0b',
  } as Record<string, string>);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'A=B'), false);
  assert.equal(env.GOOD_KEY, 'value');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'BAD_VALUE'), false);
});
