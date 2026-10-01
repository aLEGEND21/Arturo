import json
import sqlite3
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..clock import logical_date, logical_day_start, logical_today
from ..auth import CurrentUser
from ..db import (
    MAX_ACTIVE_NOTES,
    MAX_BOARDS,
    MAX_RULES,
    app_timezone,
    db_dep,
    now_iso,
    require_room,
)
from ..schemas import (
    BoardCreate,
    ContextNoteCreate,
    RuleCreate,
    RuleUpdate,
    SettingsUpdate,
)
from .tasks import TASK_SELECT, fetch_task, row_to_task

router = APIRouter(prefix="/api", tags=["misc"])

# Every query here is scoped to the signed-in user, and another user's row
# is reported as not found (404) rather than forbidden.

# Per-user preferences (the bot's work and quiet hours, message limits).
USER_SETTINGS_FIELDS = (
    "work_hours_start", "work_hours_end", "quiet_start", "quiet_end",
    "max_daily_messages", "min_gap_minutes",
)


# --- boards ---

@router.get("/boards")
def list_boards(user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    rows = conn.execute("SELECT * FROM boards WHERE user_id = ? ORDER BY name", (user["id"],)).fetchall()
    return [dict(r) for r in rows]


@router.post("/boards", status_code=201)
def create_board(body: BoardCreate, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    require_room(conn, "SELECT COUNT(*) FROM boards WHERE user_id = ?", (user["id"],), MAX_BOARDS, "boards")
    cur = conn.execute(
        "INSERT INTO boards (user_id, name, color) VALUES (?, ?, ?)", (user["id"], body.name, body.color)
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM boards WHERE id = ?", (cur.lastrowid,)).fetchone())


# --- rules ---

@router.get("/rules")
def list_rules(user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    rows = conn.execute("SELECT * FROM rules WHERE user_id = ? ORDER BY id DESC", (user["id"],)).fetchall()
    return [{**dict(r), "active": bool(r["active"])} for r in rows]


@router.post("/rules", status_code=201)
def create_rule(body: RuleCreate, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    active_count = conn.execute(
        "SELECT COUNT(*) FROM rules WHERE user_id = ? AND active = 1", (user["id"],)
    ).fetchone()[0]
    if active_count >= 15:
        raise HTTPException(status_code=400, detail="Rule cap reached (15 active). Deactivate one first.")
    require_room(conn, "SELECT COUNT(*) FROM rules WHERE user_id = ?", (user["id"],), MAX_RULES, "rules")
    cur = conn.execute(
        "INSERT INTO rules (user_id, text, created_at) VALUES (?, ?, ?)", (user["id"], body.text, now_iso())
    )
    conn.commit()
    r = conn.execute("SELECT * FROM rules WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**dict(r), "active": True}


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleUpdate, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute(
        "UPDATE rules SET active = ? WHERE id = ? AND user_id = ?", (int(body.active), rule_id, user["id"])
    )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Rule not found")
    conn.commit()
    r = conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
    return {**dict(r), "active": bool(r["active"])}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute("DELETE FROM rules WHERE id = ? AND user_id = ?", (rule_id, user["id"]))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Rule not found")
    conn.commit()
    return {"ok": True}


# --- context notes ---

@router.get("/context-notes")
def list_context_notes(
    user: CurrentUser,
    active_only: bool = True,
    task_id: int | None = None,
    conn: sqlite3.Connection = Depends(db_dep),
):
    where, params = ["user_id = ?"], [user["id"]]
    if active_only:
        where.append("active = 1")
    if task_id is not None:
        where.append("task_id = ?")
        params.append(task_id)
    sql = "SELECT * FROM context_notes WHERE " + " AND ".join(where) + " ORDER BY id DESC"
    rows = conn.execute(sql, params).fetchall()
    return [{**dict(r), "active": bool(r["active"])} for r in rows]


@router.post("/context-notes", status_code=201)
def create_context_note(body: ContextNoteCreate, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    if body.scope == "task" and body.task_id is None:
        raise HTTPException(status_code=400, detail="task_id required for task-scoped notes")
    if body.task_id is not None:
        fetch_task(conn, body.task_id, user["id"])  # a note can only attach to the caller's task
    require_room(
        conn, "SELECT COUNT(*) FROM context_notes WHERE user_id = ? AND active = 1", (user["id"],),
        MAX_ACTIVE_NOTES, "active context notes",
    )
    cur = conn.execute(
        "INSERT INTO context_notes (user_id, scope, task_id, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (user["id"], body.scope, body.task_id, body.text, body.expires_at, now_iso()),
    )
    conn.commit()
    r = conn.execute("SELECT * FROM context_notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**dict(r), "active": True}


@router.delete("/context-notes/{note_id}")
def dismiss_context_note(note_id: int, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute(
        "UPDATE context_notes SET active = 0 WHERE id = ? AND user_id = ?", (note_id, user["id"])
    )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    conn.commit()
    return {"ok": True}


# --- settings ---

def ensure_user_settings(conn: sqlite3.Connection, user_id: int) -> None:
    """Give a user their settings row, with defaults, the first time it is
    needed. The caller commits."""
    conn.execute("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)", (user_id,))


def user_settings(conn: sqlite3.Connection, user_id: int) -> dict:
    """The caller's preferences plus the app-wide timezone."""
    ensure_user_settings(conn, user_id)
    row = conn.execute(
        f"SELECT {', '.join(USER_SETTINGS_FIELDS)} FROM user_settings WHERE user_id = ?", (user_id,)
    ).fetchone()
    return {"timezone": app_timezone(conn), **dict(row)}


@router.get("/settings")
def get_settings(user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    out = user_settings(conn, user["id"])
    conn.commit()
    return out


@router.patch("/settings")
def update_settings(body: SettingsUpdate, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    # Only per-user preferences are writable. The timezone is shared by
    # everyone (one rollover, on Eastern time), so it is not a user setting.
    fields = body.model_dump(exclude_unset=True)
    ensure_user_settings(conn, user["id"])
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE user_settings SET {sets} WHERE user_id = ?", [*fields.values(), user["id"]])
    conn.commit()
    return user_settings(conn, user["id"])


# --- day history ---

@router.get("/history/{day}")
def day_history(day: str, user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    """Reconstruct a past day's task list from the append-only event log.

    Tasks only store current state, so 'what was on the list on day D and
    how did it end' is replayed from events: completed / promoted /
    deferred / dropped. Only tasks still on the list at the end of the day
    are returned: done, not finished, or (recurring) missed. Tasks moved
    back to the backlog or dropped during the day are left out.
    Days are logical days (see clock.py): they start at
    DAY_START_HOUR, so a task finished at 1am counts for the day before.
    Rollover events fire right at the boundary and are attributed to the
    day they close out.
    """
    try:
        target = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="day must be YYYY-MM-DD")
    tz = ZoneInfo(app_timezone(conn))
    if target >= logical_today(tz):
        raise HTTPException(status_code=400, detail="History covers past days only")

    utc = ZoneInfo("UTC")
    start = logical_day_start(target, tz)
    # Two days: the target day itself plus the rollover events at its close
    # (which land a hair after the next day's boundary).
    end = start + timedelta(days=2)
    rows = conn.execute(
        """SELECT e.task_id, e.event_type, e.payload, e.created_at,
                  t.title, t.notes, t.recurring, t.effort, t.streak
           FROM task_events e JOIN tasks t ON t.id = e.task_id
           WHERE t.user_id = ? AND e.created_at >= ? AND e.created_at < ?
           ORDER BY e.id ASC""",
        (user["id"], start.astimezone(utc).isoformat(), end.astimezone(utc).isoformat()),
    ).fetchall()

    tasks: dict[int, dict] = {}
    for r in rows:
        payload = json.loads(r["payload"]) if r["payload"] else {}
        created = datetime.fromisoformat(r["created_at"])
        if r["event_type"] in ("deferred", "carried_over") and payload.get("reason") == "rollover":
            # Rollover closes out the day in progress when it fired. It runs
            # at the boundary itself, so step back a second to land on the
            # day it ended rather than the one it started.
            created -= timedelta(seconds=1)
        local_date = logical_date(created, tz)
        if local_date != target:
            continue
        entry = tasks.setdefault(
            r["task_id"],
            {
                "id": r["task_id"],
                "title": r["title"],
                "notes": r["notes"],
                "recurring": bool(r["recurring"]),
                "effort": r["effort"],
                "streak": r["streak"],
                "status": None,
                "completed_at": None,
            },
        )
        et = r["event_type"]
        if et == "completed":
            entry["status"] = "done"
            entry["completed_at"] = r["created_at"]
        elif et == "state_changed" and entry["status"] == "done" and payload.get("to") != "done":
            entry["status"] = "open"
            entry["completed_at"] = None
        elif et == "deferred" and entry["status"] != "done":
            entry["status"] = "not_finished" if payload.get("reason") == "rollover" else "removed"
        elif et == "carried_over" and entry["status"] != "done":
            entry["status"] = "not_finished"
        elif et == "dropped":
            entry["status"] = "dropped"
        elif et == "promoted" and entry["status"] in (None, "removed", "dropped"):
            # Back on the list after a defer/drop earlier the same day.
            entry["status"] = "open"

    out = []
    for e in tasks.values():
        if e["status"] is None:
            continue  # only incidental events (notes edits, commitments) that day
        if e["status"] in ("removed", "dropped"):
            continue  # gone from the list before the day ended
        if e["status"] == "open":
            # Never resolved by a later event: recurring tasks were reset
            # without completing; non-recurring ones just weren't finished.
            e["status"] = "missed" if e["recurring"] else "not_finished"
        out.append(e)
    out.sort(key=lambda e: (e["recurring"], 0 if e["status"] == "done" else 1, e["title"].lower()))
    return {"date": day, "tasks": out}


# --- export ---

@router.get("/export")
def export_tasks(user: CurrentUser, conn: sqlite3.Connection = Depends(db_dep)):
    """The today list plus every task ever created, as one JSON download.

    The all-tasks list is deliberately unfiltered: the backlog view hides
    done and dropped rows, so reusing it would drop exactly the history
    this export exists to keep. Every row already carries state and
    completed_at, so what got finished is on the task itself and the
    per-task event log stays out of the file.
    """
    tz_name = app_timezone(conn)
    uid = user["id"]
    today = [
        row_to_task(r)
        for r in conn.execute(
            f"{TASK_SELECT} WHERE t.user_id = ? AND t.today_flag = 1 AND t.state != 'dropped'"
            " ORDER BY t.position ASC, t.id ASC",
            (uid,),
        ).fetchall()
    ]
    tasks = [
        row_to_task(r)
        for r in conn.execute(f"{TASK_SELECT} WHERE t.user_id = ? ORDER BY t.id ASC", (uid,)).fetchall()
    ]
    # Logical day (clock.py), so an export pulled at 2am is filed under the
    # day it belongs to rather than the calendar date that just started.
    filename = f"arturo-export-{logical_today(ZoneInfo(tz_name)).isoformat()}.json"
    payload = {
        "exported_at": now_iso(),
        "timezone": tz_name,
        "today": today,
        "tasks": tasks,
    }
    # Pretty-printed to be read, not just parsed. The shape is a fixed three
    # levels — root, list, flat task — so indent=4 stays legible; it is the
    # deeper structures that need to drop to 2 to avoid marching off the
    # right edge. ensure_ascii=False keeps non-ASCII titles readable rather
    # than escaping them to \uXXXX.
    return Response(
        json.dumps(payload, indent=4, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
