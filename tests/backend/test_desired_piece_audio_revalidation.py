from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.backend.services import extra_service


def payload(**changes):
    return {"title": "Wish", "composer": "Composer", "duration": "5:00", "genre": "クラシック",
            "formation": "Orchestra", "notes": "memo", "votes": [],
            "reference_audio_url": "https://www.youtube.com/watch?v=abcdefghijk", **changes}


def create(client, seed_device_fn, monkeypatch):
    seed_device_fn(device_id="audio-owner", permission="一般", member_id="audio-owner", member_name="Owner")
    validations = []

    def validate(url):
        validations.append(url)
        if "example.com" in url:
            raise HTTPException(status_code=400, detail="invalid YouTube URL")
        return url

    monkeypatch.setattr(extra_service, "validate_youtube_url", validate)
    headers = {"X-Device-Id": "audio-owner"}
    response = client.post("/api/extra/desired_pieces", headers=headers, json=payload())
    assert response.status_code == 200, response.text
    validations.clear()
    return headers, response.json(), validations


@pytest.mark.parametrize("change", [{"votes": [{"member_id": "audio-owner", "name": "Owner"}]}, {"sort_order": 2}, {"notes": "new memo"}])
def test_unchanged_audio_skips_lookup(client, seed_device_fn, monkeypatch, change):
    headers, item, validations = create(client, seed_device_fn, monkeypatch)
    response = client.put(f"/api/extra/desired_pieces/{item['id']}", headers=headers,
                          json={"payload": {**item, **change}, "expected_updated_at": item["updated_at"]})
    assert response.status_code == 200, response.text
    assert response.json()["reference_audio_url"] == item["reference_audio_url"]
    assert validations == []


def test_missing_audio_field_preserves_current_url(client, seed_device_fn, monkeypatch):
    headers, item, validations = create(client, seed_device_fn, monkeypatch)
    response = client.put(f"/api/extra/desired_pieces/{item['id']}", headers=headers, json={"notes": "partial"})
    assert response.status_code == 200, response.text
    assert response.json()["reference_audio_url"] == item["reference_audio_url"]
    assert validations == []


def test_changed_url_is_checked_even_if_client_claims_unchanged(client, seed_device_fn, monkeypatch):
    headers, item, validations = create(client, seed_device_fn, monkeypatch)
    changed = "https://example.com/invalid"
    response = client.put(f"/api/extra/desired_pieces/{item['id']}", headers=headers,
                          json={**item, "reference_audio_url": changed, "audio_unchanged": True})
    assert response.status_code == 400
    assert validations == [changed]


def test_reference_changed_between_preflight_and_commit_is_not_overwritten(monkeypatch):
    old = payload(id=1, member_id="owner")
    monkeypatch.setattr(extra_service, "_store", lambda: SimpleNamespace(get=lambda *_args: dict(old)))
    monkeypatch.setattr(extra_service, "validate_youtube_url", lambda _url: pytest.fail("unchanged URL must not fetch"))
    mutate = extra_service.build_update_mutate("desired_pieces", 1, dict(old),
                                               {"member_id": "owner", "permission": "管理者"}, None)
    with pytest.raises(HTTPException) as caught:
        mutate({**old, "reference_audio_url": "https://www.youtube.com/watch?v=12345678901"})
    assert caught.value.status_code == 409


def test_unchecked_url_is_rejected_if_actor_becomes_owner_before_commit(monkeypatch):
    before = payload(id=1, member_id="other-owner")
    monkeypatch.setattr(extra_service, "_store", lambda: SimpleNamespace(get=lambda *_args: dict(before)))
    monkeypatch.setattr(extra_service, "validate_youtube_url", lambda _url: pytest.fail("non-owner preflight must not fetch"))
    mutate = extra_service.build_update_mutate(
        "desired_pieces", 1, {**before, "reference_audio_url": "https://example.com/unvalidated"},
        {"member_id": "new-owner", "member_name": "New Owner", "permission": "一般"}, None,
    )
    # Ownership can change after the unlocked comparison. The locked row now
    # permits an owner edit, but that must not promote an unchecked URL.
    with pytest.raises(HTTPException) as caught:
        mutate({**before, "member_id": "new-owner"})
    assert caught.value.status_code == 409


def test_another_members_vote_keeps_existing_votes_without_lookup(client, seed_device_fn, monkeypatch):
    headers, item, validations = create(client, seed_device_fn, monkeypatch)
    response = client.put(f"/api/extra/desired_pieces/{item['id']}", headers=headers,
                          json={**item, "votes": [{"member_id": "audio-owner", "name": "Owner"}]})
    assert response.status_code == 200, response.text
    current = response.json()
    seed_device_fn(device_id="audio-voter", permission="一般", member_id="audio-voter", member_name="Voter")
    voted = client.put(f"/api/extra/desired_pieces/{item['id']}", headers={"X-Device-Id": "audio-voter"},
                       json={**current, "votes": [{"member_id": "audio-voter", "name": "Voter"}]})
    assert voted.status_code == 200, voted.text
    assert {str(v["member_id"]) for v in voted.json()["votes"]} == {"audio-owner", "audio-voter"}
    assert validations == []


def test_new_audio_is_validated_and_saved(client, seed_device_fn, monkeypatch):
    headers, item, validations = create(client, seed_device_fn, monkeypatch)
    changed = "https://www.youtube.com/watch?v=12345678901"
    response = client.put(f"/api/extra/desired_pieces/{item['id']}", headers=headers,
                          json={**item, "reference_audio_url": changed})
    assert response.status_code == 200, response.text
    assert response.json()["reference_audio_url"] == changed
    assert validations == [changed]
