import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import type { ManagedSession, Participant, RunAttempt, TaskPhase, WorkItem } from '../../../../packages/contracts/src/types';
import { ITEM_LABEL, PHASE_LABEL, duration, initials } from '../lib/format';

export type GraphSelection = { kind: 'participant'; id: string } | { kind: 'artifact'; id: string } | null;

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

const PAD = 28;
const GAP = 22;
const ROOT_W = 392;
const ROOT_H = 128;
const CARD_MIN = 178;
const CARD_MAX = 268;
const CARD_BASE = 122;
const WORK_LINE = 23;
const MAX_WORKS = 4;
const GUTTER_TOP = 78;
const GUTTER_BOTTOM = 88;

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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(920);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 60) setWidth(Math.round(rect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const seats = useMemo(() => buildSeats(detail, events), [detail, events]);
  const plan = useMemo(() => buildPlan(detail, seats, width), [detail, seats, width]);
  const running = seats.some((s) => s.tone === 'run');
  const now = useNow(running);

  const counts = {
    run: seats.filter((s) => s.tone === 'run').length,
    queue: detail.workItems.filter((w) => ['pending', 'ready', 'queued'].includes(w.state)).length,
    review: detail.workItems.filter((w) => ['awaiting_review', 'verifying'].includes(w.state)).length,
    accepted: detail.workItems.filter((w) => w.state === 'accepted').length,
    total: detail.workItems.length,
  };

  return (
    <div className="cx" ref={wrapRef}>
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

      <div className="cx-scroll">
        <div className="cx-plane" style={{ width: plan.w, height: plan.h }}>
          <svg className="cx-links" width={plan.w} height={plan.h} viewBox={`0 0 ${plan.w} ${plan.h}`} aria-hidden="true">
            <defs>
              {ACCENTS.map((c, i) => (
                <marker key={i} id={`cx-arrow-${i}`} viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M 0 0.7 L 6.6 4 L 0 7.3 z" fill={c} opacity="0.7" />
                </marker>
              ))}
            </defs>
            {plan.links.map((l) => (
              <g key={l.key}>
                <path
                  d={l.d}
                  className={`cx-link ${l.active ? 'active' : ''}`}
                  style={{ stroke: l.color }}
                  markerEnd={l.arrow ? `url(#cx-arrow-${l.index % ACCENTS.length})` : undefined}
                />
                {l.active ? (
                  <circle className="cx-packet" r="2.6" style={{ fill: l.color }}>
                    <animateMotion dur="2.2s" repeatCount="indefinite" path={l.d} />
                  </circle>
                ) : null}
              </g>
            ))}
          </svg>

          {plan.columns.map((col) => (
            <div key={col.key} className="cx-col" style={{ left: col.x, width: col.w }} aria-label={col.title}>
              <div className="cx-col-head">
                <span className="cx-col-title">{col.title}</span>
                <span className="cx-col-count">{col.count}</span>
              </div>
              <div className="cx-col-body">
                {col.cards.map((c) =>
                  c.seat ? (
                    <SeatCard
                      key={c.key}
                      seat={c.seat}
                      height={c.h}
                      now={now}
                      selected={selection?.kind === 'participant' && selection.id === (c.seat as Seat).participant.id}
                      onSelect={() => onSelect({ kind: 'participant', id: (c.seat as Seat).participant.id })}
                    />
                  ) : (
                    <div key={c.key} className={`cx-card plain ${c.tone ?? ''}`} style={{ height: c.h }}>
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
            </div>
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
  seat,
  height,
  now,
  selected,
  onSelect,
}: {
  seat: Seat;
  height: number;
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
      className={`cx-card ${seat.tone} ${seat.root ? 'root' : ''} ${selected ? 'selected' : ''}`}
      style={{ height }}
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
  h: number;
  title?: string;
  sub?: string;
  meta?: string;
  glyph?: string;
  tone?: Tone;
  tag?: string;
  accent?: string;
  accentSoft?: string;
}

interface Column {
  key: string;
  title: string;
  count: number;
  x: number;
  w: number;
  cards: CardModel[];
}

interface LinkPath {
  key: string;
  d: string;
  color: string;
  index: number;
  active: boolean;
  arrow: boolean;
}

interface Plan {
  w: number;
  h: number;
  columns: Column[];
  links: LinkPath[];
}

interface Box {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 并列列布局(参考 Lancer 的编排画布):
 * 主控/规划 → 执行者 → 审核席位 → 交付物 各占一列, 列内卡片自上而下堆叠,
 * 连线只在列间的竖直空隙(gutter)里走, 因此天然不会压到任何卡片。
 */
function buildPlan(detail: TaskDetail, seats: Seat[], width: number): Plan {
  const lead = seats.find((s) => s.root) ?? null;
  const workers = seats.filter((s) => !s.root && s.participant.role === 'worker');
  const strongs = seats.filter((s) => !s.root && s.participant.role === 'strong');
  const done = detail.task.lifecycle === 'completed';
  const hasDeliver = detail.artifacts.length > 0 || detail.reviewRounds.length > 0 || done || detail.task.phase === 'delivery';

  const raw: { key: string; title: string; cards: CardModel[] }[] = [];

  if (lead) {
    const cards: CardModel[] = [{ key: `seat-${lead.key}`, seat: lead, h: 132 }];
    if (detail.plan) {
      const planLive = detail.task.lifecycle === 'awaiting_plan_approval' ? 'wait' : detail.plan.status === 'approved' ? 'ok' : 'idle';
      cards.push({
        key: 'plan-card',
        seat: null,
        h: 96,
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
    raw.push({ key: 'plan', title: '主控 / 规划', cards });
  }

  if (workers.length > 0) {
    raw.push({
      key: 'exec',
      title: '执行者',
      cards: workers.map((w) => ({ key: `seat-${w.key}`, seat: w, h: workerCardHeight(w) })),
    });
  }

  if (strongs.length > 0) {
    raw.push({
      key: 'review',
      title: '审核席位',
      cards: strongs.map((s) => ({ key: `seat-${s.key}`, seat: s, h: 132 })),
    });
  }

  if (hasDeliver) {
    raw.push({
      key: 'deliver',
      title: '交付',
      cards: [
        {
          key: 'deliver-card',
          seat: null,
          h: 104,
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

  const n = Math.max(1, raw.length);
  const gutter = n >= 4 ? (width < 820 ? 38 : 48) : n > 2 ? 60 : 78;
  const available = width - PAD * 2 - gutter * (n - 1);
  const minW = width < 820 ? 138 : 168;
  const colW = Math.max(minW, Math.min(300, Math.floor(available / n)));
  const spanW = n * colW + (n - 1) * gutter;
  const planeW = Math.max(width, spanW + PAD * 2);
  const left = Math.round((planeW - spanW) / 2);

  const columns: Column[] = raw.map((c, i) => ({
    key: c.key,
    title: c.title,
    count: c.cards.length,
    x: left + i * (colW + gutter),
    w: colW,
    cards: c.cards,
  }));

  // 卡片纵向堆叠, 记下每张卡的中心 y 供连线使用
  const boxes = new Map<string, Box>();
  const headH = 26;
  let maxBottom = 0;
  for (const col of columns) {
    let y = headH + 6;
    for (const card of col.cards) {
      const h = Math.min(card.h, 240);
      const x = col.x;
      boxes.set(card.key, { key: card.key, x, y, w: colW, h });
      y += h + 12;
    }
    maxBottom = Math.max(maxBottom, y);
  }

  // 连线只画在列间空隙: 来源卡的右边缘连到目标卡的左边缘, 控制点取空隙中线,
  // 曲线整体停留在两列之间, 因此不会压到任何卡片, 也不需要绕行。
  const links: LinkPath[] = [];
  for (let i = 0; i < columns.length - 1; i += 1) {
    const fromCol = columns[i];
    const toCol = columns[i + 1];
    if (fromCol.cards.length === 0 || toCol.cards.length === 0) continue;
    const pairs = fromCol.cards.length * toCol.cards.length;
    const targets = pairs > 9 ? [toCol.cards[0]] : toCol.cards;
    // 计划卡是信息卡, 不作为连线起点, 否则同一列会射出双倍曲线。
    const seatCards = fromCol.cards.filter((c) => c.seat !== null);
    const sources = seatCards.length > 0 ? seatCards : fromCol.cards;
    sources.forEach((src, si) => {
      const sb = boxes.get(src.key);
      if (!sb) return;
      targets.forEach((dst, di) => {
        const tb = boxes.get(dst.key);
        if (!tb) return;
        const x1 = sb.x + sb.w;
        const y1 = sb.y + Math.min(sb.h, 56) / 2 + 8;
        const x2 = tb.x - 2;
        const y2 = tb.y + Math.min(tb.h, 56) / 2 + 8;
        const mid = (x1 + x2) / 2;
        links.push({
          key: `l-${fromCol.key}-${src.key}-${dst.key}`,
          d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
          color: src.seat?.accent ?? src.accent ?? 'var(--line-3)',
          index: si + di,
          active: (src.seat?.tone ?? src.tone) === 'run' || (dst.seat?.tone ?? dst.tone) === 'run',
          arrow: true,
        });
      });
    });
  }

  return { w: planeW, h: maxBottom + 12, columns, links };
}

function workerCardHeight(seat: Seat): number {
  const rows = Math.min(3, seat.works.length);
  return 116 + rows * WORK_LINE + (rows > 0 ? 8 : 0);
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
