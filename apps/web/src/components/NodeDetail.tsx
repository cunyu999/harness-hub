import { useMemo, useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import type { GraphSelection } from './CollabGraph';
import { ACTIVITY_LABEL, ITEM_LABEL, ITEM_TONE, ago, clock, shortId } from '../lib/format';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';

export function NodeDetail({
  detail,
  selection,
  events,
  onClose,
  onChanged,
}: {
  detail: TaskDetail;
  selection: GraphSelection;
  events: EventEnvelope[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const participant = useMemo(
    () => (selection?.kind === 'participant' ? detail.participants.find((p) => p.id === selection.id) ?? null : null),
    [detail.participants, selection],
  );

  if (!selection) return null;

  if (selection.kind === 'artifact') {
    return (
      <div className="detail">
        <h4>
          交付物
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </h4>
        <dl className="kv">
          <dt>已登记</dt>
          <dd>{detail.artifacts.length}</dd>
          <dt>工作项</dt>
          <dd>
            {detail.workItems.filter((w) => w.state === 'accepted').length}/{detail.workItems.length} 已接受
          </dd>
          <dt>交付目录</dt>
          <dd>{detail.workspace || '—'}</dd>
          <dt>审核轮次</dt>
          <dd>{detail.reviewRounds.length}</dd>
        </dl>
        <div className="small muted">交付物在右侧“产物”页签查看与预览。</div>
      </div>
    );
  }

  if (!participant) {
    return (
      <div className="detail">
        <h4>
          节点
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </h4>
        <div className="muted small">该节点不存在。</div>
      </div>
    );
  }

  const sessions = detail.sessions.filter((s) => s.participantId === participant.id);
  const live = sessions.filter((s) => !s.closedAt);
  const attempts = detail.attempts.filter((a) => a.participantId === participant.id).slice(-6).reverse();
  const items = detail.workItems.filter((w) => w.assignedParticipantId === participant.id);
  const lastEvents = events.filter((e) => e.sessionId && sessions.some((s) => s.id === e.sessionId)).slice(-8).reverse();

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
    <div className="detail">
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

      <dl className="kv">
        <dt>配置</dt>
        <dd>{detail.profiles.find((p) => p.id === participant.profileId)?.adapterId ?? '—'}</dd>
        <dt>观测模型</dt>
        <dd>{live[0]?.observedModel ?? sessions[0]?.observedModel ?? '—'}</dd>
        <dt>推理配置</dt>
        <dd>{live[0]?.observedReasoning ?? sessions[0]?.observedReasoning ?? '—'}</dd>
        <dt>连接</dt>
        <dd>{live.length === 0 ? '无活动会话' : live.map((s) => s.connectionState).join(', ')}</dd>
        <dt>进程</dt>
        <dd>{live[0]?.processRef?.pid ? `pid ${live[0].processRef.pid} · ${live[0].processHealth}` : '—'}</dd>
        <dt>活动</dt>
        <dd>{live[0] ? ACTIVITY_LABEL[live[0].activity] : '—'}</dd>
        <dt>最后事件</dt>
        <dd>{live[0] ? ago(live[0].lastEventAt) : '—'}</dd>
      </dl>

      {items.length > 0 ? (
        <>
          <div className="panel-title">工作项</div>
          {items.map((w) => (
            <div className="card" key={w.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="small">{w.goal}</strong>
                <span className={`chip ${ITEM_TONE[w.state]}`}>{ITEM_LABEL[w.state]}</span>
              </div>
              <div className="small muted mono" style={{ marginTop: 4 }}>
                {shortId(w.id, 12)} · 尝试 {w.attemptCount} · 修复轮 {w.repairRound}
              </div>
              {w.lastError ? <div className="err small" style={{ marginTop: 4 }}>{w.lastError}</div> : null}
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
                <span className="mono">{shortId(s.id, 12)}</span>
                <span className="chip cyan">{s.activity}</span>
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
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id}>
                <td>{a.kind}</td>
                <td>
                  <span className={`chip ${a.status === 'completed' ? 'green' : a.status === 'failed' ? 'red' : 'muted'}`}>{a.status}</span>
                </td>
                <td className="mono">{clock(a.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
