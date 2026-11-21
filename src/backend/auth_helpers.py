from __future__ import annotations

import hmac
import os
import re
import unicodedata
from typing import Any

from fastapi import HTTPException

from .services.security_service import verify_password
from .utils.datetime_utils import InvalidDateTimeValue, jst_today, parse_calendar_date


def compact_member_name(value: Any) -> str:
    # スマホIME入力由来の全角/半角揺れや不可視文字を吸収して照合する。
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", text)
    return re.sub(r"[\s\u3000]+", "", text).strip().lower()


def compact_member_part(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", text)
    return re.sub(r"[\s\u3000]+", "", text).strip().lower()


def member_display_name(member: dict[str, Any]) -> str:
    full_name = f"{member.get('last_name') or ''}{member.get('first_name') or ''}"
    return full_name or str(member.get("name") or "")


def member_login_names(member: dict[str, Any]) -> set[str]:
    names = {
        member_display_name(member),
        f"{member.get('last_name') or ''}{member.get('first_name') or ''}",
        f"{member.get('last_name_kana') or ''}{member.get('first_name_kana') or ''}",
    }
    if member.get("maiden_name"):
        names.add(f"{member.get('maiden_name') or ''}{member.get('first_name') or ''}")
    if member.get("maiden_name_kana"):
        names.add(f"{member.get('maiden_name_kana') or ''}{member.get('first_name_kana') or ''}")
    return {compact_member_name(name) for name in names if compact_member_name(name)}


def find_member_by_login_name(items: list[dict[str, Any]], name: str, part: str = "") -> tuple[int, dict[str, Any]]:
    normalized = compact_member_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="name is required")

    normalized_part = compact_member_part(part)
    candidates: list[tuple[int, dict[str, Any]]] = []
    for index, item in enumerate(items):
        if normalized in member_login_names(item):
            candidates.append((index, item))

    if not candidates:
        raise HTTPException(status_code=404, detail="Member not found")

    if normalized_part:
        strict_matches = [
            (index, item)
            for index, item in candidates
            if compact_member_part(member_part(item)) == normalized_part
        ]
        if strict_matches:
            return strict_matches[0]

        if len(candidates) == 1:
            return candidates[0]

    raise HTTPException(status_code=404, detail="Member not found")


def is_hidden_system_admin_login(login: Any) -> bool:
    configured_name = os.environ.get("HIDDEN_ADMIN_NAME", "")
    configured_hash = os.environ.get("HIDDEN_ADMIN_PASSWORD_HASH", "")
    normalized_name = compact_member_name(configured_name)
    # Restrict this privileged account to hash_password's current storage format.
    # verify_password also accepts legacy plain text for ordinary member migration.
    if not normalized_name or not re.fullmatch(
        r"pbkdf2\$sha256\$[1-9][0-9]*\$[0-9a-f]{32}\$[0-9a-f]{64}", configured_hash
    ):
        return False

    login_name = compact_member_name(getattr(login, "name", ""))
    login_password = unicodedata.normalize("NFKC", str(getattr(login, "password", "") or ""))
    login_password = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", login_password).strip()
    password_matches = verify_password(login_password, configured_hash)
    name_matches = hmac.compare_digest(
        login_name.encode("utf-8"), normalized_name.encode("utf-8")
    )
    # verify_password retains a plaintext fallback for old member records.
    # Never accept the configured hash itself as a privileged credential.
    submitted_hash = hmac.compare_digest(
        login_password.encode("utf-8"), configured_hash.encode("utf-8")
    )
    return name_matches and password_matches and not submitted_hash


def member_part(member: dict[str, Any]) -> str:
    return str(member.get("part") or "")


def member_is_extra(member: dict[str, Any]) -> bool:
    return str(member.get("permission") or "") == "エキストラ"


def member_access_expired(member: dict[str, Any]) -> bool:
    if not member_is_extra(member):
        return False
    access_until = str(member.get("system_access_until") or "").strip()
    if not access_until:
        return False
    try:
        last_day = parse_calendar_date(access_until, field="system_access_until")
    except InvalidDateTimeValue:
        # Unchanged rule: a value that is not a valid date does not expire.
        return False
    # The last day is valid all day in Japan; expired from 00:00 JST the next
    # day, independent of the server timezone (JST spec R04).
    return last_day < jst_today()
