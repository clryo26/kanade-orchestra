# 奏オケポータル API / データ仕様書

版: 2.0
最終更新: 2026-06-29

## 1. 概要

本書は現行実装の API と JSON コレクション仕様を定義する。

Version 5.1 では、運用データの正を PostgreSQL に統一する（DB Only）。
`src/data/*.json` は本番データソースとして扱わない。

## 2. 共通ルール

### 2.1 データ形式

- API の基本レスポンスは JSON
- 一覧は配列、単体はオブジェクト
- 更新系は created_at / updated_at を保持
- app_core は互換ファサードとして維持し、実処理は services/core/repositories へ配置する

### 2.2 ID

- next_id により整数採番
- 削除後も欠番は再利用しない

### 2.3 キャッシュ

- bootstrap 系 API は ETag を返却
- bootstrap 系 API の ETag は、レスポンスに含める全コレクションの ETag を合成して生成する
- クライアントは If-None-Match を送信可能

## 3. API 一覧

### 3.1 基本

- GET /
- GET /api/health

### 3.2 認証

- POST /api/auth/portal-login
- POST /api/auth/member-password
- GET /api/auth/devices/{device_id}
- GET /api/auth/devices
- DELETE /api/auth/devices/{device_id}

### 3.3 bootstrap

- GET /api/bootstrap-lite
- GET /api/bootstrap-core
- GET /api/bootstrap
- 画像系 bootstrap レスポンスでは `photo_url` / `flyer_image` / `image_url` を画像配信 API の URL に正規化する。
- 画像配信 API は `GET /api/members/{member_id}/photo`、`GET /api/performances/{performance_id}/flyer-image`、`GET /api/extra/promotions/{promotion_id}/image` を使用する。
- `bootstrap-lite` は初期表示用の軽量レスポンスとして `performances` / `schedules` / `announcements` / `members` / `extras.payments` / `extras.part_settings` / `extras.org_settings` / `extras.sns_settings` を返し、`extras.connection_settings` / `extras.flyer_distributions` / `extras.flyer_distribution_assignments` は返さない。
- `extras.payments` は bootstrap-lite では現在端末の持ち主の記録だけを返し、`/api/extra/payments` は管理者向けの全件取得に用いる。
- `flyer_distributions` と `flyer_distribution_assignments` はチラシ配布画面でのみ取得する。
- `performances` の公開レスポンスでは一覧表示に不要な `created_at` / `updated_at` を返さない。
- 画像本体は bootstrap レスポンスに埋め込まず、`photo_url` / `flyer_image` / `image_url` は画像配信 API の URL を返す。
- 画像配信 API は `GET /api/members/{member_id}/photo`、`GET /api/performances/{performance_id}/flyer-image`、`GET /api/extra/promotions/{promotion_id}/image` を使用する。

### 3.4 基本 CRUD

- /api/performances
- /api/schedules
- /api/members
- /api/events
- /api/announcements

各リソースで GET/POST/PUT/DELETE を提供。

### 3.5 録音

- POST /api/convert
- GET /api/recordings
- GET /api/recordings/download-zip
- GET /api/recordings/download-zip/info（一括DLの前に表示する件数・合計バイト数・取得できない件数）
- GET /api/recordings/play/{path}
- GET /api/recordings/download/{path}
- DELETE /api/recordings
- GET /api/recordings/cloud/play/{object_name}
- GET /api/recordings/cloud/download/{object_name}
- POST /api/drive/upload
- GET /api/drive/files

### 3.6 楽譜

- GET /api/sheets
- GET /api/sheets/download/{path}
- GET /api/sheets/view/{path}
- GET /api/sheets/cloud/download/{object_name}
- GET /api/sheets/cloud/view/{object_name}
- GET /api/sheets/download-zip
- POST /api/sheets/upload
- PUT /api/sheets/{sheet_id}/part
- PUT /api/sheets/parts
- DELETE /api/sheets
- GET /api/sheets/version（一覧更新番号。楽譜ライブラリを開いた時の確認用）
- GET /api/sheets/operations/{operation_id}（操作IDの処理状況）
- POST /api/sheets/tickets、GET /api/sheets/tickets/{ticket}（短期の保存用URL）
- POST /api/sheets/zip-jobs、GET /api/sheets/zip-jobs/{job_id}、POST /api/sheets/zip-jobs/{job_id}/step、POST /api/sheets/zip-jobs/{job_id}/cancel、GET /api/sheets/zip-jobs/{job_id}/download（段階作成のZIP）
- 楽譜の登録・パート変更・削除は `Idempotency-Key`（操作ID）と保存版（`expected_revision`）を使う行単位の操作。詳細は docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md

### 3.7 汎用 extra

- GET /api/extra/{name}
- POST /api/extra/{name}
- PUT /api/extra/{name}/{item_id}
- DELETE /api/extra/{name}/{item_id}

更新系リクエスト（POST/PUT/DELETE）は `X-Device-Id` ヘッダ必須。

PUT は以下を許容:

- 従来形式: 更新したい JSON 本体
- 競合検知形式: `{ payload: {...}, expected_updated_at: "..." }`

`expected_updated_at` が現行 `updated_at` と不一致の場合は `409` を返す。

対象 name は以下。

- absences
- event_responses
- date_adjustments
- date_adjustment_responses
- sheet_library
- payments
- castings
- piece_infos
- practice_instructions
- albums
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- desired_pieces
- promotions
- concert_record_videos

### 3.2 アクセスログ API

#### POST /api/system/access-logs

- 用途: ログイン済み団員がアクセスしたメニューを記録する
- 権限: 認証済み端末
- 入力: `menu_key`, `menu_label`, `panel`
- 保存時に `X-Device-Id` の認証端末から団員名、パート、権限、端末名を補完する

#### GET /api/system/access-logs

- 用途: アクセスログ一覧を新しい順で取得する
- 権限: システム管理者
- クエリ: `limit`（1〜1000、既定200）

## 4. 認証 API 詳細

### 4.1 POST /api/auth/portal-login

用途:

- 団員資格確認
- 端末認証情報登録
- ログイン応答返却

主要入力:

- name
- part
- password
- device_id
- device_name
- user_agent

主要出力:

- authenticated
- member_id
- member_name
- permission
- is_recording_manager
- is_sheet_manager

パスワードは保存時にハッシュ化し、団員一覧や bootstrap レスポンスでは `password` を空文字、`password_set` を設定有無として返す。元パスワードの復元表示は行わない。

### 4.2 POST /api/auth/member-password

用途:

- 初回パスワード登録

### 4.3 GET /api/auth/devices/{device_id}

用途:

- 端末単位の認証照会
- 最終アクセス時刻更新

## 5. 録音・楽譜仕様

### 5.1 録音メタデータ

代表キー:

- name
- date
- piece
- path または object_name
- play_url
- download_url
- source
- duration_seconds
- duration

録音一覧では、Cloud Storage のメタデータとローカル保存ファイルが同じ録音を指す場合、Cloud Storage 側を優先して 1 ファイル 1 件として返す。

### 5.2 楽譜メタデータ

代表キー:

- id
- performance_id
- performance_title
- piece
- part
- source
- path または object_name
- view_url
- download_url

drive_files では、Cloud Storage上の録音識別には object_name を使用する。PostgreSQL の id は内部採番IDであり、旧JSON互換の文字列IDは保存時に object_name として扱う。DB保存時は `created_at` / `updated_at` を必ず補完する。

## 6. JSON コレクション仕様

時刻フィールド（例: schedules.start_time / end_time / available_start_time / available_end_time）は、レスポンスでは秒を含めず `HH:MM` 形式に正規化する。

### 6.1 管理対象

- performances
- schedules
- announcements
- drive_files
- events
- members
- absences
- event_responses
- date_adjustments
- date_adjustment_responses
- sheet_library
- payments
- castings
- piece_infos
- practice_instructions
- albums
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- auth_devices
- recording_metadata
- desired_pieces
- promotions

### 6.2 重要フィールド

members:

- permission
- system_access_until
- is_recording_manager
- is_sheet_manager

payments:

- paid_until_month
- performance_fees

支払金額は、月額団費を org_settings.membership_fee_amount、演奏会費を performances.performance_fee_amount に保存する。payments は団員ごとの支払状況を保持し、金額入力の正本にはしない。

performances:

- performance_fee_amount

castings:

- performance_id
- piece
- members[]
- extras[]

date_adjustments:

- title
- deadline
- notes
- delete_phrase
- created_by
- member_id
- candidates[]

制約:

- title 必須
- candidates は1件以上必須
- candidates の date/start_time/end_time 重複は禁止

date_adjustment_responses:

- adjustment_id
- candidate_id
- name
- member_id
- status (ok / maybe / ng)
- note

制約:

- status は ok / maybe / ng のみ
- candidate_id/name 必須

piece_infos:

- performance_id
- piece
- description

認可:

- 認証済み団員なら登録・編集・削除可

practice_instructions:

- performance_id
- piece
- practice_notes
- performance_instruction

認可:

- 認証済み団員なら登録・編集・削除可

desired_pieces:

- title
- piece
- composer
- duration
- genre
- formation
- notes
- reference_audio_url
- reference_score_url

隱榊庄:

- 参考音源はYouTube URLで保存する
- 参考スコアはPDF 1ファイルで保存する

connection_settings:

- google_project_id
- google_cloud_storage_bucket
- google_cloud_storage_data_prefix
- google_cloud_storage_public
- google_service_account_file
- google_service_account_json

## 7. エラーハンドリング

- バリデーション失敗: 400
- 認証失敗: 401 / 403
- 未検出: 404
- クラウド保存失敗: 502

detail フィールドでメッセージを返す。

## 8. 参照

- main.py のコメント付き API 定義
- DESIGN_WEB.md
- SYSTEM_DESIGN.md

## JST日時・ファイル操作の契約（2026-10-19、ローカル実装）

通常業務APIの瞬間は `YYYY-MM-DDTHH:mm:ss.ffffff+09:00`。日付/年月/時刻/経過時間は区別し、既存専用APIのUTC契約、識別・署名・ICSを一律に変更しない。日時入力はoffset付きの有効な値を要求する。競合トークンは瞬間で比較し、旧naiveは409、不正入力422、DB保存値不正500となる。

`events.deadline` は暦日として往復し、DBのUTC 0時エンコードを維持する。不明な旧形式は表示を空にするが、空の再保存で元値を消さない。新たな回答締切制限は追加しない。API/IndexedDBの日時表現版は `jst-us-1`。

参考楽譜・共通画像の作成/置換/削除、確定参照を持つ所有行の削除は、UUIDの `Idempotency-Key` を使用する。対象でキーなしは428。同じ操作・内容は保存済み成功/拒否結果を返し、別内容は409。処理中は202。認証付き `GET /api/portal-file-operations/{operation_id}` は元添付や現在対象の存在を要求しない。正常照会の不存在404とDB照会不能503を区別する。

操作記録・業務行・確定アセット参照は同じDB接続/TXで確定し、回収は確定後に行う。通常の非ファイルAPIへ操作キーを一律必須化しない。詳細と未確認事項は[修正仕様](docs/JST_DATETIME_REMEDIATION_SPEC.md)と[計画書第13章](docs/JST_DATETIME_IMPLEMENTATION_PLAN.md#13-ローカル実装と検証の記録2026-10-19)を参照。

認証付き `GET /api/portal-file-actor` は、テナントとアカウント世代を表す不透明なscopeをno-storeで返す。保留操作のブラウザー保存キーはこのscopeへ結び付ける。同じアカウントの再ログイン後も結果を回復でき、IDを再利用した別世代には引き継がない。元の会員登録日時や内部actorキーは返さない。通信中の応答適用は別途、現在の認証世代でも照合する。


## 性能改善第3段階: 整合読取と版ETag（2026-10-23）

有効化はAPI別の既存環境変数方式で行い、`PORTAL_READ_CONTEXT_PATHS`・`PORTAL_VERSION_ETAG_PATHS`の未指定は無効。対象8 GET、HTTPヘッダー、依存表、2つの追加版表は[第3段階実装記録](docs/PERF_STAGE3_IMPLEMENTATION.md)を参照する。公開5一覧/coreの認証条件や200本文を変えない。liteの任意認証と団員紹介の必須認証を維持し、認証と版と本文を同じREAD ONLY/RR接続で読む。団員紹介は既存本文ハッシュを維持する。

版ETagは認証後に判定し、200/304はprivate, no-cacheと既存の利用者・団体区分のVary、Accept-Encodingを持つ。full bootstrap・認証API・専用楽譜/ファイル/プロモーションAPIは新経路の対象外。読取容量503はdetail.code=read_capacity_exceeded、Retry-After: 2。読取のversion_clock_anomalyだけ「データを確認できませんでした。管理者に連絡してください」とし、保存の既存文言を変えない。

023は対象12表の団体列・主キー・親子参照/団体一致を前提とし、不足時は停止する。互換スキーマだけではこの前提が揃わないため実DB事前検査が必要。業務表の制約やDBロールを自動整備しない。実DB適用・有効化は未実施。


第3段階レビュー補正（2026-10-23）: Web lifespanと読取スコープだけでプールを必須とし、単独保守のDB Only直接接続を維持する。版のない空団体は同じRRで空と確認して版0とし、初回書込で正の版へ移る。非空の版欠落は異常のまま。入場待ちはスレッドを使わず、41/80同時投入を検証する。詳細は[第3段階実装記録](docs/PERF_STAGE3_IMPLEMENTATION.md)の8924a59レビュー修正節を参照。
