import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import {
  ActivityChart,
  AddRepoModal,
  AuthorChart,
  AuthorMergeModal,
  AuthorTable,
  CommitPickerModal,
  EmptyState,
  Modal,
  ObjectTable,
  Spinner,
  Toasts,
  TopObjectsChart,
  fmt,
  useToasts,
} from './components.jsx';

const ACTIVE = ['queued', 'cloning', 'extracting', 'parsing', 'indexing'];
const PAGE_SIZE = 50;

function dateToSec(dateStr, endOfDay) {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000) + (endOfDay ? 86400 : 0);
}

export default function App() {
  const { toasts, push, dismiss } = useToasts();

  // repositories ----------------------------------------------------------
  const [repos, setRepos] = useState([]);
  const [repoId, setRepoId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [authors, setAuthors] = useState([]);

  // filters ---------------------------------------------------------------
  const [authorSel, setAuthorSel] = useState(() => new Set());
  const [authorQuery, setAuthorQuery] = useState('');
  const [path, setPath] = useState('');
  const [commitMode, setCommitMode] = useState('all'); // all | range | commits
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [hashes, setHashes] = useState(() => new Set());
  const [pathInput, setPathInput] = useState('');
  const [pathSuggestions, setPathSuggestions] = useState([]);

  // dashboard -------------------------------------------------------------
  const [tab, setTab] = useState('overview');
  const [sort, setSort] = useState({ key: 'churn', dir: 'desc' });
  const [filesPage, setFilesPage] = useState(0);
  const [dirsPage, setDirsPage] = useState(0);
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(false);

  const repo = repos.find((r) => r.id === repoId) || null;
  const repoReady = repo && repo.status === 'ready';

  // ---- repository list + polling while anything is ingesting ------------
  const anyActive = repos.some((r) => ACTIVE.includes(r.status));
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const list = await api.listRepos();
        if (!alive) return;
        setRepos(list);
      } catch {
        /* transient */
      }
    }
    poll();
    const iv = setInterval(poll, anyActive ? 1200 : 8000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [anyActive]);

  // auto-select first repo
  useEffect(() => {
    if (!repoId && repos.length > 0) setRepoId(repos[0].id);
  }, [repos, repoId]);

  // ---- authors for the selected repo ------------------------------------
  const reloadAuthors = useCallback(async () => {
    if (!repoId || !repoReady) return;
    try {
      setAuthors(await api.listAuthors(repoId));
    } catch (err) {
      push(err.message);
    }
  }, [repoId, repoReady, push]);

  useEffect(() => {
    setAuthors([]);
    setAuthorSel(new Set());
    setPath('');
    setPathInput('');
    setHashes(new Set());
    setCommitMode('all');
    setFromDate('');
    setToDate('');
    setTab('overview');
    reloadAuthors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  useEffect(() => {
    if (repoReady) reloadAuthors();
  }, [repoReady, reloadAuthors]);

  // ---- path autocomplete -------------------------------------------------
  useEffect(() => {
    if (!repoId || !repoReady) return;
    const t = setTimeout(async () => {
      try {
        setPathSuggestions(await api.suggestPaths(repoId, pathInput.trim()));
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [pathInput, repoId, repoReady]);

  // ---- metrics query -----------------------------------------------------
  const metricsParams = useMemo(() => {
    const p = {};
    if (path) p.path = path;
    if (authorSel.size) p.authors = [...authorSel].join(',');
    if (commitMode === 'range') {
      const from = dateToSec(fromDate, false);
      const to = dateToSec(toDate, true);
      if (from !== null) p.from = from;
      if (to !== null) p.to = to;
    }
    if (commitMode === 'commits' && hashes.size) p.hashes = [...hashes].join(',');
    p.sort = sort.key;
    p.dir = sort.dir;
    return p;
  }, [path, authorSel, commitMode, fromDate, toDate, hashes, sort]);

  useEffect(() => {
    if (!repoId || !repoReady) {
      setDash(null);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = { ...metricsParams };
        if (tab === 'files') {
          params.limit = PAGE_SIZE;
          params.offset = filesPage * PAGE_SIZE;
        }
        if (tab === 'dirs') {
          params.limit = PAGE_SIZE;
          params.offset = dirsPage * PAGE_SIZE;
        }
        const data = await api.getMetrics(repoId, params);
        setDash(data);
      } catch (err) {
        if (err.name !== 'AbortError') push(err.message);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, repoReady, JSON.stringify(metricsParams), tab, filesPage, dirsPage]);

  // reset pagination when filters change
  useEffect(() => {
    setFilesPage(0);
    setDirsPage(0);
  }, [metricsParams]);

  // ---- actions -----------------------------------------------------------
  async function onRepoAdded(newRepo) {
    setAddOpen(false);
    setRepos((rs) => [newRepo, ...rs]);
    setRepoId(newRepo.id);
    push(`Ingesting "${newRepo.name}"…`, 'ok');
  }

  async function onDeleteRepo() {
    if (!repo) return;
    if (!window.confirm(`Delete repository "${repo.name}" and its metrics?`)) return;
    try {
      await api.deleteRepo(repo.id);
      setRepos((rs) => rs.filter((r) => r.id !== repo.id));
      setRepoId(null);
      setDash(null);
      push('Repository deleted', 'ok');
    } catch (err) {
      push(err.message);
    }
  }

  function onSort(key) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    );
  }

  function clearFilters() {
    setAuthorSel(new Set());
    setPath('');
    setPathInput('');
    setCommitMode('all');
    setFromDate('');
    setToDate('');
    setHashes(new Set());
  }

  const filterCount =
    authorSel.size + (path ? 1 : 0) + (commitMode !== 'all' ? 1 : 0);

  const scopeLabel = path || 'root';

  // ---- render ------------------------------------------------------------
  return (
    <div className="app">
      <Toasts toasts={toasts} dismiss={dismiss} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">🐀</span>
          <span className="brand-name">RAT</span>
          <span className="brand-sub">Repo Analysis Tool</span>
        </div>
        <div className="topbar-controls">
          <select
            className="repo-select"
            value={repoId ?? ''}
            onChange={(e) => setRepoId(Number(e.target.value) || null)}
          >
            {repos.length === 0 && <option value="">No repositories yet</option>}
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {ACTIVE.includes(r.status) ? ` (${r.status}…)` : r.status === 'error' ? ' (failed)' : ''}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            + Add Repository
          </button>
          <button
            className="btn"
            onClick={() => setMergeOpen(true)}
            disabled={!repoReady}
            title="Merge author identities"
          >
            Authors
          </button>
          <button className="btn btn-danger-ghost" onClick={onDeleteRepo} disabled={!repo} title="Delete repository">
            Delete
          </button>
        </div>
      </header>

      {repos.length === 0 ? (
        <div className="hero">
          <EmptyState
            icon="🐀"
            title="Welcome to RAT"
            hint="Add a repository to analyse git metrics per file, directory, repository, commit set and author."
          />
          <button className="btn btn-primary btn-big" onClick={() => setAddOpen(true)}>
            + Add your first repository
          </button>
        </div>
      ) : (
        <div className="layout">
          {/* ------------------------------------------------- sidebar */}
          <aside className="sidebar">
            <div className="panel">
              <div className="panel-title">
                Filters
                {filterCount > 0 && (
                  <button className="btn btn-small" onClick={clearFilters}>
                    Clear ({filterCount})
                  </button>
                )}
              </div>

              <div className="filter-block">
                <div className="filter-label">Author</div>
                <input
                  className="filter-search"
                  placeholder="Filter authors…"
                  value={authorQuery}
                  onChange={(e) => setAuthorQuery(e.target.value)}
                />
                <div className="mini-actions">
                  <button className="link" onClick={() => setAuthorSel(new Set(authors.map((a) => a.key)))}>
                    all
                  </button>
                  <button className="link" onClick={() => setAuthorSel(new Set())}>
                    none
                  </button>
                </div>
                <div className="author-checklist">
                  {authors
                    .filter(
                      (a) =>
                        !authorQuery ||
                        a.name.toLowerCase().includes(authorQuery.toLowerCase()) ||
                        a.key.toLowerCase().includes(authorQuery.toLowerCase())
                    )
                    .map((a) => (
                      <label key={a.key} className="author-check" title={a.key}>
                        <input
                          type="checkbox"
                          checked={authorSel.has(a.key)}
                          onChange={() =>
                            setAuthorSel((s) => {
                              const n = new Set(s);
                              if (n.has(a.key)) n.delete(a.key);
                              else n.add(a.key);
                              return n;
                            })
                          }
                        />
                        <span className="truncate">{a.name}</span>
                        <span className="count">{a.commits}</span>
                      </label>
                    ))}
                  {!repoReady && <div className="hint">waiting for repository…</div>}
                  {repoReady && authors.length === 0 && <div className="hint">no authors</div>}
                </div>
              </div>

              <div className="filter-block">
                <div className="filter-label">File or directory</div>
                <div className="path-row">
                  <input
                    list="path-suggestions"
                    placeholder="root (entire repository)"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setPath(pathInput.trim().replace(/^\/+|\/+$/g, ''));
                    }}
                  />
                  <datalist id="path-suggestions">
                    {pathSuggestions.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.type}
                      </option>
                    ))}
                  </datalist>
                  <button className="btn btn-small" onClick={() => setPath(pathInput.trim().replace(/^\/+|\/+$/g, ''))}>
                    Go
                  </button>
                </div>
                {path && (
                  <button className="link" onClick={() => { setPath(''); setPathInput(''); }}>
                    back to root
                  </button>
                )}
              </div>

              <div className="filter-block">
                <div className="filter-label">Commit set</div>
                <label className="radio">
                  <input
                    type="radio"
                    checked={commitMode === 'all'}
                    onChange={() => setCommitMode('all')}
                  />
                  All commits
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    checked={commitMode === 'range'}
                    onChange={() => setCommitMode('range')}
                  />
                  Date range (committer date)
                </label>
                {commitMode === 'range' && (
                  <div className="date-range">
                    <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                    <span>→</span>
                    <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                  </div>
                )}
                <label className="radio">
                  <input
                    type="radio"
                    checked={commitMode === 'commits'}
                    onChange={() => setCommitMode('commits')}
                  />
                  Selected commits
                </label>
                {commitMode === 'commits' && (
                  <div className="commit-sel">
                    <button className="btn btn-small" onClick={() => setPickerOpen(true)}>
                      {hashes.size ? `Edit selection (${hashes.size})` : 'Choose commits'}
                    </button>
                    {hashes.size > 0 && (
                      <button className="link" onClick={() => setHashes(new Set())}>
                        clear
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="sidebar-note">
              Metrics follow the brief: file, directory, repository, commit-set and author
              statistics with rename detection (50%), binary files excluded.
            </div>
          </aside>

          {/* ---------------------------------------------------- main */}
          <main className="main">
            {repo && ACTIVE.includes(repo.status) && (
              <div className="banner banner-progress">
                <Spinner label={`${repo.name}: ${repo.status}…`} />
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${Math.round(repo.progress * 100)}%` }} />
                </div>
                <span className="progress-label">{Math.round(repo.progress * 100)}%</span>
              </div>
            )}
            {repo && repo.status === 'error' && (
              <div className="banner banner-error">
                <strong>Failed to ingest "{repo.name}":</strong> {repo.error}
              </div>
            )}

            {repoReady && (
              <>
                <nav className="breadcrumb">
                  <button className={`crumb ${!path ? 'current' : ''}`} onClick={() => setPath('')}>
                    {repo.name}
                  </button>
                  {path
                    .split('/')
                    .filter(Boolean)
                    .map((seg, i, arr) => {
                      const target = arr.slice(0, i + 1).join('/');
                      return (
                        <React.Fragment key={target}>
                          <span className="crumb-sep">/</span>
                          <button
                            className={`crumb ${target === path ? 'current' : ''}`}
                            onClick={() => setPath(target)}
                          >
                            {seg}
                          </button>
                        </React.Fragment>
                      );
                    })}
                </nav>

                <section className="cards">
                  <Card label="Commits (|H|)" value={dash ? fmt.num(dash.set.size) : '…'} />
                  <Card label="Added" value={dash ? fmt.num(dash.object.added) : '…'} tone="green" />
                  <Card label="Removed" value={dash ? fmt.num(dash.object.removed) : '…'} tone="red" />
                  <Card
                    label="Growth"
                    value={dash ? fmt.num(dash.object.growth) : '…'}
                    tone={dash && dash.object.growth < 0 ? 'red' : 'green'}
                  />
                  <Card label="Churn" value={dash ? fmt.num(dash.object.churn) : '…'} />
                  <Card label="Modifications" value={dash ? fmt.num(dash.object.modifications) : '…'} />
                  <Card
                    label="Mod frequency"
                    value={dash ? fmt.pct(dash.object.modificationFrequency) : '…'}
                  />
                  <Card label="Churn rate" value={dash ? fmt.num(dash.object.churnRate) : '…'} />
                </section>

                <div className="tabs" role="tablist">
                  {[
                    ['overview', 'Overview'],
                    ['dirs', 'Directories'],
                    ['files', 'Files'],
                    ['authors', 'Authors'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={tab === id}
                      className={`tab ${tab === id ? 'active' : ''}`}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                  {loading && <Spinner label="" />}
                </div>

                <section className="tab-content">
                  {!dash && loading && <Spinner label="Computing metrics…" />}
                  {dash && tab === 'overview' && (
                    <div className="overview-grid">
                      <div className="panel">
                        <div className="panel-title">Added vs removed over time — {scopeLabel}</div>
                        <ActivityChart data={dash.timeseries} bucketSec={dash.bucketSec} />
                      </div>
                      <div className="panel">
                        <div className="panel-title">Churn by author (with ownership)</div>
                        <AuthorChart authors={dash.authors} />
                      </div>
                      {dash.scope.type !== 'file' && (
                        <>
                          <div className="panel">
                            <div className="panel-title">Top directories by churn</div>
                            <TopObjectsChart items={dash.directories.items} title="directories" />
                          </div>
                          <div className="panel">
                            <div className="panel-title">Top files by churn</div>
                            <TopObjectsChart items={dash.files.items} title="files" />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {dash && tab === 'dirs' && (
                    <div className="panel">
                      <div className="panel-title">
                        Directories in {scopeLabel} — click a directory to drill down
                      </div>
                      <ObjectTable
                        kind="dirs"
                        data={dash.directories}
                        sort={sort}
                        dir={sort.dir}
                        onSort={onSort}
                        onOpen={(name) =>
                          setPath(path ? `${path}/${name}` : name)
                        }
                        page={dirsPage}
                        onPage={setDirsPage}
                        limit={PAGE_SIZE}
                      />
                    </div>
                  )}
                  {dash && tab === 'files' && (
                    <div className="panel">
                      <div className="panel-title">Files in {scopeLabel}</div>
                      <ObjectTable
                        kind="files"
                        data={dash.files}
                        sort={sort}
                        dir={sort.dir}
                        onSort={onSort}
                        page={filesPage}
                        onPage={setFilesPage}
                        limit={PAGE_SIZE}
                      />
                    </div>
                  )}
                  {dash && tab === 'authors' && (
                    <div className="panel">
                      <div className="panel-title">
                        Author metrics on {scopeLabel}{' '}
                        <button className="btn btn-small" onClick={() => setMergeOpen(true)}>
                          Merge authors…
                        </button>
                      </div>
                      <AuthorTable authors={dash.authors} />
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </div>
      )}

      {addOpen && (
        <AddRepoModal onClose={() => setAddOpen(false)} onAdded={onRepoAdded} toast={push} />
      )}
      {mergeOpen && repoId && (
        <AuthorMergeModal
          repoId={repoId}
          authors={authors}
          onChanged={(list) => {
            setAuthors(list);
            // refresh metrics: merged identities change author aggregates
            setDash(null);
            setLoading(true);
          }}
          onClose={() => {
            setMergeOpen(false);
            reloadAuthors();
          }}
          toast={push}
        />
      )}
      {pickerOpen && repoId && (
        <CommitPickerModal
          repoId={repoId}
          initialSelected={[...hashes]}
          onClose={() => setPickerOpen(false)}
          onSave={(list) => {
            setHashes(new Set(list));
            setPickerOpen(false);
          }}
          toast={push}
        />
      )}
    </div>
  );
}

function Card({ label, value, tone }) {
  return (
    <div className={`card ${tone ? `card-${tone}` : ''}`}>
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
