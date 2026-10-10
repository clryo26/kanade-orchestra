"""Shared main-menu presentation settings; never an authorization policy."""
from __future__ import annotations

import hashlib
import json
import logging

from fastapi import HTTPException

from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from ..repositories.menu_settings_repository import MenuSettingsRepository

logger = logging.getLogger(__name__)

# Stable tab/action keys from portalMenuGroups(), independent of the viewer's role.
# The system entry is intentionally absent and cannot be persisted as hidden.
MENU_GROUPS = (
    ("練習情報", (("member-schedule", "練習予定"), ("member-practice-instruction", "練習指示"), ("member-recording", "録音部屋"))),
    ("演奏会情報", (("member-performance", "次回演奏会"), ("member-flyer-distribution", "チラシ配布"), ("member-performance-day", "本番情報"), ("member-piece-info", "楽曲情報"), ("member-sheet", "楽譜ライブラリ"), ("member-casting", "乗り番表"))),
    ("団員情報", (("member-intro", "団員紹介"), ("member-payment", "支払状況"))),
    ("団体情報", (("member-event", "イベント調整"), ("member-sns", "SNS"), ("member-date-adjustment", "日程調整"), ("member-desired-piece", "演奏希望曲"))),
    ("記録", (("member-promotion", "宣伝"), ("member-album", "アルバム"), ("member-concert-record", "演奏会記録"))),
    ("設定", (("notification-settings", "通知設定"), ("upload", "録音管理"), ("sheet-admin", "楽譜管理"), ("admin", "管理者メニュー"))),
)
MENU_KEYS = frozenset(key for _, items in MENU_GROUPS for key, _ in items)
OPTIONAL_MENU_KEYS = frozenset({"notification-settings"})
REQUIRED_MENU_KEYS = MENU_KEYS - OPTIONAL_MENU_KEYS


def _repository() -> MenuSettingsRepository:
    return MenuSettingsRepository()


def visibility_settings() -> dict[str, bool]:
    defaults = dict.fromkeys(sorted(MENU_KEYS), True)
    # Existing explicit local-JSON development mode can render default menus,
    # but settings are never written to JSON or process-local memory.
    if local_json_fallback_enabled():
        return defaults
    try:
        stored = _repository().load(get_current_tenant_id())
    except Exception as exc:
        logger.warning("Menu settings DB read failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="メニュー設定を取得できません。DB接続・マイグレーションを確認してください。") from exc
    return {key: stored.get(key, True) for key in defaults}


def management_payload(settings: dict[str, bool] | None = None) -> dict:
    settings = visibility_settings() if settings is None else settings
    return {
        "groups": [{"title": title, "items": [{"key": key, "label": label} for key, label in items]}
                   for title, items in MENU_GROUPS],
        "visibility": settings,
        "optional_keys": sorted(OPTIONAL_MENU_KEYS),
    }


def save_settings(settings: dict[str, bool]) -> dict:
    # Optional feature keys may be absent; required menus and unknown keys remain strict.
    if not REQUIRED_MENU_KEYS <= settings.keys() <= MENU_KEYS or any(not isinstance(value, bool) for value in settings.values()):
        raise HTTPException(status_code=400, detail="対象メニューすべての表示設定を指定してください。")
    if local_json_fallback_enabled():
        raise HTTPException(status_code=503, detail="メニュー設定の保存にはPostgreSQLが必要です。")
    try:
        saved = _repository().save(get_current_tenant_id(), settings)
    except Exception as exc:
        logger.warning("Menu settings DB save failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="メニュー設定を保存できませんでした。再試行してください。") from exc
    return management_payload({key: saved.get(key, True) for key in sorted(MENU_KEYS)})


def bootstrap_etag(base_etag: str, settings: dict[str, bool]) -> str:
    # Hash the same snapshot sent in the response, including its organization.
    content = json.dumps([base_etag, get_current_tenant_id(), settings], sort_keys=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
