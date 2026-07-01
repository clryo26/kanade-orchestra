from __future__ import annotations

from contextvars import ContextVar, Token

_DEFAULT_TENANT_ID = "default"
_CURRENT_TENANT_ID: ContextVar[str] = ContextVar("current_tenant_id", default=_DEFAULT_TENANT_ID)


def normalize_tenant_id(value: str | None) -> str:
    tenant_id = str(value or "").strip()
    return tenant_id or _DEFAULT_TENANT_ID


def get_current_tenant_id() -> str:
    return normalize_tenant_id(_CURRENT_TENANT_ID.get())


def set_current_tenant_id(value: str | None) -> Token[str]:
    return _CURRENT_TENANT_ID.set(normalize_tenant_id(value))


def reset_current_tenant_id(token: Token[str]) -> None:
    _CURRENT_TENANT_ID.reset(token)
