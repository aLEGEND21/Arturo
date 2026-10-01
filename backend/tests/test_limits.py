"""Input bounds and per-user caps. Sign-up is open to any Discord account,
so bad or oversized input must get a clean 4xx and can't hurt anyone else."""
import threading

import pytest

from app.routers import misc, tasks


def make_task(client, **body):
    r = client.post("/api/tasks", json={"title": "task", **body})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.parametrize(
    "value",
    [
        "9999-12-31T23:59:59-12:00",  # would overflow when converted to Eastern time
        "0001-01-01T00:00:00+14:00",
        "1899-12-31",
        "2201-01-01T00:00",
        "not a date",
        "2026-13-01",
        "2026-10-01T10:00" + "0" * 50,  # too long
    ],
)
def test_bad_timestamps_are_rejected(alice, value):
    assert alice.post("/api/tasks", json={"title": "t", "deadline": value}).status_code == 422
    t = make_task(alice)
    for field in ("deadline", "commitment_at", "snooze_until"):
        assert alice.patch(f"/api/tasks/{t['id']}", json={field: value}).status_code == 422
    assert alice.post("/api/context-notes", json={"scope": "global", "text": "x", "expires_at": value}).status_code == 422


@pytest.mark.parametrize(
    "value",
    ["2026-10-01T18:00", "2026-10-01", "2026-10-01T18:00:00+00:00", "2026-10-01T18:00:00-04:00", "", None],
)
def test_normal_timestamps_are_accepted(alice, value):
    t = make_task(alice)
    assert alice.patch(f"/api/tasks/{t['id']}", json={"deadline": value}).status_code == 200


def test_null_for_required_task_fields_is_a_422_not_a_500(alice):
    t = make_task(alice, title="keep")
    for field in ("title", "starred", "recurring"):
        assert alice.patch(f"/api/tasks/{t['id']}", json={field: None}).status_code == 422
    after = alice.get(f"/api/tasks/{t['id']}").json()
    assert (after["title"], after["starred"], after["recurring"]) == ("keep", False, False)
    # Nullable fields can still be cleared.
    assert alice.patch(f"/api/tasks/{t['id']}", json={"notes": None, "board_id": None}).status_code == 200


def test_settings_reject_nulls_and_malformed_values(alice):
    for body in (
        {"quiet_start": None}, {"max_daily_messages": None},
        {"work_hours_start": "25:00"}, {"quiet_end": "9am"},
        {"max_daily_messages": -1}, {"min_gap_minutes": 100_000},
    ):
        assert alice.patch("/api/settings", json=body).status_code == 422, body
    assert alice.patch("/api/settings", json={"quiet_start": "22:15"}).json()["quiet_start"] == "22:15"


def test_text_lengths_are_bounded(alice):
    t = make_task(alice)
    assert alice.patch(f"/api/tasks/{t['id']}", json={"notes": "x" * 10_000}).status_code == 200
    assert alice.patch(f"/api/tasks/{t['id']}", json={"notes": "x" * 10_001}).status_code == 422
    assert alice.post("/api/tasks", json={"title": "x" * 501}).status_code == 422
    assert alice.post("/api/boards", json={"name": "b", "color": "x" * 33}).status_code == 422


def test_reorder_list_is_capped(alice):
    assert alice.post("/api/tasks/reorder", json={"ids": list(range(1, 5002))}).status_code == 422


def test_task_cap(alice, bob, monkeypatch):
    monkeypatch.setattr(tasks, "MAX_TASKS", 3)
    for _ in range(3):
        make_task(alice)
    r = alice.post("/api/tasks", json={"title": "one too many"})
    assert r.status_code == 400 and "Limit reached" in r.json()["detail"]
    make_task(bob)  # per user: Bob is unaffected


def test_board_rule_and_note_caps(alice, bob, monkeypatch):
    monkeypatch.setattr(misc, "MAX_BOARDS", 2)
    monkeypatch.setattr(misc, "MAX_RULES", 2)
    monkeypatch.setattr(misc, "MAX_ACTIVE_NOTES", 2)
    for _ in range(2):
        alice.post("/api/boards", json={"name": "b"})
        alice.post("/api/context-notes", json={"scope": "global", "text": "n"})
    assert alice.post("/api/boards", json={"name": "b"}).status_code == 400
    assert alice.post("/api/context-notes", json={"scope": "global", "text": "n"}).status_code == 400

    # Rules count whether active or not, so create-and-deactivate can't
    # grow the table without bound.
    for _ in range(2):
        rule = alice.post("/api/rules", json={"text": "r"}).json()
        alice.patch(f"/api/rules/{rule['id']}", json={"active": False})
    assert alice.post("/api/rules", json={"text": "r"}).status_code == 400

    # Dismissed notes free their slot.
    note_id = alice.get("/api/context-notes").json()[0]["id"]
    alice.delete(f"/api/context-notes/{note_id}")
    assert alice.post("/api/context-notes", json={"scope": "global", "text": "n"}).status_code == 201

    assert bob.post("/api/boards", json={"name": "b"}).status_code == 201


def test_concurrent_creates_get_distinct_positions(alice):
    """Requests on separate threads each read positions and then write. The
    write lock makes them take turns, so no two tasks share a slot."""
    errors = []

    def create(n):
        for i in range(8):
            r = alice.post("/api/tasks", json={"title": f"t{n}-{i}", "today": True, "deadline": "2099-01-01T10:00"})
            if r.status_code != 201:
                errors.append(r.status_code)

    threads = [threading.Thread(target=create, args=(n,)) for n in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    positions = [t["position"] for t in alice.get("/api/tasks").json()]
    assert len(positions) == 96
    assert len(set(positions)) == 96
