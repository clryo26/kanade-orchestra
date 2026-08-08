from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from ..core.config import normalized_app_env


def cloud_run_revision() -> str:
    return os.getenv("K_REVISION", "").strip() or os.getenv("CLOUD_RUN_REVISION", "").strip()


def public_https_url(value: str | None) -> str:
    """Return only public absolute HTTPS URLs suitable for browser navigation."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return ""
    return raw


def other_environment_url() -> str:
    return public_https_url(os.getenv("OTHER_ENVIRONMENT_URL", ""))


def portal_title_for_environment(base_title: str, app_env: str | None = None) -> str:
    env = normalized_app_env(app_env)
    return f"{base_title}(テスト環境)" if env == "test" else base_title


def revision_response_payload() -> str:
    return json.dumps(
        {
            "cloudRunRevision": cloud_run_revision(),
            "appEnv": normalized_app_env(),
            "otherEnvironmentUrl": other_environment_url(),
        },
        ensure_ascii=False,
    )


def manifest_response_payload(title: str) -> str:
    manifest = {
        "name": title,
        "short_name": title,
        "start_url": "/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": "#235789",
        "icons": [
            {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }
    return json.dumps(manifest, ensure_ascii=False)


def health_payload(storage_configured: bool, db_expected: bool, db_configured: bool) -> dict[str, str]:
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "Orchestra Activity Tool",
        "storage_configured": str(storage_configured).lower(),
        "db_expected": str(db_expected).lower(),
        "db_configured": str(db_configured).lower(),
    }


def index_file_path(base_dir: Path) -> Path:
    return base_dir / "index.html"


_INDEX_STATIC_ASSET_PATTERN = re.compile(
    r'(?P<prefix>(?:src|href)=["\'])'
    r'(?P<path>/static/(?:(?:js)|(?:css))/[^"\'?]+)'
    r'(?P<query>\?[^"\']*)?'
    r'(?P<suffix>["\'])'
)


def rewrite_index_html_static_asset_urls(html: str, revision: str) -> str:
    revision_value = str(revision or "").strip()
    if not revision_value:
        return html

    def replace(match: re.Match[str]) -> str:
        path = match.group("path")
        query = match.group("query") or ""
        suffix = match.group("suffix")
        if "rev=" in query:
            return match.group(0)
        if query:
            return f'{match.group("prefix")}{path}{query}&rev={revision_value}{suffix}'
        return f'{match.group("prefix")}{path}?rev={revision_value}{suffix}'

    return _INDEX_STATIC_ASSET_PATTERN.sub(replace, html)
