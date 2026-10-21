# 第2段階A 認証確認の副作用比較表 v1.0

作成日: 2026-10-21 / 資料 v1.1 / 基準: 第2段階詳細設計 v1.3

調査対象コミット: `a50e0923dffd8ba9da243e841d699531e9ebc8fc`

資料の配置先はmain（`9c76fd920fab12a1e3c5286c0c6adbc2e9099309`）起点の専用ブランチ。上記の認証関数は両コミットで同一であり、第1段階Bの実装をこのブランチへ取り込まない。

現状を固定するための比較である。以下の差異を不具合と決めつけて揃えない。ソース変更・テスト実行・実API呼出しはしていない。

## 1. 対象と呼出元

| 関数 | 根拠 | 主な呼出元 |
|---|---|---|
| isPortalAuthenticated(options={}) | src/static/js/auth_feature.js:46–101 | bootstrap_init.jsの起動 `_runAuthAndStart`、復帰 `syncPortalSessionOnResume`（forceVerify=true） |
| tryRecoverPortalSession(deviceId) | src/static/js/modules/common_helpers/api_runtime.js:189–218 | request()の通常GET・P・更新の401回復、scores/sheet_api.jsの401回復 |

両者とも送信時はGET `/api/auth/devices/{encodedDeviceId}`、X-Device-Id、10秒のfetchWithTimeout。transport_retry.jsの既存GET再試行が適用される。現在は相互にも同一関数内にも認証確認の実行中共有がない。復帰関数には別にportalResumeSyncInFlightのガードがある。

GETだがサーバー `src/backend/auth_api.py:216–282` は認証済みデバイスのlast_seen_atを更新する。共有化の効果を測る場合、HTTP送信だけでなく実更新数も記録する。READ ONLYの読取コンテキストには入れない。

## 2. 送信前条件・戻り値

| ケース | isPortalAuthenticated | tryRecoverPortalSession |
|---|---|---|
| portalAuthVerified=true、forceVerifyなし | 通信なし。AUTH_END=authenticated。{status:authenticated,device:null,error:null} | この省略条件なし |
| forceVerify=true | 上記の省略だけを回避。以降のlocalStorage条件は残る | options引数はない |
| deviceIdなし | 通信なし。AUTH_END=unauthenticated。状態をclearしない | 通信なし。clearPortalAuthState()、false |
| PORTAL_AUTH_KEYがtrueでない | 通信なし。AUTH_END=unauthenticated。状態をclearしない | この省略条件なし。deviceIdがあれば送信 |
| deviceIdの取得元 | 関数内でlocalStorageから読む | 呼出元の引数 |
| 通信不能等 | unavailableとerrorを返し、AUTH_ENDを記録 | false。AUTH_ENDなし |

送信前条件を共有関数へ移さない。片方の省略をもう片方へ適用してはいけない。

## 3. 応答別の現状

通常のJSONオブジェクトを前提とした表。例外は各関数のcatchへ入る。

| 応答 | isPortalAuthenticated | tryRecoverPortalSession | 判定 |
|---|---|---|---|
| 401/403/404 | clear、AUTH_END=unauthenticated、3状態の未認証 | clear、false | clear条件は同じだが戻り値とmarkは別 |
| その他の非2xx（503等） | 認証状態を維持。AUTH_END=unavailable、HTTPエラーを格納 | 認証状態を維持、false | 副作用移動の必要なし |
| 2xx＋JSON不正/空本文 | json失敗を{}にしてclear。AUTH_END=unauthenticated | 同じくclear、false | 不正本文を共有側で正常と扱わない |
| 2xx＋authenticatedが偽/欠落、またはpayload=null | clear、AUTH_END=unauthenticated | clear、false | truthy/falsyの既存判定を保持 |
| 2xx＋authenticatedが真、deviceが正常オブジェクト | apply(device)、AUTH_END=authenticated、deviceを返す | apply(device)、true | 現時点は各呼出元で適用する |
| 2xx＋authenticatedが真、deviceが欠落/null/false | apply(device || {})。空オブジェクトでも認証済み状態を設定し、authenticatedを返す | !payload.deviceなのでclear、false | **実在する差異。共通の成功/失敗判定に統一しない** |
| 2xx＋authenticatedが真、deviceがtruthyな非オブジェクト | applyは型検査で何もせず、authenticatedと元のdeviceを返す | applyは何もせず、true | 今回新たなスキーマ拒否を追加しない。別途是正する場合は独立判断 |
| timeout・network・abort等の送信例外 | 状態維持、AUTH_END=unavailable、errorを返す | 状態維持、false | timeout/abortを再試行対象へ広げない |
| apply処理自体の例外 | catchでAUTH_END=unavailable。既に起きた状態更新は自動では巻き戻らない | catchでfalse。同じく自動巻戻しなし | 副作用の例外処理も一律変更しない |

`isPortalAuthenticated` は成功とみなす条件と返却deviceに `|| {}` / `|| null` を使う一方、回復側はdeviceの存在を要求している。共有する応答分類は、HTTP状態・JSON解釈の成否・payloadを提供し、この差を消さないものとする。

## 4. apply/clearが実際に持つ副作用

根拠: api_runtime.js:123–165。両関数から呼ばれるが、呼ぶ条件は前表のとおり異なる。

| 処理 | 現在の副作用 |
|---|---|
| clearPortalAuthState | portalResponseEpochを増加。チューナー退出、楽譜同期リセット、保存ダイアログ終了。PORTAL_AUTH_KEYを削除。認証・取得時刻・ロードフラグ・利用者・権限・役割を解除。団員詳細のデータ/状態/Promiseと紹介キャッシュをクリア |
| applyPortalAuthDevice | deviceの型を確認。認証世代、認証済みフラグ、確認時刻、団員ID/名前/権限/パート/hidden/担当フラグを設定。PORTAL_AUTH_KEY=true。portalFileOperationsResumeを開始 |
| AUTH_END | isPortalAuthenticated側で各戻り分岐に記録する。tryRecoverPortalSessionにはない |

applyの回数を減らすと、保留ファイル操作の再開回数にも影響し得る。clearの回数を減らすとepoch・楽譜・チューナーの副作用も変わる。このため「通信を1回にしたからapply/clearも1回」を今回の前提にしない。

## 5. 共有化の境界（設計v1.3の具体化）

| 処理 | 今回の判断 |
|---|---|
| 送信前条件 | 各公開関数に残す |
| 実行中のGET送信と一時的再試行 | 同一デバイス・認証コンテキストで共有する候補 |
| Response本文の読取 | 共有側で解析済み結果にし、同じResponseを複数回読まない |
| 応答の分類 | status、本文の解釈成否、payloadなど両者に必要な情報を保持する。最終の認証済み判定を一律化しない |
| 戻り値への変換・AUTH_END | 各公開関数に残す |
| apply/clear | **現時点で共有側への移動を許可する副作用はない。** 各関数に残す。完全な同一性を試験で立証できたものだけ後から判断 |
| 完了結果 | 新たな要求横断の認証キャッシュにしない |
| 予算 | 共有認証要求自身の一時的追加最大2回、unknown503は内数1回。データ要求の一時的予算/401後再送と別枠。合流数で増加しない |

同じ応答から両方の公開関数が戻る場合、外側の既存処理がそれぞれ動く可能性を保つ。これによる副作用を無条件に一度へ変更することは、v1.3の最小変更の範囲に含めない。

## 6. 古い認証応答の破棄

設計上の追加条件であり、現在実装済みとは扱わない。

- 送信開始時のデバイス・認証コンテキストを保持する。
- 外側の各関数でapply/clearの直前にも有効性を確認する。
- ログアウト、別利用者ログイン、同じデバイスでの再ログインを跨いだ応答で状態を適用/解除しない。
- 古い終了処理で新しい実行中Promiseを解除しない。
- 古い応答を捨てた要求から旧利用者のデータ再送を行わない。

認証コンテキストの判定には、deviceId、portalAuthGeneration、認証状態の消去と明示的ログインのときだけ進めるローカル遷移カウンターの組合せを採用する設計とする。カウンターは現在未実装であり、保存成功・キャッシュ無効化・通常のapplyでは進めない。portalResponseEpochはデータ保存でも変わるため、認証切替の判定には使わない。

通常の再確認では最初のapply後も同じ認証世代なので、2番目の合流呼出元を外部切替と誤認しない。開始世代が空、または応答で世代が更新された場合も別ケースとして固定し、同じ共有結果による正当な世代適用と、別のログインによる失効を区別する。片方がclearした場合は遷移カウンターが進み、古い応答から認証を復活させない。副作用を共有側へ移す意味ではない。

共有化前の競合試験には、(1)先行applyで同一世代、(2)保存によるepoch変化だけ、(3)clear、(4)同device再ログイン、(5)別device/別利用者、(6)開始世代と応答世代の相違を入れる。明示的ログインでカウンターを進める位置、他タブからの認証変更の検知方法も、既存ログイン・ログアウトの全入口を確認してから実装する。

## 7. 試験の準備と既存試験

既存: `tests/frontend/test_startup_auth_states.test.js` はisPortalAuthenticatedの3状態、強制確認、clearの時刻リセットを扱う。今回読取のみで、実行・網羅性の保証はしていない。

| 試験候補 | 固定する条件 |
|---|---|
| 送信省略の組合せ | verified/force/local auth key/device有無を両関数で個別確認。無通信分岐でも既存mark/clearを保持 |
| HTTPと本文の表 | 401/403/404、500/503、正常JSON、不正JSON、空、null、authenticated欠落、device欠落/null/型違い |
| 副作用の回数・内容 | apply/clear/AUTH_ENDと、applyに伴う保留操作再開を捕捉。通信共有を副作用の一律1回化と混同しない |
| 同時呼出 | 同一関数同士、起動/復帰と401回復、異なる認証コンテキスト。初回送信数と予算を別計数 |
| 応答共有 | 本文を1回だけ解析し、各関数で既存の最終判定を行える |
| 古い応答 | 成功/401両方の応答順逆転、ログアウト、他利用者、同デバイス再ログイン、古いfinallyが新Promiseを消さない |
| 正当な先行適用 | 共有結果の最初の適用を、他の合流呼出元が外部切替と誤認しない |
| 認証確認のDB効果 | 実環境のlast_seen更新数と接続取得を測定。ローカルモックでDB効果を確定しない |

## 8. 監査・第3段階との境界

ここでの認証確認の共有はフロントの実行中通信が対象。監査用request.stateやDB代替認証の取得元を変更する作業はまだ行わない。

監査主体の再利用可否は後続一覧で決定する。fallback_auth_device使用・取得元不明・同一性を保証できない経路は再利用しない。監査のactor取得ではデバイスと団員の取得、INSERTの接続を経路別に測る。共通プール最大5に含め、別枠で二重計上しない。

## 9. レビュー依頼点

1. device欠落時を含む既存差異の記述と、apply/clearを外側に残す判断。
2. D07/D08、D05/D06、D16/D17にまたがる一時的予算の引継ぎ対象。
3. 正当な先行適用と外部の認証切替を区別する条件を、共有化前に試験で固定する段取り。

これらの資料のレビュー後も、状態対応表・描画依存・v2項目契約・監査可否・対象別の修正前計測が完了するまで、第2段階全体の実装着手条件が揃ったとは扱わない。
