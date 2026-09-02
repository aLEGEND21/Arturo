import logging
import os
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
    scheduler.add_job(run_rollover, CronTrigger(hour=4, minute=0, timezone=TZ), id="rollover")
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Arturo API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks.router)
app.include_router(misc.router)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/jobs/rollover")
def trigger_rollover():
    return run_rollover()


@app.post("/api/jobs/sweep")
def trigger_sweep():
    return run_sweep()


@app.post("/api/jobs/backup")
def trigger_backup():
    return run_backup()
