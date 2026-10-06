// Smoke test: zip -> ingestion -> metrics, against hand-computed scratch-repo numbers.
process.env.RAT_DATA_DIR = '/tmp/rat-test-data';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync('/tmp/rat-test-data', { recursive: true, force: true });

const { openDb, getRepo } = await import(path.join(ROOT, 'server/db.js'));
const { createZipRepo } = await import(path.join(ROOT, 'server/ingest.js'));
const { getDashboard, listAuthors, listCommitsPage, resolveScope } = await import(
  path.join(ROOT, 'server/metrics.js')
);
const { mergeAuthors, unmergeAuthors } = await import(path.join(ROOT, 'server/authors.js'));

let failures = 0;
function assert(cond, label, extra = '') {
  if (!cond) {
    failures += 1;
    console.error('FAIL:', label, extra);
  } else {
    console.log('ok:', label);
  }
}

const db = await openDb('/tmp/rat-test-data');
const id = createZipRepo(db, { name: 'scratch', source: 'scratch.zip', zipPath: '/tmp/scratch.zip' });

let repo;
for (let i = 0; i < 200; i++) {
  repo = getRepo(db, id);
  if (repo.status === 'ready' || repo.status === 'error') break;
  await new Promise((r) => setTimeout(r, 100));
}
console.log('repo status:', repo.status, repo.error || '');
assert(repo.status === 'ready', 'zip ingestion completes');

// Expected (hand-computed): 7 non-merge commits, added=24, removed=2, churn=26, growth=22
const dash = getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, '') });
console.log('set:', JSON.stringify(dash.set), 'object:', JSON.stringify(dash.object));
assert(dash.set.size === 7, '|H| = 7', `got ${dash.set.size}`);
assert(dash.object.added === 24, 'root added = 24', `got ${dash.object.added}`);
assert(dash.object.removed === 2, 'root removed = 2', `got ${dash.object.removed}`);
assert(dash.object.churn === 26, 'root churn = 26', `got ${dash.object.churn}`);
assert(dash.object.growth === 22, 'root growth = 22', `got ${dash.object.growth}`);
assert(dash.object.modifications === 7, 'root modifications = 7', `got ${dash.object.modifications}`);
assert(Math.abs(dash.object.modificationFrequency - 1) < 1e-9, 'mod freq = 1');
assert(Math.abs(dash.object.churnRate - 26 / 7) < 1e-9, 'churn rate = 26/7');

// dir scope: docs -> added 1 (A), removed 1 (B): growth 0, churn 2, mods 2
const docs = getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, 'docs') });
assert(
  docs.object.added === 1 && docs.object.removed === 1,
  'docs dir added=1 removed=1',
  JSON.stringify(docs.object)
);
assert(docs.object.growth === 0 && docs.object.churn === 2, 'docs dir growth=0 churn=2');

// file scope: rename+edit attributed to the NEW path
const renamed = getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, 'src/renamed_edited.txt') });
assert(renamed.object.added === 1 && renamed.object.removed === 0, 'rename+edit -> new path added=1 removed=0', JSON.stringify(renamed.object));

// dir children of root: 'src' recursive sum: A:+2 (src/moved.txt), B:+1 (renamed dst) -> added 3
const srcChild = dash.directories.items.find((c) => c.name === 'src');
assert(srcChild && srcChild.isDir === true, 'src listed as dir child');
assert(srcChild && srcChild.added === 3, 'src dir added = 3 (recursive)', JSON.stringify(srcChild));

// file children of root include pure-rename dst path 'c.txt' with 0 changes
const cTxt = dash.files.items.find((f) => f.name === 'c.txt');
assert(!!cTxt, 'pure rename dst path (c.txt) visible in file list');
assert(cTxt && cTxt.churn === 0, 'pure rename contributes zero churn');

// author merging via mailmap: all commits -> alice@new.com
const authors = listAuthors(db, id);
console.log('authors:', JSON.stringify(authors));
assert(
  authors.length === 1 && authors[0].key === 'alice@new.com',
  'mailmap merged alice@old.com -> alice@new.com'
);

// manual hash selection
const commits = listCommitsPage(db, id, { limit: 100, offset: 0 });
assert(commits.total === 7, 'commit list shows 7', `got ${commits.total}`);
const subset = [commits.items[0].hash, commits.items[1].hash];
const dash2 = getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, ''), hashes: subset });
assert(dash2.set.size === 2, 'manual hash selection |H|=2', `got ${dash2.set.size}`);

// manual merge/unmerge APIs run cleanly
const merged = mergeAuthors(db, id, ['alice@new.com'], 'alice@new.com');
assert(merged.length === 1, 'merge idempotent');
const unmerged = unmergeAuthors(db, id, 'alice@new.com');
assert(unmerged.length === 1, 'unmerge ok');

// timeseries generated
assert(Array.isArray(dash.timeseries) && dash.timeseries.length > 0, 'timeseries generated');

console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
