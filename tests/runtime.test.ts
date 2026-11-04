/**
 * 浏览器存活监控的单元测试: 关停只应发生在"页面确实要关"或"心跳消失且无活跃会话"时。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { UiWatchdog, type UiStopReason } from '../apps/server/src/runtime-control.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDog(overrides: Partial<ConstructorParameters<typeof UiWatchdog>[0]> = {}): {
  dog: UiWatchdog;
  stops: UiStopReason[];
} {
  const stops: UiStopReason[] = [];
  const dog = new UiWatchdog({
    enabled: true,
    graceMs: 40,
    idleTimeoutMs: 10_000,
    firstHeartbeatTimeoutMs: 60_000,
    activeSessions: () => 0,
    onStop: (reason) => {
      stops.push(reason);
    },
    ...overrides,
  });
  return { dog, stops };
}

test('close-intent: 宽限期后关停, 期间收到心跳则取消', async () => {
  const { dog, stops } = makeDog();

  const first = dog.requestClose();
  assert.equal(first.scheduled, true);
  assert.equal(first.delayMs, 40);
  dog.noteHeartbeat();
  await sleep(80);
  assert.deepEqual(stops, [], '心跳应当取消排队中的关停');
  assert.equal(dog.status().pendingStopInMs, null);

  dog.requestClose();
  await sleep(90);
  assert.deepEqual(stops, ['ui_closed']);
  assert.equal(dog.status().stopped, true);
});

test('空闲兜底: 有活跃会话时不关停, 会话结束后才关停', async () => {
  let active = 1;
  const { dog, stops } = makeDog({ idleTimeoutMs: 30, activeSessions: () => active });

  dog.noteHeartbeat();
  await sleep(60);
  dog.tick();
  await sleep(10);
  assert.deepEqual(stops, [], '还有会话在跑时不能因为网页消失就关停');

  active = 0;
  dog.tick();
  await sleep(20);
  assert.deepEqual(stops, ['ui_gone']);
});

test('从未有页面连接: 默认一直等待, 不因"还没打开浏览器"退出', async () => {
  const { dog, stops } = makeDog({ firstHeartbeatTimeoutMs: 0, idleTimeoutMs: 10 });

  await sleep(40);
  dog.tick();
  await sleep(15);
  assert.deepEqual(stops, [], '没人打开页面时不该自己退出');
  assert.equal(dog.status().pageSeen, false);
});

test('从未有页面连接: 显式设置宽限时才按超时退出', async () => {
  const { dog, stops } = makeDog({ firstHeartbeatTimeoutMs: 30, idleTimeoutMs: 10 });

  await sleep(10);
  dog.tick();
  await sleep(5);
  assert.deepEqual(stops, [], '宽限期内不能退出');

  await sleep(40);
  dog.tick();
  await sleep(15);
  assert.deepEqual(stops, ['ui_never_connected']);
});

test('关闭开关时只报告状态, 不关停', async () => {
  const { dog, stops } = makeDog({ enabled: false, graceMs: 10, idleTimeoutMs: 10, firstHeartbeatTimeoutMs: 10 });

  const res = dog.requestClose();
  assert.equal(res.scheduled, false);
  assert.equal(res.reason, 'disabled');
  await sleep(40);
  dog.tick();
  await sleep(10);
  assert.deepEqual(stops, []);
  assert.equal(dog.status().exitOnUiClose, false);
});
