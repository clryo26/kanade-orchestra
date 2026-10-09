# Web Push通知設計・運用

## 承認と基準

2026-10-08のローカル実装。対象は `feat/portal-display-improvements-20261008`、
基準コミットは `50d1f4109de8ed1d2824ce6d823667a4500d93b8`。
着手時にブランチ・HEADの一致と、除外ディレクトリ以外の未コミット変更なしを確認した。
`.codex-pytest-retry/` は変更・削除・権限変更の対象に含めない。
コミット・プッシュ・デプロイ・稼働DBへのマイグレーション実行は行わない。
修正指示JSONは、今回の承認に従い作成しない。

## 構成

既存Manifestを維持し、通知専用の `/sw.js` を新設する。調査した基準ソースに
Service Worker登録、Push購読、VAPID実装は存在しなかった。
Workerは `push` と `notificationclick` のみ処理し、fetchを横取りしない。
既存のHTTPキャッシュ、リビジョン付きアセット、PWA起動処理を変更しない。
Worker配信はルートスコープ、JavaScript MIME、`Cache-Control: no-store` とする。

「設定」に通知設定を追加する。画面モジュールは既存の遅延読込方式でロードし、
初期HTMLのscript数と既存互換ローダーの順序を維持する。
通知タップは `/?notification=<許可された画面名>` に遷移する。
既存ウィンドウがあれば再利用し、未認証時はURLを維持して既存ログイン完了後に遷移する。
処理後は履歴stateを保持したまま通知パラメーターだけ除去する。
一般団員による管理者通知の遷移、エキストラによるイベント画面の遷移、外部URLは許可しない。

## 通知と保存処理

| 種別キー | 表示 | 保存成功後のフック | 発生条件 | 遷移先 |
|---|---|---|---|---|
| notices | お知らせ | portal_notice_service.create_notice | 新規のみ | notice-history |
| schedules | 練習予定 | schedule_service.create_schedule/update_schedule | 新規・実変更 | member-schedule |
| recordings | 録音部屋 | recording_upload_service | GCS完了登録・既存アップロード成功 | member-recording |
| piece_infos | 楽曲情報 | extra_service.create_item/update_item | 新規・実変更 | member-piece-info |
| sheets | 楽譜ライブラリ | sheet_service.upload_sheet_file / extra_service.create_item | 新規のみ | member-sheet |
| events | イベント調整 | event_service.create_event | 新規のみ | member-event |
| maintenance | メンテナンス情報 | announcement_service.create_announcement | 新規のみ | maintenance-history |
| improvements | 改善要望受付 | improvement_suggestion_serviceの団員・管理者向けcreate | 新規のみ | system-improvement-suggestion |

現行では `/api/notices` が団員のお知らせ、旧 `/api/announcements` がメンテナンス情報である。
`maintenance_service` は孤立データ検査であり、メンテナンス情報の登録先ではない。
練習予定・楽曲情報は実際のDB保存対象カラムを、既存リポジトリと同じ日付・時刻・ID変換で比較する。
更新時刻だけの差、時刻表記の差（13:00/13:00:00）、保存されない追加項目は通知対象にしない。
保存失敗・削除・その他種別の更新ではイベントを作成しない。
GCSアップロードセッションの発行だけでは通知せず、オブジェクト検証とメタデータ保存後に通知する。
通知本文には保存結果の日付と種別のみを使い、自由記述本文・登録者名・保存先・認証情報は含めない。

## DBとAPI

追加マイグレーションは `db/migrations/015_web_push_notifications.sql`。
既存の `scripts/migrate_db.py` による適用方式を維持し、起動時の自動適用は行わない。
既存テーブル・既存データの削除は行わない。

| テーブル | 用途・制約 |
|---|---|
| notification_preferences | 組織＋団員IDが主キー。8種類のbooleanをJSONBで保存。すべてONをDB既定値にする |
| push_subscriptions | 組織、団員、認証端末、endpointと鍵。endpointは全体で一意。端末更新時は旧endpointを停止 |
| notification_events | 組織・種別・リソースID・保存版・操作から生成するSHA-256キーで重複防止 |
| notification_deliveries | イベント＋購読を主キーにし、状態・試行回数・HTTP結果・再試行時刻を記録 |

設定の初回取得・購読登録時に8種類の初期値を永続化する。
設定はログインや端末変更で失われない。購読の停止は他端末の設定・購読を変更しない。
団員IDの再利用に備え、古い設定は団員作成時刻より古ければ初期化する。
配信対象は団員作成後の購読・認証端末に限る。
設定更新はJSONBの部分更新で、同時更新時に無関係な項目を上書きしない。

| API | 動作 |
|---|---|
| GET /api/notifications/settings | 初期値永続化、表示可能な種別・設定・公開鍵・端末購読状態の取得 |
| PUT /api/notifications/settings | 既知種別のbooleanのみ更新。改善要望設定はシステム管理者限定 |
| POST /api/notifications/subscriptions | ユーザー操作後の許可済み購読を現在の団員・端末に紐付ける |
| DELETE /api/notifications/subscriptions | 現在の団員・端末の購読を停止 |

APIは既存 `X-Device-Id` 認証を利用し、団員IDや組織をリクエスト本文から採用しない。
さらにDBで現在の団員と端末の関連・期限・最新権限を確認する。
`/api/notifications/` 配下は既存通知HTTPミドルウェアで `Cache-Control: no-store` を設定し、
成功応答と認証・権限・入力検証・未設定のエラー応答（200/401/403/422/503）を対象にする。
認証・本文・ステータスコードは変更しない。画面は古いキャッシュで取得・保存成功を表示しない。
HTTPException等として処理される500にも適用するが、未処理例外の500は外側の
ServerErrorMiddlewareが生成するため対象外。全500への適用には最外側の例外応答処理の別変更が必要。
通知API以外のキャッシュ方針は変更しない。
購読endpointや鍵を返す一覧APIは設けず、汎用DBビューアの公開テーブルにも追加しない。
団員IDを持たない隠し管理者アカウントは今回の団員向け購読対象から除外する。

## 配信・重複防止・失敗

業務保存完了後、別トランザクションでイベントを記録する。
応答にASGI BackgroundTasksを付け、イベントをDBから取得して配信する。
組織ごとのPostgreSQL advisory transaction lockで送信走査を直列化し、
各端末の送信直前にINSERT/UPDATEの原子的claimを行う。
最大20イベント・500送信・約180秒の走査とし、残件はDBに残す。
24時間を超えたイベントは送信しない。

配信時に団員の存在、組織、認証端末との関連、有効期限、最新権限、通知ON/OFFを確認する。
改善要望はシステム管理者のみ、イベント調整はエキストラを除外する。
通知発生後に新しく登録した端末へ過去イベントを配信しない。

- 404/410: 購読を停止する。
- 429/503: 5分後以降の走査で再試行する。総試行回数は最大3回。
- その他のHTTP失敗: failedとして記録する。
- タイムアウト・通信例外: 成否が不明なためunknownとして記録し、自動再送しない。
- sending状態でプロセスが終了した場合: 自動再送しない。
- 送信済みは再送せず、端末側のtagにもイベントIDを指定する。

**再試行走査の入口は、新しい通知イベントと認証済み通知設定画面の取得である。**
常駐ワーカーや定時スケジューラーは今回追加しない。
無通信時に再試行時刻になっても自動的に起動する保証はない。
再試行を無通信時にも保証する要件が生じた場合、実行基盤の追加は別途承認対象とする。
業務保存とイベント記録は同一トランザクションではないため、保存後にプロセスが落ちたり
イベントDB書込みが失敗した場合、通知イベントが失われる可能性がある。
厳密なexactly-onceや通知到達は保証しない。失敗によって成功済みの業務データは取り消さない。
ログにはイベントID、種別、HTTP状態、例外型だけを記録し、例外メッセージ・endpoint・鍵・個人情報は出さない。

## 端末とセキュリティ

ブラウザ権限は画面表示や初期値ONで自動要求しない。「通知を許可する」の直接操作で要求する。
未許可・拒否・非対応・未設定の状態を区別し、保存失敗時は再保存を案内する。
iPhone/iPadはiOS/iPadOS 16.4以降のホーム画面Webアプリを対象にする。
ローカル購読とサーバー購読の両方を確認し、鍵変更時は購読を再作成する。
ログアウト時にはサーバー購読停止とブラウザunsubscribeを試行する。
端末やOS側での通知禁止・遅延は制御できない。

サーバーはブラウザの許可UI自体を直接検証できない。クライアントはpermissionがgrantedのときだけ
購読を登録し、APIでもpermission値と購読の鍵形式を検証する。
endpointはHTTPS/443、固定のFCM・Mozilla・Apple・Windows配信先に限定する。
ユーザー情報付きURL・不正な鍵を拒否し、HTTPリダイレクトを無効にする。
DBのendpointと鍵には既存DBのアクセス管理を適用し、公開APIや共有ZIPへ実データを含めない。

## 有効化前の確認（本作業では未実施）

1. 追加SQLをレビューし、承認された検証DBで適用・SQL動作確認を行う。稼働DBへの適用は別承認。
2. 検証環境専用のVAPID鍵を安全に用意する。公開鍵は非圧縮P-256公開鍵のBase64URL、
   秘密鍵はpywebpush対応のBase64URL形式のraw/DER鍵、subjectは運用連絡先のmailtoまたはHTTPS URL。
3. `.env.example` の `WEB_PUSH_ENABLED=false` を既定とし、鍵・DB・実機検証の準備後にだけ有効化する。
   実鍵はソースや設定例、ログ、共有ZIPに記載しない。本作業では実鍵を生成・保存していない。
4. 応答後の配信を使うためCloud RunのCPU割当を確認する。
   リクエストベースのCPU割当では応答後の処理が保証されない。
   本構成の運用にはinstance-based billing等、応答後のCPUを確保する設定が必要。
   費用・運用への影響を確認し、稼働サービスの設定変更は別承認とする。
5. 検証用端末・複数端末で実Push受信、画面を閉じた状態、ログアウト、権限変更・期限切れ、
   404/410の購読停止、通知タップ後の認証とブラウザバックを確認する。
6. 本番前は既存のPRODUCTION_RELEASE_CHECKLISTと実機チェック表を実施する。
   CI成功を確認するまでデプロイしない。

仕様根拠:
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Cloud Run: Background activities](https://docs.cloud.google.com/run/docs/tips/general#avoiding_background_activities)

## ローカル検証と変更前の失敗

新規テストはbackend `test_notifications.py`、Vitest `test_notifications.test.js`、
Playwright `notifications.spec.js` に配置する。
送信はモックを使用し、実Push配信・稼働DBへの接続・マイグレーション適用は行わない。
構文・ruff・pytest全体・frontend syntax/load-order/state-access・Vitest・Playwrightを実行し、
最終件数は `WEB_PUSH_IMPLEMENTATION_REPORT.md` に記録する。

Playwright全体で既存4件が失敗した。基準コミットのsrcを専用一時ディレクトリへ展開し、
ポート8001のローカルサーバーでも同じ4件・同じ原因で失敗することを確認した。

- `member.spec.js` / `member_flow.spec.js` / `smoke.spec.js`: 現行の「次回演奏会」に対して旧「演奏会情報」を探索する。
- `attendance.spec.js`: 現行で表示する練習場所を、表示しないこととして検証する。

これらの既存画面・既存テストは通知追加の範囲外として変更しない。
成功扱いにはせず、既存仕様に合わせたE2Eの更新を後続対応とする。

## 再発防止

- 構文、lint、Python/JavaScript/ブラウザの回帰検証を実施する。
- 初期script数を増やさず、既存の再生ボタン・曲長・権限・ブラウザ履歴を維持する。
- 初期ONと端末の許可を分離し、保存失敗や未確認の実機検証を成功扱いにしない。
- 設計書、DB/API仕様、運用手順をこの文書にまとめ、最終検証結果を別紙に記録する。
- コミット・プッシュ・デプロイ・稼働DBへの適用を行わない。
