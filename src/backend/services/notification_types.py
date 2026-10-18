"""Shared notification categories and safe target routes."""
from __future__ import annotations

NOTIFICATION_TYPES = {
    "notices": ("お知らせ", "notice-history"),
    "schedules": ("練習予定", "member-schedule"),
    "practice_instructions": ("練習指示", "member-practice-instruction"),
    "piece_infos": ("楽曲情報", "member-piece-info"),
    "promotions": ("宣伝", "member-promotion"),
    "events": ("イベント調整", "member-event"),
    "maintenance": ("メンテナンス情報", "maintenance-history"),
    "improvements": ("改善要望受付", "system-improvement-suggestion"),
}

DEFAULT_PREFERENCES = dict.fromkeys(NOTIFICATION_TYPES, True)
