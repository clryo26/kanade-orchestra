"""Shared notification categories and safe target routes."""
from __future__ import annotations

NOTIFICATION_TYPES = {
    "notices": ("お知らせ", "notice-history"),
    "schedules": ("練習予定", "member-schedule"),
    "recordings": ("録音部屋", "member-recording"),
    "piece_infos": ("楽曲情報", "member-piece-info"),
    "sheets": ("楽譜ライブラリ", "member-sheet"),
    "events": ("イベント調整", "member-event"),
    "maintenance": ("メンテナンス情報", "maintenance-history"),
    "improvements": ("改善要望受付", "system-improvement-suggestion"),
}

DEFAULT_PREFERENCES = dict.fromkeys(NOTIFICATION_TYPES, True)
