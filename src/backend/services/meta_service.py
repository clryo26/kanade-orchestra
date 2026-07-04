from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path


def cloud_run_revision() -> str:
    return os.getenv("K_REVISION", "").strip() or os.getenv("CLOUD_RUN_REVISION", "").strip()


def revision_response_payload() -> str:
    return json.dumps({"cloudRunRevision": cloud_run_revision()}, ensure_ascii=False)


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
