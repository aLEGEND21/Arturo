# Arturo — AI Accountability Assistant

A personal task system built around one idea: the day has a fixed shape. Tasks
live on a today list or in the backlog, an event log records everything that
happens to them, and a 4am rollover closes the working day, carries unfinished
work forward, and promotes what is due next. The dashboard at
[tasks.arnavm.com](https://tasks.arnavm.com) is the front door; sign-in is by
Discord. Every table the Discord bot and the LLM layer need is already in
place and populated by the dashboard, so those arrive as additions, not
rewrites (see [Future improvements](#future-improvements)).

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
and `TZ` (defaults to `America/New_York`) for job scheduling, plus the Discord
login settings from `backend/.env` (copy `backend/.env.example`; see
[Sign-in](#sign-in)).

Or run the whole stack with Docker Compose (frontend on port 3000; the backend is
not published — the Next server proxies `/api` to it over the compose network):

```sh
docker compose up --build
```

## What's implemented

- **Schema** — `tasks`, append-only `task_events`, `context_notes`, `rules`,
  `boards`, `settings`, `users`, `sessions`, plus `messages` and `llm_calls`
  for the bot and LLM layers. WAL mode, foreign keys on.
- **Tasks API** — CRUD, per-field event logging (`created`, `completed`, `promoted`,
  `deferred`, `committed`, `state_changed`, `dropped`), drag-reorder endpoint that
  reuses position slots so backlog ordering survives a today-list reorder.
- **Rollover job (4am)** — recurring reset + streak bookkeeping, unfinished today
  tasks stay put (logged as `carried_over`), promotion from the backlog by
  deadline/commitment/overdue, promotions land at the top.
  Manual trigger: `POST /api/jobs/rollover`.
- **Logical day boundary (4am)** — the working day ends at rollover, not midnight.
  Day history and the dashboard's "Today"/"Yesterday" all treat a task
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
- **JSON export** — `GET /api/export` returns one file holding today's list and
  every task ever created, done and dropped included, so completed history
  survives the export (the backlog view hides those rows). State and
  `completed_at` live on each task, so no `task_events` audit trail is
  embedded. Served with `Content-Disposition`, so the dashboard's nav-bar
  Export link downloads it with no client-side code.
- **Dashboard** — Today view (pinned recurring section with streaks, dnd-kit
  reordering with optimistic updates, done-count), Backlog (board filter, soonest
  deadline first), quick-add with date shortcuts, task drawer (state, notes,
  handling, blocked reason, context notes, event history), active-context strip,
  rules page with the 15-active cap.
- **Home-screen install** — `app/manifest.ts` plus Apple web-app metadata in
  `app/layout.tsx` name the installed app "Arturo" and reuse the favicon
  (`app/icon.png`, copied verbatim to `app/apple-icon.png` and
  `public/icons/*`; iOS scales icons better from a large source).
- **Discord sign-in** — every API route except `/health` and `/api/auth/*`
  requires a session cookie. See [Sign-in](#sign-in).
- **Versioned schema migrations** — `PRAGMA user_version` gates an ordered
  list in `app/db.py`; boot applies whatever is missing, snapshotting the
  database first. See [Schema migrations](#schema-migrations).
- `GET /health` for the uptime monitor and the deploy script's readiness probe.

## Sign-in

Access is by Discord OAuth (`identify` scope only), implemented in
`backend/app/auth.py`. `GET /api/auth/login` bounces to Discord;
`GET /api/auth/callback` swaps the code for the profile, checks the Discord
user id against `ARTURO_ALLOWED_DISCORD_IDS`, upserts the `users` row, and
sets an HttpOnly `arturo_session` cookie (30 days, SHA-256 of the token in the
`sessions` table). `GET /api/auth/me` returns the signed-in user;
`POST /api/auth/logout` ends the session. The Next server (`src/proxy.ts`)
sends any page load without the cookie to `/login`; the backend answers 401
on API calls, which `lib/api.ts` turns into the same redirect.

Configuration lives in three files, all gitignored except the example:

- `backend/.env.example` documents every key.
- `backend/.env` is local dev, loaded automatically by uvicorn on the host
  and by `docker-compose.yml`.
- `backend/.env.production` is the prod copy, kept locally and shipped to
  the VPS as `/opt/arturo/.env` (see [Production deploys](#production-deploys)).

The keys:

- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` from the Discord developer
  portal. Register each redirect URI there exactly:
  `http://localhost:8000/api/auth/callback` (uvicorn on the host),
  `http://localhost:3000/api/auth/callback` (local compose), and
  `https://tasks.arnavm.com/api/auth/callback` (prod).
- `DISCORD_REDIRECT_URI` and `ARTURO_APP_URL` — the callback and the
  dashboard origin. In prod both are the public origin. `docker-compose.yml`
  overrides them for the local proxy setup.
- `ARTURO_ALLOWED_DISCORD_IDS` — comma-separated Discord user ids. Anyone
  else signs in with Discord fine and is then refused with
  `/login?error=not_allowed`. The `settings.discord_user_id` column is
  honoured too, so the future bot and the dashboard share one source.

Only one person is allowed for now, but nothing is single-user by design:
`users` is keyed on the Discord id so every table can gain a `user_id`
reference later, and the allowlist is the only thing to replace with an
invite flow. The rollover, sweep, and backup jobs will stay global on
Eastern time for every user; there is no per-user timezone.

The `POST /api/jobs/*` manual triggers require a session too. The scheduled
runs inside the process do not go through HTTP and are unaffected.

## Schema migrations

`app/db.py` holds an ordered `MIGRATIONS` list of `(version, script)`. On
boot `init_db` reads `PRAGMA user_version` and applies every entry above it,
each with its version stamp inside one transaction, so a crash mid-way leaves
the file at the previous version and the migration re-runs next boot. A
database from before versioning reads as 0: the baseline is all
`IF NOT EXISTS`, so it passes through untouched and is stamped 1.

Before touching a database that already has tables, `init_db` writes
`backups/arturo-pre-migration-v<from>-to-v<to>-<timestamp>.db` next to the
nightly snapshots, so every migration has a restore point no matter when the
deploy lands relative to the 3:55am job. Only the latest pre-migration
snapshot is kept, and it does not count toward the 14 nightly backups.

Rules for adding a migration:

- Append, never edit an applied entry. Bump the version by one.
- Additive only: `ALTER TABLE ... ADD COLUMN` (nullable or defaulted), new
  tables, backfills. Never drop or rename in the same release that adds — if
  `deploy.sh` rolls back to the previous image, that code must still open
  the newer file. Retire columns a release later.
- Test against a copy of prod first: `scp` the file down, run the backend
  with `ARTURO_DB` pointing at the copy, compare row counts.

Deploys never touch the data: the database lives on the VPS bind mount
(`/opt/arturo/data`), outside the images, and `deploy.sh` only swaps
containers.

## Production deploys

Pushing to `main` triggers `.github/workflows/deploy.yml`: it builds both
images on the runner, ships them to the VPS over SSH (`docker save | docker
load`), and runs `scripts/deploy.sh <tag>` there. The script brings up
`docker-compose.prod.yml` from `/opt/arturo`, health-checks `/health` through
the frontend proxy, and automatically restores the previous release if the new
one won't serve. `scripts/rollback.sh` swaps back manually.

- Repo secrets required: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`.
- The VPS needs Docker Compose 2.24 or newer (it runs 2.27). The prod
  compose file uses the long `env_file` syntax with `required: false`, which
  older versions cannot parse. Because `deploy.sh` copies the new compose
  file before starting, an older Compose would break the automatic rollback
  too.
- `/opt/arturo/.env` on the VPS holds the Discord OAuth settings (see
  [Sign-in](#sign-in)). The workflow never writes it, so it survives
  deploys. Create or update it from the local prod copy:

  ```sh
  scp backend/.env.production vps:/opt/arturo/.env
  ```

  Then restart the backend so it picks up the change
  (`cd /opt/arturo && TAG=$(cat current) docker compose -f docker-compose.prod.yml up -d`).
  If the file is missing, the stack still starts but `/api/auth/login`
  answers 503.
- Rolling back to a release from before Discord sign-in removes login
  entirely: those images have no auth, so the dashboard is public again
  until you redeploy.
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

## Future improvements

Planned, roughly in order. Each builds on tables and hooks that already exist.

- **Discord bot** — the conversational side of Arturo: check-ins, nudges,
  capturing tasks from chat. Writes to `messages`, identifies people by the
  same Discord id the dashboard signs in with, and respects the work-hours,
  quiet-hours, and message-cap columns in `settings`.
- **LLM layer** — prompt assembly from the active rules and context notes,
  every call logged to `llm_calls` with tokens and latency. Nudge wording,
  handling suggestions, and end-of-day summaries.
- **Multiple users** — a `user_id` column on tasks, rules, boards, context
  notes, and messages, backfilled to the existing user; per-user settings
  rows; every query and the position logic scoped by user; the env allowlist
  replaced by an invite flow. Rollover, sweep, and backup stay global on
  Eastern time.
- **Off-host backups** — sync `/opt/arturo/data/backups` somewhere that
  survives the VPS disk.
- **Settings UI** — the `settings` row is only editable through the API,
  which the prod proxy blocks; a page on the dashboard should own it.

## Notes

- Delete `backend/data/arturo.db*` for a clean local start (it recreates on
  boot, at the current schema version).
- Interactive API docs at `http://localhost:8000/docs`.
