import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import type { StreamDelta } from '../store';
import { clock, shortId } from '../lib/format';

/**
 * 消息正文: 结构化回合(计划/讨论/结果 JSON)默认折叠, 避免长 JSON 淹没对话。
 */
function MessageBody({ text, kind }: { text: string; kind: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson || trimmed.length < 240) return <>{text}</>;
  let title = kind;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.summary === 'string') title = `${kind} · ${parsed.summary.slice(0, 80)}`;
    else if (typeof parsed.goal === 'string') title = `${kind} · ${String(parsed.goal).slice(0, 80)}`;
    else if (Object.keys(parsed).length > 0) title = `${kind} · ${Object.keys(parsed).slice(0, 4).join(', ')}`;
  } catch {
    /* 不是合法 JSON 就按原文折叠 */
  }
  const bytes = new TextEncoder().encode(trimmed).length;
  const sizeLabel = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return (
    <div className="json-msg">
      <button className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? '收起结构化内容' : `展开结构化内容 (${sizeLabel})`} · {title}
      </button>
      {open ? <pre className="json-body">{text}</pre> : null}
    </div>
  );
}

export function Conversation({
  detail,
  deltas,
  onChanged,
}: {
  detail: TaskDetail;
  deltas: StreamDelta[];
  onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<'chat' | 'instruction' | 'answer' | 'supplement'>('chat');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const messages = useMemo(() => detail.messages ?? [], [detail.messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, deltas.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await api.sendMessage(detail.task.id, { text: t, intent: intent === 'supplement' ? 'supplement' : intent });
      setText('');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conv">
      <div className="conv-scroll" ref={scrollRef}>
        {messages.length === 0 ? <div className="empty">还没有消息。主控的计划讨论、执行摘要与交付说明都会出现在这里。</div> : null}
        {messages.map((m) => {
          const who =
            m.role === 'user'
              ? '你'
              : m.role === 'lead'
                ? '主控'
                : m.role === 'system'
                  ? '系统'
                  : detail.participants.find((p) => p.id === m.participantId)?.displayName ?? '参与者';
          return (
            <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : ''}`}>
              <div className="msg-head">
                <span>{who}</span>
                <span>{m.kind}</span>
                <span>{clock(m.createdAt)}</span>
                {m.incomplete ? <span className="chip amber">未完成</span> : null}
              </div>
              <div className="msg-body">
                <MessageBody text={m.text} kind={m.kind} />
              </div>
            </div>
          );
        })}
        {deltas.map((d) => (
          <div key={d.key} className="msg streaming">
            <div className="msg-head">
              <span>{d.role === 'system' ? '系统' : '实时输出'}</span>
              <span>{shortId(d.attemptId ?? d.sessionId, 10)}</span>
            </div>
            <div className="msg-body">{d.text || '…'}</div>
          </div>
        ))}
      </div>
      {['completed', 'blocked', 'failed'].includes(detail.task.lifecycle) ? (
        <div className="revise-hint">
          <span>
            任务已{detail.task.lifecycle === 'completed' ? '交付' : detail.task.lifecycle === 'blocked' ? '受阻' : '失败'}。
            不满意可以提修改要求: 选「补充计划」→ 写清楚要改哪里 → 发送。
          </span>
          <button
            className="btn"
            onClick={() => {
              setIntent('supplement');
              inputRef.current?.focus();
            }}
          >
            我要改成果
          </button>
        </div>
      ) : null}
      <div className="composer">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">统一主对话: 你的消息会交给主控会话处理, 不额外启动未声明的参与者。</span>
          <select
            value={intent}
            onChange={(e) => setIntent(e.target.value as typeof intent)}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--line)', borderRadius: 8, padding: '3px 6px', fontSize: 11.5 }}
          >
            <option value="chat">普通消息</option>
            <option value="instruction">指令</option>
            <option value="answer">回答追问</option>
            <option value="supplement">补充 / 要求修改</option>
          </select>
        </div>
        <textarea
          ref={inputRef}
          value={text}
          placeholder={
            intent === 'supplement' && ['completed', 'blocked', 'failed'].includes(detail.task.lifecycle)
              ? '写清楚要改哪里(例如: 第二节太笼统, 换成带步骤的版本), 然后发送 → 会重新出计划让你批准'
              : '输入消息… (Ctrl+Enter 发送)'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy || text.trim().length === 0} onClick={() => void send()}>
            {busy ? '发送中…' : '发送'}
          </button>
        </div>
        {err ? <div className="err">{err}</div> : null}
      </div>
    </div>
  );
}
