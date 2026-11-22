# Pure tests for member password-set response metadata.
import pytest

from src.backend.services import auth_service


@pytest.mark.parametrize(
    ("password_fields", "expected"),
    [
        ({}, False),
        ({"password": None}, False),
        ({"password": ""}, False),
        ({"password": " \t\n "}, False),
        ({"password": "設定済み"}, False),
        ({"password": "********"}, False),
        ({"password": "**********"}, False),
        ({"password": "password_set"}, False),
        ({"password": "(set)"}, False),
        ({"password": "set"}, False),
        ({"password": " \t設定済み\n"}, False),
        ({"password": " ******** "}, False),
        ({"password": " ********** "}, False),
        ({"password": " password_set "}, False),
        ({"password": " (set) "}, False),
        ({"password": " set "}, False),
        ({"password": "example-only-value"}, True),
        ({"password": "$2b$12$synthetic.hash.example.only"}, True),
        ({"password": "SET"}, True),
        ({"password": "PASSWORD_SET"}, True),
        ({"password": "(SET)"}, True),
        ({"password": " set-synthetic "}, True),
    ],
)
def test_password_set_metadata_and_input_preservation(password_fields, expected):
    member = {
        "id": 0,
        "photo_url": "",
        "password_set": not expected,
        "created_at": "synthetic-created",
        "updated_at": "synthetic-updated",
        "name": "Synthetic Member",
        "permission": "synthetic-permission",
        "comment": "retained comment",
        "custom_field": "retained value",
        **password_fields,
    }
    original = dict(member)

    result = auth_service._public_member_payload_base(member)

    assert result["password_set"] is expected
    assert result["id"] == 0
    assert result["photo_url"] == ""
    assert result["name"] == "Synthetic Member"
    assert result["permission"] == "synthetic-permission"
    assert result["comment"] == "retained comment"
    assert result["custom_field"] == "retained value"
    for key in ("password", "created_at", "updated_at"):
        assert key not in result
    assert member == original


@pytest.mark.parametrize("include_nulls", [False, True])
def test_response_normalization_preserves_input(include_nulls):
    text_fields = (
        "name", "last_name", "first_name", "maiden_name",
        "last_name_kana", "first_name_kana", "maiden_name_kana",
        "part", "permission", "joined_at", "system_access_until",
        "introducer", "role", "instrument_history", "past_orchestras", "comment",
    )
    member = {
        **({key: None for key in text_fields} if include_nulls else {}),
        "id": 0,
        "photo_url": "",
        "is_founder": "synthetic-truthy",
        "is_recording_manager": 0,
        "is_sheet_manager": None,
    }
    original = dict(member)

    result = auth_service._public_member_payload_base(member)

    assert result["password_set"] is False
    assert result["id"] == 0
    assert result["photo_url"] == ""
    for key in text_fields:
        assert result[key] == ""
    assert result["is_founder"] is True
    assert result["is_recording_manager"] is False
    assert result["is_sheet_manager"] is False
    for key in ("password", "created_at", "updated_at"):
        assert key not in result
    assert member == original
