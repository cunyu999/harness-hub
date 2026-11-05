import { useEffect, useMemo, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker';
import type { ProfileDto } from '../api';
import { api } from '../api';
import { stamp } from '../lib/format';

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export function NewTaskDialog({
  profiles,
  onClose,
  onCreated,
}: {
  profiles: ProfileDto[];
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const usable = profiles.filter((p) => p.enabled);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [constraints, setConstraints] = useState('');
  const [outputHint, setOutputHint] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  // 角色默认权限: planner 默认完全权限, worker 默认工作区内可写; 建好任务后仍可在对话栏逐个改
  const [plannerSandbox, setPlannerSandbox] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>(
    'danger-full-access',
  );
  const [workerSandbox, setWorkerSandbox] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>(
    'workspace-write',
  );
  const [strong, setStrong] = useState<string[]>([]);
  const [lead, setLead] = useState<string>('');
  const [workers, setWorkers] = useState<string[]>([]);
  // 逐席位覆盖: 留空 = 按角色默认(planner 完全权限 / worker 工作区内可写)
  const [seatDraft, setSeatDraft] = useState<Record<string, { ws: string; sandbox: '' | SandboxMode }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (strong.length === 0) {
      setLead('');
      return;
    }
    if (!strong.includes(lead)) setLead(strong[0]);
  }, [strong, lead]);

  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : list.concat(id));

  const slug = (name: string): string =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'seat';

  const seatList = useMemo(() => {
    const ids = [...strong, ...workers.filter((w) => !strong.includes(w))];
    return ids.map((id) => ({
      id,
      profile: profiles.find((p) => p.id === id),
      role: (strong.includes(id) ? 'strong' : 'worker') as 'strong' | 'worker',
      isLead: id === lead,
    }));
  }, [strong, workers, lead, profiles]);

  const canSubmit = title.trim().length > 0 && objective.trim().length > 0 && strong.length >= 1 && strong.includes(lead);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createTask({
        title: title.trim(),
        objective: objective.trim(),
        constraints: constraints
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        outputHint: outputHint.trim() || undefined,
        workspace: workspace.trim() || null,
        plannerSandbox,
        workerSandbox,
        strongProfileIds: strong,
        leadProfileId: lead,
        workerProfileIds: workers,
        seats: seatList
          .map((seat) => {
            const draft = seatDraft[seat.id];
            const ws = draft?.ws.trim() ?? '';
            const sandbox = draft?.sandbox ?? '';
            if (!ws && !sandbox) return null;
            return {
              profileId: seat.id,
              ...(ws ? { workspaceRoot: ws } : {}),
              ...(sandbox ? { sandbox } : {}),
            };
          })
          .filter((x): x is { profileId: string; workspaceRoot?: string; sandbox?: SandboxMode } => x !== null),
        idempotencyKey: `create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      onCreated(res.task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 100%)' }}>
        <h3>新建任务</h3>
        <div className="small muted">参与者由你选定; 程序不会自动加入其它模型, 也不会降低推理配置。</div>

        <div className="field">
          <label>任务标题</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如: 操作系统课程报告 / C++ 大作业" />
        </div>
        <div className="field">
          <label>目标与要求</label>
          <textarea
            rows={5}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="写清楚任务目标、课程或项目背景、必须满足的要求。格式与模板如已指定请一并写在这里。"
          />
        </div>
        <div className="field">
          <label>约束(每行一条, 可留空)</label>
          <textarea rows={3} value={constraints} onChange={(e) => setConstraints(e.target.value)} placeholder="例如: 不超过 6000 字" />
        </div>
        <div className="field">
          <label>输出提示(可留空)</label>
          <input type="text" value={outputHint} onChange={(e) => setOutputHint(e.target.value)} placeholder="例如: 交付 Word 文档 + 可编译的 C++ 源码" />
        </div>

        <div className="field">
          <label>工作目录(可留空)</label>
          <div className="field-pick">
            <input
              type="text"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="例如 D:/projects/my-app; 留空则每个任务用自己的目录"
            />
            <button className="btn tiny" type="button" onClick={() => setPickingWorkspace(true)}>
              选择…
            </button>
          </div>
          <div className="field-hint">
            这个目录就是任务的<strong>大工作区</strong>, 里面会生成三个中层目录:
            <code>planner/</code>(每个强模型一个子目录)、<code>worker/</code>(每个执行者一个子目录)、
            <code>deliverables/</code>(所有产物)。留空时用 .local/runs/&lt;taskId&gt;/workspace。
          </div>
        </div>

        <div className="field">
          <label>强模型(可多选, 至少一个; ≥2 个会先讨论再交叉审核)</label>
          <div className="row">
            {usable.length === 0 ? <span className="small muted">没有可用配置, 请先在“执行配置”里启用。</span> : null}
            {usable.map((p) => (
              <label key={p.id} className={`chk ${strong.includes(p.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={strong.includes(p.id)} onChange={() => setStrong((s) => toggle(s, p.id))} />
                <span>
                  {p.name}
                  <br />
                  <small>
                    {p.adapterId} · {p.requestedModel || '默认模型'} · {p.liveEnabled ? 'live' : '未标记 live'}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label>主控(负责规划与最终审核)</label>
          <select value={lead} onChange={(e) => setLead(e.target.value)}>
            {strong.map((id) => {
              const p = profiles.find((x) => x.id === id);
              return (
                <option key={id} value={id}>
                  {p?.name ?? id}
                </option>
              );
            })}
            {strong.length === 0 ? <option value="">先选择强模型</option> : null}
          </select>
        </div>

        <div className="field">
          <label>执行者(可多选, 可与强模型重合)</label>
          <div className="row">
            {usable.map((p) => (
              <label key={p.id} className={`chk ${workers.includes(p.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={workers.includes(p.id)} onChange={() => setWorkers((s) => toggle(s, p.id))} />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label>每个 harness 的工作区与权限(可留空 = 用角色默认)</label>
          <div className="field-hint">
            默认: 强模型(planner)完全权限、执行者(worker)工作区内可写。每个席位会在自己的角色大工作区里
            (planner/ 或 worker/)自动建一个属于自己的小工作区; 这里可以改成相对任务工作区的路径(例如
            planner/claude-a)或绝对路径。建好任务后也能在对话栏里逐个席改。
          </div>
          {seatList.length === 0 ? <div className="small muted">先选择参与者。</div> : null}
          {seatList.map((seat) => {
            const draft = seatDraft[seat.id] ?? { ws: '', sandbox: '' as const };
            return (
              <div key={seat.id} className="seat-row">
                <span className={`seat-tag ${seat.role}`}>
                  {seat.role === 'strong' ? '强模型' : '执行者'}
                  {seat.isLead ? ' · 主控' : ''}
                </span>
                <span className="seat-name">{seat.profile?.name ?? seat.id}</span>
                <select
                  value={draft.sandbox}
                  onChange={(e) =>
                    setSeatDraft((prev) => ({ ...prev, [seat.id]: { ...draft, sandbox: e.target.value as '' | SandboxMode } }))
                  }
                >
                  <option value="">权限跟随角色默认</option>
                  <option value="read-only">只读</option>
                  <option value="workspace-write">工作区内可写</option>
                  <option value="danger-full-access">完全权限</option>
                </select>
                <input
                  value={draft.ws}
                  placeholder={`例如 ${seat.role === 'strong' ? 'planner' : 'worker'}/${slug(seat.profile?.name ?? 'seat')}`}
                  onChange={(e) => setSeatDraft((prev) => ({ ...prev, [seat.id]: { ...draft, ws: e.target.value } }))}
                />
              </div>
            );
          })}
        </div>

        {err ? <div className="err">{err}</div> : null}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!canSubmit || busy} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建任务'}
          </button>
        </div>
      </div>
      {pickingWorkspace ? (
        <DirectoryPicker
          title="选择任务工作区"
          initial={workspace.trim() || null}
          onClose={() => setPickingWorkspace(false)}
          onPick={(abs) => {
            setWorkspace(abs);
            setPickingWorkspace(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function ProfilesPanel({
  profiles,
  onClose,
  onChanged,
}: {
  profiles: ProfileDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adapters, setAdapters] = useState<{ id: string; displayName: string; mock: boolean }[]>([]);
  const [selected, setSelected] = useState<string | null>(profiles[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => (profiles[0] ? toDraft(profiles[0]) : null));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'muted'; text: string } | null>(null);

  useEffect(() => {
    void api
      .capabilities()
      .then((list) => setAdapters(Array.isArray(list) ? list : []))
      .catch(() => setAdapters([]));
  }, []);

  // 选中项跟随外部刷新: 保留选中, 数据换了就同步到最新。
  useEffect(() => {
    if (!selected) return;
    const fresh = profiles.find((p) => p.id === selected);
    if (fresh) setDraft((prev) => (prev && prev.id === fresh.id ? toDraft(fresh) : prev));
  }, [profiles, selected]);

  const groups = useMemo(() => {
    const order = adapters.length > 0 ? adapters.map((a) => a.id) : Array.from(new Set(profiles.map((p) => p.adapterId)));
    const label = (id: string) => adapters.find((a) => a.id === id)?.displayName ?? id;
    return order.map((id) => ({
      id,
      label: label(id),
      items: profiles.filter((p) => p.adapterId === id),
    }));
  }, [adapters, profiles]);

  const current = profiles.find((p) => p.id === selected) ?? null;

  const pick = (p: ProfileDto) => {
    setSelected(p.id);
    setDraft(toDraft(p));
    setNotice(null);
  };

  const startNew = (adapterId: string) => {
    setSelected(null);
    setDraft({
      id: null,
      name: '',
      adapterId,
      executableRef: '',
      sourceHome: '',
      requestedModel: '',
      requestedReasoning: '',
      concurrencyGroup: 'default',
    workspaceRoot: '',
    sandbox: 'workspace-write',
      envText: '',
      notes: '',
      liveEnabled: false,
      enabled: true,
    });
    setNotice({ tone: 'muted', text: '填好名称与可执行入口后保存; 适配器一旦创建就不能改(避免会话漂移)。' });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setNotice({ tone: 'bad', text: '名称不能为空' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        executableRef: draft.executableRef.trim(),
        configRefs: draft.sourceHome.trim() ? { sourceHome: draft.sourceHome.trim() } : {},
        requestedModel: draft.requestedModel.trim() || null,
        requestedReasoning: draft.requestedReasoning.trim() || null,
        concurrencyGroup: draft.concurrencyGroup.trim() || 'default',
        workspaceRoot: draft.workspaceRoot.trim() || null,
        sandbox: draft.sandbox,
        env: parseEnv(draft.envText),
        notes: draft.notes.trim() || null,
        liveEnabled: draft.liveEnabled,
        enabled: draft.enabled,
      };
      if (draft.id) {
        await api.patchProfile(draft.id, body);
        setNotice({ tone: 'ok', text: '已保存' });
        onChanged();
      } else {
        const created = await api.createProfile({ ...body, adapterId: draft.adapterId });
        setSelected(created.id);
        setDraft(toDraft(created));
        setNotice({ tone: 'ok', text: '已创建; 建议先跑 inspect 探针' });
        onChanged();
      }
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const created = await api.createProfile({
        name: `${draft.name || '未命名'} 副本`,
        adapterId: draft.adapterId,
        executableRef: draft.executableRef.trim(),
        configRefs: draft.sourceHome.trim() ? { sourceHome: draft.sourceHome.trim() } : {},
        requestedModel: draft.requestedModel.trim() || null,
        requestedReasoning: draft.requestedReasoning.trim() || null,
        concurrencyGroup: draft.concurrencyGroup.trim() || 'default',
        workspaceRoot: draft.workspaceRoot.trim() || null,
        sandbox: draft.sandbox,
        env: parseEnv(draft.envText),
        notes: draft.notes.trim() || null,
        enabled: true,
        liveEnabled: false,
      });
      setSelected(created.id);
      setDraft(toDraft(created));
      setNotice({ tone: 'ok', text: '已复制为一份新配置(live 默认关闭)' });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (p: ProfileDto) => {
    setBusy(true);
    try {
      await api.patchProfile(p.id, { enabled: !p.enabled });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    const name = draft.name || draft.id;
    if (!window.confirm(`删除执行配置「${name}」?\n\n只影响这份配置本身; 已被任务引用过的配置只能停用, 不能删除。`)) return;
    setBusy(true);
    try {
      await api.deleteProfile(draft.id, true);
      setSelected(null);
      setDraft(null);
      setNotice({ tone: 'ok', text: '已删除' });
      onChanged();
    } catch (e) {
      const text = errorText(e);
      setNotice({
        tone: 'bad',
        text: text.includes('profile_in_use') ? '该配置被历史任务引用过, 只能停用(会保留在列表里并标灰)。' : text,
      });
    } finally {
      setBusy(false);
    }
  };

  const probe = async (mode: 'inspect' | 'live') => {
    if (!draft?.id || !current) return;
    setBusy(true);
    setNotice({ tone: 'muted', text: `${mode} 探针运行中…` });
    try {
      const res = await api.probeProfile(current.id, mode);
      const ok = res.result.ok;
      setNotice({
        tone: ok ? 'ok' : 'bad',
        text: `${mode} · ${ok ? '通过' : '未通过'} · ${res.result.version ?? '未取到版本'}${res.result.detail ? ' · ' + res.result.detail : ''}`,
      });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const lastProbe = current?.lastProbe ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pf-head">
          <div>
            <h3>执行配置</h3>
            <div className="small muted">
              每个配置 = 一个 harness 的一种用法(模型、推理、账号 home)。inspect 只握手; live 会真跑一次短回合。
            </div>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="pf-body">
          <div className="pf-list">
            {groups.map((g) => (
              <div key={g.id} className="pf-group">
                <div className="pf-group-head">
                  <span className="mono">{g.label}</span>
                  <button className="btn ghost sm" title={`新建 ${g.label} 配置`} onClick={() => startNew(g.id)}>
                    +
                  </button>
                </div>
                {g.items.length === 0 ? <div className="pf-empty">还没有配置</div> : null}
                {g.items.map((p) => (
                  <button
                    key={p.id}
                    className={`pf-item ${selected === p.id ? 'on' : ''} ${p.enabled ? '' : 'off'}`}
                    onClick={() => pick(p)}
                  >
                    <span className="pf-item-name">{p.name}</span>
                    <span className="pf-item-sub">
                      {p.requestedModel || '默认模型'} · {p.liveEnabled ? 'live' : '未启用 live'} · 任务 {p.usage ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 ? <div className="pf-empty">还没有注册适配器</div> : null}
          </div>

          <div className="pf-detail">
            {!draft ? (
              <div className="empty-state">
                从左侧选择一份配置, 或点分组标题旁的 <strong>+</strong> 新建。
              </div>
            ) : (
              <>
                <div className="pf-form">
                  <div className="field">
                    <label>名称</label>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="例如: Claude · 主控 / Codex · 审查"
                    />
                  </div>
                  <div className="field">
                    <label>适配器{draft.id ? '(创建后不可改)' : ''}</label>
                    <select
                      value={draft.adapterId}
                      disabled={!!draft.id}
                      onChange={(e) => setDraft({ ...draft, adapterId: e.target.value })}
                    >
                      {(adapters.length > 0 ? adapters.map((a) => a.id) : [draft.adapterId]).map((id) => (
                        <option key={id} value={id}>
                          {adapters.find((a) => a.id === id)?.displayName ?? id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field pf-span">
                    <label>可执行入口(项目内绝对路径; mock 可留空)</label>
                    <input
                      className="mono"
                      type="text"
                      value={draft.executableRef}
                      onChange={(e) => setDraft({ ...draft, executableRef: e.target.value })}
                      placeholder={execHint(draft.adapterId)}
                    />
                  </div>
                  <div className="field pf-span">
                    <label>凭据来源目录(首次使用时只复制到项目内私有 home, 不移动)</label>
                    <input
                      className="mono"
                      type="text"
                      value={draft.sourceHome}
                      onChange={(e) => setDraft({ ...draft, sourceHome: e.target.value })}
                      placeholder={homeHint(draft.adapterId)}
                    />
                  </div>
                  <div className="field">
                    <label>模型(留空 = 用 harness 自己的配置)</label>
                    <input
                      type="text"
                      value={draft.requestedModel}
                      onChange={(e) => setDraft({ ...draft, requestedModel: e.target.value })}
                      placeholder={modelHint(draft.adapterId)}
                    />
                    <div className="field-hint">
                      只对本程序发起的会话生效(会话级覆盖), 不改 harness 的配置文件; 填错会导致启动失败。
                    </div>
                  </div>
                  <div className="field">
                    <label>推理强度(留空 = 默认)</label>
                    <input
                      type="text"
                      value={draft.requestedReasoning}
                      onChange={(e) => setDraft({ ...draft, requestedReasoning: e.target.value })}
                      placeholder="low / medium / high"
                    />
                    <div className="field-hint">{reasoningHint(draft.adapterId)}</div>
                  </div>
                  <div className="field pf-span">
                    <label>工作目录(留空 = 任务自己的工作区)</label>
                    <input
                      type="text"
                      value={draft.workspaceRoot}
                      onChange={(e) => setDraft({ ...draft, workspaceRoot: e.target.value })}
                      placeholder="例如 D:\projects\my-app 或 .local\scratch\demo"
                    />
                    <div className="field-hint">
                      这里填的目录会成为该 harness 的 cwd 与写入根; 留空则每个任务用独立的 .local/runs/&lt;taskId&gt;/workspace。
                    </div>
                  </div>
                  <div className="field">
                    <label>会话权限</label>
                    <select
                      value={draft.sandbox}
                      onChange={(e) => setDraft({ ...draft, sandbox: e.target.value as Draft['sandbox'] })}
                    >
                      <option value="read-only">只读(不允许改文件)</option>
                      <option value="workspace-write">工作区内可写(推荐)</option>
                      <option value="danger-full-access">完全权限(不限制路径)</option>
                    </select>
                    <div className="field-hint">按 harness 原生能力生效: Codex 用沙箱, Claude 用 permissionMode, DSH 只能靠提示词与事后审计。</div>
                  </div>
                  <div className="field">
                    <label>并发组(同组内串行)</label>
                    <input
                      type="text"
                      value={draft.concurrencyGroup}
                      onChange={(e) => setDraft({ ...draft, concurrencyGroup: e.target.value })}
                      placeholder="default"
                    />
                  </div>
                  <div className="field">
                    <label>状态</label>
                    <div className="row">
                      <label className={`chk ${draft.enabled ? 'on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                        />
                        <span>可被选入任务</span>
                      </label>
                      <label className={`chk ${draft.liveEnabled ? 'on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={draft.liveEnabled}
                          onChange={(e) => setDraft({ ...draft, liveEnabled: e.target.checked })}
                        />
                        <span>允许真实调用</span>
                      </label>
                    </div>
                  </div>
                  <div className="field pf-span">
                    <label>环境变量(KEY=VALUE, 每行一条)</label>
                    <textarea
                      className="mono"
                      rows={3}
                      value={draft.envText}
                      onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                      placeholder="HTTPS_PROXY=http://127.0.0.1:7897"
                    />
                  </div>
                  <div className="field pf-span">
                    <label>备注</label>
                    <textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </div>
                </div>

                {notice ? <div className={`pf-notice ${notice.tone}`}>{notice.text}</div> : null}

                <div className="pf-actions">
                  <button className="btn primary" disabled={busy} onClick={() => void save()}>
                    {draft.id ? '保存' : '创建'}
                  </button>
                  <button className="btn" disabled={busy || !draft.id} onClick={() => void probe('inspect')}>
                    inspect 探针
                  </button>
                  <button className="btn" disabled={busy || !draft.id} onClick={() => void probe('live')}>
                    live 探针
                  </button>
                  <button className="btn ghost" disabled={busy || !draft.id} onClick={() => void duplicate()}>
                    复制一份
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy || !current}
                    onClick={() => current && void toggleEnabled(current)}
                  >
                    {current?.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn danger" disabled={busy || !draft.id} onClick={() => void remove()}>
                    删除
                  </button>
                </div>

                {lastProbe ? (
                  <div className="pf-probe">
                    <span className={`chip ${lastProbe.ok ? 'green' : 'red'}`}>{lastProbe.mode} · {lastProbe.ok ? '通过' : '未通过'}</span>
                    <span className="mono small muted">
                      {lastProbe.version ?? '版本未知'} · {stamp(lastProbe.checkedAt)}
                    </span>
                    <div className="small muted">{lastProbe.detail}</div>
                    {lastProbe.warnings?.length ? (
                      <ul className="small muted pf-warn">
                        {lastProbe.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <div className="small muted">还没有探针记录。真实调用前请先跑 inspect, 再跑 live。</div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface Draft {
  id: string | null;
  name: string;
  adapterId: string;
  executableRef: string;
  sourceHome: string;
  requestedModel: string;
  requestedReasoning: string;
  concurrencyGroup: string;
  workspaceRoot: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  envText: string;
  notes: string;
  liveEnabled: boolean;
  enabled: boolean;
}

function toDraft(p: ProfileDto): Draft {
  return {
    id: p.id,
    name: p.name,
    adapterId: p.adapterId,
    executableRef: p.executableRef,
    sourceHome: p.configRefs?.sourceHome ?? '',
    requestedModel: p.requestedModel ?? '',
    requestedReasoning: p.requestedReasoning ?? '',
    concurrencyGroup: p.concurrencyGroup,
    workspaceRoot: p.workspaceRoot ?? '',
    sandbox: (p.sandbox ?? 'workspace-write') as Draft['sandbox'],
    envText: Object.entries(p.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    notes: p.notes ?? '',
    liveEnabled: p.liveEnabled,
    enabled: p.enabled,
  };
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function execHint(adapterId: string): string {
  switch (adapterId) {
    case 'codex':
      return 'codex 或 C:/Users/你/AppData/Roaming/npm/codex.cmd(留空 = 自动探测)';
    case 'claude-code':
      return 'claude 或 .../claude-code/bin/claude.exe(留空 = 自动探测)';
    case 'dsh':
      return 'dsh 或 .../node_modules/@deepseek-ai/dsh/lib/bin.js(留空 = 自动探测)';
    default:
      return 'mock 适配器不需要可执行入口';
  }
}

function homeHint(adapterId: string): string {
  switch (adapterId) {
    case 'codex':
      return '%USERPROFILE%/.codex';
    case 'claude-code':
      return '%USERPROFILE%/.claude';
    case 'dsh':
      return '%USERPROFILE%/.dsh';
    default:
      return '不需要';
  }
}

/** 模型字段只做会话级覆盖, 留空就用 harness 自己配置里的模型。 */
function modelHint(adapterId: string): string {
  switch (adapterId) {
    case 'codex':
      return '留空 = 用 config.toml 里的模型, 例如 gpt-6.1-sol';
    case 'claude-code':
      return '留空 = 用 cc-switch / settings.json 里的模型';
    case 'dsh':
      return '留空 = 用 cordis.yml 里的模型, 例如 deepseek-v4-flash';
    default:
      return 'mock 适配器回显该值';
  }
}

/** 各 harness 对"推理强度"的支持程度不同, 这里如实说明, 避免用户以为一定生效。 */
function reasoningHint(adapterId: string): string {
  switch (adapterId) {
    case 'codex':
      return '传给 thread/start 的 effort; 取值以 Codex 支持为准(本程序未做 live 验证)。';
    case 'claude-code':
      return '传给 SDK 的 effort 选项; 实测填非法值不报错, 可能被 harness 忽略, 需要精确控制请用模型别名。';
    case 'dsh':
      return '通过 session/set_config_option(reasoning_effort) 下发; 非法值会直接报错, 说明该值确实生效。';
    default:
      return 'mock 适配器只回显, 不影响行为。';
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
