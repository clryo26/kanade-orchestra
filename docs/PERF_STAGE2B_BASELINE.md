# 第2段階B 修正前計測・試験（通信/認証）v1.0

初回計測: 2026-10-21 / ハーネス補強: 2026-10-22 / 資料v1.1 / 基準: 第2段階詳細設計v1.3

追記: 2026-10-22に先行範囲の実装を行い、現行の試験期待値は修正後へ更新した。本書の表と修正前JSONは履歴として維持する。現在の比較と残件は[実装記録](PERF_STAGE2B_IMPLEMENTATION.md)を参照。新しい出力はphase=afterであり、修正前の再取得ではない。

## 1. 実施範囲

第2段階Aの通信計画から「503→401→502」と「起動・復帰・複数401」の2シナリオを先行して固定した。通信の実装は変更していない。

- 試験: [test_perf_stage2_communication_baseline.test.js](../tests/frontend/test_perf_stage2_communication_baseline.test.js)
- 修正前の保存結果: [PERF_STAGE2B_BASELINE_BEFORE_20261021.json](PERF_STAGE2B_BASELINE_BEFORE_20261021.json)
- 読取対象の本番ソースはmain `9c76fd920fab12a1e3c5286c0c6adbc2e9099309` と同一。作業開始時の資料コミットは `3bbb1ad`。第1段階Bの実装は含まない。

実行環境はWindows、Node v24.18.0、Vitest 4.1.9。固定日時は2026-10-21 12:00 JST。実際の本番JSをNode VMへ読み込み、fetchは全件モック、待機は偽タイマーとした。実通信やブラウザでの所要時間の計測ではない。

## 2. 読み込むコードと計数

順序はstore/app_state、utils/cache、common_helpers/api_runtime、transport_retry、auth_feature、bootstrap_init。すべて本番ファイルから読み、同じロジックをテスト側に複製しない。bootstrap_init内のブロックスコープの2関数は、VM内だけに参照を公開するコードを挿入する。本番ファイルは変更しない。

fetch呼出位置でデータGET/認証GETの回数、URL、応答status、偽時刻を記録する。実際のapplyPortalAuthDevice/clearPortalAuthStateは処理を委譲するspyで数える。AUTH_END、保留操作再開、キャッシュ読書、選択した入口の呼出数も記録する。

fixtureは架空デバイスbaseline-device、架空団員701、一般権限、認証世代2026-10-21T02:00:00+00:00。ローカル認証キーはtrue、portalAuthVerifiedとessentialDataLoadedはfalse、確認時刻は初期値0。データGETのコンテキストが認証応答で別利用者へ変わる試験と混同しないよう、同一の既知の団員ID・権限・認証世代を先に設定する。したがって、実ブラウザの初回コールド起動や利用者切替の再現ではない。

各ケースでキャッシュ本文/ETagはなし。全モックstatusを消費し、GETマップ・認証の保留・タイマーが残らないことも確認する。認証GETはすべて正常な200で同じdeviceを返す。認証要求自身の503再試行は今回のシナリオに含めない。

## 3. 修正前の結果

| ID | 条件 | データ送信 | 認証送信 | 合計 | 認証の最大同時数 | apply / clear | AUTH_END |
|---|---|---:|---:|---:|---:|---|---:|
| B01 | 503→401→認証成功→502→200 | 4 | 1 | 5 | 1 | 1 / 0 | 0 |
| B02 | 503→502→401→認証成功→502→504→200 | 6 | 1 | 7 | 1 | 1 / 0 | 0 |
| B03 | 起動入口＋復帰入口2回＋異なるURLのGET2本が401 | 4 | 4 | 8 | 4 | 4 / 0 | 2 |
| C01 | 同一URLのGETを同時に2回、401→認証成功→200 | 2 | 1 | 3 | 1 | 1 / 0 | 0 |
| C02 | 完了後に別の認証回復を開始（2回連続） | 0 | 2 | 2 | 1 | 2 / 0 | 0 |

### B01/B02: 再試行予算の作り直し

B01は/api/performancesに503、401、502、200を順に返す。初回の503で250ms待ち、401確認後の再送に新しい予算が付き、502で再び250ms待つ。偽タイマーの経過は合計500ms。

短いこの系列だけでは「最大6回」の証明にならない。そこでB02は、初回のtransportで503/502/401を返し、401回復後のtransportで502/504/200を返す。待機は250/750/250/750msで合計2000ms。1件のデータ論理要求から6回送信される上限の具体例を固定した。いずれも認証GETは別計数の1回。

この経過時間は設定された待機の合計であり、実ネットワーク遅延・CPU・画面の完了時間ではない。

### B03: 認証確認の未集約

同じVMで次を開始し、認証応答を一旦すべて保留する。

1. 実際の_runAuthAndStartを呼ぶ。
2. 実際のsyncPortalSessionOnResumeを2回呼ぶ。
3. /api/performancesと/api/schedulesのrequestを同時に開始し、どちらも最初に401を返す。
4. 偽時刻を進めずに送信/応答処理のmicrotaskを処理する。2本のデータGETが401まで到達したことを確認する。
5. 認証応答をまとめて解放し、各入口の完了を待つ。解放条件を「認証が4本に達したら」にしていないので、共有化後も同じ順序を再生できる。

復帰処理内の既存ガードは働き、2回目の復帰から追加の認証は送られない。一方、起動1本＋復帰1本＋401回復2本の計4本は相互に合流しない。各200の適用でapplyと保留ファイル操作再開が4回、起動/復帰のisPortalAuthenticatedからAUTH_ENDが2回発生した。

enterPortal、loadEssentialData、保留ファイル操作再開はスタブ。実装を実行したのは送信/認証/復帰の対象関数であり、その先のbootstrap・actor・画面描画は今回の送信件数に含めない。DOMContentLoadedやpageshow/visibilitychangeの実イベントは発火しておらず、実BFCache復帰を確認したという意味ではない。

### 対照試験

C01では既存のinFlightGetRequestsが働き、同一URLを2回呼んでも1つのGET処理へ合流する。B03は異なるURLを選び、このデータGET集約によって認証の未集約が隠れないようにした。

C02では前の認証回復が完了してから次を開始する。2回とも実際に認証GETを送る既存契約を固定し、共有化で完了した認証結果をキャッシュしてしまわないための対照とした。

## 4. 修正後の比較方法

- B01/B02とB03の入力・呼出順・認証応答を解放する順序を維持して再実行する。
- データの一時的追加最大2回、401後は別枠1回、共有認証は別予算という3枠を別に数える。理由不明503の追加は一時的予算内1回。
- B01は既にデータ4回なので、通信数だけでは予算の修正を判定できない。消費状況と次の再試行可否も試験する。
- B02は修正後に200へ到達する前に打切り得る。旧版の成功を要求して再試行を増やさず、送信上限と終了状態を一緒に比較する。
- B03の同コンテキストの認証初回送信は1回を目標とする。各関数の送信前条件・mark・戻り値・副作用は既存契約を維持し、認証を1本にしたことだけを理由にapplyも1回へ変更しない。
- 同device再ログイン・clear・世代の相違・保存だけによるepoch変更は、認証副作用資料の別の競合試験で確認する。今回のB03でそれらまで検証したとは扱わない。
- ソース6ファイルとハーネスのSHA-256を修正前JSONに保存した。修正後も別ファイルに結果を残し、環境差とソース差を追跡する。

この5件は既存挙動を固定するcharacterization testである。第2段階Bで意図した挙動を変更する際は、旧JSONを保存したまま、承認済みの目標に合わせて期待値をレビューして更新する。悪い既存挙動を恒久的な受入条件にしない。archived JSONをCIから自動更新しない。

## 5. 再実行

通常の試験（結果JSONを書き出さない）:

```powershell
npm.cmd run test:frontend -- tests/frontend/test_perf_stage2_communication_baseline.test.js
```

計測結果を別ファイルへ出力する場合:

```powershell
$env:PORTAL_PERF_STAGE2_BASELINE_REPORT = '.tmp/perf-stage2-baseline/recheck.json'
try {
    npm.cmd run test:frontend -- tests/frontend/test_perf_stage2_communication_baseline.test.js
    if ($LASTEXITCODE -ne 0) { throw 'baseline tests failed' }
} finally {
    Remove-Item Env:PORTAL_PERF_STAGE2_BASELINE_REPORT
}
```

出力はリポジトリ内.tmp配下だけを許可する。5ケースすべてで検証を通過した結果が揃った場合だけJSONを出力する。修正前保存JSONは手動で一度保存した成果物であり、再実行では上書きしない。

## 6. 確認結果と未確認事項

実行結果:

- 追加の5試験が通過。
- フロント全体1,196件が通過、失敗・保留0件。全体の結果JSONは.tmp/perf-stage2-baseline/vitest-all.json。
- 追加試験ファイルのnode --check通過。本番フロント構文検査170ファイル通過。
- 2026-10-21の計測時、同じ5試験を別の出力先で再実行し、保存済みJSONとSHA-256が完全一致した。本番ソース6ファイルと当時の試験ハーネスのハッシュも確認した。以下のハーネス補強後は、ハーネスのハッシュと追加項目が変わるため、JSON全体の一致とは扱わない。

最初の実行ではテストハーネスからブロックスコープの起動関数を参照できず1件失敗した。VM内だけの参照公開を追加し、再実行で5件通過した。本番コードの不具合としては扱わない。

未実施: 実ブラウザ/HAR/実BFCache/画面比較/実機iPhone、SQL・last_seen実更新・プール待ち、GCS、転送量・圧縮・実待ち時間、バックエンド試験。このJSONのdbQueries/lastSeenWritesは未計測を示すnullであり0ではない。

今回は第2段階Aの先行2シナリオを固定した範囲。既知503、Retry-After、手動再試行、古い認証応答、P/S/Fの結果不明、ETag/304、権限別HTTPキャッシュなどの試験・対象別計測は残る。#145/#146の再現試験・修正も含めていない。これを第2段階A全体完了や第2段階B実装済みとは扱わない。

## 7. 2026-10-22のハーネス補強

本番ソースを変えずに、レビューで指摘された2点を補強した。

- bootstrap_initのVM評価後に、公開したstart/resumeが関数であることと、名前がそれぞれ_runAuthAndStart/syncPortalSessionOnResumeであることを検査する。挿入位置がずれた場合は、対象ファイル・キー・期待する関数名が分かるメッセージで失敗する。末尾への挿入方法そのものを汎用的なソース変換へ置き換えたわけではない。
- setTimeoutの全予定を、delayMs・呼出元source・scheduledAtMs・firedAtMs・cancelledAtMsとしてtimerSchedulesに記録する。キャンセルされた取得timeoutも残す。値が250/750かで記録対象を選別しない。
- 呼出スタック上の最初の本番ソースからtransport-retry/api-runtime/otherへ分類し、transport-retryの予定値を従来のretrySleepsMsへ集計する。現状のapi-runtime分は取得timeoutだが、将来もその用途しかないと仮定しない。出所を判別できないタイマーもotherとして全記録に残す。処理を別ファイルへ移した際は分類を再確認する。
- 記録器の自己試験を1件追加。VM上の合成呼出しで1,000msのretry分類、17msのother分類、実際の認証確認でキャンセルされた10,000msのtimeoutを確認する。これは記録器の試験であり、本番が既にジッターを実装したという計測ではない。

通常の実行コマンドは同じ。元の5シナリオ＋記録器自己試験の計6件が通過した。JSONのscenarioは元の5件だけで、合成の自己試験は混ぜない。

出力schemaVersionは2（timerSchedules追加）。従来のretrySleepsMsや各送信・副作用項目を維持し、修正前のschemaVersion=1の保存JSONは変更していない。新しい結果は.tmp/perf-stage2-baseline/harness-20261022.jsonへ出力した。

確認結果:

- 元の5シナリオの既存全項目（input/calls/偽経過時間/未計測nullを含む）が保存JSONと一致。
- 本番ソース6ファイルのハッシュは保存JSONと一致。ハーネスのハッシュは補強に伴い変更。
- 6件を含む関連5ファイルの53試験が通過、失敗・保留0。結果は.tmp/perf-stage2-baseline/harness-related-20261022.json。
- node --checkとgit diff --check通過。本番srcと保存済みJSONに差分なし。

フロント全体1,196件と170ファイルの構文確認は前節の初回計測時の結果。今回、フロント全体・バックエンド・ブラウザ・実機・実DBの再検証は行っていない。
