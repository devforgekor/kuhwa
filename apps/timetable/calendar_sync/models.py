#!/usr/bin/env python3
# Status: experimental
# Path: calendar_sync/oauth_service.py, calendar_sync/router.py
"""Pydantic models for calendar sync feature."""

from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class SyncMode(str, Enum):
    """Calendar sync mode."""

    FULL_REPLACE = "full_replace"
    INCREMENTAL_UPDATE = "incremental_update"


class UserToken(BaseModel):
    """OAuth token stored in database."""

    user_id: str
    email: str
    access_token: str
    refresh_token: Optional[str] = None
    token_expiry: datetime
    scopes: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("scopes", mode="before")
    @classmethod
    def _parse_pg_array_literal(cls, v):
        # (2026-10-11) SQLite 이관 회귀 수정: PG TEXT[] 는 psycopg2 가 list 로 돌려줬지만
        # SQLite TEXT 는 저장된 그대로 '{"a","b"}' 문자열을 반환한다 — list[str] 검증이
        # 실패해 get_stored_tokens 가 ValidationError 으로 /status·업로드·로그아웃이 500 이었다.
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("{") and s.endswith("}"):
                inner = s[1:-1].strip()
                if not inner:
                    return []
                return [p.strip().strip('"') for p in inner.split(",")]
            return [v] if v else []
        return v


class CalendarEvent(BaseModel):
    """Calendar event from Excel/Sheets."""

    title: str
    start_date: str
    end_date: str
    description: Optional[str] = None
    location: Optional[str] = None
    attendees: Optional[list[str]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None

    def to_google_event(self) -> dict:
        """Convert to Google Calendar API event format."""
        start_dt = f"{self.start_date}T{self.start_time or '00:00:00'}"
        end_dt = f"{self.end_date}T{self.end_time or '23:59:59'}"
        return {
            "summary": self.title,
            "description": self.description,
            "location": self.location,
            "start": {"dateTime": start_dt, "timeZone": "Asia/Seoul"},
            "end": {"dateTime": end_dt, "timeZone": "Asia/Seoul"},
            "attendees": [{"email": e} for e in (self.attendees or [])],
        }


class SyncConfig(BaseModel):
    """Configuration for sync operation."""

    mode: SyncMode = SyncMode.FULL_REPLACE
    date_range_start: Optional[str] = None
    date_range_end: Optional[str] = None
    calendar_id: str = "primary"


class SyncResult(BaseModel):
    """Result of sync operation."""

    created: int = 0
    updated: int = 0
    deleted: int = 0
    errors: list[str] = Field(default_factory=list)
    events: list[CalendarEvent] = Field(default_factory=list)