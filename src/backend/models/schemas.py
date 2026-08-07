from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class Performance(BaseModel):
    id: int | None = None
    title: str
    date: str
    open_time: str
    start_time: str
    venue: str
    conductor: str
    flyer_image: str = ""
    performance_fee_amount: float = 0
    pieces: list[Any] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None

    @field_validator("title", "date", "open_time", "start_time", "venue", "conductor", "flyer_image", mode="before")
    @classmethod
    def _blankable_text(cls, value: Any) -> str:
        return "" if value is None else str(value)

    @field_validator("performance_fee_amount", mode="before")
    @classmethod
    def _blank_fee_amount(cls, value: Any) -> float:
        if value in (None, ""):
            return 0
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0

    @field_validator("pieces", mode="before")
    @classmethod
    def _blank_pieces(cls, value: Any) -> list[Any]:
        return value if isinstance(value, list) else []


class Schedule(BaseModel):
    id: int | None = None
    date: str
    time: str = ""
    start_time: str = ""
    end_time: str = ""
    venue: str
    available_hours: str = ""
    available_start_time: str = ""
    available_end_time: str = ""
    performance_id: int | None = None
    performance_title: str = ""
    pieces: str = ""
    is_conductor_training: bool = False
    is_main_performance: bool = False
    notes: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class Announcement(BaseModel):
    id: int | None = None
    date: str
    title: str = ""
    content: str
    created_at: str | None = None
    updated_at: str | None = None


class EventAdjustment(BaseModel):
    id: int | None = None
    title: str
    date: str = ""
    start_time: str = ""
    deadline: str = ""
    url: str = ""
    notes: str = ""
    delete_phrase: str = ""
    fee: str = ""
    created_by_member_id: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


class Member(BaseModel):
    id: int | None = None
    name: str = ""
    last_name: str = ""
    first_name: str = ""
    maiden_name: str = ""
    last_name_kana: str = ""
    first_name_kana: str = ""
    maiden_name_kana: str = ""
    part: str = ""
    photo_url: str = ""
    is_founder: bool = False
    is_recording_manager: bool = False
    is_sheet_manager: bool = False
    password: str = ""
    password_set: bool = False
    permission: str = "一般"
    joined_at: str = ""
    system_access_until: str = ""
    introducer: str = ""
    role: str = ""
    instrument_history: str = ""
    past_orchestras: str = ""
    comment: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class MemberSummary(BaseModel):
    id: int | None = None
    name: str = ""
    last_name: str = ""
    first_name: str = ""
    maiden_name: str = ""
    last_name_kana: str = ""
    first_name_kana: str = ""
    part: str = ""
    photo_url: str = ""
    password_set: bool = False
    permission: str = "一般"
    joined_at: str = ""
    system_access_until: str = ""


class MemberProfileUpdate(BaseModel):
    photo_url: str = ""
    joined_at: str = ""
    introducer: str = ""
    role: str = ""
    instrument_history: str = ""
    past_orchestras: str = ""
    comment: str = ""


class RecordingDeleteRequest(BaseModel):
    source: str
    object_name: str = ""
    path: str = ""


class SheetDeleteRequest(BaseModel):
    performance_id: str
    piece: str = ""
    sheet_id: int | None = None


class SheetPartUpdateRequest(BaseModel):
    part: str = ""


class SheetBulkPartUpdateRequest(BaseModel):
    sheet_ids: list[int] = []
    part: str = ""


class PortalLoginRequest(BaseModel):
    name: str = ""
    part: str = ""
    password: str
    device_id: str
    device_name: str = ""
    user_agent: str = ""


class MemberPasswordSetupRequest(BaseModel):
    name: str
    part: str = ""
    password: str


class ExtraUpsertRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    expected_updated_at: str = ""
