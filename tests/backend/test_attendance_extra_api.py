from __future__ import annotations

from tests.conftest import seed_device


def _headers() -> dict[str, str]:
    return {"X-Device-Id": "attendance-member"}


def _seed_member(backend_env) -> None:
    backend_env.save_json_data("members", [{"id": 1, "name": "団員A", "part": "Vn", "permission": "一般"}])
    backend_env.save_json_data("schedules", [{"id": 10, "date": "2026-08-20", "venue": "練習場"}])
    seed_device(backend_env, device_id="attendance-member", member_id=1, member_name="団員A", permission="一般")


def test_attendance_accepts_all_supported_statuses_and_normalizes_optional_time(client, backend_env):
    _seed_member(backend_env)
    for status, planned_time in (("present", ""), ("absent", ""), ("late", "14:00"), ("leave_early", "16:30")):
        response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": status, "planned_time": planned_time})
        assert response.status_code == 200
        assert response.json()["status"] == status
        assert response.json()["planned_time"] == planned_time


def test_attendance_requires_time_for_late_or_leave_early(client, backend_env):
    _seed_member(backend_env)
    response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "late"})
    assert response.status_code == 422
    assert "planned_time" in response.json()["detail"]


def test_attendance_post_updates_existing_member_schedule_response(client, backend_env):
    _seed_member(backend_env)
    first = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "absent"})
    second = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "late", "planned_time": "14:00"})
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    saved = client.get("/api/extra/absences").json()
    assert len(saved) == 1
    assert saved[0]["status"] == "late"


def test_attendance_rejects_unsupported_status_but_keeps_legacy_rows_readable(client, backend_env):
    _seed_member(backend_env)
    backend_env.save_json_data("absences", [{"id": 9, "schedule_id": 10, "member_id": 1, "name": "団員A", "status": "ng"}])
    assert client.get("/api/extra/absences").json()[0]["status"] == "ng"
    response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "ng"})
    assert response.status_code == 422


def test_attendance_does_not_overwrite_same_name_record_owned_by_another_member(client, backend_env):
    _seed_member(backend_env)
    backend_env.save_json_data("absences", [{"id": 9, "schedule_id": 10, "member_id": 2, "name": "団員A", "status": "absent"}])

    response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "present"})

    assert response.status_code == 200
    assert response.json()["id"] != 9
    saved = client.get("/api/extra/absences").json()
    other_member = next(item for item in saved if item["id"] == 9)
    assert other_member["member_id"] == 2
    assert other_member["status"] == "absent"


def test_attendance_updates_one_unambiguous_legacy_name_only_record(client, backend_env):
    _seed_member(backend_env)
    backend_env.save_json_data("absences", [{"id": 9, "schedule_id": 10, "member_id": "", "name": "団員A", "status": "absent"}])

    response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "late", "planned_time": "14:00"})

    assert response.status_code == 200
    assert response.json()["id"] == 9
    assert client.get("/api/extra/absences").json() == [response.json()]


def test_attendance_does_not_overwrite_ambiguous_legacy_name_only_records(client, backend_env):
    _seed_member(backend_env)
    backend_env.save_json_data(
        "absences",
        [
            {"id": 8, "schedule_id": 10, "member_id": "", "name": "団員A", "status": "absent"},
            {"id": 9, "schedule_id": 10, "member_id": "", "name": "団員A", "status": "late", "planned_time": "14:00"},
        ],
    )

    response = client.post("/api/extra/absences", headers=_headers(), json={"schedule_id": 10, "member_id": 1, "name": "団員A", "status": "present"})

    assert response.status_code == 200
    assert response.json()["id"] not in {8, 9}
    saved = client.get("/api/extra/absences").json()
    assert next(item for item in saved if item["id"] == 8)["status"] == "absent"
    assert next(item for item in saved if item["id"] == 9)["status"] == "late"
