import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveClaudeBinary, resolveLauncher, whichSync } from '../packages/adapters/src/exec.js';

// 这些测试只验证"把配置里的入口变成可 spawn 的命令"这一层, 不启动任何 harness。

test('EXEC: PATH 里能找到 node 与 npm 提供的垫片', () => {
  const node = whichSync('node');
  assert.ok(node, '应能在 PATH 中找到 node');
  assert.ok(path.isAbsolute(node as string));
  // 不存在的命令必须是 null, 不能抛
  assert.equal(whichSync('definitely-not-a-real-command-xyz'), null);
});

test('EXEC: .js 入口用 node 执行, .exe 直接执行', () => {
  const js = resolveLauncher('D:/1hobby/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.equal(js.kind, 'node');
  assert.equal(js.command, process.execPath);
  assert.deepEqual(js.prefix, ['D:/1hobby/node_modules/@deepseek-ai/dsh/lib/bin.js']);
  assert.equal(js.entry, 'D:/1hobby/node_modules/@deepseek-ai/dsh/lib/bin.js');

  const exe = resolveLauncher('C:/Windows/System32/cmd.exe');
  assert.equal(exe.kind, 'direct');
  assert.equal(exe.command, 'C:/Windows/System32/cmd.exe');
});

test('EXEC: 留空时先找 PATH, 找不到再用项目内入口', () => {
  const nodeLauncher = resolveLauncher(null, { name: 'node' });
  assert.ok(nodeLauncher.command.length > 0);
  assert.ok(/node(\.exe)?$/i.test(nodeLauncher.command), `应解析到 node, 实际 ${nodeLauncher.command}`);

  const fallbackOnly = resolveLauncher('', {
    name: 'definitely-not-a-real-command-xyz',
    path: 'D:/1hobby/node_modules/@deepseek-ai/dsh/lib/bin.js',
  });
  assert.equal(fallbackOnly.kind, 'node');
});

test('EXEC: 入口不存在时报错而不是静默降级', () => {
  assert.throws(() => resolveLauncher('D:/1hobby/no-such-binary-xyz.exe'), /可执行入口不存在/);
});

test('EXEC: Claude Code 需要真实 exe, js 入口会退回项目内安装的版本', () => {
  const vendored = 'D:/1hobby/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const byJs = resolveClaudeBinary('D:/1hobby/node_modules/@openai/codex/bin/codex.js', vendored);
  assert.equal(byJs.source, 'vendored');
  assert.equal(byJs.executable, vendored);
  assert.ok(byJs.note && byJs.note.includes('原生可执行文件'));

  const byExe = resolveClaudeBinary('C:/Windows/System32/cmd.exe', vendored);
  assert.equal(byExe.source, 'profile');
  assert.equal(byExe.executable, 'C:/Windows/System32/cmd.exe');
});
