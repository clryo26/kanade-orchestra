# PHASE7_REFACTORING_CANDIDATES

最終更新: 2026-07-01

目的: 無理な分割を避けつつ、残る大きめ JS の責務と次回候補を整理する。

## 対象ファイル一覧

| ファイル | 行数 | 主な責務 | 分割候補 | 優先度 | 今すぐ分割すべきか | 分割を急がない理由 |
|---|---:|---|---|---|---|---|
| src/static/js/modules/performance_day.js | 492 | 本番情報の timeline/assignment/costume 正規化、フォーム入出力、API保存 | normalize helpers / render / events | 高 | いいえ | 現在は helper/render/events が既に一部分割済み。追加分割は回帰確認コストが高い |
| src/static/js/modules/scores.js | 483 | 楽譜一覧表示、フィルタ、PDFビュー、管理系操作 | filters / viewer / admin actions | 高 | いいえ | 表示系と操作系が密結合で、段階分離時に UI 回帰リスクがある |
| src/static/js/modules/bootstrap_loader.js | 448 | 初期化、bootstrap API読込、fallback、初期描画連鎖 | bootstrap_api / state_apply / render_bootstrap | 中 | いいえ | 起動順序と互換依存が強く、品質保証優先フェーズでは現状維持が安全 |
| src/static/js/modules/schedules.js | 424 | 練習予定 CRUD、カレンダー連携、フォーム補助 | crud / calendar_export / render_helpers | 中 | いいえ | E2E導入直後で追加分割よりテスト安定化を優先 |
| src/static/js/modules/performances.js | 352 | 演奏会 CRUD、曲目編集、一覧描画 | form / piece_editor / list_render | 低 | いいえ | 現在のサイズは許容範囲で、分割メリットが限定的 |
| src/static/js/recordings_feature.js | 320 | 録音一覧レンダリング、再生・DL導線、削除処理 | tree_render / playback / delete_actions | 中 | いいえ | 録音機能は利用頻度が高く、回帰影響が大きいため QA 先行が妥当 |

## 方針

- Phase7 は分割最適化より QA と本番準備を優先する。
- 追加分割は E2E と CI の安定運用が定着してから行う。
- 次回は `performance_day.js` と `scores.js` を第一候補に段階分割する。
