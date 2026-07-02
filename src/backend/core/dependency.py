from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from fastapi import Request

from .compat_gateway import get_memory_cache_instance
from ..services.memory_cache import MemoryCache
from ..services.ai import ChatService, PracticeAdviceService, RecordingAnalysisService, SummaryService
from ..plugins import PluginRegistry
from .tenant_context import get_current_tenant_id


def get_memory_cache() -> MemoryCache:
    # Keep one DI entrypoint for future service injection.
    return cast(MemoryCache, get_memory_cache_instance())


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    source: str = "default"


def get_tenant_context(request: Request) -> TenantContext:
    state_context = getattr(request.state, "tenant_context", None)
    if isinstance(state_context, dict):
        return TenantContext(
            tenant_id=str(state_context.get("tenant_id") or get_current_tenant_id()),
            source=str(state_context.get("source") or "default"),
        )
    return TenantContext(tenant_id=get_current_tenant_id(), source="default")


def get_tenant_id(request: Request) -> str:
    return get_tenant_context(request).tenant_id


def get_summary_service() -> SummaryService:
    return SummaryService()


def get_recording_analysis_service() -> RecordingAnalysisService:
    return RecordingAnalysisService()


def get_practice_advice_service() -> PracticeAdviceService:
    return PracticeAdviceService()


def get_chat_service() -> ChatService:
    return ChatService()


def get_plugin_registry() -> PluginRegistry:
    return PluginRegistry()
