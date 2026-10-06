import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

/**
 * Minimal storage adapter that mimics the subset of the better-sqlite3 API
 * used by RAT, backed by sql.js (SQLite compiled to WebAssembly).
 *
 * Why: sql.js is pure JavaScript/WASM - `npm install` never needs a C
 * toolchain or prebuilt binaries, so the app runs on any machine with
 * plain Node. It is still real SQLite, so the metric SQL is unchanged.
 *
 * Supported surface:
 *   db.exec(sql)                     - run multiple statements (schema)
 *   db.pragma(str)                   - accepted, WAL is emulated by save()
 *   db.prepare(sql)                  - { run, get, all }
 *   db.transaction(fn)               - BEGIN/COMMIT/ROLLBACK wrapper
 *   db.export() / db.save(file)      - persist the database image to disk
 *   db.close()
 * Named (@x), positional (?) and bare (x) parameter binding is supported.
 */

function toBindValues(args) {
  if (args.length === 0) return undefined;
  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === 'object') {
    const bound = {};
    for (const [k, v] of Object.entries(first)) bound[`@${k}`] = v;
    return bound;
  }
  return args;
}

class Statement {
  constructor(sqlDb, sql) {
    this.sqlDb = sqlDb;
    this.sql = sql;
  }

  run(...args) {
    const stmt = this.sqlDb.prepare(this.sql);
    try {
      const bound = toBindValues(args);
      if (bound !== undefined) stmt.bind(bound);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = this.sqlDb.getRowsModified();
    let lastInsertRowid = 0;
    if (/insert/i.test(this.sql)) {
      const res = this.sqlDb.exec('SELECT last_insert_rowid() AS id');
      lastInsertRowid = res.length ? Number(res[0].values[0][0]) : 0;
    }
    return { changes, lastInsertRowid };
  }

  get(...args) {
    const stmt = this.sqlDb.prepare(this.sql);
    try {
      const bound = toBindValues(args);
      if (bound !== undefined) stmt.bind(bound);
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = this.sqlDb.prepare(this.sql);
    const rows = [];
    try {
      const bound = toBindValues(args);
      if (bound !== undefined) stmt.bind(bound);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

export class SqliteAdapter {
  constructor(sqlDb, filePath) {
    this.sqlDb = sqlDb;
    this.filePath = filePath;
    this.dirty = false;
  }

  exec(sql) {
    if (/\b(begin|commit|rollback)\b/i.test(sql)) {
      // sql.js does not allow BEGIN inside implicit transactions it manages
      this.sqlDb.exec(sql);
      return;
    }
    this.sqlDb.exec(sql);
    this.dirty = true;
  }

  pragma(_str) {
    /* no-op: journal modes do not apply to the in-memory database */
  }

  prepare(sql) {
    return new Statement(this.sqlDb, sql);
  }

  transaction(fn) {
    const wrapped = (...args) => {
      this.sqlDb.exec('BEGIN');
      try {
        const result = fn(...args);
        this.sqlDb.exec('COMMIT');
        this.dirty = true;
        return result;
      } catch (err) {
        try {
          this.sqlDb.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    };
    return wrapped;
  }

  export() {
    return this.sqlDb.export();
  }

  save(file = this.filePath) {
    const data = Buffer.from(this.sqlDb.export());
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    this.dirty = false;
  }

  close() {
    this.sqlDb.close();
  }
}

/** Open (or create) the RAT database at <dataDir>/rat.db. */
export async function openDb(dataDir) {
  const SQL = await initSqlJs();
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'rat.db');
  let sqlDb;
  if (fs.existsSync(filePath)) {
    sqlDb = new SQL.Database(fs.readFileSync(filePath));
  } else {
    sqlDb = new SQL.Database();
  }
  return new SqliteAdapter(sqlDb, filePath);
}
