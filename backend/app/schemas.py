from typing import Literal, Optional

from pydantic import BaseModel, Field

Effort = Literal["short", "medium", "long"]
State = Literal["not_started", "in_progress", "blocked", "done", "dropped"]


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    notes: Optional[str] = None
    handling: Optional[str] = None
    deadline: Optional[str] = None
    commitment_at: Optional[str] = None
    effort: Optional[Effort] = None
    board_id: Optional[int] = None
    recurring: bool = False
    starred: bool = False
    today: bool = False
    state: Literal["not_started", "in_progress"] = "not_started"
    source: Literal["dashboard", "discord"] = "dashboard"


class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=500)
    notes: Optional[str] = None
    handling: Optional[str] = None
    deadline: Optional[str] = None
    commitment_at: Optional[str] = None
    effort: Optional[Effort] = None
    board_id: Optional[int] = None
    recurring: Optional[bool] = None
    starred: Optional[bool] = None
    state: Optional[State] = None
    blocked_reason: Optional[str] = None
    today_flag: Optional[bool] = None
    snooze_until: Optional[str] = None
    snooze_reason: Optional[str] = None


class ReorderRequest(BaseModel):
    ids: list[int]


class BoardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: Optional[str] = None


class RuleCreate(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class RuleUpdate(BaseModel):
    active: bool


class ContextNoteCreate(BaseModel):
    scope: Literal["global", "task"]
    task_id: Optional[int] = None
    text: str = Field(min_length=1, max_length=1000)
    expires_at: Optional[str] = None


class SettingsUpdate(BaseModel):
    timezone: Optional[str] = None
    discord_user_id: Optional[str] = None
    work_hours_start: Optional[str] = None
    work_hours_end: Optional[str] = None
    quiet_start: Optional[str] = None
    quiet_end: Optional[str] = None
    max_daily_messages: Optional[int] = None
    min_gap_minutes: Optional[int] = None
