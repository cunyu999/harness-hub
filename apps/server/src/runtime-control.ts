/**
 * 浏览器存活监控。
 *
 * 目的: 这是本机单用户工具, 关掉网页之后后台 node 进程不应继续驻留。
 * 做法分两条路:
 * 1. 页面在关闭/刷新时发一次 close-intent(即时请求), 服务在 graceMs 后关停;
 *    如果这段时间内页面重新发来心跳(例如只是刷新), 关停被取消。
 * 2. 页面进程消失(崩溃、被强杀)时什么也不会发, 因此用空闲超时兜底:
 *    超过 idleTimeoutMs 没有心跳、且没有正在运行的原生会话, 才关停。
 *
 * 注意: 只要还有活跃会话, 空闲兜底不会生效, 避免把正在执行的任务按"网页关了"误杀;
 * 关闭页面前的确认由前端 beforeunload 负责, 用户确认后才会发 close-intent。
 */

export interface UiWatchdogOptions {
  /** false 时完全停用(HTTP 接口只报告状态, 不关停)。 */
  enabled: boolean;
  /** 收到 close-intent 后等待新心跳的时间。 */
  graceMs: number;
  /** 心跳中断多久后判定页面已经不存在。 */
  idleTimeoutMs: number;
  /**
   * 还没等到第一次心跳时的宽限: 用户可能先启动服务再去开浏览器。
   * 设 0(默认)表示"页面从未连上就一直等着", 不因为还没连上而退出。
   */
  firstHeartbeatTimeoutMs?: number;
  /** 当前活跃原生会话数。 */
  activeSessions: () => number;
  /** 真正执行关停的回调(应当幂等)。 */
  onStop: (reason: UiStopReason) => void | Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export type UiStopReason = 'ui_closed' | 'ui_gone' | 'ui_never_connected';

export interface UiRuntimeStatus {
  exitOnUiClose: boolean;
  lastHeartbeatAgoMs: number | null;
  pendingStopInMs: number | null;
  activeSessions: number;
  stopped: boolean;
  /** 是否已经有过网页连接(没有时不会按"心跳中断"关停)。 */
  pageSeen: boolean;
}

/** HTTP 层依赖的最小接口, 便于单独测试。 */
export interface RuntimeControl {
  noteHeartbeat(): void;
  requestClose(): { scheduled: boolean; delayMs: number | null; reason?: string };
  status(): UiRuntimeStatus;
}

export class UiWatchdog {
  private lastHeartbeatAt: number | null = null;
  private readonly startedAt: number;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingAt: number | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: UiWatchdogOptions) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** 页面发来心跳: 记录时间, 并取消已经排队的关停(刷新场景)。 */
  noteHeartbeat(): void {
    this.lastHeartbeatAt = this.now();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingAt = null;
      this.options.log?.('页面重新连接, 已取消排队中的关停。');
    }
  }

  /** 页面即将关闭: 排队关停。 */
  requestClose(): { scheduled: boolean; delayMs: number | null; reason?: string } {
    if (!this.options.enabled) return { scheduled: false, delayMs: null, reason: 'disabled' };
    if (this.stopped) return { scheduled: false, delayMs: null, reason: 'already_stopping' };
    const graceMs = Math.max(0, this.options.graceMs);
    if (this.pendingTimer) return { scheduled: true, delayMs: this.pendingAt ? Math.max(0, this.pendingAt - this.now()) : graceMs };

    this.pendingAt = this.now() + graceMs;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingAt = null;
      this.options.log?.('页面已关闭, 开始关停后台服务。');
      void this.stop('ui_closed');
    }, graceMs);
    this.pendingTimer.unref?.();
    return { scheduled: true, delayMs: graceMs };
  }

  /** 周期检查: 心跳长时间中断且没有活跃会话时关停。 */
  tick(): void {
    if (!this.options.enabled || this.stopped || this.pendingTimer) return;
    if (this.lastHeartbeatAt === null) {
      // 还没有任何页面连上来: 默认一直等(用户可能还没打开浏览器)。
      const limit = this.options.firstHeartbeatTimeoutMs ?? 0;
      if (limit <= 0) return;
      const waited = this.now() - this.startedAt;
      if (waited >= limit) {
        this.options.log?.(`启动后 ${Math.round(waited / 1000)}s 没有页面连接, 关停后台服务。`);
        void this.stop('ui_never_connected');
      }
      return;
    }
    const idle = this.now() - this.lastHeartbeatAt;
    if (idle < this.options.idleTimeoutMs) return;
    if (this.options.activeSessions() > 0) return;
    this.options.log?.(`页面心跳已中断 ${Math.round(idle / 1000)}s 且无活跃会话, 关停后台服务。`);
    void this.stop('ui_gone');
  }

  status(): UiRuntimeStatus {
    return {
      exitOnUiClose: this.options.enabled,
      lastHeartbeatAgoMs: this.lastHeartbeatAt === null ? null : this.now() - this.lastHeartbeatAt,
      pendingStopInMs: this.pendingAt === null ? null : Math.max(0, this.pendingAt - this.now()),
      activeSessions: this.options.activeSessions(),
      stopped: this.stopped,
      pageSeen: this.lastHeartbeatAt !== null,
    };
  }

  private async stop(reason: UiStopReason): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.options.onStop(reason);
    } catch (err) {
      this.options.log?.(`关停失败: ${(err as Error).message}`);
    }
  }
}
