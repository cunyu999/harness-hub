import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import type { ManagedSession, Participant, RunAttempt, TaskPhase, WorkItem } from '../../../../packages/contracts/src/types';
import { ITEM_LABEL, PHASE_LABEL, duration, initials } from '../lib/format';

export type GraphSelection =
  | { kind: 'participant'; id: string }
  | { kind: 'plan' }
  | { kind: 'delivery' }
  | null;

type Tone = 'run' | 'wait' | 'ok' | 'bad' | 'idle';
type ItemState = keyof typeof ITEM_LABEL;

/** 每个席位一个色相, 同时用于卡片左侧色条与它的连线; 状态色另行表达, 两者不混用。 */
const ACCENTS = ['#8b7bff', '#2fb8a6', '#d99435', '#5b8def', '#d4709d', '#4aa96c'];
const ACCENT_SOFT = [
  'rgba(139, 123, 255, .13)',
  'rgba(47, 184, 166, .13)',
  'rgba(217, 148, 53, .13)',
  'rgba(91, 141, 239, .13)',
  'rgba(212, 112, 157, .13)',
  'rgba(74, 169, 108, .13)',
];

const HARNESS_SHORT: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude',
  dsh: 'DSH',
  mock: 'Mock',
};

const PHASE_STEPS: TaskPhase[] = ['planning', 'discussion', 'execution', 'integration', 'verification', 'review', 'delivery'];

const MAX_WORKS = 4;

interface Seat {
  key: string;
  participant: Participant;
  name: string;
  roleLabel: string;
  harness: string;
  model: string;
  accent: string;
  accentSoft: string;
  tone: Tone;
  stateLabel: string;
  doing: string;
  elapsedMs: number | null;
  works: WorkItem[];
  item: WorkItem | null;
  session: ManagedSession | null;
  attempt: RunAttempt | null;
  root: boolean;
}

/** 有活动时每 900ms 刷新一次, 让耗时自然增长; 无活动不启动定时器。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 900);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function CollabGraph({
  detail,
  events,
  selection,
  onSelect,
}: {
  detail: TaskDetail;
  events: EventEnvelope[];
  selection: GraphSelection;
  onSelect: (s: GraphSelection) => void;
}) {
  const seats = useMemo(() => buildSeats(detail, events), [detail, events]);
  const stages = useMemo(() => buildStages(detail, seats), [detail, seats]);
  const running = seats.some((s) => s.tone === 'run');
  const now = useNow(running);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [wireBox, setWireBox] = useState({ w: 0, h: 0 });

  // 连线坐标只能量出来: 阶段内部是 CSS 网格自动换行, 不量就不知道卡片落在哪
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const cr = canvas.getBoundingClientRect();
      const box = new Map<string, { x: number; y: number; w: number; h: number }>();
      canvas.querySelectorAll<HTMLElement>('[data-ck]').forEach((el) => {
        const key = el.dataset.ck;
        if (!key) return;
        const r = el.getBoundingClientRect();
        box.set(key, { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
      });
      setWires(buildWires(stages, box));
      setWireBox({ w: canvas.scrollWidth, h: canvas.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [stages]);

  const counts = {
    run: seats.filter((s) => s.tone === 'run').length,
    queue: detail.workItems.filter((w) => ['pending', 'ready', 'queued'].includes(w.state)).length,
    review: detail.workItems.filter((w) => ['awaiting_review', 'verifying'].includes(w.state)).length,
    accepted: detail.workItems.filter((w) => w.state === 'accepted').length,
    total: detail.workItems.length,
  };

  return (
    <div className="cx">
      <div className="cx-head">
        <PhaseStepper phase={detail.task.phase} lifecycle={detail.task.lifecycle} />
        <div className="cx-summary">
          {detail.task.lifecycle === 'awaiting_plan_approval' && detail.plan ? (
            <span className="cx-pill wait">
              <span className="cx-dot" />
              计划 v{detail.plan.number} 待确认
            </span>
          ) : null}
          <span className={`cx-pill ${running ? 'live' : ''}`}>
            <span className="cx-dot" />
            {running ? '会话进行中' : '当前无运行会话'}
          </span>
          <span className="cx-stat">
            <b>{counts.run}</b> 运行
          </span>
          <span className="cx-stat">
            <b>{counts.queue}</b> 排队
          </span>
          {counts.review > 0 ? (
            <span className="cx-stat">
              <b>{counts.review}</b> 待审核
            </span>
          ) : null}
          {counts.total > 0 ? (
            <span className="cx-stat">
              <b>{counts.accepted}</b>/{counts.total} 已接受
            </span>
          ) : null}
        </div>
      </div>

      <div className="cx-flow">
        <div className="cx-canvas" ref={canvasRef}>
          {wires.length > 0 && wireBox.w > 0 ? (
            <svg
              className="cx-wire"
              width={wireBox.w}
              height={wireBox.h}
              viewBox={`0 0 ${wireBox.w} ${wireBox.h}`}
              aria-hidden="true"
            >
              {wires.map((w) => (
                <g key={w.key} className={w.active ? 'active' : ''}>
                  <path d={w.d} className="cx-wire-glow" style={{ stroke: w.color }} />
                  <path d={w.d} className="cx-wire-path" style={{ stroke: w.color }} />
                  {w.active ? (
                    <circle r="2.6" className="cx-spark" style={{ fill: w.color }}>
                      <animateMotion dur="2.8s" repeatCount="indefinite" path={w.d} />
                    </circle>
                  ) : null}
                </g>
              ))}
            </svg>
          ) : null}
        {stages.map((stage, i) => (
          <section key={stage.key} className="cx-stage" aria-label={stage.title}>
            {i > 0 ? (
              <div className={`cx-arrow ${anyRunning(stage) || anyRunning(stages[i - 1]) ? 'active' : ''}`} aria-hidden="true">
                <span className="cx-arrow-label">{stage.inflow}</span>
              </div>
            ) : null}

            <header className="cx-stage-head">
              <span className="cx-stage-title">{stage.title}</span>
              <span className="cx-stage-count">{stage.cards.length}</span>
            </header>

            <div className="cx-stage-body">
              {stage.cards.map((c) =>
                c.seat ? (
                  <SeatCard
                    key={c.key}
                    ck={c.key}
                    seat={c.seat}
                    now={now}
                    selected={selection?.kind === 'participant' && selection.id === (c.seat as Seat).participant.id}
                    onSelect={() => onSelect({ kind: 'participant', id: (c.seat as Seat).participant.id })}
                  />
                ) : c.select ? (
                  <button
                    key={c.key}
                    data-ck={c.key}
                    type="button"
                    className={`cx-card plain clickable ${c.tone ?? ''} ${selection?.kind === c.select ? 'selected' : ''}`}
                    onClick={() => onSelect(c.select === 'plan' ? { kind: 'plan' } : { kind: 'delivery' })}
                    aria-label={(c.title ?? '') + ' 详情'}
                  >
                    <span className="cx-card-rail" style={{ background: c.accent ?? 'var(--line-3)' }} />
                    <span className="cx-card-top">
                      <span className="cx-avatar" style={{ background: c.accentSoft ?? 'var(--surface-2)', color: c.accent ?? 'var(--text-2)' }}>
                        {c.glyph}
                      </span>
                      <span className="cx-card-id">
                        <b>{c.title}</b>
                        <em title={c.sub}>{c.sub}</em>
                      </span>
                      {c.tone ? (
                        <span className={`cx-state ${c.tone}`}>
                          <span className={`cx-dot ${c.tone}`} />
                          {c.tag}
                        </span>
                      ) : null}
                    </span>
                    {c.meta ? <span className="cx-card-meta">{c.meta}</span> : null}
                    <span className="cx-card-more">查看详情 ›</span>
                  </button>
                ) : (
                  <div key={c.key} data-ck={c.key} className={`cx-card plain ${c.tone ?? ''}`}>
                    <span className="cx-card-rail" style={{ background: c.accent ?? 'var(--line-3)' }} />
                    <span className="cx-card-top">
                      <span className="cx-avatar" style={{ background: c.accentSoft ?? 'var(--surface-2)', color: c.accent ?? 'var(--text-2)' }}>
                        {c.glyph}
                      </span>
                      <span className="cx-card-id">
                        <b>{c.title}</b>
                        <em title={c.sub}>{c.sub}</em>
                      </span>
                      {c.tone ? (
                        <span className={`cx-state ${c.tone}`}>
                          <span className={`cx-dot ${c.tone}`} />
                          {c.tag}
                        </span>
                      ) : null}
                    </span>
                    {c.meta ? <span className="cx-card-meta">{c.meta}</span> : null}
                  </div>
                ),
              )}
            </div>
          </section>
        ))}
        </div>
      </div>

      <div className="cx-legend">
        {(['run', 'wait', 'ok', 'bad', 'idle'] as Tone[]).map((t) => (
          <span key={t} className="cx-key">
            <span className={`cx-dot ${t}`} />
            {t === 'run' ? '运行中' : t === 'wait' ? '等待' : t === 'ok' ? '已完成' : t === 'bad' ? '失败' : '未开始'}
          </span>
        ))}
        <span className="cx-note">节点、连线与动效均由服务端事件与会话状态推导, 无模拟动画</span>
      </div>
    </div>
  );
}

/* ------------------------------ 阶段步进 ------------------------------ */

export function PhaseStepper({ phase, lifecycle }: { phase: TaskPhase; lifecycle: string }) {
  const idx = PHASE_STEPS.indexOf(phase);
  return (
    <ol className="cx-steps" aria-label="任务阶段">
      {PHASE_STEPS.map((step, i) => {
        const done = idx > i;
        const now = idx === i;
        return (
          <li key={step} className={`${done ? 'done' : ''} ${now ? 'now' : ''}`}>
            <span className="cx-step-dot">{done ? '✓' : ''}</span>
            <span className="cx-step-label">{PHASE_LABEL[step] ?? step}</span>
          </li>
        );
      })}
      {lifecycle === 'paused' ? <li className="cx-step-hold">已暂停</li> : null}
    </ol>
  );
}

/* ------------------------------ 卡片 ------------------------------ */

function SeatCard({
  ck,
  seat,
  now,
  selected,
  onSelect,
}: {
  ck: string;
  seat: Seat;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const elapsed = seat.elapsedMs === null ? null : duration(seat.elapsedMs);
  const works = seat.works.slice(0, MAX_WORKS);
  const more = seat.works.length - works.length;

  return (
    <button
      type="button"
      data-seat={seat.participant.id}
      data-ck={ck}
      className={`cx-card ${seat.tone} ${seat.root ? 'root' : ''} ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${seat.name} ${seat.roleLabel} ${seat.stateLabel} ${seat.doing}`}
    >
      <span className="cx-card-rail" style={{ background: seat.accent }} />
      <span className="cx-card-top">
        <span className="cx-avatar" style={{ background: seat.accentSoft, color: seat.accent }}>
          {initials(seat.name)}
        </span>
        <span className="cx-card-id">
          <b>{seat.name}</b>
          <em title={`${seat.roleLabel} · ${seat.harness}${seat.model ? ` · ${seat.model}` : ''}`}>
            {seat.roleLabel} · {HARNESS_SHORT[seat.harness] ?? seat.harness}
            {seat.model ? ` · ${seat.model}` : ''}
          </em>
        </span>
        <span className={`cx-state ${seat.tone}`}>
          <span className={`cx-dot ${seat.tone}`} />
          {seat.stateLabel}
        </span>
      </span>

      <span className="cx-card-doing" title={seat.doing}>
        {seat.doing}
      </span>

      <span className="cx-card-meta">
        {seat.item ? `${ITEM_LABEL[seat.item.state as ItemState] ?? seat.item.state}` : '暂无工作项'}
        <span className="cx-sep">·</span>
        {elapsed && elapsed !== '—' ? `已用 ${elapsed}` : seat.session ? `空闲 · ${shortAgo(seat.session.lastEventAt, now)}` : '未启动会话'}
      </span>

      {works.length > 0 ? (
        <span className="cx-works">
          {works.map((w) => (
            <span className="cx-work" key={w.id}>
              <span className={`cx-work-dot ${w.state}`} />
              <span className="cx-work-goal" title={w.goal}>
                {w.goal}
              </span>
              <span className={`cx-work-state ${w.state}`}>{ITEM_LABEL[w.state as ItemState] ?? w.state}</span>
            </span>
          ))}
          {more > 0 ? <span className="cx-work-more">还有 {more} 项</span> : null}
        </span>
      ) : null}
    </button>
  );
}

function shortAgo(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  return `${Math.round(s / 3600)}h 前`;
}

/* ------------------------------ 布局 ------------------------------ */

interface CardModel {
  key: string;
  seat: Seat | null;
  /** 非席位卡(计划/交付)可被点开, 在右侧面板显示详情 */
  select?: 'plan' | 'delivery';
  title?: string;
  sub?: string;
  meta?: string;
  glyph?: string;
  tone?: Tone;
  tag?: string;
  accent?: string;
  accentSoft?: string;
}

interface Stage {
  key: string;
  title: string;
  cards: CardModel[];
  /** 从上一条阶段流到这一段的动作名, 画在阶段之间的空隙里 */
  inflow: string;
}

interface Wire {
  key: string;
  d: string;
  color: string;
  active: boolean;
}

/**
 * 阶段之间的连线: 从上一阶段每张卡的底边中点, 弯到下一阶段每张卡的顶边中点。
 * 全部是三次贝塞尔, 控制点只落在两阶段之间的走廊里, 因此不会压到卡片。
 */
function buildWires(
  stages: Stage[],
  box: Map<string, { x: number; y: number; w: number; h: number }>,
): Wire[] {
  const out: Wire[] = [];
  for (let i = 0; i < stages.length - 1; i += 1) {
    const from = stages[i].cards.filter((c) => c.seat !== null);
    const to = stages[i + 1].cards;
    if (from.length === 0 || to.length === 0) continue;

    const pairs: { a: CardModel; b: CardModel }[] = [];
    if (from.length * to.length <= 8) {
      for (const a of from) for (const b of to) pairs.push({ a, b });
    } else {
      // 太多对就每条目标卡只接最近的一两张来源卡, 避免糊成一团
      for (const b of to) {
        const B = box.get(b.key);
        const bx = B ? B.x + B.w / 2 : 0;
        const sorted = [...from].sort((p, q) => {
          const P = box.get(p.key);
          const Q = box.get(q.key);
          return Math.abs((P ? P.x + P.w / 2 : 0) - bx) - Math.abs((Q ? Q.x + Q.w / 2 : 0) - bx);
        });
        pairs.push({ a: sorted[0], b });
        if (sorted[1] && from.length > 2) pairs.push({ a: sorted[1], b });
      }
    }

    // 同一张卡发出多条线时, 起点沿底边铺开, 避免全部挤在中轴线上
    const bySource = new Map<string, { a: CardModel; b: CardModel }[]>();
    for (const pair of pairs) {
      const list = bySource.get(pair.a.key) ?? [];
      list.push(pair);
      bySource.set(pair.a.key, list);
    }

    for (const list of bySource.values()) {
      const A = box.get(list[0].a.key);
      if (!A) continue;
      const spread = Math.min(34, A.w * 0.3);
      list.forEach(({ a, b }, index) => {
        const B = box.get(b.key);
        if (!B) return;
        const offset = list.length === 1 ? 0 : ((index - (list.length - 1) / 2) / (list.length - 1)) * 2 * spread;
        const x1 = A.x + A.w / 2 + offset;
        const y1 = A.y + A.h;
        const x2 = B.x + B.w / 2;
        const y2 = B.y;
        const gap = Math.max(22, y2 - y1);
        const c1 = y1 + gap * 0.62;
        const c2 = y2 - gap * 0.62;
        out.push({
          key: `${a.key}->${b.key}`,
          d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${c1.toFixed(1)}, ${x2.toFixed(1)} ${c2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
          color: a.accent ?? 'var(--line-3)',
          active: (a.seat?.tone ?? 'idle') === 'run' || (b.seat?.tone ?? 'idle') === 'run',
        });
      });
    }
  }
  return out;
}

/**
 * 竖向阶段布局: 主控/规划 → 执行者 → 审核席位 → 交付, 阶段自上而下排列;
 * 阶段内部用网格自动换行(多执行者/多轮返工只会让阶段变高, 不会横向溢出),
 * 整块画布纵向滚动, 连线只画在阶段之间的空隙里, 因此不会压住任何卡片。
 */
function buildStages(detail: TaskDetail, seats: Seat[]): Stage[] {
  const lead = seats.find((s) => s.root) ?? null;
  const workers = seats.filter((s) => !s.root && s.participant.role === 'worker');
  const strongs = seats.filter((s) => !s.root && s.participant.role === 'strong');
  const done = detail.task.lifecycle === 'completed';
  const hasDeliver = detail.artifacts.length > 0 || detail.reviewRounds.length > 0 || done || detail.task.phase === 'delivery';

  const stages: Stage[] = [];

  if (lead) {
    const cards: CardModel[] = [{ key: `seat-${lead.key}`, seat: lead }];
    if (detail.plan) {
      const planLive = detail.task.lifecycle === 'awaiting_plan_approval' ? 'wait' : detail.plan.status === 'approved' ? 'ok' : 'idle';
      cards.push({
        key: 'plan-card',
        seat: null,
        select: 'plan',
        title: `计划 v${detail.plan.number}`,
        sub: `${detail.plan.content.workItems.length} 个工作项 · ${detail.plan.content.deliverables.length} 份交付物`,
        meta: `哈希 ${detail.plan.contentHash.slice(0, 10)} · ${planLive === 'wait' ? '待你确认' : planLive === 'ok' ? '已批准' : detail.plan.status}`,
        glyph: '计',
        tone: planLive as Tone,
        tag: planLive === 'wait' ? '待确认' : planLive === 'ok' ? '已批准' : '草稿',
        accent: 'var(--accent)',
        accentSoft: 'var(--accent-soft)',
      });
    }
    stages.push({ key: 'plan', title: '主控 / 规划', cards, inflow: '' });
  }

  if (workers.length > 0) {
    stages.push({
      key: 'exec',
      title: '执行者',
      cards: workers.map((w) => ({ key: `seat-${w.key}`, seat: w })),
      inflow: '派发',
    });
  }

  if (strongs.length > 0) {
    stages.push({
      key: 'review',
      title: '审核席位',
      cards: strongs.map((s) => ({ key: `seat-${s.key}`, seat: s })),
      inflow: '提交审核',
    });
  }

  if (hasDeliver) {
    stages.push({
      key: 'deliver',
      title: '交付',
      inflow: '交付',
      cards: [
        {
          key: 'deliver-card',
          select: 'delivery',
          seat: null,
          title: '交付物',
          sub: `${detail.artifacts.length} 个登记文件 · ${detail.reviewRounds.length} 轮审核`,
          meta: `工作项 ${detail.workItems.filter((w) => w.state === 'accepted').length}/${detail.workItems.length} 已接受 · 交付说明见「产物」页签`,
          glyph: '物',
          tone: done ? 'ok' : 'wait',
          tag: done ? '已交付' : '收集中',
          accent: 'var(--ok)',
          accentSoft: 'var(--ok-soft)',
        },
      ],
    });
  }

  return stages;
}

function anyRunning(stage: Stage): boolean {
  return stage.cards.some((c) => (c.seat?.tone ?? c.tone) === 'run');
}

/* ------------------------------ 数据推导 ------------------------------ */

function rank(state: string): number {
  const order = ['running', 'verifying', 'awaiting_review', 'queued', 'ready', 'pending', 'produced', 'accepted', 'failed'];
  const i = order.indexOf(state);
  return i < 0 ? 99 : i;
}

function buildSeats(detail: TaskDetail, events: EventEnvelope[]): Seat[] {
  const items = detail.workItems;
  const sessions = [...detail.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const openSessions = sessions.filter((s) => !s.closedAt);

  const sessionFor = (participantId: string) =>
    openSessions.find((s) => s.participantId === participantId) ?? sessions.find((s) => s.participantId === participantId) ?? null;

  const toolFor = (sessionId: string | null): string | null => {
    if (!sessionId) return null;
    const started = new Map<string, { tool: string; seq: number }>();
    for (const e of events) {
      if (e.sessionId !== sessionId) continue;
      const p = (e.payload ?? {}) as { toolName?: string; callId?: string };
      if (e.type === 'tool.started' && p.callId) started.set(p.callId, { tool: p.toolName ?? 'tool', seq: e.seq });
      else if (e.type === 'tool.completed' && p.callId) started.delete(p.callId);
    }
    const last = [...started.values()].sort((a, b) => b.seq - a.seq)[0];
    return last ? last.tool : null;
  };

  const ordered = [...detail.participants].sort((a, b) => (a.isLead === b.isLead ? 0 : a.isLead ? -1 : 1));

  return ordered.map((p, index) => {
    const profile = detail.profiles.find((x) => x.id === p.profileId) ?? null;
    const session = sessionFor(p.id);
    const attempts = detail.attempts
      .filter((a) => a.participantId === p.id)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const liveAttempt = attempts.find((a) => !a.endedAt) ?? null;
    const works = items
      .filter((w) => w.assignedParticipantId === p.id)
      .sort((a, b) => rank(a.state) - rank(b.state) || (a.createdAt < b.createdAt ? -1 : 1));
    const item = works[0] ?? null;
    const tool = toolFor(session?.id ?? null);

    let tone: Tone = 'idle';
    let stateLabel = '未启动';
    let doing = '尚未启动会话';

    const liveItem = item && (item.state === 'running' || item.state === 'verifying') ? item : null;

    if (liveAttempt || liveItem) {
      tone = 'run';
      stateLabel = liveItem?.state === 'verifying' ? '验证中' : '执行中';
      doing = tool ? `工具 ${tool}` : session?.activity === 'tool_running' ? '工具执行中' : (liveItem?.goal ?? '生成回复中…');
    } else if (session && !session.closedAt) {
      if (session.connectionState === 'disconnected' || session.processHealth === 'exited') {
        tone = 'bad';
        stateLabel = '已断开';
        doing = '连接已断开, 等待重新调度';
      } else if (session.activity === 'no_recent_event') {
        tone = 'wait';
        stateLabel = '无新事件';
        doing = `超过阈值无事件 · 最后 ${shortAgo(session.lastEventAt, Date.now())}`;
      } else if (session.activity === 'generating' || session.activity === 'tool_running') {
        tone = 'run';
        stateLabel = '运行中';
        doing = tool ? `工具 ${tool}` : '生成回复中…';
      } else {
        tone = 'idle';
        stateLabel = '空闲';
        doing = '会话空闲, 等待调度';
      }
    } else if (item) {
      if (item.state === 'accepted') {
        tone = 'ok';
        stateLabel = '已完成';
        doing = item.goal;
      } else if (item.state === 'awaiting_review') {
        tone = 'wait';
        stateLabel = '待审核';
        doing = `等待强模型审核 · ${item.goal}`;
      } else if (item.state === 'failed' || item.state === 'invalidated') {
        tone = 'bad';
        stateLabel = '失败';
        doing = item.lastError ?? '该工作项失败';
      } else {
        tone = 'wait';
        stateLabel = '排队中';
        doing = `等待派发 · ${item.goal}`;
      }
    }

    const elapsedMs = liveAttempt ? Date.now() - new Date(liveAttempt.startedAt).getTime() : null;
    const roleLabel = p.isLead ? '主控' : p.role === 'strong' ? '强模型' : '执行者';

    return {
      key: p.id,
      participant: p,
      name: p.displayName,
      roleLabel,
      harness: profile?.adapterId ?? 'unknown',
      model: profile?.requestedModel || profile?.name || '',
      accent: ACCENTS[index % ACCENTS.length],
      accentSoft: ACCENT_SOFT[index % ACCENT_SOFT.length],
      tone,
      stateLabel,
      doing,
      elapsedMs,
      works,
      item,
      session,
      attempt: liveAttempt,
      root: Boolean(p.isLead),
    };
  });
}
