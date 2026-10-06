import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Git engine.
 *
 * Metric semantics implemented here (see brief §2):
 *  - Only NON-MERGE commits reachable from HEAD are measured (H-bar).
 *  - numstat diff is taken against the first parent; the initial commit diffs
 *    against the empty tree (h[p] = h-empty).
 *  - Rename detection is enabled with a 50% similarity threshold (-M50%).
 *    A pure rename contributes 0/0 (metrics unchanged); edits on a renamed
 *    object are attributed to the NEW path; deletions are recorded as removed
 *    lines on the old path.
 *  - Binary files are not measured (numstat reports "-").
 *
 * Parsing uses `git log --numstat -z` with NUL-terminated records:
 *   \x02<hash>\x01<parents>\x01<aN>\x01<aE>\x01<ct>\x01<subject>\0
 *   <added>\t<removed>\t<path>\0                     (regular entry)
 *   <added>\t<removed>\t\0<src-path>\0<dst-path>\0   (rename entry)
 *   "-" means binary -> skipped.
 * %aN / %aE apply the repository .mailmap automatically.
 */

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
  }
}

function run(args, { cwd, onStderr, collect } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (onStderr) onStderr(d.toString());
    });
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(collect ? stdout : undefined);
      else {
        const msg = stderr.trim().split('\n')[0] || `git ${args[0]} exited with code ${code}`;
        reject(new GitError(msg));
      }
    });
  });
}

/** Depth-first search for the .git directory (or bare-repo layout) under root. */
export function locateGit(root) {
  const direct = path.join(root, '.git');
  if (fs.existsSync(direct)) {
    const st = fs.statSync(direct);
    if (st.isDirectory()) {
      return { gitDir: direct, workDir: root };
    }
    // .git file (worktree): "gitdir: <path>"
    const content = fs.readFileSync(direct, 'utf8');
    const m = content.match(/gitdir:\s*(.+)/);
    if (m) {
      const target = path.resolve(root, m[1].trim());
      if (fs.existsSync(target)) return { gitDir: target, workDir: root };
    }
    throw new GitError('Found a .git file but could not resolve its gitdir target');
  }
  // Zip root may be a bare repository (HEAD/objects/refs at top level)
  if (
    fs.existsSync(path.join(root, 'HEAD')) &&
    fs.existsSync(path.join(root, 'objects')) &&
    fs.existsSync(path.join(root, 'refs'))
  ) {
    return { gitDir: root, workDir: root };
  }
  // Otherwise look one level deep for a repo folder containing .git
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inner = path.join(root, entry.name, '.git');
    if (fs.existsSync(inner)) {
      if (fs.statSync(inner).isDirectory()) {
        return { gitDir: inner, workDir: path.join(root, entry.name) };
      }
      const content = fs.readFileSync(inner, 'utf8');
      const m = content.match(/gitdir:\s*(.+)/);
      if (m) {
        const target = path.resolve(path.join(root, entry.name), m[1].trim());
        if (fs.existsSync(target)) {
          return { gitDir: target, workDir: path.join(root, entry.name) };
        }
      }
    }
  }
  throw new GitError(
    'No .git directory found in the provided repository. Zip uploads must contain the repository with its .git directory.'
  );
}

/** Total number of commits reachable from HEAD (for progress reporting). */
export function countCommits(gitDir) {
  return run(['--git-dir', gitDir, 'rev-list', '--count', 'HEAD'], { collect: true }).then((out) =>
    parseInt(out.trim(), 10)
  );
}

/**
 * Incremental, resumable parser for `git log --numstat -z` output.
 * Feed chunks via push(); completed commits are emitted via onCommit.
 */
export function createLogParser(onCommit) {
  let buf = Buffer.alloc(0);
  // token state: 'seek' (looking for \x02), 'header' (first token after \x02), 'entries'
  let stage = 'seek';
  let expectToken = false; // a token read is in progress (we saw content but no NUL yet)
  let commit = null;
  let meta = null; // [added, removed, rest] of the current numstat entry
  let renamePhase = 0; // 0 = not in rename; 1 = src expected; 2 = dst expected
  let renameSrc = '';
  let suppressNewline = false;

  function finishCommit() {
    if (commit) onCommit(commit);
    commit = null;
    meta = null;
    renamePhase = 0;
    suppressNewline = false;
  }

  function emitFile(a, r, p) {
    commit.files.push({ path: p, added: a, removed: r });
  }

  function handleToken(tokenStr) {
    if (stage === 'header') {
      const [hash, parents, authorName, authorEmail, date, subject] = tokenStr.split('\x01');
      commit = {
        hash,
        parent: parents ? parents.split(' ')[0] : null,
        authorName: authorName || '',
        authorEmail: authorEmail || '',
        date: parseInt(date, 10) || 0,
        subject: subject || '',
        files: [],
      };
      stage = 'entries';
      suppressNewline = true;
      return;
    }
    // entries stage
    if (suppressNewline) {
      suppressNewline = false;
      if (tokenStr.startsWith('\n')) tokenStr = tokenStr.slice(1);
      if (tokenStr === '') return; // empty commit: "\n" then next \x02 arrives as its own token
    }
    if (renamePhase === 1) {
      renameSrc = tokenStr;
      renamePhase = 2;
      return;
    }
    if (renamePhase === 2) {
      emitFile(parseInt(meta[0], 10), parseInt(meta[1], 10), tokenStr);
      renamePhase = 0;
      meta = null;
      return;
    }
    // meta token: "added\tremoved\trest"
    const t1 = tokenStr.indexOf('\t');
    if (t1 === -1) return; // ignore stray noise between records
    const t2 = tokenStr.indexOf('\t', t1 + 1);
    if (t2 === -1) return;
    const added = tokenStr.slice(0, t1);
    const removed = tokenStr.slice(t1 + 1, t2);
    const rest = tokenStr.slice(t2 + 1);
    if (added === '-' || removed === '-') return; // binary file: not measured
    if (rest === '') {
      // rename entry: an empty token, then src, then dst
      meta = [added, removed];
      renamePhase = 1;
      return;
    }
    emitFile(parseInt(added, 10), parseInt(removed, 10), rest);
  }

  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'seek') {
          const i = buf.indexOf(0x02);
          if (i === -1) {
            buf = Buffer.alloc(0);
            return;
          }
          buf = buf.subarray(i + 1);
          stage = 'header';
          expectToken = false;
        }
        // find the next token boundary: NUL terminator or a new \x02 record start
        const nul = buf.indexOf(0x00);
        const rec = buf.indexOf(0x02);
        if (!expectToken && (nul === -1 || (rec !== -1 && rec < nul))) {
          if (rec === -1) {
            // The chunk ended in the middle of a token. Keep every byte until
            // its NUL terminator arrives; long paths and subjects regularly
            // cross stream chunk boundaries.
            expectToken = buf.length > 0;
            return;
          }
          if (stage === 'entries') finishCommit();
          buf = buf.subarray(rec + 1);
          stage = 'header';
          expectToken = false;
          continue;
        }
        if (nul === -1) {
          expectToken = buf.length > 0;
          if (!expectToken) return;
          // wait for more data; keep the partial token buffered
          return;
        }
        const token = buf.subarray(0, nul).toString('utf8');
        buf = buf.subarray(nul + 1);
        expectToken = false;
        if (token.includes('\x02')) {
          // \x02 inside a token means the record boundary came first
          const idx = token.indexOf('\x02');
          const before = token.slice(0, idx);
          if (before !== '') handleToken(before);
          if (stage === 'entries') finishCommit();
          stage = 'header';
          const after = token.slice(idx + 1);
          if (after !== '') handleToken(after);
          continue;
        }
        handleToken(token);
      }
    },
    end() {
      // flush any trailing commit (git output normally ends with a NUL)
      const leftover = buf.toString('utf8');
      buf = Buffer.alloc(0);
      if (stage === 'entries' && leftover) {
        const cleaned = leftover.replace(/^\n/, '');
        if (cleaned) {
          const nul = cleaned.indexOf('\0');
          const token = nul === -1 ? cleaned : cleaned.slice(0, nul);
          handleToken(token);
        }
      }
      finishCommit();
      stage = 'seek';
    },
  };
}

/**
 * Stream the full history of a repository as metric records.
 * @param {string} gitDir path to the .git directory (or bare repo dir)
 * @param {string|null} workDir working tree containing .mailmap (zip ingestion)
 * @param {(commit:{hash,parent,authorName,authorEmail,date,subject,files:Array})=>void} onCommit
 * @returns {Promise<{commits:number}>}
 */
export async function streamHistory(gitDir, workDir, onCommit) {
  const args = [
    '--git-dir',
    gitDir,
    'log',
    '--no-merges', // H-bar: non-merge commits only
    '--numstat',
    '-M50%', // rename detection at 50% similarity
    '-z',
    '--format=%x02%H%x01%P%x01%aN%x01%aE%x01%ct%x01%s',
    'HEAD',
  ];
  const parser = createLogParser(onCommit);
  await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: workDir || undefined });
    child.stdout.on('data', (d) => parser.push(d));
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        parser.end();
        resolve();
      } else {
        reject(new GitError(stderr.trim().split('\n')[0] || `git log exited with code ${code}`));
      }
    });
  });
}

/**
 * Deep-clone a remote repository (bare: history only, no working tree).
 * onProgress receives 0..1 during the clone.
 */
export async function cloneRepo(url, destDir, onProgress) {
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--bare', '--progress', url, destDir]);
    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderrBuf += text;
      if (onProgress) {
        // Example: "Receiving objects:  42% (123/456)"
        const receiving = text.match(/Receiving objects:\s+(\d+)%/);
        const resolving = text.match(/Resolving deltas:\s+(\d+)%/);
        const updating = text.match(/Updating files:\s+(\d+)%/);
        if (receiving) onProgress(0.0 + (parseInt(receiving[1], 10) / 100) * 0.6);
        else if (resolving) onProgress(0.6 + (parseInt(resolving[1], 10) / 100) * 0.25);
        else if (updating) onProgress(0.85 + (parseInt(updating[1], 10) / 100) * 0.15);
      }
    });
    child.on('error', (err) => reject(new GitError(`git failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const lines = stderrBuf.trim().split('\n');
        const msg =
          lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1] || `git clone exited with code ${code}`;
        reject(new GitError(msg.replace(/^(fatal|error):\s*/i, '')));
      }
    });
  });
  // A bare clone has no working tree, so git cannot see a checked-in .mailmap.
  // Extract it from HEAD and register it via mailmap.file so author merging
  // via mailmap still works for cloned repositories.
  try {
    const mailmap = await run(['--git-dir', destDir, 'show', 'HEAD:.mailmap'], { collect: true });
    if (mailmap && mailmap.trim()) {
      const mailmapPath = path.join(destDir, '.rat-mailmap');
      fs.writeFileSync(mailmapPath, mailmap);
      await run(['--git-dir', destDir, 'config', 'mailmap.file', mailmapPath]);
    }
  } catch {
    /* no .mailmap in HEAD - manual merging remains available */
  }
}
