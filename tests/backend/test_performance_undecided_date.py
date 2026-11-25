from datetime import date, timedelta
import json

import pytest


def _multipart_performance(**overrides):
    payload = {
        "title": "Undecided concert",
        "date": "",
        "open_time": "18:00",
        "start_time": "19:00",
        "venue": "Old hall",
        "conductor": "Conductor",
        "flyer_image": "",
        "performance_fee_amount": "5000",
        "pieces": json.dumps([{"title": "Symphony"}]),
        "expected_updated_at": "",
    }
    payload.update(overrides)
    # Filename-less parts force the same multipart parser used by browser FormData,
    # including an explicitly empty date, without attaching a flyer file.
    return {key: (None, value) for key, value in payload.items()}


def _get_performance(client, performance_id):
    response = client.get(f"/api/performances/{performance_id}")
    assert response.status_code == 200
    return response.json()


def _assert_multipart(response):
    assert response.request.headers["content-type"].startswith("multipart/form-data;")


@pytest.fixture
def undecided_performance(client, seed_device_fn, admin_headers_fixture):
    seed_device_fn(device_id="dev-admin", permission="管理者")
    response = client.post(
        "/api/performances",
        headers=admin_headers_fixture,
        files=_multipart_performance(),
    )
    assert response.status_code == 200
    _assert_multipart(response)
    assert response.json()["date"] == ""
    return response.json()


def test_create_undecided_performance_and_future_schedule(
    client, undecided_performance, admin_headers_fixture
):
    performance_id = undecided_performance["id"]
    listed = client.get("/api/performances")
    assert listed.status_code == 200
    saved = next(item for item in listed.json() if item["id"] == performance_id)
    assert saved["date"] == ""
    assert saved["pieces"] == [{"title": "Symphony"}]

    practice_date = (date.today() + timedelta(days=30)).isoformat()
    response = client.post(
        "/api/schedules",
        headers=admin_headers_fixture,
        json={
            "date": practice_date,
            "start_time": "18:00",
            "end_time": "21:00",
            "venue": "Rehearsal hall",
            "performance_id": performance_id,
            "pieces": "Symphony",
        },
    )
    assert response.status_code == 200
    assert response.json()["performance_id"] == performance_id
    schedules = client.get("/api/schedules")
    assert schedules.status_code == 200
    saved_schedule = next(item for item in schedules.json() if item["id"] == response.json()["id"])
    assert saved_schedule["performance_id"] == performance_id
    assert saved_schedule["date"] == practice_date
    assert saved_schedule["pieces"] == "Symphony"


def test_update_venue_then_confirm_performance_date(
    client, undecided_performance, admin_headers_fixture
):
    performance_id = undecided_performance["id"]
    before = _get_performance(client, performance_id)
    response = client.put(
        f"/api/performances/{performance_id}",
        headers=admin_headers_fixture,
        files=_multipart_performance(venue="New hall", expected_updated_at=before["updated_at"]),
    )
    _assert_multipart(response)
    assert response.status_code == 200
    assert response.json()["date"] == ""
    assert response.json()["venue"] == "New hall"
    saved = _get_performance(client, performance_id)
    assert saved["date"] == ""
    assert saved["venue"] == "New hall"
    assert saved["pieces"] == before["pieces"]
    assert saved["performance_fee_amount"] == before["performance_fee_amount"]

    response = client.put(
        f"/api/performances/{performance_id}",
        headers=admin_headers_fixture,
        files=_multipart_performance(
            date="2027-06-20", venue="New hall", expected_updated_at=saved["updated_at"]
        ),
    )
    _assert_multipart(response)
    assert response.status_code == 200
    assert response.json()["date"] == "2027-06-20"
    saved = _get_performance(client, performance_id)
    assert saved["date"] == "2027-06-20"
    assert saved["venue"] == "New hall"
    assert saved["pieces"] == before["pieces"]
    assert saved["performance_fee_amount"] == before["performance_fee_amount"]


def test_invalid_multipart_post_does_not_add_performance(
    client, undecided_performance, admin_headers_fixture
):
    before_list = client.get("/api/performances")
    assert before_list.status_code == 200
    response = client.post(
        "/api/performances",
        headers=admin_headers_fixture,
        files=_multipart_performance(date="2026-13-40"),
    )
    _assert_multipart(response)
    assert response.status_code == 422
    after_list = client.get("/api/performances")
    assert after_list.status_code == 200
    assert after_list.json() == before_list.json()


@pytest.mark.parametrize("saved_date", ["", "2027-06-20"])
def test_invalid_multipart_put_does_not_change_saved_performance(
    client, undecided_performance, admin_headers_fixture, saved_date
):
    performance_id = undecided_performance["id"]
    if saved_date:
        before = _get_performance(client, performance_id)
        response = client.put(
            f"/api/performances/{performance_id}",
            headers=admin_headers_fixture,
            files=_multipart_performance(
                date=saved_date, expected_updated_at=before["updated_at"]
            ),
        )
        _assert_multipart(response)
        assert response.status_code == 200
    before = _get_performance(client, performance_id)
    assert before["date"] == saved_date
    response = client.put(
        f"/api/performances/{performance_id}",
        headers=admin_headers_fixture,
        files=_multipart_performance(
            date="2026-13-40", venue="Must not be saved", expected_updated_at=before["updated_at"]
        ),
    )
    _assert_multipart(response)
    assert response.status_code == 422
    assert _get_performance(client, performance_id) == before
