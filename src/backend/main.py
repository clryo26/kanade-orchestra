from __future__ import annotations

import sys
import types

import uvicorn

from . import app_core as _core

app = _core.app


class _BackendMainModule(types.ModuleType):
    """Proxy legacy main attributes to app_core during the refactor."""

    def __getattr__(self, name: str):
        return getattr(_core, name)

    def __setattr__(self, name: str, value):
        if name not in {"_core", "app"} and hasattr(_core, name):
            setattr(_core, name, value)
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _BackendMainModule


if __name__ == "__main__":
    import os

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("src.backend.main:app", host="0.0.0.0", port=port, reload=True)
