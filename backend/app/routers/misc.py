import sqlite3
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

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
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE settings SET {sets} WHERE id = 1", list(fields.values()))
        conn.commit()
    return dict(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())


# --- stats ---

@router.get("/stats/summary")
def stats_summary(conn: sqlite3.Connection = Depends(db_dep)):
    tz_name = conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0]
    tz = ZoneInfo(tz_name)
    now_local = datetime.now(tz)
    day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)

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
