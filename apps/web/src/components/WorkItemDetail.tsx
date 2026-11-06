import { useEffect } from 'react';
import type { TaskDetail } from '../api';
import type { PlanWorkItem } from '../../../../packages/contracts/src/types';
import { ITEM_LABEL, ITEM_TONE, RISK_LABEL, bytes, shortType, stamp } from '../lib/format';

const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  starting: '启动中',
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_user: '等待回答',
  retry_wait: '重试等待',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '未知',
};

const ATTEMPT_KIND_LABEL: Record<string, string> = {
  plan: '规划',
  discuss: '讨论',
  work: '执行',
  review: '审核',
  crosscheck: '交叉复核',
  integrate: '集成',
  deliver: '交付',
  verify: '验证',
};

const ARTIFACT_STATUS_LABEL: Record<string, string> = {
  registered: '已登记',
  superseded: '已被替代',
  invalid: '无效',
  missing: '文件缺失',
};

function labelOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/** 工作项详情: 把计划表里被挤压的「目标」原样展开, 并列出它的执行、产物与验证。 */
export function WorkItemDetail({
  detail,
  item,
  onClose,
}: {
  detail: TaskDetail;
  item: PlanWorkItem;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const live = detail.workItems.find((w) => w.planItemId === item.id) ?? null;
  const participantId = item.assignedParticipantId ?? live?.assignedParticipantId ?? null;
  const participant = detail.participants.find((p) => p.id === participantId) ?? null;
  const attempts = live ? detail.attempts.filter((a) => a.workItemId === live.id) : [];
  const artifacts = live ? detail.artifacts.filter((a) => a.workItemId === live.id) : [];
  const verifications = live ? detail.verifications.filter((v) => v.workItemId === live.id) : [];
  const result = live?.result ?? null;
  const state = live?.state ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(780px, 100%)', maxHeight: '82vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`工作项 ${item.id}`}
      >
        <div className="pf-head">
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h4 style={{ margin: 0 }}>工作项 {item.id}</h4>
            {state ? <span className={`state ${ITEM_TONE[state]}`}>{ITEM_LABEL[state]}</span> : <span className="state muted">未创建</span>}
            <span className="chip muted">{participant?.displayName ?? participantId ?? '未指派'}</span>
            <span className="chip muted">风险 {RISK_LABEL[item.riskLevel] ?? item.riskLevel}</span>
          </div>
          <button className="btn tiny" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="panel-title">目标</div>
        <p className="wi-goal">{item.goal}</p>
        {live && live.goal !== item.goal ? (
          <>
            <div className="panel-title">执行时使用的工作项描述</div>
            <p className="wi-goal">{live.goal}</p>
          </>
        ) : null}

        <dl className="kv">
          <dt>依赖</dt>
          <dd>{item.dependencies.length ? item.dependencies.join(' , ') : '—'}</dd>
          <dt>尝试</dt>
          <dd>
            {live ? `${live.attemptCount} 次 · 修复轮 ${live.repairRound}` : '未开始'}
            {attempts.length ? ` · 记录 ${attempts.length} 条` : ''}
          </dd>
          <dt>写入范围</dt>
          <dd>{item.writeScope.length ? item.writeScope.join(' , ') : '—'}</dd>
          <dt>最近更新</dt>
          <dd>{live ? stamp(live.updatedAt) : '—'}</dd>
        </dl>

        {item.inputs.length ? (
          <>
            <div className="panel-title">输入</div>
            <ul className="wi-list">
              {item.inputs.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </>
        ) : null}

        {item.expectedOutputs.length ? (
          <>
            <div className="panel-title">预期产物</div>
            <ul className="wi-list">
              {item.expectedOutputs.map((o, i) => (
                <li key={i}>
                  <span className="mono">{o.relativePath}</span>
                  <span className="muted">
                    {' '}
                    · {o.format}
                    {o.template ? ` · 模板 ${o.template}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {item.acceptanceCriteria.length ? (
          <>
            <div className="panel-title">验收标准</div>
            <ul className="wi-list">
              {item.acceptanceCriteria.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </>
        ) : null}

        {live?.userNote ? (
          <>
            <div className="panel-title">我对本项的补充</div>
            <p className="wi-goal">{live.userNote}</p>
          </>
        ) : null}

        {live?.lastError ? (
          <>
            <div className="panel-title">最近错误</div>
            <p className="wi-goal" style={{ color: 'var(--bad)' }}>
              {live.lastError}
            </p>
          </>
        ) : null}

        <div className="panel-title">执行记录 ({attempts.length})</div>
        {attempts.length === 0 ? (
          <p className="wi-empty">还没有执行记录。</p>
        ) : (
          attempts.map((a) => (
            <div className="attempt-row" key={a.id}>
              <span>{labelOf(ATTEMPT_KIND_LABEL, a.kind)}</span>
              <span className={`state ${a.status === 'completed' ? 'green' : a.status === 'failed' ? 'red' : a.status === 'running' ? 'cyan' : 'muted'}`}>
                {labelOf(ATTEMPT_STATUS_LABEL, a.status)}
              </span>
              <span className="muted">
                {stamp(a.startedAt)}
                {a.endedAt ? ` → ${stamp(a.endedAt)}` : ''}
                {a.errorMessage ? ` · ${a.errorMessage}` : ''}
              </span>
            </div>
          ))
        )}

        <div className="panel-title">产物 ({artifacts.length})</div>
        {artifacts.length === 0 ? (
          <p className="wi-empty">本项还没有登记产物。</p>
        ) : (
          artifacts.map((a) => (
            <div className="attempt-row" key={a.id}>
              <span className="mono">{shortType(a.mediaType)}</span>
              <span className={a.status === 'registered' ? 'state green' : 'state muted'}>{labelOf(ARTIFACT_STATUS_LABEL, a.status)}</span>
              <span className="mono">
                {a.relativePath} · {bytes(a.size)}
              </span>
            </div>
          ))
        )}

        <div className="panel-title">验证 ({verifications.length})</div>
        {verifications.length === 0 ? (
          <p className="wi-empty">本项还没有验证记录。</p>
        ) : (
          verifications.map((v) => (
            <div className="attempt-row" key={v.id}>
              <span className="mono">{v.checkId}</span>
              <span className={`state ${v.status === 'passed' ? 'green' : v.status === 'failed' ? 'red' : 'muted'}`}>
                {v.status === 'passed' ? '通过' : v.status === 'failed' ? '未通过' : v.status === 'skipped' ? '跳过' : '未知'}
              </span>
              <span className="muted">
                {v.detail}
                {v.exitCode !== null ? ` (exit ${v.exitCode})` : ''}
              </span>
            </div>
          ))
        )}

        {result ? (
          <>
            <div className="panel-title">执行结论</div>
            <p className="wi-goal">{result.summary}</p>
            {result.verificationClaims.length ? (
              <ul className="wi-list">
                {result.verificationClaims.map((c, i) => (
                  <li key={i}>
                    {c.check} — {c.status}
                    {c.evidenceRef ? ` (${c.evidenceRef})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.unresolvedIssues.length ? (
              <div style={{ marginTop: 6 }}>
                <div className="panel-title">未解决问题</div>
                <ul className="wi-list">
                  {result.unresolvedIssues.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
