"""Single-user behavior that must survive the multi-user change: list
placement, state transitions and their events, reorder, rollover."""
from datetime import datetime
from zoneinfo import ZoneInfo

from app.jobs.maintenance import run_rollover


def make_task(client, **body):
    r = client.post("/api/tasks", json={"title": "task", **body})
    assert r.status_code == 201, r.text
    return r.json()


def titles(client, view="today"):
    return [t["title"] for t in client.get(f"/api/tasks?view={view}").json() if not t["recurring"]]


def test_new_today_task_goes_to_top_below_sooner_deadlines(alice):
    make_task(alice, title="later", today=True, deadline="2099-01-02T10:00")
    make_task(alice, title="soon", today=True, deadline="2000-01-01T10:00")
    make_task(alice, title="new", today=True, deadline="2099-01-01T10:00")
    assert titles(alice) == ["soon", "new", "later"]


def test_today_task_defaults_to_end_of_day_deadline(alice):
    tz = ZoneInfo("America/New_York")
    before = datetime.now(tz).strftime("%Y-%m-%d")
    t = make_task(alice, today=True)
    after = datetime.now(tz).strftime("%Y-%m-%d")
    # Either side of midnight, if the request happened to straddle it.
    assert t["deadline"] in {f"{before}T23:59", f"{after}T23:59"}
    assert make_task(alice)["deadline"] is None


def test_state_transitions_and_events(alice):
    t = make_task(alice, today=True)
    done = alice.patch(f"/api/tasks/{t['id']}", json={"state": "done"}).json()
    assert done["state"] == "done" and done["completed_at"]
    undone = alice.patch(f"/api/tasks/{t['id']}", json={"state": "in_progress"}).json()
    assert undone["completed_at"] is None
    dropped = alice.patch(f"/api/tasks/{t['id']}", json={"state": "dropped"}).json()
    assert dropped["today_flag"] is False
    types = [e["event_type"] for e in alice.get(f"/api/tasks/{t['id']}/events").json()]
    assert types == ["dropped", "state_changed", "completed", "promoted", "created"]


def test_backlog_origin_flag(alice):
    assert make_task(alice)["backlog_origin"] is True
    assert make_task(alice, today=True)["backlog_origin"] is False


def test_reorder_reuses_position_slots(alice):
    a, b, c = (make_task(alice, title=n) for n in "abc")
    slots = sorted(t["position"] for t in (a, b, c))
    assert alice.post("/api/tasks/reorder", json={"ids": [c["id"], a["id"], b["id"]]}).status_code == 200
    by_id = {t["id"]: t["position"] for t in alice.get("/api/tasks").json()}
    assert [by_id[c["id"]], by_id[a["id"]], by_id[b["id"]]] == slots


def test_rule_cap_and_toggle(alice):
    rule = alice.post("/api/rules", json={"text": "r"}).json()
    assert alice.patch(f"/api/rules/{rule['id']}", json={"active": False}).json()["active"] is False
    assert alice.delete(f"/api/rules/{rule['id']}").json() == {"ok": True}
    assert alice.get("/api/rules").json() == []


def test_task_note_requires_task_id(alice):
    r = alice.post("/api/context-notes", json={"scope": "task", "text": "x"})
    assert r.status_code == 400


def test_rollover_promotes_and_orders_within_each_user(alice, bob):
    today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    for n in ("a1", "a2", "a3"):
        make_task(alice, title=n)
    alice_before = [(t["id"], t["position"]) for t in alice.get("/api/tasks").json()]
    make_task(bob, title="b-not-due")
    make_task(bob, title="b-due-today", deadline=f"{today}T18:00")
    make_task(bob, title="b-overdue", deadline="2000-01-01T09:00")

    stats = run_rollover()
    assert stats["promoted"] == 2

    # Bob's promotions land at the top of his list, in promotion order...
    bob_all = bob.get("/api/tasks").json()
    assert [t["title"] for t in bob_all] == ["b-due-today", "b-overdue", "b-not-due"]
    assert [t["position"] for t in bob_all] == [1, 2, 3]
    assert {t["title"] for t in bob_all if t["today_flag"]} == {"b-due-today", "b-overdue"}
    # ...and Alice, with nothing to promote, keeps her exact positions.
    assert [(t["id"], t["position"]) for t in alice.get("/api/tasks").json()] == alice_before


def test_rollover_with_promotions_for_several_users(alice, bob):
    """Both users get promotions: each list is numbered from 1 on its own,
    with that user's promotions first, in backlog order."""
    today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    make_task(alice, title="a-keep")
    make_task(alice, title="a-due", deadline=f"{today}T09:00")
    make_task(bob, title="b-overdue", deadline="2001-01-01T09:00")
    make_task(bob, title="b-keep")
    make_task(bob, title="b-due", deadline=f"{today}T20:00")
    run_rollover()
    for client, expected in ((alice, ["a-due", "a-keep"]), (bob, ["b-overdue", "b-due", "b-keep"])):
        rows = client.get("/api/tasks").json()
        assert [t["title"] for t in rows] == expected
        assert [t["position"] for t in rows] == list(range(1, len(expected) + 1))


def test_rollover_survives_a_bad_stored_timestamp(alice, bob, db):
    """A malformed or out-of-range timestamp already in the database skips
    that one task; the rollover still runs for everyone else."""
    bad = make_task(bob, title="bad")
    db.execute(
        "UPDATE tasks SET deadline = '9999-12-31T23:59:59-12:00', commitment_at = 'garbage' WHERE id = ?",
        (bad["id"],),
    )
    db.commit()
    overdue = make_task(alice, title="overdue", deadline="2000-01-01T09:00")
    run_rollover()
    assert alice.get(f"/api/tasks/{overdue['id']}").json()["today_flag"] is True
    assert bob.get(f"/api/tasks/{bad['id']}").json()["today_flag"] is False


def test_rollover_resets_recurring_and_counts_streaks(alice):
    r = make_task(alice, title="habit", recurring=True)
    alice.patch(f"/api/tasks/{r['id']}", json={"state": "done"})
    run_rollover()
    t = alice.get(f"/api/tasks/{r['id']}").json()
    assert (t["state"], t["streak"], t["today_flag"]) == ("not_started", 1, True)
