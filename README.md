# Arturo — AI Accountability Assistant (Phase 0)

Task management dashboard + backend from the design doc. This is the Phase 0 slice:
no Discord bot, no LLM calls — the schema, event log, promotion job, and dashboard
they'll plug into.

## Layout

```
backend/   FastAPI + SQLite (sole DB owner) + APScheduler jobs
frontend/  Next.js 16 (App Router) + Tailwind + shadcn/ui + dnd-kit + SWR
```

## Run it

Backend (port 8000):

```sh
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time
.venv/bin/uvicorn app.main:app --port 8000
```

Frontend (port 3000):

```sh
cd frontend
npm install        # first time
npm run dev
```

The frontend reads `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8000`).
The backend reads `ARTURO_DB` (defaults to `backend/data/arturo.db`, created on boot)
and `TZ` (defaults to `America/New_York`) for job scheduling.

## What's implemented

- **Full schema from §5** — `tasks`, append-only `task_events`, `context_notes`,
  `rules`, `boards`, `settings`, plus `messages`/`llm_calls` (empty until Phase 1/2).
  WAL mode, foreign keys on.
- **Tasks API** — CRUD, per-field event logging (`created`, `completed`, `promoted`,
  `deferred`, `committed`, `state_changed`, `dropped`), drag-reorder endpoint that
  reuses position slots so backlog ordering survives a today-list reorder.
- **Rollover job (4am)** — recurring reset + streak bookkeeping, carryover `deferred`
  events, promotion by deadline/commitment/overdue, promotions land at the top.
  Manual trigger: `POST /api/jobs/rollover`.
- **Sweep job (3am + startup)** — expires context notes, kills notes on closed tasks,
  enforces the 5-note cap, clears stale snoozes. Manual: `POST /api/jobs/sweep`.
- **Dashboard** — Today view (pinned recurring section with streaks, dnd-kit
  reordering with optimistic updates, done-count), Backlog (board filter, soonest
  deadline first), quick-add with date shortcuts, task drawer (state, notes,
  handling, blocked reason, context notes, event history), active-context strip,
  rules page with the 15-active cap.
- `GET /health` for the uptime monitor (open question 11).

## Notes

- The DB currently holds a few sample tasks from smoke testing; delete
  `backend/data/arturo.db*` for a clean start (it recreates on boot).
- Interactive API docs at `http://localhost:8000/docs`.
