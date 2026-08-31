"""SQLite access layer. One process owns this file; WAL mode, foreign keys on."""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("ARTURO_DB", Path(__file__).resolve().parent.parent / "data" / "arturo.db"))

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


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = get_conn()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.commit()
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
