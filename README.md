# Arturo

A task dashboard that runs on a fixed daily rhythm. Tasks live on a today list
or in the backlog, every change is written to an event log, and at 4am a
rollover closes out the day: unfinished work carries over and anything due
gets pulled onto the new list. It's live at
[tasks.arnavm.com](https://tasks.arnavm.com), and you sign in with Discord.

```
backend/   FastAPI, SQLite, APScheduler
frontend/  Next.js 16, Tailwind 4, dnd-kit, SWR
```

## Running it locally

Copy `backend/.env.example` to `backend/.env` and fill in the Discord client
ID and secret. Then start the backend on port 8000 and the frontend on 3000:

```sh
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```

```sh
cd frontend
npm install
npm run dev
```

The database is created at `backend/data/arturo.db` on first boot. Delete it
for a clean start. API docs are at http://localhost:8000/docs.

`docker compose up --build` runs both together. In that setup only the
frontend is exposed (port 3000), and it proxies `/api` to the backend.

## How it works

The 4am rollover resets recurring tasks and updates their streaks, keeps
unfinished tasks on today's list, and promotes backlog tasks that are due,
overdue, or committed for today. The working day ends at 4am rather than
midnight, so something finished at 1am still counts for the day before
(`app/clock.py` on the backend, `logicalDay()` in the frontend). A sweep at
3am expires old context notes and snoozes.

Past days are rebuilt from the event log, which is what the dashboard's day
arrows show. The Export button downloads every task as JSON.

Anyone with a Discord account can sign in. Each person gets their own tasks,
rules, boards, notes and settings, and can't see anyone else's. Every query
filters by the signed-in user, and someone else's row returns a 404 as if
it didn't exist. Positions are per user too, so one person reordering their
list never moves anyone else's. The manual job triggers (`POST
/api/jobs/rollover`, `sweep`, `backup`) affect everyone's data, so only the
owner account can call them. That account is hardcoded in `app/auth.py`.
Since sign-up is open, inputs are bounded and each user has storage caps
(the `MAX_*` constants in `app/db.py`).

Styling is a Tailwind theme defined in `frontend/src/app/globals.css`. Shared
components are in `components/industry.tsx` and class recipes in
`lib/ui.ts`. There's a custom `phone:` breakpoint at 768px.

## Configuration

`backend/.env.example` lists every setting. The ones you need:

- `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` from the Discord developer
  portal.
- `DISCORD_REDIRECT_URI`, which must match a redirect registered in the
  portal exactly. Locally that's `http://localhost:8000/api/auth/callback`
  (or port 3000 under compose). In production it's
  `https://tasks.arnavm.com/api/auth/callback`.
- `ARTURO_APP_URL`, where the browser lands after signing in.

The production copy lives locally as `backend/.env.production` (gitignored)
and on the VPS as `/opt/arturo/.env`.

## Tests

```sh
cd backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
```

Each test starts from a fresh database with two signed-in users. Most of the
suite checks that one user can't read or change another's data on any
route, and a route-table check fails if a new endpoint skips auth. The rest
covers sign-in, input limits, the rollover and the migrations. The tests
refuse to run against anything but a throwaway database, so they can't touch
`backend/data`. The deploy runs them first and stops if any fail.

## Deploying

Pushing to `main` deploys. GitHub Actions runs the tests, builds both
images, copies them to the VPS over SSH, and runs `scripts/deploy.sh`. That
script starts the new release, checks `/health`, and switches back to the
previous release on its own if the new one doesn't come up.
`scripts/rollback.sh` does the same switch by hand.

Things the VPS needs:

- Repo secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_USER`.
- Docker Compose 2.24 or newer (the prod compose file uses `env_file`
  options older versions can't parse).
- `/opt/arturo/.env`. Deploys never overwrite it. To change it, copy the
  local file up and restart the backend:

  ```sh
  scp backend/.env.production vps:/opt/arturo/.env
  ssh vps 'cd /opt/arturo && TAG=$(cat current) docker compose -f docker-compose.prod.yml up -d'
  ```

- nginx pointed at `http://arturo-frontend:3000` on the `nginx-proxy`
  network. The backend isn't exposed outside Docker, and the frontend blocks
  `/api/jobs/*` and `/api/settings` from the public site.

The database lives in `/opt/arturo/data`, outside the images, so deploys
never touch it. Rolling back to a release from before multi-user support
isn't recommended: those builds ignore ownership and require an allowlist
that's no longer set, so nobody can sign in until you redeploy.

## Migrations

`MIGRATIONS` in `app/db.py` is an ordered list of SQL scripts. On boot the
backend runs any that are newer than the database's `user_version`, each in
its own transaction, after saving a snapshot to
`backups/arturo-pre-migration-*.db`. Only the latest snapshot is kept.

When adding one:

- Append it with the next version number. Don't edit an old entry.
- Only add things (columns that are nullable or have defaults, new tables,
  backfills). If a deploy rolls back, the previous release has to be able
  to open the new database, so drop or rename columns in a later release.
- Try it on a copy of the production database first.

## Backups

The backend snapshots the database at 3:55am, just before the rollover, into
`data/backups/arturo-YYYY-MM-DD.db`, and keeps the last 14. These sit on the
same disk as the database, so copy them somewhere else if you want to
survive losing the VPS.

To restore, stop the stack and replace the database, deleting the `-wal` and
`-shm` files along with it. Leftover WAL files can corrupt a restored copy.

```sh
docker compose down
cd backend/data
rm -f arturo.db arturo.db-wal arturo.db-shm
cp backups/arturo-2026-09-01.db arturo.db
docker compose up -d
```

## Planned

- A Discord bot for check-ins, nudges and adding tasks from chat. The
  `messages` table and the work-hours and quiet-hours settings are already
  there for it.
- An LLM layer for nudge wording and end-of-day summaries, logging each call
  to `llm_calls`.
- Off-site backups.
- A settings page. Right now settings can only be changed through the API.
- Rate limits on sign-up if open sign-up gets abused.
