"""Logical-day boundary.

A working day does not end at midnight: it ends when the rollover job runs.
Anything finished between midnight and DAY_START_HOUR still belongs to the
day before, so every "which day did this happen on" question goes through
here instead of calling .date() on a local timestamp.
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DAY_START_HOUR = 4


def logical_date(dt: datetime, tz: ZoneInfo) -> date:
    """The logical day a moment belongs to. Naive datetimes are assumed local."""
    local = dt.astimezone(tz) if dt.tzinfo is not None else dt
    if local.hour < DAY_START_HOUR:
        return local.date() - timedelta(days=1)
    return local.date()


def logical_today(tz: ZoneInfo) -> date:
    return logical_date(datetime.now(tz), tz)


def logical_day_start(d: date, tz: ZoneInfo) -> datetime:
    """The moment logical day `d` begins (DAY_START_HOUR local time)."""
    return datetime.combine(d, time(hour=DAY_START_HOUR), tzinfo=tz)
