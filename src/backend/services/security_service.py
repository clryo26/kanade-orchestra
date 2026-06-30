from __future__ import annotations

import hashlib
import secrets


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return f"sha256${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    if not stored.startswith("sha256$"):
        return secrets.compare_digest(password, stored)
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    expected = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return secrets.compare_digest(expected, digest)


def is_hashed_password(stored: str) -> bool:
    return bool(stored and stored.startswith("sha256$"))
