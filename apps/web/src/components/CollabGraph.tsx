import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import type { WorkItem } from '../../../../packages/contracts/src/types';
import { ACTIVITY_LABEL, ITEM_LABEL, LIFECYCLE_LABEL, PHASE_LABEL, shortId } from '../lib/format';

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

const PAD = 26;
const NODE_W = 210;
const NODE_H = 68;
const GAP_X = 26;
const GAP_Y = 46;

/** 估算文本像素宽度: CJK 约等于字号, 其余约 0.56 倍, 用于在固定卡片宽度内截断。 */
function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? fontSize : fontSize * 0.56;
  }
  return w;
}

function fit(text: string, maxPx: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxPx) return text;
  let out = '';
  for (const ch of text) {
    if (textWidth(`${out}${ch}…`, fontSize) > maxPx) break;
    out += ch;
  }
  return `${out}…`;
}

/** 行内水平居中排布, 返回每个元素的 x 坐标。 */
function rowPositions(count: number, width: number, itemW: number, gap: number): number[] {
  if (count <= 0) return [];
  const usable = Math.max(itemW, width - PAD * 2);
  const span = count * itemW + (count - 1) * gap;
  const start = Math.max(PAD, (width - Math.min(span, usable)) / 2);
  return Array.from({ length: count }, (_, i) => Math.round(start + i * (itemW + gap)));
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => buildGraph(detail, size.w, size.h), [detail, size.w, size.h]);
  const { nodes, edges, need } = layout;
  const viewH = Math.max(size.h, need);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);

  if (!detail.task) return null;

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <div className="graph-head">
        <span className="graph-phase">{PHASE_LABEL[detail.task.phase]}</span>
        <span className="graph-sep">·</span>
        <span className={`graph-life ${detail.task.lifecycle}`}>{LIFECYCLE_LABEL[detail.task.lifecycle]}</span>
      </div>
      <svg viewBox={`0 0 ${size.w} ${viewH}`} width="100%" height={viewH} role="img" aria-label="协作图">
        <defs>
          <filter id="nodeshadow" x="-30%" y="-30%" width="160%" height="180%">
            <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="var(--shadow-color)" floodOpacity="1" />
            <feDropShadow dx="0" dy="1" stdDeviation="1.6" floodColor="var(--shadow-color)" floodOpacity=".55" />
          </filter>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line-3)" />
          </marker>
          <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-2)" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const a = byKey.get(e.from);
          const b = byKey.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + a.w / 2;
          const y1 = a.y + a.h + 2;
          const x2 = b.x + b.w / 2;
          const y2 = b.y - 9;
          const my = (y1 + y2) / 2;
          const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
          const cls =
            e.state === 'active' ? 'gedge active' : e.state === 'done' ? 'gedge done' : e.state === 'bad' ? 'gedge bad' : 'gedge';
          return (
            <g key={`e${i}`}>
              <path d={d} className={cls} markerEnd={e.state === 'active' ? 'url(#arrow-active)' : 'url(#arrow)'} />
              {e.label ? (
                <text
                  x={(x1 + x2) / 2}
                  y={my + 4}
                  textAnchor="middle"
                  fill="var(--text-3)"
                  fontSize="9.5"
                  fontFamily="var(--mono)"
                  stroke="var(--bg)"
                  strokeWidth="4"
                  paintOrder="stroke"
                >
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {nodes.map((n) => {
          const isArtifact = n.key === 'a:artifacts';
          const selected = isArtifact
            ? selection?.kind === 'artifact'
            : selection?.kind === 'participant' && selection.id === n.key.replace(/^p:/, '');
          const cls = [
            'gnode',
            n.state === 'running' ? 'running' : '',
            n.state === 'failed' ? 'failed' : '',
            n.state === 'waiting' ? 'waiting' : '',
            n.state === 'done' ? 'done' : '',
            selected ? 'selected' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const badgeW = n.badge ? Math.max(34, Math.round(textWidth(n.badge, 9.5)) + 16) : 0;
          const titleMax = n.w - 24 - (badgeW ? badgeW + 10 : 0);
          return (
            <g
              key={n.key}
              className={cls}
              transform={`translate(${n.x},${n.y})`}
              onClick={() => onSelect(isArtifact ? { kind: 'artifact', id: 'artifacts' } : { kind: 'participant', id: n.key.replace(/^p:/, '') })}
              tabIndex={0}
              role="button"
              aria-label={`${n.title} ${n.sub} ${n.meta}`}
            >
              <rect className="card" width={n.w} height={n.h} rx="13" filter="url(#nodeshadow)" />
              <rect x="0" y="11" width="3" height={n.h - 22} rx="2" fill={toneColor(n.state)} />
              <text className="glabel" x="14" y="24">
                {fit(n.title, titleMax, 12.5)}
              </text>
              <text className="gsub" x="14" y="42">
                {fit(n.sub, n.w - 28, 11)}
              </text>
              <text className="gmeta" x="14" y="58" fill={toneColor(n.state)}>
                {fit(n.meta, n.w - 28, 11)}
              </text>
              {n.badge ? (
                <g>
                  <rect x={n.w - badgeW - 12} y="10" width={badgeW} height="17" rx="8.5" fill="var(--accent-soft)" stroke="var(--accent-line)" strokeWidth="0.8" />
                  <text x={n.w - badgeW / 2 - 12} y="22" textAnchor="middle" fill="var(--accent)" fontSize="9.5" fontFamily="var(--sans)">
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
        <span className="muted">节点与连线均由服务端事件与快照推导, 无模拟动画</span>
      </div>
    </div>
  );
}

function toneColor(state: GNode['state']): string {
  switch (state) {
    case 'running':
      return 'var(--accent-2)';
    case 'done':
      return 'var(--ok)';
    case 'failed':
      return 'var(--bad)';
    case 'waiting':
      return 'var(--warn)';
    default:
      return 'var(--line-3)';
  }
}

function buildGraph(detail: TaskDetail, width: number, height: number): { nodes: GNode[]; edges: GEdge[]; need: number } {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const lead = detail.participants.find((p) => p.isLead);
  const strongs = detail.participants.filter((p) => p.role === 'strong' && p.id !== lead?.id);
  const workers = detail.participants.filter((p) => p.role === 'worker');
  const items = detail.workItems;
  const sessions = [...detail.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const sessionFor = (participantId: string) =>
    sessions.find((s) => s.participantId === participantId && !s.closedAt) ?? sessions.find((s) => s.participantId === participantId);
  const itemFor = (participantId: string): WorkItem | undefined =>
    items
      .filter((w) => w.assignedParticipantId === participantId)
      .sort((a, b) => rank(b.state) - rank(a.state))[0];

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
    const model = s?.observedModel ?? '';
    const sub = `${p.role === 'strong' ? '强模型' : '执行者'} · ${model || '未观测模型'}`;
    const meta = item
      ? `${ITEM_LABEL[item.state]} · ${item.goal.replace(/\s+/g, ' ')}`
      : s
        ? ACTIVITY_LABEL[s.activity]
        : '尚未建立会话';
    return { key: `p:${p.id}`, x, y, w: NODE_W, h: NODE_H, title: p.displayName, sub, meta, state: st, badge };
  };

  const centeredX = (n: number, idx: number) => {
    const xs = rowPositions(n, width, NODE_W, GAP_X);
    return xs[idx] ?? Math.round(width / 2 - NODE_W / 2);
  };

  const strongPerRow = Math.max(1, Math.min(strongs.length || 1, Math.floor((width - PAD * 2 + GAP_X) / (NODE_W + GAP_X))));
  const workerPerRow = Math.max(1, Math.min(workers.length || 1, Math.floor((width - PAD * 2 + GAP_X) / (NODE_W + GAP_X))));
  const strongRows = Math.ceil(strongs.length / strongPerRow);
  const workerRows = Math.ceil(workers.length / workerPerRow);
  const hasArtifact = detail.artifacts.length > 0 || detail.task.lifecycle === 'completed';
  const totalRows = 1 + strongRows + workerRows + (hasArtifact ? 1 : 0);

  /** 行数少时把纵向留白摊进行间距, 避免整张图挤在顶部。 */
  const innerGap = 30;
  const spare = height - totalRows * NODE_H - PAD * 2 - (totalRows - 1) * innerGap;
  const gapY = Math.round(Math.min(116, Math.max(GAP_Y, GAP_Y + spare / Math.max(1, totalRows * 2))));

  let cursorY = PAD + 6;
  if (lead) {
    nodes.push(makeNode(lead, Math.round(width / 2 - NODE_W / 2), cursorY, '主控'));
  } else {
    nodes.push({
      key: 'p:none',
      x: Math.round(width / 2 - NODE_W / 2),
      y: cursorY,
      w: NODE_W,
      h: NODE_H,
      title: '未选定主控',
      sub: 'participants',
      meta: '请检查任务参与者',
      state: 'failed',
    });
  }
  cursorY += NODE_H + gapY;

  if (strongRows > 0) {
    const strongY = cursorY;
    strongs.forEach((p, i) => {
      const row = Math.floor(i / strongPerRow);
      const inRow = Math.min(strongPerRow, strongs.length - row * strongPerRow);
      const idx = i % strongPerRow;
      const phaseBadge = detail.task.phase === 'review' ? '审核' : detail.task.phase === 'discussion' ? '讨论' : undefined;
      nodes.push(makeNode(p, centeredX(inRow, idx), strongY + row * (NODE_H + innerGap), phaseBadge));
      if (lead) {
        edges.push({
          from: `p:${lead.id}`,
          to: `p:${p.id}`,
          state: detail.task.phase === 'discussion' ? 'active' : 'idle',
          label: detail.task.phase === 'discussion' ? '质询' : '',
        });
      }
    });
    cursorY = strongY + strongRows * (NODE_H + innerGap) - innerGap + gapY;
  }

  if (workerRows > 0) {
    const workerY = cursorY;
    workers.forEach((p, i) => {
      const row = Math.floor(i / workerPerRow);
      const inRow = Math.min(workerPerRow, workers.length - row * workerPerRow);
      const idx = i % workerPerRow;
      const item = itemFor(p.id);
      nodes.push(
        makeNode(p, centeredX(inRow, idx), workerY + row * (NODE_H + innerGap), item && item.state === 'running' ? '执行' : undefined),
      );
      if (lead) {
        const st: GEdge['state'] =
          item?.state === 'running' ? 'active' : item?.state === 'accepted' ? 'done' : item?.state === 'failed' ? 'bad' : 'idle';
        edges.push({ from: `p:${lead.id}`, to: `p:${p.id}`, state: st });
      }
    });
    cursorY = workerY + workerRows * (NODE_H + innerGap) - innerGap + gapY;
  }

  for (const w of items) {
    if (!w.assignedParticipantId || w.dependencyIds.length === 0) continue;
    for (const depId of w.dependencyIds) {
      const dep = items.find((x) => x.id === depId || x.planItemId === depId);
      if (!dep?.assignedParticipantId || dep.assignedParticipantId === w.assignedParticipantId) continue;
      const st: GEdge['state'] = dep.state === 'accepted' ? 'done' : w.state === 'running' ? 'active' : 'idle';
      edges.push({ from: `p:${dep.assignedParticipantId}`, to: `p:${w.assignedParticipantId}`, state: st, label: '依赖' });
    }
  }

  const need = cursorY + NODE_H + PAD;
  if (hasArtifact) {
    const accepted = items.filter((w) => w.state === 'accepted').length;
    nodes.push({
      key: 'a:artifacts',
      x: Math.round(width / 2 - NODE_W / 2),
      y: cursorY,
      w: NODE_W,
      h: NODE_H,
      title: '交付物',
      sub: `${detail.artifacts.length} 个已登记文件`,
      meta: `工作项 ${accepted}/${items.length} 已接受`,
      state: detail.task.lifecycle === 'completed' ? 'done' : 'waiting',
      badge: '产物',
    });
    // 只从"最后一行"连到交付物, 避免长边穿过中间的节点卡片。
    const producers = workers.length > 0 ? workers : strongs.length > 0 ? strongs : lead ? [lead] : [];
    producers.forEach((p) => {
      edges.push({
        from: `p:${p.id}`,
        to: 'a:artifacts',
        state: detail.task.lifecycle === 'completed' ? 'done' : 'idle',
      });
    });
  }

  return { nodes, edges, need: Math.max(need, 320) };
}

function rank(state: string): number {
  const order = ['running', 'verifying', 'waiting_input', 'awaiting_review', 'queued', 'pending', 'ready', 'accepted', 'failed'];
  const i = order.indexOf(state);
  return i < 0 ? 0 : order.length - i;
}
