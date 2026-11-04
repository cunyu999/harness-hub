/**
 * 页面生命周期: 心跳 + 离开时的关停意图。
 *
 * 为什么需要它: 这是本机单用户工具, 后台进程只在网页打开时才有意义。
 * 做法:
 * - 每 2s 发一次心跳, 服务据此知道页面还在;
 * - 关闭/刷新时发一次 close-intent, 服务在宽限期内关停, 期间收到心跳就取消(刷新场景);
 * - 关闭前用 beforeunload 让浏览器弹出确认提示(文案由浏览器决定, 不能自定义)。
 */
import { useEffect, useRef, useState } from 'react';
import { api, type UiRuntimeStatus } from '../api';

declare global {
  interface Window {
    /** 应用内自己触发的刷新可以跳过离开提示。 */
    __hhAllowUnload?: boolean;
  }
}

const HEARTBEAT_MS = 2000;

export function usePageLifecycle(): { status: UiRuntimeStatus | null; online: boolean } {
  const [status, setStatus] = useState<UiRuntimeStatus | null>(null);
  const [online, setOnline] = useState(true);
  const statusRef = useRef<UiRuntimeStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const beat = async () => {
      try {
        const next = await api.heartbeat();
        if (!alive) return;
        statusRef.current = next;
        setStatus(next);
        setOnline(true);
      } catch {
        if (alive) setOnline(false);
      }
    };
    void beat();
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const exitOnUiClose = status?.exitOnUiClose ?? false;

  useEffect(() => {
    if (!exitOnUiClose) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (window.__hhAllowUnload) return undefined;
      // 现代浏览器只显示自己的通用文案, 但会因此拦下这次关闭, 给用户一次反悔机会。
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    const onPageHide = () => {
      // 刷新时也会走到这里; 服务有 2.5s 宽限期, 新页面的第一次心跳会取消关停。
      try {
        const body = new Blob(['{}'], { type: 'application/json' });
        navigator.sendBeacon('/api/runtime/close-intent', body);
      } catch {
        /* 关停意图发不出去时, 服务还有心跳超时兜底 */
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [exitOnUiClose]);

  return { status, online };
}
