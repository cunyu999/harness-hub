import { useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import { ITEM_LABEL, ITEM_TONE, stamp } from '../lib/format';

export function PlanPanel({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const plan = detail.plan;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const awaiting = detail.task.lifecycle === 'awaiting_plan_approval' && plan;

  const decide = async (decision: 'approve' | 'supplement' | 'replan') => {
    if (!plan) return;
    if (decision !== 'approve' && notesTrim().length === 0) {
      setErr('请先写下补充内容或重新计划的理由。');
      return;
    }
    setBusy(decision);
    setErr(null);
    try {
      await api.planDecision(detail.task.id, {
        decision,
        planRevisionId: plan.id,
        planHash: plan.contentHash,
        participantsRevision: detail.task.participantsRevision,
        expectedTaskVersion: detail.task.version,
        note: notesTrim() || undefined,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const notesTrim = () => note.trim();

  if (!plan) {
    return (
      <div className="stack">
        <div className="empty">尚未生成计划。请先在“新建任务”中选定参与者，然后请求规划。</div>
        <button
          className="btn primary"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('plan');
            setErr(null);
            try {
              await api.requestPlan(detail.task.id, 'initial');
              onChanged();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'plan' ? '规划中…' : '请求规划'}
        </button>
        {err ? <div className="err">{err}</div> : null}
      </div>
    );
  }

  const items = plan.content.workItems;

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>计划 v{plan.number}</strong>
          <span className={`chip ${plan.status === 'approved' ? 'green' : plan.status === 'superseded' ? 'muted' : 'violet'}`}>{plan.status}</span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {stamp(plan.createdAt)} · 哈希 <span className="mono">{plan.contentHash.slice(0, 12)}</span> · 参与者版本{' '}
          {detail.task.participantsRevision}
        </div>
        {plan.summary ? <div className="small" style={{ marginTop: 6 }}>{plan.summary}</div> : null}
        {plan.content.clarificationNeeded?.length ? (
          <div className="card warn" style={{ marginTop: 8, marginBottom: 0 }}>
            <h5>计划中标记的待澄清问题</h5>
            <ul className="small" style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {plan.content.clarificationNeeded.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="panel-title">工作项 ({items.length})</div>
      <table className="grid plan-grid">
        <colgroup>
          <col />
          <col style={{ width: 96 }} />
          <col style={{ width: 72 }} />
        </colgroup>
        <thead>
          <tr>
            <th>目标</th>
            <th>执行者</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const live = detail.workItems.find((w) => w.planItemId === it.id);
            const p = detail.participants.find((x) => x.id === it.assignedParticipantId);
            return (
              <tr key={it.id}>
                <td>
                  <div>{it.goal}</div>
                  <div className="mono muted" style={{ fontSize: 10 }}>
                    {it.id}
                    {it.dependencies.length ? ` · 依赖 ${it.dependencies.join(',')}` : ''}
                  </div>
                </td>
                <td className="small">{p?.displayName ?? it.assignedParticipantId ?? '—'}</td>
                <td>{live ? <span className={`chip ${ITEM_TONE[live.state]}`}>{ITEM_LABEL[live.state]}</span> : <span className="chip muted">未创建</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {plan.content.deliverables?.length ? (
        <>
          <div className="panel-title">交付物</div>
          {plan.content.deliverables.map((d, i) => (
            <div className="card" key={i}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">{d.label}</span>
                <span className="chip muted">{d.format}</span>
              </div>
              <div className="mono muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                {d.destination}
              </div>
            </div>
          ))}
        </>
      ) : null}

      {plan.content.verificationSteps?.length ? (
        <>
          <div className="panel-title">验证步骤</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 17 }}>
            {plan.content.verificationSteps.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </>
      ) : null}

      {plan.content.risks?.length ? (
        <>
          <div className="panel-title">风险</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 17 }}>
            {plan.content.risks.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </>
      ) : null}

      {awaiting ? (
        <>
          <div className="panel-title">计划确认</div>
          <div className="card">
            <div className="small muted">批准会绑定当前这个计划版本(哈希与参与者版本), 之后的内容改动不会自动沿用。</div>
            <textarea
              placeholder="补充内容或重新计划的理由(直接执行可留空)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ width: '100%', minHeight: 64, marginTop: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 9, padding: 8 }}
            />
            <div className="row" style={{ marginTop: 9 }}>
              <button className="btn primary" disabled={busy !== null} onClick={() => void decide('approve')}>
                {busy === 'approve' ? '提交中…' : '直接执行'}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => void decide('supplement')}>
                {busy === 'supplement' ? '提交中…' : '补充内容'}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => void decide('replan')}>
                {busy === 'replan' ? '提交中…' : '重新计划'}
              </button>
            </div>
            {err ? <div className="err" style={{ marginTop: 8 }}>{err}</div> : null}
          </div>
        </>
      ) : null}

      {detail.planHistory.length > 1 ? (
        <>
          <div className="panel-title">历史版本</div>
          {detail.planHistory.map((h) => (
            <div className="row small" key={h.id} style={{ justifyContent: 'space-between', padding: '3px 0' }}>
              <span>
                v{h.number} · {h.status}
              </span>
              <span className=" mono muted">{h.contentHash.slice(0, 10)}</span>
            </div>
          ))}
        </>
      ) : null}

      {err && !awaiting ? <div className="err">{err}</div> : null}
    </div>
  );
}
