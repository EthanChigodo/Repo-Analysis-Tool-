/**
 * RAT verification suite (`npm test`).
 *
 * Builds a synthetic repository covering every tricky case in the brief,
 * ingests it through BOTH paths (zip upload and clone), and asserts the
 * metrics against hand-computed values.
 *
 * Synthetic history (committer dates are spaced 1000s apart from T0):
 *
 *  C1  T0+0    Alice Old  <alice@old.com>   add src/app.py(5), docs/readme.md(2),
 *                                           lib/util.py(3), empty.txt(0), bin.dat(binary)
 *  C2  T0+1000 Bob        <bob@dev.io>      edit src/app.py +3/-1, delete docs/readme.md,
 *                                           add .gitignore(1)
 *  C3  T0+2000 Alice New  <alice@new.com>   pure rename lib/util.py -> lib/helpers.py,
 *                                           rename+edit src/app.py -> src/main.py (+2)
 *  C4  T0+3000 Carol      <carol@dev.io>    (branch feature, off C1) add feature/f.txt(2)
 *  C5  T0+4000 Alice New  <alice@new.com>   add root.txt(1)
 *  C6  T0+5000 merge feature into main (merge commit - excluded from H-bar)
 *  C7  T0+6000 Bob        <bob@dev.io>      add .mailmap(Alice old -> new),
 *                                           edit lib/helpers.py +1/-2
 *
 * Expected over H-bar (6 non-merge commits reachable from HEAD):
 *   added=21 removed=5 churn=26 growth=16 modifications=6
 *   authors after mailmap: alice@new.com(3 commits, churn 13), bob@dev.io(2, 11),
 *                          carol@dev.io(1, 2)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, '.test-data');

process.env.RAT_DATA_DIR = path.join(TEST_DIR, 'rat-data');
fs.rmSync(TEST_DIR, { recursive: true, force: true });

const { openDb, getRepo } = await import(path.join(ROOT, 'server/db.js'));
const { createZipRepo, createCloneRepo } = await import(path.join(ROOT, 'server/ingest.js'));
const {
  getDashboard,
  listAuthors,
  listCommitsPage,
  resolveScope,
  suggestPaths,
} = await import(path.join(ROOT, 'server/metrics.js'));
const { mergeAuthors, unmergeAuthors } = await import(path.join(ROOT, 'server/authors.js'));

let failures = 0;
let checks = 0;
function assert(cond, label, extra = '') {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  FAIL:', label, extra);
  } else {
    console.log('  ok:', label);
  }
}
function eq(actual, expected, label) {
  assert(
    actual === expected,
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}
function near(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-9, `${label} (expected ~${expected}, got ${actual})`);
}

const T0 = 1600000000;
function git(dir, args, env = {}) {
  const res = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: TEST_DIR, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function commit(dir, message, when, name, email) {
  git(
    dir,
    ['commit', '-m', message],
    {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: `${when} +0000`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: `${when} +0000`,
    }
  );
  return git(dir, ['rev-parse', 'HEAD']);
}

function buildSyntheticRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(TEST_DIR, '.gitconfig'), '');

  // C1 - Alice Old
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/app.py'), 'l1\nl2\nl3\nl4\nl5\n');
  fs.writeFileSync(path.join(repoDir, 'docs/readme.md'), 'd1\nd2\n');
  fs.writeFileSync(path.join(repoDir, 'lib/util.py'), 'b1\nb2\nb3\n');
  fs.writeFileSync(path.join(repoDir, 'empty.txt'), '');
  fs.writeFileSync(path.join(repoDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
  git(repoDir, ['add', '-A']);
  const c1 = commit(repoDir, 'C1 initial', T0, 'Alice Old', 'alice@old.com');

  // C2 - Bob
  fs.writeFileSync(path.join(repoDir, 'src/app.py'), 'l1\nl2a\nl2b\nl2c\nl3\nl4\nl5\n');
  fs.rmSync(path.join(repoDir, 'docs/readme.md'));
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules\n');
  git(repoDir, ['add', '-A']);
  const c2 = commit(repoDir, 'C2 bob edits', T0 + 1000, 'Bob', 'bob@dev.io');

  // C3 - Alice New: pure rename + rename-with-edit
  git(repoDir, ['mv', 'lib/util.py', 'lib/helpers.py']);
  git(repoDir, ['mv', 'src/app.py', 'src/main.py']);
  fs.appendFileSync(path.join(repoDir, 'src/main.py'), 'l6\nl7\n');
  git(repoDir, ['add', '-A']);
  const c3 = commit(repoDir, 'C3 renames', T0 + 2000, 'Alice New', 'alice@new.com');

  // C4 - Carol on a feature branch off C1
  git(repoDir, ['checkout', '-q', '-b', 'feature', c1]);
  fs.mkdirSync(path.join(repoDir, 'feature'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'feature/f.txt'), 'f1\nf2\n');
  git(repoDir, ['add', '-A']);
  const c4 = commit(repoDir, 'C4 feature', T0 + 3000, 'Carol', 'carol@dev.io');

  // C5 - Alice New on main
  git(repoDir, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repoDir, 'root.txt'), 'r1\n');
  git(repoDir, ['add', '-A']);
  const c5 = commit(repoDir, 'C5 root file', T0 + 4000, 'Alice New', 'alice@new.com');

  // C6 - merge (must be excluded from H-bar)
  git(
    repoDir,
    ['merge', '-q', '--no-ff', 'feature', '-m', 'C6 merge feature'],
    {
      GIT_AUTHOR_NAME: 'Alice New',
      GIT_AUTHOR_EMAIL: 'alice@new.com',
      GIT_AUTHOR_DATE: `${T0 + 5000} +0000`,
      GIT_COMMITTER_NAME: 'Alice New',
      GIT_COMMITTER_EMAIL: 'alice@new.com',
      GIT_COMMITTER_DATE: `${T0 + 5000} +0000`,
    }
  );

  // C7 - Bob: .mailmap + helpers edit
  fs.writeFileSync(
    path.join(repoDir, '.mailmap'),
    'Alice New <alice@new.com> Alice Old <alice@old.com>\n'
  );
  fs.writeFileSync(path.join(repoDir, 'lib/helpers.py'), 'b1\nb4\n');
  git(repoDir, ['add', '-A']);
  const c7 = commit(repoDir, 'C7 mailmap + helpers', T0 + 6000, 'Bob', 'bob@dev.io');

  return { c1, c2, c3, c4, c5, c7 };
}

function zipDir(srcDir, outZip) {
  // Python's shutil is used to avoid a native zip dependency.
  const res = spawnSync(
    'python3',
    [
      '-c',
      `import shutil; shutil.make_archive(${JSON.stringify(outZip.replace(/\.zip$/, ''))}, 'zip', ${JSON.stringify(srcDir)})`,
    ],
    { encoding: 'utf8' }
  );
  if (res.status !== 0 || !fs.existsSync(outZip)) {
    throw new Error(`failed to zip: ${res.stderr}`);
  }
}

async function waitForReady(db, repoId) {
  for (let i = 0; i < 600; i++) {
    const repo = getRepo(db, repoId);
    if (repo.status === 'ready' || repo.status === 'error') return repo;
    await new Promise((r) => setTimeout(r, 100));
  }
  return getRepo(db, repoId);
}

/** All metric assertions for one ingested repository. */
function runMetricAssertions(db, id, hashes) {
  const root = resolveScope(db, id, '');
  const dash = getDashboard(db, id, { repoId: id, scope: root });
  eq(dash.set.size, 6, '|H| (merge commit excluded)');
  eq(dash.object.added, 21, 'root added');
  eq(dash.object.removed, 5, 'root removed');
  eq(dash.object.growth, 16, 'root growth');
  eq(dash.object.churn, 26, 'root churn');
  eq(dash.object.modifications, 6, 'root modifications');
  near(dash.object.modificationFrequency, 1, 'root modification frequency');
  near(dash.object.churnRate, 26 / 6, 'root churn rate');

  // repository metrics == directory metrics on the root (identical object here)
  const dirs = Object.fromEntries(dash.directories.items.map((d) => [d.name, d]));
  eq(dirs.src.added, 10, 'dir src added');
  eq(dirs.src.removed, 1, 'dir src removed');
  eq(dirs.src.churn, 11, 'dir src churn');
  eq(dirs.src.modifications, 3, 'dir src modifications');
  eq(dirs.lib.added, 4, 'dir lib added (pure rename + edit)');
  eq(dirs.lib.removed, 2, 'dir lib removed');
  eq(dirs.lib.modifications, 2, 'dir lib modifications (pure rename not counted)');
  eq(dirs.docs.added, 2, 'dir docs added');
  eq(dirs.docs.removed, 2, 'dir docs removed');
  eq(dirs.docs.growth, 0, 'dir docs growth');
  eq(dirs.docs.churn, 4, 'dir docs churn');
  eq(dirs.feature.added, 2, 'dir feature added');

  // file metrics: assert within each parent directory scope (the files table
  // lists immediate children of the current scope)
  const srcFiles = Object.fromEntries(
    getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, 'src') }).files.items.map((f) => [f.name, f])
  );
  eq(srcFiles['app.py'].added, 8, 'file src/app.py added (kept on its old path)');
  eq(srcFiles['app.py'].removed, 1, 'file src/app.py removed');
  eq(srcFiles['app.py'].modifications, 2, 'file src/app.py modifications');
  eq(srcFiles['main.py'].added, 2, 'file src/main.py added (rename+edit -> new path)');
  eq(srcFiles['main.py'].removed, 0, 'file src/main.py removed');
  const libFiles = Object.fromEntries(
    getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, 'lib') }).files.items.map((f) => [f.name, f])
  );
  eq(libFiles['util.py'].added, 3, 'file lib/util.py added');
  eq(libFiles['util.py'].removed, 0, 'file lib/util.py removed (rename does not remove)');
  eq(libFiles['helpers.py'].added, 1, 'file lib/helpers.py added');
  eq(libFiles['helpers.py'].removed, 2, 'file lib/helpers.py removed');
  const docsFiles = Object.fromEntries(
    getDashboard(db, id, { repoId: id, scope: resolveScope(db, id, 'docs') }).files.items.map((f) => [f.name, f])
  );
  eq(docsFiles['readme.md'].churn, 4, 'file docs/readme.md churn (add+delete)');
  eq(docsFiles['readme.md'].modifications, 2, 'file docs/readme.md modifications');
  const filesRoot = Object.fromEntries(dash.files.items.map((f) => [f.name, f]));
  assert('empty.txt' in filesRoot, 'empty file listed');
  eq(filesRoot['empty.txt'].churn, 0, 'empty file churn 0');
  assert(!('bin.dat' in filesRoot), 'binary file not measured');

  // authors (mailmap merged Alice into alice@new.com)
  const authorsDash = getDashboard(db, id, { repoId: id, scope: root }).authors;
  const byKey = Object.fromEntries(authorsDash.map((a) => [a.key, a]));
  assert('alice@new.com' in byKey, 'mailmap applied: alice@new.com present');
  assert(!('alice@old.com' in byKey), 'mailmap applied: alice@old.com merged away');
  assert(authorsDash.length === 3, 'exactly 3 authors after mailmap', JSON.stringify(Object.keys(byKey)));
  eq(byKey['alice@new.com'].churn, 13, 'alice churn');
  eq(byKey['alice@new.com'].commits, 3, 'alice commits');
  eq(byKey['alice@new.com'].modifications, 3, 'alice modifications');
  near(byKey['alice@new.com'].ownership, 13 / 26, 'alice ownership');
  eq(byKey['bob@dev.io'].churn, 11, 'bob churn');
  near(byKey['bob@dev.io'].ownership, 11 / 26, 'bob ownership');
  eq(byKey['carol@dev.io'].commits, 1, 'carol commits');
  near(byKey['carol@dev.io'].ownership, 2 / 26, 'carol ownership');

  // commit-set metrics: time period [T0+2500, present) -> C4, C5, C7
  const period = getDashboard(db, id, {
    repoId: id,
    scope: root,
    from: T0 + 2500,
  });
  eq(period.set.size, 3, '|H| for time period');
  eq(period.object.added, 5, 'time period added');
  eq(period.object.removed, 2, 'time period removed');
  eq(period.object.churn, 7, 'time period churn');

  // commit-set metrics: range [T0+1000, T0+4000) -> C2, C3, C4
  const range = getDashboard(db, id, {
    repoId: id,
    scope: root,
    from: T0 + 1000,
    to: T0 + 4000,
  });
  eq(range.set.size, 3, '|H| for half-open range');
  eq(range.object.added, 8, 'range added');
  eq(range.object.removed, 3, 'range removed');

  // commit-set metrics: manual commit list [C1, C7]
  const manual = getDashboard(db, id, {
    repoId: id,
    scope: root,
    hashes: [hashes.c1, hashes.c7],
  });
  eq(manual.set.size, 2, '|H| for manual selection');
  eq(manual.object.added, 12, 'manual selection added');
  eq(manual.object.removed, 2, 'manual selection removed');

  // author filter: alice only
  const aliceOnly = getDashboard(db, id, {
    repoId: id,
    scope: root,
    authors: ['alice@new.com'],
  });
  eq(aliceOnly.set.size, 3, '|H| filtered by author');
  eq(aliceOnly.object.churn, 13, 'author-filtered churn');
  eq(aliceOnly.authors.length, 1, 'single author in filtered authors');
  near(aliceOnly.authors[0].ownership, 1, 'ownership 1.0 when single author');

  // directory scope drill-down: src
  const srcScope = resolveScope(db, id, 'src');
  const srcDash = getDashboard(db, id, { repoId: id, scope: srcScope });
  eq(srcDash.object.added, 10, 'src scope added');
  eq(srcDash.object.removed, 1, 'src scope removed');
  eq(srcDash.object.modifications, 3, 'src scope modifications');

  // file scope
  const fileScope = resolveScope(db, id, 'lib/helpers.py');
  const fileDash = getDashboard(db, id, { repoId: id, scope: fileScope });
  eq(fileDash.object.added, 1, 'file scope added');
  eq(fileDash.object.removed, 2, 'file scope removed');

  // path autocomplete
  const sugg = suggestPaths(db, id, 'src', 25).map((p) => p.path);
  assert(sugg.includes('src'), 'paths suggest: dir src');
  assert(sugg.includes('src/app.py'), 'paths suggest: src/app.py');
  assert(sugg.includes('src/main.py'), 'paths suggest: src/main.py');

  // commit list + timeseries consistency
  const commits = listCommitsPage(db, id, { limit: 100, offset: 0 });
  eq(commits.total, 6, 'commit list size');
  const tsAdded = dash.timeseries.reduce((a, b) => a + b.added, 0);
  const tsRemoved = dash.timeseries.reduce((a, b) => a + b.removed, 0);
  eq(tsAdded, 21, 'timeseries added sums to total');
  eq(tsRemoved, 5, 'timeseries removed sums to total');

  return { dash };
}

// --------------------------------------------------------------------- run
console.log('building synthetic repository...');
const repoDir = path.join(TEST_DIR, 'synthetic-repo');
const hashes = buildSyntheticRepo(repoDir);

const db = await openDb(process.env.RAT_DATA_DIR);

console.log('[1/3] zip ingestion path');
let zipPath = path.join(TEST_DIR, 'synthetic-repo.zip');
zipDir(repoDir, zipPath);
const zipRepoId = createZipRepo(db, {
  name: 'synthetic-zip',
  source: 'synthetic-repo.zip',
  zipPath,
});
const zipRepo = await waitForReady(db, zipRepoId);
eq(zipRepo.status, 'ready', `zip ingestion ready ${zipRepo.error || ''}`);
eq(zipRepo.commit_count, 6, 'zip ingestion commit count');
runMetricAssertions(db, zipRepoId, hashes);

console.log('[2/3] clone ingestion path (local remote)');
const cloneRepoId = createCloneRepo(db, { name: 'synthetic-clone', url: repoDir });
const cloneRepo = await waitForReady(db, cloneRepoId);
eq(cloneRepo.status, 'ready', `clone ingestion ready ${cloneRepo.error || ''}`);
runMetricAssertions(db, cloneRepoId, hashes);

console.log('[3/3] manual author merge/unmerge');
const merged = mergeAuthors(db, zipRepoId, ['bob@dev.io', 'carol@dev.io']);
eq(merged.length, 2, 'authors after manual merge');
const mergedDash = getDashboard(db, zipRepoId, { repoId: zipRepoId, scope: resolveScope(db, zipRepoId, '') });
const mergedByKey = Object.fromEntries(mergedDash.authors.map((a) => [a.key, a]));
assert(
  mergedByKey['bob@dev.io'] && mergedByKey['bob@dev.io'].churn === 13,
  'merged author churn aggregated',
  JSON.stringify(mergedByKey)
);
eq(mergedByKey['bob@dev.io'].commits, 3, 'merged author commit count');
const unmerged = unmergeAuthors(db, zipRepoId, 'bob@dev.io');
eq(unmerged.length, 3, 'authors restored after unmerge');

// error path: bad zip (no .git)
const bogusZip = path.join(TEST_DIR, 'bogus.zip');
fs.mkdirSync(path.join(TEST_DIR, 'bogus'), { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, 'bogus/readme.txt'), 'not a repo');
zipDir(path.join(TEST_DIR, 'bogus'), bogusZip);
const badId = createZipRepo(db, { name: 'bogus', source: 'bogus.zip', zipPath: bogusZip });
const badRepo = await waitForReady(db, badId);
eq(badRepo.status, 'error', 'zip without .git reported as error');
assert(!!badRepo.error, 'error message present', badRepo.error || '');

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log(
  failures === 0
    ? `\nVERIFY PASS (${checks} checks)`
    : `\nVERIFY FAIL (${failures}/${checks} checks failed)`
);
process.exit(failures === 0 ? 0 : 1);
