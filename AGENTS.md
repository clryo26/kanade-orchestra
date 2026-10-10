# 奏オケポータル開発ガイド

## 開発環境

- Windows 11 / VS Code / PowerShell
- Python 3.10+、パッケージ管理は uv
- JavaScript、Vitest / Playwright

AIエージェントは通常の開発ツールとしてソース調査、直接編集、テスト、Git操作を行える。
ユーザーの依頼に沿って作業する。AI専用ジョブ、作業前ゲート、署名付き証跡、追加承認は不要。

## 設計・実装

- 既存の設計・仕様・命名を尊重し、関連ファイルを確認する。
- 他の作業による未コミット変更を保持する。
- 業務処理は services / core / repositories に配置する。app_core.py は互換ファサード。
- 本番フロントエンドの入口は main.js。app.js は deprecated 互換ローダー。
- 共有状態は portalAppState。getAppState() または portalRuntimeContext.appState で参照する。
- 分割ファイルの読み込み順、既存の公開関数・UIイベントを維持する。
- iPhoneでの見やすさと押しやすさを重視し、管理者情報・内部保存先を団員画面に出さない。
- 複雑な処理、外部連携、認証、DB・ファイル操作には保守に役立つ理由・前提をコメントする。
- 仕様・運用が変わる場合は関連ドキュメントも更新する。

## セキュリティ・データ保護

- 認証・認可、管理者権限、DB整合性を維持する。
- 本番はDB Only運用。src/data/*.json を本番データソースにしない。
- 大容量録音はGCS直接アップロード、Cloud Runはメタデータ登録を担当する。
- Secretをソースやログに記載しない。外部通信にはタイムアウトを設定する。
- 共有ZIPに .env、.git、.venv、node_modules、実データ、録音、DB、credentials を含めない。
- 診断APIは既定で無効。本番では管理者認証と機密値のマスクを維持する。

## 通常の開発・検証

```powershell
uv sync --extra dev
npm ci
uv run python -m compileall -q src/backend tests
uv run ruff check .
uv run pytest
npm run check:frontend:syntax
npm run test:frontend
npm run test:e2e
```

一括実行は npm run setup:local / npm run qa:local。
共有ZIPは npm run check:release-safety / npm run zip:source。
通常のCI/CD、Lint、型チェック、テスト、データ保護チェックは維持する。
本番運用は docs/PRODUCTION_RELEASE_CHECKLIST.md、実機確認は docs/MANUAL_DEVICE_QA_CHECKLIST.md、
Cloud Run / GCS / DB確認は docs/CLOUD_RUN_GCS_DB_CHECK.md を参照する。
実行した確認、未確認事項、失敗の原因・影響を正確に報告する。
