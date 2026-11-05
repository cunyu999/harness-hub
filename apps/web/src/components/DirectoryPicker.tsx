import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 目录选择器: 只读浏览本机目录, 用来替代"手输路径"。
 * 只列目录(不列文件), 支持返回上级、盘符/主目录快捷入口。
 */
export function DirectoryPicker({
  title = '选择工作区',
  initial,
  onPick,
  onClose,
}: {
  title?: string;
  initial?: string | null;
  onPick: (absolutePath: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<{
    path: string | null;
    parent: string | null;
    entries: { name: string; path: string; isDir: boolean }[];
    roots: { label: string; path: string }[];
    error?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (p?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.fsList(p ?? null);
      setListing(next);
      if (next.error) setError(next.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void go(initial ?? null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 80, position: 'fixed', inset: 0 }}>
      <div className="modal dp" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 100%)' }}>
        <div className="dp-head">
          <h3>{title}</h3>
          <button className="btn tiny" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="dp-path">
          <button className="btn tiny" disabled={!listing?.parent || loading} onClick={() => void go(listing?.parent ?? null)}>
            ↑ 上级
          </button>
          <code className="dp-current" title={listing?.path ?? ''}>
            {listing?.path ?? '选择起点'}
          </code>
          <button className="btn tiny" disabled={loading} onClick={() => void go(listing?.path ?? null)}>
            刷新
          </button>
        </div>

        {error ? <div className="pf-notice bad">{error}</div> : null}

        <div className="dp-body">
          {listing?.path === null ? (
            <div className="dp-roots">
              {listing.roots.map((r) => (
                <button key={r.path} className="dp-entry" onClick={() => void go(r.path)}>
                  <span className="dp-icon">▸</span>
                  <span className="dp-name">{r.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="dp-list">
              {loading ? <div className="small muted">读取中…</div> : null}
              {!loading && (listing?.entries.length ?? 0) === 0 ? <div className="small muted">这个目录下没有子目录</div> : null}
              {listing?.entries.map((e) => (
                <button key={e.path} className="dp-entry" onClick={() => void go(e.path)} title={e.path}>
                  <span className="dp-icon">▸</span>
                  <span className="dp-name">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="dp-foot">
          <div className="small muted">只列目录; 选择后会把绝对路径填进工作区输入框。</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn tiny" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}>
              选定这个目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
