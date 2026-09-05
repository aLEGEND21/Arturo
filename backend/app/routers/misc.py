import json
import sqlite3
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

from ..clock import logical_date, logical_day_start, logical_today
from ..db import db_dep, now_iso
from ..schemas import (
    BoardCreate,
    ContextNoteCreate,
    RuleCreate,
    RuleUpdate,
    SettingsUpdate,
)

router = APIRouter(prefix="/api", tags=["misc"])


# --- boards ---

@router.get("/boards")
def list_boards(conn: sqlite3.Connection = Depends(db_dep)):
    return [dict(r) for r in conn.execute("SELECT * FROM boards ORDER BY name").fetchall()]


@router.post("/boards", status_code=201)
def create_board(body: BoardCreate, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute("INSERT INTO boards (name, color) VALUES (?, ?)", (body.name, body.color))
    conn.commit()
    return dict(conn.execute("SELECT * FROM boards WHERE id = ?", (cur.lastrowid,)).fetchone())


# --- rules ---

@router.get("/rules")
def list_rules(conn: sqlite3.Connection = Depends(db_dep)):
    rows = conn.execute("SELECT * FROM rules ORDER BY id DESC").fetchall()
    return [{**dict(r), "active": bool(r["active"])} for r in rows]


@router.post("/rules", status_code=201)
def create_rule(body: RuleCreate, conn: sqlite3.Connection = Depends(db_dep)):
    active_count = conn.execute("SELECT COUNT(*) FROM rules WHERE active = 1").fetchone()[0]
    if active_count >= 15:
        raise HTTPException(status_code=400, detail="Rule cap reached (15 active). Deactivate one first.")
    cur = conn.execute(
        "INSERT INTO rules (text, created_at) VALUES (?, ?)", (body.text, now_iso())
    )
    conn.commit()
    r = conn.execute("SELECT * FROM rules WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**dict(r), "active": True}


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleUpdate, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute("UPDATE rules SET active = ? WHERE id = ?", (int(body.active), rule_id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Rule not found")
    conn.commit()
    r = conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
    return {**dict(r), "active": bool(r["active"])}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Rule not found")
    conn.commit()
    return {"ok": True}


# --- context notes ---

@router.get("/context-notes")
def list_context_notes(
    active_only: bool = True,
    task_id: int | None = None,
    conn: sqlite3.Connection = Depends(db_dep),
):
    where, params = [], []
    if active_only:
        where.append("active = 1")
    if task_id is not None:
        where.append("task_id = ?")
        params.append(task_id)
    sql = "SELECT * FROM context_notes"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC"
    rows = conn.execute(sql, params).fetchall()
    return [{**dict(r), "active": bool(r["active"])} for r in rows]


@router.post("/context-notes", status_code=201)
def create_context_note(body: ContextNoteCreate, conn: sqlite3.Connection = Depends(db_dep)):
    if body.scope == "task" and body.task_id is None:
        raise HTTPException(status_code=400, detail="task_id required for task-scoped notes")
    cur = conn.execute(
        "INSERT INTO context_notes (scope, task_id, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        (body.scope, body.task_id, body.text, body.expires_at, now_iso()),
    )
    conn.commit()
    r = conn.execute("SELECT * FROM context_notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**dict(r), "active": True}


@router.delete("/context-notes/{note_id}")
def dismiss_context_note(note_id: int, conn: sqlite3.Connection = Depends(db_dep)):
    cur = conn.execute("UPDATE context_notes SET active = 0 WHERE id = ?", (note_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    conn.commit()
    return {"ok": True}


# --- settings ---

@router.get("/settings")
def get_settings(conn: sqlite3.Connection = Depends(db_dep)):
    return dict(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())


@router.patch("/settings")
def update_settings(body: SettingsUpdate, conn: sqlite3.Connection = Depends(db_dep)):
    fields = body.model_dump(exclude_unset=True)
    # An invalid timezone would crash every scheduled job (rollover, sweep,
    # backup) and the stats endpoint at ZoneInfo() time — refuse it here.
    if fields.get("timezone") is not None:
        try:
            ZoneInfo(fields["timezone"])
        except (ValueError, KeyError, OSError):
            raise HTTPException(status_code=400, detail="Unknown timezone")
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE settings SET {sets} WHERE id = 1", list(fields.values()))
        conn.commit()
    return dict(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())


# --- day history ---

@router.get("/history/{day}")
def day_history(day: str, conn: sqlite3.Connection = Depends(db_dep)):
    """Reconstruct a past day's task list from the append-only event log.

    Tasks only store current state, so 'what was on the list on day D and
    how did it end' is replayed from events: completed / promoted /
    deferred / dropped. Days are logical days (see clock.py): they start at
    DAY_START_HOUR, so a task finished at 1am counts for the day before.
    Rollover events fire right at the boundary and are attributed to the
    day they close out.
    """
    try:
        target = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="day must be YYYY-MM-DD")
    tz_name = conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0]
    tz = ZoneInfo(tz_name)
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
           WHERE e.created_at >= ? AND e.created_at < ?
           ORDER BY e.id ASC""",
        (start.astimezone(utc).isoformat(), end.astimezone(utc).isoformat()),
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
        elif et == "promoted" and entry["status"] is None:
            entry["status"] = "open"

    out = []
    for e in tasks.values():
        if e["status"] is None:
            continue  # only incidental events (notes edits, commitments) that day
        if e["status"] == "open":
            # Never resolved by a later event: recurring tasks were reset
            # without completing; non-recurring ones just weren't finished.
            e["status"] = "missed" if e["recurring"] else "not_finished"
        out.append(e)
    out.sort(key=lambda e: (e["recurring"], 0 if e["status"] == "done" else 1, e["title"].lower()))
    return {"date": day, "tasks": out}


# --- stats ---

@router.get("/stats/summary")
def stats_summary(conn: sqlite3.Connection = Depends(db_dep)):
    tz_name = conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0]
    tz = ZoneInfo(tz_name)
    day_start = logical_day_start(logical_today(tz), tz)

    def completed_between(start: datetime, end: datetime) -> int:
        return conn.execute(
            """SELECT COUNT(*) FROM task_events e
               JOIN tasks t ON t.id = e.task_id
               WHERE e.event_type = 'completed' AND t.recurring = 0
                 AND e.created_at >= ? AND e.created_at < ?""",
            (start.astimezone(ZoneInfo("UTC")).isoformat(), end.astimezone(ZoneInfo("UTC")).isoformat()),
        ).fetchone()[0]

    done_today = completed_between(day_start, day_start + timedelta(days=1))
    week_total = completed_between(day_start - timedelta(days=6), day_start + timedelta(days=1))

    today_total = conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE today_flag = 1 AND recurring = 0 AND state != 'dropped'"
    ).fetchone()[0]
    open_backlog = conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE state NOT IN ('done','dropped')"
    ).fetchone()[0]

    return {
        "done_today": done_today,
        "today_total": today_total,
        "seven_day_avg": round(week_total / 7, 1),
        "open_tasks": open_backlog,
    }
