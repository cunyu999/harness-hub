import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import type { ManagedSession, Participant, RunAttempt, TaskPhase, WorkItem } from '../../../../packages/contracts/src/types';
import { ACTIVITY_LABEL, ITEM_LABEL, PHASE_LABEL, duration, initials, shortId } from '../lib/format';

export type GraphSelection = { kind: 'participant'; id: string } | { kind: 'artifact'; id: string } | null;

type Tone = 'run' | 'wait' | 'ok' | 'bad' | 'idle';

interface AgentView {
  key: string;
  participant: Participant;
  roleLabel: string;
  harness: string;
  model: string;
  tone: Tone;
  stateLabel: string;
  doing: string;
  item: WorkItem | null;
  queue: WorkItem[];
  session: ManagedSession | null;
  attempt: RunAttempt | null;
  elapsedMs: number | null;
  badge?: string;
}

interface PlacedAgent {
  view: AgentView;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Chip {
  key: string;
  label: string;
  state: string;
  item: WorkItem;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
}

interface Lane {
  workerKey: string;
  y: number;
  h: number;
  chips: Chip[];
  endX: number;
  endY: number;
}

interface Link {
  key: string;
  d: string;
  tone: Tone;
  active: boolean;
  label?: string;
  labelX?: number;
  labelY?: number;
}

const PAD = 30;
const LEAD_W = 348;
const LEAD_H = 118;
const STRONG_W = 276;
const STRONG_H = 104;
const WORKER_W = 258;
const WORKER_H = 100;
const CHIP_W = 188;
const CHIP_H = 50;
const CHIP_GAP = 34;
const DELIVER_W = 336;
const DELIVER_H = 104;

const PHASE_STEPS: TaskPhase[] = ['planning', 'discussion', 'execution', 'integration', 'verification', 'review', 'delivery'];

/** 有活动时每 900ms 刷新一次, 让耗时自然增长; 无活动时不启动定时器。 */
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
  const [width, setWidth] = useState(960);

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

  const agents = useMemo(() => buildAgents(detail, events), [detail, events]);
  const layout = useMemo(() => buildLayout(detail, agents, width), [detail, agents, width]);
  const running = agents.some((a) => a.tone === 'run');
  const now = useNow(running);
  const reviewing = detail.workItems.filter((w) => w.state === 'awaiting_review' || w.state === 'verifying').length;
  const accepted = detail.workItems.filter((w) => w.state === 'accepted').length;

  const maxY = Math.max(
    ...layout.placed.map((p) => p.y + p.h),
    ...layout.lanes.map((l) => l.y + l.h),
    layout.deliver ? layout.deliver.y + layout.deliver.h : 0,
    240,
  );
  const height = maxY + PAD + 34;

  return (
    <div className="cv" ref={wrapRef}>
      <div className="cv-head">
        <PhaseStepper phase={detail.task.phase} lifecycle={detail.task.lifecycle} />
        <div className="cv-summary">
          {detail.task.lifecycle === 'awaiting_plan_approval' && detail.plan ? (
            <span className="cv-pill wait">
              <span className="cv-dot" />计划 v{detail.plan.number} 待确认
            </span>
          ) : null}
          <span className={`cv-pill ${running ? 'live' : ''}`}>
            <span className="cv-pulse" />
            {running ? '会话进行中' : '当前无运行会话'}
          </span>
          <span className="cv-stat">
            <b>{agents.filter((a) => a.tone === 'run').length}</b> 运行
          </span>
          <span className="cv-stat">
            <b>
              {
                detail.workItems.filter((w) => w.state === 'pending' || w.state === 'ready' || w.state === 'queued').length
              }
            </b>{' '}
            排队
          </span>
          {reviewing > 0 ? (
            <span className="cv-stat">
              <b>{reviewing}</b> 待审核
            </span>
          ) : null}
          <span className="cv-stat">
            <b>{accepted}</b>/{detail.workItems.length} 已接受
          </span>
        </div>
      </div>

      <div className="cv-canvas" style={{ height }}>
        {layout.lanes.map((lane, i) => (
          <div
            key={`band-${lane.workerKey}`}
            className="cv-lane"
            style={{ top: lane.y - 12, height: lane.h + 24 }}
            aria-hidden="true"
          >
            <span className="cv-lane-label">
              泳道 {i + 1}
              {lane.chips.length > 0 ? ` · ${lane.chips.length} 项` : ''}
            </span>
          </div>
        ))}

        <svg className="cv-links" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            <linearGradient id="cv-flow" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="55%" stopColor="var(--accent-2)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          {layout.links.map((l) => (
            <g key={l.key}>
              <path d={l.d} className={`cv-link ${l.tone} ${l.active ? 'active' : ''}`} id={l.key} />
              {l.active ? (
                <circle className="cv-packet" r="2.6">
                  <animateMotion dur="2.6s" repeatCount="indefinite" path={l.d} />
                </circle>
              ) : null}
              {l.label ? (
                <text className="cv-link-label" x={l.labelX} y={l.labelY} textAnchor="middle">
                  {l.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>

        {layout.placed.map(({ view, x, y, w, h }) => (
          <AgentCard
            key={view.key}
            view={view}
            x={x}
            y={y}
            w={w}
            h={h}
            now={now}
            selected={selection?.kind === 'participant' && selection.id === view.participant.id}
            onSelect={() => onSelect({ kind: 'participant', id: view.participant.id })}
          />
        ))}

        {layout.lanes.map((lane) =>
          lane.chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`cv-chip ${chip.state} ${chip.active ? 'active' : ''}`}
              style={{ left: chip.x, top: chip.y, width: chip.w, height: chip.h }}
              onClick={() => onSelect({ kind: 'participant', id: lane.workerKey.replace(/^p:/, '') })}
              title={`${chip.label} · ${ITEM_LABEL[chip.item.state as keyof typeof ITEM_LABEL] ?? chip.item.state}`}
            >
              <span className="cv-chip-goal">{chip.label}</span>
              <span className="cv-chip-meta">
                {ITEM_LABEL[chip.item.state as keyof typeof ITEM_LABEL] ?? chip.item.state}
                {chip.item.attemptCount > 1 ? ` · 第 ${chip.item.attemptCount} 次` : ''}
              </span>
            </button>
          )),
        )}

        {layout.deliver ? (
          <button
            type="button"
            className={`cv-agent deliver ${layout.deliver.tone}`}
            style={{ left: layout.deliver.x, top: layout.deliver.y, width: layout.deliver.w, height: layout.deliver.h }}
            onClick={() => onSelect({ kind: 'artifact', id: 'artifacts' })}
            aria-label="查看交付物"
          >
            <span className="cv-agent-top">
              <span className="cv-avatar deliver">◆</span>
              <span className="cv-agent-id">
                <b>交付物</b>
                <em>{layout.deliver.sub}</em>
              </span>
              <span className="cv-badge ok">产物</span>
            </span>
            <span className="cv-agent-doing">{layout.deliver.doing}</span>
          </button>
        ) : null}
      </div>

      <div className="cv-legend">
        <span className="cv-key run">运行中</span>
        <span className="cv-key wait">等待</span>
        <span className="cv-key ok">已完成</span>
        <span className="cv-key bad">失败</span>
        <span className="cv-key idle">未开始</span>
        <span className="cv-note">节点、连线与动效均由服务端事件与会话状态推导, 无模拟动画</span>
      </div>
    </div>
  );
}

/** 阶段步进: 当前阶段高亮, 已过阶段打勾, 停止/失败时整体降级。 */
export function PhaseStepper({ phase, lifecycle }: { phase: TaskPhase; lifecycle: string }) {
  const idx = PHASE_STEPS.indexOf(phase);
  const stopped = lifecycle !== 'active' && lifecycle !== 'awaiting_plan_approval';
  return (
    <ol className={`cv-steps ${stopped ? 'muted-step' : ''}`} aria-label="任务阶段">
      {PHASE_STEPS.map((p, i) => (
        <li key={p} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
          <span className="cv-step-dot">{i < idx ? '✓' : ''}</span>
          <span className="cv-step-label">{PHASE_LABEL[p]}</span>
        </li>
      ))}
    </ol>
  );
}

function AgentCard({
  view,
  x,
  y,
  w,
  h,
  now,
  selected,
  onSelect,
}: {
  view: AgentView;
  x: number;
  y: number;
  w: number;
  h: number;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const elapsed = view.elapsedMs === null ? null : duration(view.elapsedMs);
  return (
    <button
      type="button"
      className={`cv-agent ${view.tone} ${selected ? 'selected' : ''} ${view.badge ? 'lead' : ''}`}
      style={{ left: x, top: y, width: w, height: h }}
      onClick={onSelect}
      aria-label={`${view.participant.displayName} ${view.roleLabel} ${view.stateLabel} ${view.doing}`}
      aria-pressed={selected}
    >
      <span className="cv-rail" />
      <span className="cv-agent-top">
        <span className={`cv-avatar ${view.tone}`}>{initials(view.participant.displayName)}</span>
        <span className="cv-agent-id">
          <b>{view.participant.displayName}</b>
          <em title={`${view.roleLabel} · ${view.harness}${view.model ? ` · ${view.model}` : ''}`}>
            {view.badge ? '' : `${view.roleLabel} · `}
            {harnessShort(view.harness)}
            {view.model ? ` · ${view.model}` : ''}
          </em>
        </span>
        {view.badge ? <span className="cv-badge">{view.badge}</span> : null}
        <span className={`cv-state ${view.tone}`}>
          <span className="cv-dot" />
          {view.stateLabel}
        </span>
      </span>
      <span className="cv-agent-doing" title={view.doing}>
        {view.doing}
      </span>
      <span className="cv-agent-foot">
        <span className="cv-stage">{view.item ? ITEM_LABEL[view.item.state as keyof typeof ITEM_LABEL] ?? view.item.state : '—'}</span>
        <span className="cv-elapsed" title={view.elapsedMs === null ? '暂无运行中的尝试' : '本次尝试耗时(自然增长)'}>
          {elapsed && elapsed !== '—' ? `${elapsed}` : `空闲 ${view.session ? '· ' + shortAgo(view.session.lastEventAt, now) : ''}`}
        </span>
      </span>
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

/* ------------------------------ 数据推导 ------------------------------ */

function buildAgents(detail: TaskDetail, events: EventEnvelope[]): AgentView[] {
  const items = detail.workItems;
  const sessions = [...detail.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const openSessions = sessions.filter((s) => !s.closedAt);

  const sessionFor = (participantId: string) =>
    openSessions.find((s) => s.participantId === participantId) ?? sessions.find((s) => s.participantId === participantId) ?? null;
  const attemptsFor = (participantId: string) =>
    detail.attempts
      .filter((a) => a.participantId === participantId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  const toolFor = (sessionId: string | null): string | null => {
    if (!sessionId) return null;
    const started = new Map<string, { tool: string; seq: number; summary?: string }>();
    for (const e of events) {
      if (e.sessionId !== sessionId) continue;
      const p = (e.payload ?? {}) as { toolName?: string; callId?: string; inputSummary?: string };
      if (e.type === 'tool.started' && p.callId) {
        started.set(p.callId, { tool: p.toolName ?? 'tool', seq: e.seq, summary: p.inputSummary });
      } else if (e.type === 'tool.completed' && p.callId) {
        started.delete(p.callId);
      }
    }
    const last = [...started.values()].sort((a, b) => b.seq - a.seq)[0];
    return last ? last.tool : null;
  };

  return detail.participants.map((p) => {
    const profile = detail.profiles.find((x) => x.id === p.profileId) ?? null;
    const session = sessionFor(p.id);
    const attempts = attemptsFor(p.id);
    const liveAttempt = attempts.find((a) => !a.endedAt) ?? null;
    const queue = items
      .filter((w) => w.assignedParticipantId === p.id)
      .sort((a, b) => rank(a.state) - rank(b.state) || (a.createdAt < b.createdAt ? -1 : 1));
    const item = queue[0] ?? null;
    const tool = toolFor(session?.id ?? null);

    let tone: Tone = 'idle';
    let stateLabel = '未启动';
    let doing = '尚未启动会话';

    const liveItem = item && (item.state === 'running' || item.state === 'verifying') ? item : null;

    if (liveAttempt || liveItem) {
      // 有未结束的尝试或工作项正在跑时以执行状态为准, 不被"会话空闲"覆盖。
      tone = 'run';
      stateLabel = liveItem?.state === 'verifying' ? '验证中' : '执行中';
      doing = tool
        ? `工具 ${tool}${toolHint(tool)}`
        : session?.activity === 'tool_running'
          ? '工具执行中'
          : (liveItem?.goal ?? '生成回复中…');
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
        doing = tool ? `工具 ${tool}${toolHint(tool)}` : '生成回复中…';
      } else {
        tone = 'idle';
        stateLabel = '空闲';
        doing = '会话空闲, 等待调度';
      }
    } else if (item) {
      if (item.state === 'accepted') {
        tone = 'ok';
        stateLabel = '已完成';
        doing = `已接受 · ${item.goal}`;
      } else if (item.state === 'awaiting_review') {
        tone = 'wait';
        stateLabel = '待审核';
        doing = `等待强模型审核 · ${item.goal}`;
      } else if (item.state === 'failed' || item.state === 'invalidated') {
        tone = 'bad';
        stateLabel = '失败';
        doing = item.lastError ?? '该工作项失败';
      } else if (item.state === 'running' || item.state === 'verifying') {
        tone = 'run';
        stateLabel = item.state === 'verifying' ? '验证中' : '执行中';
        doing = item.goal;
      } else {
        tone = 'wait';
        stateLabel = '排队中';
        doing = `等待派发 · ${item.goal}`;
      }
    }

    const elapsedMs = liveAttempt ? Date.now() - new Date(liveAttempt.startedAt).getTime() : null;

    return {
      key: `p:${p.id}`,
      participant: p,
      roleLabel: p.isLead ? '主控' : p.role === 'strong' ? '强模型' : '执行者',
      harness: profile?.adapterId ?? '—',
      model: session?.observedModel ?? profile?.requestedModel ?? '',
      tone,
      stateLabel,
      doing,
      item,
      queue,
      session,
      attempt: liveAttempt,
      elapsedMs,
      badge: p.isLead ? '主控' : undefined,
    };
  });
}

const HARNESS_SHORT: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude',
  dsh: 'DSH',
  mock: 'Mock',
};

function harnessShort(adapterId: string): string {
  return HARNESS_SHORT[adapterId] ?? adapterId;
}

function toolHint(tool: string): string {  const t = tool.toLowerCase();
  if (t.includes('bash') || t.includes('shell') || t.includes('exec')) return ' · 执行命令';
  if (t.includes('read')) return ' · 读取文件';
  if (t.includes('write') || t.includes('edit') || t.includes('patch')) return ' · 写入文件';
  if (t.includes('grep') || t.includes('search')) return ' · 检索';
  return '';
}

function rank(state: string): number {
  const order = ['running', 'verifying', 'waiting_input', 'awaiting_review', 'queued', 'ready', 'pending', 'accepted', 'failed'];
  const i = order.indexOf(state);
  return i < 0 ? 99 : i;
}

/* ------------------------------ 布局 ------------------------------ */

function buildLayout(
  detail: TaskDetail,
  agents: AgentView[],
  width: number,
): {
  placed: PlacedAgent[];
  lanes: Lane[];
  links: Link[];
  deliver: { x: number; y: number; w: number; h: number; tone: Tone; sub: string; doing: string } | null;
} {
  const placed: PlacedAgent[] = [];
  const lanes: Lane[] = [];
  const links: Link[] = [];
  const W = Math.max(360, width);
  const narrow = W < 820;

  const lead = agents.find((a) => a.participant.isLead) ?? agents.find((a) => a.participant.role === 'strong') ?? null;
  const strongs = agents.filter((a) => a.participant.role === 'strong' && a.key !== lead?.key);
  const workers = agents.filter((a) => a.participant.role === 'worker');

  const leadW = Math.min(LEAD_W, W - PAD * 2);
  const leadH = narrow ? 108 : LEAD_H;
  const leadX = Math.round((W - leadW) / 2);
  const leadY = 14;
  if (lead) {
    placed.push({ view: lead, x: leadX, y: leadY, w: leadW, h: leadH });
  }

  // 强模型席位
  const strongW = Math.min(STRONG_W, W - PAD * 2);
  const strongH = 96;
  const perRow = narrow ? 1 : Math.max(1, Math.floor((W - PAD * 2 + 22) / (strongW + 22)));
  let cursorY = leadY + leadH + (strongs.length > 0 ? 62 : 54);
  const strongTop = cursorY;
  strongs.forEach((a, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, strongs.length - row * perRow);
    const idx = i % perRow;
    const span = inRow * strongW + (inRow - 1) * 22;
    const startX = Math.round((W - span) / 2);
    const x = startX + idx * (strongW + 22);
    const y = strongTop + row * (strongH + 20);
    placed.push({ view: a, x, y, w: strongW, h: strongH });
    if (lead) {
      const active = a.tone === 'run';
      const tone: Tone = active ? 'run' : a.tone === 'ok' ? 'ok' : a.tone === 'bad' ? 'bad' : 'idle';
      links.push({
        key: `l-${a.participant.id}`,
        d: curveDown(leadX + leadW / 2, leadY + leadH, x + strongW / 2, y),
        tone,
        active,
        label: detail.task.phase === 'review' ? '交叉审核' : detail.task.phase === 'discussion' ? '讨论' : undefined,
        labelX: (leadX + leadW / 2 + x + strongW / 2) / 2 + 26,
        labelY: (leadY + leadH + y) / 2,
      });
    }
  });
  cursorY = strongTop + Math.ceil(strongs.length / perRow) * (strongH + 20) + (strongs.length > 0 ? 34 : 0);

  // 执行泳道: 每个执行者一条, 没有执行者时主控自己一条
  const laneOwners = workers.length > 0 ? workers : lead ? [lead] : [];
  const workerW = Math.min(WORKER_W, W - PAD * 2);
  let laneY = cursorY;
  for (const [laneIndex, owner] of laneOwners.entries()) {
    const chips = owner.queue.map((w) => w);
    const isLeadLane = lead !== null && owner.key === lead.key;
    const cardW = isLeadLane ? leadW : workerW;
    const cardH = isLeadLane ? leadH : WORKER_H;
    const cardX = isLeadLane ? leadX : narrow ? Math.round((W - workerW) / 2) : PAD;
    const cardY = isLeadLane ? leadY : laneY + Math.round((WORKER_H - cardH) / 2);
    const chipStartX = narrow ? PAD : isLeadLane ? PAD : PAD + workerW + 52;
    const usable = narrow ? W - PAD * 2 : W - chipStartX - PAD - 8;
    const perChipRow = narrow ? 1 : Math.max(1, Math.floor((usable + CHIP_GAP) / (CHIP_W + CHIP_GAP)));
    const chipRows = Math.max(1, Math.ceil(chips.length / perChipRow));
    const laneH = narrow
      ? cardH + 18 + chips.length * (CHIP_H + 12) + 8
      : Math.max(isLeadLane ? CHIP_H + 24 : WORKER_H, chipRows * CHIP_H + (chipRows - 1) * 14 + 24);

    const lane: Lane = { workerKey: owner.key, y: laneY, h: laneH, chips: [], endX: 0, endY: 0 };
    if (chips.length > 0) lanes.push(lane);

    if (!isLeadLane) {
      placed.push({ view: owner, x: cardX, y: cardY, w: cardW, h: cardH });
    }

    if (lead && owner.key !== lead.key) {
      const fromX = leadX + 18 + laneIndex * 12;
      const fromY = leadY + leadH - 6;
      const active = owner.tone === 'run';
      const trunkY = laneY - 16;
      const path = downThenAcross(fromX, fromY, cardX + cardW / 2, cardY, trunkY, 16);
      links.push({
        key: `lq-${owner.participant.id}`,
        d: path.d,
        tone: active ? 'run' : owner.tone === 'ok' ? 'ok' : owner.tone === 'bad' ? 'bad' : 'idle',
        active,
        label: '派发',
        labelX: cardX + cardW / 2 + 30,
        labelY: trunkY - 5,
      });
    }

    chips.forEach((item, i) => {
      const row = Math.floor(i / perChipRow);
      const idx = i % perChipRow;
      const x = narrow ? PAD : chipStartX + idx * (CHIP_W + CHIP_GAP);
      const chipW = narrow ? W - PAD * 2 : CHIP_W;
      const y = narrow
        ? cardY + cardH + 18 + row * (CHIP_H + 12)
        : laneY + 12 + row * (CHIP_H + 14);
      const chip: Chip = {
        key: `c-${item.id}`,
        label: fitText(item.goal, 132),
        state: item.state,
        item,
        x,
        y,
        w: chipW,
        h: CHIP_H,
        active: item.state === 'running' || item.state === 'verifying',
      };
      const prev = lane.chips[lane.chips.length - 1];
      lane.chips.push(chip);
      if (prev && row === Math.floor((i - 1) / perChipRow)) {
        links.push({
          key: `c-${item.id}-link`,
          d: `M ${prev.x + prev.w} ${prev.y + prev.h / 2} C ${prev.x + prev.w + 16} ${prev.y + prev.h / 2}, ${x - 16} ${y + CHIP_H / 2}, ${x} ${y + CHIP_H / 2}`,
          tone: chip.active ? 'run' : item.state === 'accepted' ? 'ok' : item.state === 'failed' ? 'bad' : 'idle',
          active: chip.active,
        });
      } else if (!prev) {
        const fromX = narrow ? cardX + cardW / 2 : cardX + cardW;
        const fromY = narrow ? cardY + cardH : cardY + cardH / 2;
        links.push({
          key: `c-${item.id}-entry`,
          d: narrow
            ? curveDown(fromX, fromY, x + CHIP_W / 2, y)
            : `M ${fromX} ${fromY} C ${fromX + 20} ${fromY}, ${x - 20} ${y + CHIP_H / 2}, ${x} ${y + CHIP_H / 2}`,
          tone: chip.active ? 'run' : 'idle',
          active: chip.active,
        });
      }
    });

    const lastChip = lane.chips[lane.chips.length - 1];
    if (lastChip) {
      lane.endX = lastChip.x + lastChip.w;
      lane.endY = lastChip.y + lastChip.h / 2;
    } else {
      lane.endX = cardX + cardW;
      lane.endY = cardY + cardH / 2;
    }

    laneY += (chips.length > 0 ? laneH : isLeadLane ? 0 : WORKER_H) + (narrow ? 26 : 22);
  }

  const hasArtifact = detail.reviewRounds.length > 0 || detail.task.lifecycle === 'completed';
  let deliver: { x: number; y: number; w: number; h: number; tone: Tone; sub: string; doing: string } | null = null;
  if (hasArtifact) {
    const dw = Math.min(DELIVER_W, W - PAD * 2);
    const dx = Math.round((W - dw) / 2);
    const dy = laneY + 64;
    const accepted = detail.workItems.filter((w) => w.state === 'accepted').length;
    const done = detail.task.lifecycle === 'completed';
    deliver = {
      x: dx,
      y: dy,
      w: dw,
      h: DELIVER_H,
      tone: done ? 'ok' : 'wait',
      sub: `${detail.artifacts.length} 个已登记文件 · ${detail.reviewRounds.length} 轮审核`,
      doing: done ? `交付完成 · 工作项 ${accepted}/${detail.workItems.length} 已接受` : `收集中 · 工作项 ${accepted}/${detail.workItems.length} 已接受`,
    };
    lanes.forEach((lane, i) => {
      const trunkY = dy - 22 - i * 17;
      const path = downThenAcross(lane.endX, lane.endY + 4, dx + dw / 2 + (i - (lanes.length - 1) / 2) * 12, dy, trunkY);
      links.push({
        key: `ld-${lane.workerKey}`,
        d: path.d,
        tone: done ? 'ok' : lane.chips.some((c) => c.active) ? 'run' : 'idle',
        active: lane.chips.some((c) => c.active),
        label: '回传',
        labelX: path.labelX,
        labelY: path.labelY,
      });
    });
  }

  return { placed, lanes, links, deliver };
}

function curveDown(x1: number, y1: number, x2: number, y2: number): string {
  const my = y1 + (y2 - y1) * 0.55;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

/** 下行 → 横移到主干高度 → 再横移 → 落到目标顶部; 用于多条回传线收束。 */
function downThenAcross(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  trunkY: number,
  radius = 16,
): { d: string; labelX: number; labelY: number } {
  const dir = x2 === x1 ? 1 : Math.sign(x2 - x1);
  const r = Math.min(radius, Math.abs(x2 - x1) / 2, Math.max(6, Math.abs(trunkY - y1) / 2));
  const d = [
    `M ${x1} ${y1}`,
    `L ${x1} ${trunkY - r}`,
    `Q ${x1} ${trunkY}, ${x1 + dir * r} ${trunkY}`,
    `L ${x2 - dir * r} ${trunkY}`,
    `Q ${x2} ${trunkY}, ${x2} ${trunkY + r}`,
    `L ${x2} ${y2}`,
  ].join(' ');
  return { d, labelX: (x1 + x2) / 2, labelY: trunkY - 5 };
}

/** 直角圆角折线: 先垂直下到中线, 再横移到目标列, 最后落到目标顶部。 */
function elbow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius = 18,
): { d: string; midX: number; midY: number } {
  const midY = Math.round(y1 + Math.max(30, (y2 - y1) * 0.45));
  const dir = x2 === x1 ? 1 : Math.sign(x2 - x1);
  const r = Math.min(radius, Math.abs(x2 - x1) / 2, Math.max(8, y2 - midY));
  const d = [
    `M ${x1} ${y1}`,
    `L ${x1} ${midY - r}`,
    `Q ${x1} ${midY}, ${x1 + dir * r} ${midY}`,
    `L ${x2 - dir * r} ${midY}`,
    `Q ${x2} ${midY}, ${x2} ${midY + r}`,
    `L ${x2} ${y2}`,
  ].join(' ');
  return { d, midX: (x1 + x2) / 2, midY };
}

function fitText(text: string, maxPx: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  let out = '';
  let w = 0;
  for (const ch of flat) {
    const cw = (ch.codePointAt(0) ?? 0) > 0x2e80 ? 11.5 : 6.4;
    if (w + cw > maxPx) return `${out}…`;
    out += ch;
    w += cw;
  }
  return out;
}

/** 供其他组件复用的会话活动文案。 */
export function activityText(activity: string): string {
  return ACTIVITY_LABEL[activity as keyof typeof ACTIVITY_LABEL] ?? activity;
}
