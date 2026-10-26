"""The Discord bot's task tools and conversation loop. Nothing here talks to
Discord or the Anthropic API: tools run against the test database and the
model is a scripted stand-in."""
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

from app.bot import agent
from app.bot.client import split_message
from app.bot import tools
from app.bot.tools import deadline_label, run_tool, task_snapshot
from app.clock import logical_day_start, logical_today
from app.db import now_iso


def user_of(client) -> dict:
    return {"id": client.user_id}


def test_add_task_logs_a_discord_creation(alice, db):
    out = run_tool(db, user_of(alice), "add_task", {"title": "buy milk", "today": True})
    task = out["created"]
    # The model sees a label; the stored deadline keeps the naive local format.
    assert task["today"] is True and task["deadline"].startswith("due ") and " 11:59pm (" in task["deadline"]
    row = db.execute("SELECT source, user_id, deadline FROM tasks WHERE id = ?", (task["id"],)).fetchone()
    assert (row["source"], row["user_id"]) == ("discord", alice.user_id)
    assert row["deadline"].endswith("T23:59")
    events = [e["event_type"] for e in alice.get(f"/api/tasks/{task['id']}/events").json()]
    assert events == ["promoted", "created"]


def test_add_task_to_backlog(alice, db):
    task = run_tool(db, user_of(alice), "add_task", {"title": "someday", "today": False})["created"]
    assert task["today"] is False and "deadline" not in task


def test_list_tasks_only_shows_the_callers_tasks(alice, bob, db):
    for today in (True, False):
        run_tool(db, user_of(alice), "add_task", {"title": "alice's", "today": today})
        run_tool(db, user_of(bob), "add_task", {"title": "bob's", "today": today})
    for view in ("today", "backlog"):
        listed = run_tool(db, user_of(alice), "list_tasks", {"view": view})
        assert [t["title"] for t in listed["tasks"]] == ["alice's"]


def test_complete_task_cannot_reach_another_users_task(alice, bob, db):
    theirs = run_tool(db, user_of(bob), "add_task", {"title": "bob's", "today": True})["created"]
    out = run_tool(db, user_of(alice), "complete_task", {"task_id": theirs["id"]})
    assert out == {"error": "Task not found"}
    assert bob.get(f"/api/tasks/{theirs['id']}").json()["state"] == "not_started"


def test_complete_task(alice, db):
    mine = run_tool(db, user_of(alice), "add_task", {"title": "essay", "today": True})["created"]
    assert run_tool(db, user_of(alice), "complete_task", {"task_id": mine["id"]})["completed"]["state"] == "done"
    task = alice.get(f"/api/tasks/{mine['id']}").json()
    assert task["state"] == "done" and task["completed_at"]


def test_remove_task_drops_it_from_every_list(alice, db):
    mine = run_tool(db, user_of(alice), "add_task", {"title": "never mind", "today": True})["created"]
    assert run_tool(db, user_of(alice), "remove_task", {"task_id": mine["id"]})["removed"]["state"] == "dropped"
    for view in ("today", "backlog"):
        assert run_tool(db, user_of(alice), "list_tasks", {"view": view})["tasks"] == []
    events = [e["event_type"] for e in alice.get(f"/api/tasks/{mine['id']}/events").json()]
    assert events[0] == "dropped"


def test_remove_task_cannot_reach_another_users_task(alice, bob, db):
    theirs = run_tool(db, user_of(bob), "add_task", {"title": "bob's", "today": True})["created"]
    assert run_tool(db, user_of(alice), "remove_task", {"task_id": theirs["id"]}) == {"error": "Task not found"}
    assert bob.get(f"/api/tasks/{theirs['id']}").json()["state"] == "not_started"


def test_bot_changes_are_tagged_in_the_event_log(alice, db):
    done = run_tool(db, user_of(alice), "add_task", {"title": "done by bot", "today": True})["created"]
    gone = run_tool(db, user_of(alice), "add_task", {"title": "removed by bot", "today": True})["created"]
    run_tool(db, user_of(alice), "complete_task", {"task_id": done["id"]})
    run_tool(db, user_of(alice), "remove_task", {"task_id": gone["id"]})
    for task in (done, gone):
        events = alice.get(f"/api/tasks/{task['id']}/events").json()
        assert {e["payload"]["source"] for e in events} == {"discord"}
    # The extra payload key doesn't change how a day is rebuilt. History
    # only serves past days, so the events move to yesterday morning.
    tz = ZoneInfo("America/New_York")
    yesterday = logical_today(tz) - timedelta(days=1)
    at = (logical_day_start(yesterday, tz) + timedelta(hours=6)).astimezone(timezone.utc).isoformat()
    db.execute("UPDATE task_events SET created_at = ?", (at,))
    db.commit()
    day = alice.get(f"/api/history/{yesterday.isoformat()}").json()
    status = {t["title"]: t["status"] for t in day["tasks"]}
    assert status.get("done by bot") == "done" and "removed by bot" not in status


def test_bad_tool_input_is_an_error_result(alice, db):
    out = run_tool(db, user_of(alice), "add_task", {"title": "x", "today": False, "deadline": "next tuesday"})
    assert "deadline" in out["error"]
    assert "error" in run_tool(db, user_of(alice), "add_task", {"title": "", "today": False})
    assert "error" in run_tool(db, user_of(alice), "complete_task", {"task_id": "7"})
    assert "error" in run_tool(db, user_of(alice), "list_tasks", {"view": "all"})
    assert "error" in run_tool(db, user_of(alice), "drop_table", {})
    assert alice.get("/api/tasks").json() == []


def test_daily_cap_counts_only_todays_incoming_messages(alice, bob, db):
    yesterday = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    rows = [
        (alice.user_id, "in", now_iso()),
        (alice.user_id, "in", now_iso()),
        (alice.user_id, "out", now_iso()),
        (alice.user_id, "in", yesterday),
        (bob.user_id, "in", now_iso()),
    ]
    db.executemany("INSERT INTO messages (user_id, direction, content, created_at) VALUES (?, ?, 'hi', ?)", rows)
    db.commit()
    assert agent.messages_today(alice.user_id) == 2


def test_snapshot_lists_only_the_callers_open_tasks(alice, bob, db):
    run_tool(db, user_of(alice), "add_task", {"title": "gym", "today": True})
    later = run_tool(db, user_of(alice), "add_task", {"title": "taxes", "today": False, "deadline": "2026-11-15"})
    gone = run_tool(db, user_of(alice), "add_task", {"title": "dropped one", "today": True})["created"]
    run_tool(db, user_of(alice), "remove_task", {"task_id": gone["id"]})
    run_tool(db, user_of(bob), "add_task", {"title": "bob's secret", "today": True})

    snap, titles = task_snapshot(db, user_of(alice), now=SUNDAY_EVENING)
    assert sorted(titles) == ["gym", "taxes"]
    today, backlog = snap.split("All tasks")
    assert '"gym"' in today and "taxes" not in today
    assert f'id {later["created"]["id"]}: "taxes", due Sun 11/15 (in 21 days)' in backlog
    assert "dropped one" not in snap and "bob" not in snap


# Sunday 10/25/2026, 8:16pm Eastern: the evening the bot called Tuesday
# 10/27 "tomorrow, Monday".
SUNDAY_EVENING = datetime(2026, 10, 25, 20, 16, tzinfo=ZoneInfo("America/New_York"))


def test_deadline_labels_do_the_date_math():
    tz, now = ZoneInfo("America/New_York"), SUNDAY_EVENING
    assert deadline_label("2026-10-27T23:59", tz, now) == "due Tue 10/27 11:59pm (in 2 days)"
    assert deadline_label("2026-10-26", tz, now) == "due Mon 10/26 (tomorrow)"
    assert deadline_label("2026-10-25T23:59", tz, now) == "due Sun 10/25 11:59pm (today)"
    assert deadline_label("2026-10-25T09:00", tz, now) == "due Sun 10/25 9:00am (today, overdue)"
    assert deadline_label("2026-10-14", tz, now) == "due Wed 10/14 (11 days ago, overdue)"
    assert deadline_label("2027-01-03T08:30", tz, now) == "due Sun 1/3/2027 8:30am (in 70 days)"
    # Before 4am it is still the previous logical day.
    assert deadline_label("2026-10-26T01:30", tz, now) == "due Mon 10/26 1:30am (tonight)"
    one_am_monday = datetime(2026, 10, 26, 1, 0, tzinfo=tz)
    assert deadline_label("2026-10-26T23:59", tz, one_am_monday) == "due Mon 10/26 11:59pm (tomorrow)"
    # An offset is converted to local time; junk is passed through.
    assert deadline_label("2026-10-27T03:59:00+00:00", tz, now) == "due Mon 10/26 11:59pm (tomorrow)"
    assert deadline_label("someday", tz, now) == "due someday"


def test_system_prompt_has_a_calendar():
    prompt = agent.system_prompt(ZoneInfo("America/New_York"))
    today = logical_today(ZoneInfo("America/New_York"))
    friday = next(today + timedelta(days=n) for n in range(7) if (today + timedelta(days=n)).weekday() == 4)
    assert f"Fri {friday.isoformat()}" in prompt


def test_today_counts_finished_tasks(alice, db):
    ids = [run_tool(db, user_of(alice), "add_task", {"title": t, "today": True})["created"]["id"] for t in "abc"]
    run_tool(db, user_of(alice), "complete_task", {"task_id": ids[0]})
    assert "Finished today: 1 of 3" in task_snapshot(db, user_of(alice))[0]
    listed = run_tool(db, user_of(alice), "list_tasks", {"view": "today"})
    assert (listed["done"], listed["total"]) == (1, 3)


def test_lists_follow_dashboard_order(alice, db):
    """Today: drag order, finished tasks sunk, recurring in their own
    section. All tasks: soonest deadline first, undated last by position.
    The same rules as frontend src/app/page.tsx."""
    def add(title, **body):
        r = alice.post("/api/tasks", json={"title": title, **body})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    first = add("first", today=True)
    finished = add("finished", today=True)
    add("second", today=True)
    add("daily", recurring=True)
    # Drag order on the dashboard: first, finished, second.
    order = [t["id"] for t in alice.get("/api/tasks?view=today").json() if not t["recurring"]]
    order.remove(first)
    order.remove(finished)
    alice.post("/api/tasks/reorder", json={"ids": [first, finished, *order]})
    alice.patch(f"/api/tasks/{finished}", json={"state": "done"})

    add("undated b")
    add("dec", deadline="2026-12-01")
    add("undated a")
    alice.post("/api/tasks/reorder", json={"ids": [
        t["id"] for t in sorted(alice.get("/api/tasks?view=backlog").json(), key=lambda t: t["title"])
        if not t["today_flag"]
    ]})
    add("nov", deadline="2026-11-15T09:00")

    today = run_tool(db, user_of(alice), "list_tasks", {"view": "today"})
    assert [t["title"] for t in today["tasks"]] == ["first", "second", "finished"]
    assert [t["title"] for t in today["recurring"]] == ["daily"]
    assert (today["done"], today["total"]) == (1, 4)
    backlog = run_tool(db, user_of(alice), "list_tasks", {"view": "backlog"})
    assert [t["title"] for t in backlog["tasks"]] == ["nov", "dec", "undated a", "undated b"]

    snap, _ = task_snapshot(db, user_of(alice))
    titles = [line.split('"')[1] for line in snap.splitlines() if line.startswith("- ")]
    assert titles == ["first", "second", "finished", "daily", "nov", "dec", "undated a", "undated b"]


def test_snapshot_is_capped(alice, db, monkeypatch):
    monkeypatch.setattr(tools, "MAX_LISTED", 2)
    for title in "abc":
        run_tool(db, user_of(alice), "add_task", {"title": title, "today": False})
    snap, _ = task_snapshot(db, user_of(alice))
    assert snap.count("- id ") == 2 and "1 more not shown" in snap


def test_casual_case_keeps_task_titles():
    titles = {"Complete 1 NeetCode problem", "Work out"}
    reply = "Here's what's left:\n\n- Complete 1 NeetCode problem\n- ~~Work out~~\n\nDone 1/2. Nice! Amazon is due Wed."
    assert agent.casual_case(reply, titles) == (
        "here's what's left:\n\n- Complete 1 NeetCode problem\n- ~~Work out~~\n\ndone 1/2. nice! amazon is due Wed."
    )
    assert agent.casual_case("Wait, I think I'll ask: Call I.R.S (id 12)?", {"Call I.R.S"}) == (
        "wait, i think i'll ask: Call I.R.S?"
    )
    # Bullets get a title's own capitals back; prose is left as the model wrote it.
    titles = {"Build nightstand", "Buy Halloween costume", "Work out"}
    reply = "- build nightstand\n- ~~work out~~\n- buy halloween costume, due Sun 10/25\n\ngo work out lol"
    assert agent.casual_case(reply, titles) == (
        "- Build nightstand\n- ~~Work out~~\n- Buy Halloween costume, due Sun 10/25\n\ngo work out lol"
    )


def test_split_message():
    assert split_message("short") == ["short"]
    text = "\n".join(["x" * 30] * 10)
    chunks = split_message(text, limit=100)
    assert all(len(c) <= 100 for c in chunks)
    assert "\n".join(chunks) == text
    assert split_message("y" * 250, limit=100) == ["y" * 100, "y" * 100, "y" * 50]


class ScriptedLLM:
    """Stands in for AsyncAnthropic: returns canned responses in order and
    keeps every request it was sent."""

    def __init__(self, *responses: Message):
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.messages = self

    async def create(self, **kwargs):
        # Copy the list: the loop appends to it after this call returns.
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.responses.pop(0)


def reply(stop_reason: str, *content) -> Message:
    return Message.model_construct(
        id="msg", type="message", role="assistant", model=agent.MODEL, content=list(content),
        stop_reason=stop_reason, stop_sequence=None, usage=Usage(input_tokens=10, output_tokens=5),
    )


def test_respond_runs_tools_and_records_the_exchange(alice, db):
    llm = ScriptedLLM(
        reply("tool_use", ToolUseBlock.model_construct(
            type="tool_use", id="tu1", name="add_task", input={"title": "buy milk", "today": True},
        )),
        reply("end_turn", TextBlock.model_construct(type="text", text="Added **buy milk** to today.")),
    )
    out = asyncio.run(agent.respond(llm, user_of(alice), "555", "add buy milk for today"))
    assert out == "added **buy milk** to today."
    snapshot, said = llm.requests[0]["messages"][-1]["content"]
    assert "Today: (empty)" in snapshot["text"] and said["text"] == "add buy milk for today"

    titles = [t["title"] for t in alice.get("/api/tasks?view=today").json()]
    assert titles == ["buy milk"]
    # The tool result went back to the model on the second request.
    tool_result = llm.requests[1]["messages"][-1]["content"][0]
    assert tool_result["tool_use_id"] == "tu1" and not tool_result["is_error"]

    msgs = db.execute("SELECT user_id, direction, discord_id, content, llm_call_id FROM messages ORDER BY id").fetchall()
    assert [(m["user_id"], m["direction"]) for m in msgs] == [(alice.user_id, "in"), (alice.user_id, "out")]
    assert msgs[0]["discord_id"] == "555" and msgs[1]["content"] == out
    call = db.execute("SELECT * FROM llm_calls WHERE id = ?", (msgs[1]["llm_call_id"],)).fetchone()
    assert (call["purpose"], call["input_tokens"], call["output_tokens"]) == ("discord_reply", 20, 10)


def test_respond_sends_recent_history(alice):
    first = ScriptedLLM(reply("end_turn", TextBlock.model_construct(type="text", text="Hi!")))
    asyncio.run(agent.respond(first, user_of(alice), "1", "hello"))
    second = ScriptedLLM(reply("end_turn", TextBlock.model_construct(type="text", text="Sure.")))
    asyncio.run(agent.respond(second, user_of(alice), "2", "thanks"))
    # Past turns carry only what was said; the task list rides on the newest.
    *past, newest = second.requests[0]["messages"]
    assert past == [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi!"}]
    assert newest["content"][1]["text"] == "thanks"


def test_history_is_per_user(alice, bob):
    asyncio.run(agent.respond(
        ScriptedLLM(reply("end_turn", TextBlock.model_construct(type="text", text="ok"))),
        user_of(bob), "1", "bob's secret",
    ))
    llm = ScriptedLLM(reply("end_turn", TextBlock.model_construct(type="text", text="ok")))
    asyncio.run(agent.respond(llm, user_of(alice), "2", "hi"))
    (only,) = llm.requests[0]["messages"]
    assert "bob" not in str(only) and only["content"][1]["text"] == "hi"
