# 第4段階4C 第3単位：台帳の永続化基盤

2026-10-25。設計7.3と9章のうち、内部4表と同期除外だけを実装する。写真差分SQLと全置換禁止の後続。**DBガード・写真への内部参照・台帳への実画像登録・lease操作・候補生成・回収ワーカーはまだ実装しない。** この単位だけで4C完了・4D実行可能とはしない。

## 1. Migration 024

`024_album_asset_ledger_foundation.sql` を新設した。既存のmigrationは変更しない。既存albums/album_photosの列・行・権限・トリガーには触れず、新しい表は空の状態で追加する。通常のアルバム書込で新表へのSQLは発生しない。nullableな写真asset参照の追加も、同期の列コピー対策とJSON変換の対策を行う次の単位まで保留する。

| 表 | 今回の制約・索引 |
|---|---|
| `album_asset_gc_control` | singleton=1、環境UUID/bucket非NULL、bucket空文字不可、guard既定false。環境を推測した初期行は作らない |
| `album_storage_assets` | asset UUID PK、環境/bucket/key/generation一意、generation正のnumeric(20,0)、4状態、claim token/期限の対、deletingにはclaim必須 |
| `album_asset_gc_candidates` | asset FK、pending/cancelled/done/held、pending/heldはassetごとに1件。観測時刻/期限は両方NULLか両方非NULL。期限は観測から168時間以上。期限未設定はdue索引に含めない |
| `album_asset_read_leases` | lease UUID PK、asset FK、既定は同じDB statement時刻から300秒、正の保護期間かつ更新時刻から最大300秒。asset/期限索引 |

派生画像は、同じ環境・bucketの原画像だけを親に持てる複合FKを使う。`parent_kind` は親UUIDがあればoriginalとなる生成列で、アプリが任意の種別を入れて条件を迂回できない。原画像に親を付ける、派生を親にする、自己参照、存在しない親は拒否する。異なるgenerationの同じkeyは別assetとして保持できる。候補やleaseがあるasset、登録assetがある制御行はFKにより安易に削除できない。

候補の`first_observed_at`/`not_before`は自動で埋めない。将来のワーカーがコミット済み候補を初めて観測してから設定する。DBの制約は最小期間を検査するが、コミット後に観測したこと自体はワーカーの別トランザクションと試験で保証する必要がある。夏時間でも7×24時間を下回らないよう、calendar daysではなく168 hoursを使う。

leaseの列制約は基本形だけである。読取開始の参照/assetロック、期限切れの復活禁止、60秒以内ごとの延長、失敗・キャンセル・プロセス停止、解放条件の実装と競合試験は後続。`attempts`は非負の記録用で、最大3回の自動再候補化を本スキーマだけで実施・保証したとは扱わない。

## 2. 有効化と権限

ガードが未実装なのに有効状態だけを作れないよう、**一時的な安全制約 `album_gc_foundation_guard_disabled CHECK (NOT guard_enabled)`** を設ける。後続のレビュー済みmigrationで、必要なトリガーとプロトコルを導入するときだけ、この制約を扱う。Web環境変数で解除する仕組みはない。通常運用で手動DROPして有効化しない。制御行がない現段階では回収を実行しない。

4表のPUBLIC権限を取り消し、アプリ用の権限や新しい運用ロールは作らない。既存の`ALTER DEFAULT PRIVILEGES`で非ownerへ権限が直接付く場合は、SQL内のACL検査でmigrationを失敗させる。既存権限を推測して書き換えない。

**適用者は別のDDL ownerでなければならない。** 同じログインがアプリとownerを兼ねる場合や、アプリがownerロールを継承できる場合はACLでは保護できない。実環境の接続ロール・所有者・所属・superuser・既定権限を、読取専用で確認するまで適用しない。テスト用の別ログインで成功したことを実環境のロール分離の証拠にしない。

同期のfingerprintと全体バックアップには、内部4表へのSELECT権限も必要になる。本単位はowner以外へSELECTを含む権限を付けないため、アプリと同じ無権限のログインでこれらを実行すると拒否される。実際の同期・バックアップ用ログインでの読取権限を、別のロール方針と後続の権限設定で確定・検証するまで、**このmigrationを単独で実環境へ適用しない**。アプリへの包括的な台帳更新権限で解決しない。現在の通常同期は4表が未作成なら従来どおり動く。

## 3. 同期・復元

`sync_prod_to_test_preflight.EXCLUDED_DB_TABLES`に内部4表を追加した。既存の同期実装はこの定数からコピー除外と前後fingerprintを行うため、コピーしないだけでなく、TEST側の内部4表がDB同期中に変わっていないことも検査する。アプリの通常集合を列挙する`PORTAL_DB_TABLES`へは加えない。旧schemaに4表がなければ、従来どおり存在する除外表だけを検査する。

現段階は写真UUIDもトリガーもなく、通常DB同期は内部4表を変えない。将来の台帳再照合・写真紐付け・候補/lease再確立は、その後の専用工程として別途実装する。今回の除外だけで、その同期工程が完了したとは扱わない。gcs_only再開も後続工程を省略できない。

全体のpg_dump/restoreは内部表を含み得る。復元された環境UUID/bucket/候補を現在環境と認めず、回収停止・環境照合・再確立・猶予再設定を行う設計は維持する。今回、既存の同期SQL、GCS同期、バックアップ、復元スクリプトは変更しない。

## 4. 検証と実環境の境界

PostgreSQL16/18の所有確認付きloopback専用DB `portal_perf_stage4` だけで試験する。接続先の暗黙DB_URLは使わない。新表の制約/ACL、初期空・無効、適用とrollback、再適用の失敗、既存migration実行器のchecksum記録・skip・不一致拒否、通常のアルバムPUTと公開本文の維持、実際の除外fingerprintを確認する。

通常のアプリ用と別のテストログインを作り、SELECT/INSERT/UPDATE/DELETE/TRUNCATEが4表すべてで拒否されることを試験する。`SET LOCAL app.album_delete_protocol='v2'`や同期設定だけでは権限を取得できない。ただしこれは内部4表のACLの試験であり、albums/album_photosの書込ガードの試験ではない。

[検証記録](perf_stage4/STAGE4C_LEDGER_VALIDATION.json) にコマンド、結果、source/test hashを保存する。旧BEFORE/AFTER、固定画像、別作業の`docs/archive/`は保持する。実環境へのDDL適用・GCS操作・push・PR・マージ・デプロイは行わない。

### 最終結果

| 検証 | 結果 |
|---|---|
| PG16 / PG18 | 各83件成功（新しい基盤39件、全置換禁止3件、写真差分18件、#150の23件） |
| バックエンド全体 | 1,065件成功・224件スキップ。新しい39件は明示DSNが必要なため通常実行ではスキップ |
| フロント全体 / 全e2e（Chromium） | 1,385件 / 95件成功 |
| フロント構文 / compileall / ruff / 共有ZIP安全検査 | 170ファイル / 終了コード0 / 終了コード0 / 全項目PASS |

同期スクリプトの既存29件も全体に含まれ、除外一覧の期待値は内部4表を含む契約へ更新した。PostgreSQL試験はLintで指摘されたfixture名の衝突を直した最終ファイルでも再実行した。所有ラベルを照合して専用コンテナ2台を停止済み。全体の3警告は既存のPython 3.10向けgoogle-api-core警告、pkg_resources非推奨、ffmpeg未検出。WebKit画像比較・実機・実DB/GCSは未実施であり、Chromium全e2eの成功で代用しない。本単位はHTML/JS/CSSを変更していない。

## 5. 残件・戻し方

次は、写真の内部asset参照とJSON/同期での保持、v2の1トランザクション、DBガードと参照先状態ロック、トリガーによる候補生成、lease開始/延長/終了を接続する。回収候補の再登録・rollback・cascade・AP150-T12、実DB/GCS/R25・実ロール・実機確認、4D有効化条件は未完了。4AのGCS条件付きGETも保留のまま。

アプリを戻す場合も、追加した表をそのまま残す。後で登録された内部データをDROPで消すrollbackを用意しない。台帳/ガード導入後は回収ワーカー停止とDBガード維持を守り、旧版へ戻して削除を再開しない。
