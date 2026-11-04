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
  const [showNew, setShowNew] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { tasks, reload: reloadTasks } = useTaskList();
  const state = useTask(taskId);
  const { theme, toggle: toggleTheme } = useTheme();

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
          <span>{tasks.length}</span>
        </div>
        <div className="task-list">
          {tasks.length === 0 ? <div className="empty">还没有任务。<br />点击下方“新建任务”。</div> : null}
          {tasks.map((t) => (
            <button
              key={t.id}
              className={`task-item ${t.id === taskId ? 'active' : ''}`}
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
            <span className="mono" style={{ fontSize: 10 }}>
              hl {detail?.highWaterSeq ?? 0}
            </span>
          </div>
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

        <div className="workspace">
          <section className="canvas">
            {detail ? (
              <>
                <CollabGraph detail={detail} selection={selection} onSelect={setSelection} />
                {selection ? (
                  <NodeDetail
                    detail={detail}
                    selection={selection}
                    events={state.events}
                    onClose={() => setSelection(null)}
                    onChanged={refresh}
                  />
                ) : null}
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
                <Conversation detail={detail} deltas={state.deltas} onChanged={refresh} />
              ) : tab === 'plan' ? (
                <PlanPanel detail={detail} onChanged={refresh} />
              ) : tab === 'approvals' ? (
                <ApprovalPanel detail={detail} onChanged={refresh} />
              ) : tab === 'review' ? (
                <ReviewPanel detail={detail} />
              ) : tab === 'artifacts' ? (
                <ArtifactPanel detail={detail} />
              ) : (
                <EventTimeline events={state.events} />
              )}
            </div>
          </aside>
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
      {showProfiles ? <ProfilesPanel profiles={profiles} onChanged={() => { setShowProfiles(false); loadProfiles(); }} /> : null}

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
