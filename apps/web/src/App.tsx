import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProfileDto } from './api';
import { useTask, useTaskList } from './store';
import { CollabGraph, type GraphSelection } from './components/CollabGraph';
import { NodeDetail } from './components/NodeDetail';
import { PlanPanel } from './components/PlanPanel';
import { ApprovalPanel, ArtifactPanel, EventTimeline, ReviewPanel } from './components/Panels';
import { Conversation } from './components/Conversation';
import { NewTaskDialog, ProfilesPanel } from './components/Dialogs';
import { LIFECYCLE_LABEL, LIFECYCLE_TONE, PHASES, PHASE_LABEL, clock, shortId } from './lib/format';
import { useTheme } from './lib/theme';
import { usePageLifecycle } from './lib/runtime';

type Tab = 'plan' | 'chat' | 'approvals' | 'review' | 'artifacts' | 'events';

const TERMINAL = ['completed', 'cancelled', 'failed'];

export function App() {
  const [profiles, setProfiles] = useState<ProfileDto[]>([]);
  const [taskId, setTaskId] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('task');
    if (fromUrl) return fromUrl;
    return localStorage.getItem('hh.taskId');
  });
  const [tab, setTab] = useState<Tab>('plan');
  const [selection, setSelection] = useState<GraphSelection>(null);
  // 对话对象: null = 主控, 否则是某个席位的 participantId
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { tasks, reload: reloadTasks } = useTaskList();

  /**
   * 点画布上的席位 = 直接和它对话(像点开一个普通 harness);
   * 点计划/交付卡 = 看详情。席位详情从对话栏的「详情」按钮进。
   */
  const pickSelection = (next: GraphSelection) => {
    if (next && next.kind === 'participant') {
      setChatTarget(next.id);
      setSelection(null);
      setTab('chat');
      return;
    }
    setSelection((prev) => {
      if (!prev || !next) return next;
      if (prev.kind !== next.kind) return next;
      return null;
    });
  };

  const terminalTasks = tasks.filter((t) => ['completed', 'cancelled', 'failed'].includes(t.lifecycle));

  const removeFinished = async () => {
    if (terminalTasks.length === 0) return;
    const ok = window.confirm(
      `删除 ${terminalTasks.length} 个已结束的任务?\n\n它们的事件、对话、计划与工作项都会删除, 已登记的成果产物会归档到 .local/archive/<taskId>/。\n\n此操作不可撤销。`,
    );
    if (!ok) return;
    let files = 0;
    for (const t of terminalTasks) {
      try {
        const res = await api.deleteTask(t.id);
        files += res.files;
        if (taskId === t.id) {
          setTaskId(null);
      localStorage.removeItem('hh.taskId');
          setSelection(null);
    setChatTarget(null);
          localStorage.removeItem('hh.taskId');
        }
      } catch (e) {
        window.alert(`删除「${t.title}」失败: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    await reloadTasks();
    window.alert(`已清理 ${terminalTasks.length} 个任务, 归档产物 ${files} 个。`);
  };

  const removeTask = async (t: { id: string; title: string }) => {
    const ok = window.confirm(
      `删除任务「${t.title}」?\n\n会删除: 任务记录、计划、工作项、会话与全部对话、事件、审核与验证记录。\n会保留: 成果产物(归档到 .local/archive/${t.id}/, 附一份 manifest.json)。\n如果任务用的是你自己的目录, 里面的其它文件不会被改动。\n\n此操作不可撤销。`,
    );
    if (!ok) return;
    try {
      const res = await api.deleteTask(t.id);
      if (taskId === t.id) {
        setTaskId(null);
        setSelection(null);
        localStorage.removeItem('hh.taskId');
      }
      await reloadTasks();
      window.alert(
        res.files > 0
          ? `已删除任务, 并归档 ${res.files} 个产物到:\n${res.archivedDir}`
          : '已删除任务(没有登记过的产物需要归档)。',
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };
  const state = useTask(taskId);
  const { theme, toggle: toggleTheme } = useTheme();
  const { status: runtimeStatus } = usePageLifecycle();

  const loadProfiles = useCallback(() => {
    void api
      .listProfiles()
      .then(setProfiles)
      .catch((e) => setToast(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (taskId) localStorage.setItem('hh.taskId', taskId);
    else localStorage.removeItem('hh.taskId');
  }, [taskId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const detail = state.detail;
  const pendingCount = detail?.approvalsPending.length ?? 0;

  const refresh = useCallback(() => {
    state.reload();
    reloadTasks();
  }, [state, reloadTasks]);

  const control = async (action: 'pause_dispatch' | 'resume' | 'cancel') => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.control(detail.task.id, action, undefined, `UI ${action}`);
      refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const phaseIndex = detail ? PHASES.indexOf(detail.task.phase) : -1;

  const tabs: { key: Tab; label: string; badge?: number }[] = useMemo(
    () => [
      { key: 'plan', label: '计划' },
      { key: 'chat', label: '对话' },
      { key: 'approvals', label: '审批', badge: pendingCount },
      { key: 'review', label: '审核' },
      { key: 'artifacts', label: '产物' },
      { key: 'events', label: '事件' },
    ],
    [pendingCount],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div className="brand-text">
            <div className="brand-name">Harness Hub</div>
            <div className="brand-sub">多 Harness 统一调度</div>
          </div>
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.4 14.6A8.6 8.6 0 1 1 9.4 3.6a6.9 6.9 0 0 0 11 11Z" />
              </svg>
            )}
          </button>
        </div>

        <div className="side-section">
          <span>任务</span>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            {terminalTasks.length > 0 ? (
              <button className="linkish" onClick={() => void removeFinished()} title="删除所有已结束的任务(产物归档)">
                清理已完成 {terminalTasks.length}
              </button>
            ) : null}
            <span>{tasks.length}</span>
          </span>
        </div>
        <div className="task-list">
          {tasks.length === 0 ? <div className="empty">还没有任务。<br />点击下方“新建任务”。</div> : null}
          {tasks.map((t) => (
            <div key={t.id} className={`task-row ${t.id === taskId ? 'active' : ''}`}>
              <button
                className="task-item"
                onClick={() => {
                  setTaskId(t.id);
                  setSelection(null);
                  setTab('plan');
                }}
              >
                <span className="task-item-title">{t.title}</span>
                <span className="task-item-meta">
                  <span className={`chip ${LIFECYCLE_TONE[t.lifecycle]}`}>{LIFECYCLE_LABEL[t.lifecycle]}</span>
                  <span>{PHASE_LABEL[t.phase]}</span>
                  <span className="mono">{clock(t.updatedAt)}</span>
                </span>
              </button>
              <button
                className="task-del"
                title="删除任务(保留产物)"
                aria-label={`删除任务 ${t.title}`}
                onClick={() => void removeTask(t)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <button className="btn primary" onClick={() => setShowNew(true)}>
            新建任务
          </button>
          <button className="btn" onClick={() => setShowProfiles(true)}>
            执行配置 ({profiles.filter((p) => p.enabled).length})
          </button>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className={`chip ${state.conn === 'live' ? 'green' : state.conn === 'reconnecting' ? 'amber' : 'muted'}`}>
              <span className="dot" />
              {state.conn === 'live' ? '事件流已连接' : state.conn === 'reconnecting' ? '重连中' : '连接中'}
            </span>
          </div>
          {runtimeStatus?.exitOnUiClose ? (
            <p className="foot-note" title="关闭或刷新页面时浏览器会先确认; 确认关闭后后台进程会在约 2.5s 内结束, 刷新则不会。">
              关闭页面将停止后台服务
            </p>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <header className="taskbar">
          <div className="taskbar-title">{detail?.task.title ?? '选择或新建一个任务'}</div>
          {detail ? (
            <>
              <span className={`chip ${LIFECYCLE_TONE[detail.task.lifecycle]}`}>
                <span className="dot" />
                {LIFECYCLE_LABEL[detail.task.lifecycle]}
              </span>
              <span className="chip violet">{PHASE_LABEL[detail.task.phase]}</span>
              <div className="phase-track" title={PHASE_LABEL[detail.task.phase]}>
                {PHASES.map((p, i) => (
                  <span key={p} className={`phase-step ${i < phaseIndex ? 'done' : i === phaseIndex ? 'now' : ''}`} title={PHASE_LABEL[p]} />
                ))}
              </div>
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                v{detail.task.version} · 参与者 r{detail.task.participantsRevision}
              </span>
              {detail.task.errorCode ? <span className="chip red" title={detail.task.errorMessage ?? ''}>{detail.task.errorCode}</span> : null}
            </>
          ) : null}
          <div className="taskbar-spacer" />
          {detail && !TERMINAL.includes(detail.task.lifecycle) ? (
            <>
              {detail.task.lifecycle === 'paused' || detail.task.errorCode === 'restart_recovered' ? (
                <button className="btn sm" disabled={busy} onClick={() => void control('resume')}>
                  恢复派发
                </button>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => void control('pause_dispatch')}>
                  暂停派发
                </button>
              )}
              <button className="btn sm danger" disabled={busy} onClick={() => void control('cancel')}>
                取消任务
              </button>
            </>
          ) : null}
        </header>

        <div className={`workspace ${detail && selection ? 'with-inspector' : ''}`}>
          <section className="canvas" data-canvas>
            {detail ? (
              <>
                <CollabGraph detail={detail} events={state.events} selection={selection} onSelect={pickSelection} />
              </>
            ) : (
              <div className="graph-empty" style={{ position: 'relative', flex: 1, display: 'grid', placeItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 15, marginBottom: 6 }}>统一工作台</div>
                  <div className="small muted" style={{ maxWidth: 380, lineHeight: 1.7 }}>
                    左侧选择任务, 或新建任务。协作图只反映真实事件: 会话连接、工具调用、审批、审核与交付。
                    <br />
                    计划生成后需要你明确选择“直接执行 / 补充内容 / 重新计划”。
                  </div>
                </div>
              </div>
            )}
            {state.error && !detail ? <div className="toast">{state.error}</div> : null}
          </section>

          {detail && selection ? (
            <aside className="inspector">
              <NodeDetail
                detail={detail}
                selection={selection}
                events={state.events}
                onClose={() => setSelection(null)}
                onChanged={refresh}
                onChat={(participantId) => {
                  setChatTarget(participantId);
                  setTab('chat');
                  setSelection(null);
                }}
              />
            </aside>
          ) : null}

          {detail && selection ? null : (
          <aside className="dock">
            <div className="dock-tabs">
              {tabs.map((t) => (
                <button key={t.key} className={`dock-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
                  {t.label}
                  {t.badge ? <span className="badge">{t.badge}</span> : null}
                </button>
              ))}
            </div>
            <div className="dock-body" style={tab === 'chat' ? { padding: 0, overflow: 'hidden' } : undefined}>
              {!detail ? (
                <div className="empty">尚未选择任务。</div>
              ) : tab === 'chat' ? (
                <Conversation
                  detail={detail}
                  deltas={state.deltas}
                  onChanged={refresh}
                  target={chatTarget}
                  onTargetChange={setChatTarget}
                  onOpenDetail={(participantId) => setSelection({ kind: 'participant', id: participantId })}
                />
              ) : tab === 'plan' ? (
                <PlanPanel detail={detail} onChanged={refresh} />
              ) : tab === 'approvals' ? (
                <ApprovalPanel detail={detail} onChanged={refresh} />
              ) : tab === 'review' ? (
                <ReviewPanel detail={detail} />
              ) : tab === 'artifacts' ? (
                <ArtifactPanel detail={detail} />
              ) : (
                <EventTimeline events={state.events} highWaterSeq={detail?.highWaterSeq} />
              )}
            </div>
          </aside>
          )}
        </div>
      </main>

      {showNew ? (
        <NewTaskDialog
          profiles={profiles}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            setTaskId(id);
            setTab('plan');
            refresh();
          }}
        />
      ) : null}
      {showProfiles ? (
        <ProfilesPanel profiles={profiles} onClose={() => setShowProfiles(false)} onChanged={loadProfiles} />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
      {detail?.task.lifecycle === 'blocked' ? (
        <div className="toast" style={{ borderLeftColor: 'var(--amber)' }}>
          <strong>任务受阻</strong>
          <div className="small muted" style={{ marginTop: 3 }}>
            {detail.task.errorCode}: {detail.task.errorMessage}
          </div>
        </div>
      ) : null}
      {detail ? (
        <div className="sr">
          任务 {shortId(detail.task.id)} 当前阶段 {detail.task.phase}
        </div>
      ) : null}
    </div>
  );
}
