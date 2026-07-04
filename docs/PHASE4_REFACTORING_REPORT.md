# PHASE4_REFACTORING_REPORT

最終更新: 2026-07-01

## 実施概要

安全性・互換性優先で Phase4 の分割改善を実施した。
API パス、レスポンス形式、DB スキーマ、UI 仕様は変更していない。

## 今回分割したファイル

- src/static/js/modules/date_piece_promotion/helpers.js（新規）
- src/static/js/modules/admin_system/helpers.js（新規）
- src/static/js/modules/date_piece_promotion.js（ヘルパー分離で縮小）
- src/static/js/modules/admin_system.js（ヘルパー分離で縮小）

## app_core.py の追加整理

- app_core の serialization 互換ラッパーを direct import 化
  - model_dump
  - fk_int
- app_core の単純委譲ラッパーを追加で direct import 化
  - DB row/json 互換関数群
  - cloud_run_revision / ensure_expected_updated_at / next_updated_at / env_flag_enabled
  - parse_extra_upsert_request / assert_extra_collection_permission / read_json_body
- 互換エントリーポイントとしての公開面は維持
- import boundary 方針（main.py / core/compat_gateway.py 以外で direct import 禁止）は維持

## appState 移行方針（実装済み）

- 正式名: window.portalAppState
- 互換 alias: window.appState
- 新規推奨参照: window.getAppState() または window.portalRuntimeContext.appState
- runtime_context 側は getAppState() 優先で appState を解決

## 互換維持方針

- 既存外部公開関数名は維持
- index.html と app.js 互換ローダーの読み込み順に helper を追加
- 既存イベント登録・描画フローを変更しない

## 残った巨大ファイル

- src/backend/app_core.py
- src/static/js/modules/date_piece_promotion.js
- src/static/js/modules/admin_system.js

## app_core.py の残責務

- startup/json/recording/extra の互換ラッパー集約
- __all__ による互換公開面の維持
- 旧経路を使うテスト/monkeypatch 互換

## 次回改善候補

- app_core 互換ラッパー群の依存注入インターフェース化
- date_piece_promotion の render/events/api/state の追加分離
- admin_system の diagnostics/maintenance/api 分離
- portalAppState の直接利用比率をさらに上げ、appState alias の利用箇所を監査

## Phase5 への引き継ぎ

- Phase5 で `date_piece_promotion` と `admin_system` は追加分割を実施済み。
- 本レポートの未対応候補のうち、`app_core` の依存注入互換層分離は継続課題として残る。
