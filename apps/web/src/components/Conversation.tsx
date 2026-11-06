import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskDetail } from '../api';
import { api } from '../api';
import type { StreamDelta } from '../store';
import { clock, initials, shortId, tokens } from '../lib/format';
import { DirectoryPicker } from './DirectoryPicker';
import type { EventEnvelope } from '../../../../packages/contracts/src/events';
import { liveStatus } from '../lib/live';

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

const SANDBOX_LABEL: Record<SandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区内可写',
  'danger-full-access': '完全权限',
};

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
  events,
  usageLive,
  onChanged,
  target,
  onTargetChange,
  onOpenDetail,
}: {
  detail: TaskDetail;
  deltas: StreamDelta[];
  events: EventEnvelope[];
  /** 进行中的实时 token 用量(按 attempt)。 */
  usageLive?: { attemptId: string; participantId: string | null; total: number; input: number; output: number; cached: number }[];
  onChanged: () => void;
  target: string | null;
  onTargetChange: (participantId: string | null) => void;
  /** 打开这个席位的详情(工作项/尝试/产物)。 */
  onOpenDetail?: (participantId: string) => void;
}) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<'chat' | 'instruction' | 'answer' | 'supplement'>('chat');
  const [busy, setBusy] = useState(false);
  type Pending = { id: string; file: File; preview: string | null };
  const [pendingFiles, setPendingFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  /** 优先用 Windows 自带的文件夹选择框; 平台不支持或弹不出来时才回退到网页内浏览。 */
  const pickWorkspaceNative = async (participantId: string | null) => {
    try {
      const res = await api.pickDirectory(wsDraft.trim() || null);
      if (res.path) setWsDraft(res.path);
      return;
    } catch {
      setPickingWs(true);
    }
    void participantId;
  };

  const [pickingWs, setPickingWs] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<'none' | 'ws' | 'perm'>('none');
  const [restarting, setRestarting] = useState(false);
  const toolsRef = useRef<HTMLSpanElement | null>(null);
  const [popBox, setPopBox] = useState<{ right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (openPanel === 'none') {
      setPopBox(null);
      return;
    }
    const place = () => {
      const r = toolsRef.current?.getBoundingClientRect();
      if (!r) return;
      setPopBox({ right: Math.max(12, window.innerWidth - r.right), bottom: Math.max(12, window.innerHeight - r.top + 8) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [openPanel]);

  // 点空白处 / 按 Esc 关闭浮层(点按钮本身由按钮的切��逻辑负责, 这里排除掉)
  useEffect(() => {
    if (openPanel === 'none') return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (el.closest('.cs-popover')) return;
      if (el.closest('.composer-tools-wrap')) return;
      setOpenPanel('none');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPanel('none');
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [openPanel]);
  const [onlyThis, setOnlyThis] = useState(false);
  const [wsDraft, setWsDraft] = useState('');
  // 展示成相对任务工作区的路径, 太长时更好读
  const toRelative = (abs: string | null | undefined): string => {
    if (!abs) return '';
    const base = detail.workspace;
    if (base && abs.startsWith(base)) return abs.slice(base.length).replace(/^[\\/]+/, '');
    return abs;
  };
  const [sandboxDraft, setSandboxDraft] = useState<SandboxMode>('workspace-write');
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const messages = useMemo(() => detail.messages ?? [], [detail.messages]);
  const participants = detail.participants ?? [];
  const lead = participants.find((p) => p.isLead) ?? null;
  const currentId = target ?? lead?.id ?? null;
  const [tick, setTick] = useState(() => Date.now());
  const live = liveStatus(detail, events, currentId, tick);
  const liveTokens = (usageLive ?? [])
    .filter((u) => !currentId || u.participantId === currentId)
    .reduce((sum, u) => sum + u.total, 0);
  useEffect(() => {
    if (!live || live.tone !== 'run') return undefined;
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live?.tone, live?.label]);
  const current = participants.find((p) => p.id === currentId) ?? lead;
  const isLeadTarget = !!current && current.isLead;

  // 切换席位时, 把它的工作区/权限填进设置面板
  useEffect(() => {
    if (!current) return;
    setWsDraft(toRelative(current.workspaceRoot));
    setSandboxDraft((current.sandbox as SandboxMode) ?? 'workspace-write');
    setOpenPanel('none');
    setNotice(null);
  }, [current?.id, current?.workspaceRoot, current?.sandbox]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, deltas.length]);

  const visible = useMemo(() => {
    if (!onlyThis || !current || isLeadTarget) return messages;
    return messages.filter((m) => m.role === 'user' || m.participantId === current.id);
  }, [messages, onlyThis, current?.id, isLeadTarget]);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const next: Pending[] = [];
    for (const f of Array.from(files).slice(0, 8)) {
      if (f.size > 30 * 1024 * 1024) {
        setErr(`${f.name} 超过 30MB, 没有加入`);
        continue;
      }
      next.push({
        id: `${Date.now()}-${f.name}-${Math.random().toString(36).slice(2, 6)}`,
        file: f,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      });
    }
    if (next.length > 0) setPendingFiles((prev) => [...prev, ...next].slice(0, 8));
  };

  const readBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

  const send = async () => {
    const t = text.trim();
    if (!t && pendingFiles.length === 0) return;
    if (!t) {
      setErr('带附件时也写一句话, 说明希望模型拿这些文件做什么');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const uploaded = [];
      for (const item of pendingFiles) {
        const dataBase64 = await readBase64(item.file);
        const ref = await api.uploadAttachment(detail.task.id, {
          name: item.file.name || 'file',
          dataBase64,
          mediaType: item.file.type || undefined,
        });
        uploaded.push(ref);
      }
      await api.sendMessage(detail.task.id, {
        text: t,
        intent: intent === 'supplement' ? 'supplement' : intent,
        participantId: isLeadTarget ? null : (current?.id ?? null),
        attachments: uploaded,
      });
      setText('');
      setPendingFiles((prev) => {
        for (const p2 of prev) if (p2.preview) URL.revokeObjectURL(p2.preview);
        return [];
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 该席位当前是否有未结束的会话(用于"改动要等下一回合"还是"可以立即重启")
  const runningSessionId = useMemo(() => {
    if (!current) return null;
    const open = (detail.sessions ?? []).filter(
      (x) => x.participantId === current.id && !x.closedAt,
    );
    return open.length > 0 ? open[open.length - 1].id : null;
  }, [detail.sessions, current?.id]);

  const restartSession = async () => {
    if (!runningSessionId) return;
    setRestarting(true);
    setErr(null);
    try {
      await api.control(detail.task.id, 'cancel_session', runningSessionId, 'settings_changed');
      setNotice('已请求重启该席位的会话; 新的工作区/权限会在它重新开始时生效。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
    }
  };

  // 两个面板各自只提交自己的字段: 后端把 undefined 当"不改", 所以互不影响
  const saveWorkspace = async () => {
    if (!current) return;
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      const ws = wsDraft.trim();
      const res = await api.updateParticipant(detail.task.id, current.id, {
        workspaceRoot: ws.length > 0 ? ws : null,
      });
      const resolved = (res.participant as { workspaceRoot?: string | null }).workspaceRoot;
      setNotice(
        (resolved ? `工作目录已保存: ${resolved}。` : '工作目录已回到自动分配。') +
          (runningSessionId ? ' 该席位正在运行: 新目录会在本回合结束后生效, 点「立即重启会话」可马上切换。' : ' 下一个回合生效。'),
      );
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const savePermission = async () => {
    if (!current) return;
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      await api.updateParticipant(detail.task.id, current.id, { sandbox: sandboxDraft });
      setNotice(
        `权限已保存: ${SANDBOX_LABEL[sandboxDraft]}。` +
          (runningSessionId ? ' 该席位正在运行: 权限会在本回合结束后生效, 点「立即重启会话」可马上应用。' : ' 下一个回合生效。'),
      );
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="conv">
      {current ? (
        <div className="conv-ident">
          <span className="conv-avatar">{initials(current.displayName)}</span>
          <div className="conv-ident-main">
            <div className="conv-ident-name">
              {current.displayName}
              <span className={`chip ${isLeadTarget ? 'accent' : 'muted'}`}>
                {isLeadTarget ? '主控' : current.role === 'strong' ? '强模型' : '执行者'}
              </span>
              <span
                className={`chip ${
                  current.sandbox === 'read-only'
                    ? 'amber'
                    : current.sandbox === 'danger-full-access'
                      ? 'red'
                      : 'green'
                }`}
              >
                {SANDBOX_LABEL[(current.sandbox as SandboxMode) ?? 'workspace-write']}
              </span>
            </div>
            <div className="conv-ident-cwd" title={current.workspaceRoot ?? ''}>
              {current.workspaceRoot
                ? toRelative(current.workspaceRoot)
                : '工作区: 自动分配(角色大工作区 + 席位小工作区)'}
            </div>
          </div>
          {onOpenDetail ? (
            <button className="btn tiny" onClick={() => onOpenDetail(current.id)} title="工作项、尝试、产物与最近事件">
              详情
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="conv-target">
        <label className="small muted" htmlFor="conv-target-select">
          对话对象
        </label>
        <select
          id="conv-target-select"
          value={currentId ?? ''}
          onChange={(e) => {
            const next = e.target.value;
            onTargetChange(participants.find((p) => p.id === next && !p.isLead) ? next : null);
          }}
        >
          {lead ? <option value={lead.id}>{lead.displayName}(主控)</option> : null}
          {participants
            .filter((p) => !p.isLead)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}({p.role === 'strong' ? '强模型' : '执行者'})
              </option>
            ))}
        </select>
        {!isLeadTarget ? (
          <label className="small muted row" style={{ gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />
            只看与它的对话
          </label>
        ) : null}
      </div>

      <div className="conv-scroll" ref={scrollRef}>
        {visible.length === 0 ? (
          <div className="empty">
            还没有消息。主控的计划讨论、各席位的执行摘要与交付说明都会出现在这里;
            在上方切换对话对象, 可以直接和某个 harness 说话。
          </div>
        ) : null}
        {visible.map((m) => {
          const who =
            m.role === 'user'
              ? '你'
              : m.role === 'lead'
                ? '主控'
                : m.role === 'system'
                  ? '系统'
                  : participants.find((p) => p.id === m.participantId)?.displayName ?? '参与者';
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
                {m.attachments && m.attachments.length > 0 ? (
                  <div className="msg-attach">
                    {m.attachments.map((a) => (
                      <span key={a.path} className="attach-chip" title={a.path}>
                        <span className="attach-name">{a.name}</span>
                        <span className="small muted">{Math.max(1, Math.round(a.size / 1024))}KB</span>
                      </span>
                    ))}
                  </div>
                ) : null}
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
            不满意可以提修改要求: 选「补充 / 要求修改」→ 写清楚要改哪里 → 发送。
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
      <div
        className="composer"
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">
            <span>
              {current
              ? `正在和 ${current.displayName}(${isLeadTarget ? '主控' : current.role === 'strong' ? '强模型' : '执行者'})对话`
              : '统一主对话'}
            </span>
          </span>
          <span className="composer-tools-wrap" ref={toolsRef}>
            {openPanel !== 'none' && current ? (
              <div
                className="cs-popover"
                role="dialog"
                aria-label="席位设置"
                style={{
                  position: 'fixed',
                  right: popBox?.right ?? 16,
                  bottom: popBox?.bottom ?? 120,
                  width: 'min(420px, calc(100vw - 24px))',
                  zIndex: 60,
                }}
              >
                {openPanel === 'ws' && current ? (
                        <div className="conv-settings">
                          <div className="cs-row cs-row-stack">
                            <span className="cs-label">工作目录</span>
                            <div className="cs-fields">
                              <input
                                className="cs-input"
                                value={wsDraft}
                                placeholder="绝对路径, 或相对任务工作区(例如 planner/claude); 留空 = 自动分配"
                                onChange={(e) => setWsDraft(e.target.value)}
                              />
                              <div className="cs-actions">
                                <button
                                  type="button"
                                  className="btn tiny"
                                  onClick={() => {
                                    void pickWorkspaceNative(current?.id ?? null);
                                  }}
                                >
                                  选择…
                                </button>
                                {runningSessionId ? (
                                  <button type="button" className="btn tiny" disabled={restarting} onClick={() => void restartSession()}>
                                    {restarting ? '重启中…' : '立即重启会话'}
                                  </button>
                                ) : null}
                                <button className="btn primary tiny" disabled={saving} onClick={() => void saveWorkspace()}>
                                  {saving ? '保存中…' : '保存工作区'}
                                </button>
                              </div>
                            </div>
                          </div>
                          <p className="small muted cs-hint">
                            留空 = <code>{"<大工作区>/"}{current.role === 'strong' ? 'planner' : 'worker'}/{"<席位名>"}</code>;
                            也可以填相对任务工作区的路径(例如 <code>worker/experiments</code>)或绝对路径。改动对下一个回合生效;
                            席位正在跑时可以点「立即重启会话」马上切换。
                          </p>
                          {notice ? <div className="cs-notice">{notice}</div> : null}
                        </div>
                      ) : null}
                
                      {openPanel === 'perm' && current ? (
                        <div className="conv-settings">
                          <div className="cs-row">
                            <span className="cs-label">会话权限</span>
                            <select value={sandboxDraft} onChange={(e) => setSandboxDraft(e.target.value as SandboxMode)}>
                              {(Object.keys(SANDBOX_LABEL) as SandboxMode[]).map((m) => (
                                <option key={m} value={m}>
                                  {SANDBOX_LABEL[m]}
                                </option>
                              ))}
                            </select>
                            {runningSessionId ? (
                              <button type="button" className="btn tiny" disabled={restarting} onClick={() => void restartSession()}>
                                {restarting ? '重启中…' : '立即重启会话'}
                              </button>
                            ) : null}
                            <button className="btn primary tiny" disabled={saving} onClick={() => void savePermission()}>
                              {saving ? '保存中…' : '保存权限'}
                            </button>
                          </div>
                          <p className="small muted cs-hint">
                            权限由 harness 原生能力执行: Codex 用沙箱、Claude 用 permissionMode + 工具放行、DSH 只能靠提示词与事后审计。
                            改动在下一个回合生效, 正在跑的会话不受影响。
                          </p>
                          {notice ? <div className="cs-notice">{notice}</div> : null}
                        </div>
                      ) : null}
              </div>
            ) : null}
            <span className="composer-tools">
            <button
              type="button"
              className={`btn tiny ${openPanel === 'ws' ? 'on' : ''}`}
              title="改这个席位的工作目录"
              onClick={() => {
                setNotice(null);
                setOpenPanel((v) => (v === 'ws' ? 'none' : 'ws'));
              }}
            >
              工作区
            </button>
            <button
              type="button"
              className={`btn tiny ${openPanel === 'perm' ? 'on' : ''}`}
              title="改这个席位的会话权限"
              onClick={() => {
                setNotice(null);
                setOpenPanel((v) => (v === 'perm' ? 'none' : 'perm'));
              }}
            >
              权限
            </button>
          <select
            value={intent}
            onChange={(e) => setIntent(e.target.value as typeof intent)}
            className="tiny-select"
          >
            <option value="chat">普通消息</option>
            <option value="instruction">指令</option>
            <option value="answer">回答追问</option>
            <option value="supplement">补充 / 要求修改</option>
          </select>
            </span>
          </span>
        </div>
        {live ? (
          <div className={'conv-live ' + live.tone}>
            <span className="dot" />
            <b>{live.label}</b>
            {live.detail ? <span className="live-detail">{live.detail}</span> : null}
            {live.since ? (
              <span className="live-time">{fmtElapsed(tick - live.since)}</span>
            ) : null}
            {liveTokens > 0 ? <span className="live-time" title="本回合最近一次上报的 token 用量">· {tokens(liveTokens)} tokens</span> : null}
          </div>
        ) : null}
        {pendingFiles.length > 0 ? (
          <div className="attach-row">
            {pendingFiles.map((f) => (
              <span key={f.id} className="attach-chip" title={f.file.name}>
                {f.preview ? <img src={f.preview} alt={f.file.name} /> : null}
                <span className="attach-name">{f.file.name}</span>
                <span className="small muted">{Math.max(1, Math.round(f.file.size / 1024))}KB</span>
                <button
                  type="button"
                  title="移除"
                  onClick={() =>
                    setPendingFiles((prev) => {
                      if (f.preview) URL.revokeObjectURL(f.preview);
                      return prev.filter((x) => x.id !== f.id);
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {dragging ? <div className="drop-hint">松手即添加附件</div> : null}
        <textarea
          ref={inputRef}
          value={text}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          placeholder={
            intent === 'supplement' && ['completed', 'blocked', 'failed'].includes(detail.task.lifecycle)
              ? '写清楚要改哪里(例如: 第二节太笼统, 换成带步骤的版本), 然后发送 → 会重新出计划让你批准'
              : isLeadTarget
                ? '输入消息… (Enter 发送, Shift+Enter 换行, 发给主控)'
                : `输入消息… (Enter 发送, Shift+Enter 换行, 只发给 ${current?.displayName ?? '该席位'})`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 像普通 harness 的对话: Enter 直接发送, Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && text.trim().length > 0) void send();
            }
          }}
        />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="composer-attach">
            <button
              type="button"
              className="btn tiny"
              title="添加文件或图片(也可以直接拖进输入区 / 直接粘贴截图)"
              onClick={() => fileRef.current?.click()}
            >
              + 附件
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <span className="small muted">文件会存到任务工作区 uploads/ 下</span>
          </span>
          <button className="btn primary" disabled={busy || (text.trim().length === 0 && pendingFiles.length === 0)} onClick={() => void send()}>
            {busy ? '发送中…' : isLeadTarget ? '发送给主控' : `发送给 ${current?.displayName ?? '席位'}`}
          </button>
        </div>
        {err ? <div className="err">{err}</div> : null}
      </div>
      {pickingWs && current ? (
        <DirectoryPicker
          title={`选择 ${current.displayName} 的工作目录`}
          initial={wsDraft.trim() || null}
          onClose={() => setPickingWs(false)}
          onPick={(abs) => {
            setWsDraft(abs);
            setPickingWs(false);
          }}
        />
      ) : null}
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 60) return t + 's';
  const m = Math.floor(t / 60);
  const r = t % 60;
  return m + 'm' + String(r).padStart(2, '0') + 's';
}
