"""Personal tuner practice history API (summaries only).

The tuner is still limited to system administrators in the laboratory, so
these endpoints use the system-administrator dependency. Even for them the
data is strictly personal: the owner is resolved from the caller's own
member and there is no endpoint to read another person's history.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import PlainTextResponse

from ..core.auth_dependencies import get_system_admin_device_auth
from ..services import tuner_service

router = APIRouter(prefix="/api/tuner")

# Public scope of the tuner (laboratory, system administrators only).
TunerUser = Depends(get_system_admin_device_auth)


@router.get("/identity")
async def tuner_identity(device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.identity(device)


@router.get("/preferences")
async def tuner_get_preferences(device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.get_preferences(device)


@router.put("/preferences")
async def tuner_put_preferences(body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.put_preferences(device, body)


@router.get("/instruments")
async def tuner_list_instruments(device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.list_instruments(device)


@router.post("/instruments")
async def tuner_create_instrument(body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.create_instrument(device, body)


@router.patch("/instruments/{instrument_id}")
async def tuner_update_instrument(instrument_id: str, body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.update_instrument(device, instrument_id, body)


@router.delete("/instruments/{instrument_id}")
async def tuner_delete_instrument(instrument_id: str, device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.delete_instrument(device, instrument_id)


@router.get("/presets")
async def tuner_list_presets(device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.list_presets(device)


@router.post("/presets")
async def tuner_create_preset(body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.create_preset(device, body)


@router.delete("/presets/{preset_id}")
async def tuner_delete_preset(preset_id: str, device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.delete_preset(device, preset_id)


@router.post("/sessions")
async def tuner_create_session(body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.create_session(device, body)


@router.put("/sessions/{session_id}/parts/{index}")
async def tuner_put_part(session_id: str, index: int, body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.put_part(device, session_id, index, body)


@router.post("/sessions/{session_id}/finalize")
async def tuner_finalize_session(session_id: str, body: dict[str, Any] = Body(...), device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.finalize_session(device, session_id, body)


@router.get("/sessions")
async def tuner_list_sessions(
    device: dict[str, Any] = TunerUser,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    instrument: str | None = None,
    kind: str | None = None,
    condition: str | None = None,
    cursor: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    query = {"from": from_, "to": to, "instrument": instrument, "kind": kind, "condition": condition, "cursor": cursor, "limit": limit}
    return tuner_service.list_sessions(device, query)


@router.get("/sessions/{session_id}")
async def tuner_get_session(session_id: str, cursor: str | None = None, device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.get_session(device, session_id, cursor)


@router.delete("/sessions/{session_id}")
async def tuner_delete_session(session_id: str, device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.delete_session(device, session_id)


@router.delete("/history")
async def tuner_delete_history(device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.delete_history(device)


@router.get("/diagnosis")
async def tuner_diagnosis(condition: str = "", device: dict[str, Any] = TunerUser) -> dict[str, Any]:
    return tuner_service.diagnosis(device, condition)


@router.get("/export", response_model=None)
async def tuner_export(format: str = "json", cursor: str | None = None, device: dict[str, Any] = TunerUser) -> Any:
    result = tuner_service.export_data(device, "csv" if format == "csv" else "json", cursor)
    if isinstance(result, str):
        return PlainTextResponse(result, media_type="text/csv; charset=utf-8", headers={"Cache-Control": "no-store"})
    return result
