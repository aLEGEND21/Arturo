"""Rollover promotion (4am) and context-note sweep (3am). Plain SQL, no LLM."""
import logging
from datetime import date, datetime
from zoneinfo import ZoneInfo

from ..db import get_conn, log_event, now_iso

log = logging.getLogger("arturo.jobs")


def _local_date(iso: str | None, tz: ZoneInfo) -> date | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.date()
    return dt.astimezone(tz).date()


def run_rollover() -> dict:
    """4am daily. Resets recurring tasks, defers yesterday's leftovers,
    promotes tasks due or committed today. Promotions land at the top."""
    conn = get_conn()
    try:
        tz = ZoneInfo(conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()[0])
        today = datetime.now(tz).date()
        stats = {"recurring_reset": 0, "deferred": 0, "promoted": 0}

        # 1. Recurring tasks: streak bookkeeping, then reset and re-promote.
        for r in conn.execute("SELECT * FROM tasks WHERE recurring = 1 AND state != 'dropped'").fetchall():
            new_streak = r["streak"] + 1 if r["state"] == "done" else 0
            conn.execute(
                """UPDATE tasks SET state = 'not_started', today_flag = 1,
                          completed_at = NULL, nudge_level = 0, streak = ? WHERE id = ?""",
                (new_streak, r["id"]),
            )
            log_event(conn, r["id"], "promoted", {"reason": "recurring", "streak": new_streak})
            stats["recurring_reset"] += 1

        # 2. Clear today_flag on finished non-recurring tasks; defer unfinished ones.
        conn.execute("UPDATE tasks SET today_flag = 0 WHERE recurring = 0 AND today_flag = 1 AND state = 'done'")
        leftovers = conn.execute(
            """SELECT id FROM tasks WHERE recurring = 0 AND today_flag = 1
               AND state NOT IN ('done','dropped')"""
        ).fetchall()
        for r in leftovers:
            conn.execute("UPDATE tasks SET today_flag = 0, nudge_level = 0 WHERE id = ?", (r["id"],))
            log_event(conn, r["id"], "deferred", {"reason": "rollover"})
            stats["deferred"] += 1

        # 3. Promote: due today, committed today, or overdue.
        promoted_ids = []
        open_tasks = conn.execute(
            "SELECT * FROM tasks WHERE recurring = 0 AND state NOT IN ('done','dropped')"
        ).fetchall()
        for r in open_tasks:
            dl = _local_date(r["deadline"], tz)
            cm = _local_date(r["commitment_at"], tz)
            if (dl == today) or (cm == today) or (dl is not None and dl < today):
                reason = "overdue" if (dl is not None and dl < today) else ("commitment" if cm == today else "deadline")
                conn.execute("UPDATE tasks SET today_flag = 1 WHERE id = ?", (r["id"],))
                log_event(conn, r["id"], "promoted", {"reason": reason})
                promoted_ids.append(r["id"])
        stats["promoted"] = len(promoted_ids)

        # 4. Renumber positions with promotions first, keeping relative order elsewhere.
        if promoted_ids:
            promoted_set = set(promoted_ids)
            rows = conn.execute("SELECT id FROM tasks ORDER BY position ASC, id ASC").fetchall()
            ordered = promoted_ids + [r["id"] for r in rows if r["id"] not in promoted_set]
            for pos, task_id in enumerate(ordered, start=1):
                conn.execute("UPDATE tasks SET position = ? WHERE id = ?", (pos, task_id))

        conn.commit()
        log.info("rollover complete: %s", stats)
        return stats
    finally:
        conn.close()


def run_sweep() -> dict:
    """3am nightly and on startup. Expires stale context notes,
    kills notes on closed tasks, enforces the 5-note-per-task cap."""
    conn = get_conn()
    try:
        stats = {"expired": 0, "closed_task": 0, "capped": 0}
        now = now_iso()

        cur = conn.execute(
            "UPDATE context_notes SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?",
            (now,),
        )
        stats["expired"] = cur.rowcount

        cur = conn.execute(
            """UPDATE context_notes SET active = 0 WHERE active = 1 AND scope = 'task'
               AND task_id IN (SELECT id FROM tasks WHERE state IN ('done','dropped'))"""
        )
        stats["closed_task"] = cur.rowcount

        # 5-note cap per task: deactivate the oldest beyond 5.
        cur = conn.execute(
            """UPDATE context_notes SET active = 0 WHERE id IN (
                 SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS rn
                   FROM context_notes WHERE active = 1 AND scope = 'task'
                 ) WHERE rn > 5
               )"""
        )
        stats["capped"] = cur.rowcount

        # Clear expired snoozes so state is inspectable.
        conn.execute(
            "UPDATE tasks SET snooze_until = NULL, snooze_reason = NULL WHERE snooze_until IS NOT NULL AND snooze_until < ?",
            (now,),
        )

        conn.commit()
        log.info("sweep complete: %s", stats)
        return stats
    finally:
        conn.close()
