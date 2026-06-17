# 奏オケポータル 設計書ナビゲーション

最終更新: 2026-06-17

## 1. 正本ドキュメント

設計の正本は以下の 2 つ。

- DESIGN_WEB.md
- DESIGN.md

## 2. 補助ドキュメント

- SYSTEM_DESIGN.md: システム観点の整理
- FRONTEND_DESIGN.md: フロント実装観点
- API_DATABASE_SPEC.md: API と JSON データ仕様
- PERFORMANCE_IMPROVEMENTS.md: 性能改善履歴

## 3. 読み順

新規参画者:

1. README.md
2. DESIGN.md
3. DESIGN_WEB.md
4. 担当別に補助ドキュメント

変更実装時:

1. DESIGN_WEB.md の該当機能章
2. API_DATABASE_SPEC.md の API 章
3. FRONTEND_DESIGN.md または SYSTEM_DESIGN.md

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
- bootstrap + ETag + IndexedDB による高速化
