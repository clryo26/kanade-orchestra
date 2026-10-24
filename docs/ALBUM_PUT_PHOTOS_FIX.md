# Issue #150 アルバムPUT省略時のデータ保持（単独修正版）

2026-10-24。対象: https://github.com/clryo26/kanade-orchestra/issues/150

## 目的・PRの単位

写真を省略したアルバムPUTで写真参照と作成者情報が失われる問題を修正する。性能改善の第2〜4段階より先にレビュー・リリースできるよう、`origin/main` (`9c76fd9`) から専用ブランチ `fix/album-put-photos-standalone-20261024` を作成した。元の `db88630` から本番ソース差分と独立した31件の回帰試験を移植し、性能改善側の計測fixture・基盤・migration・設計書を取り込まない。ソースのパッチは競合なしで適用できた。

## 確定した契約

- `photos` を省略した更新は、ロック後に読んだ現在の写真を保存日時も含めて維持する。
- `photos: []` を明示した場合だけ全写真参照の削除を要求する。明示した非空配列は従来どおり置き換える。
- `photos: null` は、従来の全削除扱いから422に変わる。文字列・辞書・数値・真偽値・辞書以外の要素を含む配列も422。文言は「写真情報の形式が正しくありません」。
- `created_by_member_id` / `created_by_member_name` は省略された項目だけを維持する。明示値の扱いは従来どおり。
- 親の他項目を一律に部分更新へ変えない。他集合（#151〜154）の契約は変えない。

## 実装と安全条件

本番ソースの変更は `src/backend/repositories/db_item_repository.py` だけ。PostgresRowStoreとListRowStoreに同じalbums限定の補正を入れる。期待版の確認後に写真と作成者をsnapshotにし、mutateの認可後に形式を検査する。権限のない要求は従来の403、期待版の不一致は409を保つ。albumsのmutateにはdeepcopyした現在行を渡し、入れ子の変更がsnapshotや失敗時の保存データへ漏れないようにする。

写真の省略時はserver child fieldsの処理後にsnapshotを戻す。保存済みの不正な写真形式を空配列へ変換して消さず、固定の診断ログを出して停止する。ローカルlegacyの写真項目なし/Noneだけは空集合として扱う。

写真行のDELETE/再INSERTは従来どおり残る。差分SQL化、GCSの物理削除、回収候補、トリガー、ロール、認証、通常の5秒lock timeoutは変更しない。新しいUI・正常操作の文言・画面配置の変更もない。型不正422の文言だけがAPI契約の差分。

## 検証

2026-10-24、単独ブランチで以下を確認した。

| 確認 | 結果 |
|---|---|
| 新しい回帰試験 | 31件成功 |
| バックエンド全体 | 943件成功、83件スキップ、失敗0件（独立PG試験追加後） |
| ruff / compileall | 終了コード0 / 終了コード0 |
| フロント構文 | 170ファイル成功 |
| 元コミットとの一致 | 2つの補正関数と両storeのupdateがASTで一致、31件の試験ファイルはバイト一致 |

実行は元作業ツリーの仮想環境Pythonを使い、cwdとimport先が本単独作業ツリーになることを確認した。既存の3つの依存警告は残る。フロント全体/e2e、WebKit画像比較、実環境DB・GCS・実機は単独ブランチでは再実行しておらず、元スタックの結果を引き継いだ成功とは報告しない。独立PostgreSQL試験は以下の追記を参照する。

JUnitはローカルの `.tmp/issue150-standalone/targeted.xml` と `backend.xml` に保存した（Git対象外）。

旧スタック上の `db88630` ではPG16/18の新規23件と既存計測16件ずつが成功しているが、それを本ブランチのPostgreSQL検証結果とは扱わない。性能改善fixtureに依存するPG試験を、単独修正PRの実行条件には加えない。

## リリースと戻し方

PRは#150単独とし、性能改善PRへ依存させない。性能改善側には同じ補正が既に含まれるため、後でmainを取り込む際は重複して別の挙動を足さず、最終差分を照合する。全変更の一括マージ・デプロイを強制するものではなく、実行時期はユーザーの判断とする。本作業でpush・PR作成・マージ・デプロイ・実データ修復・Issueのcloseは行わない。

リリース説明には写真省略の保持、nullの422化、明示空配列での削除、省略作成者の維持を明記する。旧版に戻すとデータ消失の経路が再発するため、汎用アルバム更新を停止するか保持対応版を配備する。既に失われた写真行の自動修復は行わない。

性能改善の4C着手には本修正のレビュー完了を記録する。4C実装後のAP150-T12（回収候補との整合）、4D有効化前の実DB/GCS・ロール・実機確認は引き続き未完了で、本PRでは解除しない。単独版は4Aの対象写真取得変更を含まないので、その配備条件を本修正の新しい依存にはしない。

## 検証対象のSHA-256

- `src/backend/repositories/db_item_repository.py`: `46c1870fd01c88ddafecd75e5f48ef65659c2d34b4fe31b7c64f5d83b8fd47ac`
- `tests/backend/test_album_put_photos.py`: `2d832b8af4d708c8303505f09986fdff15328c4fb387c33a9b734b9f53aa1db9`
- `.tmp/issue150-standalone/targeted.xml`: `543c223acad3e941264091b69ffd530238ee668a977a512361ae9f2bb4bb1c62`
- `.tmp/issue150-standalone/backend.xml`: `af16c2c7f8daeb1c8ddea27e1e9d00c1572327cbb86bef4141194cab0b6b408a`

## レビュー補足：独立PostgreSQL試験・単独PRの説明

`tests/backend/test_album_put_photos_standalone_postgres.py` を追加した。性能改善のfixture・schema・migrationには依存せず、mainのschema互換ビルダーと既存の002だけを使い、架空の団員1人・アルバム1件・写真3行を投入する。fixtureに親子FKも追加し、HTTPの認証・row store・共通プール・監査を通す。本番ソースと31件の試験は `2a16a1b` から変えていない。

- 写真省略のPUTで写真3行と保存日時・作成者を維持する。
- 明示空配列で写真参照を削除する（GCSへアクセスしない）。
- nullを422で拒否し、親と写真の全検証列が変わらない。
- 子の保存後に例外を注入すると親と写真がともにrollbackされる。
- 別接続が写真1行を削除して親をロック中にPUTを投入し、待機を実DBで確認する。先行transactionのcommit後、残った2行だけを保持する。

接続は環境変数 `PORTAL_ISSUE150_TEST_DB_URL` を明示したときだけ行い、未指定は5件をskipする。アプリの `DB_URL` は接続先として暗黙利用しない。loopback、専用DB名 `portal_issue150_standalone`、専用user `issue150`、portを確認し、hostaddr/service/optionsの入力DSN上書きを拒否する。検証後はhostaddrとpublic search_pathを明示し、libpqの環境変数で接続先・schemaが変わらないようにする。既存DBは専用所有markerが一致する場合だけ利用し、未所有DBではschema作成・削除をしない。fixtureのDELETEはそのDBの試験用5テーブルだけ。実GCS Clientの構築は禁止し、既存のプールがあれば上書きせず止める。

再実行例（専用の空DBを用意した後）:

```powershell
$env:PORTAL_ISSUE150_TEST_DB_URL='host=127.0.0.1 port=63916 dbname=portal_issue150_standalone user=issue150'
uv run pytest -q tests/backend/test_album_put_photos_standalone_postgres.py
```

PostgreSQL 16・18の専用使い捨てコンテナで各9件成功（接続先拒否の4件＋上記の実DB5件）。既存のPGコンテナや実環境のDB/GCSは変更していない。初回は試験が `SELECT *` の先頭列をIDと誤認して各1件失敗したため、取得列を明示して両バージョンの全件を取り直した。アプリの処理を変えて通したわけではない。

`docs/PRODUCTION_RELEASE_CHECKLIST.md` に、写真省略の保持・nullの422化・明示空配列での参照削除・作成者維持をリリース説明へ記載する確認行を追加した。

PR説明には、性能改善とは独立したmainベースの不具合修正であることを明記する。性能改善側の `db88630` にも同じソース補正があるため、**どちらを先にmainへ入れた場合も、後から入れる側でmainを取り込み、競合の有無と最終差分を確認する**。今のパッチが一致することは、将来の競合がない保証ではない。push・PR作成・マージ・デプロイは今回も行わない。

最終の独立PG試験・バックエンド全体の件数、対象ファイル/JUnitのhash、試験側の補正は [検証記録JSON](ISSUE150_STANDALONE_POSTGRES_VALIDATION.json) に保存した。通常の全体実行は943件成功・83件スキップ（新しいPG試験5件を含む）。この補足で本番ソースは変えていないため、フロント/e2eは再実行していない。
