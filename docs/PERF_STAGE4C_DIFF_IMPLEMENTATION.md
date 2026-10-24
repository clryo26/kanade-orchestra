# 第4段階4C 第1実装単位：アルバム写真の差分更新

2026-10-24。基準 `db88630`、ブランチ `perf/portal-stage4c-20261024`。対象は [詳細設計](PERF_STAGE4_DETAILED_DESIGN.md) 7.1 / S4-06の写真差分だけ。

## 1. 範囲と着手条件

#150の契約と基礎ソース `db88630` / 独立版 `2a16a1b` はユーザーがレビュー済み。独立版へのPG補足 `7ba2598` は別作業ツリーでローカルコミットされ、元スタックへ取り込んでいない。修正のソースと31件の単体試験は両系列で同一である。今回、同じ契約を既存23件の実PG試験でも再確認する。

4Cをレビュー可能な実装単位に分けた。今回は写真の差分SQLと、そのための未変更写真のserver日時保持だけを実装する。後続の全置換禁止、台帳/内部asset参照、DBガード/v2プロトコル、同期/復元の整合、読取lease、回収候補は未実装である。4C全体を完了とせず、4Dも実装・有効化しない。AP150-T12の候補整合は候補生成後に実施し、今回の差分試験だけで合格にしない。

## 2. 変更

本番ソースは `repositories/db_item_repository.py` だけ。

- 親ロック後に読んだ現在の写真を `_write_children(previous=...)` へ渡す。INSERTの場合は空の以前集合を明示し、albumsの以前集合が不明な呼出しは停止する。他集合は従来のDELETE/INSERTのまま。
- DB保存と同じ列定義・正規化でIDと保存値を比較する。親の名称変更、省略写真、同一写真配列の再送・並べ替えでは写真行へのDMLを0にする。
- 追加は対象INSERT、写真内容/参照の変更は対象UPDATE、除去は対象DELETE。UPDATE/DELETEは写真IDだけでなく親IDと既存の団体条件も付ける。新しい写真をUPSERTせず、別親/別団体の既存IDと衝突したら通常の一意制約でrollbackする。
- 重複した要求IDをdictで静かに潰さず、従来の重複INSERTと同じUniqueViolationとして拒否する。IDの型は既存DB変換で比較する。
- 写真の実データが同じならserver管理日時の違いを変更理由にしない。実データを変更した写真だけupdated_atを進め、保存済みcreated_at/uploaded_atはNULLも含めて維持する。未変更写真の全snapshot列は保つ。親updated_atは従来どおり進む。
- 既存アップロードの全団体MAX/ロックによる写真ID割当は変更しない。汎用PUTのID省略は既存の互換sequence helperを維持し、別のロック順を導入しない。試験では同期済みsequenceの成功と、古いsequenceが既存IDに衝突した場合の全体rollbackを分ける。

既存の例外/版確認/認可、書込lock timeout5秒と監査は維持する。新しいUI・通常の文言・HTTPキャッシュ・GCS I/O・即時物理削除の経路・ロール・DDL・migrationは変えない。既存の即時削除が残るため、遅延回収の安全プロトコルを導入済みとは扱わない。

SQL差分は未知の内部列をUPDATEしない。将来の台帳参照をこの実装だけで保護したとは扱わず、4C後続でJSON変換・INSERT/参照変更・ガードと併せて実装する。

## 3. 検証

新しい実PG試験は [test_perf_stage4c_photo_diff.py](../tests/backend/test_perf_stage4c_photo_diff.py)。写真25行の名称変更/同一/並べ替え/追加/ID省略/変更/参照変更/1行削除/空配列、重複ID/別親/別団体のID、実UPDATE後の例外rollback、sequence衝突を確かめる。既存#150の23件（親ロックの両順序を含む）と合わせて各37件。

[test_perf_stage4c_unit.py](../tests/backend/test_perf_stage4c_unit.py) の4件で、未変更/変更とNULL/非NULLの日時を組み合わせ、偽のclient日時を適用しないことと、同じ参照のv1 thumbnail keyが変わらないことを確認する。

初回の実PG試験は各34成功/2失敗だった。元のserver child処理が既存NULLのuploaded_atを現在時刻で補い、写真変更時にv1キーを変えることを検出したため、NULLも保持するよう実装を修正した。期待値を緩めて通したのではない。

旧 `db88630` のchild writerだけを別pytestプロセスへ読み込む対照では、写真25枚/50枚の未変更DMLゼロ試験2件が旧DELETE/INSERTで失敗した。本番ファイルを一時的に戻していない。

最終の件数・source/test/JUnitのhashは [検証記録](perf_stage4/STAGE4C_DIFF_VALIDATION.json) へ記録する。旧BEFORE・#150 AFTER・写真fixtureは上書きしない。

## 4. 比較

写真25行の名称変更は、PG16/18ともSQL42文から16文へ減る。写真DELETE25行とINSERT25文がなくなり、延べ貸出6回と監査1件は変わらない。親/写真のSELECT回数や全写真のfetch行数を減らす変更ではない。写真省略PUTも25行を保持し、16文となる。旧来の「0写真/17文」はデータ消失なので性能の基準に戻さない。

新しい [PG16 AFTER](perf_stage4/STAGE4C_DIFF_PG16_AFTER.json) / [PG18 AFTER](perf_stage4/STAGE4C_DIFF_PG18_AFTER.json) に、同じ架空の標準/2倍量、1/25/50枚表示、5回の名称変更、競合、監査を保存する。SDK呼出数は合成adapterの回数で、実GCSの課金要求数ではない。所要時間は他のローカル試験と併走しており、実Cloud Runのレイテンシ改善の証拠にはしない。SQL/影響行数を本変更の効果として扱う。

## 5. 戻し方・残件

今回の差分だけを戻せば、写真行の全DELETE/再INSERTへ戻る。#150の省略保持修正は残す。DBやGCSの復元・削除、設定変更は不要。将来のガード/回収導入後のrollbackは、既存設計どおりワーカー停止とガード維持を別途必要とする。

実DB/GCSのR25、団体列/PK/FK/ロールと共有参照、実機・WebKit画像比較、4AのGCS条件付きGETは未確認/保留。今回のPG fixtureは従来の互換schemaでalbum_photosのFKを持たず、cascade検証ではない。独立#150のFKありfixtureの成功を本差分の結果へ読み替えない。

既存スタック上の1コミットとして扱う。独立#150やmainを先に取り込む際は、重複ソースと最終差分を確認する。push・PR作成・マージ・デプロイ・実環境の有効化は行わない。

## 6. 最終結果

| 検証 | 結果 |
|---|---|
| バックエンド全体 | 1,042件成功・178件スキップ |
| PG16 / PG18：差分14件＋既存#150の23件 | 各37件成功 |
| PG16 / PG18：既存4-0/4A比較計測 | 各16件成功 |
| 日時/サムネイル識別の単体試験 | 4件成功（全体にも含む） |
| 全e2e（Chromium） | 95件成功、終了コード0 |
| ruff / compileall / 共有ZIP安全検査 | 終了コード0 |

フロント単体は再実行していない（JS/CSS変更なし）。最初のe2eログも95件成功だったが、PowerShell呼出しは警告stderrのNativeCommandErrorを含んで終了1だったため、最終結果には使用しない。最終の全件は別subprocessで取り直し、終了コード0を確認した。PostgreSQLの専用コンテナは所有ラベルを照合して停止済み。別作業のdocs/archiveは保持した。
