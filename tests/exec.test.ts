import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBinary, resolveLauncher, whichSync } from '../packages/adapters/src/exec.js';

// 这些测试只验证"把配置里的入口变成可 spawn 的命令"这一层, 不启动任何 harness。
// 注意: 本项目不再内置 harness 副本, 所以这里用测试文件自身当"存在的 .js 入口"。

const self = fileURLToPath(import.meta.url);

test('EXEC: PATH 里能找到 node 与 npm 提供的垫片', () => {
  const node = whichSync('node');
  assert.ok(node, '应能在 PATH 中找到 node');
  assert.ok(path.isAbsolute(node as string));
  // 不存在的命令必须是 null, 不能抛
  assert.equal(whichSync('definitely-not-a-real-command-xyz'), null);
});

test('EXEC: .js 入口用 node 执行, .exe 直接执行', () => {
  const js = resolveLauncher(self);
  assert.equal(js.kind, 'node');
  assert.equal(js.command, process.execPath);
  assert.deepEqual(js.prefix, [self]);
  assert.equal(js.entry, self);

  const exe = resolveLauncher('C:/Windows/System32/cmd.exe');
  assert.equal(exe.kind, 'direct');
  assert.equal(exe.command, 'C:/Windows/System32/cmd.exe');
});

test('EXEC: 留空时先找 PATH, 找不到再用可选兜底', () => {
  const byPath = resolveLauncher(null, { name: 'node' });
  assert.ok(/node(\.exe)?$/i.test(byPath.command), `应解析到 node, 实际 ${byPath.command}`);

  const byFallback = resolveLauncher('', {
    name: 'definitely-not-a-real-command-xyz',
    path: self,
  });
  assert.equal(byFallback.kind, 'node');
});

test('EXEC: 找不到入口时报错并给出可执行建议', () => {
  assert.throws(() => resolveLauncher('D:/1hobby/no-such-binary-xyz.exe'), /可执行入口不存在/);
  assert.throws(
    () => resolveLauncher('', { name: 'definitely-not-a-real-command-xyz' }),
    /请先安装它|找绝对路径/,
  );
});

test('EXEC: Claude Code 需要真实 exe; 没有本机安装时交给 SDK 内置', () => {
  const byJs = resolveClaudeBinary(self, null);
  assert.equal(byJs.executable, null);
  assert.equal(byJs.source, 'sdk');
  assert.ok(byJs.note && byJs.note.includes('原生可执行文件'));

  const byExe = resolveClaudeBinary('C:/Windows/System32/cmd.exe', null);
  assert.equal(byExe.source, 'profile');
  assert.equal(byExe.executable, 'C:/Windows/System32/cmd.exe');

  const nothing = resolveClaudeBinary('definitely-not-a-real-command-xyz', null);
  assert.equal(nothing.executable, null);
  assert.equal(nothing.source, 'sdk');
});
