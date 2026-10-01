"""Migration 3 hands every pre-existing row to the legacy owner, and rows
written later by pre-multi-user code (a rollback) are adopted on boot."""
import sqlite3

import pytest

from app import db as dbmod
from app.db import AUTH_SCHEMA, DB_PATH, OWNED_TABLES, OWNER_DISCORD_ID, SCHEMA, init_db


def build_v2_database(with_owner_row: bool, version: int = 2) -> None:
    """A database as an earlier single-user release left it. Version 2 is
    the release with Discord sign-in; 1 and 0 predate it (no users table)."""
    for suffix in ("", "-wal", "-shm"):
        __import__("pathlib").Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    if version >= 2:
        conn.executescript(AUTH_SCHEMA)
    conn.execute(f"PRAGMA user_version = {version}")
    if with_owner_row and version >= 2:
        conn.execute(
            "INSERT INTO users (discord_id, username, created_at, last_login_at) VALUES (?, '.alegend', 'x', 'x')",
            (OWNER_DISCORD_ID,),
        )
    conn.execute("UPDATE settings SET work_hours_start = '06:30' WHERE id = 1")
    for i in range(3):
        conn.execute(
            "INSERT INTO tasks (title, position, created_at) VALUES (?, ?, 'x')", (f"old task {i}", i + 1)
        )
        conn.execute("INSERT INTO task_events (task_id, event_type, created_at) VALUES (?, 'created', 'x')", (i + 1,))
    conn.execute("INSERT INTO rules (text, created_at) VALUES ('old rule', 'x')")
    conn.execute("INSERT INTO boards (name) VALUES ('old board')")
    conn.execute("INSERT INTO context_notes (scope, text, created_at) VALUES ('global', 'old note', 'x')")
    conn.execute("INSERT INTO messages (direction, content, created_at) VALUES ('in', 'hi', 'x')")
    conn.commit()
    conn.close()


def owner_and_counts():
    conn = sqlite3.connect(DB_PATH)
    try:
        owner = conn.execute("SELECT id, username FROM users WHERE discord_id = ?", (OWNER_DISCORD_ID,)).fetchone()
        counts = {
            t: conn.execute(f"SELECT user_id, COUNT(*) FROM {t} GROUP BY user_id").fetchall() for t in OWNED_TABLES
        }
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        events = conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0]
        settings = conn.execute("SELECT user_id, work_hours_start FROM user_settings").fetchall()
        return owner, counts, version, events, settings
    finally:
        conn.close()


def test_backfills_everything_to_existing_owner_row():
    build_v2_database(with_owner_row=True)
    init_db()
    owner, counts, version, events, settings = owner_and_counts()
    assert version == 3
    assert owner[1] == ".alegend"  # the existing row was reused, not replaced
    assert counts == {
        "tasks": [(owner[0], 3)], "rules": [(owner[0], 1)], "boards": [(owner[0], 1)],
        "context_notes": [(owner[0], 1)], "messages": [(owner[0], 1)],
    }
    assert events == 3
    assert settings == [(owner[0], "06:30")]  # carried over from the old settings row


def test_creates_owner_row_when_missing():
    build_v2_database(with_owner_row=False)
    init_db()
    owner, counts, version, events, settings = owner_and_counts()
    assert owner is not None
    assert all(rows == [(owner[0], 1 if t != "tasks" else 3)] for t, rows in counts.items())
    assert settings == [(owner[0], "06:30")]


@pytest.mark.parametrize("version", [0, 1])
def test_migrates_databases_from_before_sign_in(version):
    build_v2_database(with_owner_row=False, version=version)
    init_db()
    owner, counts, final_version, events, settings = owner_and_counts()
    assert final_version == 3
    assert counts["tasks"] == [(owner[0], 3)]
    assert events == 3
    assert settings == [(owner[0], "06:30")]


def test_takes_a_snapshot_before_migrating():
    build_v2_database(with_owner_row=True)
    init_db()
    snaps = list((DB_PATH.parent / "backups").glob("arturo-pre-migration-v2-to-v3-*.db"))
    assert len(snaps) == 1
    snap = sqlite3.connect(snaps[0])
    assert snap.execute("PRAGMA user_version").fetchone()[0] == 2
    assert snap.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 3
    snap.close()


def test_rows_without_owner_are_adopted_on_boot():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    # What a rolled-back, single-user image would write: no user_id, in
    # every owned table.
    conn.execute("INSERT INTO tasks (title, position, created_at) VALUES ('from old image', 99, 'x')")
    conn.execute("INSERT INTO rules (text, created_at) VALUES ('old image rule', 'x')")
    conn.execute("INSERT INTO boards (name) VALUES ('old image board')")
    conn.execute("INSERT INTO context_notes (scope, text, created_at) VALUES ('global', 'old image note', 'x')")
    conn.execute("INSERT INTO messages (direction, content, created_at) VALUES ('in', 'hi', 'x')")
    conn.commit()
    conn.close()
    init_db()
    owner, counts, *_ = owner_and_counts()
    assert counts == {t: [(owner[0], 1)] for t in OWNED_TABLES}


def test_migrated_database_passes_integrity_checks():
    build_v2_database(with_owner_row=True)
    init_db()
    conn = sqlite3.connect(DB_PATH)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_migration_is_idempotent():
    build_v2_database(with_owner_row=True)
    init_db()
    first = owner_and_counts()
    init_db()
    assert owner_and_counts() == first
    assert dbmod.MIGRATIONS[-1][0] >= 3
