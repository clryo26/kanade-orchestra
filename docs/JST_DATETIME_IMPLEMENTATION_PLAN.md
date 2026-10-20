# ポータル日時JST統一・修正 実装計画書

作成日: 2026-10-19（日本時間）
改訂: 第3版。2026-10-19の実装方針決定（一括実装・影響受容、10.5節）と最終レビュー指摘F01〜F05を反映。想定読者は構成を知っている引継ぎ実装担当者。
基準仕様: [docs/JST_DATETIME_REMEDIATION_SPEC.md](JST_DATETIME_REMEDIATION_SPEC.md) 第5版（未コミット・未追跡）
調査対象: ブランチ `feat/portal-display-improvements-20261008`、HEAD `9e567dc`
状態: **ローカル実装・検証中**。承認済み仕様に基づくソース・試験・追加マイグレーション・運用スクリプトの実装を進めている。TEST/本番反映・既存データ補正は未実施。最新状況は第13章、実装前の調査記録は第12章。

## 0. 凡例と前提

| 記号 | 意味 |
|---|---|
| 【事実】 | 現在のソースで確認した内容（ファイル:行を併記） |
| 【再現】 | 今回ローカルで実行して確認した挙動（DB・GCS・HTTP非接続） |
| 【推定】 | コードからの推論。実データ・実環境では未確認 |
| 【提案】 | 本計画の設計提案。実装時に採否を確定する |
| 【未確認】 | ローカルでは確定できず、読取確認が必要な事項（第10章） |

- 実装開始時の git 状態: 未追跡 `.pytest-promotion-focused/`、`.pytest-promotion-tmp/`、`docs/JST_DATETIME_REMEDIATION_SPEC.md` のみ。これらは変更しない。本計画書は新規作成で、同名ファイルは存在しなかった。
- 行番号は HEAD `9e567dc` 時点。実装時は関数名で再確認する。
- 本番・TESTのDB/GCS/Cloud Runには接続していない。

---

## 1. 調査結果と実装方針

### 1.1 仕様書の調査結果（D01〜D18）の再確認

| ID | 再確認結果 | 現在の根拠 |
|---|---|---|
| D01 | 【事実】一致。時間帯なし `datetime.now().isoformat()` が登録・認証・更新の主経路にある | `repositories/base_repository.py:36,45`、`auth_api.py:134,142,189,231`、`utils/datetime_utils.py:8`、`repositories/db_row_repository.py:255,269,364`、`services/album_service.py:51,174`、`services/recording_asset_service.py:66,144`、`core/startup.py:75`、`services/calendar_service.py:8`、`services/meta_service.py:70`、`services/maintenance_service.py:41` |
| D02 | 【事実】一致。`formatDateTimeLabel` がUTC日付 `toISOString().slice(0,10)` と端末現地時刻 `toTimeString()` を結合 | `static/js/modules/common_helpers/pure.js:69` |
| D03 | 【事実】一致。保存後はPython生成のnaive文字列をメモリーキャッシュへ格納、DB再取得はawareの `isoformat()`（接続のTimeZone依存のオフセット、µs=0なら小数省略） | `services/json_collection_service.py:119`、`repositories/db_row_repository.py:70-79`、【再現】`db_json_value(2026-10-19 03:00:00+00:00)` → `2026-10-19T03:00:00+00:00`（小数なし） |
| D04 | 【事実】一致。`today()` は端末現地日付、アクセスログ検索境界は端末現地0時、利用期限はサーバー現地日付 | `static/js/utils/runtime_context.js:35-41`、`modules/admin_system/access_logs.js:37-44`、`auth_helpers.py:86-95` |
| D05 | 【事実】一致し、**影響は仕様記載より大きい**（N02参照）。画面 `type="date"`、DBは `TIMESTAMPTZ`、書込みは日付→UTC 0時 | `src/index.html:494`、`core/db_schema.py:345`、`db_row_repository.py:136-149`、【再現】`parse_db_timestamp("2026-10-19")` → `2026-10-19T00:00:00+00:00` |
| D06 | 【事実】一致。比較（メモリーキャッシュの一覧）と保存（一覧置換）が別処理 | `services/extra_service.py:454-457,521`、`repositories/db_json_repository.py:315-493` |
| D07 | 【事実】一致。`update_item` は `trim_reference_score_files` を `save_json_data` より前に実行 | `extra_service.py:519-521` |
| D08 | 【事実】一致。配信は保存先prefixの最新mtime/updated候補を選択 | `services/desired_piece_asset_service.py:46-71,179-212` |
| D09 | 【事実】一致。共通画像は `{prefix}{ext}` 固定名へ上書き。利用者は団員写真・演奏会チラシ・団体アイコン | `services/image_asset_service.py:69-84`、`member_service.py:26-45`、`performance_service.py:26-56`、`extra_service.py:288-326` |
| D10 | 【事実】一致。UI終端 `T23:59:59+09:00`、ローカルストア `startedAt <= to` | `modules/tuner/view_history.js:255`、`modules/tuner/storage_local.js:491` |
| D11 | 【事実・再現】一致。9時間未来の前回値に+1µsした値を返す | `utils/datetime_utils.py:7-19`、【再現】前回 `…09:52:24.327183+00:00`（現在比+9h）→ `…18:52:24.327184`（naive） |
| D12 | 【事実】一致。`members.created_at` を宣伝/楽譜のactor、チューナー/メトロノームの所有者世代に使用 | `services/promotion_service.py:39-63`、`services/sheet_library_service.py`（`actor_key`）、`repositories/tuner_repository.py:69-103`、`services/tuner_service.py:196`、`services/metronome_service.py:248` |
| D13 | 【事実】一致。mtimeはnaive現地時間、GCSはaware | `routers/scores.py:45,66,89,101`、`recording_asset_service.py:108`、`drive_storage.py:251,301` |
| D14 | 【事実】一致。ETagはDBの `xmin` 署名で表現形式を含まない。端末は304で旧ペイロードを再利用 | `db_json_repository.py:181-246`、`services/bootstrap_service.py:60-84`、`common_helpers/api_runtime.js:343-391`、`utils/cache.js:12-31` |
| D15 | 【事実】一致。予約→照合→結果返却がvalidate_target/applyより先 | `promotion_service.py:159-172`、`sheet_library_service.py:149-174` |
| D16 | 【事実】一致。予約→`stage`（DB記録）→アップロード→確定時 `require_attempt` | `promotion_service.py:173-232`、`promotion_image_service.py:99-121` |
| D17 | 【事実】一致。`RETIRED_GRACE=15分`、`STAGED_GRACE=24時間`、`OPERATION_RETENTION=30日` | `services/sheet_cleanup_service.py:26-29` |
| D18 | 【事実】一致。`object_referenced` で横断照合 | `repositories/sheet_repository.py:287` |

### 1.2 新たに見つかった不備・矛盾

仕様書に明記されていない、または影響範囲が広い事項。日時修正の前提として扱うもの（必須）と、別課題として記録するもの（記録）に分ける。

| ID | 内容 | 根拠・確度 | 影響 | 推奨対応 | 区分 |
|---|---|---|---|---|---|
| N01 | 競合比較が文字列一致。同じ瞬間でも `Z`/`+00:00`/`+09:00`/naive の表記差で409 | 【事実】`utils/concurrency.py:6-12`。【再現】`03:00:00.123456+00:00` と `12:00:00.123456+09:00` で409 | 保存直後のキャッシュ値（naive）を持つ画面が、別インスタンス（DB値aware）で誤409。逆に将来の表記統一で旧トークン全件が409 | 瞬間比較へ変更（S03）。旧naiveトークンは409「再読み込み」 | 必須 |
| N02 | `events.deadline` を再編集すると消える | 【事実】DB取得値は `YYYY-MM-DDT00:00:00+00:00` 等（`db_row_repository.py:140`）。`events.js:42` で `type="date"` 入力へ代入→ブラウザは不正値を空にする→保存時 `deadline: ''`（`events.js:17`）→`parse_db_timestamp('')` は `None`。表示も `formatDateWithWeekday` が不正として生文字列を表示（`pure.js:68`） | 管理者がイベントを編集すると回答期限がNULLになる【推定：DBモード】 | 専用codecで日付として返す（S05）。不明形式の既存値は空送信で上書きしない | 必須 |
| N03 | `GET /api/auth/devices/{id}` の最終確認更新が全列UPSERT | 【事実】`auth_api.py:195-236` は読んだ `item` 全体を `upsert_auth_device`（`db_json_repository.py:249-289`、`ON CONFLICT (id) DO UPDATE` で `created_at` 以外全列）へ書く | 同じdevice_idで並行した新ログイン（別会員・新権限・新認証日時）を古い値へ巻き戻し得る（R08違反） | `last_seen_at` と会員由来列だけを条件付きUPDATE（S08） | 必須 |
| N04 | ログイン時のパスワード再ハッシュ、初回パスワード設定が会員一覧全体保存 | 【事実】`auth_api.py:129-136,184-191` → `save_json_data("members")` → `replace_collection` | 並行した会員登録・削除・権限変更を消す/復活させる | 行単位の部分UPDATE（S08） | 必須 |
| N05 | アルバム写真IDがアルバム内連番で、子表のUPSERTが `ON CONFLICT (id)` | 【事実】`album_service.py:53`（`max(photos)+1`）、`db_row_repository.py:518-533`（`"id": photo.get("id")`）、`db_json_repository.py:430-432`。【推定】別アルバムの同ID写真行を上書き・移動し得る。保存名 `albums/{album}/{date}/{id}_{name}` も衝突し上書き | 写真メタデータ消失・別アルバムへの移動、GCS実体上書き | DB採番・UUID保存名・確定後削除（S12）。実データ照合Q09 | 必須（日時台帳の `uploaded_at`・日別保存先に関係） |
| N06 | 削除系がDB確定前に外部ファイルを削除 | 【事実】`extra_service.py:549-556`（画像・参考楽譜→保存）、`member_service.py:184-187`、`performance_service.py:185-188`、`album_service.py:150-177` | DB削除失敗・競合で参照先だけ消える | 確定後回収へ（S11・S12） | 必須（R06） |
| N07 | メモリーキャッシュがテナント非分離。テナントはリクエストヘッダー由来 | 【事実】`memory_cache.py:25-31`、`core/middleware.py:38-47` | 他テナントのキャッシュを再利用し得る。DBが単一テナントでも、任意ヘッダーを受け付ける以上は安全の根拠にならない | 読込・格納・ETag・索引・無効化をテナント別キーへ統一（S07）。Q12は規模調査であり修正免除条件ではない | 必須 |
| N08 | 希望曲の曲名ロック判定の権限名が文字化け | 【事実】`extra_service.py:136` の比較文字列が `"邂｡逅・・"` 等 | 管理者を管理者として判定しない（本人管理者が曲名変更不可） | 日時対象外。別課題 | 記録 |
| N09 | クライアント送信のシステム日時を保存し得る | 【事実】`extra_collection_helpers.py:254-270`（作成時 `data.get("created_at")` を採用）、`db_row_repository.py:497-499,530-532`（投票・写真の `voted_at`/`created_at`/`updated_at` をpayload値で保存） | R02「システム管理項目はサーバーが設定」違反 | サーバー設定に限定（S06・S10） | 必須 |
| N10 | 宣伝の操作照会 `retryable` がアプリ時計 | 【事実】`promotion_service.py:92`（`repo.utc_now()` とDBの `lease_until` を比較） | 時計差で再試行可否表示がずれる（確定処理はDB時計で保護済み） | 既存専用APIのため今回変更しない。時計差測定（Q07）で影響評価 | 記録 |
| N11 | 通知イベントIDが `updated_at` の文字列表現に依存 | 【事実】`notification_service.py:119-130` | 表記変更をまたぐ同一版の再emitで別イベント扱い | 正規化済み瞬間文字列を使う（S06の戻り値を使えば自然に統一）。通常は1保存1emitで実害小 | 必須（軽微） |
| N12 | JSON→PostgreSQL移行スクリプトがnaive値をDBセッションTimeZoneで解釈 | 【事実】`scripts/migrate_json_to_postgres.py:53-58` | 移行時期の旧値は瞬間が9時間ずれている可能性【推定】 | 補正判断は実データ照合（Q06）まで保留 | 要確認 |
| N13 | チューナーのサーバー検索 `to` は包含、メトロノームは排他 | 【事実】`tuner_repository.py:435-437`、`metronome_repository.py:373-376` | 契約差。UIから `to` を送る呼出元はない【事実：view_historyはローカルストアのみ使用】 | サーバー契約は維持し文書化。ローカルに排他 `before` を追加（S13） | 必須（ローカル側） |
| N14 | 参考楽譜の配信は同一URL・`private, max-age=3600` | 【事実】`desired_piece_asset_service.py:205-211`、ルートに認証依存なし（`routers/albums.py:148-150`） | 置換後も1時間旧PDFが表示され得る | アセット版付きURL（S11）。認証付与は既存契約変更のため別判断（第10章 U14） | 必須（キャッシュ）／記録（認証） |
| N15 | 瞬間の文字列ソート | 【事実】`modules/albums.js:12`、`modules/notices.js:48`、`date_piece_promotion/helpers.js:10`、`date_piece_promotion/render_desired_promotion.js:63`、`json_collection_service.py:130-136`、`auth_api.py:251-255`、`routers/scores.py:28-29` | 表記混在時に並び順が崩れる | 瞬間値で比較（S04・S07） | 必須 |
| N16 | Python 3.10 の `fromisoformat` は `Z` と3/6桁以外の小数を解析不可 | 【事実】Python 3.10仕様（3.11で拡張） | 厳密パーサを `fromisoformat` だけで実装すると1〜2,4〜5桁の小数を拒否 | 正規表現で検証後に組み立てる（S01） | 必須 |
| N17 | DockerfileにTZ・tzdataの明示なし。`tzdata` はWindows向け依存のみ | 【事実】`Dockerfile`、`uv.lock:1901` | `ZoneInfo("Asia/Tokyo")` の可否が環境依存 | 固定オフセットJSTを採用（D-01） | 必須 |
| N18 | DB接続に `TimeZone`・`lock_timeout`・`statement_timeout` 指定なし | 【事実】`core/db_config.py:9-31`、`core/db_pool.py:45-50` | naive送信値の解釈が接続設定次第。ロック待ちが無期限 | naiveをDBへ送らない。行ロックするトランザクションだけ `SET LOCAL` で上限設定（S06） | 必須 |
| N19 | 識別子・IDの採番が `max(id)+1`（明示ID INSERT） | 【事実】`base_repository.py:37`、`extra_service.py:396`、`utils/collection_utils.next_id` | IDENTITYシーケンスが進んでいない可能性。DB採番へ切替えると既存IDと衝突し得る【推定】 | 行単位INSERTは表ロック相当のadvisory lock下で `max+1` を維持しシーケンスも追従（S06）。Q16で確認 | 必須 |
| N20 | 参考楽譜アップロードにサイズ上限なし | 【事実】`desired_piece_asset_service.py:74-105` | 長時間アップロード・メモリー使用 | 既存楽譜の30MiB等に合わせた上限を設ける案（U13） | 記録 |

### 1.3 実装方針の要約

1. **時間帯の実装は固定オフセットJST**（Python `timezone(timedelta(hours=9), "JST")`、JSは `UTC+9` 算術）。日本は1951年以降夏時間がなく、現行ポータル対象期間に限る方針を文書化する。パッケージ追加不要（D-01）。
2. **DBへnaive値を送らない**。瞬間は aware `datetime` で渡すか、DB側 `clock_timestamp()` で生成する。DBのTimeZone設定は変更しない（R02・3.1）。
3. **通常業務APIの瞬間出力は `YYYY-MM-DDTHH:MM:SS.ffffff+09:00`**。DB値（`TIMESTAMPTZ`）からの変換を `db_row_to_json` に集約。宣伝・楽譜・チューナー・メトロノーム等の既存専用APIは出力契約を維持（D-02）。
4. **単一項目の登録・更新・削除は行単位**。新規 `repositories/db_item_repository.py` に、ロック・競合比較・DB時刻による更新版生成・子行置換・テナント条件を集約し、`BaseRepository` と `extra_service` から利用する。一覧置換が残る経路は「DB側advisory lock下でDBから読み直して置換」する共通関数へ寄せ、行単位対象の一覧置換はガードで禁止する（R05）。
5. **ファイルは操作照合・アップロード前の永続準備記録・確定参照・確定後回収**。参考楽譜・共通画像には `portal_file_operations` と `portal_file_assets` を今回導入し、クライアントが同じ操作IDで再送・照会できるようにする。既存の宣伝・楽譜機構は維持する。
6. **表現版（`jst-us-1`）をETagとIndexedDBエントリへ付与**し、旧形式の304再利用を防ぐ（R09）。
7. **旧データ補正は読取照合まで保留**。表示・解析の修正は先行できるが、9時間補正等は根拠確定後に専用手順で行う（R10・R11）。

---

## 2. 要件と変更箇所の対応表

区分: **変更**＝コード変更が必要／**維持**＝現実装で満たし維持／**要確認**＝実環境・旧データの確認が必要／**設計選択**＝詳細設計の選択が必要（第10章で推奨）。1要件に複数区分あり得る。

| 要件 | 区分 | 主な変更箇所（手順） | 補足 |
|---|---|---|---|
| R01 基本原則 | 変更・要確認 | 全体。S01〜S16 | 「同じ版は保存直後・キャッシュ・DB再取得・別インスタンスで同じ表記」はS02（出力統一）＋S06（確定値返却）＋S07（キャッシュ無効化）で満たす。端末時計誤りは対象外と明記（S15文書） |
| R02 共通バックエンド処理 | 変更・設計選択 | S01（`datetime_utils`）、S02（`db_row_repository`）、S03（`concurrency`）、S06、S09（mtime/GCS）、S10 | 固定オフセット（D-01）。厳密解析はN16対応。新規入力の不正は422、DB側不正値は500サービスエラー |
| R03 表示と暦演算 | 変更 | S04（`pure.js`、`runtime_context.js`）、S13（チューナー/メトロノーム表示）、S14（個別画面） | 月末規則は現行 `setMonth` を固定テスト（`payments.js:305-311`）。`absences.js:171-178` はUTC暦演算で正しく維持 |
| R04 今日・期限・検索境界 | 変更・要確認 | S04（today、再評価）、S07（アクセスログAPI）、S08（`member_access_expired`）、S05（events.deadline）、S13（チューナー終端） | 回答受付制限は**存在しない**【事実：`event_responses`・`date_adjustment_responses` の保存経路にdeadline判定なし、`extra_service.py`・`timetable_payload_helpers.py:40-71`】。新規制限は追加しない |
| R05 永続化の原子性 | 変更・設計選択 | S06（新リポジトリ）、S10（`BaseRepository`・`extra_service`）、S08（認証）、S12（アルバム）、S07（一覧保存ガード） | 行単位／一覧保存の区分は6.3節。ロック順・上限は6.2節 |
| R05-A 操作同一性 | 変更・維持 | S11の新規対象へ操作ID・指紋・終端結果・保持規則を導入。既存専用APIは維持 | 新規対象もT19〜T24を実行。単なるサーバー生成要求IDで代替しない |
| R05-B 再送判定順序 | 変更・維持 | S11の新規対象も、セッション/主体→操作照合/終端結果→実行権→対象確認→準備→確定の順序 | 保存済み結果に現在対象の存在・版一致を再要求しない。DB照会不能を未実行としない |
| R06 確定参照・置換・回収 | 変更 | S11（参考楽譜・共通画像・新規 `portal_file_asset_service.py`）、S12（アルバム）、S17（移行・回収スクリプト） | 既存の宣伝/楽譜は変更しない |
| R06-A 状態・試行・回収 | 変更・設計選択 | S11。状態・数値は6.5節 | 回収周期は運用決定事項（U10） |
| R07 更新版と未来値 | 変更・要確認 | S06（DB時刻・`GREATEST`・5秒閾値）、S01（ローカルJSONモードの `next_updated_at`） | 5秒は設計値。Q05/Q07で実測後に確定 |
| R08 認証・所有者 | 変更・維持 | S08（認証日時、最終確認、フォールバック単調時計、期限JST）。`members.created_at` は不変を維持（`db_upsert_rows` の除外 `db_row_repository.py:290` を新リポジトリでも踏襲） | 署名・ハッシュ・音声クロックは維持（6.7節） |
| R09 表現版とデータ版 | 変更 | S07（テナント別キャッシュ・索引・ETag・無効化）、S04（端末の形式版） | 単一テナント確認だけでN07を別課題へ送らない |
| R10 旧値の扱い | 要確認・変更 | S02（codec）、S05（deadline）、S17（照合・補正スクリプト雛形）、第9章 | 一律±9時間補正禁止 |
| R11 反映条件 | 変更・要確認 | 第9章、S20。今回用の `manage_datetime_maintenance.py` を計画 | 既存の宣伝リセット専用解除手順をそのまま使わず、既存ガードを弱めない |
| R12 検証 | 変更 | 第8章 | PG実接続並行試験、TZ組合せ試験を追加 |

---

## 3. 日時項目別の契約台帳

列: 項目／分類／DB型（実在DDL）／生成元（現状）／API出力（現状→新）／旧値の解釈根拠／精度／null・空／異常時／識別依存／移行区分／テスト。
移行区分: A=スキーマ変更不要・補正不要（表示/出力修正のみ）、B=追加スキーマ必要、C=旧データ補正の可能性（要確認）、D=識別用で専用移行、E=実環境確認まで判断不可。

### 3.1 瞬間（DB TIMESTAMPTZ）

| # | 項目 | 分類 | DB型 | 生成元（現状） | API出力 現状→新 | 旧値の解釈根拠 | 精度 | null/空 | 異常時 | 識別依存 | 区分 | テスト |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L01 | 通常コレクションの `created_at`（`DB_COLLECTION_COLUMNS` の全表） | 瞬間 | `TIMESTAMPTZ NOT NULL DEFAULT NOW()`（`core/db_runtime.py:153-154`、`db/postgresql_table_spec.md:11`） | `base_repository.py:36`、`extra_collection_helpers.py:254-270`（naive）、`db_row_repository.py:255-262`（naive）、DB既定値 | DB取得: 接続TZのオフセット・µs可変 →JST6桁。保存直後: naive→DB確定値 | DB内は瞬間として保存済み。**その瞬間が正しいかは「アプリ生成時のTZ」×「書込み時の接続TimeZone」に依存**。Cloud Run既定TZ（UTC）【推定】×接続TimeZone【未確認 Q01/Q02】 | µs | NOT NULL | 出力時に変換不能なら500（サービス）。表示は「日時不明」 | `members` 以外なし | A（表示）＋E（補正可否） | T01,T04,T05,T18 |
| L02 | 同 `updated_at` | 瞬間・競合トークン | 同上 | 同上。競合比較は `concert_record_videos`・`desired_pieces`（画面送信 `concert_record.js:177,224`、`date_piece_promotion/api.js:59-61`） | 同上。新: DB `GREATEST(clock_timestamp(), 前回+1µs)` の確定値 | 同上 | µs（トークンは文字列のまま返送） | NOT NULL | 前回値>DB現在+5秒で更新停止（R07） | 通知イベントID（N11） | A＋E | T04,T05,T08,T10 |
| L03 | 子表 `created_at`/`updated_at`（`performance_pieces`、`date_adjustment_candidates`、`payment_performance_fees`、`casting_members`、`casting_extras`、`desired_piece_votes`、`album_photos`） | 瞬間 | 同上（`DB_CHILD_COLUMNS`） | `db_row_repository.py:363-534`（親値継承 or naive now、payload値） | 親JSON内の配列要素→JST6桁 | L01と同じ | µs | NOT NULL | 同上 | なし | A＋E | T05,T08 |
| L04 | `members.created_at` | **識別用**瞬間（会員世代） | `TIMESTAMPTZ` | `base_repository.py:36`（naive） | 会員公開payloadに含むか要確認→JST6桁（値の瞬間は不変） | 同上。宣伝actor `promotion_service.py:59-63`（UTC正規形）、楽譜actor、`tuner_owners.member_birth`（`tuner_repository.py:82` で瞬間一致比較） | µs | NOT NULL | 補正禁止。不一致は所有者失効を誘発 | **宣伝/楽譜の操作記録キー、チューナー/メトロノーム所有者** | D | T13,T24 |
| L05 | `auth_devices.authenticated_at`/`last_seen_at` | 瞬間・認証世代 | `TIMESTAMPTZ`（`db_schema.py:347`） | `auth_api.py:142,231`、フォールバック | aware/JST6桁。新規永続値はDB時計 | L01と同じ。旧naiveの意味は未確定なら推測しない | µs | 任意。認証世代に使う値は欠落時の既存契約を確認 | 不明表示は日時不明。世代判定値の欠落/不正で認証を緩めない | `authenticated_at` は tuner_service.resolve_owner / metronome_service.resolve_owner で会員登録日時と比較。`created_at` が既存の代替値。`last_seen_at` は最終確認 | A＋E、補正は識別依存照合必須 | T13,T24 |
| L06 | `access_logs.accessed_at` | 瞬間・検索境界 | `TIMESTAMPTZ NOT NULL DEFAULT NOW()`（`db_runtime.py:106-121`、索引 `idx_access_logs_accessed_at`） | `routers/access_logs.py:28`（`next_updated_at()` naive） | →JST6桁。新: DB `clock_timestamp()` | L01と同じ | µs | NOT NULL | — | なし | A＋E | T06 |
| L07 | `desired_piece_votes.voted_at` | 瞬間 | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | `db_row_repository.py:497,507`（payload値 or naive now） | 投票配列内→JST6桁。新: 新規投票はDB時刻、既存投票は保持 | L01＋**クライアント送信値の可能性**（N09） | µs | NOT NULL | — | なし | A＋E | T08 |
| L08 | `album_photos.uploaded_at`、`albums.created_at`（画面「作成日」） | 瞬間 | `TIMESTAMPTZ` | `album_service.py:51,174`（naive） | →JST6桁 | L01と同じ | µs | 任意 | — | なし | A＋E | T05,T11 |
| L09 | `improvement_suggestions.created_at/updated_at`、`portal_notices.created_at/updated_at` | 瞬間 | `TIMESTAMPTZ DEFAULT NOW()`（`013`、`014`） | DB `NOW()`（`improvement_suggestion_repository.py:96`）→【正しい既存実装】 | `isoformat()`（接続TZ）→JST6桁 | DB生成のため瞬間は正しい | µs | — | — | なし | A | T05 |
| L10 | 管理用: `schema_migrations.applied_at`、監査ログ、メニュー設定 `updated_at` | 瞬間（運用表示） | `TIMESTAMPTZ` | DB既定値 | `system_repository.py:84,163,195` の `isoformat()`→JST6桁 | DB生成 | µs | — | — | なし | A | T05 |
| L11 | 宣伝 `promotions.*`、`promotion_operations.*`、`promotion_image_assets.*` | 瞬間（既存専用API） | `TIMESTAMPTZ`（`018`、`clock_timestamp()`） | DB時刻【正しい既存実装】 | `repo.iso`（接続TZ）→**維持**（D-02） | DB生成 | µs | — | — | 操作キー（actorにmembers.created_at） | A（変更なし） | T19〜T24回帰 |
| L12 | 楽譜 `sheet_*` | 同上 | `TIMESTAMPTZ`（`020`、`021`） | DB時刻 | 維持（`sheet_library_service.py:48` の `modified_at` 含む） | DB生成 | µs | — | — | 同上 | A（変更なし） | 回帰 |
| L13 | チューナー/メトロノーム `started_at`、`finalized_at`、`expires_at`、`member_birth` 等 | 瞬間（同期契約UTC `Z`） | `TIMESTAMPTZ`（`017`、`019`） | aware UTC（`tuner_repository.py:44-49`、`metronome_repository.py:80`） | `Z`表記を**維持**。表示だけJST化 | aware生成 | µs/ms | — | — | 所有者世代・ハッシュ | A（API変更なし） | T16 |
| L14 | `drive_files`/`recording_metadata` の `created_at/updated_at` | 瞬間 | `TIMESTAMPTZ` | `recording_asset_service.py:66,144`、`db_row_repository.py:269-280`（naive） | →JST6桁 | L01と同じ | µs | NOT NULL | — | なし | A＋E | T05 |
| L15 | `modified_at`（録音ローカル、PDF編集、GCS） | 瞬間（APIのみ、DB非保存） | — | mtime `datetime.fromtimestamp(st_mtime)`（naive現地）、GCS `blob.updated`（aware UTC）、欠落時 naive now | 混在→JST6桁（mtimeはepoch→aware） | mtimeはepochで時間帯非依存 | µs | 空文字 | — | 並び順（`scores.py:28-29`） | A | T04 |
| L16 | 診断: `/api/health` `timestamp`、孤立検査 `checked_at`、`generated_at`、`calendar_service.current_timestamp` | 瞬間（運用表示） | — | naive（`meta_service.py:70`、`maintenance_service.py:41`、`calendar_service.py:8`）、aware UTC（`system_service.py:170`） | →JST6桁（`generated_at` もJSTへ。UTC例外にしない） | 都度生成 | µs | — | — | なし | A | T05 |
| L17 | 本番運用履歴 `production_operation_histories`（汎用JSON） | 瞬間（運用契約） | JSONB内文字列 | `production_ops_service.py:26`（aware UTC） | **UTC維持**（運用契約の例外として記録）。画面は時間帯付き値をJST表示 | aware | µs | — | — | なし | A | T16 |
| L18 | 通知内部 `notification_events.created_at`、`next_attempt_at` 等 | 瞬間（内部） | `TIMESTAMPTZ`（`015`） | DB `NOW()` | API非公開。維持 | DB生成 | µs | — | — | イベントID（N11） | A | 回帰 |
| L19 | フォールバック認証の有効期限 `_fallback_expires_at` | 経過時間 | プロセス内 | `auth_session_fallback.py:13,35`（naive現地） | 非公開。単調時計へ | — | — | — | 期限切れで削除 | 8時間寿命 | A | T13 |

### 3.2 日付・月・時刻・経過時間・識別子

| # | 項目 | 分類 | DB型 | 現状 | 新契約 | 旧値の扱い | 区分 | テスト |
|---|---|---|---|---|---|---|---|---|
| L30 | `performances.date`、`schedules.date`、`announcements.date`、`events.date`、`portal_notices.date`、`recording_metadata.date`、`date_adjustment_candidates.date`、`flyer_distribution_assignments.planned_date/distributed_date`、`payments.latest_payment_date` | 日付 | `DATE` | `parse_db_date`（`db_row_repository.py:95-112`）は `/`・`.`区切り・時刻付き・`YYYY-MM` を寛容に受理 | 新規入力は `YYYY-MM-DD` 厳密（不正は422）。DB値は `date.isoformat()` で維持 | DATE型のため暦日は保持済み | A | T02,T03 |
| L31 | `members.system_access_until`、`auth_devices.system_access_until` | 日付（利用期限） | `DATE` | 判定は `datetime.now().date()`（サーバー現地＝【推定】UTC） | 判定は `jst_today()`。最終日は終日有効、翌日00:00 JSTから失効 | 値は維持 | A | T07 |
| L32 | `members.joined_at` | 日付（画面は `type="month"`、`index.html:606`） | `DATE` | `parse_db_date` が `YYYY-MM` を `-01` 補完 | 現行規則を維持（変更しない） | 維持 | A | T03 |
| L33 | `date_adjustments.deadline` | 日付 | `DATE` | 文字列のまま保存（`timetable_payload_helpers.py:65`） | 厳密 `YYYY-MM-DD` | 維持 | A | T07 |
| L34 | `events.deadline` | **日付（DBはTIMESTAMPTZ）** | `TIMESTAMPTZ`（`db_schema.py:345`） | 書込み: 日付→UTC 0時（`db_row_repository.py:144-145`）。読込み: aware日時文字列（N02） | 専用codec「UTC 0時で日付を表す」（D-03）。読込み `(deadline AT TIME ZONE 'UTC')::date` 相当、UTC 0時以外は不明 | 現行コードの書込みは全てUTC 0時【事実】。過去版・移行スクリプト経由は【未確認 Q04】 | A（Q04で0件確認時）／C（不適合あり） | T07,T15 |
| L35 | `improvement_suggestions.responded_at` | 日付（対応日） | `DATE` | `date` で処理【正しい既存実装】 | 維持 | — | A | T02 |
| L36 | `payments.paid_from_month/paid_until_month` | 月 | `CHAR(7)` | `parse_db_month` | 維持。画面の月演算は暦演算のまま | — | A | T03 |
| L37 | 時刻 `performances.open_time/start_time`、`schedules.start_time/end_time/available_*`、`events.start_time`、`absences.planned_time`、`date_adjustment_candidates.start_time/end_time` | 時刻 | `TIME` | `parse_db_time` は `HH:MM` に丸め（秒切捨て、`db_row_repository.py:115-133`） | 既存 `HH:MM` 契約を維持。新規入力の秒付きは現行どおり受理し分単位で保存（変更しない） | — | A | T03 |
| L38 | `schedules.time`、`schedules.available_hours` | 自由記述 | `TEXT` | 文字列 | 変換対象外（R02「宣言した項目だけ」） | — | A | — |
| L39 | `recording_metadata.duration_seconds`、チューナー/メトロノームのepoch ms・`AudioContext.currentTime`・`performance.now` | 経過時間/数値時刻 | NUMERIC / JSON | 既存単位 | 維持 | — | A | T16 |
| L40 | アルバム保存先 `albums/{album}/{YYYY-MM-DD}/…` | 運用上の日付＋識別 | GCSキー | `album_service.py:55`（サーバー現地日付） | 新規はJST日付＋UUID。既存キーは改名しない | 既存維持 | A | T11 |
| L41 | 録音アップロード日別ディレクトリの既定値 | 運用上の日付 | GCSキー | `recording_upload_service.py:28,123`（サーバー現地日付） | 既定値をJST日付へ | 既存維持 | A | T02 |
| L42 | 参考楽譜保存名 `YYYYmmddHHMMSSffffff_name.pdf` | 識別子 | GCSキー | `desired_piece_asset_service.py:40-43` | UUIDキー（S11） | 既存は移行で参照固定 | B | T11,T12 |
| L43 | 共通画像 `{prefix}.{ext}` | 識別子 | GCSキー | 固定名（D09） | UUIDキー＋アセット版URL | 既存キーは旧URLで配信継続 | B | T11,T12 |
| L44 | 端末: チューナー整備ログ日付、メトロノーム校正日表示、楽譜同期時刻表示、ICS | 日付/表示 | 端末 | `view_history.js:548`（UTC日付）、`metronome/view_analysis.js:135`（UTC日付）、`scores/sync.js:55-58`（端末現地）、ICS `schedules.js:238-257` | JST日付・JST時刻へ。ICSの `DTSTAMP` UTC・`TZID=Asia/Tokyo`・終日 `VALUE=DATE` は維持 | 既存端末データは書き換えない | A | T16,T17 |

---

## 4. 修正対象ファイル一覧

### 4.1 既存ファイル（バックエンド）

| ファイル | 対象関数／処理・行 | 仕様ID | 現状と問題点 | 具体的な変更内容 | 呼出元／関連 | 互換性・データ影響 | テスト | 順序・前提 |
|---|---|---|---|---|---|---|---|---|
| `src/backend/utils/datetime_utils.py` | `next_updated_at` 7-19、ファイル全体 | R02,R07 | naive生成、未来値に+1µs、`astimezone()` 引数なし | JST定数・厳密解析・出力・暦検証・日付範囲を追加（5.1節）。`next_updated_at` は名前を維持し、aware JST・6桁・未来5秒超で `FutureVersionAnomaly`。DBモードの更新版生成には使わない | `app_core.py:260`、`extra_service.py:33`、`routers/access_logs.py:16`、`app_core.py:487` | 公開名維持（`core/app_core_exports.py:61`）。戻り値がnaive→aware JSTに変わる | 新 `test_datetime_utils.py` | S01（最初） |
| `src/backend/utils/concurrency.py` | `ensure_expected_updated_at` 6-12 | R05,N01 | 文字列一致 | 両辺を瞬間で比較。期待値が形式不正→422、naive旧トークン→409（再読込）、現在値不正→500。ローカルJSONモードとファサード用に維持し、DBモードは新リポジトリ内で同等比較 | `extra_service.py:457`、`app_core.py:259` | 公開名維持 | 新 `test_concurrency_instant.py` | S03（S01後） |
| `src/backend/repositories/db_row_repository.py` | `db_json_value` 70-79、`db_row_to_json` 82-92、`parse_db_date` 95、`parse_db_timestamp` 136-149、`db_write_value` 161-203、`db_fetch_all` 206-222、`db_prepare_timestamp_columns_for_upsert` 251-262、`db_collection_rows_for_save` 265-281、`db_child_rows_for_collection` 363-534 | R02,R05,R10,N09 | aware/naive・µs可変の出力、naive書込み、日付→UTC0時の汎用処理、子行にクライアント値・naive now | `db_json_value`: aware→`format_instant`、naive datetimeは現行 `isoformat()`（推測付与しない）。`db_row_to_json(row, table_name=None)` に `events.deadline` codec。`parse_db_timestamp`: aware文字列/aware datetimeのみ受理し `format_instant`、日付のみは `events.deadline` 用の旧規則（UTC0時）として残す、naiveは `InvalidDateTimeValue`。`db_write_value`: 全表の `created_at/updated_at` もtimestamp扱い。`db_prepare_…`/`db_collection_rows_for_save`/子行生成のnowは aware（DB時刻を渡す引数を追加）、クライアントの `voted_at/created_at/updated_at` は採用しない（既存子行は照合して保持） | `db_json_repository.py`、`access_log_repository.py:124`、新 `db_item_repository.py`、`app_core.py:246,255` | 公開名維持。出力表記が変わる→ETag表現版（S07）と同時反映 | `test_db_json_layer.py` 拡張、新 `test_db_row_codecs.py` | S02（S01後） |
| `src/backend/repositories/db_json_repository.py` | `load_json_data` 108-178、`load_collection_etag` 181-246、`upsert_auth_device` 249-289、`replace_collection` 315-493、`save_generic_json_collection` 64-76 | R05,R09,N03 | 一覧置換が行単位対象にも使われる。ETagに表現版なし。端末UPSERTが全列 | (1) `db_fetch_all` 呼出しで `table_name` を `db_row_to_json` へ渡す。(2) ETag digestに `API_DATETIME_FORMAT_VERSION` を含める。(3) `replace_collection` に `ROW_LEVEL_COLLECTIONS` ガード（`allow_bulk=True` は移行・シードのみ）。(4) 新関数 `mutate_collection_locked(name, mutator)`: advisory lock→同一接続でDB読込→置換→commit。(5) `upsert_auth_device` は `authenticated_at/last_seen_at` をDB `clock_timestamp()` で設定、新関数 `touch_auth_device(device_id, member_id, member_fields)` | `json_collection_service.py:111-120`、`auth_api.py`、`routers/bootstrap.py:42-60` | ETag全件変化（初回だけ再取得）。行単位対象への一覧置換は409/500に変わる→呼出元を先に移行 | `test_db_json_layer.py`、`test_db_mode_api_regression.py`、PG並行試験 | S07（S06・S10後にガード有効化） |
| `src/backend/core/db_schema.py` | 定数群 | R05 | 行単位対象の宣言なし | `ROW_LEVEL_COLLECTIONS`、`LIST_LOCKED_COLLECTIONS`、`DATE_ENCODED_TIMESTAMP_COLUMNS = {("events","deadline")}` を追加。既存定数は変更しない | `db_runtime.py`（DDL生成は不変） | なし | `test_db_schema_consistency.py` | S02 |
| `src/backend/services/json_collection_service.py` | load/save/list | R05,R09,N07,N15 | 名前だけの共有キャッシュ、保存構築値の再利用 | 読込/格納/ETag/無効化/索引のすべてを現在テナントでスコープ化。保存後は当該テナント・名前だけ無効化。DBモードの行単位対象は行APIへ誘導。端末一覧は瞬間順 | compat_data、app_core、bootstrap | ローカルは既定テナント。公開メソッド名は維持 | テナントA/B交互読込、同名コレクション、無効化、ETagの試験 | S07 |
| `src/backend/services/memory_cache.py` | get/set/etag/get_index/clear/invalidate | R09,N07 | データ・ETag・索引が名前のみで共有 | 内部キーを `(tenant_id, name)` へ統一。テナントはサーバーの検証済みcontextから取得。clear(name)等は現在テナントのみ、全テナント破棄は起動/運用用の明示メソッドで区別。ETagにテナントと表現版を含める | compat_data、collection_utils、bootstrap、全呼出元 | 既存の全消去用途を棚卸し。HTTPヘッダーだけを利用者のテナント権限の証明にしない | 新 `test_memory_cache_tenant_isolation.py`、bootstrap回帰 | S07 |
| `src/backend/services/bootstrap_service.py` | `combined_collection_etag` 60-73 | R09 | 同上 | digestへ表現版を追加 | `routers/bootstrap.py:79-161` | 初回304なし | `test_bootstrap_swr`（JS）、新規Python | S07 |
| `src/backend/repositories/base_repository.py` | `create` 34-40、`update` 42-54、`delete` 56-59 | R05,R02 | 一覧読込→全体保存、naive時刻、`max+1` | DBモード: `db_item_repository` へ委譲（create=insert、update=mutate付き行更新、delete=行削除）。`expected_updated_at` 引数を任意追加。ローカルJSONモード: 現行構造＋aware時刻 | events/members/schedules/announcements/performances/payments/albums/recording の各service | API互換（応答の日時表記のみ変化） | `test_auth_and_crud.py`、`test_repository_contracts.py`、PG並行 | S10（S06後） |
| `src/backend/services/extra_service.py` | `create_item` 366-444、`update_item` 447-536、`delete_item` 539-556、`_prepare_desired_piece_payload` 244-264、`_persist_collection_image` 296-315、`_concert_record_resequence_group` 203-222 | R05,R06,D06,D07,N06 | 一覧比較・全体保存、DB確定前のtrim/削除、固定名画像 | 行単位: `db_item_repository.update_item(name, id, mutate, expected_updated_at=…)` の `mutate` 内で権限・検証・正規化（I/Oなし）。ファイルは S11 の手順（準備記録→アップロード→確定→回収）。演奏会記録動画は `performance_id` グループロック。出欠作成は `(schedule_id, member_id)` ロックで重複防止。希望曲の投票のみ更新はDB現在値に対する差分適用 | `routers/albums.py:26-67`（汎用extraルート） | 応答形式維持。対象不存在404・版不一致409を維持 | `test_db_mode_extra_collections_crud.py`、`test_attendance_extra_api.py`、`test_concert_record_videos.py`、`test_desired_piece_*`、PG並行 | S10（S06後）、ファイル部分はS11 |
| `src/backend/services/extra_collection_helpers.py` | `normalize_extra_payload` 254-270、`parse_extra_upsert_request` 126-146 | R02,N09 | 作成時にクライアント `created_at` 採用 | `id/created_at/updated_at` をpayloadから除去しサーバー設定。`expected_updated_at` の前後空白除去のみ（解析はconcurrency/リポジトリ） | `app_core.py:487` | クライアント指定のcreated_atが無視される（意図した変更） | 単体 | S10 |
| `src/backend/services/desired_piece_asset_service.py` | 全体（40-212） | R06,D07,D08,N14,L42 | 時刻名、最新候補配信、prefix一括trim/削除 | `portal_file_asset_service` を使う実装へ置換。最新候補探索関数は移行スクリプト用の読取専用に限定。配信は確定アセットのみ、URL `…/reference_score?asset=<uuid>` | `extra_service.py:14-20`、`routers/albums.py:148-150` | 旧URL（asset無し）は互換配信（6.5節） | `test_desired_piece_reference_assets.py` 書換え | S11（S16スキーマ後） |
| `src/backend/services/image_asset_service.py` | 固定名保存・配信・削除 | R06,D09 | 固定名上書きと世代不明削除 | 新方式対象は操作サービスへ委譲。asset有無にかかわらず現在の確定DB参照とowner/kind/tenantを照合して配信。旧固定名も根拠付きlegacyアセットへ移行。無関係な既存宣伝のlegacy経路は別契約として維持 | member/performance/extraと対応ルート | 所有者contextを渡す引数/ラッパを整備し、単純な固定名fallbackを残さない | 既存画像試験＋未確定legacy拒否 | S11 |
| `src/backend/services/member_service.py` | `create_member` 74-98、`update_member` 101-120、`update_member_profile` 136-173、`delete_member` 184-192 | R05,R06,R08 | 全体保存、固定名写真、DB確定前削除 | 行単位（S10）。写真はS11。`created_at` は更新対象外（識別用） | `routers/members.py`、`routers/system.py:71-79` | `members.created_at` 不変 | `test_auth_and_crud.py`、`test_system_permission_management.py` | S10,S11 |
| `src/backend/services/performance_service.py` | `create_performance` 124-155、`update_performance` 156-184、`delete_performance` 185-189 | R05,R06 | 同上（チラシ） | 同上。`performance_pieces` は親行ロック下で当該親の子だけ置換 | `routers/performances.py` | 子行IDは現行どおり再採番 | `test_db_mode_api_regression.py` | S10,S11 |
| `src/backend/services/album_service.py` | `upload_album_photo` 39-97、`delete_album_photo` 150-177 | R05,R06,N05,L08,L40 | 一覧保存、アルバム内連番ID、衝突する保存名、DB確定前削除 | アルバム行ロック下で写真行をDB採番INSERT/DELETE。保存名 `albums/{album}/{JST日付}/{uuid}_{name}` を `if_generation_match=0` で作成。削除はDB確定後 | `routers/albums.py:70-145` | 既存写真URL `/api/albums/{a}/photos/{id}` は既存IDで維持 | `test_album_photo_serving.py`、PG並行 | S12（S06後、Q09確認後） |
| `src/backend/routers/albums.py`、`routers/members.py`、`routers/performances.py` | 新方式対象の送信/削除と操作照会 | R05-A/B,R06 | 操作キーを渡さない経路 | 対象リクエストのIdempotency-Keyをサービスへ渡し、キーなし対象は428。認証付き `/api/portal-file-operations/{operation_id}` を既存登録済みrouterへ追加し、actor/tenantで照合する。既存の変更/閲覧認可を弱めない | 各サービス、対象UI | 無関係な通常APIの要求形式は維持 | 新規対象のPOST/PUT/DELETE再送・照会・失効権限 | S11 |
| `src/backend/auth_api.py` | `portal_login` 103-176、`set_member_password` 179-192、`get_auth_device` 195-236、`get_auth_devices` 239-255 | R08,N03,N04,N15 | naive時刻、会員一覧全体保存、全列UPSERT、文字列ソート | パスワード: `db_item_repository.update_columns("members", id, {"password":…}, where_password=旧値)`。ログイン: DB時刻で `authenticated_at/last_seen_at`。最終確認: `touch_auth_device`（`member_id` 一致時のみ、`last_seen_at = GREATEST(last_seen_at, clock_timestamp())`、`authenticated_at` は更新しない）。一覧は瞬間ソート | `main`（テストのパッチ面 `backend_api()`） | 応答キー不変。ローカルJSONモード経路は維持 | `test_auth_login_stability.py`、`test_auth_and_crud.py`、PG並行 | S08（S06後） |
| `src/backend/auth_helpers.py` | `member_access_expired` 86-95 | R04 | サーバー現地日付 | `jst_today()` と厳密日付解析で比較（`access_until < today` の現行規則維持） | `auth_service.device_auth_record` 155、`auth_api.py:118,215` | JST 0〜9時の失効タイミングが是正 | 新単体（境界） | S08 |
| `src/backend/services/auth_session_fallback.py` | `_now` 12-13、`remember_auth_device` 23-37、`fallback_auth_device` 46-58、`list_fallback_auth_devices` 61-72 | R08 | naive現地時計で寿命判定 | 寿命は `time.monotonic()`、`last_seen_at` 表示値は `format_instant(jst_now())`。8時間は維持 | `auth_api.py`、`auth_service.py:137-145` | 寿命不変 | `test_auth_login_stability.py` | S08 |
| `src/backend/routers/access_logs.py` | `create_access_log` 21-54、`list_access_logs` 57-83 | R04,L06 | naive生成、naive検索境界をDBへ | 生成はDB `clock_timestamp()`（INSERTで省略しDB既定ではなく明示関数）。検索: `date_from/date_to` はaware必須（naive→422）、`date_from >= date_to` は422。新パラメータ `from_date/to_date`（`YYYY-MM-DD`、JST暦日、終端排他）を追加 | `access_logs.js`、`diagnostics.js:42-44` | 旧画面の `toISOString()`（aware）は引き続き受理 | `test_access_logs_api.py`、`test_access_log_repository.py` | S07（S01後） |
| `src/backend/repositories/access_log_repository.py` | `insert_access_log` 18-54、`query_access_logs` 57-131 | R04 | — | `accessed_at/created_at/updated_at` を `clock_timestamp()`、`RETURNING` で確定値。`db_row_to_json(..., "access_logs")` | 上記 | — | 同上 | S07 |
| `src/backend/services/access_log_service.py` | `_access_log_sort_key` 7-15、`search_access_logs` 56-100 | R04 | naiveを `timestamp()`（現地TZ）で数値化 | 厳密解析、naiveは末尾扱い（ローカルJSONモードのみ） | ローカルモード | — | 単体 | S07 |
| `src/backend/services/event_service.py`、`repositories/event_repository.py` | `create_event` 22-32、`update_event` 35-36 | R04,R05,N02 | 一覧保存、deadline消失 | `BaseRepository` 経由で行単位。`update_event` の `deadline` は「日付文字列 or 空」を厳密検証。DB現在値が不明形式で要求が空なら現在値維持（6.4節） | `routers/events.py` | 応答の `deadline` が日付文字列に変わる | `test_event_album_permissions.py`、新規 | S05,S10 |
| `src/backend/routers/scores.py` | `_sort_pdf_editor_files` 28-29、`_list_pdf_editor_files` 32-104 | R02,L15 | mtime naive、文字列ソート | `format_instant(datetime.fromtimestamp(st_mtime, tz=timezone.utc))`、GCS `blob.updated` も `format_instant`。瞬間でソート | PDF編集画面 | 表記変化 | 新単体 | S09 |
| `src/backend/services/recording_asset_service.py` | `remember_recording_duration` 53-86、`local_recording_metadata` 89-115、`remember_drive_file` 142-159、`forget_drive_file` 162-172 | R02,R05,L14,L15 | naive、一覧保存 | aware生成。一覧保存は `mutate_collection_locked`（`drive_files`/`recording_metadata`） | `routers/recordings.py` | 500件上限の切詰め規則は維持 | `test_recording_resumable_upload.py` | S09（S07後） |
| `src/backend/drive_storage.py` | 251, 301 | R02,L15 | `blob.updated.isoformat()`、欠落時naive | `format_instant` | 録音アップロード | 表記変化 | 単体 | S09 |
| `src/backend/services/recording_upload_service.py` | 28, 123 | R04,L41 | サーバー現地日付の既定ディレクトリ | `jst_today()` | 録音アップロード | 新規分のみ | 単体 | S09 |
| `src/backend/core/startup.py` | seed_connection_settings_from_legacy_env | R02,R05 | 起動時の一覧保存 | `collection:connection_settings` 共通DBロック取得後に同一接続で再読込し、未設定分だけ補う。通常の行単位更新/削除/登録も同キーへ参加。既存値を古いシードで戻さない | 起動処理、新リポジトリ | allow_bulkはこの保護経路内だけ。ロックのない迂回禁止 | 起動シード対通常更新/登録のPG並行試験 | S09（S07後） |
| `scripts/migrate_base64_images.py`、`tests/scripts/test_migrate_base64_images.py` | `store_data_image` 直接呼出し 60、`save_json_data` による一覧保存 79 | R05,R06,F02 | 固定名画像保存と一覧全体保存に依存。行単位ガード・アセット化後は動作しない | 対象（会員写真・チラシ・団体アイコン等）ごとに、内部migration actorの操作として `portal_file_asset_service` でstaged→アップロード→確定し、所有行の参照列/URLは `db_item_repository.update_columns`（期待値一致条件付き）で更新する。既定ドライラン、`--execute` で適用、旧値不一致は停止。無保護な `save_json_data` と固定名保存を残さない | 運用時の手動実行 | 既存のCLI引数・既定ドライランの性質は維持。出力の保存先URL形式は新方式へ変わる | 既存試験を新方式へ書換え＋PG/隔離GCS | S11と同時（S16後） |
| `src/backend/services/meta_service.py` 70、`maintenance_service.py` 41、`calendar_service.py` 8、`system_service.py` 170 | 診断日時 | R02,L16 | naive/UTC混在 | `format_instant(jst_now())` | 管理画面診断 | 表記変化 | `test_system_readiness_summary.py` 等 | S09 |
| `src/backend/repositories/system_repository.py` 84,163,195、`improvement_suggestion_repository.py` 22-24、`portal_notice_repository.py`（同型の `isoformat`） | 出力 | R02,L09,L10 | 接続TZのオフセット | `format_instant` | 管理画面・お知らせ | 表記変化 | `test_portal_notices.py`、`test_improvement_suggestions_contract.py` | S09 |
| `src/backend/services/notification_service.py` | `emit` 105-138 | N11 | 表記依存のイベントID | `version` が瞬間文字列なら `format_instant(parse_instant())` で正規化してハッシュ（解析不能時は原文） | 各service | 反映直後の同一版再emitのみ影響 | `test_notifications.py` | S09 |
| `src/backend/core/db_runtime.py` | `ensure_db_schema_compatibility` 73-136 | R05 | — | **変更しない**（列型・TimeZone変更なし）。新規表はマイグレーションで作成 | — | — | `test_startup_schema_compatibility_policy.py` | — |

### 4.2 既存ファイル（フロントエンド）

| ファイル | 対象・行 | 仕様ID | 現状と問題点 | 変更内容 | 呼出元 | 互換性 | テスト | 順序 |
|---|---|---|---|---|---|---|---|---|
| `src/static/js/utils/runtime_context.js` | `today` 35-41 | R04 | 端末現地日付 | `portalRuntimeContext.jst = { parts(ms), dateKey(ms), now() }` を追加（UTC+9算術）。`today()` は `jst.dateKey(Date.now())` | 36箇所（20ファイル）の `today()` | 公開名維持。読込み順不変（`index.html:1339`） | 新 `test_jst_runtime_context.test.js`（本番ファイルをVM読込） | S04 |
| `src/static/js/modules/common_helpers/pure.js` | `formatDateWithWeekday` 68、`formatDateTimeLabel` 69、`daysUntil` 70、`isValidPerformanceDate` 72、`nextAllDayDate` 36、`addHoursToTime` 34 | R03,D02 | UTC日付＋現地時刻、ミリ秒差/86400000、現地Date | `parsePortalInstantMs(value)`（オフセット必須、naiveはNaN）、`formatDateTimeLabel`（JST、空→「未記録」、不正→「日時不明」）、`formatDateWithWeekday`（`Date.UTC` で曜日、不正→「日付不明」）、`daysUntil`（暦日番号差）、`nextAllDayDate`/`addHoursToTime`（暦・分算術）、`portalJstDateBoundaryIso(date, exclusiveEnd)`、`comparePortalInstantDesc(a,b)` を追加 | 全画面 | 関数名・引数維持 | 新 `test_jst_pure_helpers.test.js`（本番 `pure.js` をVM＋子プロセスTZ=Asia/Tokyo/UTC/America/New_York） | S04（実装は独立可、公開は9.2節の条件） |
| `src/static/js/modules/admin_system/access_logs.js` | `accessLogDateBoundary` 37-44、`loadAccessLogs` 123-146 | R04 | 端末現地0時 | `from_date/to_date`（`YYYY-MM-DD`）を送信。開始>終了は画面で警告 | `navigation/routes.js`（遅延読込） | 旧APIパラメータも残す | `test_access_log_search_pagination.test.js` 更新 | S07後 |
| `src/static/js/modules/admin_system/diagnostics.js` | 48-50,70,166 | R03 | `Date.parse` ソート | 共通比較関数 | — | — | 既存 | S04 |
| `src/static/js/modules/albums.js` 12、`notices.js` 48、`date_piece_promotion/helpers.js` 10、`date_piece_promotion/render_desired_promotion.js` 63 | ソート | R03,N15 | 文字列比較 | `comparePortalInstantDesc`（不正値は末尾、同値はid） | — | 並び順の是正 | 各モジュール試験 | S04 |
| `src/static/js/modules/improvement_suggestions.js` | `formatDateTime` 147-152 | R03 | `toLocaleString('ja-JP')`（端末TZ） | 共通 `formatDateTimeLabel` 相当（JST）。`responded_at` は日付表示 | 研究室モジュール（チューナー起動タグを含む） | **チューナー起動URLタグを含むため `check:tuner-release` 必須** | `test_improvement_suggestions_contract.test.js` | S04 |
| `src/static/js/modules/scores/sync.js` | `time` 55-58 | R03 | 端末現地 | JST `HH:mm:ss` | 楽譜同期表示 | — | `test_sheet_library_sync.test.js` | S04 |
| `src/static/js/utils/calendar.js` | `portalIsoDate` 1-3 | R03 | `toISOString().slice(0,10)`（UTC日付） | 日付文字列はそのまま、瞬間はJST日付 | 呼出元なし【事実：grep 0件】→ 互換のため実装のみ修正 | — | 単体 | S04 |
| `src/static/js/modules/events.js` 17,42、`members/events.js` 64 | 回答期限 | R04,N02 | 日時文字列を日付入力へ代入 | APIが日付文字列を返すため代入はそのまま。防御として `YYYY-MM-DD` 以外は空にせず警告表示し、未変更時は送信しない（`deadline_unchanged`） | — | — | 新規 | S05 |
| `src/static/js/utils/cache.js` | `init` 12-31、`getEntry` 33-63、`set` 72-82 | R09 | 形式版なし | エントリに `format: PORTAL_CACHE_FORMAT_VERSION` を保存。不一致・欠落は既存 `invalid: true` 経路で破棄。**IndexedDBのDBバージョン1は上げない**（blocked/versionchange回避） | `api_runtime.js`、`bootstrap_loader.js:85-110` | 旧タブは形式を見ないため新形式も読める（表示は旧関数） | `test_bootstrap_swr.test.js` 拡張 | S04 |
| `src/static/js/modules/common_helpers/api_runtime.js` | `request` 319-395、`hasFreshCacheEntry` 267-281 | R09 | 304で旧形式を再利用 | 形式版不一致のキャッシュは `If-None-Match` を送らない。開始時の形式版で書込み | — | — | `test_fetch_transport_paths.test.js` | S04 |
| `src/static/js/modules/common_helpers/bootstrap_init.js` | `visibilitychange` 152-156 | R04 | 復帰時に当日再評価なし | 復帰・`pageshow`・`online` 時に `jst.dateKey` が前回描画日と異なれば日付依存ビュー（ホーム、予定、出欠リマインド、会費）を再描画 | — | — | 新規（fake timers） | S04 |
| `src/static/js/modules/payments.js` | `addMonths` 305-311、`paymentAlertInfo` 313-360 | R03 | 現地Date `setMonth`（月末繰越） | 規則は変更しない。内部を `Date.UTC` へ置換し同じ繰越結果を保つ（固定テストで確認） | — | 業務規則不変 | `test_payment_*` | S04 |
| `src/static/js/modules/tuner/view_history.js` | `date` 56-58、`filters` 252-258、548 | R03,R04,D10 | 端末TZ表示、終端23:59:59、UTC日付 | 自己完結のJST表示関数。`f.before = 翌日00:00+09:00`（`to` は送らない）、整備ログ既定日付はJST | チューナー内部 | **`generate:tuner-release` 必須** | `test_tuner_history_restore.test.js` 等 | S13 |
| `src/static/js/modules/tuner/storage_local.js` | `listSessions` 482-495 | R04 | `startedAt <= to` | `before`（排他）を追加。`to` は既存呼出元互換で残す | view_history | 同上 | `test_tuner_storage_local.test.js` | S13 |
| `src/static/js/modules/tuner/view_diagnosis.js` 234 | 表示 | R03 | 端末TZ日付 | JST日付 | — | 同上 | `test_tuner_trainer_diagnosis.test.js` | S13 |
| `src/static/js/modules/metronome/view_analysis.js` 135 | 校正日表示 | R03 | UTC日付 | JST日付 | — | **`generate:metronome-release` 必須** | `test_metronome_*` | S13 |
| `src/static/js/testable/formatting.js` 71 | テスト用コピー | R09 | UTC日付既定 | 本番と同じ規則へ追従（主試験は本番ファイルで行う） | `frontend_testable_logic.js` | 本番非読込【事実：`index.html` に無し】 | `frontend_logic.test.js` | S04 |
| `modules/date_piece_promotion/api.js`、`modules/members/api.js`、`modules/portal_views.js`、`modules/performances.js`、`modules/admin_system/api.js`、新 `utils/portal_file_operations.js` | 対象ファイルの作成/置換/削除・所有行削除 | R05-A/B,R06 | 操作キーなし | 一回の意図した操作に同じUUIDを保持し、結果不明は同じキーで照会/再送。対象フォーム・削除呼出元へ接続し、actor/tenantをまたいで保留結果を流用しない | 各送信/削除ルート、index.htmlの読込順 | 新方式の旧要求428。新IDでの自動再作成禁止 | POST再送、削除後再送、別内容、DB不能、再ログインのフロント試験 | S11 |
| `src/index.html` | script読込み・版 | R09,R05-A | 操作helper未導入 | 新portal_file_operations helperを呼出元より前に追加し、変更ファイルの?vを更新 | 既存遅延ロードも確認 | 公開関数と順序を維持 | load-order/state-access | S04/S11/S13 |

### 4.3 新規ファイル案（既存ファイルと区別）

| 新規ファイル | 責務 | 仕様ID | 主な関数・内容 | 依存 | テスト |
|---|---|---|---|---|---|
| `src/backend/repositories/db_item_repository.py` | 行単位の登録・更新・削除、ロック、競合、DB時刻更新版、子行置換 | R05,R07 | 5.3節 | `db_row_repository`、`db_schema`、`tenant_context`、`db_pool` | `tests/backend/test_db_item_repository.py`（モック）、`tests/backend/test_db_item_repository_postgres.py`（`PORTAL_TEST_DB_URL` 任意実行、CIのpostgresサービスへ追加） |
| `src/backend/services/portal_file_asset_service.py` | 操作照合・準備・アップロード・同一TX確定・配信・回収 | R05-A/B,R06/R06-A | 6.5節。既存専用APIの機構は重複変更しない | 新操作/アセット表、db_item_repositoryの既存TX受入れ | `test_portal_file_assets.py`、`test_portal_file_operations_postgres.py` |
| `db/migrations/022_portal_file_assets.sql` | `portal_file_operations`、`portal_file_assets`、索引・同一テナントFK・active所有参照 | R05-A/B,R06 | 6.5節。操作表を含む追加のみのexpand。022は実装開始時に空き番号を再確認 | — | 旧コード互換・制約・テナント移行チェック |
| `scripts/audit_datetime_values.py` | 読取専用の旧値照合（第10章 Q01〜Q16） | R10 | 既定は読取のみ。結果は件数・匿名化キーのみ出力（実データ値・氏名を出さない） | — | 単体（SQL生成のみ） |
| `scripts/migrate_reference_assets.py` | 根拠付きマニフェストから旧参考楽譜・共通画像の参照を固定 | R06,R10 | 既定ドライラン。件数だけで自動確定しない。旧DB値・キー・世代・根拠が一致した対象だけ適用。不明/共有対象は停止して対応確定 | 新表 | 単一未確定候補の拒否、複数候補、共有、旧値不一致 |
| `scripts/cleanup_portal_file_assets.py` | 新アセットの回収（既存 `cleanup_promotion_images.py` と同じCLI作法） | R06-A | `--organization` 必須、既定ドライラン | 新サービス | 単体 |
| `src/static/js/utils/portal_file_operations.js` | 新規ファイル変更操作のID保持・同一ID再送・状態照会 | R05-A/B | actor/tenant/対象/内容ごとの操作IDを保持。結果不明で新IDを自動発行しない | 既存API runtime、index.htmlの読込順 | 新フロント試験 |
| `scripts/manage_datetime_maintenance.py` | 今回用の停止・drain確認・新リビジョン解除・条件付き復旧 | R11 | 9.3節。既存宣伝リセット専用ツールと分離し、安全条件を維持 | production_maintenance、Cloud Run CLI、状態ファイル | 新 `test_datetime_maintenance_plan.py`（CLI/状態の模擬試験）、TESTで別途検証 |
| `tests/frontend/test_jst_pure_helpers.test.js`、`test_jst_runtime_context.test.js` | 本番読込みファイルのJST試験 | R03,R04,T01〜T03 | 子プロセスで `TZ` を切替え | — | — |
| `tests/backend/test_datetime_utils.py`、`test_concurrency_instant.py`、`test_db_row_codecs.py`、`test_events_deadline_codec.py` | 共通処理試験 | R02,T04 | — | — | — |

---

## 5. 共通処理とAPIの変更設計

### 5.1 バックエンド共通処理（`src/backend/utils/datetime_utils.py` 拡張）

既存の公開名 `next_updated_at` を維持し、以下を追加する。DB非依存の純関数のみとし、DB時刻は repositories 側に置く。

```python
JST = timezone(timedelta(hours=9), "JST")          # 固定オフセット（D-01）。日本は1951年以降夏時間なし
API_DATETIME_FORMAT_VERSION = "jst-us-1"           # ETag・端末キャッシュの表現版
MAX_FUTURE_VERSION_SKEW = timedelta(seconds=5)     # R07 設計値（Q05/Q07で検証）

class InvalidDateTimeValue(ValueError): field: str; reason: str   # 値そのものはメッセージに含めない
class FutureVersionAnomaly(RuntimeError): table: str; item_id: Any

def utc_now() -> datetime                     # aware UTC（アプリ時計。診断用途のみ）
def jst_now() -> datetime                     # aware JST
def jst_today() -> date
def parse_instant(value: str | datetime, *, field: str) -> datetime
    # 受理: YYYY-MM-DDTHH:MM[:SS[.f{1,6}]](Z|±HH:MM)。小数7桁以上・naive・NaN/Infinity・数値は拒否
    # 3.10の fromisoformat 非対応表記（Z、1/2/4/5桁小数）は正規表現で分解して datetime を組み立てる
def format_instant(value: datetime) -> str    # naiveは InvalidDateTimeValue。astimezone(JST).isoformat(timespec="microseconds")
def same_instant(a: datetime, b: datetime) -> bool   # aware同士のµs一致
def parse_calendar_date(value: str, *, field: str) -> date        # YYYY-MM-DD 厳密、存在しない日を拒否
def parse_year_month(value: str, *, field: str) -> str            # YYYY-MM 厳密
def jst_day_start(value: date) -> datetime                        # その日の00:00+09:00
def jst_date_range(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]
    # (開始日00:00+09:00, 終了日翌日00:00+09:00)。開始>終了は InvalidDateTimeValue
def parse_legacy_naive_instant(value: str, *, assumed: tzinfo, codec: str) -> datetime
    # 確定したcodecからだけ呼ぶ。呼出元は台帳のcodec名と一致させる（現時点で本番経路の呼出しなし）
def next_updated_at(previous: Any = None) -> str
    # ローカルJSONモード専用。jst_now() と 前回+1µs の大きい方。前回がnaiveなら比較に使わない。
    # 前回 > 現在+5秒 は FutureVersionAnomaly。戻り値は format_instant 形式
```

エラー契約:
- 通常業務APIへの新規入力で `InvalidDateTimeValue` → 422（`detail` は項目名と理由のみ）。
- DB・保存側の必須日時が不正 → 500 `{"detail": {"code": "datetime_value_invalid", "message": "保存データの日時を確認できません"}}`、ログにテーブル名・ID・項目名（値は出さない）。
- `FutureVersionAnomaly` → 409ではなく503 `{"code": "version_clock_anomaly", "message": "保存できませんでした。管理者に連絡してください"}`。管理者向けログに表・ID・前回値・DB現在値（機密でない時刻のみ）。

### 5.2 DB変換（`db_row_repository.py`）

| 関数 | 変更後の入出力 |
|---|---|
| `db_json_value(value)` | aware `datetime` → `format_instant`。naive `datetime`（TIMESTAMP WITHOUT TIME ZONE列、現状なし）→ 従来の `isoformat()`（時間帯を推測しない）。`date`/`time`/`Decimal` は不変 |
| `db_row_to_json(row, table_name=None)` | `table_name` 指定時、`DATE_ENCODED_TIMESTAMP_COLUMNS` は `decode_utc_midnight_date(value)`（UTC 00:00:00.000000 のときだけ `YYYY-MM-DD`、それ以外は `""` とし警告ログ）。既存呼出し（引数なし）は従来どおり汎用変換 |
| `parse_db_timestamp(value)` | aware文字列/aware datetime → `format_instant`。日付のみ（`YYYY-MM-DD`）→ `YYYY-MM-DDT00:00:00+00:00`（`events.deadline` の旧規則を明示codecとして残す）。naive → `InvalidDateTimeValue`。空 → `None` |
| `db_write_value(table, column, value)` | `created_at/updated_at` を全表でtimestamp扱い。`events.deadline` は `encode_utc_midnight_date(parse_calendar_date(value))`。他の日付列は新規入力経路では厳密、既存DB値の再書込み経路では従来の `parse_db_date` |

### 5.3 行単位リポジトリ（新規 `db_item_repository.py`）

```python
@contextmanager
def item_transaction(*, lock_timeout_ms=5000, statement_timeout_ms=15000)
    # autocommit=False。SET LOCAL lock_timeout / statement_timeout / idle_in_transaction_session_timeout

def insert_item(name: str, build: Callable[[Cursor, ItemContext], dict], *, group_keys: Sequence[str] = ()) -> dict
def update_item(name: str, item_id: int, mutate: Callable[[dict, ItemContext], dict], *,
                expected_updated_at: str | None, group_keys: Sequence[str] = ()) -> dict
def update_columns(name: str, item_id: int, values: dict, *, where: dict | None = None) -> dict | None
def delete_item(name: str, item_id: int, authorize: Callable[[dict], None], *,
                expected_updated_at: str | None = None, group_keys: Sequence[str] = ()) -> dict
def lock_groups(cur, name: str, group_keys: Sequence[str]) -> None
    # pg_advisory_xact_lock(hashtextextended('portal:'||org||':'||name||':'||key, 0)) をキー昇順で取得
```

ファイル操作の確定では、外側TXが操作記録・対象行・アセットを同時に確定する。`insert/update/delete_item` に既存の `ItemContext` を渡せる経路を用意し、その場合は内部で別接続・独立COMMITを行わない。外側なしの通常呼出しだけ自分でTXを管理する。

処理順（`update_item`）:
1. `item_transaction()` 開始、`lock_groups`（キー昇順）。
2. `SELECT * FROM t WHERE organization_id=%s AND id=%s FOR UPDATE` → 無ければ404（既存の `find_item` と同じ `detail`）。子表を同一接続で読み、親JSONを組立て（`db_row_to_json(…, table_name)`）。
3. `SELECT clock_timestamp()`（**ロック取得後**の時刻）。`current.updated_at > db_now + 5秒` → `FutureVersionAnomaly`。
4. `expected_updated_at` が非空なら `parse_instant` して `same_instant(current.updated_at, expected)`、不一致409（`detail` は既存文言 "Data has been updated by another user" を維持）。naive→409（再読込）、不正→422。
5. `mutate(current, ctx)`（権限確認・検証・正規化。外部I/O禁止）。HTTPExceptionはロールバック。
6. `UPDATE t SET <id/created_at/organization_id 以外> , updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond') WHERE organization_id=%s AND id=%s RETURNING *`。
7. 子表: 当該親IDの子だけ `DELETE … WHERE organization_id=%s AND parent=%s` → INSERT（既存子行の `created_at`・投票の `voted_at` はキー照合で保持、新規はDB時刻、`updated_at` は親の新値）。
8. COMMIT。返却値はRETURNINGと再読込した子から生成（クライアント値を返さない）。
9. 呼出元はcommit後にメモリーキャッシュ無効化・通知 `emit`（DBロールバック扱いにしない）。

`insert_item`: advisory lock `('portal:id:'||table)` 下で `COALESCE(MAX(id),0)+1`（全テナント横断、既存 `db_next_id` と同じ）を採番し、シーケンスがあれば `setval` で追従（N19）。`created_at = updated_at = clock_timestamp()`。
`delete_item`: 行ロック→`authorize`→（任意）版比較→子行削除→親削除→COMMIT→削除行を返す（ファイル回収候補はS11で同一トランザクションに記録）。
デッドロック（SQLSTATE `40P01`）・直列化失敗（`40001`）のみ、DB処理全体を最大2回再試行（外部I/O・通知を含めない）。`lock_timeout`（`55P03`）は再試行せず503 `{"code":"save_busy"}`。

### 5.4 フロントエンド共通処理

`runtime_context.js`（`pure.js` より先に読込まれる）:
```js
jst: {
  parts(ms)   // {year, month, day, hour, minute, second, weekday} を new Date(ms + 9h) の getUTC* から算出
  dateKey(ms) // 'YYYY-MM-DD'
  now()       // Date.now()
}
today: () => jst.dateKey(Date.now())
```
`pure.js`:
- `parsePortalInstantMs(value)`: `/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/` を検証し `Date.UTC` で算出。naive・不正はNaN。表示専用（ミリ秒へ丸めた値を競合・識別に使わない）。
- `formatDateTimeLabel(value)`: 空→「未記録」、NaN→「日時不明」、それ以外→`YYYY/MM/DD（曜）HH:mm`（現行の表記・秒非表示を維持）。
- `formatDateWithWeekday(dateText, fallback='未定')`: 空→fallback、`YYYY-MM-DD` 以外→「日付不明」、曜日は `new Date(Date.UTC(y,m-1,d)).getUTCDay()`。
- `daysUntil(dateText)`: `(Date.UTC(target) - Date.UTC(today)) / 86400000`（整数）。
- `portalJstDateBoundaryIso(dateText, exclusiveEnd=false)`: `'YYYY-MM-DDT00:00:00+09:00'`（終端は翌日）。
- `comparePortalInstantDesc(a, b)`: 瞬間降順、NaNは末尾、同値は `id` 降順。

チューナー/メトロノームはポータルのグローバルに依存させず、各モジュール内に同等の小関数を置く（既存 `intonation_profile.js:263` と同じ+9h算術）。

### 5.5 API契約の変更一覧

| API | 変更 | 互換性 |
|---|---|---|
| 通常業務API全般（`/api/performances`、`/api/schedules`、`/api/announcements`、`/api/events`、`/api/members`、`/api/extra/{name}`（宣伝除く）、`/api/bootstrap*`、`/api/auth/devices*`、`/api/system/access-logs`、`/api/notices`、`/api/improvement-suggestions`、診断） | 瞬間項目を `…ffffff+09:00` へ統一 | 値の瞬間は不変。ETag表現版で再取得 |
| `PUT /api/extra/{name}/{id}` | `expected_updated_at` を瞬間比較。naive→409、不正→422 | 省略可否は現状維持（省略時は版確認なし、ただし他行は壊さない） |
| `/api/events` | `deadline` を `YYYY-MM-DD` で返却。入力も厳密 | 旧画面は日時文字列を受け取っていた→新形式で編集時の消失が解消 |
| `GET /api/system/access-logs` | `from_date`/`to_date` 追加。`date_from`/`date_to` はaware必須、開始≧終了は422 | 旧画面（`toISOString()`）は受理 |
| `GET /api/extra/desired_pieces/{id}/reference_score` | `?asset=<uuid>` で版固定配信（`Cache-Control: private, max-age=3600` 可）。asset無しは現在の確定アセットを `no-cache` で配信 | 旧URL互換 |
| 共通画像ルート（`/api/members/{id}/photo` 等） | asset有無とも確定DB参照を照合。`?asset=`は版固定、旧URLは現在参照から解決 | 旧固定名をDB参照なしで読むfallbackは設けない。必要な移行完了を公開条件にする |
| 新規ファイル対象の作成/置換/削除API | Idempotency-Key必須、未対応旧要求428。新規操作照会APIを追加 | 対象UI/ルートをS11で同時変更。通常非ファイルAPIは一括変更しない |
| 宣伝・楽譜・チューナー・メトロノーム | **変更なし** | — |

---

## 6. DB・並行更新・ファイル処理の設計

### 6.1 トランザクション境界

- 比較・認可に必要な現在値確認・更新版生成・保存を同一トランザクションで行う（5.3節）。
- 外部I/O（GCSアップロード・YouTubeメタデータ取得 `extra_service.py:233`）はトランザクション外で先に行い、確定トランザクションで再検証する。YouTube取得はロック前に実施し、確定時は取得済みの正規化値を使う。
- 通知 `emit` はcommit後（既存 `promotion_service.py:236-239` と同じ規則）。

### 6.2 ロック対象・順序・待機時間

| 順位 | ロック | 対象 |
|---|---|---|
| 0 | 操作行（新規ファイル方式のみ） | テナント・actor世代・操作IDを一意に予約/照合。同じ操作の終端結果は対象確認より先に返す |
| 1 | advisory xact lock（キー文字列昇順） | `id採番:<table>`、グループロック、`collection:<name>`。混在する `recording_metadata` と `connection_settings` は登録・更新・削除・起動シード・一覧保存の全経路が同一キーを取得 |
| 2 | 親行 `FOR UPDATE`（ID昇順） | 対象行。演奏会記録動画の再採番はグループ内全行をID昇順で |
| 3 | 子行・アセット | 子は親ロックで直列化。新アセット/旧アセットはID順で取得し、操作行→collection/group→対象行→アセットの順に統一 |

- `lock_timeout=5s`、`statement_timeout=15s`、`idle_in_transaction_session_timeout=30s`（`SET LOCAL`）。数値は設計値で、TESTの並行試験で調整（U08）。
- 既存の宣伝・楽譜はそれぞれの順序を維持し、新規コードから宣伝・楽譜の行をロックしない。
- `members` の行ロックとチューナー所有者（`tuner_owners` の `FOR UPDATE`、`tuner_repository.py:73-80`）は別トランザクションで、同時保持しない。

### 6.3 行単位保存と一覧保存の区分

| 区分 | 対象 | 方式 |
|---|---|---|
| 行単位へ変更 | `BaseRepository` 経由: `events`、`members`、`schedules`、`announcements`、`performances`（+`performance_pieces`）、`payments`（+`payment_performance_fees`）、`albums`（+`album_photos`）、`recording_metadata`（Repository経由分）。汎用extra: `absences`、`event_responses`、`date_adjustments`（+候補）、`date_adjustment_responses`、`castings`（+members/extras）、`piece_infos`、`practice_instructions`、`performance_day_infos`、`concert_record_videos`（グループロック）、`part_settings`、`venue_settings`、`flyer_distributions`、`flyer_distribution_assignments`、`org_settings`、`sns_settings`、`connection_settings`、`desired_pieces`（+votes）。認証: `members` パスワード部分更新、`auth_devices` ログイン/最終確認 | 5.3節。`ROW_LEVEL_COLLECTIONS` に登録し、DBモードの `replace_collection` はガードで拒否 |
| 一覧保存を残す（保護付き） | drive_files、recording_metadata（一部）、connection_settings（起動時シード）、production_operation_histories、ローカルJSONのaccess_logs | `mutate_collection_locked`: collectionロック→同一接続でDB再読込→mutator→保存→commit。`recording_metadata` と `connection_settings` は行単位経路も同じキーへ参加。ROW_LEVEL_COLLECTIONSガードは通常一覧保存を拒否し、保護済み専用経路内だけ限定的なallow_bulkを許可。任意呼出元の迂回は禁止 |
| 既存専用（変更なし） | `promotions`、`sheet_library`、チューナー、メトロノーム、通知、改善要望、お知らせ | 既存実装 |

### 6.4 対象不存在・版不一致・events.deadline の規則

- 不存在404（既存 `find_item` の文言）、版不一致409（既存文言）、権限403（既存文言）、入力不正422。削除済み対象への更新でINSERT/UPSERTしない（`UPDATE … WHERE` のみ）。
- `events.deadline`（D-03推奨）: 書込みは日付→UTC 00:00（現行と同じ）。読込みはUTC 00:00のとき日付、それ以外は `""`。更新時、要求の `deadline` が空でDB現在値が不明形式なら現在値を保持し、ログに記録（無言消去を防ぐ）。明示削除は画面の「期限なし」操作で `deadline: null` を送る形にするか（U05）。Q04で不明形式0件を確認できれば防御分岐のみ。

### 6.5 ファイル（参考楽譜・共通画像）

**今回導入する表（022、追加のみ）**:

- `portal_file_operations`: `(organization_id, actor_key, operation_id)` 複合主キー。`operation_id UUID` はクライアントが一回の意図した操作ごとに生成し、再送で維持。`kind/method/target_id`、`request_hash/hash_version`、`state`（processing/succeeded/rejected）、`attempt_id`、`lease_until`、`result_status/result_body`、`created_at/updated_at/result_expires_at` を保持。日時はTIMESTAMPTZ、DB時計。結果は公開payloadだけとし、パスワード・秘密値・ファイル本体を保存しない。
- `portal_file_assets`: `asset_id UUID PK`、`organization_id`、`actor_key/operation_id/attempt_id`、`kind`（参考楽譜/会員写真/チラシ/団体アイコン）、`owner_id`、一意の `object_name`、`source/filename/content_type/byte_size/sha256/storage_generation`、`state`（staged/active/retired/delete_pending/deleted）、`legacy`、作成/退役/削除/照合/再試行日時、回収回数/エラーコード。操作とのFKは同一テナント・actor・operationに結び付ける。各アセットの旧attempt_idは履歴として保持し、操作行の現在attempt_idと混同しない。
- **実装時の選択**: 仕様R06が認める専用参照表方式を採用する。所有表への4つのUUID列追加案に代えて、`portal_file_assets` の `state='active'` 行を確定参照とし、`(organization_id, kind, owner_id)` の部分一意索引で所有者・種類ごとに1件へ制約する。操作との同一テナントFKを持ち、確定・配信・回収は必ずtenant/kind/ownerを照合する。所有行の公開URLとactive参照の変更は同じ接続・同じTXで行う。既存表のDDL変更を抑え、参照列と参照表の二重管理を避けるための選択であり、R05/R06の原子性・テナント境界・確定参照のみの配信要件は変更しない。

旧参照の移行は利用者要求の偽装でなく、専用migration actor/runの内部操作として監査記録と参照を残す。新操作表とのFKを満たす親記録を作り、利用者の再送/照会からその内部操作へアクセスさせない。

**クライアントとAPI**:

- 参考楽譜・共通画像の作成/置換/削除、および確定アセットを持つ所有レコードの削除を新方式の対象とする。無関係な通常APIへ一括でキーを必須化しない。
- 対象リクエストは `Idempotency-Key: <UUID>` を必須とする。未対応旧画面は428と再読込案内を返し、サーバーで毎回別IDを作って代替しない。POSTにも同じキーでの再送を保証する。
- 新 `utils/portal_file_operations.js` と、`modules/date_piece_promotion/api.js`、`modules/members/api.js`、`modules/portal_views.js`、`modules/performances.js`、`modules/admin_system/api.js` 等の対象送信・削除呼出元を更新する。フォーム内容が同じ再送は同じID、利用者が意図して内容を変えた新操作は新ID。完了後に一覧を再取得する。
- 新規候補 `GET /api/portal-file-operations/{operation_id}` を認証付きで設ける。現在のテナント・actor世代・結果閲覧権限で絞る。元の添付や現在の対象存在を照会条件にしない。DB不能は503/保留であり404/未実行ではない。操作記録の正常照会で不存在なら既存の不明案内に準じる。
- クライアントの保留操作はtenant/actor世代単位で保持し、ログアウト後や別利用者へ結果を流用しない。元ファイルがなくても状態照会できる。DB不能や応答喪失で新IDを自動発行し直さない。

**処理順（R05-Bに統一）**:

1. セッション・テナント・actor世代、要求構文と指紋を確認する。操作行を予約/照合し、異内容は409、同内容の終端状態は現在の結果閲覧を認可して保存済み結果を返す。現在対象の存在/版/変更権限確認を先に置かない。
2. 新規/再開の実行権を得たattemptだけ現在対象・変更権限・期待版を確認する。ファイルなしの削除等も操作記録に終端結果を残す。確定的な拒否は当該attemptに限定して保存する。
3. アップロード前にstagedアセットと予定キーをDBへ記録してcommitする。leaseはDB時計で10分を設計値とし、期限切れ引継ぎは比較更新で新attemptを発行する。引継ぎ先は別アセットキーを使う。
4. `{kind}/{org}/{asset_id}.{ext}` 等のUUID一意キーへ外部保存する。GCSは `if_generation_match=0`、`timeout=60`、`Retry(deadline=120)`、ローカルは排他的作成。外部I/O中はDBロックを保持しない。
5. 一つの確定TXで、操作実行権→collection/group→対象行→アセットの順にロックし、現在の認証/権限/版/アセット状態を再確認する。同じ接続のdb_item_repositoryへ委譲し、業務変更・新参照・更新版・asset active・旧asset retired/回収候補・operation succeededと公開結果を同時確定する。確定的拒否も当該attemptだけが終端化する。一時障害をrejectedへ固定しない。
6. commit応答喪失時は新接続で操作記録を照合する。succeeded/rejectedなら保存結果、processing/照会不能なら処理中/503保留。asset activeだけから元の応答を推測しない。未確定候補を削除しない。同じキーで照会/再開へ収束させる。
7. 回収はcommit後に行う。参照・lease・配信保護を再確認してdelete_pendingへ確定してから、記録したキー/世代を限定削除する。削除失敗は保存成功を覆さず再回収する。

**状態と中断点**:

| 中断点 | 永続状態 | 回復 |
|---|---|---|
| 準備前 | 操作なし、またはprocessingのみ | 操作照会。実体作成前なので未追跡アップロードなし |
| 準備commit後・外部保存前 | processingとstaged、実体なし | 有効lease中は処理中。期限切れは安全に引継ぎ/回収 |
| アップロード応答喪失・成功後停止 | processingとstaged、実体あり/なし | 記録キー・世代を照合。旧試行をDBで失効させ、新試行へ引継ぎ。旧試行は確定不可 |
| 確定commitの応答喪失 | 終端結果またはprocessing | 新接続で操作記録を再照会。照会不能を失敗/未実行にしない |
| 競合・権限失効で拒否確定 | rejectedと自試行のstaged | 元の拒否結果を再送でも返し、自試行の未参照候補だけ回収 |
| 旧試行の遅延アップロード | 旧attemptの非active候補 | 新参照を触らず、削除済み記録も再照合して遅延実体を回収 |
| 旧アセット回収失敗 | retired/delete_pending | 参照・配信保護を再確認し指数バックオフで再実行 |

**旧ファイルの移行と配信**:

- 配信はDBに確定した参照だけを使用する。参照未設定の旧参考楽譜は候補が1件でも配信根拠とせず、移行要確認として扱う。候補のmtime順や件数で確定しない。
- 旧DBの参照値、対象tenant/owner、保存キー/世代、既知の確定操作等の根拠をマニフェストへ記録する。候補1件でも未確定の可能性があるため、根拠なしの自動移行は禁止。旧値一致を確認してlegacyアセットと参照を同時確定する。必要な対象が確定できるまで一般利用へ切替えない。
- asset無し旧URLも現在の確定参照から解決しno-cacheで返す。asset付きはkind/owner/tenantと世代を固定し、別アセットへ黙って差し替えない。共通画像の旧固定名も台帳へ確定してから参照する。
- 共有旧実体はQ10/Q11で検出し、全参照を保護できる管理方式を決めるまで回収/移行を停止する。単一テナント/ID prefixだけで非共有と断定しない。
- 配信開始TXでアセット行をロックし、`read_protected_until` をDB時刻+15分まで延長してから外部読取りへ進む。回収も同じ行をロックして期限を再確認する。退役時刻からの15分猶予とは独立し、退役・他の読取り終了/失敗で短縮しない。再試行120秒+最終要求タイムアウト60秒を上回る値として15分を採用し、I/O予算変更時は再評価する。候補選択後の配信開始、猶予終了境界、保護失効後の回収をローカル/PGで検証し、実GCSでの整合はTESTで確認する。
- 回収CLIは既定ドライラン。deleted記録は最低30日かつ遅延実体/未解決操作がないことを確認するまで保持し、一回のNotFoundだけで破棄しない。操作結果本文は30日を初期設計値とし、失効ID識別に必要な主体/ID/指紋/終端状態等の最小記録は保持する。保持終了の詳細はU08/U09で確定する。

### 6.6 操作同一性の台帳（R05-A）

| API | 操作ID | 再送保証 | 処理 |
|---|---|---|---|
| 宣伝 `/api/extra/promotions*` | Idempotency-Key（既存） | 既存どおり | 既存reserve/require_attempt/finishを維持 |
| 楽譜 `/api/sheets*` | 既存 | 既存どおり | 既存旧画面契約を維持 |
| チューナー/メトロノーム同期 | 既存 | 既存どおり | 同期API・ハッシュは維持 |
| 参考楽譜付き希望曲の登録/置換/削除 | Idempotency-Keyを今回導入 | 同じ内容のPOST/PUT/DELETE再送に元結果 | portal_file_operations、6.5節、R05-B順序。対象削除後も結果閲覧を認可して再送結果を返す |
| 会員写真・演奏会チラシ・団体アイコンの変更、確定参照を持つ所有行削除 | 同上 | 同上 | 対象送信/削除UI、ルート、サービスを同時更新。新方式のキーなし要求は428 |
| ファイル変更と無関係な通常業務API | なし（現状維持） | 新たに保証しない | 対象版と原子性の既存/新契約を適用 |

### 6.7 変更しない値・形式・処理

| 対象 | 理由 |
|---|---|
| `members.created_at` の瞬間、`promotion_service.actor` のUTC正規形 `member:{id}:{UTC iso}` | 宣伝/楽譜の操作記録キーとチューナー/メトロノーム所有者世代の識別（D12）。変えると再送照合不能・履歴失効 |
| チューナー/メトロノームAPIのUTC `Z` 出力、payload hash、epoch ms、`AudioContext.currentTime`、`performance.now`、スケジューラ | 同期・ハッシュ・音声計測契約（R08末尾） |
| ICS `DTSTAMP`（UTC）、`DTSTART;TZID=Asia/Tokyo`、終日 `VALUE=DATE` | 外部形式（R09） |
| 楽譜チケットの `expires_at`（`scores/save_dialog.js:267`）、署名URL寿命 | 外部/既存専用契約 |
| フォールバック認証の8時間寿命 | R08 |
| 既存のIndexedDB（ポータル `OrchestraAppCache` v1、チューナー/メトロノームの各DB） | 全消去・スキーマ変更をしない（R09） |
| DBのTimeZone設定、列型 | 3.1 |
| 楽譜の30日操作保持、15分/24時間猶予 | 既存契約 |

---

## 7. 依存関係付きの実装手順

各手順は「前提→変更→完了条件→検証」。10.5節の決定により、S00は環境判断・TEST反映の条件であり、ローカル実装の開始を妨げない。手順番号は依存順で、同じ段の手順は並行可。

```
S00 ─┬─ S01 ─┬─ S02 ─┬─ S05
     │       ├─ S03 ─┤
     │       │       └─ S06 ─┬─ S08
     │       │               ├─ S10 ─┬─ S07(ガード有効化)
     │       │               │       └─ S12
     │       ├─ S09          └─ S16 ─ S11 ─ S17
     └─ S04 ─ S13 ─ S14
S15(文書) は各手順と並行。S16-A(専用メンテナンス実装)はS18前、S19で実確認。S18〜S20は関連実装後
```

### S00 実装前の読取確認（TEST反映の開始条件）
- 実施者: 利用者（10.5節 F05）。ローカル実装は並行可。
- 対象: TEST（可能なら本番の読取専用ロール）。第10章 Q01〜Q16。
- 完了条件: Q01/Q02（接続TimeZone）、Q03（列精度）、Q04（deadline適合）、Q12（テナント数）、Q16（ID/シーケンス）の結果が記録されている。
- 検証: 結果を本計画書の付録として追記（実データ値・氏名は記載しない）。

### S01 共通日時処理（バックエンド）
- 対象: `src/backend/utils/datetime_utils.py`。
- 変更: 5.1節の関数を追加。`next_updated_at` をaware化。
- 入出力: 5.1節。
- 前提: なし。
- 完了条件: `test_datetime_utils.py` が Python 3.10 で合格（Z/±00:00/+09:00、1〜6桁小数、7桁拒否、naive拒否、存在しない日、うるう日、範囲の開始>終了、未来5秒境界±1µs）。`compileall`・`ruff` 合格。
- 検証: `uv run pytest tests/backend/test_datetime_utils.py`。Docker（python:3.10-slim）でも同試験（T01）。

### S02 DB変換codec
- 対象: `db_row_repository.py`（5.2節）、`db_schema.py`（定数追加）。
- 前提: S01。
- 完了条件: `db_row_to_json` が aware値を `+09:00` 6桁で返す。`events.deadline` codec が UTC 0時→日付、それ以外→空。`parse_db_timestamp` がnaiveを拒否。既存 `test_db_json_layer.py`・`test_json_db_response_parity.py` が（期待値更新のうえ）合格。
- 検証: 新 `test_db_row_codecs.py`、`test_events_deadline_codec.py`。

### S03 競合比較の瞬間化
- 対象: `utils/concurrency.py`。
- 前提: S01。
- 完了条件: 同瞬間の異表記を受理、µs差は409、naiveは409、不正は422、現在値不正は500。
- 検証: `test_concurrency_instant.py`。既存 `test_concert_record_videos.py` 合格。

### S04 フロントエンド共通表示・今日・キャッシュ形式版
- 対象: `runtime_context.js`、`pure.js`、`cache.js`、`api_runtime.js`、`bootstrap_init.js`、ソート4ファイル、`improvement_suggestions.js`、`scores/sync.js`、`utils/calendar.js`、`payments.js`、`testable/formatting.js`、`index.html` の `?v=`。
- 前提: 実装は独立可能。公開は9.2節に従い、旧naive値が日時不明になる影響を未評価のまま単独公開しない。
- 完了条件: 仕様R03表の4ケースが `TZ=Asia/Tokyo`/`UTC`/`America/New_York` の子プロセスで一致。`daysUntil`・`nextAllDayDate` が米国夏時間切替日でも暦日差。月末繰越が現行と同じ（固定テスト）。形式版不一致のIndexedDBエントリが破棄され `If-None-Match` を送らない。
- 検証: 新 `test_jst_pure_helpers.test.js`・`test_jst_runtime_context.test.js`、既存 `npm run test:frontend`、`check:frontend:syntax`、`check:frontend:load-order`、`check:frontend:state-access`、`check:tuner-release`（`improvement_suggestions.js` を変更するため）。

### S05 回答期限
- 対象: `db_row_repository.py`（codec、S02で実装済み）、`event_service.py`、`events.js`、`members/events.js`。
- 前提: S02、Q04。
- 完了条件: 作成→取得→編集画面表示→保存で同じ暦日（T07）。不明形式の既存値は空送信で消えない。
- 検証: 新 `test_events_deadline_roundtrip.py`（モック）、PG試験で往復。

### S06 行単位リポジトリ
- 対象: 新規 `db_item_repository.py`、`db_row_repository.py`（子行生成のnow引数化・クライアント日時除外）。
- 前提: S01〜S03。
- 完了条件: 5.3節の処理順を満たし、PG独立接続試験で T08（異なる要求の同版更新は一方のみ成功、別行更新は両立、登録対更新で追加消失なし、削除対更新で復活なし、子項目変更で他子が戻らない）、T09（別テナント不可視、`lock_timeout` で有限時間収束、デッドロック再試行）、T10（同一µs連続更新で版が増加、未来5秒±1µs境界、9時間未来で停止、時計後退時も単調）が合格。
- 検証: `tests/backend/test_db_item_repository_postgres.py`（CI `backend-tests-db` ジョブへ `PORTAL_TEST_DB_URL` を追加）。

### S07 一覧保存の保護・キャッシュ・ETag・アクセスログ
- 対象: `db_json_repository.py`（`mutate_collection_locked`、ETag表現版、ガード）、`json_collection_service.py`、`memory_cache.py`、`bootstrap_service.py`、`routers/access_logs.py`、`access_log_repository.py`、`access_log_service.py`、`access_logs.js`。
- 前提: S02、S06。**ガード（行単位対象の `replace_collection` 拒否）はS08・S10・S12で全呼出元を移行した後に有効化**。
- 完了条件: テナントA/Bの同名キャッシュ・ETag・索引・get/clearが分離される。connection_settings/recording_metadataの混在書込みは全経路が共通ロックに参加し、行単位ガードを無保護に迂回しない。表現版で旧ETagを再利用せず、検索境界を満たす。
- 検証: `test_access_logs_api.py`、`test_access_log_repository.py`（期待値更新）、`test_bootstrap_*`、PG試験。

### S08 認証
- 対象: `auth_api.py`、`auth_helpers.py`、`auth_session_fallback.py`、`db_json_repository.py`（`upsert_auth_device`、新 `touch_auth_device`）。
- 前提: S06。
- 完了条件: ログイン・最終確認はDB時刻。並行ログインを最終確認が巻き戻さず、同じ会員への再ログインでも古いセッションスナップショットで新認証日時/権限を上書きしない。authenticated_at/代替created_atと会員登録時刻の世代判定、欠落/旧形式/会員再作成をT13/T24で確認し、誤って履歴を継承させない。パスワード更新は行単位、利用期限はJST、フォールバック寿命8時間は維持。
- 検証: `test_auth_login_stability.py`、`test_auth_and_crud.py`、`test_auth_dependencies.py`（期待値更新）、新PG並行試験（T13）。

### S09 その他の生成元・mtime・診断
- 対象: `routers/scores.py`、`recording_asset_service.py`、`drive_storage.py`、`recording_upload_service.py`、`core/startup.py`、`meta_service.py`、`maintenance_service.py`、`calendar_service.py`、`system_service.py`、`system_repository.py`、`improvement_suggestion_repository.py`、`portal_notice_repository.py`、`notification_service.py`。
- 前提: S01（一覧保存部分はS07の `mutate_collection_locked`）。
- 完了条件: 対象出力がすべて `+09:00` 6桁。mtimeがサーバーTZに依存しない（TZ切替試験）。
- 検証: 既存試験の期待値更新、新単体。

### S10 業務サービスの行単位化
- 対象: `base_repository.py`、`extra_service.py`、`extra_collection_helpers.py`、`member_service.py`（写真以外）、`performance_service.py`（チラシ以外）、`event_service.py`、`schedule_service.py`、`announcement_service.py`、`payment_service.py`。
- 前提: S06。ファイル部分（参考楽譜のtrim/削除、共通画像の固定名保存/削除）は本手順では変更せず、S11で置換する。**S10とS11は同一リリースで反映し、S10単独では反映しない**（仕様1.7 F03。prefix一括trimやDB確定前削除が残る途中状態を利用者へ開放しない）。開発中の中間コミットでは、該当箇所に未完了である旨を試験で明示してよい。
- 完了条件: 4.1節の各APIで応答形式・ステータスが既存試験どおり。PG並行試験で他行消失なし。
- 検証: `test_db_mode_extra_collections_crud.py`、`test_attendance_extra_api.py`、`test_concert_record_videos.py`、`test_desired_piece_vote_id_regression.py`、`test_general_member_extra_permissions.py`、`test_event_album_permissions.py`、`test_repository_contracts.py`、`test_db_mode_api_regression.py`。

### S11 参考楽譜・共通画像のアセット化
- 対象: 新規portal_file_asset_service、操作/アセット表、対象バックエンドの作成/更新/削除と配信、utils/portal_file_operations.js、members/api・portal_views・performances・admin_system/api・date_piece_promotion/api、index.html。送信形式へ操作キーを追加し、結果照会UIも実装する。
- 前提: S10、S16。ローカル試験は隔離・使い捨てDBへ022を適用して実施する。TESTでの稼働には、S00の記録とTESTへの022適用が必要。
- 完了条件: 6.5節の中断点・R05-B分岐を新規対象で検証する。POST再送でも業務変更は一回、元の成功/拒否結果を返し、状態照会は対象存在に依存しない。旧ファイルは根拠付き参照が確定し、単一未確定候補を配信しない。T11/T12/T19〜T24合格。
- 検証: モック単体＋PG＋TESTの隔離GCSプレフィックスで世代条件試験。

### S12 アルバム写真
- 対象: `album_service.py`。
- 前提: S06、Q09。
- 完了条件: 並行アップロードで写真が消えず、保存名が衝突しない。削除はDB確定後。
- 検証: `test_album_photo_serving.py` 拡張、PG並行。

### S13 チューナー・メトロノーム表示と終端
- 対象: `tuner/view_history.js`、`tuner/storage_local.js`、`tuner/view_diagnosis.js`、`metronome/view_analysis.js`。
- 前提: S04（規則の共有のみ。コード依存なし）。
- 完了条件: 終了日 `23:59:59.500` を含み翌日00:00を含まない（T06）。オフライン履歴・未同期操作が保持される（T14）。
- 検証: 関連 `test_tuner_*`、`test_metronome_*`、`npm run generate:tuner-release` → `check:tuner-release`、`generate:metronome-release` → `check:metronome-release`、`test:e2e`（tuner/metronome spec）。

### S14 個別画面の確認
- 対象: `admin_system/render.js`（端末一覧）、`albums.js`、`date_piece_promotion/render_desired_promotion.js`、`environment_management.js`、`notices.js`。
- 前提: S04。
- 完了条件: 各画面の日時がJST、空欄は「未記録」、不正は「日時不明」。
- 検証: 該当フロント試験、Playwright。

### S15 文書更新（並行）
- 対象: 本計画書、仕様書（今回の実装指示に基づく結果反映）、`docs/AUTH_DEVICE_SESSION_STABILITY.md`、`docs/PRODUCTION_RELEASE_CHECKLIST.md`、`docs/MANUAL_DEVICE_QA_CHECKLIST.md`、`docs/CLOUD_RUN_GCS_DB_CHECK.md`、`API_DATABASE_SPEC.md`、`db/postgresql_table_spec.md`。
- 完了条件: API日時契約・表現版・回収手順・時計差確認が記載される。

### S16 マイグレーション022（expand）
- 対象: 新規 `db/migrations/022_portal_file_assets.sql`。操作表、確定参照を兼ねるアセット表、同一テナント制約、必要な索引を追加する。022は提案番号で、実装時に未使用を確認する。
- 前提: S00。旧コードが追加列・新表を無視して動作すること（追加のみ、NULL許容、既定値あり）。
- 完了条件: `check_tenant_migration.py` 合格、旧コードの試験がスキーマ適用後も合格。
- 注意: TESTデプロイ（`.github/workflows/deploy-test.yml:138-149`）と本番昇格（`promote-production.yml:97-108`）は保留マイグレーションを全適用するため、**022はS11より前に単独で反映可能な形にする**。

### S16-A 今回専用メンテナンス手順の実装
- 対象: 新規 `scripts/manage_datetime_maintenance.py`、`tests/backend/test_datetime_maintenance_plan.py`、今回の運用文書。
- 前提: S00と第9章の状態/互換性設計。S11の実装と並行可能だが、S18/S19の検証前に完成させる。宣伝リセット専用ツールは変更しない。
- 変更: 9.3節の開始・状態照合・drain/writer確認・解除・解除失敗時maintenance復帰・互換条件付き旧revision復帰を実装する。模擬実行と明示executeを区別し、秘密値は状態ファイルへ保存しない。
- 完了条件: reset runなしで今回の解除条件を満たせる一方、状態不一致、未停止writer、drain未完了、非互換データ利用後の旧コード復帰を拒否する。模擬CLI試験が合格し、S19で隔離TESTの実操作を確認する。

### S17 旧データ照合・移行スクリプト
- 対象: 新規 `scripts/audit_datetime_values.py`、`scripts/migrate_reference_assets.py`、`scripts/cleanup_portal_file_assets.py`。
- 前提: S16、S11。
- 完了条件: ドライランで根拠付きマニフェスト・件数・差分を出力し、候補1件でも根拠がなければ適用しない。旧値不一致・共有実体・未確定操作は停止。内部migration操作を記録し、二重実行で変化なし（T11/T12/T15）。

### S18 全体検証（ローカル・CI）
- AGENTS.md の全コマンド＋型チェック・ロード順・状態アクセス・tuner/metronomeリリース・リリース安全性・テナント移行チェック。未実施・失敗・既存失敗を分けて記録。

### S19 TEST反映と実環境照合
- 第9章の順序でTESTへ反映。専用メンテナンス手順の開始/解除/障害復旧も隔離TESTで検証する。T17/T18、DB/GCS障害・再送・並行保存・キャッシュ分離を確認する。本番専用旧スクリプトをTESTへ流用しない。

### S20 本番反映
- 今回用のmanage_datetime_maintenance.pyと第9章で反映する。宣伝リセットrunの作成・流用や既存解除ガードの無効化は行わない。専用手順のTEST検証、書込み停止/ドレイン/DBとジョブの停止確認、旧新互換性確認を本番開始条件とする。

---

## 8. テスト・受入条件の対応表

レベル: U=単体（モック）、P=実PostgreSQL独立接続、G=隔離TEST GCS、E=Playwright、T=TEST環境照合、D=実機。モックのみで合格としない項目に★。

| 試験 | 内容（仕様R12） | 実装する試験 | レベル | 合格条件 |
|---|---|---|---|---|
| T01 | サーバー/DB接続/端末TZ組合せ | `test_datetime_utils.py`（`TZ` 環境変数を変えた子プロセス）、`test_jst_pure_helpers.test.js`（3TZ）、PG試験で接続 `TimeZone` をUTC/Asia/Tokyo/America/New_Yorkに設定して往復 | U,P,T | 同一瞬間が同一JST、保存瞬間不変 |
| T02 | 00:00、09:00前後、月末、年末年始、うるう日 | 同上＋`member_access_expired` 境界、`today()` | U | 日付・曜日・当日判定一致 |
| T03 | 暦演算・海外夏時間 | `daysUntil`、`nextAllDayDate`、`addMonths`（現行月末繰越の固定値）、`absences` 7日窓 | U | 暦日不変・既存規則維持 |
| T04 | 表記・小数・旧形式・不正/欠落 | `test_datetime_utils.py`、`test_db_row_codecs.py`、`test_concurrency_instant.py`、`parsePortalInstantMs` | U | 規則どおり受理/拒否、µs・元トークン維持 |
| T05 | 保存直後・再取得・再ログイン・別インスタンス ★ | PG試験で保存応答と別接続再取得の `updated_at` 文字列一致、キャッシュ無効化確認 | P,T | 同版の日時一致 |
| T06 | 23:59:59.000/.500/.999、DB .999999、翌日00:00 | アクセスログ（PG）、チューナーローカルストア | U,P | 終了日含む・翌日含まない |
| T07 | 利用期限・回答期限・復帰/日付変更 | `member_access_expired`、deadline往復、`bootstrap_init` 復帰再描画（fake timers） | U,P,E | JST境界、新制限なし |
| T08 | 同版2更新・別行・登録対更新・削除対更新・子項目 ★ | `test_db_item_repository_postgres.py`（2接続でバリア同期） | P | 一方のみ成功、消失・復活なし |
| T09 | テナント違い・権限変更・ロック/混在保存 ★ | PG独立接続、A/B交互キャッシュ、connection_settings起動シード対通常変更 | P,U | 越境・キャッシュ流用・起動時巻戻しなし、有限時間収束 |
| T10 | 同一µs・未来5秒境界・9時間異常・時計後退 ★ | 同上（`updated_at` を直接設定した行で検証） | P | 版衝突なし、異常検出 |
| T11 | 準備前後・仮保存直後・競合・DB/応答喪失 ★ | 新規操作とアセットの中断注入＋PG/GCS。候補1件の未確定旧ファイルも検証 | U,P,G | 各中断点を追跡し未確定配信・誤回収なし |
| T12 | 並行置換・固定URLキャッシュ・回収失敗・プロセス終了 ★ | 同上＋配信ヘッダー試験 | P,G | 最新確定参照を配信、他要求を消さない |
| T13 | 認証・フォールバック・所有者 ★ | authenticated_at/代替created_atとmember_birthの境界、欠落/旧形式、会員再作成、並行再ログイン | U,P | 正しい世代だけ履歴利用可。新認証を巻き戻さない |
| T14 | メモリー/IndexedDB/304/旧インフライト/旧タブ/オフライン | `test_bootstrap_swr.test.js`、`test_fetch_transport_paths.test.js`拡張、`metronome_two_tabs.spec.js`・tuner E2E | U,E | 旧形式再混入・未同期データ消失なし |
| T15 | 補正ドライラン・二重実行・補正中更新・切り戻し | `scripts/audit_datetime_values.py`・`migrate_reference_assets.py` の試験（PG） | P | 件数/差分一致、後続更新を上書きしない |
| T16 | ICS・署名URL・同期/ハッシュ・音声 | 既存 `test_tuner_*`/`test_metronome_*`/ICS試験の回帰＋リリースID検査 | U,E | 外部形式・寿命・経過時間維持 |
| T17 | iPhone/Safari・Chromium・複数タブ ★ | `docs/MANUAL_DEVICE_QA_CHECKLIST.md` に項目追加 | D,E | 入力/表示/復帰/キャッシュ切替が正しい |
| T18 | API・DB・画面の実環境照合 ★ | TESTで操作時刻を記録し、API応答・DB `clock_timestamp()`・画面を照合。時計差（Q07）と応答遅延を別記録 | T | 実時刻一致 |
| T19 | 同じIDの成功/拒否/処理中/更新削除後/異内容 | 新規ファイルAPIのPOST/PUT/DELETE・状態照会に加え既存宣伝/楽譜の回帰 | U,P | 業務変更一回、元結果/処理中応答、異内容拒否。新規対象を既存回帰だけで代替しない |
| T20 | 準備記録のみ・完了応答喪失・強制停止・一時障害 ★ | 新規アセットの中断注入、既存宣伝の回帰 | P,G | DB記録で再開/回収、一時障害をrejectedへ固定しない |
| T21 | リース失効・引継ぎ後の旧処理・遅延完了・削除後の遅延実体 ★ | lease切れ後の確定拒否、`deleted` 後24h再照合 | P,G | 旧試行確定不可、遅延実体回収 |
| T22 | 配信参照取得後の置換/回収、長いダウンロード ★ | 版固定URLと15分猶予 | P,G | 進行中配信を破壊しない |
| T23 | 同じ旧実体を複数レコード/テナントが参照 | 移行スクリプトの検出停止、既存楽譜回帰 | P | 他方を破壊しない |
| T24 | 権限失効・会員再作成・保持期限・DB照会不能 | 新規操作照会と認証世代試験、既存専用APIの回帰 | U,P | 別主体へ結果/履歴を渡さず、照会不能を未実行にしない |

運用試験: 今回用maintenanceの模擬CLIと隔離TESTで、宣伝resetを要求しない解除、状態不一致の停止、drain未完了時の拒否、解除確認失敗時のmaintenance復帰、非互換参照利用後の旧revision復帰拒否を確認する。既存manage_production_maintenanceの安全条件を無効化する試験ではない。

---

## 9. 移行・反映・切り戻し計画

### 9.1 変更の分類

| 分類 | 対象 |
|---|---|
| スキーマ変更不要 | S01〜S10、S12〜S14（出力・解析・行単位化・表示） |
| 追加スキーマが必要 | S11/S16（022: portal_file_operations、portal_file_assets、同一テナント制約・active所有参照） |
| 旧データの補正が必要（可能性） | L01〜L08・L14の瞬間（Q01/Q02/Q06の結果次第）、`events.deadline` 不適合行（Q04）、アルバム写真の移動行（Q09） |
| 識別用日時のため専用移行が必要 | `members.created_at`（L04）。補正が必要と判明しても本計画では実施しない |
| 実環境確認まで判断できない | 補正の要否・件数、時計差、ID/シーケンス（Q16）、旧参考楽譜の候補数 |

### 9.2 反映区分

段番号は実施順（第3版でF04を反映）。第1段の追加スキーマは通常稼働中に先行適用できる。第2段〜第4段は同じメンテナンス期間中に完了させ、途中状態を一般利用へ開放しない。表示系（S04/S13/S14）はバックエンドと同じ第3段で反映し、単独で先行しない（U01決定済み）。

| 段 | 手順 | 条件 |
|---|---|---|
| 第1段（先行expand、稼働中） | S16: 操作表/確定参照を兼ねるアセット表 | 旧コード・スキーマ互換を検証。既存の保留マイグレーションも列挙 |
| 第2段（メンテナンス開始） | S16-Aの開始・drain・writer停止確認 | 専用手順のTEST検証済み。進行中TX・ジョブの停止を確認 |
| 第3段（候補コード反映、非公開） | S01〜S14（S10とS11は同一リリース）、S07のテナント分離・共通ロック・ガード有効化、キー対応UI、運用スクリプト（F02） | 依存完了・TEST受入れ合格。メンテナンスを維持 |
| 第4段（移行・公開判定・解除） | S17の根拠付き参照移行（ドライラン→適用）、移行状態とhealthの照合、S16-Aの解除 | 必要な旧参照の移行完了。解除失敗時はmaintenanceへ戻す |
| 旧データの瞬間補正 | 別の補正計画 | 根拠（S00/Q06等）とドライラン、依存関係・復旧計画が確定するまで保留 |

### 9.3 旧新混在・今回専用メンテナンス

既存 `scripts/manage_production_maintenance.py` は解除時に宣伝リセットのcompleted runを要求し、旧リビジョンへの復帰も拒否する。今回の解除/切戻しにそのまま使用できない。無関係な宣伝リセットを実施したり、同スクリプトのガードを弱めたりしない。

新規候補 `scripts/manage_datetime_maintenance.py` を今回の反映手順として設計・実装する（この文書更新では作成しない）。既存のmaintenance entry pointと停止検証の考え方は再利用し、宣伝リセットの完了条件とは分離する。

1. 対象project/region/service/DB、現在100%配信中の旧revision、候補revision/image digest、従来traffic/tag、互換区分を明示する。状態ファイルを変更前に排他的作成し、再実行で現在状態と照合する。秘密値は記録しない。
2. deploy/sync/cleanup等の外部writerを停止し、maintenance revisionを用意する。100% traffic切替と旧tag除去後にdrain期限を設定する。単なる環境変数更新では既存処理が止まったと扱わない。
3. 旧revisionのrequest timeout経過だけで完了とせず、実行中DB TX・ジョブ・旧書込み元も確認する。未完了なら解除/移行を止める。待機は状態照会で継続可能にする。
4. メンテナンス中に追加スキーマ、候補コード、根拠付き旧参照移行、起動時シード等を検証する。候補は明示的な通常mainエントリ、想定DB/スキーマ、リビジョン・digest、health、移行状態が一致することを確認する。
5. 新revisionへの100%解除は上記の確認結果に基づく。宣伝リセットrun_idを要求しない。解除後の確認失敗はmaintenanceへ戻し、状態ファイルに経過を残す。旧writerは互換確認前に再開しない。
6. 旧revisionへの復帰は9.4節の可否を状態ファイルと実データで判定する。非互換データ利用後は拒否し、maintenanceを維持して前進復旧する。

| 組合せ | 対応 |
|---|---|
| 旧一覧置換サーバーと新行単位サーバー | 同時書込み禁止。新コードの起動時シードも共通ロック。切替前に旧writerと進行中TXを止める |
| 旧タブ→新サーバー | 通常の旧aware入力は互換。旧naive版は409再読込。新規ファイル変更のキーなし要求は428。新規操作IDをサーバーで代用しない |
| 新タブ→旧サーバー | メンテナンス期間内に閉じ込める。新ファイルUIを旧サーバーへ送らない |
| 旧キャッシュ/オフライン復帰 | tenant/actor・表現版に従って再取得。チューナー等の未同期履歴は全消去しない |
| 022のみ適用後の旧コード | expand互換試験で確認。問題なしと未検証で断定しない |
| 新アセット/操作記録利用後→旧コード | 旧コードへの切戻し不可。新規アップロード停止だけでは既存新参照を旧コードが読めるようにならない |

### 9.4 切り戻し・前進復旧

- 第1段の追加スキーマは原則そのまま残す。DROPによる復旧は行わない。
- 第3段の候補コードは、一般利用へ開放する前であっても無条件に切戻し可能としない。今回用の停止/復帰手順で、日時・写真ID・子表等の新値を旧コードが扱え、旧処理がデータを破壊しないことを確認できた範囲だけ復帰可とする。未確認ならmaintenanceを維持する。
- 第4段で新参照・操作結果を利用した後は前進復旧。根拠付きlegacy参照の逆操作は後続更新と値が一致する対象に限定できるが、それだけで旧コード全体への復帰を許可しない。
- データ補正は対象・旧値・新値・根拠を記録し、適用/逆操作とも期待値一致を条件とする。
- 上記スクリプトのCLI/状態/異常復帰を模擬試験し、隔離TESTで停止→drain→解除→解除失敗時maintenance復帰を検証する。本番操作は本計画作成では実行しない。

---

## 10. 未確定事項と確認方法

### 10.1 実装時に安全に選べる判断（推奨を採用してよい）

| ID | 判断 | 推奨 | 理由 |
|---|---|---|---|
| D-01 | JST実装 | 固定オフセット `+09:00` | パッケージ追加不要、Docker/Windows/Python3.10で同一。夏時間なし |
| D-02 | 既存専用API（宣伝・楽譜・チューナー・メトロノーム・本番運用履歴）の出力形式 | 変更しない | R01「既存専用APIは契約を保つ」。画面は時間帯付き値を正しく表示できる |
| D-03 | `events.deadline` | 列型維持、「UTC 0時で日付を表す」を正式codecに（新旧で書込み規則が同じため形式版不要） | 仕様「当面既存DB型維持」。新旧混在が生じない |
| D-04 | 一覧保存の保護 | advisory lock＋同一接続DB再読込 | `SELECT FOR UPDATE` だけでは新規追加を防げない（R05） |
| D-05 | ID採番 | advisory lock下の `max+1`＋シーケンス追従 | 既存の明示ID運用と整合（N19） |
| D-06 | 新規ファイル対象の操作プロトコル | 今回導入。クライアント維持UUID＋portal_file_operations＋結果照会 | R05-A/B・R06の必須条件。既存の無関係なAPIだけ現状維持 |
| D-07 | IndexedDB | DBバージョンを上げずエントリに形式版 | blocked/versionchange回避 |
| D-08 | naive旧トークン | 409（再読込） | 生成元のオフセットを断定できない |
| D-09 | 表示不正値 | 「日時不明」「日付不明」 | R03 |

### 10.2 判断に実データ・環境確認が必要な事項

| ID | 事項 | 確認方法（読取のみ） | 影響する判断 |
|---|---|---|---|
| Q01 | 接続のTimeZone | `SHOW TimeZone; SELECT now(), clock_timestamp();`（アプリと同じ接続文字列・ロール） | 旧値の瞬間の正しさ（L01等） |
| Q02 | DB/ロール既定設定 | `SELECT d.datname, r.rolname, s.setconfig FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole;` | 同上 |
| Q03 | 列型・精度 | `SELECT table_name, column_name, data_type, datetime_precision FROM information_schema.columns WHERE table_schema='public' AND data_type LIKE 'timestamp%' ORDER BY 1,2;` | µs精度前提（R02） |
| Q04 | `events.deadline` 適合 | `SELECT organization_id, count(*) total, count(*) FILTER (WHERE deadline IS NULL) nulls, count(*) FILTER (WHERE deadline = (date_trunc('day', deadline AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) utc_midnight, count(*) FILTER (WHERE deadline = (date_trunc('day', deadline AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo')) jst_midnight FROM events GROUP BY 1;` | D-03の防御分岐、補正要否 |
| Q05 | 未来値・逆転 | 各表 `count(*) FILTER (WHERE updated_at > clock_timestamp() + interval '5 seconds')`、`FILTER (WHERE created_at > updated_at)` | R07閾値、補正要否 |
| Q06 | 9時間ずれの兆候 | `access_logs.accessed_at` のJST時間帯ヒストグラム（`extract(hour from accessed_at AT TIME ZONE 'Asia/Tokyo')`）を稼働リビジョン期間別に集計。既知の操作（例: 特定日時に行った登録）とDB値の対応 | 補正対象・期間 |
| Q07 | アプリとDBの時計差 | TESTで `/api/health` の `timestamp` とDB `clock_timestamp()` を同時刻に取得し差を記録（複数回） | R07閾値、N10評価 |
| Q08 | Cloud Run の `TZ` 環境変数・リビジョン履歴 | `gcloud run services describe` / `revisions list`（環境変数名の有無のみ。値の秘密情報は出さない） | 過去の生成TZ |
| Q09 | アルバム写真の移動・衝突 | `SELECT count(*) FROM album_photos WHERE object_name <> '' AND object_name NOT LIKE 'albums/' || album_id || '/%';` | N05の補正要否 |
| Q10 | 旧参考楽譜の候補数 | `desired_pieces` の `reference_score_url<>''` 件数と、GCS `desired_piece_reference_scores/{id}/` のオブジェクト数（一覧のみ） | 移行の自動/手動判定 |
| Q11 | 共通画像の旧URL | `members.photo_url`・`performances.flyer_image`・`org_settings.icon_url` の `?ext=`・data URL・その他の件数 | 移行対象 |
| Q12 | テナント分布と受入れ境界 | membersだけでなく全対象表のorganization_id分布、HTTP tenant指定の検証、A/B同名キャッシュ分離を読取/隔離試験で確認 | 規模・移行対象の把握。単一テナントをN07修正免除にしない |
| Q13 | 所有者世代の整合 | `SELECT count(*) FROM tuner_owners o JOIN members m ON m.organization_id=o.organization_id AND m.id=o.member_id WHERE o.revoked_at IS NULL AND o.member_birth <> m.created_at;`（メトロノームも同様） | R08、専用移行の要否 |
| Q14 | 認証日時の逆転 | `count(*) FILTER (WHERE authenticated_at > last_seen_at)` | 表示・補正 |
| Q15 | 宣伝actorの前提 | `SELECT count(*) FROM members WHERE created_at IS NULL;` | 宣伝・楽譜の操作照合 |
| Q16 | ID/シーケンス | 各表 `SELECT max(id) FROM t` と `pg_get_serial_sequence` の `last_value` | D-05 |

### 10.3 運用・設計上の決定事項（実装前またはTEST反映前に確定）

| ID | 事項 | 推奨案 | 決定時期 |
|---|---|---|---|
| U01 | 表示系を単独で先行反映するか | **決定済み**: 先行しない。9.2第3段でバックエンドと同時反映 | 決定済み（10.5） |
| U02 | 5秒未来閾値 | 5秒で実装し、Q07の実測で再評価 | TEST前 |
| U03 | `lock_timeout`/`statement_timeout` | 5秒/15秒 | TEST並行試験後 |
| U04 | 旧データ補正の実施有無 | Q01/Q02/Q06の結果で別計画 | 本番前 |
| U05 | 回答期限の明示削除操作 | 現行の「空欄で保存＝期限なし」を維持し、不明形式行のみ保護 | 実装前 |
| U06 | 参考楽譜・共通画像の操作キー契約 | 必須導入（D-06）。対象API・旧要求428・クライアント保持・結果閲覧を確定 | 実装前 |
| U07 | 共通画像旧固定名の扱い | 公開前に根拠付きlegacy参照へ固定。置換後にretiredとし、共有/配信保護確認後だけ回収 | 実装前 |
| U08 | 回収処理の保持値 | staged 24h、retired 15分を初期設計値とし配信/外部I/O上限をTESTで照合。deletedは最低30日かつ未解決操作/遅延実体なしまで保持 | 実装前 |
| U09 | 新規操作記録の保持 | 結果本文30日を初期設計値。未解決/回収未完了は消さず、失効IDの最小記録を保持 | スキーマ/TEST反映前 |
| U10 | 回収周期・実行者 | 既存スクリプト同様の手動ドライラン→実行を本番チェックリストへ追加、定期化は別判断 | 本番前 |
| U11 | メトロノーム/チューナーの表示変更をこのリリースに含めるか | 含める（リリースID再生成とE2Eを伴う） | 実装前 |
| U12 | テナント非分離キャッシュ | S07で全キーをtenant別にする。任意ヘッダーは権限根拠にせず既存認可と照合。別課題へ延期しない | 実装前 |
| U13 | 参考楽譜のサイズ上限 | 楽譜と同じ30MiB | 実装前（既存挙動変更のため確認） |
| U14 | 参考楽譜配信ルートの認証 | 既存契約維持（今回追加しない）。別課題として記録 | 実装前 |
| U15 | 文字化け権限名（N08） | 別課題 | — |

---

### 10.4 レビュー反映の追跡表

| 指摘 | 反映先 | 検証/反映条件 |
|---|---|---|
| C01 新規ファイルの操作照合延期 | R05-A/B対応、6.5/6.6、D-06、S11/S16、送信UI | 新規対象でPOSTを含むT19〜T24、結果照会。操作表なしの版比較で代替しない |
| C02 メンテナンス解除の用途不一致 | 9.2〜9.4、S16-A/S19/S20、新規専用スクリプト案 | 宣伝resetに依存しない解除・非互換復帰拒否・TESTでの復旧試験 |
| C03 単一候補の未確定配信 | 6.5、移行スクリプト案、S17、T11/T12 | 1件でも根拠なしは配信/自動確定しない。確定参照の移行完了が公開条件 |
| C04 connection_settings混在ロック | 4.1/startup、6.2/6.3、S07/S09、T09 | 全書込み経路が同じcollectionロック、シード対通常変更のPG試験 |
| C05 テナント共有キャッシュ | N07、4.1、S07、U12、T09/T14 | get/set/etag/index/clearをA/B交互に検証。単一テナントDBだけで免除しない |
| C06 認証日時の用途誤認 | L05、S08、T13/T24 | 認証日時/代替登録日時とmember_birthの比較、旧形式/欠落/再作成時の世代保護 |

これらは今回の文書改訂で反映した設計であり、ソース・スキーマ・スクリプトを実装したという意味ではない。

### 10.5 実装方針の決定と最終レビュー反映（第3版）

2026-10-19、最終レビュー（「本仕様どおりでは既存機能の無変更・無影響は満たせない」）を受けて、利用者が次を決定した。詳細は仕様書1.6/1.7。

| ID | 決定・指摘 | 本計画への反映 |
|---|---|---|
| E01 | A（日時最小修正）/B（保存信頼性）に分けず一括実装 | 第7章の全手順を同一反映計画で実施。9.2の第3段で同時反映 |
| E02 | API出力の `+09:00` 6桁統一を実施 | 5.5節のとおり。ETag表現版・端末形式版（S04/S07）も必須 |
| E03 | 意図した挙動変更を承認 | 仕様1.6「受容した影響」の範囲に限る。それ以外の既存挙動の変更は、要件または本計画に根拠がない限り行わない。利用者案内・運用文書（S15）に記載 |
| F01 | R05-Aの原則と新規操作プロトコルの矛盾 | 仕様側で例外を明記。本計画6.6の対象以外へキー必須化を広げない |
| F02 | `scripts/migrate_base64_images.py` の漏れ | 4.1節へ追加。S11と同時に移行 |
| F03 | S10単独反映時のprefix trim残存 | S10はファイル処理を変更せず、S11と同一リリース |
| F04 | 反映段番号と実施順の不一致 | 9.2/9.4を実施順へ統一 |
| F05 | S00を実装担当環境から実行できない | 下記の分担で実施 |

**S00の分担（F05）**: Q01〜Q16の読取確認は利用者が実施する。実装担当は第10.2節のSQL・確認手順を渡し、結果（件数・設定値・有無のみ。実データ値・氏名・秘密値は含めない）を本計画書の付録として受け取る。ローカルの実装・試験（S01〜S17）は結果を待たずに並行して進めてよいが、次の判断は結果が揃うまで確定しない: 旧データ補正の要否（U04）、`events.deadline` の防御分岐の扱い（Q04）、ID採番とシーケンス追従（Q16）、5秒閾値（Q05/Q07）、旧参照移行の対象集合（Q10/Q11）、アルバム写真の既存移動行（Q09）。TEST反映（S19）の開始条件に、少なくともQ01〜Q04・Q09〜Q12・Q16の結果記録を加える。

## 11. 自己レビュー

| 観点 | 確認結果 |
|---|---|
| 要件漏れ | R01〜R12、R05-A/B、R06-AとT01〜T24を再照合。新規ファイル対象の操作プロトコルは必須として計画へ反映し、既存API回帰だけで代替しない |
| 手順の矛盾 | 一覧置換ガード（S07）を全呼出元移行（S08・S10・S12）後に有効化する依存を明記。マイグレーションがデプロイで自動適用される点に合わせ、022を単独反映可能な追加のみとした |
| 未保護の書込み経路 | 4.1・6.3節で `save_json_data`/`replace_collection`/`save_generic_json_collection` の全呼出元（`grep` 結果: `auth_api.py:70,89,100,136,191`、`core/startup.py:83`、`base_repository.py:26,39,53,59`、`routers/access_logs.py:53`、`album_service.py:96,176`、`extra_service.py:429,521,556`、`production_ops_service.py:271`、`recording_asset_service.py:73,86,159,164`）を行単位または保護付き一覧保存へ分類済み。スクリプト（`migrate_json_to_postgres.py`、`sync_prod_to_test_db.py`、`migrate_base64_images.py`）は運用時のみ。`allow_bulk` 指定と実行時のメンテナンスを前提とする |
| 検証不足 | 新規対象の操作照会・POST再送・削除後再送、キャッシュ分離、connection_settings混在保存、今回専用maintenanceの解除/復旧を追加。CIのPG試験とTEST隔離GCSを併用し、モックだけで合格にしない |
| 残るリスク | 旧データの瞬間の正しさ（Q01/Q02/Q06未確認）、アルバム写真の既存移動行（Q09）、行単位化による広範な回帰（既存試験の期待値更新が多い：naiveフィクスチャ `test_auth_login_stability.py:441` 等はローカルJSONモードで読み続けられるよう、ローカルモードのnaive値は表示「日時不明」・比較不可として扱う） |

---

## 12. 今回実施した確認と未実施事項

### 実施
- 初回調査時: `git status`（未追跡3件を確認、変更なし）、当時の仕様書第3版・AGENTS.md の通読。
- 上記ファイルのソース読取（バックエンド: utils/repositories/services/routers/core、マイグレーション001〜021、`db_runtime.py` のDDL生成、`postgresql_table_spec.md`。フロント: common_helpers、runtime_context、cache、各画面モジュール、チューナー/メトロノームの該当箇所、`index.html` 読込み順、静的配信・Service Worker。CI・デプロイワークフロー、Dockerfile、依存定義）。
- ローカルの副作用なし再現（`.venv` のPython 3.10、`DATA_BACKEND=local`、DB/GCS/HTTP非接続）:
  - `parse_db_timestamp("2026-10-19")` → `2026-10-19T00:00:00+00:00`
  - `parse_db_timestamp("2026-10-19T12:00:00")` → naiveのまま通過
  - `db_json_value(aware, µs=0)` → 小数なし
  - `next_updated_at(現在+9h)` → 前回+1µsのnaive値
  - `ensure_expected_updated_at` で同一瞬間の異表記が409
  - 実行後に `git status` が不変であることを確認。

### 未実施
- 修正の実装、テストコードの作成・実行（`pytest`・`vitest`・`playwright`・`ruff` 等のフルチェックは今回未実施）。
- TEST・本番のDB/GCS/Cloud Runへの接続、第10章Q01〜Q16の読取確認。
- 実機（iPhone/Safari）確認、実PostgreSQLでの並行試験、GCS世代条件試験。
- パッケージ追加・更新、Gitステージ・コミット、マイグレーション適用、デプロイ、データ補正。

本書は実装計画の完成を示すものであり、修正実装・実環境検証の完成を意味しない。

### 第2版の文書更新で実施した確認

レビュー6件を仕様書第4版と本計画書へ対応付け、本文・対象ファイル・新規表・S手順・反映計画・T試験・判断台帳・自己レビューを整合させた。参照パス/表構造/旧方針の残存を静的に確認する。アプリテスト、DB/GCS接続、メンテナンス操作、Git操作は実施しない。

### 第3版の文書更新で実施した確認

- 利用者の決定（E01〜E03）と最終レビュー指摘（F01〜F05）を仕様書第5版1.6/1.7と本計画10.5節へ対応付けた。
- F02の根拠として `scripts/migrate_base64_images.py:10,60,79` を、C06の記載として `tuner_service.py:197-198`・`metronome_service.py:249-250` を、C02の前提として `scripts/manage_production_maintenance.py:114-124` をソースで確認した。
- 実装、テスト実行、DB/GCS/Cloud Run接続、Git操作は実施していない。

## 13. ローカル実装と検証の記録（2026-10-19）

本章は実装再開後の現状であり、第12章の「未実施」は文書作成当時の履歴である。ローカルPostgreSQLは既存の使い捨てコンテナ `127.0.0.1:56543` のみを使用した。TEST・本番のDB/GCS/Cloud Runへは接続していない。ステージ・コミット・デプロイ・実データ補正は実施していない。

### 13.1 実装対応

| 手順・要件 | 実装と主な検証先 | 現状・残条件 |
|---|---|---|
| S01〜S03 / R01,R02,R07 | `datetime_utils.py`、DB codec、瞬間による競合比較。`test_datetime_utils.py`、`test_db_json_layer.py`、PG行保存試験 | Python 3.10.20で検証。旧naiveトークンは、保存値と文字列が一致していても409。不正トークン422、保存版不正500。5秒閾値の環境判断は未確定 |
| S04,S13,S14 / R03,R04 | JST表示・今日・暦演算・瞬間ソート・検索境界・復帰時再評価。`test_jst_pure_helpers`、`test_jst_resume`、チューナー履歴試験、`jst_datetime.spec.js` | UTC/米国時間の子プロセスとChromiumで確認。月末繰越は現行規則維持。復帰時は支払フォームの未保存選択を再作成しない。iPhone/Safariは未確認 |
| S05 / R04 | 回答期限のUTC 0時codec、不明な既存値の空保存時の保全。PGの `test_unknown_deadline_is_not_erased_by_blank_browser_input` | 不明値の元TIMESTAMPTZを保持。実データの扱いと明示的な期限削除の最終判断はQ04/U05待ち |
| S06,S07,S10 / R05,R09 | 行単位store、共通collectionロック、一覧置換ガード、tenant別MemoryCache、ETag/IndexedDBの `jst-us-1` | 独立PG接続による競合、登録・削除の保全、ロック待機上限、tenant分離を確認。古いGETは保存後にキャッシュを戻せない。ID/シーケンス調整はQ16待ち |
| S08 / R08 | ログインDB時刻、会員の行単位変更、条件付き最終確認、8時間の単調時計TTL | 同会員再ログインも認証世代で照合。`test_auth_session_postgres`、`test_auth_jst`。履歴所有者の既存世代契約は維持 |
| S09 / R02 | mtime、録音・楽譜メタデータ、診断等のJST生成・表示 | 既存回帰試験と構文・型・Lintで確認。個別専用API/署名/ICSのUTC契約は維持 |
| S11,S16 / R05-A/B,R06/R06-A | 操作/アセット表022、staged記録、確定参照、UUID/GCS世代条件、照会・回収。`test_portal_file_operations` とPG版 | 所有参照は6.5節の専用参照表方式を採用。S10/S11同時公開を維持。実GCSの世代条件・障害試験は未確認 |
| S11画面 / R05-A/B,R09 | `portal_file_operations.js` を対象画面に接続。不透明な主体scopeを `GET /api/portal-file-actor` で確認し、再ログインを越えて同じアカウント世代の保留記録を保持する。内容ハッシュ/操作UUIDのみを永続化し、添付・秘密値は保存しない | 応答喪失・再読込・別内容・認証変更を単体/Chromiumで検証。未確定操作は元添付なしでも照会でき、再送で新IDへ変えない。遅延読込URLも版更新 |
| S12 / R05,R06 | アルバム写真の全親共通ID、UUID実体、確定後削除 | 同一/別アルバムへの独立PG接続の並行アップロードで全写真を保持。既存誤対応行の有無と修復はQ09待ち |
| S16-A,S17 / R10,R11 | 専用メンテナンス、根拠付き旧参照移行、回収・日時監査、base64移行スクリプト | 模擬CLI/ローカル試験。実環境では未実行。宣伝リセット用ツールのガードは変更していない |
| S15,S18 / R12 | 仕様・計画・API/DB/運用/実機確認文書、CIへのPG専用試験追加 | ローカル結果を13.2節へ記録。CIの実行・TEST受入・本番反映は未実施 |

### 13.2 検証結果

- 中断時の試験結果は再開後の検証と区別した。再開時のバックエンド全体は819 passed / 72 skipped、フロントエンドは1,150 passed。
- 追加修正後のバックエンド（PG専用試験無効）は822 passed / 73 skipped。PG専用群のうちアルバム並行試験等は合格し、認証世代の変更に合わせた旧期待値を修正した後、認証PG試験は5件合格。最終全体結果は下記追記欄へ記録する。
- フロントエンド全体は110ファイル、1,162件合格。起動計測の既存試験で実時計の1ms進行による失敗を一度観測したが、同試験の単独再実行と次の全体実行は合格。今回のために計測実装やその試験の許容値は変更していない。
- Chromium既存E2Eは82件合格。追加したJST/応答喪失後の再読込試験は3件合格。APIを模擬するブラウザー試験と、実PGのトランザクション試験は別の証拠であり、実GCSや実機の受入を代替しない。
- Python構文、ruff、バックエンドmypy（162ファイル）、フロント構文・読込順・状態アクセス、チューナー/メトロノームのリリース整合、テナント移行・リリース安全性を実行。最終追記欄に残る失敗・未実行を明記する。
- 作業開始時のPython DLL読込/Dockerアクセス拒否は、ローカル検証コマンドの権限を限定して実行することで解消した。実環境への接続権限は使用していない。

### 13.3 反映前に残る事項

1. 利用者実施のS00結果を10.5節の規則で記録する。少なくともQ01〜Q04・Q09〜Q12・Q16が揃うまでS19を開始しない。
2. Q04、Q05/Q07、Q09〜Q11、Q16を受けて、旧期限・未来閾値・既存写真・移行対象・採番の判断を確定する。実データの一律9時間補正は行っていない。
3. CIを実行し、実GCSの世代条件、遅延アップロード/回収、専用メンテナンスの開始・drain・解除失敗時復帰、旧コードのexpand互換を隔離TESTで検証する。
4. iPhone/Safariの復帰、オフライン履歴と未同期操作の保持、日付境界、ファイル再送を実機で受入する。
5. 第9章の4段階を同じ切替計画で実施する。新参照利用後は互換性未確認の旧コードへ戻さず前進復旧とする。

ローカルの合格結果をもって、S00・S19・S20や全受入条件が完了したとは扱わない。

### 13.4 最終確認の追記

- ローカルPG専用試験を有効にしたpytest全体: **860 passed / 38 skipped**。今回の行保存・認証・ファイル操作・アルバム並行試験を含む。スキップされた他機能の専用PG試験は下記補完結果と区別する。
- フロントエンド全体: **110ファイル / 1,162件合格**。最後の表示修正とリリースID再生成後に再確認した。
- Chromium E2E全体: **85件合格**。一度観測したメトロノーム画面のタイムアウトは、システム管理画面の遅延初期化が新しいタブ選択を上書きする競合だった。既存の画面遷移世代を初期タブ選択にも適用し、制御した遅延を使う回帰試験と全体再実行で確認した。待機時間や検証条件を緩めたものではない。
- 最終走査で、環境管理のUTCビルド時刻表示とチューナー保守メモの当日付与もJSTに揃えた。専用APIのUTC保存契約は維持した。最終資産でJST/再読込復旧の3件、チューナー保存・呼出し等の重点2件も合格。
- Python構文・ruff・mypy（バックエンド162ファイルと標準チェック用4スクリプト）、フロント構文/読込順/共有状態、リリースID、リリース安全性、テナント移行対象、運用チェックリストは合格。互換ファサードの行数制限超過は、処理を `services/row_storage_service.py` へ移して解消し、制限や公開関数を維持した。
- `git diff --check` は既存のCRLFを行末として扱う `git -c core.whitespace=cr-at-eol diff --check` で合格。再開後は作業中ファイルの既存改行を一括変換せず保持した。ステージ済み差分はない。
- 宣伝・楽譜・メニューの専用PG試験は**16件合格**。チューナー/メトロノームの22件は、最初の補完時には試験DBに017/019の表がなくセットアップエラーとなった。テストが要求する前提スキーマを使い捨てローカルDBだけに準備して再実行した結果を、次の補完結果欄へ記録する。アプリの判定や試験の検証条件は変更していない。

再ログインによる認証時刻の変更と、アカウントの再作成による世代変更は別に扱う。保留操作はサーバー発行のtenant/account世代scopeで区切り、応答を適用する際は現在の認証情報も照合する。保持期限外の結果は不明扱いを維持し、保留記録を勝手に破棄して新IDで再実行しない。

**専用PG補完の最終結果**: 017/019準備後のチューナー/メトロノームは **22 passed**。宣伝・楽譜・メニューの16件と合わせ、全体実行でスキップされた専用PGの38件をすべて補完して合格した。前提スキーマ未適用時の22セットアップエラーは検証環境の準備で解消した。実GCS・CI・TEST・本番・iPhone/Safariに関する13.3節の未確認事項は引き続き残る。

### 13.5 コミット前レビュー指摘の修正（2026-10-19）

- CIに追加した `PORTAL_TEST_DB_URL` とPG試験stepのインデントを修正し、YAML解析とジョブ内の配置を確認した。
- 旧版の参照取得と実体読取りの間で退役15分の境界を越えて回収されると、開始済み配信が404になる事象をローカルで再現した。配信開始TXで行ロック下に `read_protected_until` をDB時刻+15分へ延長・確定し、回収も同じ行ロック下で期限を再確認する方式へ修正した。
- 保護は022の新アセット表に追加するNULL許容列で管理する。未リリース022を試行済みのローカルDBでSQLを再実行しても列を追加できるよう冪等にし、既存ローカルSQLiteも列を追加する。TEST/本番には適用していない。退役や別読取りの終了/失敗で保護を短縮せず、外部I/O中のDBロックは不要とする。
- 回帰試験は版固定/現在参照の両経路、猶予境界での回収、保護失効後の回収、新版の保全、他の読取り期限の非短縮、`delete_pending` 後の読取り拒否を確認する。PGは独立接続で「回収候補の選択→配信保護の確定→猶予終了→回収の再確認」の順序を固定する。実GCSのI/O上限確認は13.3節の未確認事項として維持する。
- 最終の関連ローカル試験は **42 passed**、独立接続を含むファイル操作PG試験は **8 passed**。旧SQLiteの列追加・再接続と接続の明示的closeも確認した。旧022のPG表に対する列追加・SQL二重実行は独立した一時スキーマで確認し、ロールバックした。型チェックは既定のパッケージ単位（162ファイル）、ruff、Python構文、リリース安全性、行末を考慮した差分チェックに合格した。
- 補助確認では、単一ファイル指定と `--follow-imports=skip` の組合せにより内部importがAny扱いとなり、型エラー6件が出た。既定の `mypy ... -p src.backend` で再確認し合格した。旧SQLiteの単独確認も、通常のapp_core初期化順と接続の明示的closeを使って再実行し合格した。型チェック設定の緩和や例外追加は行っていない。
- ローカルPGを有効にしたPython全体は **866 passed / 38 skipped**。SQLiteの明示的closeと旧スキーマ試験の最終追加後は上記の関連42件で再確認した。スキップは他機能の専用DB条件によるもので、今回それらの専用PG試験やフロントエンド/E2Eは再実行していない。TEST/本番、実GCS、ステージ・コミット・デプロイは未実施。

### 13.6 TESTのS00読取り結果とCI（2026-10-19）

利用者からTEST読取り確認の明示承認を受け、稼働TESTサービスの接続設定をメモリ内だけで使用した。接続時から `default_transaction_read_only=on` を強制し、READ ONLYを確認して集計後にロールバックした。秘密値・個人の実データは出力・記録していない。DB更新、マイグレーション適用、本番接続、GCS変更、TEST公開は実施していない。

| 確認 | TEST結果 | 判断・残条件 |
|---|---|---|
| Q01/Q02 | セッションTimeZoneはGMT、DB/ロールのTimeZone上書きは0件 | UTC保存を一律9時間補正する根拠とはしない |
| Q03 | timestamp系157列、すべて小数精度6 | APIのマイクロ秒契約と整合 |
| Q04 | 回答期限1件、UTC 0時1件、NULL/JST 0時/その他は0件 | UTC 0時の日付codecを採用。既存値補正なし |
| Q05 | 5秒超未来値・8時間超未来値・作成/更新逆転の検出は0件 | 未来版の旧データ補正は不要。時計差確認は下記Q07が残る |
| Q07/Q08 | health時刻を3回確認したが全てオフセットなし。TZ環境変数なし | healthだけでは瞬間を断定せず、時計差は未確定。新候補を非公開で起動した際にawareなhealthとDBを再比較する |
| Q09 | アルバム写真の保存prefix不一致0件 | この照合では旧写真の補正対象なし |
| Q10 | 参考楽譜URLを持つ希望曲0件 | DBが参照する旧参考楽譜の移行対象0件。孤立GCS実体の有無は未確認で、回収しない |
| Q11 | 会員写真: data URL 2件、旧固定名3件、asset URL 0件、空54件。チラシ: data URL 1件、空1件。団体アイコン: 空1件 | 旧固定名3件の実体・世代・DB参照根拠を照合してから移行する。DB内data URLは確定参照として維持可能 |
| Q12 | 全対象30表でtenantはdefaultのみ | テナント分離のPG回帰試験はCIでも成功。単一tenantを分離免除の理由にしない |
| Q13〜Q15 | 稼働tuner ownerのmember_birth不一致0件、認証日時のlast_seen超過0件、会員created_at NULL 0件 | これらの識別用日時補正なし。metronome owner表はこのDBでは未作成 |
| Q16 | concert_record_videosのみ最大ID4・sequence last_value 1。他の確認対象は遅れなし | 行単位storeはロック下のMAX+1で採番するため新方式同士は衝突しない。外部の既定採番との衝突防止のため、TEST反映時の停止中にこのsequenceを再確認し、後退させず最大ID以上へ追従させる手順を要する |
| 保留スキーマ | 022_portal_file_assets.sqlのみ | 適用にはTEST DB変更の承認とメンテナンス反映手順が必要 |

PR #141の初回CI（run 39203531229、head 751b85d）は、バックエンドDB/ローカル、フロント、ブラウザー、Docker smoke、品質ゲート等の全10ジョブが成功した。標準Deploy TestはmainのCI成功後に自動起動して通常公開するため、今回の移行・メンテナンス条件を満たすまでPRをドラフトとし、マージを保留する。通常の `deploy_to_test.ps1` をそのまま実行して停止・移行手順を飛ばさない。

S00の取得に際し、接続時の `statement_timeout` 追加指定は接続先と互換性がなかったため、既存の接続確認手順と同じREAD ONLY指定だけで接続し、トランザクション内で30秒のSQLタイムアウトを設定した。DB監査SQLの結果記録と時計差未確定を分離し、S00・S19・S20の全完了とは扱わない。

### 13.7 WindowsでのメンテナンスCLI事前確認

Windowsで `subprocess.run(["gcloud", ...])` がFileNotFoundErrorになることを、外部変更を伴わない `--version` で確認した。`shutil.which` で実際のgcloud.CMDを解決してから実行するよう修正し、CLI不在時は操作前に停止する。回帰試験13件、実CLIの `--version`、ruffが合格した。実環境のメンテナンス切替を検証したという意味ではない。

### 13.8 TEST限定の既存404受容と反映手順

2026-10-19、利用者はTEST反映（022、採番追従、参照移行、メンテナンス切替）を承認した。旧会員画像3件は現行TESTでも404で、TESTバケットに現行・非現行・ソフト削除世代が存在しないことを確認した。その後、利用者は「TEST限定で既存404の3件を除外して反映する」を明示的に選択した。既存URLを保持し、画像や参照は削除しない。本番へこの受容を引き継がない。

- `migrate_reference_assets.py apply --accept-test-missing-photos` は、承認情報付きマニフェストと実環境 `APP_ENV=test` / `CLOUD_RUN_SERVICE=kanade-orchestra-test` を必須とする。現在の未移行参照を再調査し、対象がちょうど承認済み3件であること、DB値不変・実体未復元・事前404の根拠を照合する。変化や追加参照があれば停止する。
- レポートは移行済み `applied` と受容した欠損 `accepted_missing` を分け、欠損を正常移行済みと偽装しない。解除ゲートは後者を承認済み3件・TESTサービスだけに限定し、本番では拒否する。
- 旧DB内のGCS設定には環境変数との不一致がある。反映時の接続先はTESTサービスから取得したTEST DB・TESTバケットに固定し、他環境の実体をコピーしない。既存DB設定の書き換えは今回の対象外。
- 専用メンテナンスrevisionは `MAINTENANCE_MODE=true` も明示する。通常Deploy Testは今回のメンテナンスと競合するため、実行中の外部writerがないことを確認し、当該TESTデプロイworkflowを停止してから切り替える。解除・検証後に元のworkflow状態へ戻す。自動反映ガードを弱めない。
- 非公開候補は通常入口とTEST用メンテナンスガードを併用し、healthだけで時計差を検証する。公開用revisionは同じimage digest・通常入口・ガード無効を明示し、解除ゲートで確認する。公開後のhealthはhealthyかつmaintenance無効を要求し、不一致ならmaintenanceへ戻す。
- 関連の移行・専用メンテナンス試験27件が合格。画像復元・削除・参照消去は行っていない。

### 13.9 TEST反映の実施結果（2026-10-19）

以下は2026-10-19のTEST反映作業時点の記録であり、現在の稼働状態を示すものではない。利用者の「TEST反映を続行してよい」「続行」の指示により、13.8節の手順でTESTへ反映した。このTEST反映作業では、本番・本番DB・本番GCSには接続も変更もしていない。TEST接続設定はTEST旧revisionからメモリ内だけで読み込み、表示・保存していない。

| 手順 | 結果 |
|---|---|
| メンテナンス開始 | 同日14:58に実施済み（旧revision 00175、メンテナンスrevision 00176、互換記録あり） |
| verify | 合格。他の実行中DBトランザクション0、新方式のファイル操作・アセット0。Deploy Test・Sync Prod to Testは無効、実行中writerなし（2026-08の滞留run記録のみ） |
| 022 | 既に適用済みで、現行ファイルとchecksum一致（再実行はskip） |
| 採番追従 | `concert_record_videos` のsequenceを last_value 1→4（最大ID）。後退なし |
| 参照移行 | TEST実データで再照合し、未移行参照は承認済みの会員画像3件のみ（DB値不変・実体なし）。report `completed`、applied 0、accepted_missing 3。画像・参照の作成・削除なし |
| イメージ | `d006cd4` を `git archive` からビルドしpush。Cloud Runの解決digest `sha256:54e16507…` |
| 非公開候補 | revision 00229（通常入口・TESTメンテナンスガード有効・tag付き・トラフィック0）でhealthy、他APIは503。Q07: healthの `+09:00` 時刻とDB時計の差 0.007〜0.065秒（3回） |
| 公開 | revision 00178（同一digest・通常入口・メンテナンス無効）。tag除去後、解除ゲート（入口・digest・DB名・022・アクティブTX 0・移行report・TEST限定例外）合格で100%切替 |
| 公開後確認 | 100% 00178、health `healthy`・`maintenance: disabled`。主要一覧APIは200で瞬間を `…ffffff+09:00`、`events.deadline` を `YYYY-MM-DD` で返却 |

反映作業終了時点の申し送り: Deploy Testは無効のままとした。当時のmainは本変更を含んでおらず、再有効化後にmainへ別の変更が入るとTESTが旧コードへ戻るため、PR #141のマージとDeploy Test再有効化の順序を確認する必要があった。この時点では実機（iPhone/Safari）確認、TEST上の操作試験（T17/T18）、本番反映は未実施だった。

2026-10-20の文書整理時にローカルGit履歴で、PR #141は2026-10-19 18:47:46（JST）に `93baca3` でマージ済みであり、現在の作業ブランチとローカルの `origin/main` がこのコミットを含むことを確認した。上記のマージ待ちは反映作業終了時点の記録として扱う。Deploy Test・Sync Prod to Testの現在の有効状態、現在のTEST稼働revision、後続の実機確認・操作試験・本番反映の実施状況は、この文書整理では再確認していない。
