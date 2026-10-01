"""Sign-in through the real OAuth callback, with Discord's API faked.

Sign-up is open: any Discord account gets its own user row on first login,
reuses it afterwards, and starts with an empty, private dashboard."""
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def fake_discord(profile):
    """An httpx.AsyncClient stand-in that answers the token exchange and the
    profile lookup the way Discord does."""

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, **kw):
            assert url == auth.DISCORD_TOKEN_URL
            return FakeResponse(200, {"access_token": "fake-token"})

        async def get(self, url, **kw):
            assert url == auth.DISCORD_ME_URL
            return FakeResponse(200, profile)

    return FakeClient


def sign_in_via_discord(monkeypatch, profile) -> tuple[TestClient, object]:
    monkeypatch.setattr(auth.httpx, "AsyncClient", fake_discord(profile))
    client = TestClient(app)
    client.cookies.set(auth.STATE_COOKIE, "the-state")
    r = client.get("/api/auth/callback?code=c&state=the-state", follow_redirects=False)
    return client, r


@pytest.mark.parametrize("discord_id", ["5550001", "5550002"])
def test_any_discord_account_can_sign_in(monkeypatch, discord_id):
    client, r = sign_in_via_discord(
        monkeypatch, {"id": discord_id, "username": f"user{discord_id}", "global_name": "New Person", "avatar": None}
    )
    assert r.status_code == 303
    assert r.headers["location"].endswith("/")  # the dashboard, not /login?error=...
    assert auth.SESSION_COOKIE in r.cookies

    me = client.get("/api/auth/me").json()
    assert (me["discord_id"], me["display_name"]) == (discord_id, "New Person")
    # A brand-new account starts empty.
    assert client.get("/api/tasks").json() == []
    assert client.get("/api/rules").json() == []


def test_signing_in_again_reuses_the_account(monkeypatch):
    profile = {"id": "5550003", "username": "returning", "global_name": None, "avatar": None}
    first, _ = sign_in_via_discord(monkeypatch, profile)
    first.post("/api/tasks", json={"title": "mine"})
    first_id = first.get("/api/auth/me").json()["id"]

    second, _ = sign_in_via_discord(monkeypatch, {**profile, "username": "renamed"})
    me = second.get("/api/auth/me").json()
    assert me["id"] == first_id
    assert me["username"] == "renamed"
    assert [t["title"] for t in second.get("/api/tasks").json()] == ["mine"]


def test_new_account_cannot_see_existing_users_data(monkeypatch, alice):
    alice.post("/api/tasks", json={"title": "alice private"})
    stranger, _ = sign_in_via_discord(
        monkeypatch, {"id": "5550004", "username": "stranger", "global_name": None, "avatar": None}
    )
    assert stranger.get("/api/tasks").json() == []


def test_bad_state_is_still_refused(monkeypatch):
    monkeypatch.setattr(auth.httpx, "AsyncClient", fake_discord({"id": "1", "username": "x"}))
    client = TestClient(app)
    client.cookies.set(auth.STATE_COOKIE, "expected")
    r = client.get("/api/auth/callback?code=c&state=forged", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"].endswith("/login?error=state")
    assert auth.SESSION_COOKIE not in r.cookies
