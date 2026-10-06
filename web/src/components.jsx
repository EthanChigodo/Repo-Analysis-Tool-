import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from './api.js';

export const fmt = {
  num(n) {
    if (n === null || n === undefined) return '-';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n * 100) / 100);
  },
  pct(x) {
    return `${(x * 100).toFixed(1)}%`;
  },
  date(sec) {
    if (!sec) return '-';
    return new Date(sec * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  },
};

// ------------------------------------------------------------------ toasts
export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.message}</span>
          <button className="toast-x" aria-label="dismiss">×</button>
        </div>
      ))}
    </div>
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  function push(message, kind = 'error') {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, message, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }
  const dismiss = (id) => setToasts((ts) => ts.filter((t) => t.id !== id));
  return { toasts, push, dismiss };
}

// ------------------------------------------------------------------ modal
export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ spinner
export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon = '📭', title, hint }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ add repo
export function AddRepoModal({ onClose, onAdded, toast }) {
  const [tab, setTab] = useState('clone');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      let repo;
      if (tab === 'clone') {
        if (!url.trim()) throw new Error('Enter a git repository URL');
        repo = await api.cloneRepo(url.trim(), name.trim() || undefined);
      } else {
        if (!file) throw new Error('Choose a .zip file of the repository (including .git)');
        repo = await api.uploadRepo(file, name.trim() || undefined);
      }
      onAdded(repo);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Repository" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button className={`tab ${tab === 'clone' ? 'active' : ''}`} onClick={() => setTab('clone')}>
          Clone URL
        </button>
        <button className={`tab ${tab === 'zip' ? 'active' : ''}`} onClick={() => setTab('zip')}>
          Upload Zip
        </button>
      </div>
      {tab === 'clone' ? (
        <>
          <label className="field">
            <span>Remote repository URL</span>
            <input
              autoFocus
              placeholder="https://github.com/redis/redis.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <p className="hint">The repository is deeply cloned (full history). Large repos take a while.</p>
        </>
      ) : (
        <>
          <label className="field">
            <span>Repository zip (must contain the .git directory)</span>
            <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files[0])} />
          </label>
          <p className="hint">Zip the repository folder with its .git directory included.</p>
        </>
      )}
      <label className="field">
        <span>Display name (optional)</span>
        <input placeholder="auto" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Starting…' : 'Add Repository'}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ commit picker
export function CommitPickerModal({ repoId, initialSelected, onClose, onSave, toast }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialSelected));
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE = 100;

  const load = async (reset) => {
    setLoading(true);
    try {
      const params = { limit: PAGE, offset: reset ? 0 : offset };
      if (q) params.q = q;
      const res = await api.listCommits(repoId, params);
      setTotal(res.total);
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      if (reset) setOffset(0);
      else setOffset((o) => o + PAGE);
    } catch (err) {
      toast(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => load(true), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function toggle(hash) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  return (
    <Modal title={`Select commits (${selected.size} selected)`} onClose={onClose} wide>
      <input
        className="search-input"
        placeholder="Search by message or hash prefix…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="commit-list">
        {items.map((c) => (
          <label key={c.hash} className="commit-row">
            <input type="checkbox" checked={selected.has(c.hash)} onChange={() => toggle(c.hash)} />
            <span className="commit-hash">{c.hash.slice(0, 8)}</span>
            <span className="commit-subject" title={c.subject}>{c.subject || '(no message)'}</span>
            <span className="commit-meta">
              {c.author_name} · {fmt.date(c.date)}
            </span>
          </label>
        ))}
        {!loading && items.length === 0 && <EmptyState title="No commits match" />}
      </div>
      <div className="modal-actions space-between">
        <span className="hint">
          Showing {items.length} of {total}
        </span>
        <div>
          <button className="btn" onClick={onClose}>Cancel</button>{' '}
          {items.length < total && (
            <button className="btn" onClick={() => load(false)} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}{' '}
          <button className="btn btn-primary" onClick={() => onSave([...selected])}>
            Apply selection
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ author merge
export function AuthorMergeModal({ repoId, authors, onChanged, onClose, toast }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  function toggle(key) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function merge() {
    if (selected.size < 2) {
      toast('Select at least two authors to merge', 'error');
      return;
    }
    setBusy(true);
    try {
      const updated = await api.mergeAuthors(repoId, [...selected]);
      onChanged(updated);
      setSelected(new Set());
      toast('Authors merged', 'ok');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function unmerge(email) {
    setBusy(true);
    try {
      const updated = await api.unmergeAuthors(repoId, email);
      onChanged(updated);
      toast('Author unmerged', 'ok');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Merge authors" onClose={onClose} wide>
      <p className="hint">
        The repository .mailmap is applied automatically. Manually merge identities the mailmap
        does not cover: select two or more authors and merge them. Merged groups can be split
        again with ✕.
      </p>
      <div className="author-list">
        {authors.map((a) => (
          <div key={a.key} className="author-row">
            <label className="author-main">
              <input type="checkbox" checked={selected.has(a.key)} onChange={() => toggle(a.key)} />
              <span className="author-name">{a.name}</span>
              <span className="author-key">{a.key}</span>
            </label>
            <span className="author-commits">{a.commits} commits</span>
            {a.mergedFrom.map((m) => (
              <span key={m} className="merge-chip" title={`${m} is merged into ${a.key}`}>
                ⇐ {m}
                <button className="chip-x" disabled={busy} onClick={() => unmerge(m)}>✕</button>
              </span>
            ))}
            {a.mergedFrom.length > 0 && (
              <button className="btn btn-small" disabled={busy} onClick={() => unmerge(a.key)}>
                ungroup
              </button>
            )}
          </div>
        ))}
        {authors.length === 0 && <EmptyState title="No authors yet" />}
      </div>
      <div className="modal-actions space-between">
        <span className="hint">{selected.size} selected</span>
        <div>
          <button className="btn" onClick={onClose}>Close</button>{' '}
          <button className="btn btn-primary" onClick={merge} disabled={busy || selected.size < 2}>
            Merge selected
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ charts
const AXIS = { stroke: '#8b93a7', fontSize: 11 };

export function ActivityChart({ data, bucketSec }) {
  const rows = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        label: new Date(d.t * 1000).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: bucketSec >= 7 * 86400 ? 'numeric' : undefined,
        }),
      })),
    [data, bucketSec]
  );
  if (!rows.length) return <EmptyState icon="📈" title="No activity in this commit set" />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={rows} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3040" vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: '#2a3040' }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{ background: '#161b26', border: '1px solid #2a3040', borderRadius: 8 }}
          labelStyle={{ color: '#c8cede' }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="added" name="Added lines" fill="#3fb27f" radius={[3, 3, 0, 0]} />
        <Bar dataKey="removed" name="Removed lines" fill="#e0616e" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const AUTHOR_COLORS = ['#5b8def', '#3fb27f', '#e0a83f', '#b06fe0', '#e0616e', '#4ec3d9', '#8f9f5b', '#d97fb0'];

export function AuthorChart({ authors }) {
  const rows = authors.slice(0, 8);
  if (!rows.length) return <EmptyState icon="👥" title="No author churn in this commit set" />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(rows.length * 38 + 40, 120)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 40, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3040" horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tick={{ ...AXIS, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(v, _n, item) => [`${fmt.num(v)} (${fmt.pct(item.payload.ownership)} ownership)`, 'churn']}
          contentStyle={{ background: '#161b26', border: '1px solid #2a3040', borderRadius: 8 }}
        />
        <Bar dataKey="churn" name="Churn" radius={[0, 3, 3, 0]}>
          {rows.map((a, i) => (
            <Cell key={a.key} fill={AUTHOR_COLORS[i % AUTHOR_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopObjectsChart({ items, title }) {
  const rows = items.slice(0, 10);
  if (!rows.length) return <EmptyState icon="🗂" title={`No ${title} in this commit set`} />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(rows.length * 30 + 40, 120)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 60, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3040" horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={150}
          tick={{ ...AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{ background: '#161b26', border: '1px solid #2a3040', borderRadius: 8 }}
        />
        <Bar dataKey="churn" name="Churn" fill="#5b8def" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ------------------------------------------------------------------ tables
export function ObjectTable({ kind, data, sort, dir, onSort, onOpen, page, onPage, limit }) {
  const cols = [
    { key: 'name', label: kind === 'dirs' ? 'Directory' : 'File' },
    { key: 'added', label: 'Added' },
    { key: 'removed', label: 'Removed' },
    { key: 'growth', label: 'Growth' },
    { key: 'churn', label: 'Churn' },
    { key: 'modifications', label: 'Mods' },
    { key: 'modificationFrequency', label: 'Mod freq' },
    { key: 'churnRate', label: 'Churn rate' },
  ];
  const items = data.items || [];
  const maxChurn = Math.max(...items.map((i) => i.churn), 1);
  const from = data.total === 0 ? 0 : page * limit + 1;
  const to = Math.min((page + 1) * limit, data.total);
  return (
    <div>
      <table className="data-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={c.key === 'name' ? 'col-name' : 'col-num'}
                onClick={() => onSort(c.key)}
                title="Click to sort"
              >
                {c.label}
                {sort.key === c.key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr
              key={`${row.name}-${row.isDir}`}
              className={row.isDir && onOpen ? 'row-clickable' : ''}
              onClick={() => row.isDir && onOpen && onOpen(row.name)}
            >
              <td className="col-name">
                <span className={row.isDir ? 'obj-dir' : 'obj-file'}>
                  {row.isDir ? '📁' : '📄'} {row.name}
                </span>
                <span className="churn-bar" style={{ width: `${(row.churn / maxChurn) * 100}%` }} />
              </td>
              <td className="col-num added">{fmt.num(row.added)}</td>
              <td className="col-num removed">{fmt.num(row.removed)}</td>
              <td className={`col-num ${row.growth >= 0 ? 'added' : 'removed'}`}>{fmt.num(row.growth)}</td>
              <td className="col-num">{fmt.num(row.churn)}</td>
              <td className="col-num">{fmt.num(row.modifications)}</td>
              <td className="col-num">{fmt.pct(row.modificationFrequency)}</td>
              <td className="col-num">{fmt.num(row.churnRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <EmptyState title={`No ${kind} in this scope`} />}
      {data.total > limit && (
        <div className="pager">
          <span>
            Showing {from}–{to} of {data.total}
          </span>
          <button className="btn btn-small" disabled={page === 0} onClick={() => onPage(page - 1)}>
            ← Prev
          </button>
          <button
            className="btn btn-small"
            disabled={to >= data.total}
            onClick={() => onPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

export function AuthorTable({ authors }) {
  if (!authors.length) return <EmptyState title="No author activity in this commit set" />;
  const maxChurn = Math.max(...authors.map((a) => a.churn), 1);
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="col-name">Author</th>
          <th className="col-num">Commits</th>
          <th className="col-num">Churn</th>
          <th className="col-num">Modifications</th>
          <th className="col-name">Ownership</th>
        </tr>
      </thead>
      <tbody>
        {authors.map((a) => (
          <tr key={a.key}>
            <td className="col-name">
              <span className="author-name">{a.name}</span>
              <span className="author-key"> {a.key}</span>
            </td>
            <td className="col-num">{fmt.num(a.commits)}</td>
            <td className="col-num">
              <span className="inline-bar-wrap">
                <span className="inline-bar" style={{ width: `${(a.churn / maxChurn) * 100}%` }} />
                {fmt.num(a.churn)}
              </span>
            </td>
            <td className="col-num">{fmt.num(a.modifications)}</td>
            <td className="col-name">
              <span className="inline-bar-wrap">
                <span className="inline-bar ownership" style={{ width: `${a.ownership * 100}%` }} />
                {fmt.pct(a.ownership)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
