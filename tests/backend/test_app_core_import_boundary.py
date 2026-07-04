from __future__ import annotations

import ast
from pathlib import Path


def _imports_app_core(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "src.backend.app_core" or alias.name.endswith(".app_core"):
                    return True
        elif isinstance(node, ast.ImportFrom):
            if node.module in {"app_core", "src.backend.app_core"}:
                return True
            if node.module == "src.backend" and any(alias.name == "app_core" for alias in node.names):
                return True
            if node.module is None and any(alias.name == "app_core" for alias in node.names):
                return True
            if node.module and node.module.endswith(".app_core"):
                return True
    return False


def test_backend_app_core_direct_imports_are_limited_to_compat_boundary() -> None:
    project_root = Path(__file__).resolve().parents[2]
    backend_root = project_root / "src" / "backend"
    allowed = {
        "src/backend/main.py",
        "src/backend/core/compat_gateway.py",
        "src/backend/app_core.py",
    }

    offenders: list[str] = []
    for path in backend_root.rglob("*.py"):
        rel = path.relative_to(project_root).as_posix()
        if rel in allowed:
            continue

        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        if _imports_app_core(tree):
            offenders.append(rel)

    assert not offenders, f"Unexpected direct app_core imports: {', '.join(sorted(offenders))}"
