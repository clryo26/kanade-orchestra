from __future__ import annotations

import hmac
import secrets
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from src.backend.auth_helpers import is_hidden_system_admin_login
from src.backend.services.security_service import hash_password


@pytest.mark.parametrize("missing", ["both", "name", "hash"])
def test_hidden_admin_is_disabled_without_complete_configuration(monkeypatch, missing):
    monkeypatch.setenv("HIDDEN_ADMIN_NAME", "offline-admin")
    monkeypatch.setenv("HIDDEN_ADMIN_PASSWORD_HASH", hash_password("example-password-47"))
    if missing in {"both", "name"}:
        monkeypatch.delenv("HIDDEN_ADMIN_NAME", raising=False)
    if missing in {"both", "hash"}:
        monkeypatch.delenv("HIDDEN_ADMIN_PASSWORD_HASH", raising=False)
    assert not is_hidden_system_admin_login(SimpleNamespace(name="offline-admin", password="example-password-47"))


@pytest.mark.parametrize("missing", ["both", "name", "hash"])
def test_configured_credentials_match_after_existing_normalization(hidden_admin_credentials, monkeypatch, missing):
    name, password = hidden_admin_credentials
    if missing == "name":
        name = " \u200bＯＦＦＬＩＮＥ－ＨＩＤＤＥＮ－ＡＤＭＩＮ\ufeff "
    elif missing == "hash":
        password = " \u200bｏｆｆｌｉｎｅ－ｈｉｄｄｅｎ－ｐａｓｓ－４７\ufeff "
    assert is_hidden_system_admin_login(SimpleNamespace(name=name, password=password))


@pytest.mark.parametrize("name", ["", " ", "\u200b", "\u3000"])
def test_blank_normalized_configured_name_is_disabled(monkeypatch, name):
    monkeypatch.setenv("HIDDEN_ADMIN_NAME", name)
    monkeypatch.setenv("HIDDEN_ADMIN_PASSWORD_HASH", hash_password("example-password-47"))
    assert not is_hidden_system_admin_login(SimpleNamespace(name=name, password="example-password-47"))


@pytest.mark.parametrize("stored", [
    "", "example-password-47", "sha256$salt$1234", "pbkdf2$sha256$0$salt$digest",
    "pbkdf2$sha256$260000$salt$digest", "pbkdf2$sha512$260000$salt$digest",
])
def test_hidden_admin_rejects_plaintext_and_malformed_hashes(monkeypatch, stored):
    monkeypatch.setenv("HIDDEN_ADMIN_NAME", "offline-admin")
    monkeypatch.setenv("HIDDEN_ADMIN_PASSWORD_HASH", stored)
    assert not is_hidden_system_admin_login(SimpleNamespace(name="offline-admin", password="example-password-47"))


@pytest.mark.parametrize(("name", "password"), [
    ("different-admin", "offline-hidden-pass-47"),
    ("offline-hidden-admin", "wrong-password"),
    ("", "offline-hidden-pass-47"),
    ("offline-hidden-admin", ""),
])
def test_incorrect_credentials_are_rejected(hidden_admin_credentials, name, password):
    assert not is_hidden_system_admin_login(SimpleNamespace(name=name, password=password))


def test_password_is_verified_even_when_name_does_not_match(hidden_admin_credentials):
    with patch("src.backend.auth_helpers.verify_password", return_value=True) as verify:
        assert not is_hidden_system_admin_login(SimpleNamespace(name="different-admin", password="example"))
    verify.assert_called_once()


def test_comparisons_use_constant_time_primitives(hidden_admin_credentials):
    name, password = hidden_admin_credentials
    with (
        patch("src.backend.auth_helpers.hmac.compare_digest", wraps=hmac.compare_digest) as name_compare,
        patch("src.backend.services.security_service.secrets.compare_digest", wraps=secrets.compare_digest) as password_compare,
    ):
        assert is_hidden_system_admin_login(SimpleNamespace(name=name, password=password))
    assert name_compare.call_count == 2
    password_compare.assert_called_once()


def test_configured_hash_cannot_be_used_as_the_login_password(hidden_admin_credentials, monkeypatch):
    import os

    name, _ = hidden_admin_credentials
    stored = os.environ["HIDDEN_ADMIN_PASSWORD_HASH"]
    assert not is_hidden_system_admin_login(SimpleNamespace(name=name, password=stored))
    assert not is_hidden_system_admin_login(SimpleNamespace(name=name, password=" " + stored + " "))


@pytest.mark.parametrize(("name", "password", "expected"), [
    ("offline-hidden-admin", "offline-hidden-pass-47", True),
    (" OFFLINE-HIDDEN-ADMIN ", " offline-hidden-pass-47 ", True),
    ("ｏｆｆｌｉｎｅ－ｈｉｄｄｅｎ－ａｄｍｉｎ", "ｏｆｆｌｉｎｅ－ｈｉｄｄｅｎ－ｐａｓｓ－４７", True),
    ("off\u200bline-hidden-admin", "off\ufeffline-hidden-pass-47", True),
    ("someone-else", "offline-hidden-pass-47", False),
    ("offline-hidden-admin", "incorrect-password", False),
    ("offline-hidden-admin", "OFFLINE-HIDDEN-PASS-47", False),
    ("", "offline-hidden-pass-47", False),
    ("offline-hidden-admin", "", False),
])
def test_configured_hidden_admin_retains_normalization(hidden_admin_credentials, name, password, expected):
    assert is_hidden_system_admin_login(SimpleNamespace(name=name, password=password)) is expected


def test_name_and_password_are_checked_even_when_name_is_wrong(hidden_admin_credentials):
    import src.backend.auth_helpers as helpers

    actual = helpers.verify_password
    with patch.object(helpers, "verify_password", wraps=actual) as verify, patch.object(
        helpers.hmac, "compare_digest", wraps=helpers.hmac.compare_digest
    ) as compare:
        assert not helpers.is_hidden_system_admin_login(
            SimpleNamespace(name="wrong-account", password="offline-hidden-pass-47")
        )
    verify.assert_called_once()
    assert any(call.args == (b"wrong-account", b"offline-hidden-admin") for call in compare.call_args_list)


def test_disabled_account_does_not_verify_password(monkeypatch):
    monkeypatch.delenv("HIDDEN_ADMIN_NAME", raising=False)
    monkeypatch.delenv("HIDDEN_ADMIN_PASSWORD_HASH", raising=False)
    with patch("src.backend.auth_helpers.verify_password") as verify:
        assert not is_hidden_system_admin_login(SimpleNamespace(name="offline-admin", password="example-password-47"))
    verify.assert_not_called()


def test_hidden_admin_configuration_is_reloaded_for_each_login(monkeypatch, hidden_admin_credentials):
    login = SimpleNamespace(name="offline-hidden-admin", password="offline-hidden-pass-47")
    assert is_hidden_system_admin_login(login)
    monkeypatch.delenv("HIDDEN_ADMIN_PASSWORD_HASH")
    assert not is_hidden_system_admin_login(login)
