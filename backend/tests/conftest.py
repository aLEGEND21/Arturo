"""Shared fixtures. Each test gets a fresh, fully migrated database file and
API clients signed in as separate users.

The database path is read when the app is imported, so it is pointed at a
throwaway directory before anything from `app` is imported."""
import hashlib
import os
import secrets
import shutil
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="arturo-tests-"))
os.environ["ARTURO_DB"] = str(_TMP / "arturo.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import DB_PATH, OWNER_DISCORD_ID, get_conn, init_db, now_iso  # noqa: E402
from app.main import app  # noqa: E402

# Every test deletes this database and its backups. If anything imported
# `app` before this file set ARTURO_DB, DB_PATH would be the real dev
# database; refuse to run rather than wipe it.
if DB_PATH.parent != _TMP:
    raise RuntimeError(f"tests would use {DB_PATH}, not a throwaway database; refusing to run")


def _wipe_db() -> None:
    for suffix in ("", "-wal", "-shm"):
        Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
    shutil.rmtree(DB_PATH.parent / "backups", ignore_errors=True)


@pytest.fixture(autouse=True)
def fresh_db():
    _wipe_db()
    init_db()
    yield
    _wipe_db()


def sign_in(discord_id: str, username: str) -> TestClient:
    """A client with a live session for this Discord user (created if new).
    The app's lifespan (scheduler, startup sweep) is not started."""
    conn = get_conn()
    try:
        now = now_iso()
        conn.execute(
            """INSERT INTO users (discord_id, username, created_at, last_login_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username""",
            (discord_id, username, now, now),
        )
        user_id = conn.execute("SELECT id FROM users WHERE discord_id = ?", (discord_id,)).fetchone()[0]
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), user_id, now, "2999-01-01T00:00:00+00:00"),
        )
        conn.commit()
    finally:
        conn.close()
    client = TestClient(app)
    client.cookies.set("arturo_session", token)
    client.user_id = user_id
    return client


@pytest.fixture
def alice() -> TestClient:
    return sign_in("1001", "alice")


@pytest.fixture
def bob() -> TestClient:
    return sign_in("1002", "bob")


@pytest.fixture
def owner() -> TestClient:
    """The legacy owner, who is also the only admin."""
    return sign_in(OWNER_DISCORD_ID, "owner")


@pytest.fixture
def anon() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db():
    conn = get_conn()
    yield conn
    conn.close()


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)
