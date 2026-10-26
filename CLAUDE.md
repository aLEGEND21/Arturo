# CLAUDE.md

Guidance for working in this repo. Read this before changing anything. The
README covers the same ground for humans; this file adds the rules,
invariants, and traps that matter when editing code.

## What Arturo is

A multi-user task dashboard that runs on a fixed daily rhythm. Each user has
a **today list** and a **backlog** ("All tasks"). Every task change is
written to an append-only event log. At 4am Eastern a rollover closes out the
day: recurring tasks reset, unfinished today tasks stay, and backlog tasks
that are due, overdue, or committed for today get promoted. Past days are
rebuilt from the event log.

- Live at https://tasks.arnavm.com. Sign-in is Discord OAuth, open to any
  Discord account.
- Owner/maintainer: Arnav. The owner's Discord id is hardcoded as
  `OWNER_DISCORD_ID` in `backend/app/db.py`.
- A Discord bot (`app/bot/`) answers DMs: Claude turns plain-language
  messages into add, list, complete and remove tool calls on the sender's tasks.
- Planned but not built: bot check-ins and nudges, LLM summaries, a settings
  page, off-site backups. The schema already has columns for them
  (`nudge_level`, `last_nudged_at`, `snooze_*`, `handling`,
  `last_user_update`, work/quiet hours in `user_settings`). Many of these
  are unused today. Don't remove them.

## Repo layout

```
backend/                FastAPI + SQLite (raw sqlite3, no ORM) + APScheduler
  app/__init__.py       loads backend/.env (real env vars win)
  app/main.py           app, CORS, router wiring, scheduler, admin job routes
  app/auth.py           Discord OAuth, cookie sessions, require_user/require_admin
  app/db.py             connection, MIGRATIONS, storage caps, helpers
  app/clock.py          logical-day boundary (DAY_START_HOUR = 4)
  app/schemas.py        Pydantic request bodies, all bounded
  app/routers/tasks.py  /api/tasks: list, create, get, events, patch, reorder
  app/routers/misc.py   boards, rules, context notes, settings, history, export
  app/jobs/maintenance.py  run_rollover, run_sweep, run_backup
  app/bot/              Discord bot: client.py (py-cord, DMs), agent.py (Claude loop), tools.py
  tests/                pytest; isolation, auth, limits, behavior, migration
  data/                 dev database + backups (gitignored, real user data)
frontend/               Next.js 16 (App Router), React 19, Tailwind 4, SWR, dnd-kit, sonner
  src/proxy.ts          page gate: no session cookie -> /login (Next 16's "middleware")
  src/app/page.tsx      the dashboard (today column + all-tasks column + drawer)
  src/app/login/        Discord sign-in page (server component)
  src/app/rules/        rules page
  src/lib/api.ts        fetcher/api(), types, SWR cache helpers, date helpers
  src/lib/ui.ts         class recipes (buttonClass, inputClass, kickerClass)
  src/lib/utils.ts      cn() with tailwind-merge tuned to the theme
  src/components/       industry.tsx (design primitives), today-list, task-drawer,
                        add-row, day-history, effort-dot, context-strip, nav, task-row
  next.config.ts        /api proxy rewrites (only when API_PROXY_TARGET is set)
docker-compose.yml      local stack: only frontend exposed on :3000
docker-compose.prod.yml prod stack, images built in CI, joins nginx-proxy network
scripts/deploy.sh       runs ON the VPS: start release, health check, auto-rollback
scripts/rollback.sh     runs ON the VPS: switch back to the previous release
.github/workflows/deploy.yml  push to main -> test, build, ship, deploy
```

## Commands

Backend (from `backend/`):

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --port 8000        # dev server, docs at /docs
.venv/bin/pytest -q                               # full suite
.venv/bin/pytest -q tests/test_isolation.py -k board   # one file / filter
```

Frontend (from `frontend/`):

```sh
npm install
npm run dev        # :3000, talks to http://localhost:8000 directly
npm run lint
npx tsc --noEmit   # type check
npm run build
```

Both together: `docker compose up --build` (open http://localhost:3000).

Local sign-in needs `backend/.env` (copy `backend/.env.example`) with
`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. The redirect URI registered
in the Discord portal must match exactly: `http://localhost:8000/api/auth/callback`
for host dev, `http://localhost:3000/api/auth/callback` under compose (compose
overrides the env var for you). Without credentials, `/api/auth/login`
returns 503.

There are **no frontend tests**. Verify frontend changes with lint, the type
check, and a build, and by running the app when the change is visual.

## How to verify a change

- Any backend change: `pytest -q` must pass. CI runs the same suite and a
  failure blocks the deploy.
- New or changed API route: add isolation coverage (another user gets 404)
  and add the route to the list in
  `tests/test_isolation.py::test_every_data_route_requires_a_session`. That
  test compares against the app's real route table and fails if a route has
  no 401 check.
- Frontend change: `npm run lint && npx tsc --noEmit`, plus `npm run build`
  for anything touching config, routing, or server components.

## Backend architecture and invariants

### Auth and per-user isolation (the most important rules)

- `tasks.router` and `misc.router` are mounted with
  `dependencies=[Depends(require_user)]`, so every route in them 401s
  without a live session. Only `/health` and `/api/auth/*` (login, callback,
  logout) are open. Put new data routes on one of these routers, or mount
  them the same way.
- Handlers take `user: CurrentUser` and **every query filters by
  `user["id"]`**, including UPDATE and DELETE (`... WHERE id = ? AND user_id = ?`).
- Another user's row must look exactly like a missing row: **404, never
  403**. Load tasks with `fetch_task(conn, task_id, user_id)`; validate a
  board id with `check_board`. A note attached to a task goes through
  `fetch_task` first. Reorder returns 400 if any id isn't the caller's.
- Owned tables: `OWNED_TABLES = (tasks, rules, boards, context_notes, messages)`,
  each with a `user_id` column. `task_events` inherit ownership through their
  task (join on `tasks.user_id`). `user_settings` is keyed by `user_id`.
- Admin = the owner only. `ADMIN_DISCORD_ID = OWNER_DISCORD_ID` is fixed in
  code on purpose. Never read admin ids from env or the database (a test
  enforces this). The manual job routes `POST /api/jobs/{rollover,sweep,backup}`
  use `require_admin` because they act on every user's data.
- Sessions: random token in the `arturo_session` HttpOnly cookie
  (SameSite=Lax, Secure when the redirect URI is https). Only its SHA-256
  is stored. Lax cookies are the CSRF protection for the JSON API, so keep
  mutating routes as non-GET.

### Database (`app/db.py`)

- Raw `sqlite3`, `row_factory = sqlite3.Row`, WAL mode, foreign keys on. One
  connection per request via the `db_dep` dependency. Handlers commit
  explicitly with `conn.commit()`.
- Booleans are stored as 0/1 and converted on the way out
  (`row_to_task`, `{**dict(r), "active": bool(r["active"])}`).
- Before reading positions for a write, call `write_lock(conn)` (`BEGIN
  IMMEDIATE`) so concurrent requests can't compute the same slot.
- Per-user caps (open sign-up): `MAX_TASKS`, `MAX_BOARDS`, `MAX_RULES`,
  `MAX_ACTIVE_NOTES`, enforced with `require_room(...)`, which returns 400.
  Rules also have a hardcoded 15-active cap in `misc.py`.
- DB path comes from `ARTURO_DB` (default `backend/data/arturo.db`). Delete
  it (plus `-wal`/`-shm`) for a fresh dev start. It contains real data, so
  don't delete it without asking.

### Migrations

`MIGRATIONS` in `db.py` is an ordered list of `(version, sql)` run against
SQLite's `user_version` on boot. Each script runs in one transaction with its
version stamp. Before migrating an existing database a snapshot is written
to `data/backups/arturo-pre-migration-*.db` (only the latest is kept).

When adding a migration:

1. Append `(next_version, SCRIPT)`. **Never edit an existing entry.**
2. **Additive only**: new tables, nullable or defaulted columns, indexes,
   backfills. No drops or renames in the same release. A failed deploy rolls
   back to the previous image, and it must still open the new file.
3. Prefer `IF NOT EXISTS`. `ALTER TABLE ADD COLUMN` isn't idempotent, but the
   version gate keeps it from running twice.
4. If it touches ownership, keep `adopt_orphans` working (it runs on every
   boot and gives `user_id IS NULL` rows to the owner).
5. Add a test in `tests/test_migration.py` and try it on a copy of the
   production database.

Current versions: 1 baseline schema, 2 users and sessions, 3 multi-user
(`user_id` columns, `user_settings`). The old `settings` row (id=1) now only
supplies the app-wide `timezone`. Its other columns are dead but kept for
rollback compatibility.

### Time, the logical day, and timestamps

- **One timezone for everyone: America/New_York.** The rollover, sweep, and
  backup run once for all users. This is a deliberate decision: don't add
  per-user timezones or per-user schedules. Read it with `app_timezone(conn)`.
- **The day ends at 4am, not midnight.** `DAY_START_HOUR = 4` in
  `app/clock.py`. Something done at 1am belongs to the previous day. Every
  "which day" question goes through `logical_date` / `logical_today` /
  `logical_day_start`. Don't call `.date()` on a local timestamp. The
  frontend mirrors this in `logicalDay()` in `src/lib/api.ts`. Change both
  together.
- System timestamps (`created_at`, `completed_at`, event times) are UTC ISO
  strings from `now_iso()`.
- User-entered `deadline` / `commitment_at` are **naive local strings**
  (`"2026-10-01T23:59"`, the datetime-local picker format) or bare dates.
  Code relies on lexical order being chronological for these. Keep that
  format; don't add offsets.
- `schemas.py` bounds every input (text lengths, years 1900 to 2200, list
  sizes) and turns explicit nulls on NOT NULL fields into 422s. New fields
  need bounds too. `SettingsUpdate` forbids unknown fields.

### Tasks, positions, and the event log

- Views: `today` = `today_flag = 1 AND state != 'dropped'`; `backlog` = not
  done or dropped; `all` = everything. Lists come back ordered by
  `position, id`.
- `position` is **per user**: one integer ordering across that user's tasks.
  Reorder reuses the existing slots of the given ids so tasks outside the
  view keep their order.
- A task created on today (or promoted by hand) goes to the top, below
  open today tasks with sooner deadlines (`today_insert_position`). The
  frontend mirrors this in `insertForToday` for optimistic inserts. Change
  both together.
- A task created on today with no deadline defaults to 11:59 PM that
  calendar day (server and `endOfTodayDeadline()` on the client).
- Recurring tasks always have `today_flag = 1` and render in their own
  section.
- **Every meaningful change logs an event** with `log_event`: `created`
  (payload `{"source", "today"}`), `promoted`, `deferred`, `completed`,
  `state_changed`, `dropped`, `committed`, `carried_over`. Events from a
  person carry `"source": "dashboard" | "discord"` in the payload, so the log
  shows whether the bot or the web made a change (older rows have no source,
  or `"manual"` on promoted/deferred, which was always the dashboard);
  rollover events carry `reason` instead. Day history
  (`GET /api/history/{day}`) is reconstructed purely from these events, and
  `backlog_origin` is derived from the `created` event's `today` flag. When
  you add a state transition, log an event and check that `day_history` still
  classifies it correctly.
- State side effects in `update_task`: `done` stamps `completed_at`; leaving
  `done` clears it; `dropped` clears `today_flag`.

### Discord bot (`app/bot/`)

- Runs **inside the API process**: `start_bot()` in `main.py`'s lifespan
  starts py-cord's gateway client as a task on uvicorn's event loop, so
  SQLite still has one owning process. It starts only when
  `DISCORD_BOT_TOKEN` and `ANTHROPIC_API_KEY` are set, and a bad token is
  logged, never raised, so a Discord problem can't fail a deploy's health
  check. **Keep uvicorn at one worker**: each worker would connect its own
  bot and answer every DM. Dev uses a separate Discord application from prod.
- DMs only (server messages are ignored). The account is the `users` row
  for the author's Discord id; unknown ids are told to sign in on the
  dashboard. The model never supplies a user id, so tool calls can't reach
  another account.
- The tools in `tools.py` **call the task code in `routers/tasks.py`
  directly** (`create_task`, `list_tasks`, and `apply_task_update`, which the
  PATCH route also wraps) with source `"discord"`. Removing is `state="dropped"` (the dashboard's Drop),
  never a hard delete: day history is built from the event log. Change a handler and the bot changes with it.
  `HTTPException`/`ValidationError` become `{"error": ...}` tool results.
- `agent.py`: manual tool loop on `AsyncAnthropic`, model `ARTURO_BOT_MODEL`
  (default `claude-haiku-5-5`), effort low, thinking disabled (it added over
  a second per call for no gain), at most 6 rounds. Latency is almost all
  API round trips (~0.7s each), so the user's open tasks
  (`tools.task_snapshot`) ride on the newest user message: viewing takes
  one call and add/complete/remove take two. Keep the snapshot on the newest
  message, not in the system prompt; before the history, the model reads it
  as stale and invents duplicates. The snapshot's "Finished today: x of y"
  line (everything on today, recurring included) is counted in code so the
  reply's "done x/y" can't be miscounted; per-section counts confused it.
  Its lists are in dashboard order (`dashboard_today`/`dashboard_backlog`
  mirror `regular`/`backlog` in `page.tsx`: today by position with done
  tasks sunk and recurring separate, All tasks soonest-due first). Change
  both together.
  History holds only text, not past tool calls; the prompt tells the model
  so, or it decides its earlier "marked it done" never happened. SQLite work
  runs in `asyncio.to_thread` with its own connection. The incoming DM is
  written to `messages` before the model runs (so the daily cap,
  `MAX_BOT_MESSAGES_PER_DAY`, counts failed attempts too), and the reply plus
  one `llm_calls` row per turn after. History is the user's last 10
  messages within 6 hours. Replies use a lowercase, casual texting voice set
  in the system prompt and enforced by `casual_case` (it lowercases sentence
  starts but skips known task titles, which keep their capitals); the model
  drifts back to sentence case without it. The canned replies in `client.py`
  match the voice.
- Tests (`tests/test_bot.py`) use a scripted stand-in for the model.
  `conftest.py` blanks the bot env vars so tests never connect to Discord.

### Scheduled jobs (`app/jobs/maintenance.py`, wired in `main.py`)

- 3:00 `run_sweep`: expire context notes, deactivate notes on closed tasks,
  keep at most 5 active notes per task, clear expired snoozes. It also runs on
  startup.
- 3:55 `run_backup`: SQLite online backup to `data/backups/arturo-YYYY-MM-DD.db`,
  keeps 14. It runs before the rollover so the snapshot has the day's final state.
- 4:00 `run_rollover`: (1) recurring reset plus streak (+1 if done, else 0);
  (2) un-flag done today tasks and log `carried_over` for unfinished ones;
  (3) promote backlog tasks due today, committed today, or overdue; (4)
  renumber positions **per user**, promotions first. One bad stored
  timestamp must skip that task, never abort the run for everyone
  (`_local_date` swallows parse errors).
- Jobs run across all users with no user filter. That's intended. Keep any
  ordering work per user.

## Frontend architecture and conventions

- **Next.js 16 is not the Next.js in your training data.** Read the relevant
  guide in `frontend/node_modules/next/dist/docs/` before using a Next API
  you aren't sure about (see `frontend/AGENTS.md`). Examples here: the
  request gate is `src/proxy.ts` exporting `proxy` (formerly middleware);
  page props like `searchParams` are Promises; `LayoutProps<"/">` is a
  global type.
- `frontend/CLAUDE.md` / `AGENTS.md` contain a block that `next dev`
  rewrites. Leave it alone. If it shows up as a diff, committing it is fine.
- **API base:** `API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"`.
  In dev the browser calls :8000 directly (CORS with credentials). In Docker
  it's built as `""`, so calls are relative `/api/...` and `next.config.ts`
  rewrites them to `API_PROXY_TARGET`. That target is **baked in at
  `next build`**, not read at runtime.
- The production proxy **blocks `/api/jobs/*` and `/api/settings`** from the
  public origin (rewritten to a 404). Settings can only be changed by calling
  the backend directly.
- Always call the backend through `fetcher` (SWR reads) and `api(path,
  method, body)` (writes) in `lib/api.ts`. They send cookies and turn a 401
  into a full navigation to `/login`. `login/page.tsx` repeats `API_BASE`
  because it's a server component and can't import SWR code.
- **Data and optimistic updates:** SWR keys are the API paths
  (`/api/tasks?view=today`, `/api/tasks?view=all`, ...). Mutations update
  the caches first with the helpers in `lib/api.ts` (`patchTaskCache`,
  `addTaskCache`/`replaceTaskCache`/`removeTaskCache` with `makeTempTask`'s
  negative ids, `addToTodayCache`/`removeFromTodayCache`), then send the
  request, toast the error on failure (`sonner`), and `revalidateAll()`.
  Optimistic patches must **mirror server side effects** (done ->
  `completed_at`, dropped -> leaves today, today placement). If you change
  server behavior, update the mirror.
- Done tasks sink to the bottom of today for display only. Their stored
  positions don't change, and they're excluded from reorder writes
  (`openIds` in `page.tsx`).
- The task drawer autosaves the title and notes on blur and on Escape. It
  tracks the last-saved values separately because typing live-patches the
  caches.
- The browsed day lives in the URL (`/?day=YYYY-MM-DD`). Past days are
  read-only and come from `/api/history/{day}`.

### Styling: the "Industry" design system

- A Tailwind 4 theme in `src/app/globals.css` (`@theme static`). **Tailwind's
  default palette is removed.** Only theme tokens exist: `canvas`, `surface`,
  `ink`, `accent(-100..900)`, `neutral-100..900`, `muted`, `faint`, `label`,
  `divider(-soft/-strong)`, `hover`, `press`, `danger(-bg)`,
  `effort-short/medium/long`, and so on. `bg-blue-500` doesn't exist.
- Spacing tokens: `px-page`, `py-row-y`, `pl-row-l`, `pr-row-r`, `p-row-x`.
  They tighten on phones.
- **Breakpoint: `phone:`** = `max-width: 768px` (768 inclusive). It's
  desktop-first, so write the wide layout and override with `phone:`. Don't
  use `sm:`/`md:`. `hover:` is plain `:hover` (no hover-media wrapping).
- Square corners everywhere (`rounded-none`), Barlow body and Barlow
  Condensed headings (`font-heading`), font sizes as exact pixel values
  (`text-[14px]`). Phone inputs are 16px to stop iOS zoom.
- Reuse the primitives: `Button`, `Field`, `Blueprint` (the framed box with
  corner ticks), `Tag`, `OverdueTag`, `Square` (checkbox), `Seg`, and the
  icons in `components/industry.tsx`; `buttonClass`/`inputClass`/`kickerClass`
  in `lib/ui.ts` (also usable from server components); row layout recipes in
  `components/task-row.ts`. Merge classes with `cn()` from `lib/utils.ts`,
  which knows the custom tokens. shadcn was removed, so don't add it back.

## Deployment and production

- **Pushing to `main` deploys to production.** GitHub Actions runs the
  backend tests, builds both images tagged with the short SHA, `docker save`s
  them over SSH to the VPS, copies the compose file and scripts to
  `/opt/arturo/`, and runs `deploy.sh <tag>`. That script health-checks
  `/health` through the frontend and restores the previous tag if it fails.
- VPS state lives in `/opt/arturo/`: `.env` (secrets, never overwritten by
  deploys), `data/` (database and backups, outside the images), and
  `current`/`previous` tag files. nginx reaches `arturo-frontend:3000` on the
  external `nginx-proxy` network. The backend is never exposed.
- Production env: local copy in `backend/.env.production` (gitignored).
  Changing it means `scp` to `/opt/arturo/.env` and restarting (see README).
- Don't roll back to a pre-multi-user release (before migration 3). Those
  images can't sign anyone in.
- Restoring a backup: stop the stack and delete `arturo.db-wal`/`-shm`
  along with the database before copying the backup in.
- Checking the live site from Arnav's Mac: a network filter blocks
  `tasks.arnavm.com` for curl/openssl by SNI. Use headless system Chrome
  through Playwright with
  `--enable-features=EncryptedClientHello,UseDnsHttpsSvcb` instead. The
  site isn't down.

## Working preferences

- Work directly on `main` in the primary checkout. Don't create worktrees or
  feature branches unless asked.
- **Don't commit or push unless explicitly asked.** A push to `main` is a
  production deploy. Leave changes in the working tree for review.
- Commit messages, when asked for: Conventional Commits with a scope where it
  fits, e.g. `feat(frontend): ...`, `fix: ...`, `docs: ...`, `chore(frontend): ...`.
- Match the existing code style. Comments explain *why* (constraints,
  invariants, mirrors between client and server) in full sentences, not what
  the next line does.
- Never touch `backend/data/` or production data without asking. Tests use
  a throwaway database and refuse to run otherwise (`tests/conftest.py`
  sets `ARTURO_DB` before importing `app`). Keep it that way in new test
  files: import `app` only after conftest has run.
- Keep the README in sync when behavior described there changes (rollover
  rules, config, deploy, migrations, backups).
