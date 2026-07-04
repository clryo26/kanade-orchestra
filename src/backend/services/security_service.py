from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import unicodedata

_PBKDF2_ALGO = "sha256"
_PBKDF2_ITERATIONS = 260000

_PASSWORD_PLACEHOLDERS = {
    "設定済み",
    "********",
    "**********",
    "password_set",
    "(set)",
    "set",
}


def normalize_password_candidate(password: str) -> str:
    """Normalize accidental IME / copy-paste variations without weakening storage.

    Passwords are still compared exactly first.  The normalized candidates are
    used only as a compatibility fallback for old data and mobile input issues.
    """

    text = unicodedata.normalize("NFKC", str(password or ""))
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", text)
    return text.strip()


def password_candidates(password: str) -> list[str]:
    raw = str(password or "")
    candidates = [raw, raw.strip(), normalize_password_candidate(raw)]
    unique: list[str] = []
    for item in candidates:
        if item not in unique:
            unique.append(item)
    return unique


def hash_password(password: str) -> str:
    """Hash a member password.

    Current format:
        pbkdf2$sha256$<iterations>$<salt>$<hex_hash>

    verify_password also supports legacy formats used during earlier releases:
    - sha256$<salt>$<hex_hash>
    - raw sha256 hex digest
    - Django-style pbkdf2_sha256$<iterations>$<salt>$<base64_hash>
    - Werkzeug-style pbkdf2:sha256:<iterations>$<salt>$<hex_hash>
    - legacy plain text
    """
    normalized = normalize_password_candidate(password)
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        _PBKDF2_ALGO,
        normalized.encode("utf-8"),
        salt.encode("utf-8"),
        _PBKDF2_ITERATIONS,
    ).hex()
    return f"pbkdf2${_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt}${digest}"


def is_password_placeholder(stored: str) -> bool:
    value = str(stored or "").strip()
    return not value or value in _PASSWORD_PLACEHOLDERS


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
    variants = (
        f"{salt}:{password}",
        f"{salt}{password}",
        f"{password}{salt}",
        password,
    )
    return any(secrets.compare_digest(hashlib.sha256(value.encode("utf-8")).hexdigest(), digest) for value in variants)


def _verify_sha256_hex(password: str, stored: str) -> bool:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", stored or ""):
        return False
    expected = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return secrets.compare_digest(expected.lower(), stored.lower())


def _verify_django_pbkdf2(password: str, stored: str) -> bool:
    # Django: pbkdf2_sha256$<iterations>$<salt>$<base64-digest>
    try:
        scheme, iterations_text, salt, digest_b64 = stored.split("$", 3)
        iterations = int(iterations_text)
    except (ValueError, TypeError):
        return False
    if scheme != "pbkdf2_sha256" or iterations <= 0:
        return False
    expected = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    try:
        expected_b64 = base64.b64encode(expected).decode("ascii").strip()
    except Exception:
        return False
    return secrets.compare_digest(expected_b64, digest_b64)


def _verify_werkzeug_pbkdf2(password: str, stored: str) -> bool:
    # Werkzeug: pbkdf2:sha256:<iterations>$<salt>$<hex-digest>
    try:
        method, salt, digest = stored.split("$", 2)
        parts = method.split(":")
        if len(parts) != 3 or parts[0] != "pbkdf2" or parts[1] != "sha256":
            return False
        iterations = int(parts[2])
    except (ValueError, TypeError):
        return False
    expected = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations).hex()
    return secrets.compare_digest(expected, digest)


def _verify_bcrypt(password: str, stored: str) -> bool:
    if not (stored.startswith("$2a$") or stored.startswith("$2b$") or stored.startswith("$2y$")):
        return False
    try:
        import bcrypt  # type: ignore
    except Exception:
        return False
    try:
        return bool(bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8")))
    except Exception:
        return False


def verify_password(password: str, stored: str) -> bool:
    stored_value = str(stored or "").strip()
    if is_password_placeholder(stored_value):
        return False

    for candidate in password_candidates(password):
        if stored_value.startswith("pbkdf2$") and _verify_pbkdf2(candidate, stored_value):
            return True
        if stored_value.startswith("sha256$") and _verify_legacy_sha256(candidate, stored_value):
            return True
        if stored_value.startswith("pbkdf2_sha256$") and _verify_django_pbkdf2(candidate, stored_value):
            return True
        if stored_value.startswith("pbkdf2:sha256:") and _verify_werkzeug_pbkdf2(candidate, stored_value):
            return True
        if _verify_sha256_hex(candidate, stored_value):
            return True
        if _verify_bcrypt(candidate, stored_value):
            return True
        # Legacy plain-text passwords from early data are accepted once.  The
        # login endpoint migrates plain text to a hashed value after success.
        if hmac.compare_digest(candidate.encode("utf-8"), stored_value.encode("utf-8")):
            return True
    return False


def is_hashed_password(stored: str) -> bool:
    value = str(stored or "").strip()
    return bool(
        value.startswith("pbkdf2$")
        or value.startswith("sha256$")
        or value.startswith("pbkdf2_sha256$")
        or value.startswith("pbkdf2:sha256:")
        or value.startswith("$2a$")
        or value.startswith("$2b$")
        or value.startswith("$2y$")
        or re.fullmatch(r"[0-9a-fA-F]{64}", value or "")
    )
