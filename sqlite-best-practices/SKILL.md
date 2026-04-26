---
name: sqlite-best-practices
description: Use when designing or refactoring SQLite-backed applications, schemas, connection setup, STRICT tables, WAL mode, migration handling, reflink backups, app-level locks, and reload-safe web startup behavior.
---

# SQLite Best Practices

## Schema

- Use `STRICT` tables by default: every `CREATE TABLE` should end with `) STRICT;` unless there is a specific compatibility reason not to.
- Use explicit column types and constraints. Prefer `NOT NULL`, `CHECK`, `UNIQUE`, and foreign keys over application-only validation when the database can enforce the invariant.
- Enable foreign keys on every connection with `PRAGMA foreign_keys = ON`; SQLite does not enforce them by default for new connections.
- For a baseline/current-schema migration where legacy DBs are not supported, prefer plain `CREATE TABLE ...` over `CREATE TABLE IF NOT EXISTS ...` so unexpected pre-existing schemas fail loudly instead of being silently marked applied.

## Connections

- Configure every SQLite connection with shared pragmas: `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
- Keep connection ownership explicit. Request handlers should open and close DB connections per request. Long-running workers may keep one connection for the job lifetime.
- Use context managers so connections commit/rollback predictably and always close.
- Keep SQLite connection policy in one helper so normal app connections, worker connections, and migration connections do not drift.

## Migration Coordination

Use a real migration history tool, but keep SQLite locking policy explicit in the app:

- Use a separate app-level lock file such as `<db>.migrate.lock`: normal DB clients take a shared `flock`, the migrator takes an exclusive `flock`.
- Treat that lock as cooperative app coordination, not as SQLite enforcement. It prevents app code from racing into migrations and gives nicer behavior than random `database is locked` errors.
- For migrations, open one dedicated SQLite connection, configure shared pragmas, then set `PRAGMA locking_mode = EXCLUSIVE`.
- After setting exclusive mode, issue a real schema read, for example `SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1`, so SQLite actually acquires the exclusive lock.

## Startup Flow

Make the migration entrypoint cheap and deliberate:

1. Read migrations from disk.
2. Capture `needs_backup = db_path.exists() and db_path.stat().st_size > 0` before opening SQLite, so fresh DB creation does not trigger a backup.
3. Under a shared migration lock, check whether migrations are pending. If none are pending, return without taking the exclusive lock.
4. If pending, take the exclusive migration lock, open the single exclusive migration connection, recheck pending state, then back up and apply.

## Backup Flow

Before applying pending migrations to an existing DB:

- Run `PRAGMA wal_checkpoint(TRUNCATE)` on the migration connection.
- Check the checkpoint result: fail if `busy` is nonzero or if checkpointed frames do not match log frames.
- Copy only the main DB file after the checkpoint, using `cp --reflink=always <db> <backup>`.
- Keep backups in a local backup directory and do not auto-delete them during the migration command.

This relies on WAL being fully checkpointed before the reflink copy. The exclusive migration connection prevents cooperating SQLite clients from changing the DB during the checkpoint/copy window.

## Web Reloaders

Do not run migrations from a reloaded app factory such as `create_app()`.

- The CLI/server entrypoint may run `init_db()` once before launching uvicorn.
- The web app factory should only wait for pending migrations to disappear, typically polling once per second.
- This lets developers edit migration files while a reloader is active without the reloader silently applying half-written migrations.

## Python And Yoyo

When using Python and yoyo:

- Open the migration SQLite connection yourself instead of letting yoyo's default SQLite backend create it.
- Set `conn.isolation_level = None`, matching yoyo's own SQLite backend. This puts Python's sqlite3 wrapper in autocommit mode so yoyo's explicit `BEGIN`, `COMMIT`, `ROLLBACK`, and savepoints are the only transaction machinery in play.
- Intercept yoyo with a custom SQLite backend that returns the app-owned connection.
- Override the backend's `copy()` so it returns another backend wrapper over the same connection instead of opening a second connection.
- This avoids yoyo's default `file:...?cache=shared` connection and prevents self-deadlock under exclusive locking.

## Pitfalls

- `locking_mode=EXCLUSIVE` in WAL mode blocks other SQLite connections once the DB is actually touched; it is not a polite multi-reader WAL mode.
- Holding an exclusive SQLite connection while the migration tool opens a second connection can block the migration tool itself. Prefer one app-owned connection for the whole migration run when the tool allows it.
- `SELECT 1` does not touch the DB file; use a real schema/table read to trigger the exclusive lock.
- App-level `flock` and SQLite exclusive locking are complementary. Keep both unless all clients and tools are guaranteed to be perfectly controlled.
