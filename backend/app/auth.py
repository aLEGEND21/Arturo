"""Discord OAuth login and cookie sessions.

The flow: GET /api/auth/login sends the browser to Discord with a random
`state` pinned in a short-lived cookie. Discord returns to
GET /api/auth/callback, which swaps the code for a token, reads the profile
(`identify` scope only), upserts the `users` row, and opens a session. The session token lives in an HttpOnly
cookie; only its SHA-256 lands in the database.

Every API router hangs `require_user` off its include_router call, so a
request without a live session gets a 401 before any handler runs. Only
/health and these auth routes stay open. Handlers that touch data take the
same dependency (`CurrentUser`) and scope every query by `user["id"]`;
FastAPI resolves it once per request, so the session is looked up once.

Any Discord account may sign in. Each person who signs in gets their own
users row, created on first login, and sees only their own data. The one
admin, the owner (OWNER_DISCORD_ID in db.py), can also trigger the app-wide
jobs, which act on every user's data."""
import hashlib
import logging
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from .db import OWNER_DISCORD_ID, db_dep, now_iso

log = logging.getLogger("arturo.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token"
DISCORD_ME_URL = "https://discord.com/api/users/@me"

CLIENT_ID = os.environ.get("DISCORD_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
# Where Discord sends the browser back. Must match a redirect registered on
# the Discord application exactly, scheme and port included. In prod this is
# the public origin; the Next proxy forwards /api/auth/* to the backend.
REDIRECT_URI = os.environ.get("DISCORD_REDIRECT_URI", "http://localhost:8000/api/auth/callback")
# Where the browser lands after login/logout — the dashboard's origin.
APP_URL = os.environ.get("ARTURO_APP_URL", "http://localhost:3000").rstrip("/")
# The only account allowed to run the app-wide jobs by hand. Deliberately
# fixed in code: no environment variable or database row can add admins.
ADMIN_DISCORD_ID = OWNER_DISCORD_ID
SESSION_DAYS = int(os.environ.get("ARTURO_SESSION_DAYS", "30"))

SESSION_COOKIE = "arturo_session"
STATE_COOKIE = "arturo_oauth_state"
# Secure cookies are refused over plain http, which is what local dev uses.
COOKIE_SECURE = REDIRECT_URI.startswith("https://")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _avatar_url(discord_id: str, avatar_hash: str | None) -> str | None:
    if not avatar_hash:
        return None
    return f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png?size=64"


def _public_user(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "discord_id": row["discord_id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "avatar_url": _avatar_url(row["discord_id"], row["avatar"]),
    }


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 3600,
        httponly=True,
        secure=COOKIE_SECURE,
        # Lax: the redirect back from Discord is a top-level GET and carries
        # the cookie, while cross-site POSTs to the API do not — which is the
        # CSRF protection for the JSON endpoints.
        samesite="lax",
        path="/",
    )


def _login_error(reason: str) -> RedirectResponse:
    return RedirectResponse(f"{APP_URL}/login?{urlencode({'error': reason})}", status_code=303)


def require_user(request: Request, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Dependency: the user behind the session cookie, or 401."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in")
    row = conn.execute(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?""",
        (_hash(token), now_iso()),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Session expired")
    return _public_user(row)


# The signed-in user, for handlers that scope data by user["id"].
CurrentUser = Annotated[dict, Depends(require_user)]


def require_admin(user: CurrentUser) -> dict:
    """Dependency: the owner, signed in, or 403."""
    if user["discord_id"] != ADMIN_DISCORD_ID:
        raise HTTPException(status_code=403, detail="Admins only")
    return user


@router.get("/login")
def login():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Discord login is not configured")
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": "identify",
        "state": state,
        "prompt": "none",
    }
    response = RedirectResponse(f"{DISCORD_AUTHORIZE_URL}?{urlencode(params)}", status_code=303)
    response.set_cookie(
        STATE_COOKIE, state, max_age=600, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/"
    )
    return response


@router.get("/callback")
async def callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    conn: sqlite3.Connection = Depends(db_dep),
):
    if error or not code:
        # The user cancelled on Discord's consent screen.
        return _login_error("cancelled")
    expected = request.cookies.get(STATE_COOKIE)
    if not expected or not state or not secrets.compare_digest(expected, state):
        return _login_error("state")

    async with httpx.AsyncClient(timeout=10) as client:
        token_res = await client.post(
            DISCORD_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
            },
            auth=(CLIENT_ID, CLIENT_SECRET),
            headers={"Accept": "application/json"},
        )
        if token_res.status_code != 200:
            log.warning("discord token exchange failed: %s %s", token_res.status_code, token_res.text[:200])
            return _login_error("discord")
        access_token = token_res.json().get("access_token")
        me_res = await client.get(DISCORD_ME_URL, headers={"Authorization": f"Bearer {access_token}"})
        if me_res.status_code != 200:
            log.warning("discord profile fetch failed: %s", me_res.status_code)
            return _login_error("discord")
    profile = me_res.json()

    discord_id = str(profile["id"])
    now = now_iso()
    conn.execute(
        """INSERT INTO users (discord_id, username, display_name, avatar, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(discord_id) DO UPDATE SET
             username = excluded.username,
             display_name = excluded.display_name,
             avatar = excluded.avatar,
             last_login_at = excluded.last_login_at""",
        (discord_id, profile["username"], profile.get("global_name"), profile.get("avatar"), now, now),
    )
    user_id = conn.execute("SELECT id FROM users WHERE discord_id = ?", (discord_id,)).fetchone()[0]

    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat()
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (_hash(token), user_id, now, expires_at),
    )
    # Opportunistic cleanup so the table never grows past what is live.
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
    conn.commit()

    response = RedirectResponse(APP_URL + "/", status_code=303)
    _set_session_cookie(response, token)
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


@router.get("/me")
def me(user: CurrentUser):
    return user


@router.post("/logout")
def logout(request: Request, response: Response, conn: sqlite3.Connection = Depends(db_dep)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))
        conn.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}
