# 奏オケポータル 設計書ナビゲーション

最終更新: 2026-06-30

## 1. 正本ドキュメント

設計の正本は以下の 2 つ。

- DESIGN_WEB.md
- DESIGN.md

## 2. 補助ドキュメント

- SYSTEM_DESIGN.md: システム観点の整理
- ACCESS_AND_SOURCE_SYNC_GUIDE.md: 2台PC開発向けのGitHub/Googleアクセス情報とソース同期手順
- DB_SETUP_GUIDE.md: DB構築の一本化手順（どのDBをどこからどう作るか）
- FRONTEND_DESIGN.md: フロント実装観点
- FRONTEND_LAYOUT_SPEC.md: 画面レイアウト仕様（表示イメージ中心）
- API_DATABASE_SPEC.md: API と JSON データ仕様
- PERFORMANCE_IMPROVEMENTS.md: 性能改善履歴
- UNIT_TEST_SPEC.md: 単体テスト仕様（全体網羅）
- INTEGRATION_TEST_SPEC.md: 結合テスト親仕様（担当別ハブ）
- INTEGRATION_TEST_SPEC_BACKEND.md: 結合テスト仕様（バックエンド担当）
- INTEGRATION_TEST_SPEC_FRONTEND.md: 結合テスト仕様（フロント担当）
- INTEGRATION_TEST_SPEC_CI.md: 結合テスト仕様（CI/運用担当）
- OPERATION_TEST_SPEC.md: 運用テスト仕様（運用スモーク/CI運用）
- docs/TEST_RUNNER_STABILITY.md: フロントテスト実行の安定化方針

## 3. 読み順

新規参画者:

1. README.md
2. DESIGN.md
3. DESIGN_WEB.md
4. ACCESS_AND_SOURCE_SYNC_GUIDE.md
5. 担当別に補助ドキュメント

変更実装時:

1. DESIGN_WEB.md の該当機能章
2. API_DATABASE_SPEC.md の API 章
3. FRONTEND_DESIGN.md または SYSTEM_DESIGN.md
4. 単体テスト観点を UNIT_TEST_SPEC.md へ反映
5. 結合テスト観点を INTEGRATION_TEST_SPEC.md + 担当別仕様へ反映
6. 運用テスト観点を OPERATION_TEST_SPEC.md へ反映

## 4. 同期ルール

実装変更時は最低限以下を同時更新する。

- 画面/機能変更: DESIGN_WEB.md, FRONTEND_DESIGN.md
- API/データ変更: API_DATABASE_SPEC.md, SYSTEM_DESIGN.md
- 全体仕様変更: DESIGN.md

## 5. 現行実装で重要な更新点

- 団員/管理者/システム管理の三層パネル
- 端末認証 + 権限モデル + エキストラ期限制御
- 支払金額管理、乗り番管理、宣伝、演奏希望曲
- 楽譜一括パート更新、PDF ビューア
- 接続先情報の JSON 管理（connection_settings）
- bootstrap + 全コレクション合成 ETag + IndexedDB による高速化
- ログイン画面の更新ボタン + Rev. 表示
- システム管理のアクセスログ（access_logs）で団員のメニューアクセスを記録・閲覧
