# Issue #150 設計v1.0レビューの追跡資料

2026-10-24。状態: 2026-10-24、PUBLICリポジトリと確認し、ユーザーが確認した非機密の原稿を公開可能と判断して送信済み。Issue #150のコメント1件と別Issue #151〜154を作成し、全本文を原稿と照合した。記録は [投稿検証JSON](perf_stage4/ISSUE150_PUBLICATION.json)。以下は実際の投稿本文。ソース修正は含めない。

## Issue #150への追記（[投稿済み](https://github.com/clryo26/kanade-orchestra/issues/150#issuecomment-6377528084)）

Issue #150の別仕様・詳細設計を調べた結果、写真に加えて作成者の2項目も、省略PUTで失われる経路を確認しました。

- 名前だけのpayloadを本番の `build_update_mutate("albums", …)` へ渡すと、`created_by_member_id` / `created_by_member_name` が結果に含まれません。
- 本番の `db_row_tuple` でこの2列のUPDATE値へ変換するとNULL/NULLとなります。今回実DBへの書込は行っていません。
- そのままではアルバム作成者の情報が失われ、後続の編集・削除の認可に影響するおそれがあります。

本Issueの修正に「省略された作成者ID・名前は、ロック後の現在行から維持する」を含める方針です。明示された値の既存の認可・処理は変えず、所有者移管の新制度は導入しません。

詳細設計: `docs/ALBUM_PUT_PHOTOS_DETAILED_DESIGN.md` のAP150-R05/R06、証拠: `docs/perf_stage4/ISSUE150_CONTRACT_BEFORE.json`（基準0060e1c）。資料はローカルブランチにあり未push、修正実装はまだ行っていません。4C着手前の修正レビューと、4C実装後/4D有効化前の回収候補との整合試験は分けて追跡します。

## [Issue #151](https://github.com/clryo26/kanade-orchestra/issues/151): 不具合候補: 演奏会の専用PUTでpiecesを省略すると曲目が失われる

## 確認した経路

`PUT /api/performances/{id}` の更新サービスで、曲目piecesを省略したpayloadが `_normalize_performance` によりpieces:[]となり、currentとのmerge後も空配列が優先されます。汎用 `/api/extra/performances/{id}` はCollection not foundの404であり、この入口の問題ではありません。

本番 `performance_service.update_performance` と架空のListRowStoreで、曲目1件→省略更新後0件を確認しました。flyer keep・操作キーなしの経路です。操作キー/ファイル操作経路の追加検証は残っています。

## 証拠の範囲

2026-10-24、基準 `6fc739e`。`docs/perf_stage4/ISSUE150_SIBLING_COLLECTION_AUDIT.json` に記録した調査です。本番サービス・現在行に対する認可分岐・ListRowStoreを使い、load/saveだけを架空のメモリ辞書に置換しました。DB子行変換も本番の関数を使用しています。DB/GCS/外部URL呼出しは禁止しています。

これはHTTP/認証ミドルウェア/実PostgreSQLの実行結果ではなく、実環境のデータ損失も確認していません。資料は未pushのローカル成果物です。Issue #150のアルバム修正とは別に扱い、4C/4Dの直接の着手・有効化条件に追加しません。

## 完了条件

- [ ] 実際の入口と呼出元、現在行のmerge・入力既定値・省略/空/null/部分集合の契約を確認し、意図した置換と事故による省略を区別する。
- [ ] 各集合専用の修正仕様を決める。albumsの保持規則を共通helperで一律適用しない。
- [ ] 本物router・モデル・サービス・repositoryと隔離PostgreSQLで再現し、ローカルとの差、認可、期待版、rollback、監査を検証する。
- [ ] 既存の明示的な削除・投票取消・料金編集・配役編集を壊さない回帰試験を作る。
- [ ] 実データの欠損調査と修復の要否を別に判断する。本起票では実DBやファイルの修復・削除・設定変更を行わない。

## [Issue #152](https://github.com/clryo26/kanade-orchestra/issues/152): 不具合候補: 会計の汎用PUTで料金の子項目を省略すると明細や金額が失われる

## 確認した経路

`PUT /api/extra/payments/{id}` → `extra_service.update_item` は現在行と子mapをmergeしません。performance_feesとperformance_fee_amountsを両方省略すると、架空の保存状態から両mapが落ち、DB子行変換は2明細→0明細となりました。performance_feesだけを送る場合も、2明細は残りますがfee_amountが100/200から0/0へ変換されました。

一方 `payment_service.update_payment` はcurrentとmergeし、両mapの省略でも子情報を保持しました。ただし現行paymentsルーターは空で、このサービスがHTTPの汎用入口を保護しているわけではありません。

`modules/payments.js::savePaymentStatus` の通常の画面保存がこの経路に該当します。performance_feesだけを送り、performance_fee_amountsは送りません。フロント全体でも後者は読取helper内の参照だけで、送信する箇所は見つかりませんでした。したがって、通常の支払状況保存でも、該当する会計の明細金額を0で書き直すコード経路を通ります。

一方、画面が表示する金額は演奏会ごとのperformance_fee_amountです。会計ごとの金額を読むperformanceFeeAmountMapは定義以外の参照がなく、会計ごとの金額は現行画面に表示されず、フロントからも送られません。このため影響は限られる見込みで、既存のfee_amountも画面以外から設定されたものを除いて0である可能性があります。ただし実DBの値・書換履歴・経済的影響は確認しておらず、実際に常に0だとは断定しません。

## 証拠の範囲

2026-10-24、基準 `6fc739e`。`docs/perf_stage4/ISSUE150_SIBLING_COLLECTION_AUDIT.json` に記録した調査です。本番サービス・現在行に対する認可分岐・ListRowStoreを使い、load/saveだけを架空のメモリ辞書に置換しました。DB子行変換も本番の関数を使用しています。DB/GCS/外部URL呼出しは禁止しています。

これはHTTP/認証ミドルウェア/実PostgreSQLの実行結果ではなく、実環境のデータ損失も確認していません。資料は未pushのローカル成果物です。Issue #150のアルバム修正とは別に扱い、4C/4Dの直接の着手・有効化条件に追加しません。

## 完了条件

- [ ] 実際の入口と呼出元、現在行のmerge・入力既定値・省略/空/null/部分集合の契約を確認し、意図した置換と事故による省略を区別する。
- [ ] 各集合専用の修正仕様を決める。albumsの保持規則を共通helperで一律適用しない。
- [ ] 本物router・モデル・サービス・repositoryと隔離PostgreSQLで再現し、ローカルとの差、認可、期待版、rollback、監査を検証する。
- [ ] 既存の明示的な削除・投票取消・料金編集・配役編集を壊さない回帰試験を作る。
- [ ] 実データの欠損調査と修復の要否を別に判断する。本起票では実DBやファイルの修復・削除・設定変更を行わない。

## [Issue #153](https://github.com/clryo26/kanade-orchestra/issues/153): 不具合候補: 配役の汎用PUTでmembersやextrasを省略すると子集合が失われる

## 確認した経路

`PUT /api/extra/castings/{id}` → `extra_service.update_item` は現在行と子集合をmergeしません。本番サービスと架空ListRowStoreで、members1/extras1の保存状態から両方省略すると両方0件、membersだけを明示するとmembers1/extras0になることを確認しました。DB子行変換でも同じ件数です。

現行 `modules/practice_casting/api.js` の保存payloadはmembers/extrasの両方を送るため、この確認だけで画面からデータ損失が起きたとは扱いません。動的・外部利用は未確認です。

## 証拠の範囲

2026-10-24、基準 `6fc739e`。`docs/perf_stage4/ISSUE150_SIBLING_COLLECTION_AUDIT.json` に記録した調査です。本番サービス・現在行に対する認可分岐・ListRowStoreを使い、load/saveだけを架空のメモリ辞書に置換しました。DB子行変換も本番の関数を使用しています。DB/GCS/外部URL呼出しは禁止しています。

これはHTTP/認証ミドルウェア/実PostgreSQLの実行結果ではなく、実環境のデータ損失も確認していません。資料は未pushのローカル成果物です。Issue #150のアルバム修正とは別に扱い、4C/4Dの直接の着手・有効化条件に追加しません。

## 完了条件

- [ ] 実際の入口と呼出元、現在行のmerge・入力既定値・省略/空/null/部分集合の契約を確認し、意図した置換と事故による省略を区別する。
- [ ] 各集合専用の修正仕様を決める。albumsの保持規則を共通helperで一律適用しない。
- [ ] 本物router・モデル・サービス・repositoryと隔離PostgreSQLで再現し、ローカルとの差、認可、期待版、rollback、監査を検証する。
- [ ] 既存の明示的な削除・投票取消・料金編集・配役編集を壊さない回帰試験を作る。
- [ ] 実データの欠損調査と修復の要否を別に判断する。本起票では実DBやファイルの修復・削除・設定変更を行わない。

## [Issue #154](https://github.com/clryo26/kanade-orchestra/issues/154): 不具合候補: 希望曲のPUTでvotesを省略すると操作した本人の票が除かれる

## 確認した経路

希望曲は `desired_piece_merged_votes` が他人の票を維持するため、votes省略ですべての票が無条件に消えるわけではありません。しかし省略payloadには本人の票もないため、現在の本人票が戻り値から除かれます。

本番 `extra_service.update_item` と架空ListRowStoreで、作成者本人の1票のみ→省略で0票、本人+他人の2票→他人の1票、投票していない管理者が省略→他人の1票を維持、の3ケースを確認しました。希望曲の題名は変えず、参考音源URLは空なので外部検証を呼びませんでした。

投票の明示的な取消と項目省略を同一視することが意図した契約かは未確定です。現行の投票呼出元はvotesを明示しており、実画面での不具合発生は未確認です。

## 証拠の範囲

2026-10-24、基準 `6fc739e`。`docs/perf_stage4/ISSUE150_SIBLING_COLLECTION_AUDIT.json` に記録した調査です。本番サービス・現在行に対する認可分岐・ListRowStoreを使い、load/saveだけを架空のメモリ辞書に置換しました。DB子行変換も本番の関数を使用しています。DB/GCS/外部URL呼出しは禁止しています。

これはHTTP/認証ミドルウェア/実PostgreSQLの実行結果ではなく、実環境のデータ損失も確認していません。資料は未pushのローカル成果物です。Issue #150のアルバム修正とは別に扱い、4C/4Dの直接の着手・有効化条件に追加しません。

## 完了条件

- [ ] 実際の入口と呼出元、現在行のmerge・入力既定値・省略/空/null/部分集合の契約を確認し、意図した置換と事故による省略を区別する。
- [ ] 各集合専用の修正仕様を決める。albumsの保持規則を共通helperで一律適用しない。
- [ ] 本物router・モデル・サービス・repositoryと隔離PostgreSQLで再現し、ローカルとの差、認可、期待版、rollback、監査を検証する。
- [ ] 既存の明示的な削除・投票取消・料金編集・配役編集を壊さない回帰試験を作る。
- [ ] 実データの欠損調査と修復の要否を別に判断する。本起票では実DBやファイルの修復・削除・設定変更を行わない。
