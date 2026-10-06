import { listAuthors } from './metrics.js';

/**
 * Manual author merging.
 *
 * Mailmap merging is already applied by git itself (%aN/%aE in the log
 * format). Manual merges map additional author emails onto a canonical key;
 * every metric query resolves identity as
 * COALESCE(author_merge.canonical, commits.author_email).
 */

/** Pick the member with the most commits as the default canonical identity. */
function defaultCanonical(db, repoId, emails) {
  let best = emails[0];
  let bestN = -1;
  const stmt = db.prepare(
    `SELECT COALESCE(am.canonical, h.author_email) AS key, COUNT(*) AS n
     FROM commits h
     LEFT JOIN author_merge am ON am.repo_id = h.repo_id AND am.email = h.author_email
     WHERE h.repo_id = ? AND h.author_email = ?
     GROUP BY key`
  );
  for (const email of emails) {
    const row = stmt.get(repoId, email);
    const n = row ? row.n : 0;
    if (n > bestN) {
      bestN = n;
      best = email;
    }
  }
  return best;
}

/**
 * Merge the given author emails into one canonical key.
 * @returns the refreshed author list.
 */
export function mergeAuthors(db, repoId, emails, canonical) {
  const clean = [...new Set(emails.map((e) => String(e || '').trim()).filter(Boolean))];
  if (clean.length < 1) throw new BadRequest('Provide at least one author email to merge');
  let target = canonical ? String(canonical).trim() : defaultCanonical(db, repoId, clean);
  if (!clean.includes(target)) clean.push(target);
  // If the chosen canonical is itself merged into another key, follow it.
  const existing = db
    .prepare('SELECT canonical FROM author_merge WHERE repo_id = ? AND email = ?')
    .get(repoId, target);
  if (existing) target = existing.canonical;

  const upsert = db.prepare(
    `INSERT INTO author_merge(repo_id, email, canonical) VALUES (?, ?, ?)
     ON CONFLICT(repo_id, email) DO UPDATE SET canonical = excluded.canonical`
  );
  const tx = db.transaction(() => {
    for (const email of clean) {
      if (email !== target) upsert.run(repoId, email, target);
    }
  });
  tx();
  db.save();
  return listAuthors(db, repoId);
}

/**
 * Unmerge an author. If the email is a canonical key with members, the whole
 * group is dissolved; otherwise only that email's mapping is removed.
 * @returns the refreshed author list.
 */
export function unmergeAuthors(db, repoId, email) {
  const clean = String(email || '').trim();
  if (!clean) throw new BadRequest('Provide the author email to unmerge');
  db.prepare('DELETE FROM author_merge WHERE repo_id = ? AND (email = ? OR canonical = ?)').run(
    repoId,
    clean,
    clean
  );
  db.save();
  return listAuthors(db, repoId);
}

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}
