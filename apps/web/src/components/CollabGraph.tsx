import { useMemo } from 'react';
import type { TaskDetail } from '../api';
import type { WorkItem } from '../../../../packages/contracts/src/types';
import { ACTIVITY_LABEL, ITEM_LABEL, ITEM_TONE, PHASE_LABEL, roleLabel, shortId } from '../lib/format';

export type GraphSelection = { kind: 'participant'; id: string } | { kind: 'artifact'; id: string } | null;

interface GNode {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  meta: string;
  state: 'idle' | 'running' | 'done' | 'failed' | 'waiting';
  badge?: string;
}

interface GEdge {
  from: string;
  to: string;
  state: 'idle' | 'active' | 'done' | 'bad';
  label?: string;
}

const W = 880;
const H = 600;

function itemTone(state: string): GNode['state'] {
  if (state === 'running' || state === 'verifying') return 'running';
  if (state === 'accepted') return 'done';
  if (state === 'failed' || state === 'invalidated') return 'failed';
  if (state === 'waiting_input' || state === 'awaiting_review') return 'waiting';
  return 'idle';
}

export function CollabGraph({
  detail,
  selection,
  onSelect,
}: {
  detail: TaskDetail;
  selection: GraphSelection;
  onSelect: (s: GraphSelection) => void;
}) {
  const { nodes, edges } = useMemo(() => buildGraph(detail), [detail]);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);

  if (!detail.task) return null;

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="协作图">
        <defs>
          <pattern id="dotgrid" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.055)" />
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.32)" />
          </marker>
          <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(79,209,197,0.65)" />
          </marker>
        </defs>

        <rect width={W} height={H} fill="url(#dotgrid)" />
        <text x="26" y="34" fill="rgba(255,255,255,0.26)" fontSize="11" letterSpacing="1.5">
          {`${detail.task.phase} · ${detail.task.lifecycle}`}
        </text>

        {edges.map((e, i) => {
          const a = byKey.get(e.from);
          const b = byKey.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + a.w / 2;
          const y1 = a.y + a.h;
          const x2 = b.x + b.w / 2;
          const y2 = b.y;
          const my = (y1 + y2) / 2;
          const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2 - 6}`;
          const cls = e.state === 'active' ? 'gedge active' : e.state === 'done' ? 'gedge done' : e.state === 'bad' ? 'gedge bad' : 'gedge';
          return (
            <g key={`e${i}`}>
              <path d={d} className={cls} markerEnd={e.state === 'active' ? 'url(#arrow-active)' : 'url(#arrow)'} />
              {e.label ? (
                <text x={(x1 + x2) / 2} y={my + 3} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="9.5">
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {nodes.map((n) => {
          const selected =
            (selection?.kind === 'participant' && selection.id === n.key.replace(/^p:/, '')) ||
            (selection?.kind === 'artifact' && n.key === 'a:artifacts');
          const cls = ['gnode', n.state === 'running' ? 'running' : '', n.state === 'failed' ? 'failed' : '', selected ? 'selected' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <g
              key={n.key}
              className={cls}
              transform={`translate(${n.x},${n.y})`}
              onClick={() =>
                onSelect(
                  n.key === 'a:artifacts'
                    ? { kind: 'artifact', id: 'artifacts' }
                    : { kind: 'participant', id: n.key.replace(/^p:/, '') },
                )
              }
              tabIndex={0}
              role="button"
              aria-label={`${n.title} ${n.sub}`}
            >
              <rect className="card" width={n.w} height={n.h} rx="12" />
              <rect x="0" y="0" width="3" height={n.h} rx="2" fill={toneColor(n.state)} />
              <text className="glabel" x="12" y="20">
                {n.title}
              </text>
              <text className="gsub" x="12" y="36">
                {n.sub}
              </text>
              <text className="gsub" x="12" y="49" fill={toneColor(n.state)}>
                {n.meta}
              </text>
              {n.badge ? (
                <g>
                  <rect x={n.w - 46} y="8" width="38" height="16" rx="8" fill="rgba(139,123,255,0.18)" />
                  <text x={n.w - 27} y="19" textAnchor="middle" fill="#b6acff" fontSize="9.5">
                    {n.badge}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="graph-legend">
        <span className="chip cyan">执行中</span>
        <span className="chip green">已完成</span>
        <span className="chip amber">等待</span>
        <span className="chip red">失败</span>
        <span className="muted">节点与连线均由服务端事件和快照推导</span>
      </div>
    </div>
  );
}

function toneColor(state: GNode['state']): string {
  switch (state) {
    case 'running':
      return '#4fd1c5';
    case 'done':
      return '#52d39a';
    case 'failed':
      return '#f2685f';
    case 'waiting':
      return '#f2b455';
    default:
      return 'rgba(255,255,255,0.28)';
  }
}

function buildGraph(detail: TaskDetail): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const lead = detail.participants.find((p) => p.isLead);
  const strongs = detail.participants.filter((p) => p.role === 'strong' && p.id !== lead?.id);
  const workers = detail.participants.filter((p) => p.role === 'worker');
  const items = detail.workItems;
  const sessions = [...detail.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const sessionFor = (participantId: string) => sessions.find((s) => s.participantId === participantId && !s.closedAt) ?? sessions.find((s) => s.participantId === participantId);
  const itemFor = (participantId: string): WorkItem | undefined =>
    items.filter((w) => w.assignedParticipantId === participantId).sort((a, b) => rank(b.state) - rank(a.state))[0];

  const nodeW = 204;
  const nodeH = 66;

  const makeNode = (p: { id: string; displayName: string; role: string }, x: number, y: number, badge?: string): GNode => {
    const s = sessionFor(p.id);
    const item = itemFor(p.id);
    const running = s?.activity === 'generating' || s?.activity === 'tool_running';
    const st: GNode['state'] = running
      ? 'running'
      : item && item.state === 'accepted'
        ? 'done'
        : item && (item.state === 'failed' || item.state === 'invalidated')
          ? 'failed'
          : item && (item.state === 'waiting_input' || item.state === 'awaiting_review')
            ? 'waiting'
            : 'idle';
    const sub = `${p.role === 'strong' ? '强模型' : '执行者'} · ${shortId(s?.observedModel ?? null, 18) || '未观测模型'}`;
    const meta = item
      ? `${ITEM_LABEL[item.state]} · ${item.goal.slice(0, 16)}`
      : s
        ? ACTIVITY_LABEL[s.activity]
        : '尚未建立会话';
    return { key: `p:${p.id}`, x, y, w: nodeW, h: nodeH, title: p.displayName, sub, meta, state: st, badge };
  };

  if (lead) {
    nodes.push(makeNode(lead, W / 2 - nodeW / 2, 62, '主控'));
  } else {
    nodes.push({ key: 'p:none', x: W / 2 - nodeW / 2, y: 62, w: nodeW, h: nodeH, title: '未选定主控', sub: 'participants', meta: '请检查任务参与者', state: 'failed' });
  }

  const strongY = 190;
  strongs.forEach((p, i) => {
    const total = strongs.length;
    const span = Math.min(W - 120, total * (nodeW + 26));
    const start = W / 2 - span / 2 + (span - total * nodeW) / (total + 1);
    const x = total === 1 ? W / 2 - nodeW / 2 : start + i * (nodeW + (span - total * nodeW) / (total + 1) + 0);
    const phaseBadge = detail.task.phase === 'review' ? '审核' : detail.task.phase === 'discussion' ? '讨论' : undefined;
    nodes.push(makeNode(p, Math.round(x), strongY, phaseBadge));
    if (lead) {
      edges.push({ from: `p:${lead.id}`, to: `p:${p.id}`, state: detail.task.phase === 'discussion' ? 'active' : 'idle', label: detail.task.phase === 'discussion' ? '质询' : '' });
    }
  });

  const workerRows = Math.ceil(workers.length / 4) || 1;
  workers.forEach((p, i) => {
    const perRow = 4;
    const row = Math.floor(i / perRow);
    const inRow = row === workerRows - 1 ? workers.length - row * perRow : Math.min(perRow, workers.length - row * perRow);
    const idx = i % perRow;
    const span = Math.min(W - 120, inRow * (nodeW + 22));
    const start = W / 2 - span / 2 + (span - inRow * nodeW) / (inRow + 1);
    const x = Math.round(start + idx * (nodeW + (span - inRow * nodeW) / (inRow + 1)));
    const y = 320 + row * 92;
    const item = itemFor(p.id);
    nodes.push(makeNode(p, x, y, item && item.state === 'running' ? '执行' : undefined));
    if (lead) {
      const st: GEdge['state'] = item?.state === 'running' ? 'active' : item?.state === 'accepted' ? 'done' : item?.state === 'failed' ? 'bad' : 'idle';
      edges.push({ from: `p:${lead.id}`, to: `p:${p.id}`, state: st });
    }
  });

  // 依赖连线: 执行者之间按工作项依赖
  for (const w of items) {
    if (!w.assignedParticipantId || w.dependencyIds.length === 0) continue;
    for (const depId of w.dependencyIds) {
      const dep = items.find((x) => x.id === depId || x.planItemId === depId);
      if (!dep?.assignedParticipantId || dep.assignedParticipantId === w.assignedParticipantId) continue;
      const st: GEdge['state'] = w.state === 'running' && dep.state !== 'accepted' ? 'active' : dep.state === 'accepted' ? 'done' : 'idle';
      edges.push({ from: `p:${dep.assignedParticipantId}`, to: `p:${w.assignedParticipantId}`, state: st, label: '依赖' });
    }
  }

  if (detail.artifacts.length > 0 || detail.task.lifecycle === 'completed') {
    const accepted = items.filter((w) => w.state === 'accepted').length;
    nodes.push({
      key: 'a:artifacts',
      x: W / 2 - nodeW / 2,
      y: 470,
      w: nodeW,
      h: nodeH,
      title: '交付物',
      sub: `${detail.artifacts.length} 个已登记文件`,
      meta: `工作项 ${accepted}/${items.length} 已接受`,
      state: detail.task.lifecycle === 'completed' ? 'done' : 'waiting',
      badge: '产物',
    });
    const leadKey = lead ? `p:${lead.id}` : null;
    if (leadKey) edges.push({ from: leadKey, to: 'a:artifacts', state: detail.task.lifecycle === 'completed' ? 'done' : 'idle', label: PHASE_LABEL[detail.task.phase] });
  }

  return { nodes, edges };
}

function rank(state: string): number {
  const order = ['running', 'verifying', 'waiting_input', 'awaiting_review', 'queued', 'pending', 'ready', 'accepted', 'failed'];
  const i = order.indexOf(state);
  return i < 0 ? 0 : order.length - i;
}
