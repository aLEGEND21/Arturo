import json
import sqlite3
from datetime import datetime
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

from ..db import db_dep, log_event, now_iso
from ..schemas import ReorderRequest, TaskCreate, TaskUpdate

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


# backlog_origin: the task was created on the all-tasks list rather than on
# today. Derived from the created event so it never drifts, and unaffected by
# later moves between the lists. The recently completed section keys off it.
TASK_SELECT = """
    SELECT t.*,
           EXISTS (SELECT 1 FROM task_events e
                   WHERE e.task_id = t.id AND e.event_type = 'created'
                     AND json_extract(e.payload, '$.today') = 0) AS backlog_origin
    FROM tasks t
"""


def row_to_task(row: sqlite3.Row) -> dict:
    t = dict(row)
    for f in ("starred", "recurring", "today_flag", "backlog_origin"):
        t[f] = bool(t[f])
    return t


def fetch_task(conn: sqlite3.Connection, task_id: int) -> dict:
    row = conn.execute(f"{TASK_SELECT} WHERE t.id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return row_to_task(row)


@router.get("")
def list_tasks(
    view: Literal["today", "backlog", "all"] = "all",
    board_id: Optional[int] = None,
    conn: sqlite3.Connection = Depends(db_dep),
):
    where, params = [], []
    if view == "today":
        where.append("today_flag = 1 AND state != 'dropped'")
    elif view == "backlog":
        where.append("state NOT IN ('done','dropped')")
    if board_id is not None:
        where.append("board_id = ?")
        params.append(board_id)
    sql = TASK_SELECT
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY t.position ASC, t.id ASC"
    return [row_to_task(r) for r in conn.execute(sql, params).fetchall()]


@router.post("", status_code=201)
def create_task(body: TaskCreate, conn: sqlite3.Connection = Depends(db_dep)):
    max_pos = conn.execute("SELECT COALESCE(MAX(position), 0) FROM tasks").fetchone()[0]
    today_flag = 1 if (body.today or body.recurring) else 0
    deadline = body.deadline
    if body.today and not body.recurring and deadline is None:
        # A task added straight to the today list is due by the end of the
        # calendar day it was created on. Naive local time, matching what the
        # dashboard's datetime picker saves.
        tz = ZoneInfo(conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0])
        deadline = datetime.now(tz).strftime("%Y-%m-%dT23:59")
    cur = conn.execute(
        """INSERT INTO tasks (title, notes, handling, position, starred, recurring, board_id,
                              deadline, commitment_at, effort, state, today_flag, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            body.title, body.notes, body.handling, max_pos + 1, int(body.starred),
            int(body.recurring), body.board_id, deadline, body.commitment_at,
            body.effort, body.state, today_flag, body.source, now_iso(),
        ),
    )
    task_id = cur.lastrowid
    log_event(conn, task_id, "created", {"source": body.source, "today": bool(today_flag)})
    if today_flag:
        log_event(conn, task_id, "promoted", {"reason": "created_for_today"})
    conn.commit()
    return fetch_task(conn, task_id)


@router.get("/{task_id}")
def get_task(task_id: int, conn: sqlite3.Connection = Depends(db_dep)):
    return fetch_task(conn, task_id)


@router.get("/{task_id}/events")
def task_events(task_id: int, conn: sqlite3.Connection = Depends(db_dep)):
    fetch_task(conn, task_id)
    rows = conn.execute(
        "SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 100", (task_id,)
    ).fetchall()
    out = []
    for r in rows:
        e = dict(r)
        e["payload"] = json.loads(e["payload"]) if e["payload"] else None
        out.append(e)
    return out


@router.patch("/{task_id}")
def update_task(task_id: int, body: TaskUpdate, conn: sqlite3.Connection = Depends(db_dep)):
    task = fetch_task(conn, task_id)
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return task

    sets, params = [], []

    state = fields.pop("state", None)
    if state is not None and state != task["state"]:
        sets.append("state = ?")
        params.append(state)
        if state == "done":
            sets.append("completed_at = ?")
            params.append(now_iso())
            log_event(conn, task_id, "completed", {"recurring": task["recurring"]})
        elif task["state"] == "done":
            sets.append("completed_at = NULL")
            log_event(conn, task_id, "state_changed", {"from": "done", "to": state})
        elif state == "dropped":
            sets.append("today_flag = 0")
            log_event(conn, task_id, "dropped", None)
        else:
            log_event(conn, task_id, "state_changed", {"from": task["state"], "to": state})

    today_flag = fields.pop("today_flag", None)
    if today_flag is not None and today_flag != task["today_flag"]:
        sets.append("today_flag = ?")
        params.append(int(today_flag))
        if today_flag:
            # A manually promoted task joins the bottom of the today list
            # rather than slotting in by its (creation-order) position: the
            # tasks already there are due sooner. Rollover promotions still
            # land at the top.
            max_pos = conn.execute("SELECT COALESCE(MAX(position), 0) FROM tasks").fetchone()[0]
            sets.append("position = ?")
            params.append(max_pos + 1)
        log_event(
            conn, task_id,
            "promoted" if today_flag else "deferred",
            {"source": "manual"},
        )

    commitment_at = fields.pop("commitment_at", None)
    if commitment_at is not None and commitment_at != task["commitment_at"]:
        sets.append("commitment_at = ?")
        params.append(commitment_at or None)
        log_event(conn, task_id, "committed", {"at": commitment_at})

    for key, value in fields.items():
        sets.append(f"{key} = ?")
        params.append(int(value) if isinstance(value, bool) else value)

    if sets:
        params.append(task_id)
        conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    return fetch_task(conn, task_id)


@router.post("/reorder")
def reorder_tasks(body: ReorderRequest, conn: sqlite3.Connection = Depends(db_dep)):
    if not body.ids:
        return {"ok": True, "count": 0}
    placeholders = ",".join("?" * len(body.ids))
    rows = conn.execute(
        f"SELECT id, position FROM tasks WHERE id IN ({placeholders})", body.ids
    ).fetchall()
    if len(rows) != len(body.ids):
        raise HTTPException(status_code=400, detail="Unknown task id in reorder")
    # Reuse the same position slots so tasks outside this view keep their order.
    slots = sorted(r["position"] for r in rows)
    for slot, task_id in zip(slots, body.ids):
        conn.execute("UPDATE tasks SET position = ? WHERE id = ?", (slot, task_id))
    conn.commit()
    return {"ok": True, "count": len(body.ids)}
