// Performance check: generates a synthetic ~100,000-commit bare repository
// via `git fast-import` (fast, independent of our own ingestion code), then
// times our ingestion pipeline (streamHistory parse + batched SQLite insert)
// and a handful of representative dashboard queries against it.
//
// Not part of `npm test` (metric correctness is covered there) - run with:
//   node scripts/perf-test.mjs [commitCount]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createRepo, updateRepo, getRepo } from '../server/db.js';
import { streamHistory, countCommits } from '../server/git.js';
import { getDashboard, resolveScope } from '../server/metrics.js';

const N = parseInt(process.argv[2] || '100000', 10);
const FILES = 40;
const DIRS = 8;
const AUTHORS = 12;

function filePath(i) {
  const dir = `dir${i % DIRS}`;
  return `${dir}/file${i % FILES}.txt`;
}

async function generateRepo(bareDir) {
  fs.mkdirSync(bareDir, { recursive: true });
  await run(['init', '--bare', '-q', bareDir]);
  await run(['--git-dir', bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const lineCount = new Array(FILES).fill(0);
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', bareDir, 'fast-import', '--quiet'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`))));

    const w = (s) => child.stdin.write(s);
    const epoch0 = 1_600_000_000;
    for (let i = 0; i < N; i++) {
      const fileIdx = i % FILES;
      const p = filePath(fileIdx);
      lineCount[fileIdx] += 1;
      const content = `line ${lineCount[fileIdx]} of commit ${i}\n`;
      const author = `Author${i % AUTHORS} <author${i % AUTHORS}@example.com>`;
      const date = epoch0 + i * 60;
      w(`commit refs/heads/main\n`);
      w(`committer ${author} ${date} +0000\n`);
      const msg = `commit ${i}`;
      w(`data ${Buffer.byteLength(msg)}\n${msg}\n`);
      // No explicit "from" needed: fast-import automatically chains each new
      // commit on refs/heads/main from the previous commit on that same ref.
      w(`M 100644 inline ${p}\n`);
      w(`data ${Buffer.byteLength(content)}\n${content}`);
      // occasionally delete and recreate a different file to exercise deletes
      if (i % 777 === 0 && i > 0) {
        const victim = filePath((fileIdx + 1) % FILES);
        w(`D ${victim}\n`);
      }
    }
    child.stdin.end();
  });
  console.log(`  fast-import of ${N} commits: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`))));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-perf-'));
  const bareDir = path.join(tmp, 'source.git');
  console.log(`Generating synthetic repo with ${N} commits in ${bareDir} ...`);
  await generateRepo(bareDir);

  const total = await countCommits(bareDir);
  console.log(`  verified HEAD commit count: ${total}`);

  const dataDir = path.join(tmp, 'rat-data');
  const db = await openDb(dataDir);
  const repoId = createRepo(db, { name: 'perf', sourceType: 'clone', source: bareDir, dir: bareDir });

  console.log('Ingesting (streamHistory parse + batched insert)...');
  const t1 = Date.now();
  let parsed = 0;
  let pendingCommits = [];
  let pendingChanges = [];
  const insertCommit = db.prepare(
    `INSERT OR IGNORE INTO commits(repo_id, hash, parent, author_email, author_name, date, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertChange = db.prepare(`INSERT INTO changes(repo_id, hash, path, added, removed) VALUES (?, ?, ?, ?, ?)`);
  const flush = db.transaction(() => {
    for (const c of pendingCommits) insertCommit.run(repoId, c.hash, c.parent, c.authorEmail, c.authorName, c.date, c.subject);
    for (const ch of pendingChanges) insertChange.run(repoId, ch.hash, ch.path, ch.added, ch.removed);
    pendingCommits = [];
    pendingChanges = [];
  });
  await streamHistory(bareDir, null, (commit) => {
    parsed += 1;
    pendingCommits.push(commit);
    for (const f of commit.files) pendingChanges.push({ hash: commit.hash, ...f });
    if (pendingCommits.length >= 2000) flush();
  });
  flush();
  const ingestMs = Date.now() - t1;
  console.log(`  parsed + inserted ${parsed} commits in ${(ingestMs / 1000).toFixed(2)}s (${(parsed / (ingestMs / 1000)).toFixed(0)} commits/s)`);

  console.log('Building path index...');
  const t2 = Date.now();
  db.exec('DELETE FROM paths');
  const insertPath = db.prepare('INSERT OR IGNORE INTO paths(repo_id, path, type) VALUES (?, ?, ?)');
  const files = db.prepare('SELECT DISTINCT path FROM changes WHERE repo_id = ?').all(repoId);
  const dirs = new Set();
  const loadPaths = db.transaction(() => {
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
  loadPaths();
  updateRepo(db, repoId, { status: 'ready', progress: 1, commit_count: parsed });
  console.log(`  path index built in ${((Date.now() - t2) / 1000).toFixed(2)}s`);

  console.log('Querying dashboard (various filters)...');
  const root = resolveScope(db, repoId, '');
  const timeIt = (label, fn) => {
    const t = Date.now();
    const result = fn();
    console.log(`  ${label}: ${Date.now() - t}ms`);
    return result;
  };

  timeIt('root dashboard, all commits', () =>
    getDashboard(db, repoId, { repoId, scope: root }, { limit: 50 })
  );
  timeIt('root dashboard, author filter', () =>
    getDashboard(db, repoId, { repoId, scope: root, authors: ['author0@example.com'] }, { limit: 50 })
  );
  timeIt('root dashboard, date range filter', () =>
    getDashboard(
      db,
      repoId,
      { repoId, scope: root, from: 1_600_000_000, to: 1_600_000_000 + Math.floor(N / 2) * 60 },
      { limit: 50 }
    )
  );
  const dirScope = resolveScope(db, repoId, 'dir0');
  timeIt('directory dashboard (dir0)', () => getDashboard(db, repoId, { repoId, scope: dirScope }, { limit: 50 }));
  const fileScope = resolveScope(db, repoId, filePath(0));
  timeIt('file dashboard', () => getDashboard(db, repoId, { repoId, scope: fileScope }, { limit: 50 }));

  console.log('\nDone. Cleaning up temp directory.');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
