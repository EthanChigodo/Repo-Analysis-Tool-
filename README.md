# RAT - Repo Analysis Tool

A web-app dashboard that measures git metrics (added/removed lines, growth,
churn, modifications, modification frequency, churn rate, author ownership)
for files, directories, whole repositories, and arbitrary commit sets -
filterable by repository, author, file/directory, and commit set (a time
period or a manually selected list of commits).

Repositories can be added either as a zip of the working tree (containing the
`.git` directory) or as a remote URL that is deeply cloned. Author identities
are unified automatically via the repository's `.mailmap`, and can also be
merged manually from the UI when no mailmap is provided.

## Requirements

- Node.js >= 18
- `git` on `PATH`
- No native build tools needed - storage uses `sql.js` (SQLite compiled to
  WebAssembly), so `npm install` never compiles anything.

## Running it

```bash
./start.sh
```

This installs dependencies on first run, builds the frontend, and starts the
server at **http://localhost:3000**.

Equivalently, step by step:

```bash
npm install
npm run build   # builds web/ into dist/, served by the Express server
npm start        # starts the server on http://localhost:3000
```

For frontend development with hot reload (Vite dev server on :5173 proxying
`/api` to the Express server on :3000), use:

```bash
npm run dev
```

### Performance check

```bash
node scripts/perf-test.mjs 100000
```

Generates a synthetic ~100,000-commit repository with `git fast-import`
(independent of our own ingestion code), then times ingestion and a set of
representative dashboard queries against it. On the development machine this
ingests 100k commits in under 5 seconds and answers every dashboard query
(root/directory/file scope, author filter, date-range filter) in well under
3 seconds, each backed by a single indexed SQL aggregation pass rather than
an in-memory walk of commit history.

### Running the test suite

```bash
npm test
```

This runs `scripts/verify.js`, a self-contained check that builds a small
synthetic git repository (with renames, binary files, deletions, a merge
commit, and a `.mailmap`), ingests it through both the zip and clone paths,
and asserts every metric formula from the brief against hand-computed values
(154 checks).

## Usage

1. Open http://localhost:3000.
2. Click **+ Add Repository** and either upload a zip of a repo (must include
   its `.git` folder) or paste a remote clone URL (e.g.
   `https://github.com/DaveGamble/cJSON.git`). Ingestion progress is shown
   while the repository is cloned/extracted and its history is indexed.
3. Pick the repository from the top-left selector. Use the sidebar to filter
   by author, by a file/directory path, and by commit set (all history, a
   date range, or a manually picked list of commits).
4. The main panel shows repository/directory/file-level metrics (cards,
   activity chart, sortable/paginated tables) and the author breakdown
   (modifications, churn, ownership) for the current scope. Click a
   directory or file row to drill into it; use the breadcrumb to go back up.
5. Click **Authors** to merge author identities that the repository's
   `.mailmap` doesn't already cover (select two or more identities and
   merge them), or split a previously merged group apart again.

## Architecture

- `server/git.js` - spawns `git log --no-merges --numstat -M50% -z` and
  parses its binary-safe output with a small streaming state machine (one
  pass over the repository's history, independent of repository size).
- `server/db.js` / `server/sqlite.js` - SQLite (via `sql.js`) schema and a
  thin adapter; every commit's per-path added/removed line counts are stored
  once and all metrics are computed with indexed SQL aggregation at query
  time, rather than being recomputed by walking commit history per request.
- `server/metrics.js` - implements every formula from the brief (file,
  directory, repository, commit-set, and author metrics) as parameterised
  SQL over the selected commit set `H`.
- `server/ingest.js` - serialized ingestion queue; handles zip extraction and
  remote cloning (with mailmap wiring for bare clones).
- `server/authors.js` - manual author merge/unmerge on top of the mailmap.
- `web/` - React + Vite dashboard (filters, drill-down, charts, tables).

## Notes

- Binary files are excluded from all metrics (per the brief).
- Rename detection is enabled at a 50% similarity threshold; a pure rename
  does not change any metric, and edits made alongside a rename are
  attributed to the file's new path.
- A deleted file is recorded as a removal on its last path.
- Metric correctness was additionally cross-checked against the maintainers'
  reference statistics for the cJSON test repository (exact match on root
  repository totals at the specified commit).
