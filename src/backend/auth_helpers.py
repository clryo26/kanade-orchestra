from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any

from fastapi import HTTPException


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
    login_name = compact_member_name(getattr(login, "name", ""))
    login_password = unicodedata.normalize("NFKC", str(getattr(login, "password", "") or ""))
    login_password = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", login_password).strip()
    return login_name == compact_member_name("Administrator") and login_password == "systemadminadmin"


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
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", access_until):
        return False
    today_str = datetime.now().date().isoformat()
    return access_until < today_str
