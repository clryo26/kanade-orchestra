from __future__ import annotations

import argparse
import ast
from pathlib import Path
from typing import Iterable


def _string_collection_from_assignment(module_path: Path, symbol_name: str) -> set[str]:
    if not module_path.exists():
        return set()
    tree = ast.parse(module_path.read_text(encoding="utf-8"), filename=str(module_path))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name) or target.id != symbol_name:
                continue
            if isinstance(node.value, (ast.List, ast.Tuple)):
                values: set[str] = set()
                for item in node.value.elts:
                    if isinstance(item, ast.Constant) and isinstance(item.value, str):
                        values.add(item.value)
                return values
    return set()


def _resolve_imported_symbol_values(tree: ast.Module, app_core_path: Path, symbol_name: str) -> set[str]:
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom):
            continue
        for alias in node.names:
            imported_as = alias.asname or alias.name
            if imported_as != symbol_name:
                continue

            module_parts = (node.module or "").split(".") if node.module else []
            base_dir = app_core_path.parent
            if node.level > 1:
                base_dir = app_core_path.parent
                for _ in range(node.level - 1):
                    base_dir = base_dir.parent
            module_path = base_dir.joinpath(*module_parts, "__init__.py")
            if not module_path.exists():
                module_path = base_dir.joinpath(*module_parts).with_suffix(".py")
            return _string_collection_from_assignment(module_path, alias.name)
    return set()


def collect_app_core_exports(app_core_path: Path) -> set[str]:
    tree = ast.parse(app_core_path.read_text(encoding="utf-8"), filename=str(app_core_path))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    all_value = node.value
                    if isinstance(all_value, ast.Call) and isinstance(all_value.func, ast.Name) and all_value.func.id == "sorted" and all_value.args:
                        all_value = all_value.args[0]
                    if isinstance(all_value, ast.Name):
                        resolved = _resolve_imported_symbol_values(tree, app_core_path, all_value.id)
                        if resolved:
                            return resolved
                    if isinstance(all_value, (ast.List, ast.Tuple)):
                        exports_from_all: set[str] = set()
                        for item in all_value.elts:
                            if isinstance(item, ast.Constant) and isinstance(item.value, str):
                                exports_from_all.add(item.value)
                        if exports_from_all:
                            return exports_from_all

    exports: set[str] = set()

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if not node.name.startswith("_"):
                exports.add(node.name)
            continue

        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and not target.id.startswith("_"):
                    exports.add(target.id)
            continue

        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if not node.target.id.startswith("_"):
                exports.add(node.target.id)

    return exports


def iter_python_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*.py"):
        if path.name == "app_core.py":
            continue
        yield path


def _collect_alias_attribute_usages(tree: ast.AST, module_aliases: set[str]) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        if isinstance(node.value, ast.Name) and node.value.id in module_aliases:
            names.add(node.attr)
    return names


def collect_repo_references(repo_root: Path) -> tuple[dict[str, set[str]], set[str]]:
    src_root = repo_root / "src"
    references: dict[str, set[str]] = {}
    importing_files: set[str] = set()

    for path in iter_python_files(src_root):
        rel = path.relative_to(repo_root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

        direct_names: set[str] = set()
        module_aliases: set[str] = set()

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module_name = node.module or ""
                if module_name.endswith("app_core"):
                    importing_files.add(rel)
                    for alias in node.names:
                        if alias.name != "*":
                            direct_names.add(alias.asname or alias.name)
                elif module_name in {"", "src.backend", "backend", ".", ".."}:
                    for alias in node.names:
                        if alias.name == "app_core":
                            importing_files.add(rel)
                            module_aliases.add(alias.asname or alias.name)

            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.endswith("app_core"):
                        importing_files.add(rel)
                        module_aliases.add(alias.asname or alias.name.split(".")[-1])

        for name in direct_names:
            references.setdefault(name, set()).add(rel)

        for attr in _collect_alias_attribute_usages(tree, module_aliases):
            references.setdefault(attr, set()).add(rel)

    return references, importing_files


def render_report(exports: set[str], references: dict[str, set[str]], importing_files: set[str]) -> str:
    used = sorted(name for name in exports if name in references)
    unused = sorted(name for name in exports if name not in references)

    lines: list[str] = []
    lines.append("# app_core Export Inventory")
    lines.append("")
    lines.append(f"- Total exports discovered: {len(exports)}")
    lines.append(f"- Files importing app_core in src/: {len(importing_files)}")
    lines.append(f"- Referenced from backend source tree: {len(used)}")
    lines.append(f"- Not referenced from backend source tree: {len(unused)}")
    lines.append("")

    lines.append("## Files Importing app_core")
    lines.append("")
    for path in sorted(importing_files):
        lines.append(f"- {path}")
    if not importing_files:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Referenced Exports")
    lines.append("")
    for name in used:
        refs = ", ".join(sorted(references.get(name, set())))
        lines.append(f"- {name}: {refs}")

    lines.append("")
    lines.append("## Candidate Unreferenced Exports")
    lines.append("")
    for name in unused:
        lines.append(f"- {name}")

    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- This report only scans references inside src/.")
    lines.append("- Reference detection uses static import/attribute patterns and may miss dynamic getattr-style access.")
    lines.append("- Symbols listed as unreferenced may still be required by external scripts or runtime monkeypatch usage.")
    lines.append("- Use this list as a review queue, not as direct delete instructions.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory app_core exports and in-repo references.")
    parser.add_argument("--repo-root", default=".", help="Repository root path")
    parser.add_argument("--write", default="", help="Optional output markdown path")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    app_core_path = repo_root / "src" / "backend" / "app_core.py"
    exports = collect_app_core_exports(app_core_path)
    references, importing_files = collect_repo_references(repo_root)
    report = render_report(exports, references, importing_files)

    if args.write:
        output_path = (repo_root / args.write).resolve()
        output_path.write_text(report, encoding="utf-8")
        print(f"Wrote report: {output_path}")
    else:
        print(report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
