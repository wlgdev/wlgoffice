import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import logger from "../logger";

type KvRow = {
  value: string;
};

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class DB {
  private db: Database;
  private stmtGet: Statement<KvRow, [string]>;
  private stmtSet: Statement<unknown, [string, string]>;
  private stmtDelete: Statement<unknown, [string]>;

  constructor(dbPath: string = "db/db.sqlite") {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath, { create: true });
    this.migrate();

    this.stmtGet = this.db.prepare<KvRow, [string]>(`SELECT value FROM kv WHERE key = ?`);
    this.stmtSet = this.db.prepare<unknown, [string, string]>(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ${NOW})
      ON CONFLICT (key) DO UPDATE
        SET value = excluded.value,
            updated_at = excluded.updated_at
    `);
    this.stmtDelete = this.db.prepare<unknown, [string]>(`DELETE FROM kv WHERE key = ?`);
  }

  public migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (${NOW})
      );
    `);
  }

  public get(key: string): string | null {
    return this.stmtGet.get(key)?.value ?? null;
  }

  public set(key: string, value: string): void {
    this.stmtSet.run(key, value);
  }

  public delete(key: string): boolean {
    return this.stmtDelete.run(key).changes > 0;
  }

  public getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn(`[DB] Не удалось разобрать JSON по ключу "${key}":`, err);
      return null;
    }
  }

  public setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  public close(): void {
    this.db.close(true);
  }
}
