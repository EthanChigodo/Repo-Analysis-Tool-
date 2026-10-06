import fs from 'node:fs';
import path from 'node:path';
import { openDb as openSqlite } from './sqlite.js';

/**
 * SQLite storage for RAT (pure JS/WASM via sql.js - no native builds).
 * Open with `await openDb(dataDir)`.
 *
 * Schema notes:
 *  - repos:      one row per ingested repository + ingestion status/progress.
 *  - commits:    every non-merge commit reachable from HEAD (H-bar in the brief),
 *                with post-mailmap author identity and committer date.
 *  - changes:    per-commit per-file numstat (added/removed lines). Binary files
 *                are never stored (not measured per brief). Pure renames are
 *                stored as 0/0 rows on the new path so the path stays visible.
 *  - paths:      distinct file paths + all ancestor directories, used for the
 *                path autocomplete and to distinguish files from directories.
 *  - author_merge: manual author merge mapping email -> canonical email.
 */
export async function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = await openSqlite(dataDir);
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source TEXT NOT NULL,
      dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      progress REAL NOT NULL DEFAULT 0,
      commit_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commits(
      repo_id INTEGER NOT NULL,
      hash TEXT NOT NULL,
      parent TEXT,
      author_email TEXT NOT NULL,
      author_name TEXT NOT NULL,
      date INTEGER NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(repo_id, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_commits_date   ON commits(repo_id, date);
    CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(repo_id, author_email);

    CREATE TABLE IF NOT EXISTS changes(
      repo_id INTEGER NOT NULL,
      hash TEXT NOT NULL,
      path TEXT NOT NULL,
      added INTEGER NOT NULL,
      removed INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_path ON changes(repo_id, path);
    CREATE INDEX IF NOT EXISTS idx_changes_hash ON changes(repo_id, hash);

    CREATE TABLE IF NOT EXISTS paths(
      repo_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY(repo_id, path)
    );

    CREATE TABLE IF NOT EXISTS author_merge(
      repo_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      canonical TEXT NOT NULL,
      PRIMARY KEY(repo_id, email)
    );
  `);
}

export function createRepo(db, { name, sourceType, source, dir }) {
  const info = db
    .prepare(
      `INSERT INTO repos(name, source_type, source, dir, status, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    )
    .run(name, sourceType, source, dir, Date.now());
  return info.lastInsertRowid;
}

export function getRepo(db, id) {
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

export function listRepos(db) {
  return db.prepare('SELECT * FROM repos ORDER BY id DESC').all();
}

export function updateRepo(db, id, fields) {
  const allowed = ['status', 'error', 'progress', 'commit_count'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }
  if (!sets.length) return;
  params.push(id);
  db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteRepo(db, id) {
  const repo = getRepo(db, id);
  if (!repo) return null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM changes WHERE repo_id = ?').run(id);
    db.prepare('DELETE FROM commits WHERE repo_id = ?').run(id);
    db.prepare('DELETE FROM paths WHERE repo_id = ?').run(id);
    db.prepare('DELETE FROM author_merge WHERE repo_id = ?').run(id);
    db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  });
  tx();
  return repo;
}

export function publicRepo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    source: row.source,
    status: row.status,
    error: row.error,
    progress: row.progress,
    commitCount: row.commit_count,
    createdAt: row.created_at,
  };
}
