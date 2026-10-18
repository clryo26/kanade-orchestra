"""Personal metronome practice history API (summaries only).

The metronome is limited to system administrators in the laboratory, so
these endpoints use the system-administrator dependency. Even for them the
data is strictly personal: the owner is resolved from the caller's own
member and there is no endpoint to read another person's history.
Responses are never cached (personal data on possibly shared devices).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query, Response

from ..core.auth_dependencies import get_system_admin_device_auth
from ..services import metronome_service


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/metronome", dependencies=[Depends(_no_store)])

# Public scope of the metronome (laboratory, system administrators only).
MetronomeUser = Depends(get_system_admin_device_auth)


@router.get("/identity")
async def metronome_identity(device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.identity(device)


@router.get("/preferences")
async def metronome_get_preferences(device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.get_preferences(device)


@router.put("/preferences")
async def metronome_put_preferences(body: dict[str, Any] = Body(...), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.put_preferences(device, body)


@router.post("/sessions")
async def metronome_create_session(response: Response, body: dict[str, Any] = Body(...), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    data, created = metronome_service.create_session(device, body)
    response.status_code = 201 if created else 200
    return data


@router.put("/sessions/{session_id}/parts/{index}")
async def metronome_put_part(session_id: str, index: int, body: dict[str, Any] = Body(...), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.put_part(device, session_id, index, body)


@router.post("/sessions/{session_id}/finalize")
async def metronome_finalize(session_id: str, body: dict[str, Any] = Body(...), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.finalize_session(device, session_id, body)


@router.get("/sessions")
async def metronome_list_sessions(
    device: dict[str, Any] = MetronomeUser,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    condition: str | None = None,
    cursor: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    return metronome_service.list_sessions(device, {"from": from_, "to": to, "condition": condition, "cursor": cursor, "limit": limit})


@router.get("/sessions/{session_id}")
async def metronome_get_session(session_id: str, device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.get_session(device, session_id)


# DELETE carries a JSON body (operationId / historyEpoch), like the design's
# FastAPI contract; MT-14 checks that it is not dropped on the way.
@router.delete("/sessions/{session_id}")
async def metronome_delete_session(session_id: str, body: dict[str, Any] | None = Body(default=None), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.delete_session(device, session_id, body)


@router.delete("/history")
async def metronome_delete_history(body: dict[str, Any] | None = Body(default=None), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.delete_history(device, body)


@router.get("/presets")
async def metronome_list_presets(limit: int = 60, device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.list_presets(device, limit)


@router.post("/presets", status_code=201)
async def metronome_create_preset(body: dict[str, Any] = Body(...), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.create_preset(device, body)


@router.delete("/presets/{preset_id}")
async def metronome_delete_preset(preset_id: str, body: dict[str, Any] | None = Body(default=None), device: dict[str, Any] = MetronomeUser) -> dict[str, Any]:
    return metronome_service.delete_preset(device, preset_id, body)
