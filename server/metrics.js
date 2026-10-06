/**
 * Metric queries implementing the brief §2 formulas.
 *
 * All metrics are computed over a commit set H ⊆ H-bar, where H-bar is every
 * non-merge commit reachable from HEAD (all rows in `commits`). H is selected
 * by filters: authors (post-merge), committer-date range [from, to), and/or a
 * manual list of commit hashes.
 *
 *  File/Directory/Repository metrics (per commit h):
 *    l+ added, l- removed, delta = l+ - l- (growth), lambda = l+ + l- (churn)
 *  Directory metrics on d = sum over all files under d. Because each
 *  subdirectory's metric is itself the sum of its own children, summing every
 *  descendant file is equivalent to the brief's immediate-children recursion.
 *  Repository metrics = directory metrics on the root.
 *
 *  Commit-set metrics (over H, object o):
 *    added/removed/growth/churn = sums over h in H
 *    modifications   n  = #{ h in H : lambda(h,o) > 0 }
 *    mod frequency   eta = n / |H|           (0 when |H| = 0)
 *    churn rate      rho = lambda / |H|      (0 when |H| = 0)
 *
 *  Author metrics (over H, object o, author a):
 *    author modifications = #{ h in H : a = h[a] and lambda(h,o) > 0 }
 *    author churn         = sum of lambda(h,o) for h in H with a = h[a]
 *    author ownership     = author churn / total churn on o over H across
 *                           ALL authors (not narrowed by an author filter -
 *                           selecting one author should show their true
 *                           share, not 100%).
 */

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * Resolve a user-supplied path to a measurable object.
 * Returns { type: 'root' | 'file' | 'dir', path } or null when the path does
 * not exist in the repository's history.
 */
export function resolveScope(db, repoId, rawPath) {
  const p = (rawPath || '').replace(/^\/+|\/+$/g, '');
  if (!p) return { type: 'root', path: '' };
  const row = db.prepare('SELECT type FROM paths WHERE repo_id = ? AND path = ?').get(repoId, p);
  if (row) return { type: row.type === 'dir' ? 'dir' : 'file', path: p };
  return null;
}

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Prepare filter state. Filters (see brief §2):
 *   authors: array of post-merge author emails
 *   from/to: committer-date window, from inclusive, to exclusive
 *   hashes:  manually selected commit list
 */
function prepareFilters(db, filters) {
  const params = { repo: filters.repoId };
  const commitWhere = ['h.repo_id = @repo'];
  const changeWhere = ['c.repo_id = @repo'];
  let hashJoin = '';

  if (filters.authors && filters.authors.length) {
    const keys = filters.authors.map((a, i) => `@a${i}`);
    filters.authors.forEach((a, i) => (params[`a${i}`] = a));
    commitWhere.push(`COALESCE(am.canonical, h.author_email) IN (${keys.join(',')})`);
  }
  if (filters.from !== undefined && filters.from !== null && filters.from !== '') {
    params.from = intOrNull(filters.from);
    if (params.from !== null) commitWhere.push('h.date >= @from');
  }
  if (filters.to !== undefined && filters.to !== null && filters.to !== '') {
    params.to = intOrNull(filters.to);
    if (params.to !== null) commitWhere.push('h.date < @to');
  }
  if (filters.hashes && filters.hashes.length) {
    db.prepare('CREATE TEMP TABLE IF NOT EXISTS sel_hashes(hash TEXT PRIMARY KEY)').run();
    db.prepare('DELETE FROM sel_hashes').run();
    const ins = db.prepare('INSERT OR IGNORE INTO sel_hashes(hash) VALUES (?)');
    const load = db.transaction((hashes) => {
      for (const h of hashes) ins.run(h);
    });
    load(filters.hashes);
    hashJoin = 'JOIN sel_hashes sh ON sh.hash = h.hash';
  }
  return { params, commitWhere, hashJoin };
}

function scopeFilter(scope, params) {
  if (scope.type === 'root') return '1 = 1';
  if (scope.type === 'file') {
    params.scopePath = scope.path;
    return 'c.path = @scopePath';
  }
  params.scopePrefix = escapeLike(scope.path) + '/%';
  return "c.path LIKE @scopePrefix ESCAPE '\\'";
}

/** |H| and date range of the filtered commit set. */
function setInfo(db, filters, prepared) {
  const { params, commitWhere, hashJoin } = prepared;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS size, COALESCE(MIN(h.date), 0) AS minDate, COALESCE(MAX(h.date), 0) AS maxDate
       FROM commits h LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${commitWhere.join(' AND ')}`
    )
    .get(params);
  return { size: row.size, minDate: row.minDate, maxDate: row.maxDate };
}

/** added/removed/growth/churn/modifications of one object over H. */
function objectTotals(db, filters, prepared, scope) {
  const { params, commitWhere, hashJoin } = prepared;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(c.added), 0) AS added, COALESCE(SUM(c.removed), 0) AS removed,
              COUNT(DISTINCT CASE WHEN c.added + c.removed > 0 THEN c.hash END) AS modifications
       FROM changes c
       JOIN commits h ON h.repo_id = c.repo_id AND h.hash = c.hash
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${commitWhere.join(' AND ')} AND ${scopeFilter(scope, params)}`
    )
    .get(params);
  return finalizeObject(row, filters);
}

function finalizeObject(row, filters) {
  const size = filters.setSize || 0;
  const added = row.added || 0;
  const removed = row.removed || 0;
  const churn = added + removed;
  const modifications = row.modifications || 0;
  return {
    added,
    removed,
    growth: added - removed,
    churn,
    modifications,
    modificationFrequency: size > 0 ? modifications / size : 0,
    churnRate: size > 0 ? churn / size : 0,
  };
}

const CHILD_SORTS = {
  name: 'child',
  added: 'added',
  removed: 'removed',
  growth: '(added - removed)',
  churn: '(added + removed)',
  modifications: 'modifications',
};

/**
 * Immediate children (files and/or directories) of the scope directory with
 * their aggregated metrics. For directories the metric is the recursive sum
 * over all descendant files (equivalent to the brief's immediate-children
 * definition).
 */
function listChildren(db, filters, prepared, scope, { kind, sort, dir, limit, offset }) {
  const { params, commitWhere, hashJoin } = prepared;
  // rest = path relative to the scope directory
  const restExpr =
    scope.type === 'root' ? 'c.path' : `substr(c.path, ${scope.path.length + 2})`;
  const kindFilter = kind === 'files' ? 'isDir = 0' : 'isDir = 1';
  const orderCol = CHILD_SORTS[sort] || CHILD_SORTS.churn;
  const orderDir = dir === 'asc' ? 'ASC' : 'DESC';
  const inner = `
    SELECT ${restExpr} AS rest, c.added AS added, c.removed AS removed, c.hash AS hash
    FROM changes c
    JOIN commits h ON h.repo_id = c.repo_id AND h.hash = c.hash
    LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
    ${hashJoin}
    WHERE ${commitWhere.join(' AND ')} AND ${scopeFilter(scope, params)}`;
  const mid = `
    SELECT
      CASE WHEN instr(rest, '/') = 0 THEN rest ELSE substr(rest, 1, instr(rest, '/') - 1) END AS child,
      MAX(instr(rest, '/') > 0) AS isDir,
      COALESCE(SUM(added), 0) AS added,
      COALESCE(SUM(removed), 0) AS removed,
      COUNT(DISTINCT CASE WHEN added + removed > 0 THEN hash END) AS modifications
    FROM (${inner})
    GROUP BY child`;
  const grouped = `SELECT child, isDir, added, removed, modifications FROM (${mid}) WHERE ${kindFilter}`;
  // COUNT(*) OVER() piggybacks the total row count onto the same pass that
  // produces the page, instead of re-running the group-by a second time.
  const windowed = `SELECT *, COUNT(*) OVER() AS total_count FROM (${grouped})`;
  const rows = db
    .prepare(`${windowed} ORDER BY ${orderCol} ${orderDir}, child ASC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });
  const total =
    rows.length > 0 ? rows[0].total_count : db.prepare(`SELECT COUNT(*) AS n FROM (${grouped})`).get(params).n;
  return {
    total,
    items: rows.map((r) => ({
      name: r.child,
      isDir: !!r.isDir,
      added: r.added,
      removed: r.removed,
      growth: r.added - r.removed,
      churn: r.added + r.removed,
      modifications: r.modifications,
      modificationFrequency: filters.setSize > 0 ? r.modifications / filters.setSize : 0,
      churnRate: filters.setSize > 0 ? (r.added + r.removed) / filters.setSize : 0,
    })),
  };
}

/**
 * Author metrics (modifications, churn, ownership) over the scope in H.
 * Per the brief, lambda_{H,o} (the ownership denominator) is the TOTAL churn
 * on o over H across every author - it is not narrowed by an author filter.
 * So we compute the per-author rows with the active filters (which may
 * restrict to selected authors), but always compute the denominator against
 * the unfiltered-by-author commit set.
 */
function authorMetrics(db, filters, prepared, scope) {
  const { params, commitWhere, hashJoin } = prepared;
  const rows = db
    .prepare(
      `SELECT COALESCE(am.canonical, h.author_email) AS key,
              COUNT(DISTINCT CASE WHEN c.added + c.removed > 0 THEN c.hash END) AS modifications,
              COALESCE(SUM(c.added + c.removed), 0) AS churn
       FROM changes c
       JOIN commits h ON h.repo_id = c.repo_id AND h.hash = c.hash
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${commitWhere.join(' AND ')} AND ${scopeFilter(scope, params)}
       GROUP BY key
       ORDER BY churn DESC`
    )
    .all(params);

  const unfilteredPrepared =
    filters.authors && filters.authors.length
      ? prepareFilters(db, { ...filters, authors: null })
      : prepared;
  const totalChurn = db
    .prepare(
      `SELECT COALESCE(SUM(c.added + c.removed), 0) AS churn
       FROM changes c
       JOIN commits h ON h.repo_id = c.repo_id AND h.hash = c.hash
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${unfilteredPrepared.hashJoin}
       WHERE ${unfilteredPrepared.commitWhere.join(' AND ')} AND ${scopeFilter(scope, unfilteredPrepared.params)}`
    )
    .get(unfilteredPrepared.params).churn;

  return rows.map((r) => ({
    key: r.key,
    modifications: r.modifications || 0,
    churn: r.churn || 0,
    ownership: totalChurn > 0 ? (r.churn || 0) / totalChurn : 0,
  }));
}

/** Commit counts per author over the filtered set H (for the author table). */
function authorCommitCounts(db, filters, prepared) {
  const { params, commitWhere, hashJoin } = prepared;
  const rows = db
    .prepare(
      `SELECT COALESCE(am.canonical, h.author_email) AS key, COUNT(*) AS commits
       FROM commits h
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${commitWhere.join(' AND ')}
       GROUP BY key`
    )
    .all(params);
  const map = new Map();
  for (const r of rows) map.set(r.key, r.commits);
  return map;
}

/** Per-author display names (most used name per merged key, whole repo). */
export function authorDisplayNames(db, repoId) {
  const rows = db
    .prepare(
      `SELECT COALESCE(am.canonical, h.author_email) AS key, h.author_name AS name, COUNT(*) AS n
       FROM commits h
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       WHERE h.repo_id = ?
       GROUP BY key, name
       ORDER BY n DESC`
    )
    .all(repoId);
  const names = new Map();
  for (const r of rows) if (!names.has(r.key)) names.set(r.key, r.name);
  return names;
}

/** Added/removed lines per time bucket over the scope in H (for charts). */
function timeSeries(db, filters, prepared, scope, bucketSec) {
  const { params, commitWhere, hashJoin } = prepared;
  const rows = db
    .prepare(
      `SELECT (h.date / @bucket) * @bucket AS t,
              COALESCE(SUM(c.added), 0) AS added,
              COALESCE(SUM(c.removed), 0) AS removed
       FROM changes c
       JOIN commits h ON h.repo_id = c.repo_id AND h.hash = c.hash
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${commitWhere.join(' AND ')} AND ${scopeFilter(scope, params)}
       GROUP BY t
       ORDER BY t`
    )
    .all({ ...params, bucket: bucketSec });
  return rows.map((r) => ({
    t: r.t,
    added: r.added,
    removed: r.removed,
    growth: r.added - r.removed,
    churn: r.added + r.removed,
  }));
}

function chooseBucket(minDate, maxDate) {
  const span = Math.max(maxDate - minDate, 1);
  const DAY = 86400;
  if (span <= 2 * DAY) return 3600;
  if (span <= 90 * DAY) return DAY;
  if (span <= 540 * DAY) return 7 * DAY;
  return 30 * DAY;
}

/**
 * Full dashboard payload for one repository + filters.
 */
export function getDashboard(db, repoId, filters, opts = {}) {
  const scope = filters.scope;
  const prepared = prepareFilters(db, filters);
  const set = setInfo(db, filters, prepared);
  filters.setSize = set.size;
  const totals = objectTotals(db, filters, prepared, scope);
  const pagination = {
    sort: CHILD_SORTS[opts.sort] ? opts.sort : 'churn',
    dir: opts.dir === 'asc' ? 'asc' : 'desc',
    limit: Math.min(Math.max(opts.limit || 50, 1), 500),
    offset: Math.max(opts.offset || 0, 0),
  };
  const result = {
    scope: { type: scope.type, path: scope.path },
    set: {
      size: set.size,
      minDate: set.minDate,
      maxDate: set.maxDate,
    },
    object: totals,
    directories: null,
    files: null,
    authors: null,
    timeseries: null,
  };
  if (scope.type !== 'file') {
    result.directories = listChildren(db, filters, prepared, scope, {
      kind: 'dirs',
      sort: pagination.sort,
      dir: pagination.dir,
      limit: pagination.limit,
      offset: pagination.offset,
    });
    result.files = listChildren(db, filters, prepared, scope, {
      kind: 'files',
      sort: pagination.sort,
      dir: pagination.dir,
      limit: pagination.limit,
      offset: pagination.offset,
    });
  } else {
    // A file object: still list authors over it and show its history series.
    result.directories = { total: 0, items: [] };
    result.files = { total: 0, items: [] };
  }
  const authors = authorMetrics(db, filters, prepared, scope);
  const commitCounts = authorCommitCounts(db, filters, prepared);
  const names = authorDisplayNames(db, repoId);
  result.authors = authors.map((a) => ({
    ...a,
    commits: commitCounts.get(a.key) || 0,
    name: names.get(a.key) || a.key,
  }));
  // sort authors by commits desc as a secondary view need
  result.authors.sort((x, y) => y.churn - x.churn || y.commits - x.commits);
  const bucket = chooseBucket(set.minDate || Math.floor(Date.now() / 1000), set.maxDate || Math.floor(Date.now() / 1000));
  result.timeseries = timeSeries(db, filters, prepared, scope, bucket);
  result.bucketSec = bucket;
  result.pagination = pagination;
  return result;
}

/** Paginated commit list for the manual commit-set picker. */
export function listCommitsPage(db, repoId, { q, from, to, authors, limit, offset }) {
  const prepared = prepareFilters(db, { repoId, authors, from, to });
  const { params, commitWhere, hashJoin } = prepared;
  let searchJoin = '';
  if (q) {
    params.q = `%${escapeLike(q)}%`;
    params.qPrefix = `${escapeLike(q)}%`;
    searchJoin = 'AND (h.subject LIKE @q ESCAPE \'\\\' OR h.hash LIKE @qPrefix ESCAPE \'\\\')';
  }
  const where = `${commitWhere.join(' AND ')} ${searchJoin}`;
  const rows = db
    .prepare(
      `SELECT h.hash, h.date, h.subject, h.author_name, COALESCE(am.canonical, h.author_email) AS key
       FROM commits h
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${where}
       ORDER BY h.date DESC, h.hash DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM commits h
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       ${hashJoin}
       WHERE ${where}`
    )
    .get(params).n;
  return { total, items: rows };
}

/** Path autocomplete entries (files + directories). */
export function suggestPaths(db, repoId, q, limit) {
  const term = escapeLike(q || '');
  const rows = db
    .prepare(
      `SELECT path, type FROM paths
       WHERE repo_id = ? AND path LIKE ? ESCAPE '\\'
       ORDER BY type DESC, path ASC
       LIMIT ?`
    )
    .all(repoId, `${term}%`, limit);
  return rows;
}

/** All authors in the repository (post-merge keys) with commit counts. */
export function listAuthors(db, repoId) {
  const rows = db
    .prepare(
      `SELECT COALESCE(am.canonical, h.author_email) AS key, COUNT(*) AS commits, MIN(h.date) AS firstDate, MAX(h.date) AS lastDate
       FROM commits h
       LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
       WHERE h.repo_id = ?
       GROUP BY key
       ORDER BY commits DESC`
    )
    .all(repoId);
  const names = authorDisplayNames(db, repoId);
  const merges = db
    .prepare('SELECT email, canonical FROM author_merge WHERE repo_id = ?')
    .all(repoId);
  const members = new Map();
  for (const m of merges) {
    if (!members.has(m.canonical)) members.set(m.canonical, []);
    members.get(m.canonical).push(m.email);
  }
  return rows.map((r) => ({
    key: r.key,
    name: names.get(r.key) || r.key,
    commits: r.commits,
    firstDate: r.firstDate,
    lastDate: r.lastDate,
    mergedFrom: members.get(r.key) || [],
  }));
}
