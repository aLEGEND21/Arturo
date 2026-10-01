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

from fastapi import HTTPException

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

# The Discord account that owned everything before multi-user support.
# Migration 3 assigns all pre-existing rows to this user, and every boot
# re-assigns any row without an owner to it (see adopt_orphans). Kept as a
# constant, not read from configuration, so the backfill can't change if
# the environment does.
OWNER_DISCORD_ID = "416730155332009984"

# Tables whose rows belong to one user. task_events inherit ownership from
# their task; llm_calls are only reachable through messages.
OWNED_TABLES = ("tasks", "rules", "boards", "context_notes", "messages")

_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')"
_OWNER_ID_SQL = f"(SELECT id FROM users WHERE discord_id = '{OWNER_DISCORD_ID}')"
_ADD_OWNER_COLUMNS = "\n".join(
    f"ALTER TABLE {t} ADD COLUMN user_id INTEGER REFERENCES users(id);" for t in OWNED_TABLES
)
_BACKFILL_OWNER = "\n".join(
    f"UPDATE {t} SET user_id = {_OWNER_ID_SQL} WHERE user_id IS NULL;" for t in OWNED_TABLES
)

# Migration 3: multi-user data. Additive only, so the previous image can
# still open the file after a rollback:
# - every owned table gains a nullable user_id, backfilled to the owner;
# - per-user preferences move to user_settings, seeded from the old row;
# - the old settings row stays, now holding only the app-wide timezone
#   (rollover runs once, on Eastern time, for everyone). Its other columns
#   (discord_user_id, work and quiet hours, message limits) are no longer
#   read; they stay so a rolled-back image can still use the table.
MULTI_USER_SCHEMA = f"""
INSERT OR IGNORE INTO users (discord_id, username, created_at, last_login_at)
VALUES ('{OWNER_DISCORD_ID}', 'owner', {_NOW_SQL}, {_NOW_SQL});

{_ADD_OWNER_COLUMNS}
{_BACKFILL_OWNER}

CREATE INDEX IF NOT EXISTS tasks_user_position ON tasks(user_id, position);
CREATE INDEX IF NOT EXISTS rules_user ON rules(user_id);
CREATE INDEX IF NOT EXISTS boards_user ON boards(user_id);
CREATE INDEX IF NOT EXISTS context_notes_user ON context_notes(user_id);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  work_hours_start    TEXT NOT NULL DEFAULT '09:00',
  work_hours_end      TEXT NOT NULL DEFAULT '23:00',
  quiet_start         TEXT NOT NULL DEFAULT '23:30',
  quiet_end           TEXT NOT NULL DEFAULT '08:30',
  max_daily_messages  INTEGER NOT NULL DEFAULT 8,
  min_gap_minutes     INTEGER NOT NULL DEFAULT 45
);

INSERT OR IGNORE INTO user_settings
  (user_id, work_hours_start, work_hours_end, quiet_start, quiet_end, max_daily_messages, min_gap_minutes)
SELECT u.id, s.work_hours_start, s.work_hours_end, s.quiet_start, s.quiet_end,
       s.max_daily_messages, s.min_gap_minutes
FROM users u, settings s
WHERE u.discord_id = '{OWNER_DISCORD_ID}' AND s.id = 1;
"""

# Ordered (version, script). Each script runs with its version stamp inside
# one transaction, so a crash mid-migration leaves the file at the previous
# version and the migration re-runs on the next boot.
MIGRATIONS: list[tuple[int, str]] = [
    (1, SCHEMA),
    (2, AUTH_SCHEMA),
    (3, MULTI_USER_SCHEMA),
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
        if current < target:
            # Version 0 is a fresh file or one from before versioning. The
            # baseline is a no-op on the latter, but any later migration does
            # change it, so snapshot whenever real tables already exist.
            has_tables = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
            ).fetchone()
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
        adopt_orphans(conn)
    finally:
        conn.close()


def owner_id(conn: sqlite3.Connection) -> int:
    """The legacy owner's user id, creating the row if it is missing."""
    now = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO users (discord_id, username, created_at, last_login_at) VALUES (?, 'owner', ?, ?)",
        (OWNER_DISCORD_ID, now, now),
    )
    return conn.execute("SELECT id FROM users WHERE discord_id = ?", (OWNER_DISCORD_ID,)).fetchone()[0]


def adopt_orphans(conn: sqlite3.Connection) -> int:
    """Give rows without an owner to the legacy owner. Runs on every boot.

    Only pre-multi-user code writes rows without a user_id, which means an
    image from before migration 3 ran against this file (a rollback). That
    code was single-user, so its rows are the owner's. Without this they
    would stay invisible to everyone after the next deploy."""
    oid = owner_id(conn)
    adopted = 0
    for table in OWNED_TABLES:
        adopted += conn.execute(f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (oid,)).rowcount
    conn.commit()
    if adopted:
        log.warning("assigned %d rows without an owner to the legacy owner", adopted)
    return adopted


# Per-user storage limits. Sign-up is open to any Discord account, so one
# account must not be able to fill the disk. Each is far above real use.
MAX_TASKS = 10_000
MAX_BOARDS = 100
MAX_RULES = 100  # all rules, active or not; 15 may be active at once
MAX_ACTIVE_NOTES = 200


def require_room(conn: sqlite3.Connection, count_sql: str, params: tuple, limit: int, what: str) -> None:
    """Refuse a create once the caller already has `limit` rows of a kind."""
    if conn.execute(count_sql, params).fetchone()[0] >= limit:
        raise HTTPException(status_code=400, detail=f"Limit reached: at most {limit} {what}.")


def write_lock(conn: sqlite3.Connection) -> None:
    """Take SQLite's write lock before reading anything a write depends on
    (task positions), so two requests can't compute the same slot. Released
    by the handler's commit, or rolled back when the connection closes."""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def app_timezone(conn: sqlite3.Connection) -> str:
    """The app-wide timezone. Every user shares it: the 4am rollover runs
    once, on Eastern time, for everyone."""
    return conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0]


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
