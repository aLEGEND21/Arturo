"""Each user sees and changes only their own data.

Pattern: Alice creates something, then Bob tries to read, list, change or
delete it. Bob must get 404 (or 400 where the route validates a list of ids)
and Alice's data must be unchanged afterwards."""
import importlib
from datetime import timedelta
from zoneinfo import ZoneInfo

from fastapi.routing import APIRoute

from app import auth
from app.clock import logical_day_start, logical_today
from app.db import OWNER_DISCORD_ID
from app.main import app


def make_task(client, **body):
    r = client.post("/api/tasks", json={"title": "task", **body})
    assert r.status_code == 201, r.text
    return r.json()


# --- tasks ---

def test_task_lists_only_show_own_tasks(alice, bob):
    a_today = make_task(alice, title="alice today", today=True)
    a_backlog = make_task(alice, title="alice backlog")
    b_task = make_task(bob, title="bob task", today=True)

    for view in ("all", "today", "backlog"):
        bob_ids = {t["id"] for t in bob.get(f"/api/tasks?view={view}").json()}
        assert a_today["id"] not in bob_ids and a_backlog["id"] not in bob_ids
        alice_ids = {t["id"] for t in alice.get(f"/api/tasks?view={view}").json()}
        assert b_task["id"] not in alice_ids
    assert {t["id"] for t in alice.get("/api/tasks").json()} == {a_today["id"], a_backlog["id"]}


def test_cannot_read_another_users_task_or_events(alice, bob):
    a = make_task(alice, title="secret")
    assert bob.get(f"/api/tasks/{a['id']}").status_code == 404
    assert bob.get(f"/api/tasks/{a['id']}/events").status_code == 404
    # Same response as an id that doesn't exist at all.
    assert bob.get("/api/tasks/999999").status_code == 404
    assert alice.get(f"/api/tasks/{a['id']}").status_code == 200


def test_cannot_update_another_users_task(alice, bob):
    a = make_task(alice, title="keep me", today=True)
    for patch in ({"title": "pwned"}, {"state": "done"}, {"today_flag": False}, {"notes": "x"}):
        assert bob.patch(f"/api/tasks/{a['id']}", json=patch).status_code == 404
    after = alice.get(f"/api/tasks/{a['id']}").json()
    assert after["title"] == "keep me"
    assert after["state"] == "not_started"
    assert after["today_flag"] is True
    assert after["notes"] is None
    # No events were logged against Alice's task by Bob's attempts.
    types = [e["event_type"] for e in alice.get(f"/api/tasks/{a['id']}/events").json()]
    assert sorted(types) == ["created", "promoted"]


def test_cannot_reorder_another_users_tasks(alice, bob):
    a1, a2 = make_task(alice, title="a1"), make_task(alice, title="a2")
    b1 = make_task(bob, title="b1")
    before = [(t["id"], t["position"]) for t in alice.get("/api/tasks").json()]

    assert bob.post("/api/tasks/reorder", json={"ids": [a2["id"], a1["id"]]}).status_code == 400
    # Mixing one of Bob's own ids in doesn't help either.
    assert bob.post("/api/tasks/reorder", json={"ids": [b1["id"], a1["id"]]}).status_code == 400
    assert [(t["id"], t["position"]) for t in alice.get("/api/tasks").json()] == before


def test_task_cannot_use_another_users_board(alice, bob):
    board = alice.post("/api/boards", json={"name": "alice board"}).json()
    assert bob.post("/api/tasks", json={"title": "t", "board_id": board["id"]}).status_code == 404
    b = make_task(bob)
    assert bob.patch(f"/api/tasks/{b['id']}", json={"board_id": board["id"]}).status_code == 404
    assert bob.get(f"/api/tasks/{b['id']}").json()["board_id"] is None
    # Alice can use her own board, and anyone can clear a board.
    a = make_task(alice, board_id=board["id"])
    assert a["board_id"] == board["id"]
    assert alice.patch(f"/api/tasks/{a['id']}", json={"board_id": None}).json()["board_id"] is None


def test_positions_are_per_user(alice, bob):
    """Adding to one user's today list must not renumber another's tasks."""
    for i in range(3):
        make_task(bob, title=f"b{i}", today=True)
    bob_before = [(t["id"], t["position"]) for t in bob.get("/api/tasks").json()]
    # Each of these lands above an existing open today task of Alice's,
    # which shifts the tasks below it down a slot. Only hers may move.
    make_task(alice, title="a later", today=True, deadline="2099-01-01T10:00")
    make_task(alice, title="a sooner", today=True, deadline="2000-01-01T10:00")
    a = make_task(alice, title="a promote later", deadline="1999-01-01T10:00")
    alice.patch(f"/api/tasks/{a['id']}", json={"today_flag": True})
    assert [t["title"] for t in alice.get("/api/tasks?view=today").json()] == [
        "a promote later", "a sooner", "a later",
    ]
    assert [(t["id"], t["position"]) for t in bob.get("/api/tasks").json()] == bob_before


def test_today_placement_ignores_other_users_tasks(alice, bob):
    """Where a new today task lands depends only on the caller's own list.
    Bob's later-due task sits at a low position; if Alice's placement looked
    at it, her new task would jump above her own sooner one."""
    make_task(alice, title="a backlog")
    make_task(alice, title="a soon", today=True, deadline="2000-01-01T10:00")
    make_task(alice, title="a late", today=True, deadline="2099-01-01T10:00")
    make_task(bob, title="b later", today=True, deadline="2100-01-01T10:00")
    make_task(alice, title="a middle", today=True, deadline="2050-01-01T10:00")
    assert [t["title"] for t in alice.get("/api/tasks?view=today").json()] == ["a soon", "a middle", "a late"]


def test_board_filter_with_another_users_board_shows_nothing(alice, bob):
    board = alice.post("/api/boards", json={"name": "alice board"}).json()
    make_task(alice, board_id=board["id"])
    make_task(bob)
    assert bob.get(f"/api/tasks?board_id={board['id']}").json() == []


# --- boards ---

def test_boards_are_private(alice, bob):
    alice.post("/api/boards", json={"name": "alice board"})
    assert bob.get("/api/boards").json() == []
    assert [b["name"] for b in alice.get("/api/boards").json()] == ["alice board"]


# --- rules ---

def test_rules_are_private(alice, bob):
    rule = alice.post("/api/rules", json={"text": "alice rule"}).json()
    assert bob.get("/api/rules").json() == []
    assert bob.patch(f"/api/rules/{rule['id']}", json={"active": False}).status_code == 404
    assert bob.delete(f"/api/rules/{rule['id']}").status_code == 404
    rules = alice.get("/api/rules").json()
    assert [(r["id"], r["active"]) for r in rules] == [(rule["id"], True)]


def test_rule_cap_is_per_user(alice, bob):
    for i in range(15):
        assert alice.post("/api/rules", json={"text": f"r{i}"}).status_code == 201
    assert alice.post("/api/rules", json={"text": "one too many"}).status_code == 400
    assert bob.post("/api/rules", json={"text": "bob's first"}).status_code == 201


# --- context notes ---

def test_context_notes_are_private(alice, bob):
    a = make_task(alice)
    g = alice.post("/api/context-notes", json={"scope": "global", "text": "alice away"}).json()
    t = alice.post("/api/context-notes", json={"scope": "task", "task_id": a["id"], "text": "alice note"}).json()

    assert bob.get("/api/context-notes").json() == []
    assert bob.get(f"/api/context-notes?task_id={a['id']}").json() == []
    assert bob.delete(f"/api/context-notes/{g['id']}").status_code == 404
    assert bob.delete(f"/api/context-notes/{t['id']}").status_code == 404
    assert {n["id"] for n in alice.get("/api/context-notes").json()} == {g["id"], t["id"]}


def test_cannot_attach_note_to_another_users_task(alice, bob):
    a = make_task(alice)
    for scope in ("task", "global"):
        r = bob.post("/api/context-notes", json={"scope": scope, "task_id": a["id"], "text": "x"})
        assert r.status_code == 404
    # Nothing was stored for either user.
    assert alice.get("/api/context-notes").json() == []
    assert bob.get("/api/context-notes").json() == []


# --- settings ---

def test_settings_are_per_user(alice, bob):
    # Both rows exist before Alice saves (rows are created on first read).
    assert bob.get("/api/settings").json()["work_hours_start"] == "09:00"
    assert alice.get("/api/settings").json()["work_hours_start"] == "09:00"
    r = alice.patch("/api/settings", json={"work_hours_start": "07:00", "max_daily_messages": 3})
    assert r.status_code == 200
    assert r.json()["work_hours_start"] == "07:00"
    bob_settings = bob.get("/api/settings").json()
    assert bob_settings["work_hours_start"] == "09:00"
    assert bob_settings["max_daily_messages"] == 8


def test_timezone_is_shared_and_not_user_writable(alice, bob):
    assert alice.get("/api/settings").json()["timezone"] == "America/New_York"
    assert alice.patch("/api/settings", json={"timezone": "Asia/Tokyo"}).status_code == 422
    assert bob.get("/api/settings").json()["timezone"] == "America/New_York"


# --- history and export ---

def _move_events_to_yesterday(db, task_id):
    tz = ZoneInfo("America/New_York")
    yesterday = logical_today(tz) - timedelta(days=1)
    at = (logical_day_start(yesterday, tz) + timedelta(hours=6)).astimezone(ZoneInfo("UTC")).isoformat()
    db.execute("UPDATE task_events SET created_at = ? WHERE task_id = ?", (at, task_id))
    db.commit()
    return yesterday.isoformat()


def test_history_is_private(alice, bob, db):
    a = make_task(alice, title="alice did this", today=True)
    alice.patch(f"/api/tasks/{a['id']}", json={"state": "done"})
    day = _move_events_to_yesterday(db, a["id"])

    alice_hist = alice.get(f"/api/history/{day}").json()["tasks"]
    assert [(t["title"], t["status"]) for t in alice_hist] == [("alice did this", "done")]
    assert bob.get(f"/api/history/{day}").json()["tasks"] == []


def test_export_is_private(alice, bob):
    make_task(alice, title="alice today", today=True)
    make_task(bob, title="bob backlog")
    exp = bob.get("/api/export")
    assert exp.status_code == 200
    data = exp.json()
    assert [t["title"] for t in data["tasks"]] == ["bob backlog"]
    assert data["today"] == []


# --- admin-only jobs ---

def test_manual_jobs_are_admin_only(alice, owner):
    for job in ("rollover", "sweep", "backup"):
        assert alice.post(f"/api/jobs/{job}").status_code == 403
        assert owner.post(f"/api/jobs/{job}").status_code == 200


def test_owner_is_the_only_admin_and_the_environment_cannot_add_more(monkeypatch):
    assert auth.ADMIN_DISCORD_ID == OWNER_DISCORD_ID == "416730155332009984"
    # Re-import the module with admin-looking variables set. If anything
    # read the admin id from the environment at import, it would change.
    monkeypatch.setenv("ARTURO_ADMIN_DISCORD_IDS", "1001")
    monkeypatch.setenv("ARTURO_ADMIN_DISCORD_ID", "1001")
    try:
        reloaded = importlib.reload(auth)
        assert reloaded.ADMIN_DISCORD_ID == OWNER_DISCORD_ID
    finally:
        monkeypatch.delenv("ARTURO_ADMIN_DISCORD_IDS")
        monkeypatch.delenv("ARTURO_ADMIN_DISCORD_ID")
        importlib.reload(auth)


# --- unauthenticated ---

def test_every_data_route_requires_a_session(anon):
    routes = [
        ("get", "/api/tasks"), ("post", "/api/tasks"), ("get", "/api/tasks/1"),
        ("get", "/api/tasks/1/events"), ("patch", "/api/tasks/1"), ("post", "/api/tasks/reorder"),
        ("get", "/api/boards"), ("post", "/api/boards"),
        ("get", "/api/rules"), ("post", "/api/rules"), ("patch", "/api/rules/1"), ("delete", "/api/rules/1"),
        ("get", "/api/context-notes"), ("post", "/api/context-notes"), ("delete", "/api/context-notes/1"),
        ("get", "/api/settings"), ("patch", "/api/settings"),
        ("get", "/api/history/2026-01-01"), ("get", "/api/export"),
        ("post", "/api/jobs/rollover"), ("post", "/api/jobs/sweep"), ("post", "/api/jobs/backup"),
        ("get", "/api/auth/me"),
    ]
    for method, path in routes:
        assert getattr(anon, method)(path).status_code == 401, (method, path)
    assert anon.get("/health").status_code == 200

    # Every API route the app actually serves is in the list above, except
    # the sign-in flow itself. A new route can't be added without a session
    # check going unnoticed.
    open_routes = {"/api/auth/login", "/api/auth/callback", "/api/auth/logout"}
    served = {
        (m.lower(), r.path)
        for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api/") and r.path not in open_routes
        for m in r.methods
    }
    checked = {(m, p.replace("/1", "/{x}").replace("2026-01-01", "{x}")) for m, p in routes}
    normalized = {(m, p.replace("{task_id}", "{x}").replace("{rule_id}", "{x}")
                   .replace("{note_id}", "{x}").replace("{day}", "{x}")) for m, p in served}
    assert normalized <= checked, f"routes without a 401 check: {sorted(normalized - checked)}"
