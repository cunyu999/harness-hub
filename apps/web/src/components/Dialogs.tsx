import { useEffect, useMemo, useState } from 'react';
import type { ProfileDto } from '../api';
import { api } from '../api';

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
  const [strong, setStrong] = useState<string[]>([]);
  const [lead, setLead] = useState<string>('');
  const [workers, setWorkers] = useState<string[]>([]);
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
        strongProfileIds: strong,
        leadProfileId: lead,
        workerProfileIds: workers,
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
    </div>
  );
}

export function ProfilesPanel({ profiles, onChanged }: { profiles: ProfileDto[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  const probe = async (id: string, mode: 'inspect' | 'live') => {
    setBusy(`${id}:${mode}`);
    try {
      const res = await api.probeProfile(id, mode);
      const ok = res.result.ok;
      setMsg((prev) => ({
        ...prev,
        [id]: `${mode} · ${ok ? '通过' : '未通过'} · ${res.result.version ?? '未取到版本'}${res.result.detail ? ' · ' + res.result.detail : ''}`,
      }));
      onChanged();
    } catch (e) {
      setMsg((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const toggleLive = async (p: ProfileDto) => {
    setBusy(`${p.id}:live-toggle`);
    try {
      await api.patchProfile(p.id, { liveEnabled: !p.liveEnabled });
      onChanged();
    } catch (e) {
      setMsg((prev) => ({ ...prev, [p.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => profiles, [profiles]);

  return (
    <div className="modal-backdrop" onClick={() => onChanged()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(820px, 100%)' }}>
        <h3>执行配置</h3>
        <div className="small muted">
          inspect 只检查可执行文件与握手; live 会真实建立一次会话或调用。探针结论保存在配置记录里, 不改动快照。
        </div>
        <div style={{ marginTop: 12 }}>
          {rows.map((p) => (
            <div className="card" key={p.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{p.name}</strong>
                <span className="row">
                  <span className={`chip ${p.liveEnabled ? 'green' : 'muted'}`}>{p.liveEnabled ? 'live 已启用' : 'live 未启用'}</span>
                  <span className={`chip ${p.enabled ? 'cyan' : 'muted'}`}>{p.enabled ? '启用' : '停用'}</span>
                </span>
              </div>
              <div className="mono muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                {p.adapterId} · {p.requestedModel || '默认模型'} · {p.requestedReasoning || '默认推理'} · {p.executableRef || '(无入口)'}
              </div>
              <div className="row" style={{ marginTop: 7 }}>
                <button className="btn sm" disabled={busy !== null} onClick={() => void probe(p.id, 'inspect')}>
                  inspect 探针
                </button>
                <button className="btn sm" disabled={busy !== null} onClick={() => void probe(p.id, 'live')}>
                  live 探针
                </button>
                <button className="btn sm" disabled={busy !== null} onClick={() => void toggleLive(p)}>
                  {p.liveEnabled ? '取消 live' : '设为 live'}
                </button>
              </div>
              {msg[p.id] ? <div className="small muted" style={{ marginTop: 6 }}>{msg[p.id]}</div> : null}
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onChanged}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
