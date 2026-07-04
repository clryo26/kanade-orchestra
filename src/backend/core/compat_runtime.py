from __future__ import annotations
# mypy: disable-error-code=no-redef

from typing import Callable

from .app_config import app_cors_origins, configure_logging, ensure_runtime_directories, load_environment
from .app_setup import create_base_app
from .runtime_paths import CONVERTED_DIR, DATA_DIR, DRIVE_STAGING_DIR, SHEET_DIR, STATIC_DIR, UPLOAD_DIR

try:
    from ..auth_helpers import member_login_names
    from ..services.memory_cache import MemoryCache
except ImportError:  # pragma: no cover - allows running app_core.py directly.
    from auth_helpers import member_login_names
    from services.memory_cache import MemoryCache


load_environment()
logger = configure_logging()

_memory_cache = MemoryCache(member_login_names)

ensure_runtime_directories(UPLOAD_DIR, DATA_DIR, CONVERTED_DIR, DRIVE_STAGING_DIR, SHEET_DIR)

app = create_base_app(logger=logger, static_dir=STATIC_DIR, cors_origins=app_cors_origins())


def memory_cache_instance() -> MemoryCache:
    return _memory_cache


def effective_local_json_fallback_enabled(
    *,
    db_data_enabled: Callable[[], bool],
    db_expected: Callable[[], bool],
    local_json_fallback_enabled: Callable[[], bool],
) -> bool:
    if db_data_enabled():
        return False
    if db_expected():
        return False
    return local_json_fallback_enabled()
