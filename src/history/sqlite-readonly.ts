import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);

export interface StrictReadOnlyStatement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
}

export interface StrictReadOnlyDb {
    prepare(sql: string): StrictReadOnlyStatement;
    close(): void;
}

function isReadOnlyDirWalError(err: unknown): boolean {
    const code = typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    return code.startsWith("SQLITE_READONLY")
        || code.startsWith("SQLITE_CANTOPEN")
        || code === "EACCES"
        || code === "EROFS"
        || /readonly database|unable to open database file/i.test(msg);
}

/**
 * Open an existing SQLite database in strict zero-write read-only mode.
 *
 * - If no active non-empty `-wal` file exists (e.g. a closed WAL-mode DB), open via
 *   `file:...?mode=ro&immutable=1` using Node's built-in `node:sqlite` (which sets
 *   `SQLITE_OPEN_URI`, unlike `better-sqlite3` v11), so SQLite NEVER creates `-wal`
 *   or `-shm` sidecar files even inside a `0o555` read-only directory.
 * - If an active non-empty `-wal` file DOES exist, open normally via `{ readonly: true,
 *   fileMustExist: true }` so uncommitted WAL frames are visible; if the parent directory
 *   is read-only and blocks WAL shared-memory coordination, fail loudly with an
 *   actionable error rather than silently ignoring uncommitted WAL frames.
 */
export function openSqliteReadOnlyStrict(dbPath: string): StrictReadOnlyDb {
    const resolvedPath = path.resolve(dbPath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`SQLite database file does not exist: ${resolvedPath}`);
    }

    const walPath = `${resolvedPath}-wal`;
    let hasActiveWal = false;
    try {
        if (fs.existsSync(walPath)) {
            hasActiveWal = fs.statSync(walPath).size > 0;
        }
    } catch {
        // If -wal cannot be stat'd, err on the side of standard readonly open
        hasActiveWal = true;
    }

    if (hasActiveWal) {
        let db: Database.Database | null = null;
        try {
            db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
            // SQLite opens WAL/SHM lazily on the first schema/query read; probe immediately
            // so unwritable-directory WAL failures surface here with an actionable message.
            db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
            return db;
        } catch (err) {
            if (db) {
                try {
                    db.close();
                } catch {
                    // ignore
                }
            }
            if (isReadOnlyDirWalError(err)) {
                throw new Error(
                    `Cannot open SQLite database "${resolvedPath}" in strict read-only mode because an active non-empty WAL file `
                    + `("${walPath}") exists and its directory is read-only/unwritable for SQLite WAL coordination. `
                    + `Close or checkpoint the database (PRAGMA wal_checkpoint(TRUNCATE)) before running --dry-run.`,
                    { cause: err },
                );
            }
            throw err;
        }
    }

    const uri = `file:${encodeURI(resolvedPath).replace(/\?/g, "%3F").replace(/#/g, "%23")}?mode=ro&immutable=1`;
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(uri, { readOnly: true, readBigInts: false });
    return {
        prepare(sql: string): StrictReadOnlyStatement {
            const stmt = db.prepare(sql);
            return {
                all(...params: unknown[]): unknown[] {
                    return stmt.all(...(params as SQLInputValue[]));
                },
                get(...params: unknown[]): unknown {
                    return stmt.get(...(params as SQLInputValue[]));
                },
            };
        },
        close(): void {
            db.close();
        },
    };
}
