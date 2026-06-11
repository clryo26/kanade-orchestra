# Agents Configuration

VS Code Copilotの複数のエージェントを定義するファイル。Python + UV環境用（Windows11）。

## Agents

### Explore Agent
```yaml
---
name: Explore
description: Fast read-only codebase exploration and Q&A subagent
skill: codebase-exploration
tools:
  - semantic_search
  - grep_search
  - file_search
  - read_file
toolRestrictions:
  - noWrite: true
environment:
  python:
    package_manager: uv
    version: "3.10+"
    os: windows11
  tools:
    - uv: "latest"
```

### Python Development Agent
```yaml
---
name: Python-Dev
description: Python開発用エージェント - UVパッケージマネージャー対応
skill: python-development
tools:
  - run_in_terminal
  - file_search
  - read_file
  - create_file
  - replace_string_in_file
environment:
  python:
    package_manager: uv
    version: "3.10+"
    os: windows11
  commands:
    lint: uv run ruff check .
    format: uv run ruff format .
    test: uv run pytest
    install: uv sync
```

## Environment Setup (Windows11)

### UV Install
```powershell
# PowerShellで実行
$ProgressPreference = 'SilentlyContinue'
irm https://astral.sh/uv/install.ps1 | iex
```

### Project Initialization
```bash
# 新規プロジェクト
uv init my-project
cd my-project

# 既存プロジェクト
uv sync
```

### Common Commands
- `uv sync` - 依存関係をインストール
- `uv run python script.py` - Pythonスクリプト実行
- `uv add package_name` - パッケージ追加
- `uv remove package_name` - パッケージ削除
- `uv pip list` - インストール済みパッケージ表示

## Default Configuration

環境変数（Windows11 PowerShell）:
```powershell
$env:UV_PYTHON = "cpython-3.10"
$env:PYTHON_VERSION = "3.10"
```

## Notes
- UVはPythonパッケージマネージャー・プロジェクトマネージャー
- 高速でRustで実装されている
- pip、pipenv、poetryの代替として使用可能
- Windows11のPowerShellで完全に対応

-仕事中であっても感情を自然に表現してください
-砕けた自然な言葉遣いで話す
