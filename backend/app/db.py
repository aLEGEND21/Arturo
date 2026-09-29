"""SQLite access layer. One process owns this file; WAL mode, foreign keys on.

Schema changes are versioned migrations keyed on SQLite's `user_version`
pragma (see MIGRATIONS). Migrations are additive only: add a column, add a
table, backfill. Never drop or rename in the same release that adds, so the
previous image can still open the file if a deploy is rolled back."""
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("arturo.db")

DB_PATH = Path(os.environ.get("ARTURO_DB", Path(__file__).resolve().parent.parent / "data" / "arturo.db"))

# Migration 1: the Phase 0 baseline. Every statement is IF NOT EXISTS, so a
# database created before versioning existed (user_version 0) passes through
# unchanged and is simply stamped as version 1.
SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  notes           TEXT,
  handling        TEXT,
  position        INTEGER NOT NULL,
  starred         INTEGER NOT NULL DEFAULT 0,
  recurring       INTEGER NOT NULL DEFAULT 0,
  streak          INTEGER NOT NULL DEFAULT 0,
  board_id        INTEGER REFERENCES boards(id),
  deadline        TEXT,
  commitment_at   TEXT,
  effort          TEXT CHECK (effort IN ('short','medium','long')),
  state           TEXT NOT NULL DEFAULT 'not_started'
                    CHECK (state IN ('not_started','in_progress','blocked','done','dropped')),
  blocked_reason  TEXT,
  today_flag      INTEGER NOT NULL DEFAULT 0,
  snooze_until    TEXT,
  snooze_reason   TEXT,
  nudge_level     INTEGER NOT NULL DEFAULT 0,
  last_nudged_at  TEXT,
  last_user_update TEXT,
  source          TEXT CHECK (source IN ('dashboard','discord')),
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  event_type  TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  direction   TEXT CHECK (direction IN ('in','out')),
  discord_id  TEXT,
  task_id     INTEGER REFERENCES tasks(id),
  content     TEXT NOT NULL,
  llm_call_id INTEGER REFERENCES llm_calls(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY,
  purpose       TEXT,
  model         TEXT,
  request       TEXT,
  response      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_notes (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('global','task')),
  task_id     INTEGER REFERENCES tasks(id),
  text        TEXT NOT NULL,
  source_msg  INTEGER REFERENCES messages(id),
  expires_at  TEXT,
  supersedes  INTEGER REFERENCES context_notes(id),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  text        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  timezone            TEXT NOT NULL DEFAULT 'America/New_York',
  discord_user_id     TEXT NOT NULL DEFAULT '',
  work_hours_start    TEXT NOT NULL DEFAULT '09:00',
  work_hours_end      TEXT NOT NULL DEFAULT '23:00',
  quiet_start         TEXT NOT NULL DEFAULT '23:30',
  quiet_end           TEXT NOT NULL DEFAULT '08:30',
  max_daily_messages  INTEGER NOT NULL DEFAULT 8,
  min_gap_minutes     INTEGER NOT NULL DEFAULT 45
);

INSERT OR IGNORE INTO settings (id) VALUES (1);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    # check_same_thread=False: FastAPI may open, use, and close a request's
    # connection on different threadpool threads. Each connection still serves
    # exactly one request at a time, so this is safe.
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Migration 2: Discord login. `users` is keyed on the Discord id so the future
# bot and the dashboard identify the same person; it is also the table every
# per-user column will reference when the data goes multi-tenant. Sessions
# hold a hash of the cookie token, never the token itself.
AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  discord_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  display_name  TEXT,
  avatar        TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
"""

# Ordered (version, script). Each script runs with its version stamp inside
# one transaction, so a crash mid-migration leaves the file at the previous
# version and the migration re-runs on the next boot.
MIGRATIONS: list[tuple[int, str]] = [
    (1, SCHEMA),
    (2, AUTH_SCHEMA),
]


def snapshot_before_migration(from_version: int, to_version: int) -> Path | None:
    """Copy the database next to the nightly backups before its schema
    changes, so every migration has a restore point regardless of when the
    deploy landed relative to the 3:55am job. Only the latest snapshot is
    kept; the nightly job's pruning ignores these files. Skipped for a
    brand-new file."""
    if not DB_PATH.exists():
        return None
    backups_dir = DB_PATH.parent / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    dest_path = backups_dir / f"arturo-pre-migration-v{from_version}-to-v{to_version}-{stamp}.db"
    src = sqlite3.connect(DB_PATH)
    try:
        dest = sqlite3.connect(dest_path)
        try:
            src.backup(dest)
        finally:
            dest.close()
    finally:
        src.close()
    # Drop older snapshots only once the new one is safely written.
    for old in backups_dir.glob("arturo-pre-migration-*.db"):
        if old != dest_path:
            old.unlink()
    log.info("pre-migration snapshot: %s", dest_path.name)
    return dest_path


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    target = MIGRATIONS[-1][0]
    conn = get_conn()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        if current >= target:
            return
        # Version 0 is a fresh file or one from before versioning. The
        # baseline is a no-op on the latter, but any later migration does
        # change it, so snapshot whenever real tables already exist.
        has_tables = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").fetchone()
        if has_tables is not None:
            snapshot_before_migration(current, target)
        for version, script in MIGRATIONS:
            if version <= current:
                continue
            # executescript commits any pending transaction first, so the
            # BEGIN/COMMIT pair goes inside the script to make the DDL and
            # the version stamp atomic.
            conn.executescript(f"BEGIN;\n{script}\nPRAGMA user_version = {version};\nCOMMIT;")
            log.info("migrated database to version %d", version)
    finally:
        conn.close()


def log_event(conn: sqlite3.Connection, task_id: int, event_type: str, payload: dict | None = None) -> None:
    conn.execute(
        "INSERT INTO task_events (task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)",
        (task_id, event_type, json.dumps(payload) if payload else None, now_iso()),
    )


def db_dep():
    conn = get_conn()
    try:
        yield conn
    finally:
        conn.close()
