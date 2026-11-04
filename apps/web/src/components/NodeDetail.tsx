import { useMemo, useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import type { GraphSelection } from './CollabGraph';
import {
  ACTIVITY_LABEL,
  ITEM_LABEL,
  ITEM_TONE,
  PHASE_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  ago,
  bytes,
  clock,
  duration,
  shortId,
  stamp,
} from '../lib/format';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const DETAIL_W = 430;
const GAP = 12;
const EDGE = 12;

/**
 * 详情面板贴着被点的那张卡片放: 优先放右侧, 右边放不下就放左侧,
 * 两侧都不够宽就放到卡片下方(下方也不够就上方); 始终与卡片保持 GAP, 不盖住卡片本身。
 */
export function anchorStyle(
  anchor: AnchorRect | null | undefined,
  bounds?: { left: number; right: number; top: number; bottom: number } | null,
): React.CSSProperties {
  if (!anchor) return {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minLeft = Math.max(EDGE, (bounds?.left ?? 0) + EDGE);
  const maxRight = Math.min(vw - EDGE, (bounds?.right ?? vw) - EDGE);
  const minTop = Math.max(EDGE, (bounds?.top ?? 0) + EDGE);
  const maxBottom = Math.min(vh - EDGE, (bounds?.bottom ?? vh) - EDGE);

  const room = Math.max(260, maxRight - minLeft);
  const width = Math.min(DETAIL_W, room);
  const right = anchor.left + anchor.width;
  const bottomOfCard = anchor.top + anchor.height;

  const availRight = maxRight - right;
  const availLeft = anchor.left - minLeft;
  const availBelow = maxBottom - bottomOfCard;
  const availAbove = anchor.top - minTop;
  const H = Math.min(vh * 0.6, 440);

  let left: number;
  let top: number;
  if (availRight >= GAP + width) {
    left = right + GAP;
    top = anchor.top - 4;
  } else if (availLeft >= GAP + width) {
    left = anchor.left - GAP - width;
    top = anchor.top - 4;
  } else if (availBelow >= 180 || availBelow >= availAbove) {
    left = Math.max(minLeft, Math.min(anchor.left, maxRight - width));
    top = bottomOfCard + GAP;
  } else {
    left = Math.max(minLeft, Math.min(anchor.left, maxRight - width));
    top = Math.max(minTop, anchor.top - GAP - H);
  }

  left = Math.max(minLeft, Math.min(left, maxRight - width));
  top = Math.max(minTop, Math.min(top, maxBottom - 200));
  const maxHeight = Math.max(240, Math.min(maxBottom - top, vh * 0.74));
  return { position: 'fixed', top, left, width, maxHeight, right: 'auto', bottom: 'auto' };
}

/** 会话里的模型/推理有时是数组甚至是 JSON 字符串, 直接渲染会变成 ["a","b"]。 */
function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' · ');
  const text = String(value);
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.map((v) => String(v)).join(' · ');
    } catch {
      /* 不是 JSON 就原样显示 */
    }
  }
  return text;
}

function attemptTone(status: string): string {
  if (status === 'completed') return 'green';
  if (status === 'failed' || status === 'interrupted') return 'red';
  if (status === 'running' || status === 'starting') return 'cyan';
  if (status === 'waiting_approval' || status === 'waiting_user' || status === 'retry_wait') return 'amber';
  return 'muted';
}

const ROLE_LABEL: Record<string, string> = { strong: '强模型', worker: '执行者' };

export function NodeDetail({
  detail,
  selection,
  events,
  onClose,
  onChanged,
  onChat,
}: {
  detail: TaskDetail;
  selection: GraphSelection;
  events: EventEnvelope[];
  onClose: () => void;
  onChanged: () => void;
  onChat?: (participantId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const participant = useMemo(
    () => (selection?.kind === 'participant' ? detail.participants.find((p) => p.id === selection.id) ?? null : null),
    [detail.participants, selection],
  );

  if (!selection) return null;

  if (selection.kind === 'plan') {
    const plan = detail.plan;
    if (!plan) {
      return (
        <div className="detail inline">
          <h4>
            <span>计划</span>
            <button className="btn ghost sm" onClick={onClose}>
              关闭
            </button>
          </h4>
          <div className="muted small">还没有计划版本。</div>
        </div>
      );
    }
    const content = plan.content;
    const approvals = detail.approvals.filter((a) => a.planRevisionId === plan.id);
    const lead = detail.participants.find((p) => p.isLead) ?? null;
    return (
      <div className="detail inline">
        <h4>
          <span>计划 v{plan.number}</span>
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </h4>

        <div className="panel-title">版本</div>
        <dl className="kv">
          <dt>状态</dt>
          <dd>
            <span className={`chip ${plan.status === 'approved' ? 'ok' : plan.status === 'proposed' ? 'wait' : 'muted'}`}>{plan.status}</span>
          </dd>
          <dt>内容哈希</dt>
          <dd className="mono small" title={plan.contentHash ?? ''}>
            {(plan.contentHash ?? '').slice(0, 16)}…
          </dd>
          <dt>规划者</dt>
          <dd>{detail.participants.find((p) => p.id === plan.createdBy)?.displayName ?? plan.createdBy ?? '—'}</dd>
          <dt>生成时间</dt>
          <dd title={stamp(plan.createdAt)}>{ago(plan.createdAt)}</dd>
          <dt>历史版本</dt>
          <dd>
            {detail.planHistory.length} 个版本
            {detail.planHistory.length > 1
              ? `（${detail.planHistory
                  .slice(0, -1)
                  .map((p) => 'v' + p.number)
                  .join(', ')} 已被取代）`
              : ''}
          </dd>
          <dt>批准</dt>
          <dd>
            {approvals.length === 0
              ? '尚未批准'
              : approvals
                  .map((a) => `${a.decision} · ${clock(a.createdAt)}${a.userNote ? ` · ${a.userNote}` : ''}`)
                  .join('；')}
          </dd>
        </dl>

        <div className="panel-title">目标</div>
        <p className="small">{content.objective}</p>
        {plan.summary ? <p className="small muted">{plan.summary}</p> : null}
        {content.revisionNote ? (
          <>
            <div className="panel-title">这次改了什么</div>
            <p className="small muted">{content.revisionNote}</p>
          </>
        ) : null}
        {content.assumptions.length > 0 ? (
          <>
            <div className="panel-title">假设</div>
            <ul className="small muted">
              {content.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </>
        ) : null}
        {content.clarificationNeeded.length > 0 ? (
          <>
            <div className="panel-title">待你确认</div>
            <ul className="small warn-text">
              {content.clarificationNeeded.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="panel-title">工作项 {content.workItems.length}</div>
        {content.workItems.map((w) => {
          const runtime = detail.workItems.find((x) => x.planItemId === w.id) ?? null;
          const owner =
            detail.participants.find((p) => p.id === w.assignedParticipantId)?.displayName ?? w.assignedParticipantId ?? '未指派';
          return (
            <div className="card" key={w.id}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="mono small">{w.id}</span>
                <span className={`chip ${runtime ? ITEM_TONE[runtime.state] ?? 'muted' : 'muted'}`}>
                  {runtime ? ITEM_LABEL[runtime.state] ?? runtime.state : '未创建'}
                </span>
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                {w.goal}
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                执行者 {owner}
                {w.dependencies.length ? ` · 依赖 ${w.dependencies.join(', ')}` : ''}
                {w.riskLevel ? ` · 风险 ${w.riskLevel}` : ''}
              </div>
              {w.expectedOutputs.length ? (
                <div className="small muted mono" style={{ marginTop: 4 }}>
                  {w.expectedOutputs.map((o) => o.relativePath).join(' · ')}
                </div>
              ) : (
                <div className="small muted" style={{ marginTop: 4 }}>
                  无文件产物（只读复核类）
                </div>
              )}
              {w.acceptanceCriteria.length ? (
                <ul className="small muted" style={{ marginTop: 4, paddingLeft: 16 }}>
                  {w.acceptanceCriteria.slice(0, 4).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}

        <div className="panel-title">交付物</div>
        {content.deliverables.length === 0 ? (
          <div className="muted small">计划里没有单列交付物。</div>
        ) : (
          content.deliverables.map((d, i) => (
            <div className="card" key={i}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">{d.label}</span>
                <span className="chip muted">{d.format}</span>
              </div>
              <div className="small muted mono" style={{ marginTop: 3 }}>
                {d.destination}
              </div>
            </div>
          ))
        )}

        <div className="panel-title">审核策略</div>
        <dl className="kv">
          <dt>强模型席位</dt>
          <dd>{content.reviewPolicy.strongParticipantIds.length} 个</dd>
          <dt>交叉复核</dt>
          <dd>{content.reviewPolicy.crossReviewRequired ? '需要' : '不需要（单强模型）'}</dd>
          <dt>轮次上限</dt>
          <dd>{detail.limits.maxRepairRounds} 轮修复</dd>
          <dt>工作项上限</dt>
          <dd>{detail.limits.maxWorkItems} 项</dd>
          {lead ? (
            <>
              <dt>主控</dt>
              <dd>{lead.displayName}</dd>
            </>
          ) : null}
        </dl>

        {content.verificationSteps.length ? (
          <>
            <div className="panel-title">验证步骤</div>
            <ul className="small muted">
              {content.verificationSteps.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </>
        ) : null}

        {content.risks.length ? (
          <>
            <div className="panel-title">风险</div>
            <ul className="small muted">
              {content.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        ) : null}

        {content.unresolvedDecisions.length ? (
          <>
            <div className="panel-title">未决问题</div>
            <ul className="small muted">
              {content.unresolvedDecisions.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  if (selection.kind === 'delivery') {
    const accepted = detail.workItems.filter((w) => w.state === 'accepted').length;
    const passed = detail.verifications.filter((v) => v.status === 'passed').length;
    const verdicts = detail.reviewResults;
    return (
      <div className="detail inline">
        <h4>
          <span>交付物</span>
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </h4>

        <dl className="kv">
          <dt>已登记文件</dt>
          <dd>{detail.artifacts.length}</dd>
          <dt>工作项</dt>
          <dd>
            {accepted}/{detail.workItems.length} 已接受
          </dd>
          <dt>验证</dt>
          <dd>
            {passed}/{detail.verifications.length} 通过
          </dd>
          <dt>审核轮次</dt>
          <dd>
            {detail.reviewRounds.length} 轮
            {verdicts.length ? `（${verdicts.map((v) => VERDICT_LABEL[v.verdict] ?? v.verdict).join(', ')}）` : ''}
          </dd>
          <dt>工作区</dt>
          <dd className="mono small" title={detail.workspace || ''}>
            {detail.workspace || '—'}
          </dd>
        </dl>

        <div className="panel-title">文件 {detail.artifacts.length}</div>
        {detail.artifacts.length === 0 ? (
          <div className="muted small">还没有登记产物。</div>
        ) : (
          detail.artifacts.map((a) => (
            <div className="card" key={a.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono small">{a.relativePath}</span>
                <span className="chip muted">{bytes(a.size)}</span>
              </div>
              <div className="small muted mono" style={{ marginTop: 3 }}>
                {a.mediaType} · sha256 {a.sha256.slice(0, 12)} · {clock(a.registeredAt)}
              </div>
            </div>
          ))
        )}

        <div className="panel-title">验证记录</div>
        {detail.verifications.length === 0 ? (
          <div className="muted small">还没有验证记录。</div>
        ) : (
          detail.verifications.slice(-8).map((v) => (
            <div className="card" key={v.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono small">{v.checkId}</span>
                <span className={`chip ${v.status === 'passed' ? 'ok' : v.status === 'failed' ? 'bad' : 'muted'}`}>{v.status}</span>
              </div>
              <div className="small muted" style={{ marginTop: 3 }}>
                {v.method} · {v.detail}
              </div>
            </div>
          ))
        )}

        <div className="panel-title">审核结论</div>
        {verdicts.length === 0 ? (
          <div className="muted small">还没有审核结果。</div>
        ) : (
          verdicts.map((r) => (
            <div className="card" key={r.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">{detail.participants.find((p) => p.id === r.participantId)?.displayName ?? r.participantId}</span>
                <span className={`chip ${VERDICT_TONE[r.verdict] ?? 'muted'}`}>{VERDICT_LABEL[r.verdict] ?? r.verdict}</span>
              </div>
              {r.summary ? (
                <div className="small muted" style={{ marginTop: 3 }}>
                  {r.summary}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    );
  }

  if (!participant) {
    return (
      <div className="detail inline">
        <h4>
          <span>节点</span>
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </h4>
        <div className="muted small">该节点不存在。</div>
      </div>
    );
  }

  const profile = detail.profiles.find((p) => p.id === participant.profileId) ?? null;
  const sessions = detail.sessions.filter((s) => s.participantId === participant.id);
  const live = sessions.filter((s) => !s.closedAt);
  const current = live[0] ?? sessions[sessions.length - 1] ?? null;
  const attemptsAll = detail.attempts.filter((a) => a.participantId === participant.id);
  const attempts = attemptsAll.slice(-6).reverse();
  const running = attemptsAll.find((a) => a.status === 'running' || a.status === 'starting') ?? null;
  const items = detail.workItems.filter((w) => w.assignedParticipantId === participant.id);
  const itemIds = new Set(items.map((w) => w.id));
  const myArtifacts = detail.artifacts.filter((a) => a.workItemId && itemIds.has(a.workItemId));
  const myVerifications = detail.verifications.filter((v) => {
    const w = detail.workItems.find((x) => x.id === v.workItemId);
    return w ? w.assignedParticipantId === participant.id : false;
  });
  const lastEvents = events.filter((e) => e.sessionId && sessions.some((s) => s.id === e.sessionId)).slice(-8).reverse();
  const reviewed = detail.reviewResults.filter((r) => r.participantId === participant.id);
  const lastAt = current?.lastEventAt ?? participant.createdAt;
  const elapsed = running ? duration(Date.now() - Date.parse(running.startedAt)) : null;

  const cancel = async (sessionId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.control(detail.task.id, 'cancel_session', sessionId, '用户从协作图取消');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail inline">
      <h4>
        <span>
          {participant.displayName}{' '}
          <span className="chip muted" style={{ marginLeft: 6 }}>
            {participant.role === 'strong' ? (participant.isLead ? '主控' : '强模型') : '执行者'}
          </span>
        </span>
        <button className="btn ghost sm" onClick={onClose}>
          关闭
        </button>
      </h4>

      <div className="panel-title" style={{ marginTop: 2 }}>
        配置与模型
      </div>
      <dl className="kv">
        <dt>角色</dt>
        <dd>
          {ROLE_LABEL[participant.role] ?? participant.role}
          {participant.isLead ? ' · 主控(规划与裁决)' : ''}
        </dd>
        <dt>harness</dt>
        <dd>{profile?.adapterId ?? '—'}</dd>
        <dt>配置模型</dt>
        <dd>{profile?.requestedModel || '沿用 harness 默认'}</dd>
        <dt>配置推理</dt>
        <dd>{profile?.requestedReasoning || '沿用 harness 默认'}</dd>
        <dt>观测模型</dt>
        <dd title="由 harness 的原生事件回报">{readable(current?.observedModel)}</dd>
        <dt>观测推理</dt>
        <dd>{readable(current?.observedReasoning)}</dd>
      </dl>

      <div className="panel-title">运行状态</div>
      <dl className="kv">
        <dt>任务阶段</dt>
        <dd>{PHASE_LABEL[detail.task.phase] ?? detail.task.phase}</dd>
        <dt>连接</dt>
        <dd>{live.length === 0 ? '无活动会话' : live.map((s) => s.connectionState).join(' · ')}</dd>
        <dt>进程</dt>
        <dd>
          {current && !current.closedAt && current.processRef?.pid
            ? `pid ${current.processRef.pid} · ${current.processHealth}`
            : current?.closedAt
              ? `会话已结束(${current.processHealth})`
              : current
                ? current.processHealth
                : '—'}
        </dd>
        <dt>活动</dt>
        <dd>{current ? ACTIVITY_LABEL[current.activity] ?? current.activity : '—'}</dd>
        <dt>最后事件</dt>
        <dd>
          {ago(lastAt)} <span className="muted mono small">({clock(lastAt)})</span>
        </dd>
        <dt>本次耗时</dt>
        <dd>{elapsed ? <span className="mono">{elapsed}</span> : running ? '刚开始' : '—'}</dd>
      </dl>

      {participant.isLead && detail.plan ? (
        <>
          <div className="panel-title">计划(主控)</div>
          <dl className="kv">
            <dt>当前版本</dt>
            <dd>
              计划 v{detail.plan.number}{' '}
              <span className={`chip ${detail.plan.status === 'approved' ? 'green' : 'amber'}`}>{detail.plan.status}</span>
            </dd>
            <dt>工作项</dt>
            <dd>{detail.plan.content.workItems.length} 个 · 交付物 {detail.plan.content.deliverables.length} 份</dd>
            <dt>审核策略</dt>
            <dd>
              强模型席位 {detail.plan.content.reviewPolicy.strongParticipantIds.length} 个
              {detail.plan.content.reviewPolicy.crossReviewRequired ? ' · 需交叉复核' : ''}
            </dd>
            <dt>内容哈希</dt>
            <dd className="mono small">{detail.plan.contentHash.slice(0, 16)}…</dd>
          </dl>
        </>
      ) : null}

      <div className="panel-title">工作统计</div>
      <dl className="kv">
        <dt>工作项</dt>
        <dd>
          {items.length} 个 · 已接受 {items.filter((w) => w.state === 'accepted').length} · 进行中{' '}
          {items.filter((w) => ['running', 'verifying'].includes(w.state)).length}
        </dd>
        <dt>产物</dt>
        <dd>{myArtifacts.length} 个已登记</dd>
        <dt>验证</dt>
        <dd>
          {myVerifications.length} 项 · 通过 {myVerifications.filter((v) => v.status === 'passed').length}
        </dd>
        <dt>审核</dt>
        <dd>
          {reviewed.length === 0 ? '本任务无此席位结论' : reviewed.map((r) => r.verdict).join(' · ')}
        </dd>
      </dl>

      {items.length > 0 ? (
        <>
          <div className="panel-title">工作项明细</div>
          {items.map((w) => (
            <div className="card" key={w.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="small">{w.goal}</strong>
                <span className={`chip ${ITEM_TONE[w.state]}`}>{ITEM_LABEL[w.state]}</span>
              </div>
              <div className="small muted mono" style={{ marginTop: 4 }}>
                {shortId(w.id, 12)} · 尝试 {w.attemptCount} · 修复轮 {w.repairRound}
                {w.dependencyIds.length ? ` · 依赖 ${w.dependencyIds.length}` : ''}
              </div>
              <div className="small muted" style={{ marginTop: 3 }}>
                写入范围: <span className="mono">{w.writeScope.join(', ') || '未声明'}</span>
              </div>
              {w.lastError ? (
                <div className="err small" style={{ marginTop: 4 }}>
                  {w.lastError}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      {live.length > 0 ? (
        <>
          <div className="panel-title">活动会话</div>
          {live.map((s) => (
            <div className="card" key={s.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono small">{shortId(s.id, 12)}</span>
                <span className="chip cyan">{ACTIVITY_LABEL[s.activity] ?? s.activity}</span>
              </div>
              <div className="small muted mono" style={{ marginTop: 3 }}>
                {s.purpose} · 起于 {clock(s.createdAt)}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm danger" disabled={busy} onClick={() => void cancel(s.id)}>
                  请求取消
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {err ? <div className="err small">{err}</div> : null}

      <div className="panel-title">最近尝试</div>
      {attempts.length === 0 ? (
        <div className="small muted">暂无尝试记录。</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>阶段</th>
              <th>状态</th>
              <th>开始</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id}>
                <td>{a.kind}</td>
                <td>
                  <span className={`chip ${attemptTone(a.status)}`}>{a.status}</span>
                </td>
                <td className="mono">{clock(a.startedAt)}</td>
                <td className="mono">
                  {a.endedAt ? duration(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : '进行中'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {myArtifacts.length > 0 ? (
        <>
          <div className="panel-title">该节点产出</div>
          {myArtifacts.map((a) => (
            <div className="small mono" key={a.id} style={{ padding: '2px 0' }}>
              {a.relativePath} <span className="muted">· {bytes(a.size)}</span>
            </div>
          ))}
        </>
      ) : null}

      <div className="panel-title">该节点最近事件</div>
      {lastEvents.length === 0 ? (
        <div className="small muted">暂无事件。</div>
      ) : (
        <div className="tl">
          {lastEvents.map((e) => (
            <div className="tl-row" key={e.eventId}>
              <span className="tl-seq">{e.seq}</span>
              <span className="tl-type">{e.type}</span>
              <span className="tl-body">{clock(e.observedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
