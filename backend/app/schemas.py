"""Request bodies. Sign-up is open to any Discord account, so every field
is bounded: text has a maximum length, timestamps must parse and stay in a
sane range, and lists are capped. Fields stored in NOT NULL columns refuse
an explicit null with a 422 instead of failing in the database."""
from datetime import datetime, timezone
from typing import Annotated, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

Effort = Literal["short", "medium", "long"]
State = Literal["not_started", "in_progress", "blocked", "done", "dropped"]

# Timestamps are stored as strings: naive local ("2026-10-01T18:00"), a bare
# date, or an ISO string with an offset. Years are bounded so converting any
# accepted value between timezones can never overflow; the 4am rollover does
# exactly that for every user's tasks.
MIN_YEAR, MAX_YEAR = 1900, 2200


def _check_timestamp(value: Optional[str]) -> Optional[str]:
    if not value:
        return value  # None, or "" which some fields use to mean "clear"
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("must be an ISO 8601 date or date-time")
    if not MIN_YEAR <= dt.year <= MAX_YEAR:
        raise ValueError(f"year must be between {MIN_YEAR} and {MAX_YEAR}")
    return value


def _not_null(value):
    if value is None:
        raise ValueError("may not be null")
    return value


Timestamp = Annotated[Optional[str], Field(max_length=40), AfterValidator(_check_timestamp)]
ShortText = Annotated[Optional[str], Field(max_length=1000)]
LongText = Annotated[Optional[str], Field(max_length=10_000)]
HHMM = Annotated[Optional[str], Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    notes: LongText = None
    handling: LongText = None
    deadline: Timestamp = None
    commitment_at: Timestamp = None
    effort: Optional[Effort] = None
    board_id: Optional[int] = None
    recurring: bool = False
    starred: bool = False
    today: bool = False
    state: Literal["not_started", "in_progress"] = "not_started"
    source: Literal["dashboard", "discord"] = "dashboard"


class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=500)
    notes: LongText = None
    handling: LongText = None
    deadline: Timestamp = None
    commitment_at: Timestamp = None
    effort: Optional[Effort] = None
    board_id: Optional[int] = None
    recurring: Optional[bool] = None
    starred: Optional[bool] = None
    state: Optional[State] = None
    blocked_reason: ShortText = None
    today_flag: Optional[bool] = None
    snooze_until: Timestamp = None
    snooze_reason: ShortText = None

    # Omitting these leaves them alone; sending null would hit a NOT NULL
    # column. (A null state or today_flag is already a no-op.)
    reject_null = field_validator("title", "recurring", "starred")(_not_null)


class ReorderRequest(BaseModel):
    # At most a user's task cap; also keeps the query under SQLite's limit
    # on bound parameters.
    ids: list[int] = Field(max_length=5000)


class BoardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: Optional[str] = Field(default=None, max_length=32)


class RuleCreate(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class RuleUpdate(BaseModel):
    active: bool


class ContextNoteCreate(BaseModel):
    scope: Literal["global", "task"]
    task_id: Optional[int] = None
    text: str = Field(min_length=1, max_length=1000)
    expires_at: Timestamp = None


class SettingsUpdate(BaseModel):
    # Per-user preferences only. The timezone is app-wide and not writable
    # here; unknown fields are rejected rather than silently dropped.
    model_config = ConfigDict(extra="forbid")

    work_hours_start: HHMM = None
    work_hours_end: HHMM = None
    quiet_start: HHMM = None
    quiet_end: HHMM = None
    max_daily_messages: Optional[int] = Field(default=None, ge=0, le=1000)
    min_gap_minutes: Optional[int] = Field(default=None, ge=0, le=24 * 60)

    # Every column is NOT NULL: omit a field to leave it alone.
    reject_null = field_validator("*")(_not_null)
