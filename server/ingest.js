import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extract from 'extract-zip';
import { getRepo, updateRepo } from './db.js';
import { cloneRepo, countCommits, locateGit, streamHistory, GitError } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.RAT_DATA_DIR || path.join(__dirname, '..', 'data');
export const REPOS_DIR = path.join(DATA_DIR, 'repos');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

/** Ingestions run strictly one at a time (SQLite writes are synchronous). */
let queue = Promise.resolve();

export function enqueueIngest(db, repoId) {
  queue = queue
    .then(() => ingestRepo(db, repoId))
    .catch((err) => {
      // Should not happen: ingestRepo handles its own errors. Keep the queue alive.
      console.error(`[rat] ingest of repo ${repoId} crashed:`, err);
    });
  return queue;
}

export function createZipRepo(db, { name, source, zipPath }) {
  const info = db
    .prepare(
      "INSERT INTO repos(name, source_type, source, dir, status, created_at) VALUES (?, 'zip', ?, '', 'queued', ?)"
    )
    .run(name, source, Date.now());
  const repoId = info.lastInsertRowid;
  const dir = path.join(REPOS_DIR, String(repoId));
  db.prepare('UPDATE repos SET dir = ? WHERE id = ?').run(dir, repoId);
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(zipPath, path.join(dir, 'upload.zip'));
  enqueueIngest(db, repoId);
  return repoId;
}

export function createCloneRepo(db, { name, url }) {
  const info = db
    .prepare(
      "INSERT INTO repos(name, source_type, source, dir, status, created_at) VALUES (?, 'clone', ?, '', 'queued', ?)"
    )
    .run(name, url, Date.now());
  const repoId = info.lastInsertRowid;
  const dir = path.join(REPOS_DIR, String(repoId));
  db.prepare('UPDATE repos SET dir = ? WHERE id = ?').run(dir, repoId);
  enqueueIngest(db, repoId);
  return repoId;
}

async function ingestRepo(db, repoId) {
  const repo = getRepo(db, repoId);
  if (!repo) return;
  try {
    let gitDir;
    let workDir;
    if (repo.source_type === 'zip') {
      updateRepo(db, repoId, { status: 'extracting', progress: 0.05, error: null });
      const dest = path.join(repo.dir, 'checkout');
      fs.mkdirSync(dest, { recursive: true });
      await extract(path.join(repo.dir, 'upload.zip'), { dir: dest });
      fs.rmSync(path.join(repo.dir, 'upload.zip'), { force: true });
      ({ gitDir, workDir } = locateGit(dest));
    } else {
      updateRepo(db, repoId, { status: 'cloning', progress: 0.05, error: null });
      await cloneRepo(repo.source, repo.dir, (p) => {
        updateRepo(db, repoId, { progress: 0.05 + p * 0.6 });
      });
      gitDir = repo.dir;
      workDir = null; // bare clone; mailmap resolved via mailmap.file in cloneRepo
    }

    updateRepo(db, repoId, { status: 'parsing', progress: 0.65, error: null });
    const total = await countCommits(gitDir).catch(() => null);

    let parsed = 0;
    let pendingCommits = [];
    let pendingChanges = [];
    const insertCommit = db.prepare(
      `INSERT OR IGNORE INTO commits(repo_id, hash, parent, author_email, author_name, date, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChange = db.prepare(
      `INSERT INTO changes(repo_id, hash, path, added, removed) VALUES (?, ?, ?, ?, ?)`
    );

    const flush = db.transaction(() => {
      for (const c of pendingCommits) {
        insertCommit.run(repoId, c.hash, c.parent, c.authorEmail, c.authorName, c.date, c.subject);
      }
      for (const ch of pendingChanges) {
        insertChange.run(repoId, ch.hash, ch.path, ch.added, ch.removed);
      }
      pendingCommits = [];
      pendingChanges = [];
    });

    let lastProgress = Date.now();
    await streamHistory(gitDir, workDir, (commit) => {
      parsed += 1;
      pendingCommits.push(commit);
      for (const f of commit.files) pendingChanges.push({ hash: commit.hash, ...f });
      if (pendingCommits.length >= 2000) {
        flush();
        if (total && Date.now() - lastProgress > 300) {
          lastProgress = Date.now();
          updateRepo(db, repoId, { progress: 0.65 + 0.3 * (parsed / total), commit_count: parsed });
        }
      }
    });
    flush();

    updateRepo(db, repoId, { status: 'indexing', progress: 0.95, commit_count: parsed });
    buildPathIndex(db, repoId);

    updateRepo(db, repoId, { status: 'ready', progress: 1, commit_count: parsed, error: null });
    db.save();
  } catch (err) {
    const message = err instanceof GitError ? err.message : err.message || 'Ingestion failed';
    updateRepo(db, repoId, { status: 'error', error: String(message).slice(0, 500) });
    db.save();
  }
}

/** Populate the `paths` table: distinct file paths plus all ancestor directories. */
function buildPathIndex(db, repoId) {
  db.prepare('DELETE FROM paths WHERE repo_id = ?').run(repoId);
  const insertPath = db.prepare('INSERT OR IGNORE INTO paths(repo_id, path, type) VALUES (?, ?, ?)');
  const files = db.prepare('SELECT DISTINCT path FROM changes WHERE repo_id = ?').all(repoId);
  const dirs = new Set();
  const load = db.transaction(() => {
    for (const { path: p } of files) {
      insertPath.run(repoId, p, 'file');
      let idx = p.indexOf('/');
      while (idx !== -1) {
        dirs.add(p.slice(0, idx));
        idx = p.indexOf('/', idx + 1);
      }
    }
    for (const d of dirs) insertPath.run(repoId, d, 'dir');
  });
  load();
}
