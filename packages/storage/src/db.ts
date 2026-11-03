import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type SqlParam = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  private inTx = false;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(m.sql);
        this.stmt('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString(),
        );
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  stmt(sql: string) {
    return this.raw.prepare(sql);
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** 同步事务; 内部使用 BEGIN IMMEDIATE 以获得写锁。支持嵌套调用(复用外层事务)。 */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
  }
}
