import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteRepo, getRepo, listRepos, openDb, publicRepo, updateRepo } from './db.js';
import { createCloneRepo, createZipRepo, DATA_DIR, UPLOADS_DIR } from './ingest.js';
import { mergeAuthors, unmergeAuthors, BadRequest } from './authors.js';
import { getDashboard, listCommitsPage, listAuthors, resolveScope, suggestPaths } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GiB

const ACTIVE_STATUSES = ['queued', 'cloning', 'extracting', 'parsing', 'indexing'];

function sanitizeName(raw, fallback = 'repository') {
  const name = String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/]/g, '-')
    .trim()
    .slice(0, 80);
  return name || fallback;
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function intParam(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function main() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const db = await openDb(DATA_DIR);

  // Mark ingests interrupted by a server restart as failed.
  if (db.prepare(`UPDATE repos SET status = 'error', error = 'Ingestion interrupted (server restarted)' WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`).run(...ACTIVE_STATUSES).changes > 0) {
    db.save();
  }

  // Persist the database image on graceful shutdown.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        db.save();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: UPLOADS_DIR,
      filename: (_req, file, cb) =>
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.zip`),
    }),
    limits: { fileSize: MAX_UPLOAD },
  });

  const requireRepo = (req, res) => {
    const repo = getRepo(db, Number(req.params.id));
    if (!repo) {
      res.status(404).json({ error: `Repository ${req.params.id} not found` });
      return null;
    }
    if (repo.status !== 'ready' && !req.allowPending) {
      res.status(409).json({
        error: `Repository is ${repo.status}${repo.error ? `: ${repo.error}` : ''}`,
        repo: publicRepo(repo),
      });
      return null;
    }
    return repo;
  };

  // ---------------------------------------------------------------- repos
  app.post('/api/repos/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError
            ? `Upload failed: ${err.message}`
            : `Upload failed: ${err.message || 'unknown error'}`;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No zip file received (expected multipart field "file")' });
      }
      const name = sanitizeName(
        req.body.name || path.basename(req.file.originalname || 'repository', '.zip')
      );
      const id = createZipRepo(db, {
        name,
        source: req.file.originalname || name,
        zipPath: req.file.path,
      });
      res.status(202).json(publicRepo(getRepo(db, id)));
    });
  });

  app.post('/api/repos/clone', (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'A repository URL is required' });
    if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) {
      return res
        .status(400)
        .json({ error: 'Invalid remote URL - expected an http(s):// or git@/ssh:// git remote' });
    }
    const name = sanitizeName(
      req.body?.name || url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '')
    );
    const id = createCloneRepo(db, { name, url });
    res.status(202).json(publicRepo(getRepo(db, id)));
  });

  app.get('/api/repos', (_req, res) => {
    res.json(listRepos(db).map(publicRepo));
  });

  app.get('/api/repos/:id', (req, res) => {
    req.allowPending = true;
    const repo = requireRepo(req, res);
    if (repo) res.json(publicRepo(repo));
  });

  app.delete('/api/repos/:id', (req, res) => {
    req.allowPending = true;
    const repo = requireRepo(req, res);
    if (!repo) return;
    if (ACTIVE_STATUSES.includes(repo.status)) {
      return res
        .status(409)
        .json({ error: 'Cannot delete a repository while it is being ingested' });
    }
    deleteRepo(db, repo.id);
    db.save();
    fs.rm(repo.dir, { recursive: true, force: true }, () => res.json({ ok: true }));
  });

  // -------------------------------------------------------------- authors
  app.get('/api/repos/:id/authors', (req, res) => {
    const repo = requireRepo(req, res);
    if (repo) res.json(listAuthors(db, repo.id));
  });

  app.post('/api/repos/:id/authors/merge', (req, res) => {
    const repo = requireRepo(req, res);
    if (!repo) return;
    try {
      res.json(mergeAuthors(db, repo.id, csv(req.body?.emails), req.body?.canonical));
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.post('/api/repos/:id/authors/unmerge', (req, res) => {
    const repo = requireRepo(req, res);
    if (!repo) return;
    try {
      res.json(unmergeAuthors(db, repo.id, req.body?.email));
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  // ------------------------------------------------- paths / commits / metrics
  app.get('/api/repos/:id/paths', (req, res) => {
    const repo = requireRepo(req, res);
    if (!repo) return;
    const q = String(req.query.q || '').replace(/^\/+|\/+$/g, '').slice(0, 200);
    res.json(suggestPaths(db, repo.id, q, intParam(req.query.limit, 25, 1, 100)));
  });

  app.get('/api/repos/:id/commits', (req, res) => {
    const repo = requireRepo(req, res);
    if (!repo) return;
    const result = listCommitsPage(db, repo.id, {
      q: String(req.query.q || '').trim().slice(0, 100) || null,
      from: intParam(req.query.from, null, 0, Number.MAX_SAFE_INTEGER),
      to: intParam(req.query.to, null, 0, Number.MAX_SAFE_INTEGER),
      authors: csv(req.query.authors).slice(0, 100),
      limit: intParam(req.query.limit, 100, 1, 500),
      offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    });
    res.json(result);
  });

  app.get('/api/repos/:id/metrics', (req, res) => {
    const repo = requireRepo(req, res);
    if (!repo) return;
    const scope = resolveScope(db, repo.id, String(req.query.path || ''));
    if (!scope) {
      return res.status(400).json({ error: `Unknown path: ${req.query.path}` });
    }
    const hashes = csv(req.query.hashes);
    if (hashes.length > 20000) {
      return res.status(400).json({ error: 'Too many commits selected (max 20000)' });
    }
    const dashboard = getDashboard(
      db,
      repo.id,
      {
        repoId: repo.id,
        scope,
        authors: csv(req.query.authors).slice(0, 500),
        from: intParam(req.query.from, null, 0, Number.MAX_SAFE_INTEGER),
        to: intParam(req.query.to, null, 0, Number.MAX_SAFE_INTEGER),
        hashes,
      },
      {
        sort: String(req.query.sort || 'churn'),
        dir: String(req.query.dir || 'desc'),
        limit: intParam(req.query.limit, 50, 1, 500),
        offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      }
    );
    res.json(dashboard);
  });

  // ------------------------------------------------------------ frontend
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  // ------------------------------------------------------------- errors
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[rat] error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[rat] Repo Analysis Tool listening on http://localhost:${PORT}`);
    console.log(`[rat] data directory: ${DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error('[rat] failed to start:', err);
  process.exit(1);
});
