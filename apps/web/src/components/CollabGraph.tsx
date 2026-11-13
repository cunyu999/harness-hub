import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import type { ManagedSession, Participant, RunAttempt, TaskPhase, WorkItem } from '../../../../packages/contracts/src/types';
import { PHASE_LABEL, duration, tokens } from '../lib/format';

export type GraphSelection =
  | { kind: 'participant'; id: string }
  | { kind: 'plan' }
  | { kind: 'delivery' }
  | null;

type Tone = 'run' | 'wait' | 'ok' | 'bad' | 'idle';

/** 每个席位一个色相, 连线与卡片圆点同色; 状态色另行表达, 两者不混用。 */
const ACCENTS = ['#8b7bff', '#2fb8a6', '#d99435', '#5b8def', '#d4709d', '#4aa96c'];
const ACCENT_SOFT = [
  'rgba(139, 123, 255, .14)',
  'rgba(47, 184, 166, .14)',
  'rgba(217, 148, 53, .14)',
  'rgba(91, 141, 239, .14)',
  'rgba(212, 112, 157, .14)',
  'rgba(74, 169, 108, .14)',
];

const HARNESS_SHORT: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude',
  dsh: 'DSH',
  mock: 'Mock',
};

const PHASE_STEPS: TaskPhase[] = ['planning', 'discussion', 'execution', 'integration', 'verification', 'review', 'delivery'];

interface Seat {
  key: string;
  participant: Participant;
  name: string;
  roleLabel: string;
  harness: string;
  model: string;
  accent: string;
  tone: Tone;
  stateLabel: string;
  elapsedMs: number | null;
  /** 该席位累计 token 用量(已结算回合)。 */
  usageTokens: number;
  works: WorkItem[];
  session: ManagedSession | null;
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

interface NodeModel {
  key: string;
  kind: 'root' | 'seat' | 'plan' | 'delivery';
  seat: Seat | null;
  title: string;
  sub: string;
  big: string;
  foot: string;
  pct: number | null;
  tone: Tone;
  accent: string;
  segments: { color: string; flex: number }[];
  select?: 'plan' | 'delivery';
}

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

interface Wire {
  key: string;
  d: string;
  color: string;
  active: boolean;
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
  const running = seats.some((s) => s.tone === 'run' || s.tone === 'wait') === false ? false : seats.some((s) => s.tone === 'run');
  const now = useNow(seats.some((s) => s.tone === 'run'));

  const lead = useMemo(() => seats.find((s) => s.root) ?? null, [seats]);
  const others = useMemo(() => seats.filter((s) => !s.root), [seats]);
  const done = detail.task.lifecycle === 'completed';
  const hasDeliver =
    detail.artifacts.length > 0 || detail.reviewRounds.length > 0 || done || detail.task.phase === 'delivery';

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const cr = canvas.getBoundingClientRect();
      const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
      canvas.querySelectorAll<HTMLElement>('[data-ck]').forEach((el) => {
        const key = el.dataset.ck;
        if (!key) return;
        const r = el.getBoundingClientRect();
        pos.set(key, { x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
      });

      const out: Wire[] = [];
      const fromKey = lead ? `seat-${lead.key}` : null;
      const From = fromKey ? pos.get(fromKey) : null;
      const plan = pos.get('plan-card') ?? null;
      const deliver = pos.get('deliver-card') ?? null;


      if (fromKey && From) {
        others.forEach((s, i) => {
          const P = pos.get(`seat-${s.key}`);
          if (!P) return;
          // 出口按序号均分主控卡底边, 进口落在子卡顶边中点: 多席位时是扇形, 不重叠。
          const sx = From.x + (From.w * (i + 1)) / (others.length + 1);
          out.push({
            key: `${fromKey}->seat-${s.key}`,
            d: curve(sx, From.y + From.h, P.x + P.w / 2, P.y),
            color: s.accent,
            active: s.tone === 'run' || (lead?.tone ?? 'idle') === 'run',
          });
        });
      }

      if (hasDeliver && deliver) {
        if (others.length === 0 && From) {
          // 单席位任务: 主控直接落到交付节点, 保证图始终连通。
          out.push({
            key: 'lead->deliver-card',
            d: curve(From.x + From.w / 2, From.y + From.h, deliver.x + deliver.w / 2, deliver.y),
            color: 'var(--ok)',
            active: lead?.tone === 'run',
          });
        }
        others.forEach((s, i) => {
          const P = pos.get(`seat-${s.key}`);
          if (!P) return;
          // 入口按序号均分交付卡顶边, 两条线不会挤在同一点。
          const tx = deliver.x + (deliver.w * (i + 1)) / (others.length + 1);
          out.push({
            key: `seat-${s.key}->deliver-card`,
            d: curve(P.x + P.w / 2, P.y + P.h, tx, deliver.y),
            color: s.accent,
            active: s.tone === 'run',
          });
        });
      }

      setWires((prev) => {
        const same =
          prev.length === out.length &&
          prev.every((p, i) => p.key === out[i].key && p.d === out[i].d && p.color === out[i].color && p.active === out[i].active);
        return same ? prev : out;
      });
      const nextBox = { w: canvas.scrollWidth, h: canvas.scrollHeight };
      setBox((prev) => (prev.w === nextBox.w && prev.h === nextBox.h ? prev : nextBox));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [seats, lead, others, hasDeliver]);

  const counts = {
    run: seats.filter((s) => s.tone === 'run').length,
    queue: detail.workItems.filter((w) => ['pending', 'ready', 'queued'].includes(w.state)).length,
    review: detail.workItems.filter((w) => ['awaiting_review', 'verifying'].includes(w.state)).length,
    accepted: detail.workItems.filter((w) => w.state === 'accepted').length,
    total: detail.workItems.length,
  };

  const planNode: NodeModel | null = detail.plan
    ? {
        key: 'plan-card',
        kind: 'plan',
        seat: null,
        title: `计划 v${detail.plan.number}`,
        sub: `${detail.plan.content.workItems.length} 个工作项 · ${detail.plan.content.deliverables.length} 份交付物`,
        big: detail.plan.contentHash.slice(0, 10),
        foot:
          detail.task.lifecycle === 'awaiting_plan_approval'
            ? '等待你确认'
            : detail.plan.status === 'approved'
              ? '已批准'
              : detail.plan.status,
        pct: null,
        tone: detail.task.lifecycle === 'awaiting_plan_approval' ? 'wait' : detail.plan.status === 'approved' ? 'ok' : 'idle',
        accent: 'var(--accent)',
        segments: [],
        select: 'plan',
      }
    : null;

  const deliverNode: NodeModel | null = hasDeliver
    ? {
        key: 'deliver-card',
        kind: 'delivery',
        seat: null,
        title: '交付物',
        sub: `${detail.artifacts.length} 个登记文件 · ${detail.reviewRounds.length} 轮审核`,
        big: `工作项 ${counts.accepted}/${counts.total}`,
        foot: done ? '已交付 · 见「产物」页签' : '收集中',
        pct: counts.total > 0 ? Math.round((counts.accepted / counts.total) * 100) : null,
        tone: done ? 'ok' : 'wait',
        accent: 'var(--ok)',
        segments: [],
        select: 'delivery',
      }
    : null;

  return (
    <div className="cy">
      <div className="cy-head">
        <PhaseStepper phase={detail.task.phase} lifecycle={detail.task.lifecycle} />
        <div className="cy-summary">
          {planNode && detail.task.lifecycle === 'awaiting_plan_approval' ? (
            <span className="cy-pill wait">
              <span className="cy-pill-dot" />
              计划 v{detail.plan?.number} 待确认
            </span>
          ) : null}
          <span className={`cy-pill ${running ? 'live' : ''}`}>
            <span className="cy-pill-dot" />
            {running ? '会话进行中' : '当前无运行会话'}
          </span>
          <span className="cy-stat">
            <b>{counts.run}</b> 运行
          </span>
          <span className="cy-stat">
            <b>{counts.queue}</b> 排队
          </span>
          {counts.review > 0 ? (
            <span className="cy-stat">
              <b>{counts.review}</b> 待审核
            </span>
          ) : null}
          {counts.total > 0 ? (
            <span className="cy-stat">
              <b>{counts.accepted}</b>/{counts.total} 已接受
            </span>
          ) : null}
        </div>
      </div>

      <div className="cy-scroll">
        <div className="cy-canvas" ref={canvasRef}>
          {box.w > 0 && wires.length > 0 ? (
            <svg className="cy-wire" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
              <defs>
                <marker
                  id="cy-arrow"
                  viewBox="0 0 8 8"
                  refX="7.2"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0.6 0.8 L7.2 4 L0.6 7.2 Z" fill="context-stroke" />
                </marker>
              </defs>
              {wires.map((w) => (
                <g key={w.key} className={w.active ? 'active' : ''}>
                  <path d={w.d} className="cy-wire-glow" style={{ stroke: w.color }} />
                  <path d={w.d} className="cy-wire-path" style={{ stroke: w.color }} markerEnd="url(#cy-arrow)" />
                  {w.active ? (
                    <circle r="2.4" className="cy-spark" style={{ fill: w.color }}>
                      <animateMotion dur="2.6s" repeatCount="indefinite" path={w.d} />
                    </circle>
                  ) : null}
                </g>
              ))}
            </svg>
          ) : null}

          <div className="cy-tier cy-tier-root">
            {lead ? (
              <NodeCard
                node={nodeOfSeat(lead)}
                now={now}
                selected={selection?.kind === 'participant' && selection.id === lead.participant.id}
                onSelect={() => onSelect({ kind: 'participant', id: lead.participant.id })}
              />
            ) : null}
            {planNode ? (
              <NodeCard
                node={planNode}
                now={now}
                selected={selection?.kind === 'plan'}
                onSelect={() => onSelect({ kind: 'plan' })}
              />
            ) : null}
          </div>

          {others.length > 0 ? (
            <div className="cy-tier cy-tier-seats">
              {others.map((s, i) => (
                <NodeCard
                  key={s.key}
                  node={nodeOfSeat(s, i)}
                  now={now}
                  selected={selection?.kind === 'participant' && selection.id === s.participant.id}
                  onSelect={() => onSelect({ kind: 'participant', id: s.participant.id })}
                />
              ))}
            </div>
          ) : null}

          {deliverNode ? (
            <div className="cy-tier cy-tier-deliver">
              <NodeCard
                node={deliverNode}
                now={now}
                selected={selection?.kind === 'delivery'}
                onSelect={() => onSelect({ kind: 'delivery' })}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="cy-legend">
        {(['run', 'wait', 'ok', 'bad', 'idle'] as Tone[]).map((t) => (
          <span key={t} className="cy-key">
            <span className={`cy-state-dot ${t}`} />
            {t === 'run' ? '运行中' : t === 'wait' ? '等待' : t === 'ok' ? '已完成' : t === 'bad' ? '失败' : '未开始'}
          </span>
        ))}
        <span className="cy-note">节点、连线与动效均由服务端事件与会话状态推导, 无模拟动画</span>
      </div>
    </div>
  );
}

/** 父 → 子: 从父卡底边中点弯到子卡顶边中点, 控制点只落在两排之间的空隙里。 */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const gap = Math.max(28, y2 - y1);
  const c1 = y1 + gap * 0.55;
  const c2 = y2 - gap * 0.55;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${c1.toFixed(1)}, ${x2.toFixed(1)} ${c2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}


function stateColor(state: string): string {
  if (state === 'accepted') return 'var(--ok)';
  if (state === 'running' || state === 'verifying') return 'var(--accent-2)';
  if (state === 'awaiting_review') return 'var(--accent)';
  if (state === 'failed' || state === 'invalidated') return 'var(--bad)';
  return 'var(--line-2)';
}

function nodeOfSeat(seat: Seat, ordinal?: number): NodeModel {
  const total = seat.works.length;
  const accepted = seat.works.filter((w) => w.state === 'accepted').length;
  const elapsed = seat.elapsedMs === null ? '—' : duration(seat.elapsedMs);
  const last = seat.session ? shortAgo(seat.session.lastEventAt, Date.now()) : '—';
  return {
    key: `seat-${seat.key}`,
    kind: seat.root ? 'root' : 'seat',
    seat,
    title: ordinal === undefined ? seat.name : `${ORDINALS[ordinal] ?? ordinal + 1}、${seat.name}`,
    sub: `${seat.roleLabel} · ${HARNESS_SHORT[seat.harness] ?? seat.harness}${seat.model ? ` · ${seat.model}` : ''}`,
    big: `${elapsed} · ${
      total > 0 ? `${total} 项` : seat.root ? '调度' : seat.roleLabel === '强模型' ? '审核' : '待派发'
    }`,
    foot: `${seat.stateLabel} · ${last}${seat.usageTokens > 0 ? ` · ${tokens(seat.usageTokens)} tokens` : ''}`,
    pct: total > 0 ? Math.round((accepted / total) * 100) : null,
    tone: seat.tone,
    accent: seat.accent,
    segments: seat.works.slice(0, 8).map((w) => ({ color: stateColor(w.state), flex: 1 })),
  };
}

function NodeCard({
  node,
  now,
  selected,
  onSelect,
}: {
  node: NodeModel;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  void now;
  return (
    <button
      type="button"
      data-ck={node.key}
      data-seat={node.seat?.participant.id}
      className={`cy-card ${node.tone} ${node.kind} ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${node.title} ${node.sub}`}
    >
      <span className="cy-card-head">
        <span className="cy-card-dot" style={{ background: node.accent }} />
        <b title={node.title}>{node.title}</b>
        {node.tone === 'run' ? <span className="cy-now">当前</span> : null}
      </span>
      <span className="cy-card-sub" title={node.sub}>
        {node.sub}
      </span>
      <span className="cy-card-big">{node.big}</span>
      <span className="cy-bar">
        {node.segments.length > 0 ? (
          node.segments.map((s, i) => <span key={i} style={{ background: s.color, flex: s.flex }} />)
        ) : (
          <span style={{ background: 'var(--line-2)', flex: 1 }} />
        )}
      </span>
      <span className="cy-card-foot">
        <span>{node.foot}</span>
        {node.pct !== null ? <b className={`cy-pct ${node.pct > 0 ? 'on' : ''}`}>{node.pct}%</b> : null}
      </span>
    </button>
  );
}

/* ------------------------------ 阶段步进 ------------------------------ */

export function PhaseStepper({ phase, lifecycle }: { phase: TaskPhase; lifecycle: string }) {
  const idx = PHASE_STEPS.indexOf(phase);
  return (
    <ol className="cy-steps" aria-label="任务阶段">
      {PHASE_STEPS.map((step, i) => {
        const done = idx > i;
        const now = idx === i;
        return (
          <li key={step} className={`${done ? 'done' : ''} ${now ? 'now' : ''}`}>
            <span className="cy-step-dot">{done ? '✓' : ''}</span>
            <span className="cy-step-label">{PHASE_LABEL[step] ?? step}</span>
          </li>
        );
      })}
      {lifecycle === 'paused' ? <li className="cy-step-hold">已暂停</li> : null}
    </ol>
  );
}

/* ------------------------------ 数据推导 ------------------------------ */

function rank(state: string): number {
  const order = ['running', 'verifying', 'awaiting_review', 'queued', 'ready', 'pending', 'produced', 'accepted', 'failed'];
  const i = order.indexOf(state);
  return i < 0 ? 99 : i;
}

function shortAgo(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  return `${Math.round(s / 3600)}h 前`;
}

function buildSeats(detail: TaskDetail, events: EventEnvelope[]): Seat[] {
  const items = detail.workItems;
  const sessions = [...detail.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const openSessions = sessions.filter((s) => !s.closedAt);

  const sessionFor = (participantId: string) =>
    openSessions.find((s) => s.participantId === participantId) ??
    sessions.find((s) => s.participantId === participantId) ??
    null;

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
    const liveItem = item && (item.state === 'running' || item.state === 'verifying') ? item : null;

    if (liveAttempt || liveItem) {
      tone = 'run';
      stateLabel = liveItem?.state === 'verifying' ? '验证中' : '执行中';
    } else if (session && !session.closedAt) {
      if (session.connectionState === 'disconnected' || session.processHealth === 'exited') {
        tone = 'bad';
        stateLabel = '已断开';
      } else if (session.activity === 'no_recent_event') {
        tone = 'wait';
        stateLabel = '无新事件';
      } else if (session.activity === 'generating' || session.activity === 'tool_running') {
        tone = 'run';
        stateLabel = tool ? `工具 ${tool}` : '生成中';
      } else {
        tone = 'idle';
        stateLabel = '空闲';
      }
    } else if (attempts.length > 0) {
      const last = attempts[0];
      if (last.status === 'completed') {
        tone = 'ok';
        stateLabel = '已完成';
      } else if (last.status === 'failed' || last.status === 'interrupted') {
        tone = 'bad';
        stateLabel = '失败';
      } else {
        tone = 'wait';
        stateLabel = '等待';
      }
    } else if (item) {
      if (item.state === 'accepted') {
        tone = 'ok';
        stateLabel = '已完成';
      } else if (item.state === 'awaiting_review') {
        tone = 'wait';
        stateLabel = '待审核';
      } else if (item.state === 'failed' || item.state === 'invalidated') {
        tone = 'bad';
        stateLabel = '失败';
      } else {
        tone = 'wait';
        stateLabel = '排队中';
      }
    }

    // 已结束的席位也要看得到"花了多久": 没有活着的尝试时, 累加历史尝试时长
    const spentMs = attempts.reduce((sum, a) => {
      const start = new Date(a.startedAt).getTime();
      const end = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
      return sum + Math.max(0, end - start);
    }, 0);
    const elapsedMs = attempts.length > 0 ? spentMs : null;
    const usageTokens = detail.usage.byParticipant[p.id]?.total ?? 0;
    const roleLabel = p.isLead ? '主控' : p.role === 'strong' ? '强模型' : '执行者';

    return {
      key: p.id,
      participant: p,
      name: p.displayName,
      roleLabel,
      harness: profile?.adapterId ?? 'unknown',
      model: profile?.requestedModel || profile?.name || '',
      accent: ACCENTS[index % ACCENTS.length],
      tone,
      stateLabel,
      elapsedMs,
      usageTokens,
      works,
      session,
      root: Boolean(p.isLead),
    };
  });
}

void ACCENT_SOFT;
