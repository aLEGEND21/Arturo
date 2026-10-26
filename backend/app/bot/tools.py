"""The task tools Claude may call while answering a DM.

Each tool calls the dashboard's own route handlers, so positions, events,
deadline defaults, caps and input bounds behave exactly as they do on the
web. Change a handler and the bot changes with it.

The user is always the account behind the Discord author id, resolved
before the model runs. Nothing the model sends can name a user, so a
message (or a task title written by someone else) can't steer a tool at
another account's data."""
import json
import sqlite3
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import ValidationError

from ..clock import logical_date
from ..db import app_timezone
from ..routers import tasks
from ..schemas import TaskCreate, TaskUpdate

# A long backlog would cost tokens on every listing for little benefit; the
# dashboard is the place to browse everything.
MAX_LISTED = 100

TOOLS = [
    {
        "name": "list_tasks",
        "description": (
            "List the user's tasks in dashboard order. 'today' is their today list (including "
            "tasks already done today, plus recurring tasks separately); 'backlog' is the All "
            "tasks list: open tasks not on today, soonest due first. The newest message already "
            "has both lists, so only call this when that list was cut short."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"view": {"type": "string", "enum": ["today", "backlog"]}},
            "required": ["view"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_task",
        "description": (
            "Create a task. Set today=true when the user wants it on today's list (they say today, "
            "tonight, now, or it is due today); otherwise it goes to the backlog. A today task "
            "without a deadline is due 11:59 PM today automatically."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short task title, at most 500 characters."},
                "today": {"type": "boolean"},
                "deadline": {
                    "type": "string",
                    "description": "Local Eastern time as YYYY-MM-DDTHH:MM, or a bare YYYY-MM-DD. No offset.",
                },
                "effort": {"type": "string", "enum": ["short", "medium", "long"]},
                "notes": {"type": "string"},
            },
            "required": ["title", "today"],
            "additionalProperties": False,
        },
    },
    {
        "name": "complete_task",
        "description": "Mark one of the user's tasks as done, by id.",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "integer"}},
            "required": ["task_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "remove_task",
        "description": (
            "Remove one of the user's tasks, by id, when they want it gone without doing it "
            "(remove, delete, drop, cancel, never mind). It leaves every list. Use complete_task "
            "instead when they finished it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "integer"}},
            "required": ["task_id"],
            "additionalProperties": False,
        },
    },
]


def _clock_time(dt: datetime) -> str:
    return f"{dt.hour % 12 or 12}:{dt.minute:02d}{'am' if dt.hour < 12 else 'pm'}"


def relative_day(d: date, today: date) -> str:
    n = (d - today).days
    if n == 0:
        return "today"
    if n == 1:
        return "tomorrow"
    if n == -1:
        return "yesterday"
    return f"in {n} days" if n > 0 else f"{-n} days ago"


def deadline_label(deadline: str, tz: ZoneInfo, now: datetime | None = None) -> str:
    """A deadline spelled out for the model: weekday, date, time, and how far
    away it is, like "Tue 10/27 11:59pm (in 2 days)". The model was asked to
    derive weekdays and "tomorrow" from raw strings and got them wrong, so
    all date math happens here. Days are logical days (the 4am boundary), as
    everywhere else in the app."""
    local_now = (now or datetime.now(tz)).astimezone(tz).replace(tzinfo=None)
    today = logical_date(local_now, tz)
    try:
        if "T" in deadline:
            at = datetime.fromisoformat(deadline)
            # Deadlines are naive local strings; one with an offset (allowed
            # by the API) is shown in local time like the rest.
            if at.tzinfo is not None:
                at = at.astimezone(tz).replace(tzinfo=None)
            # Shown with its calendar date, but "today"/"tomorrow" follow
            # the logical day: 1am Monday is still Sunday night.
            shown_day, day, time, overdue = at.date(), logical_date(at, tz), _clock_time(at), at < local_now
        else:
            shown_day = day = date.fromisoformat(deadline)
            time, overdue = None, day < today
    except ValueError:
        return f"due {deadline}"
    shown = f"{shown_day:%a} {shown_day.month}/{shown_day.day}"
    if shown_day.year != today.year:
        shown += f"/{shown_day.year}"
    relative = "tonight" if day == today and shown_day != day else relative_day(day, today)
    when = relative + (", overdue" if overdue else "")
    return f"due {shown}" + (f" {time}" if time else "") + f" ({when})"


def _tz(conn: sqlite3.Connection) -> ZoneInfo:
    return ZoneInfo(app_timezone(conn))


def _brief(task: dict, tz: ZoneInfo) -> dict:
    out = {"id": task["id"], "title": task["title"], "state": task["state"], "today": task["today_flag"]}
    if task["deadline"]:
        out["deadline"] = deadline_label(task["deadline"], tz)
    if task["recurring"]:
        out["recurring"] = True
    return out


def _list(conn: sqlite3.Connection, user: dict, args: dict) -> dict:
    view = args.get("view")
    if view not in ("today", "backlog"):
        return {"error": "view must be 'today' or 'backlog'"}
    if view == "backlog":
        rows = dashboard_backlog(conn, user)
        return {"view": view, "tasks": [_brief(t, _tz(conn)) for t in rows[:MAX_LISTED]], "total": len(rows)}
    regular, recurring = dashboard_today(conn, user)
    return {
        "view": view,
        "tasks": [_brief(t, _tz(conn)) for t in regular[:MAX_LISTED]],
        "done": sum(t["state"] == "done" for t in regular + recurring),
        "total": len(regular) + len(recurring),
        "recurring": [_brief(t, _tz(conn)) for t in recurring],
    }


def dashboard_today(conn: sqlite3.Connection, user: dict) -> tuple[list[dict], list[dict]]:
    """Today's list in the dashboard's display order: regular tasks by
    position with finished ones sunk to the bottom, and recurring tasks as
    their own section. Mirrors `regular`/`recurring` in frontend
    src/app/page.tsx; change both together."""
    rows = tasks.list_tasks(user=user, view="today", board_id=None, conn=conn)
    regular = [t for t in rows if not t["recurring"]]
    regular = [t for t in regular if t["state"] != "done"] + [t for t in regular if t["state"] == "done"]
    return regular, [t for t in rows if t["recurring"]]


def dashboard_backlog(conn: sqlite3.Connection, user: dict) -> list[dict]:
    """The dashboard's All tasks column: open tasks not on today, soonest
    deadline first, then undated ones in position order. Mirrors `backlog`
    in frontend src/app/page.tsx, which compares the naive local deadline
    strings lexically; the stable sort keeps position order for ties."""
    rows = tasks.list_tasks(user=user, view="backlog", board_id=None, conn=conn)
    rows = [t for t in rows if not t["recurring"] and not t["today_flag"]]
    return sorted(rows, key=lambda t: (t["deadline"] is None, t["deadline"] or ""))


def task_snapshot(conn: sqlite3.Connection, user: dict, now: datetime | None = None) -> tuple[str, list[str]]:
    """The user's lists in dashboard order, one task per line, sent with
    each message, plus every title in it. Having them up front saves a
    list_tasks round trip on most messages, which is most of the bot's
    latency."""
    regular, recurring = dashboard_today(conn, user)
    backlog = dashboard_backlog(conn, user)
    tz = _tz(conn)

    def line(t: dict) -> str:
        # Titles are JSON-quoted so a newline or bracket in one can't pass
        # for another line of the list.
        parts = [f"id {t['id']}: {json.dumps(t['title'])}"]
        if t["state"] != "not_started":
            parts.append(t["state"])
        if t["deadline"]:
            parts.append(deadline_label(t["deadline"], tz, now))
        return "- " + ", ".join(parts)

    # Counted here, not left to the model, so "done x/y" is always right.
    # One number for everything on today; a count per section gave the model
    # two to choose between, and it mixed them up.
    on_today = regular + recurring
    finished = sum(t["state"] == "done" for t in on_today)
    sections = [
        ("Today:", "Today: (empty)", regular),
        ("Recurring, also on today:", None, recurring),
        ("All tasks (open, not on today), soonest due first:", "All tasks: (empty)", backlog),
    ]
    out, room, hidden = [f"Finished today: {finished} of {len(on_today)}"], MAX_LISTED, 0
    for header, empty, rows in sections:
        if not rows:
            if empty:
                out.append(empty)
            continue
        out.append(header)
        out += [line(t) for t in rows[:room]]
        hidden += max(len(rows) - room, 0)
        room = max(room - len(rows), 0)
    if hidden:
        out.append(f"({hidden} more not shown; call list_tasks to see them)")
    return "\n".join(out), [t["title"] for t in on_today + backlog]


def _add(conn: sqlite3.Connection, user: dict, args: dict) -> dict:
    body = TaskCreate(
        title=args.get("title"),
        today=bool(args.get("today", False)),
        deadline=args.get("deadline") or None,
        effort=args.get("effort") or None,
        notes=args.get("notes") or None,
        source="discord",
    )
    return {"created": _brief(tasks.create_task(body, user, conn), _tz(conn))}


def _complete(conn: sqlite3.Connection, user: dict, args: dict) -> dict:
    task_id = args.get("task_id")
    if not isinstance(task_id, int):
        return {"error": "task_id must be an integer"}
    task = tasks.apply_task_update(conn, task_id, TaskUpdate(state="done"), user["id"], "discord")
    return {"completed": _brief(task, _tz(conn))}


def _remove(conn: sqlite3.Connection, user: dict, args: dict) -> dict:
    # Removing is the dashboard's Drop: the task leaves every list, but its
    # row and events stay so day history still shows what happened.
    task_id = args.get("task_id")
    if not isinstance(task_id, int):
        return {"error": "task_id must be an integer"}
    task = tasks.apply_task_update(conn, task_id, TaskUpdate(state="dropped"), user["id"], "discord")
    return {"removed": _brief(task, _tz(conn))}


_HANDLERS = {"list_tasks": _list, "add_task": _add, "complete_task": _complete, "remove_task": _remove}


def run_tool(conn: sqlite3.Connection, user: dict, name: str, args: dict) -> dict:
    """Run one tool for `user`. Failures come back as {"error": ...} for the
    model to relay; another user's task reads as not found, like on the API."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool {name}"}
    try:
        return handler(conn, user, args)
    except HTTPException as e:
        return {"error": e.detail}
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())
        return {"error": f"invalid input: {problems}"}
