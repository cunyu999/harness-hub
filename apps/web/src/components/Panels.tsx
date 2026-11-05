import { useEffect, useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import { VERDICT_LABEL, VERDICT_TONE, ago, bytes, clock, shortId, stamp } from '../lib/format';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';

/* ---------------------------- 审批 / 用户输入 ---------------------------- */

export function ApprovalPanel({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = detail.approvalsPending;

  const resolve = async (id: string, decision: 'approve' | 'deny' | 'cancel' | 'answer') => {
    setBusy(id);
    setErr(null);
    try {
      await api.resolveApproval(id, { decision, answer: answer[id]?.trim() || undefined });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="small muted">
        审批请求直接来自原生 harness 的审批事件; 程序不会替你选择。会话已结束时请求会标记为过期。
      </div>
      {pending.length === 0 ? <div className="empty">当前没有待处理的审批或输入请求。</div> : null}
      {pending.map((a) => (
        <div className="card warn" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong className="small">{a.title}</strong>
            <span className="chip amber">{a.kind}</span>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {a.detailRedacted}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 4 }}>
            {shortId(a.id, 12)} · {ago(a.createdAt)} · 会话 {shortId(a.sessionId, 10)}
          </div>
          {a.kind === 'user_input' ? (
            <textarea
              placeholder="回答内容(会作为 native 响应的 answer 回传)"
              value={answer[a.id] ?? ''}
              onChange={(e) => setAnswer((prev) => ({ ...prev, [a.id]: e.target.value }))}
              style={{ width: '100%', minHeight: 56, marginTop: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 9, padding: 8 }}
            />
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            {a.kind === 'user_input' ? (
              <button className="btn primary sm" disabled={busy === a.id} onClick={() => void resolve(a.id, 'answer')}>
                提交回答
              </button>
            ) : (
              <>
                <button className="btn primary sm" disabled={busy === a.id} onClick={() => void resolve(a.id, 'approve')}>
                  批准
                </button>
                <button className="btn danger sm" disabled={busy === a.id} onClick={() => void resolve(a.id, 'deny')}>
                  拒绝
                </button>
              </>
            )}
            <button className="btn ghost sm" disabled={busy === a.id} onClick={() => void resolve(a.id, 'cancel')}>
              取消该请求
            </button>
          </div>
        </div>
      ))}
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}

/* -------------------------------- 审核 -------------------------------- */

export function ReviewPanel({ detail }: { detail: TaskDetail }) {
  const rounds = [...detail.reviewRounds].sort((a, b) => b.number - a.number);
  return (
    <div className="stack">
      <div className="small muted">
        审核结果绑定该轮产物集合哈希; 强模型数量 ≥2 时先独立审核再交叉复核, 某一席位失败不会被静默忽略。
      </div>
      {rounds.length === 0 ? <div className="empty">尚无审核轮次。</div> : null}
      {rounds.map((r) => {
        const results = detail.reviewResults.filter((x) => x.roundId === r.id);
        return (
          <div className="card" key={r.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong className="small">审核第 {r.number} 轮</strong>
              <span className={`chip ${r.status === 'completed' ? 'green' : r.status === 'running' ? 'cyan' : 'muted'}`}>{r.status}</span>
            </div>
            <div className="mono muted" style={{ fontSize: 10, marginTop: 3 }}>
              产物集 {r.artifactSetHash.slice(0, 10)} · {stamp(r.createdAt)}
            </div>
            {results.length === 0 ? <div className="small muted" style={{ marginTop: 6 }}>本轮尚未产生结果。</div> : null}
            {results.map((res) => {
              const p = detail.participants.find((x) => x.id === res.participantId);
              return (
                <div key={res.id} style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 7 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="small">{p?.displayName ?? shortId(res.participantId)}</span>
                    <span className={`chip ${VERDICT_TONE[res.verdict] ?? 'muted'}`}>{VERDICT_LABEL[res.verdict] ?? res.verdict}</span>
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>
                    {res.summary}
                  </div>
                  {res.crossChecked?.length ? (
                    <div className="mono muted" style={{ fontSize: 10, marginTop: 3 }}>
                      交叉复核 {res.crossChecked.length} 条
                    </div>
                  ) : null}
                  {res.findings?.map((f) => (
                    <div className="small" key={f.id} style={{ marginTop: 4 }}>
                      <span className={`chip ${f.severity === 'blocker' ? 'red' : f.severity === 'major' ? 'amber' : 'muted'}`}>{f.severity}</span>{' '}
                      {f.title}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {f.detail}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="panel-title">验证记录</div>
      {detail.verifications.length === 0 ? <div className="small muted">尚无验证记录。</div> : null}
      {detail.verifications.slice(-12).reverse().map((v) => (
        <div className="tl-row" key={v.id}>
          <span className="tl-seq">{v.method}</span>
          <span className={v.status === 'passed' ? 'chip green' : v.status === 'failed' ? 'chip red' : 'chip muted'}>{v.status}</span>
          <span className="tl-body">{v.detail || v.checkId}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- 产物 -------------------------------- */

export function ArtifactPanel({ detail }: { detail: TaskDetail }) {
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const art = detail.artifacts.find((a) => a.id === active) ?? null;

  useEffect(() => {
    if (!art || art.mediaType.startsWith('image/') || art.mediaType === 'application/pdf') {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContent(null);
    setErr(null);
    fetch(art.contentUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (!cancelled) setContent(t.slice(0, 200_000));
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [art]);

  return (
    <div className="stack">
      <div className="small muted">只展示已登记产物; 路径越界或未登记的文件不会出现在这里。</div>
      {detail.artifacts.length === 0 ? <div className="empty">尚无产物。</div> : null}
      {detail.artifacts.map((a) => (
        <div
          key={a.id}
          className={`artifact-row ${active === a.id ? 'active' : ''}`}
          onClick={() => setActive(active === a.id ? null : a.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setActive(active === a.id ? null : a.id);
          }}
        >
          <span className={`chip ${a.status === 'registered' ? 'green' : 'muted'}`}>{a.mediaType.split('/')[1] ?? a.mediaType}</span>
          <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.relativePath}
          </span>
          <span className="mono muted" style={{ fontSize: 10 }}>
            {bytes(a.size)}
          </span>
        </div>
      ))}

      {art ? (
        <div>
          <div className="panel-title">预览</div>
          <div className="small mono muted">
            {art.relativePath} · sha256 {art.sha256.slice(0, 12)} · {stamp(art.registeredAt)}
          </div>
          <div className="preview">
            {!art.exists ? (
              <div className="empty">文件已不存在(可能被移动或删除)。</div>
            ) : art.mediaType.startsWith('image/') ? (
              <img src={art.contentUrl} alt={art.relativePath} />
            ) : art.mediaType === 'application/pdf' ? (
              <iframe src={art.contentUrl} title={art.relativePath} />
            ) : content !== null ? (
              <pre>{content}</pre>
            ) : err ? (
              <div className="empty">{err}</div>
            ) : (
              <div className="empty">加载中…</div>
            )}
          </div>
          <div className="row">
            <a className="btn sm" href={art.contentUrl} target="_blank" rel="noreferrer">
              在新标签打开
            </a>
            <a className="btn sm" href={art.contentUrl} download>
              下载
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------- 事件 -------------------------------- */

const NOISY = new Set(['message.delta']);

export function EventTimeline({ events, highWaterSeq }: { events: EventEnvelope[]; highWaterSeq?: number }) {
  const [hideNoisy, setHideNoisy] = useState(true);
  const [query, setQuery] = useState('');
  const list = events
    .filter((e) => (hideNoisy ? !NOISY.has(e.type) : true))
    .filter((e) => (query.trim() ? e.type.includes(query.trim()) || JSON.stringify(e.payload ?? {}).includes(query.trim()) : true))
    .slice(-400)
    .reverse();

  return (
    <div className="stack">
      <div className="row">
        <input
          type="text"
          placeholder="按事件类型或内容过滤"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 8px', fontSize: 11.5 }}
        />
        <label className="chk" style={{ padding: '3px 8px' }}>
          <input type="checkbox" checked={hideNoisy} onChange={(e) => setHideNoisy(e.target.checked)} />
          隐藏增量
        </label>
      </div>
      <div className="small muted">        本页缓存 {events.length} 条事件{typeof highWaterSeq === 'number' ? ' · 事件高水位 #' + highWaterSeq : ''}, 显示最近 {list.length} 条。seq 单调递增(只增不减), 断线重连时用它续传, 和完成进度无关。      </div>
      <div className="tl">
        {list.map((e) => (
          <div className="tl-row" key={e.eventId}>
            <span className="tl-seq">{e.seq}</span>
            <span className="tl-type" title={e.type}>
              {e.type}
            </span>
            <span className="tl-body" title={JSON.stringify(e.payload ?? {})}>
              {clock(e.observedAt)} · {shortId(e.sessionId ?? e.attemptId ?? '', 10) || '—'} · {summarize(e)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarize(e: EventEnvelope): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  for (const key of ['message', 'text', 'summary', 'detail', 'reason', 'state', 'errorCode', 'status', 'goal']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 90);
  }
  const keys = Object.keys(p);
  return keys.length ? keys.slice(0, 4).join(', ') : '—';
}
