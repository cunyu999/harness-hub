import { useEffect, useState } from 'react';

/** 呼吸灯动效开关。只影响侧栏任务行的呼吸灯, 图上的 harness 连线始终常驻。 */
const KEY = 'hh.effects';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = read();

function paint(): void {
  document.documentElement.dataset.effects = enabled ? 'on' : 'off';
}

paint();

export function effectsEnabled(): boolean {
  return enabled;
}

export function setEffects(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(KEY, next ? 'on' : 'off');
  } catch {
    // 隐私模式下写不进去, 只影响本次会话
  }
  paint();
  listeners.forEach((fn) => fn());
}

export function toggleEffects(): void {
  setEffects(!enabled);
}

export function useEffects(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((v) => v + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return enabled;
}
