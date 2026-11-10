/**
 * 桌面通知 + 标题徽标。
 *
 * 任务最常见的等待点是"计划等批准"和"原生审批", 不需要一直盯着页面。
 * 只在页面不可见时弹系统通知; 正在看页面时仅更新标题徽标, 避免自己打扰自己。
 */
const BASE_TITLE = 'Harness Hub';

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotifyState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifyState;
}

export async function requestNotificationPermission(): Promise<NotifyState> {
  if (notificationState() === 'unsupported') return 'unsupported';
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* 用户直接关掉授权框 */
    }
  }
  return notificationState();
}

/** 返回是否真的弹了(页面可见或未授权时不弹)。 */
export function notify(title: string, body: string, onClick?: () => void): boolean {
  if (notificationState() !== 'granted') return false;
  if (typeof document !== 'undefined' && !document.hidden) return false;
  try {
    const n = new Notification(title, { body, tag: 'harness-hub' });
    n.onclick = () => {
      window.focus();
      n.close();
      onClick?.();
    };
    return true;
  } catch {
    return false;
  }
}

/** 有待处理事项时把数量放进标签页标题, 切回来一眼能看到。 */
export function setTitleBadge(count: number): void {
  if (typeof document === 'undefined') return;
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}
