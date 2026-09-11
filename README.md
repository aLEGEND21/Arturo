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

Or run the whole stack with Docker Compose (frontend on port 3000; the backend is
not published — the Next server proxies `/api` to it over the compose network):

```sh
docker compose up --build
```

## What's implemented

- **Full schema from §5** — `tasks`, append-only `task_events`, `context_notes`,
  `rules`, `boards`, `settings`, plus `messages`/`llm_calls` (empty until Phase 1/2).
  WAL mode, foreign keys on.
- **Tasks API** — CRUD, per-field event logging (`created`, `completed`, `promoted`,
  `deferred`, `committed`, `state_changed`, `dropped`), drag-reorder endpoint that
  reuses position slots so backlog ordering survives a today-list reorder.
- **Rollover job (4am)** — recurring reset + streak bookkeeping, unfinished today
  tasks stay put (logged as `carried_over`), promotion from the backlog by
  deadline/commitment/overdue, promotions land at the top.
  Manual trigger: `POST /api/jobs/rollover`.
- **Logical day boundary (4am)** — the working day ends at rollover, not midnight.
  Day history, stats, and the dashboard's "Today"/"Yesterday" all treat a task
  finished at 1am as the previous day's work. Backend: `app/clock.py`;
  frontend: `logicalDay()` in `lib/api.ts`.
- **Sweep job (3am + startup)** — expires context notes, kills notes on closed tasks,
  enforces the 5-note cap, clears stale snoozes. Manual: `POST /api/jobs/sweep`.
- **Backup job (3:55am)** — nightly SQLite snapshot, taken just before rollover
  mutates state. Manual: `POST /api/jobs/backup`. See below.
- **Day history** — `GET /api/history/{YYYY-MM-DD}` replays the event log to show
  what was on a past day's list at the end of the day and how it ended (done,
  not finished, missed); tasks moved off or dropped mid-day are omitted. The
  dashboard's ‹ › arrows use it.
- **Dashboard** — Today view (pinned recurring section with streaks, dnd-kit
  reordering with optimistic updates, done-count), Backlog (board filter, soonest
  deadline first), quick-add with date shortcuts, task drawer (state, notes,
  handling, blocked reason, context notes, event history), active-context strip,
  rules page with the 15-active cap.
- **Home-screen install** — `app/manifest.ts` plus Apple web-app metadata in
  `app/layout.tsx` name the installed app "Arturo" and reuse the favicon
  (`app/icon.png`, mirrored as `app/apple-icon.png` and `public/icons/*`).
- `GET /health` for the uptime monitor (open question 11).

## Production deploys

Pushing to `main` triggers `.github/workflows/deploy.yml`: it builds both
images on the runner, ships them to the VPS over SSH (`docker save | docker
load`), and runs `scripts/deploy.sh <tag>` there. The script brings up
`docker-compose.prod.yml` from `/opt/arturo`, health-checks `/health` through
the frontend proxy, and automatically restores the previous release if the new
one won't serve. `scripts/rollback.sh` swaps back manually.

- Repo secrets required: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`.
- The frontend joins the external `nginx-proxy` Docker network; point nginx at
  `proxy_pass http://arturo-frontend:3000;`. The backend stays on an internal
  network only — nothing is published to the host.
- Data (and nightly backups) live at `/opt/arturo/data` on the VPS.
- Release state (`current`/`previous` tags) is tracked in `/opt/arturo`; all
  older images are pruned on each deploy.

## Backups & restore

Every night at 3:55am the backend writes a consistent snapshot (SQLite online
backup API, WAL-safe) to `backups/arturo-YYYY-MM-DD.db` next to the database —
under compose that's `./backend/data/backups/` on the host via the bind mount.
The newest 14 are kept; older ones are pruned. `POST /api/jobs/backup` takes one
on demand. The job only fires while the backend is running, and it doesn't
protect against disk loss — sync `backend/data/backups/` somewhere off-host for
that.

To restore from a backup:

```sh
docker compose down                     # stop the stack (or your dev servers)
cd backend/data
rm -f arturo.db arturo.db-wal arturo.db-shm   # drop the live DB + WAL sidecars
cp backups/arturo-2026-09-01.db arturo.db     # pick the snapshot you want
docker compose up -d                    # start again
```

The WAL/SHM sidecars must go with the old database — restoring the `.db` file
while stale sidecars remain can corrupt the restored copy.

## Notes

- The DB currently holds a few sample tasks from smoke testing; delete
  `backend/data/arturo.db*` for a clean start (it recreates on boot).
- Interactive API docs at `http://localhost:8000/docs`.
