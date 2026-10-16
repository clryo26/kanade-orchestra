# Web Push通知 ローカル実装報告

実施日: 2026-10-08

## 作業範囲とGit状態

- 対象ブランチ: `feat/portal-display-improvements-20261008`
- 基準・最終HEAD: `50d1f4109de8ed1d2824ce6d823667a4500d93b8`
- 編集前にブランチ・HEADの一致と、除外ディレクトリ以外に未コミット変更がないことを確認した。
- 最終差分は既存19ファイルの変更、新規12ファイルの追加。すべて未コミット・未ステージ。
- 既存追跡ファイルの `git diff --stat`: 226行追加、21行削除。新規ファイルはこの統計に含まれない。
- `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check` は成功。
  WindowsのCRLFを考慮した一時コマンド設定であり、Git設定ファイルは変更していない。
- `.codex-pytest-retry/` は変更・削除・権限変更の対象にしていない。
- コミット、プッシュ、デプロイ、稼働DBへのマイグレーションを実施していない。
- 修正指示JSON、実VAPID鍵を生成していない。

## 実装結果

設定メニューに通知設定画面を追加した。団員単位で8種類すべてONをDB初期値とし、
一般団員には7項目、システム管理者には改善要望受付を含む8項目を表示する。
許可要求はボタンの直接操作で行い、表示時には要求しない。
購読は団員・認証端末に紐付け、複数端末、購読停止、ログアウト、公開鍵変更を扱う。

既存の8機能に保存成功後の通知イベントを組み込み、練習予定・楽曲情報は実保存値の変更だけを通知する。
設定OFF、期限切れ、削除済み団員、最新権限、組織、端末との関連を配信側で検証する。
エキストラに閲覧権限のないイベント通知、一般団員への改善要望通知を除外する。
DBによるイベント・送信claimの重複防止、404/410購読停止、429/503の限定再試行を追加した。
通知失敗は業務保存を取り消さず、endpoint・鍵・認証情報・個人情報をログに出さない。

Push専用Service Workerを追加し、通知タップで認証・権限確認後に該当画面を開く。
既存ウィンドウを再利用し、既存のキャッシュ処理や初期script順序を維持する。
本番のエントリポイントやdeprecated `app.js` に新規処理を追加していない。

詳しいDB/API仕様、対象画面、失敗時の動作、運用条件は [WEB_PUSH_NOTIFICATIONS.md](WEB_PUSH_NOTIFICATIONS.md) を参照。

## 変更ファイル

### 既存ファイル（19）

| 用途 | ファイル |
|---|---|
| 設定例・依存関係 | `.env.example`, `pyproject.toml`, `uv.lock`, `src/backend/requirements.txt` |
| API登録・配信開始 | `src/backend/core/router_registry.py` |
| 保存成功後の通知フック | `src/backend/services/portal_notice_service.py`, `announcement_service.py`, `schedule_service.py`, `recording_upload_service.py`, `extra_service.py`, `sheet_service.py`, `event_service.py`, `improvement_suggestion_service.py` |
| メニュー・画面遷移 | `src/static/js/modules/navigation/menu.js`, `helpers.js`, `routes.js`, `events.js` |
| ログアウト時の停止 | `src/static/js/auth_feature.js` |
| 設計書の参照追記 | `SYSTEM_DESIGN.md` |

### 新規ファイル（12）

| 用途 | ファイル |
|---|---|
| 4テーブルの追加SQL（未適用） | `db/migrations/015_web_push_notifications.sql` |
| 通知DB・API・配信・種別 | `src/backend/repositories/notification_repository.py`, `src/backend/routers/notifications.py`, `src/backend/services/notification_service.py`, `src/backend/services/notification_types.py` |
| 通知設定・Worker | `src/static/js/modules/notifications/settings.js`, `src/static/sw.js` |
| 回帰テスト | `tests/backend/test_notifications.py`, `tests/frontend/test_notifications.test.js`, `tests/e2e/notifications.spec.js` |
| 設計・検証記録 | `docs/WEB_PUSH_NOTIFICATIONS.md`, `docs/WEB_PUSH_IMPLEMENTATION_REPORT.md` |

## 実行した検証

Pythonテスト時には `AUDIT_LOG_ENABLED=false`, `WEB_PUSH_ENABLED=false` を指定し、
通知テストはモックのDBリポジトリ・送信処理を使用した。
専用のpytest一時ディレクトリを使用し、終了後に今回の一時データだけを整理した。

| コマンド | 結果 |
|---|---|
| `uv run python -m compileall -q src/backend tests` | 成功 |
| `uv run ruff check .` | 終了コード0。アクセス拒否の探索警告あり。除外ディレクトリの修復・削除は行っていない |
| `uv run pytest -q --basetemp=.pytest-notifications-tmp -o cache_dir=.pytest-notifications-cache` | **675成功**、4警告。通知の新規テスト45件を含む |
| `npm run check:types:backend` | 成功（backend139ファイル、補助スクリプト4ファイル）。未型付け関数についてのmypy注記あり |
| `npm run check:frontend:syntax` | 成功（96ファイル） |
| `node --check src/static/sw.js` | 成功 |
| `npm run check:frontend:load-order` | 成功（index=42、legacy=64） |
| `npm run check:frontend:state-access` | 成功（96ファイル、違反0） |
| `npm run test:frontend` | **604成功**（65ファイル）。通知の新規テスト11件を含む |
| `npm run test:e2e` | **21成功、4失敗**（Chromium）。通知の新規テスト6件はすべて成功 |

型チェックの実行時に一度 `npm run check:types` を指定したが、そのスクリプトは存在せず失敗した。
正式な `npm run check:types:backend` に修正して再実行し、上記の成功結果を確認した。

pytestの4警告はGoogle APIのPython 3.10サポート終了予告、imageioのpkg_resources非推奨、
ffmpeg未検出、既存のZIP改ざん検証における重複エントリ警告だった。テスト失敗はない。

### Playwrightの失敗内容と原因

| 既存テスト | エラー・原因 | 次の対応 |
|---|---|---|
| `member.spec.js`, `member_flow.spec.js`, `smoke.spec.js` | `toBeVisible` が失敗。現行メニュー「次回演奏会」に対し旧ラベル「演奏会情報」を探索する | 現行仕様に合わせた期待値の更新を別途行う |
| `attendance.spec.js` | 練習場所を含まないことの検証が失敗。現行画面には「練習場所: 練習場」を表示する | 現行の表示仕様を確認し、期待値の更新を別途行う |

基準コミットの `src` を専用一時ディレクトリに展開し、ポート8001で起動した基準版でも
同じ4件・同じ検証箇所の失敗を再現した。通知追加による新規の失敗としては認められなかった。
既存画面・既存E2Eは今回変更していない。全体E2Eを成功扱いにはしていない。
基準版確認に使用した専用サーバーと一時ファイルは確認終了後に整理した。
本番前に既存E2Eの不整合を解消し、CI成功を確認する必要がある。

## 未実施の検証と理由

- **実PostgreSQLでのSQL・マイグレーション検証**: Docker Desktopのエンジンに接続できず、
  ローカルPostgreSQLもないため未実施。稼働DBへの適用は承認範囲外なので実施していない。
- **Docker build / コンテナ起動**: ローカルDockerエンジンが停止しているため未実施。
- **実Push送信、Android/iPhone/PWAでの受信、閉じた画面からの起動**: 検証用VAPID設定と実端末が未用意。
  PlaywrightはブラウザAPIをモックし、操作時の許可要求・拒否・購読停止・画面遷移を確認したもので、実受信の証明ではない。
- **Cloud Runでの応答後配信とCPU割当**: 稼働環境の変更・デプロイは禁止されているため未確認。
- **リモートCI**: コミット・プッシュを行っておらず、今回の変更について新たなCI実行は行っていない。

## 運用上の残課題

`WEB_PUSH_ENABLED=false` を設定例の既定値とした。実鍵・DB・実機・実行基盤を検証してから有効化する。
応答後のBackgroundTasksを使うため、Cloud Runの応答後CPU確保が運用条件となる。
稼働サービスの設定変更や費用への影響確認は、別途承認が必要な運用作業として残した。

再試行は新しい通知イベントまたは認証済み通知設定取得を入口とする。
無通信時の定時再試行を保証するスケジューラーは追加していない。
業務保存とイベント記録は別トランザクションなので、その間の停止で通知を失う可能性がある。
成否不明の送信は自動再送しない。通知の確実な到達・厳密なexactly-onceを保証しない。

ローカル実装と実施可能な自動検証は完了した。実DB・実配信・実機・本番の完了を意味するものではない。

## 再発防止確認

- [x] Python・JavaScriptの構文チェック
- [x] ruff、型チェック、pytest、Vitest、Playwrightの実行・失敗報告
- [x] DB/API/画面/設定/配信制約を設計書へ反映
- [x] 保存失敗・無変更更新・通知OFF・権限・重複・複数端末・無効購読を回帰テストで確認
- [x] 自動許可要求を禁止し、既存ルーティングとWorkerのキャッシュ非介入を確認
- [x] 既存E2E失敗を基準コミットで再現し、成功扱いにしていない
- [x] CI未確認の状態でデプロイしていない
- [x] 除外ディレクトリと稼働DBを変更していない

## 追加検証結果（2026-10-09追記）

上記本文は2026-10-08の初回ローカル実装報告として保持する。
以下はその後の検証結果と期待値修正を反映した追記であり、本文に記載した当時の
「未実施」「21成功・4失敗」と、後続検証後の状態を区別する。
本追記作業では、過去の検証を再実行していない。

| 検証項目 | 後続検証の結果・範囲 |
|---|---|
| 実PostgreSQLマイグレーション | 専用ローカルPostgreSQLで6項目成功。基礎スキーマと001～015の適用、履歴・チェックサム、015の構造・初期値、既存業務データの不変性、再実行を検証した |
| 実Repository | 実PostgreSQL・実Repositoryを使用した17項目成功。Push送信処理はモック |
| Docker build・通常起動 | 現行Dockerfileによるビルドと通常CMDの起動成功。DBなしのhealth・静的配信・Service Worker・関連依存importを検証した |
| DB接続あり通常起動 | 専用ローカル検証DBへの接続、スキーマ互換確認、初期化・プリロード、healthが成功。起動前後の全48テーブルに差分なし |
| HTTP API | 段階A・B・購読状態再確認の合計50件成功。実HTTP・認証・入力検証・Repository・PostgreSQLの連携を検証した。実Push送信は0件 |
| 通知APIのCache-Control修正 | `/api/notifications/`配下の既存HTTPミドルウェアで成功・処理済みエラー応答に`no-store`を設定。200・401・403・422・503、対象外ルート、500の例外処理境界を含む関連テスト85件成功 |
| pytest全体 | Cache-Control修正後の2026-10-09の実施で690件成功、4警告 |
| Vitest | 初回実装時の2026-10-08に604件成功（65ファイル）。後続のCache-Control修正・E2E期待値修正時点で全体を再実行した結果ではない |
| Playwright | 2026-10-09に既存4テストの期待値を現行仕様へ修正。対象4件成功、全体25件成功（Chromium、19.2秒）。通知関連6件を含む |

### Cache-Controlの適用範囲

認証・権限・入力検証の応答本文とステータスは変更していない。
HTTPException等として処理される500にも`Cache-Control: no-store`を設定する。
未処理例外の500は外側のServerErrorMiddlewareが生成するため対象外であり、
その既存例外処理境界も回帰テストで確認した。

### 追記時点の未実施項目と環境の区別

- 実Web Pushの送受信、iPhone・Android実機での通知受信、PWAからの通知タップ起動は未実施。
- Cloud Runへの今回の実装のデプロイ、応答後CPU割当と実配信の検証は未実施。
- リモートCIは未実施。今回の追記作業でもGit add・commit・push、CI実行は行っていない。
- 成功した実DB検証は専用ローカルPostgreSQLが対象であり、本番・既存テストDBや新規Neonへの適用結果ではない。
- 実Pushを送らずに成功したHTTP・Repository・Playwright検証は、実スマートフォンへの到達の証明ではない。
