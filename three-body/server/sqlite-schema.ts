import type { DatabaseSync } from 'node:sqlite';

export const ELAND_DATABASE_FILENAME = 'eland.sqlite3';
/** Shared tables owned by SqliteElandStore are complete at this version. */
export const ELAND_DATABASE_FOUNDATION_SCHEMA_VERSION = 2;
/** Only SqliteRunStore may advance the shared database to this version. */
export const ELAND_DATABASE_SCHEMA_VERSION = 3;

export function sqliteUserVersion(database: DatabaseSync): number {
  return Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/**
 * Schema ownership is shared by two stores, so initialization must serialize
 * before re-reading `user_version`. The operation owns the version bump and
 * must perform it only after all of its CREATE statements have succeeded.
 */
export function withSqliteSchemaTransaction(
  database: DatabaseSync,
  operation: (lockedSchemaVersion: number) => void,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    operation(sqliteUserVersion(database));
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration failure if SQLite already rolled back.
    }
    throw error;
  }
}
