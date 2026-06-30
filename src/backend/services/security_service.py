from __future__ import annotations

import hashlib
import secrets

_PBKDF2_ALGO = "sha256"
_PBKDF2_ITERATIONS = 260000


def hash_password(password: str) -> str:
    """Hash a member password.

    The current format is:
        pbkdf2$sha256$<iterations>$<salt>$<hex_hash>

    Older data may still contain either the legacy `sha256$<salt>$<hash>`
    format or a plain text password. `verify_password` keeps compatibility
    with those formats so existing members are not locked out after refactor.
    """
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        _PBKDF2_ALGO,
        password.encode("utf-8"),
        salt.encode("utf-8"),
        _PBKDF2_ITERATIONS,
    ).hex()
    return f"pbkdf2${_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt}${digest}"


def _verify_pbkdf2(password: str, stored: str) -> bool:
    try:
        _, algo, iterations_text, salt, digest = stored.split("$", 4)
        iterations = int(iterations_text)
    except (ValueError, TypeError):
        return False
    if algo != _PBKDF2_ALGO or iterations <= 0:
        return False
    expected = hashlib.pbkdf2_hmac(
        algo,
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations,
    ).hex()
    return secrets.compare_digest(expected, digest)


def _verify_legacy_sha256(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    expected = hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()
    return secrets.compare_digest(expected, digest)


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    if stored.startswith("pbkdf2$"):
        return _verify_pbkdf2(password, stored)
    if stored.startswith("sha256$"):
        return _verify_legacy_sha256(password, stored)
    # Legacy plain-text passwords from early data are accepted once. The login
    # endpoint migrates plain text to a hashed value after successful login.
    return secrets.compare_digest(password, stored)


def is_hashed_password(stored: str) -> bool:
    return bool(stored and (stored.startswith("pbkdf2$") or stored.startswith("sha256$")))
