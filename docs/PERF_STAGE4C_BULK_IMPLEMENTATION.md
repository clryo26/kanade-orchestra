# 第4段階4C 第2単位：アルバム全置換の禁止

2026-10-25。詳細設計7.1 / S4-06 / PERF-R15の、アプリ内の全置換経路だけを閉じる。写真差分更新（`3de19e9` / `7b68883`）の後続であり、台帳・DBガード・lease・回収候補・物理回収は含めない。

## 1. 契約と範囲

DB経路でコレクション名が `albums` の場合、空/非空の全置換をともに409で拒否する。既存の通常 `replace_collection` と同じ `detail: "albums requires the row-level API"` を使う。`allow_bulk=True` や保守用フラグによる例外は設けない。利用者の画面に新しい要素・文言は追加しない。

| 入口 | 拒否する位置 |
|---|---|
| `replace_collection`（`allow_bulk=True` を含む） | 接続取得より前 |
| `_replace_collection_in` | 渡された接続のcursor操作・行変換より前 |
| `mutate_collection_locked` | 接続取得・集合読取・mutator実行より前 |
| `save_generic_json_collection` | Jsonb変換・接続取得より前。汎用JSON表へのalbums保存も許さない |
| `db_delete_collection_children` | cursor.connection参照より前。集合全体の子DELETEの入口を閉じる |
| `save_json_data` のDB分岐 | readiness確認・注入されたDB保存関数より前 |
| `mutate_json_data` のDB分岐 | 注入されたロック付きmutatorより前 |

判定は副作用のない `services/collection_write_policy.py` に集約する。上位サービスからrepositoriesの初期化を呼び込まないため、このポリシーはapp_core/core/repositoriesをimportしない。互換ファサード、storageの再公開、`BaseRepository.save_all` / `AlbumRepository.save_all` も同じ判定を通る。拒否時はデータ、callerのpayload、キャッシュを更新しない。

明示的なローカルJSONの `save_json_data` / `mutate_json_data` はfixture・ローカルのListRowStore用として維持する。DBリポジトリを直接呼んだ場合は、ローカル設定の有無にかかわらず拒否する。他のコレクションの保存契約は変更しない。

アルバム1件の作成・更新・削除と、1件の写真集合に空配列を明示する操作は、引き続き行APIで扱う。#150の「省略は保持」「null等は422」、所有者/管理者判定、期待版、写真差分SQLは変更しない。ListRowStoreの内部で使う明示的ローカルJSONの全保存も維持する。

## 2. 同期・保守との境界

`sync_prod_to_test_db.py` はアプリの全置換関数を使わず、独自のUPSERT / 不要行DELETEを実行するため変更しない。取得元0件のDELETEも専用同期の契約として維持する。起動処理はアルバム全体をDBへ投入せず、既存の読取・接続設定のseedは変更しない。

これはPythonアプリ内の入口制限であり、DB側のセキュリティ境界ではない。直接SQL、旧リビジョン、行単位のINSERT/UPSERT等の低レベル関数を本変更で保護したとは扱わない。既存の汎用JSON表の保存済みデータも削除しない。その有無はR25の読取専用棚卸しで確認する。

同期モードの許可ロール、v2プロトコルとDBガード、台帳の整合、回収候補なしの同期を許可する条件は後続の実装・確認事項のまま。保守のために `allow_bulk=True` を再び例外にする運用は採用しない。

## 3. 検証

単体試験は空/非空の全置換、内部関数、汎用JSON、ロック付きmutator、子全削除、9つの互換経路を対象とする。DB接続・接続文字列取得・readiness・注入callbackを失敗するsentinelに差し替え、409がそれらより先に返ることを確認する。ローカルJSONの全保存・mutate・行更新を対照とする。

PostgreSQL16/18は、既存の所有確認付きloopback専用DB `portal_perf_stage4` のfixtureだけで実行する。拒否前後の親と写真の実データ、汎用JSON表の全行とキャッシュが同じで、貸出とmutatorが0回であることを確認する。既に接続を渡した内部関数でもSQLを送らず、呼出元のトランザクションを壊さない。通常HTTP PUTと他の汎用JSONの保存、実際の同期SQL helperのUPSERT/取得元0件DELETEを正の対照とする。

既存の写真差分試験と#150のPostgreSQL試験も再実行する。本fixtureにFK/回収triggerはなく、cascade、同期workflow全体、実環境の接続ロールを検証したとは扱わない。GCSは合成adapterで、実GCSへの通信・削除は行わない。

検証結果は [STAGE4C_BULK_VALIDATION.json](perf_stage4/STAGE4C_BULK_VALIDATION.json) に記録する。過去のBEFORE/AFTERと固定画像は変更しない。本番環境での性能値や実機の結果へ読み替えない。

### 最終結果

| 検証 | 結果 |
|---|---|
| バックエンド全体 | 1,065件成功・185件スキップ（条件付きPG試験等） |
| PG16 / PG18 | 各44件成功（本単位3件、写真差分18件、既存#150の23件） |
| フロント全体 | 1,385件成功 |
| 全e2e（Chromium） | 95件成功 |
| フロント構文 / compileall / ruff / 共有ZIP安全検査 | 170ファイル / 終了コード0 / 終了コード0 / 全項目PASS |

新しい単体試験23件は全体に含む。別プロセスで4モジュールに束縛された拒否関数だけを無効にすると、迂回路の19件が失敗する。既存の通常全置換拒否2件は成功するので、これを本変更の新しい効果として数えない。本番ソースを一時的に戻さずに行った検出力の対照であり、通常検証の失敗ではない。

PG試験にはキャッシュの保持と呼出元トランザクションの継続も含む。全体の3警告は既存のPython 3.10向けgoogle-api-core警告、pkg_resources非推奨、ffmpeg未検出。WebKitの画像比較と実機確認は未実施（本単位はバックエンドのみでHTML/JS/CSSは変更なし）。所有ラベルを照合して検証専用のPostgreSQLコンテナ2台を停止した。

## 4. 残件と戻し方

台帳、DBガード、読取lease（5分・60秒以内ごとの延長）、回収候補、#150 AP150-T12、4Dは未実装。実DB/GCSのR25、NOT NULL団体列/PK/FK/共有参照/接続ロール、実機確認も残る。4AのGCS条件付きGETは時間予算の問題で保留のまま。物理回収は有効化しない。

本単位を戻すと、以前から拒否していた通常の全置換以外の迂回路が再び開く。将来DBガード/回収を導入した後に、アプリだけ旧版へ戻して削除を再開してはならない。既存設計どおり回収ワーカーを止め、DBガードを維持する。

push・PR作成・マージ・デプロイは本作業に含めない。別作業の `docs/archive/` と#150独立版のworktreeは保持する。
