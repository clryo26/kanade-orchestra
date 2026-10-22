# 第2段階C〜E 実装・計測記録

2026-10-22。[詳細設計 v1.0](PERF_STAGE2_CDE_DETAILED_DESIGN.md)に対応する。専用ブランチ`perf/portal-stage2cde-20261022`は`eef4434`を起点とする。第2段階Bの上に依存する差分であり、PR #147への追加・push・デプロイは行わない。

アプリケーション変更はCの`5cfd8bf`、E2の`5427102`に分離した。以後の判断資料・検証記録のコミットではアプリケーションコードを変更しない。

## 実装した範囲

| 単位 | 変更 |
|---|---|
| C1 / PERF-R03 | `loadExtraData`の集合別実行中結果に適用の所有を持たせ、同じ結果を複数回代入・描画しない。別集合を待つ間に保存・認証切替・新しい取得が起きた場合は古い結果を適用しない |
| C2 / PERF-R11 | extra完了時の全画面描画を採用集合の依存先に限定。団体設定・接続設定・File入力等を無関係な取得で再初期化しない |
| C2 / PERF-R12 | 本番記録画面の動画検索を描画中だけのMapに置換。演奏会の順序・動画のソート・HTMLを維持し、要求間の索引キャッシュは作らない |
| E2 / PERF-R17 | `OrchestraAppCache/bootstrap_cache`だけを整理。7日・200件・概算20MiBを適用し、最後に使った時刻の永続更新を1時間ごとに間引く |

HTTPのGET集約・再試行・認証回復はBの実装を利用する。ローダー側の情報は実行中の共有と適用判定に限り、完了したPromiseの本文参照を残さない。公開の引数省略時の全体描画・全spec取得は維持する。強制再検証のoptionsは通信層へ渡す。

部分再描画には結合した依存も含める。出欠は団員予定、乗り番は会計の対象判定、団体設定は会計・マニュアルタイトル、パート設定は団員の並び・会計・当日情報等を更新する。会計の再描画には既存`preserveForm`を使用する。団員一覧からの派生描画だけを省略できる引数を追加し、通常の公開呼出しの挙動は維持した。

失敗した集合は旧データを保持し、空配列成功は反映する。抑制応答・古い結果は読込済みとしない。楽譜専用API・録音・団員詳細/紹介・プロモーションの保留操作は一般ローダーへ移していない。

## 応答キャッシュ整理の方式

- IndexedDBのDB名・ストア名・バージョン1・keyPathを変更しない。記録に任意の`lastAccessAt`、`approximateBytes`、書込識別用`writeToken`を追加する。旧記録の移行や一括削除は不要。
- 最終使用時刻は有効な`lastAccessAt`、旧記録では`timestamp`を使う。時刻不明は期限切れと断定せず、上限超過時に先に整理する。`validatedAt`の意味は変えない。
- `approximateBytes`はJSONのUTF-16文字数×2による概算であり、物理使用量ではない。20MiB超の単一本文は保存せず、以前の本文も再利用させない。ネットワークの取得結果は返す。
- 主要な起動・保存を待たせず30秒後に整理を開始する。走査は50件、削除は25件単位のトランザクション。整理中の新規保存があれば次の整理を予約する。上限は整理後の目標値で、並行保存中に常に上限以下になることを保証するものではない。
- 整理候補は削除トランザクションで再読取し、書込・使用時刻更新後に条件が変わった記録を削除しない。メタデータ更新も現在の記録を読み直し、削除済み本文を再作成しない。無効化状態を解除しない。
- request成功ではなくtransaction完了を確定点とする。整理失敗・メタデータ更新失敗を業務処理の失敗にしない。
- チューナー・メトロノーム・共有音声の全DB/ストア、保留操作のlocalStorageは対象外。DB自体の削除も行わない。
- 識別の不一致による整理は、`appState.portalAuthVerified`がtrueで識別が確定している場合だけ行う。団員IDなどの識別は認証成功時に設定されるため、通信できない起動や認証が30秒以上遅れた場合に整理が動くと、同じ端末・同じ利用者のまだ使える記録まで不要と判定していた（レビュー指摘による補正）。未認証時は期限・件数・容量・表現版と、解釈できない旧形式キーの規則だけを適用する。試験は`test_perf_stage2e_cache.test.js`の「identity mismatch retires records only after the session is confirmed」「a confirmed session keeps its own records」。補正前のソースでは前者が失敗することを確認した。

7日・200件・20MiB・1時間の設定値は設計値のまま採用した。実ブラウザの物理容量・HTTPキャッシュとの二重保存の実測は未完了であり、架空IndexedDB計測を端末容量の実測と表現しない。

## 修正前後の計測

| 証跡 | 結果・限界 |
|---|---|
| [初回の修正前計測](perf_stage2_cde/c_before.json) | 本番ローダー・団員描画ディスパッチャーをVMで読込。アルバム同時取得は通信1回だが、適用・無関係な末端描画が各2回 |
| [全集合の修正前](perf_stage2_cde/c_collections_before.json) / [修正後](perf_stage2_cde/c_collections_after.json) | 21spec×0/1/30/60件×5回＝各420サンプル。通信1回を維持し、適用2回→1回。初回計測以外の修正前は固定した`eef4434`のソースを再生。下位HTTP集約はモックで、実DB回数は未計測 |
| [検索の修正前](perf_stage2_cde/r12_before.json) / [修正後](perf_stage2_cde/r12_after.json) | 演奏会10・動画30件で比較710→50回、2倍量で2,820→100回。各5回のHTMLハッシュが一致。比較回数はキーのString変換を計数したもので、SQL回数ではない |
| [整理前](perf_stage2_cde/e2_before.json) / [整理後](perf_stage2_cde/e2_after.json) | fake-indexeddbで205件中5件を期限切れにし、205→200件。基準コードを別VMで読込み再計測。本物のSafariのディスク容量・速度ではない |
| [固定WebKit比較](perf_stage2_cde/c_browser.json) | Linux/WebKit 26.5、390×844、DPR 2、固定日時。3権限×3画面の9画像・9表示DOMが一致。無関係なアルバム取得後の団体名・選択File保持は3権限で確認。修正前は保持されないことも確認 |

画面比較に使った固定イメージは`sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`。画像は`.tmp/perf-stage2cde/browser/`、比較ハッシュと撮影条件はJSONへ記録する。全画面・全結合データ・全編集状態の実機確認を完了したとは扱わない。

再実行は以下。基準コードの再生用コミットが必要なのはローカル計測スクリプトだけで、通常の回帰試験はshallow checkoutでも実行できる。

```powershell
node scripts/perf_stage2_cde_capture.cjs before docs/perf_stage2_cde/c_collections_before.json --collections
node scripts/perf_stage2_cde_capture.cjs after docs/perf_stage2_cde/c_collections_after.json --collections
node scripts/perf_stage2e_capture.cjs before
node scripts/perf_stage2e_capture.cjs after
node scripts/perf_stage2c_search_capture.cjs after
$env:PORTAL_PERF_CDE_REPORT='1'
uv run pytest tests/backend/test_perf_stage2de_decisions.py -q
Remove-Item Env:PORTAL_PERF_CDE_REPORT
```

固定WebKit比較は`perf_stage2c_browser.cjs`を同じイメージで実行する。先に`eef4434`の変更対象5ファイルを`.tmp/perf-stage2cde/before/src/`以下の同じパスへ抽出し、Bootstrap CSS/JSを既存の`.tmp/perf-stage1-20261021/assets/`へ用意する。比較用ローカルサーバーはHTML/staticだけを配信し、APIとCDNは架空応答・ローカル資産へ置換する。

## 変更しないと判断したもの

### C / PERF-R06

現行の復帰処理は、既存60秒判定と実行中ガードで認証・基本データを再確認する。隠れたextraを広く取り直す呼出しはなかったため、取得範囲や19フラグに新しい「再確認が必要」状態を導入しなかった。59,999/60,000/60,001ms、同時復帰の試験で既存境界とautomatic指定を固定した。基本データ内の設定等を削る判断とは分ける。

### D0 / D1

[D0計測](perf_stage2_cde/d0_bootstrap.json)は、基準量・2倍量、3権限、各5回の30サンプル。実際のpayload生成・団員公開化・本人会計抽出を呼ぶ。基準量のliteは34,251 JSON bytes、coreは44 bytes（いずれもサービスpayloadのみ。ルートのmenu等を含むHTTP実測ではない）。圧縮量はサービス本文のgzip概算。

liteは既にサマリー、coreは空extrasであり、必要な基本データを後続取得へ移すことで表示が改善する計測証拠は得ていない。D1は保留し、v2ルート・表現変更・404フォールバックを追加しない。v1・full no-storeは維持する。実ブラウザの表示時間・実DB負荷を測って再判断する。

### E0 / E1

[E0記録](perf_stage2_cde/e0_audit.json)は、実middleware・監査サービスと偽DBアダプターによる28ケース。同じ更新パスで7種類のstatus/例外と4種類の主体取得結果を組み合わせた。成功/認証失敗相当のstatus/500/handler例外、団員あり/なし・空主体・主体取得例外を分けた。認証後に名前・権限が変わると、既存監査は変更後の主体を読むことを確認した。全監査対象ルートや実際の認証依存処理全経路の実測ではない。

認証時の主体をそのまま再利用すると値が変わり得るためE1は保留。未使用のrequest.state受渡し、監査の背景化・スレッド化、DBロールや接続方式変更は加えない。偽DBの計測値を実プール待ち・実SQL時間・実イベントループ遅延とみなさず、それらはnullとした。

## 検証と残件

最終結果と対象ソースのハッシュは[検証記録](perf_stage2_cde/validation.json)へ保存する。単体試験に加え、全e2e・固定WebKit比較を独立して実行する。構文・読込順・共有状態参照・ruff・compileall・release-safetyも確認する。

最終ソースでフロント1,372件、バックエンド960件（78件skip）、全e2e 95件が成功した。構文170ファイル、読込順index43/legacy70、共有状態参照170ファイル・違反0、ruff・compileall・release-safetyの終了コード0。バックエンドの78件skipは実DBを含む未実施条件として残し、Pythonバージョン・pkg_resources・ffmpegの既存警告3件も記録した。

第1段階Aの実DB/GCS/全量計測、実機iPhone・ホーム画面起動・本物のBFCache、固定比較対象外の編集状態・結合データは継続課題。#145/#146の別修正を完了扱いにしない。今回変更するextra適用・描画の経路では、描画例外が伝播し、描画抑制フラグを新たに残さないことを確認した。events/authDevices等の別ローダーや基本データ全体の描画整理は未実装。

従って本記録はCの対象範囲とE2の実装、D0/E0の判断の記録であり、第2段階全体や実環境受入の完了ではない。

## 戻し方

- C：extraの所有判定・集合指定描画と、本番記録の描画内Mapをそれぞれ戻せる。Bの予算・503待機・キャッシュ無効化の安全条件は残す。広範描画へ戻す場合は、旧実装の無関係なフォーム初期化が再発することも記録する。
- E2：起動/保存後の整理予約と整理処理を停止する。任意メタデータを残したまま旧コードで読める。DBや音声/チューナー/メトロノームデータを削除しない。
- D/E1：本番コード未変更。判断資料を残して保留を継続する。
