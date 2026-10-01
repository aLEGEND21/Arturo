import logging
import os
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import auth
from .auth import require_admin, require_user
from .clock import DAY_START_HOUR
from .db import init_db
from .jobs.maintenance import run_backup, run_rollover, run_sweep
from .routers import misc, tasks

logging.basicConfig(level=logging.INFO)

TZ = ZoneInfo(os.environ.get("TZ", "America/New_York"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    run_sweep()  # startup sweep: a crash mid-context-window must not silence the bot forever
    scheduler = BackgroundScheduler(timezone=TZ)
    scheduler.add_job(run_sweep, CronTrigger(hour=3, minute=0, timezone=TZ), id="sweep")
    # 3:55, not 4:00: the backup snapshots the day's final state before the
    # rollover mutates it, and the two jobs never write concurrently.
    scheduler.add_job(run_backup, CronTrigger(hour=3, minute=55, timezone=TZ), id="backup")
    # The rollover defines the logical day boundary (clock.py).
    scheduler.add_job(run_rollover, CronTrigger(hour=DAY_START_HOUR, minute=0, timezone=TZ), id="rollover")
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Arturo API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(","),
    # Local dev hits the API origin directly, so the session cookie only
    # travels if credentials are allowed. Behind the compose proxy every call
    # is same-origin and CORS never applies.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Only /health and the auth routes are reachable without a session.
app.include_router(auth.router)
app.include_router(tasks.router, dependencies=[Depends(require_user)])
app.include_router(misc.router, dependencies=[Depends(require_user)])


@app.get("/health")
def health():
    return {"ok": True}


# Manual job triggers act on every user's data, so they are admin-only.
@app.post("/api/jobs/rollover", dependencies=[Depends(require_admin)])
def trigger_rollover():
    return run_rollover()


@app.post("/api/jobs/sweep", dependencies=[Depends(require_admin)])
def trigger_sweep():
    return run_sweep()


@app.post("/api/jobs/backup", dependencies=[Depends(require_admin)])
def trigger_backup():
    return run_backup()
