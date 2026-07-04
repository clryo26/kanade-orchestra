# 共有ZIP除外ルール

最終更新: 2026-07-01

このプロジェクトを共有ZIP化するときは、以下を必ず除外する。

- .git/
- .venv/
- node_modules/
- .uv-cache-local/
- .pytest_cache/
- .ruff_cache/
- .ruff-cache-local/
- __pycache__/
- .coverage
- coverage/
- .env
- *.zip
- src/uploads/

補足:
- .env.example は共有対象に残す。
- DB Only運用のため src/data/*.json は共有対象に含めない。
- 共有前に `uv run python -m compileall -q src tests` と `uv run pytest -q` を実行して破損混入を防ぐ。
