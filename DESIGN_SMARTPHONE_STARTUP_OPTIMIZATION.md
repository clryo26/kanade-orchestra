# 奏オケポータル スマートフォン初回読み込み改善 実装設計書

- 文書種別: 実装設計書
- 対象システム: 奏オケポータル
- 対象ブランチ: `main`
- 設計基準コミット: `1e77e182230ebac93d01d930da00f4f52ea06b97`
- 作成日: 2026-07-31
- 想定読者: 実装担当者、コードレビュー担当者、テスト担当者

---

## 1. 背景

奏オケポータルは、本番運用開始後、団員の大半がスマートフォンから利用することを想定している。

現在、次の事象が報告されている。

- 初回アクセス時の読み込み時間が長い。
- セッション切れ後または画面復帰後の読み込みにも時間がかかることがある。
- 最悪の場合、画面が真っ白な状態で停止し、利用者が復旧方法を判断できない。

本番運用開始前に、スマートフォンでの起動安定性を最優先で改善する必要がある。

---

## 2. 目的

本修正の目的は次の3点である。

1. JavaScript、認証API、初期データAPIのいずれかで異常が発生しても、真っ白な画面を表示し続けない。
2. 起動処理の各区間を計測し、遅延箇所を客観的に特定できる状態にする。
3. 初回表示に不要な処理・ファイルの読み込みを遅延させ、スマートフォンでの初回操作可能時間を短縮する。

---

## 3. 設計根拠と確認範囲

### 3.1 確認したソース

情報源に格納されたZIPのGit HEADは次のコミットである。

```text
46fa7499566cff2fb8939866ba76ba8975952dcc
```

GitHub上の最新`main`は次のコミットである。

```text
1e77e182230ebac93d01d930da00f4f52ea06b97
```

GitHubのコミット比較結果では、`46fa749...`から`1e77e18...`までの変更ファイルは0件である。したがって、ZIP内のソース内容は本設計時点の最新`main`と同一として扱う。

### 3.2 確認済み事実

- `src/index.html`には`script`要素が71本ある。
- 71本のうち、ローカルJavaScriptは70本、外部JavaScriptはBootstrap 1本である。
- ローカルJavaScript70本の非圧縮ファイルサイズ合計は516,754バイトである。
- 各スクリプトには`defer`または`type="module"`が付与されていない。
- スクリプトは`body`末尾で記述順に読み込まれる。
- Bootstrap CSSとBootstrap JavaScriptは`cdn.jsdelivr.net`から取得する。
- 起動処理は`src/static/js/modules/common_helpers/bootstrap_init.js`の`DOMContentLoaded`イベントから開始する。
- IndexedDB初期化には3秒のタイムアウトが実装されている。
- 端末認証確認、`/api/bootstrap-lite`、セッション復旧処理には明示的な通信タイムアウトがない。
- `enterPortal()`はログインパネルを非表示にした後、`loadEssentialData()`を待たずに処理を戻す。
- `loadEssentialData()`は`/api/bootstrap-lite`を取得後に主要画面を描画する。
- GET通信失敗時、IndexedDBにキャッシュがあれば保存済みデータを返す実装が存在する。
- IndexedDB上のETagは、ページ再読み込み後にメモリへ復元されない。
- 静的な`.js`、`.css`等のキャッシュ期間は1時間である。
- 起動区間を記録する`performance.mark()`、`PerformanceObserver`等は未実装である。

### 3.3 未確認事項

- 実機での各起動区間の現行所要時間。
- 真っ白停止時に実際に停止している処理。
- iPhone SafariとAndroid Chromeの発生率の差。
- Cloud Runのコールドスタート所要時間。
- Neonへの初回接続確立時間。
- `/api/auth/devices/{deviceId}`と`/api/bootstrap-lite`の本番実測応答時間。
- 最新`main`のコミットSHAと本番・テスト環境の稼働リビジョンとの対応関係。

未確認事項を事実として扱わず、Phase 1およびPhase 2で計測可能にする。

---

## 4. 現行起動シーケンス

```text
ブラウザが index.html を取得
    ↓
外部Bootstrap CSSを取得
    ↓
HTML本文を解析
    ↓
body末尾でJavaScript 71本を順次取得・評価
    ↓
DOMContentLoaded
    ↓
IndexedDB初期化（最大3秒）
    ↓
画面初期設定・イベント登録
    ↓
isPortalAuthenticated()
    ↓
端末認証API
    ↓
認証済みの場合 enterPortal()
    ↓
ログイン画面を非表示
    ↓
仮表示・ローディング表示
    ↓
/api/bootstrap-lite
    ↓
主要データ反映・主要画面描画
    ↓
アイドル時間後 /api/bootstrap-core
    ↓
背景画面描画
```

### 4.1 現行構造の問題

#### P-01: JavaScript実行前のフェイルセーフ表示がない

`DOMContentLoaded`より前にスクリプト読込または評価が停止すると、アプリ側のエラー表示処理へ到達できない。

#### P-02: 外部CDNの完了が初期表示品質に影響する

Bootstrap CSS・JavaScriptの取得失敗または遅延が、アプリ本体とは独立して発生し得る。

#### P-03: 通信待機が無期限になり得る

認証APIと初期データAPIに明示的なタイムアウトがなく、通信が完了も失敗もしない場合、利用者へ復旧手段を提示できない。

#### P-04: 認証済み画面への切替が初期データ取得完了より先行する

`enterPortal()`はログインパネルを隠した後、`loadEssentialData()`を待たずに終了する。このため、取得停止時に内容の薄い画面が長時間残る可能性がある。

#### P-05: 起動遅延の区間計測がない

Cloud Run、認証API、IndexedDB、JavaScript評価、画面描画のどこが主要因か判断できない。

#### P-06: 初回利用に不要な管理機能も事前読込される

管理画面、録音、楽譜、アルバム、支払、イベント等を含む多数のスクリプトが、利用者が該当画面を開く前に読み込まれる。

#### P-07: キャッシュのETagが再起動後に復元されない

データ本体はIndexedDBから取得できるが、ETagはメモリ上の`Map`のみで保持される。ページ再読み込み後はETagが空になり、条件付きGETを利用できない。

---

## 5. 問題分類

### 5.1 真っ白画面・操作不能

対象:

- スクリプト読込失敗
- JavaScript初期化例外
- 認証APIの無応答
- 初期データAPIの無応答
- 外部CDNの遅延または失敗

優先度: **最優先**

### 5.2 初回読み込み遅延

対象:

- JavaScript 71本の取得・評価
- Cloud Runコールドスタート
- 認証API
- `/api/bootstrap-lite`
- IndexedDB初期化
- DOM描画

優先度: **高**

### 5.3 セッション復帰時の遅延

対象:

- `visibilitychange`および`online`イベント時の認証確認
- 認証確認後の`loadEssentialData()`再取得
- 短時間の画面復帰でも同じ処理を行うこと

優先度: **高**

---

## 6. 基本方針

### 6.1 採用方針

1. 白画面防止と復旧導線を先に実装する。
2. 同時に計測を追加し、改善前後を比較できるようにする。
3. 起動処理の責務を変えすぎず、既存のグローバル関数構成を維持する。
4. 認証仕様、権限仕様、APIレスポンス形式は変更しない。
5. 読み込み本数削減は段階的に行い、一括でES Modulesや新ビルド基盤へ移行しない。
6. キャッシュ表示は、利用者へ保存済みデータであることを明示する。
7. 本番直前のため、Service Worker導入など更新事故の影響が大きい変更は今回の必須範囲に含めない。

### 6.2 今回採用しない案

| 案 | 判定 | 理由 |
|---|---|---|
| Vite等への全面移行 | 今回は不採用 | 変更範囲が大きく、本番直前の回帰リスクが高い |
| Service Workerによる全面キャッシュ | 今回は不採用 | 古い資産の残留、更新失敗、端末差の検証が必要 |
| APIレスポンス形式の全面変更 | 今回は不採用 | フロント・バック双方の影響範囲が大きい |
| Cloud Run設定の先行変更 | 今回は不採用 | 実測前に原因をCloud Runと断定できない |
| Neon設定の先行変更 | 今回は不採用 | 実測前にDB接続を主原因と断定できない |

---

## 7. 目標値

現行値は未計測であるため、次の値は**実装受入用の設計目標値**とする。

### 7.1 必須目標

| 指標 | 目標 |
|---|---:|
| HTML表示後に利用者向け状態表示が現れるまで | 1秒以内 |
| 真っ白画面の継続 | 0件 |
| 通信無応答時にエラー・再試行導線を表示するまで | 15秒以内 |
| 起動区間ログ欠落 | 0件 |
| 起動失敗時の復旧操作 | 画面上で1操作以内 |

### 7.2 性能目標

実機計測後、P50・P95を記録する。初期目標は次のとおりとする。

| 指標 | 通常回線 P50 | 通常回線 P95 |
|---|---:|---:|
| 静的起動画面表示 | 1秒以内 | 2秒以内 |
| 認証済みキャッシュ画面表示 | 2秒以内 | 4秒以内 |
| 最新主要データ反映 | 5秒以内 | 10秒以内 |
| セッション復帰後の操作再開 | 2秒以内 | 5秒以内 |

Cloud Runコールドスタートを含む場合は別集計する。

---

## 8. 改修フェーズ

## Phase 1: 白画面防止と通信停止対策

### 目的

処理がどこで失敗しても、利用者へ現在状態と復旧操作を表示する。

### 対象

- `src/index.html`
- `src/static/css/style.css`
- `src/static/js/modules/common_helpers/bootstrap_init.js`
- `src/static/js/modules/common_helpers/api_runtime.js`
- `src/static/js/modules/navigation/events.js`
- `src/static/js/auth_feature.js`
- 新規 `src/static/js/startup_guard.js`

### 実装内容

#### 8.1.1 静的起動画面

`src/index.html`の`main`より前、または`main`先頭に、JavaScriptなしでも表示される起動画面を追加する。

必須要素:

```html
<section id="portalStartupPanel" role="status" aria-live="polite">
    <h1>奏オケポータル</h1>
    <p id="portalStartupMessage">起動しています...</p>
    <button id="portalStartupRetryButton" type="button" hidden>再試行</button>
    <button id="portalStartupReloadButton" type="button" hidden>再読み込み</button>
</section>
```

要件:

- Bootstrap CSSが取得できなくても読める最小限のインラインCSSを`head`へ記述する。
- アプリ利用可能になるまで起動画面を非表示にしない。
- エラー時は再試行ボタンまたは再読み込みボタンを表示する。
- ログイン画面または主要画面の表示完了後にのみ起動画面を非表示にする。

#### 8.1.2 起動監視スクリプト

`startup_guard.js`はローカルスクリプト群より先に読み込む。

責務:

- 起動開始時刻を記録する。
- `window.onerror`を登録する。
- `unhandledrejection`を登録する。
- 一定時間内にアプリ準備完了通知がない場合、起動停止画面へ切り替える。
- 起動状態更新用の最小APIを`window.portalStartup`へ公開する。

公開API:

```javascript
window.portalStartup = {
    mark(name, detail),
    setMessage(message),
    showRetry({ message, retry }),
    showReload(message),
    ready(),
    snapshot(),
};
```

監視タイマー:

- 初期値: 15,000ms
- `ready()`実行時に解除する。
- タイムアウト値は`config.js`のアプリ設定から上書き可能にする。

#### 8.1.3 通信タイムアウト共通化

`api_runtime.js`へ共通fetch処理を追加する。

新規関数:

```javascript
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000)
```

仕様:

- 呼出元の`options.signal`がある場合は破棄しない。
- 内部`AbortController`と外部signalの双方を考慮する。
- タイムアウト時は識別可能な`PortalTimeoutError`を投げる。
- GET、POST、認証復旧時の再送すべてに適用する。
- `requestJson()`および`portalFetchJson()`の重複fetchも、利用箇所を確認したうえで共通処理へ寄せる。

設計値:

| 通信 | タイムアウト |
|---|---:|
| 端末認証確認 | 10秒 |
| `/api/bootstrap-lite` | 12秒 |
| `/api/bootstrap-core` | 20秒 |
| 通常GET | 15秒 |
| 更新系API | 20秒 |

タイムアウト値は定数化する。呼出箇所への数値直書きは禁止する。

#### 8.1.4 `enterPortal()`の完了条件修正

現行は`loadEssentialData()`を待たずに終了する。次の順序へ変更する。

```text
起動画面表示
    ↓
認証済みユーザー情報を適用
    ↓
キャッシュ済み主要データがあれば先行描画
    ↓
最新 /api/bootstrap-lite を取得
    ↓
主要画面を描画
    ↓
起動画面を非表示
    ↓
背景データ取得開始
```

`enterPortal()`は、少なくとも次のいずれかが完了するまでresolveしない。

- 最新主要データの反映完了
- 保存済み主要データの反映完了
- エラー画面の表示完了

Promiseを意図的に未待機にする場合は`void`を明記し、エラー処理を呼出先に持たせる。

#### 8.1.5 認証エラーと通信エラーの分離

`isPortalAuthenticated()`の現行実装は、通信エラーも`false`として扱う。

変更後:

- 認証されていない: `unauthenticated`
- 認証済み: `authenticated`
- 通信失敗またはタイムアウト: `unavailable`

戻り値候補:

```javascript
{
    status: 'authenticated' | 'unauthenticated' | 'unavailable',
    device: object | null,
    error: Error | null,
}
```

通信失敗時にログイン画面へ強制遷移させない。保存済みの認証情報とデータがある場合は、オフライン表示へ移行する。

### Phase 1完了条件

- JavaScript構文エラーを模擬しても真っ白にならない。
- 認証APIを無応答にしても15秒以内に復旧導線が表示される。
- `/api/bootstrap-lite`を無応答にしても15秒以内に復旧導線が表示される。
- エラー時にブラウザ更新以外の再試行操作が提供される。
- 正常起動時に起動画面が確実に消える。

---

## Phase 2: 起動計測

### 目的

遅延箇所を推測ではなく計測値で特定する。

### 対象

- `src/static/js/startup_guard.js`
- `src/static/js/modules/common_helpers/bootstrap_init.js`
- `src/static/js/auth_feature.js`
- `src/static/js/modules/bootstrap_loader.js`
- `src/static/js/modules/navigation/events.js`
- 必要に応じて新規バックエンドAPI

### 8.2.1 計測イベント

| イベント名 | 発生箇所 |
|---|---|
| `APP_START` | `startup_guard.js`先頭 |
| `DOM_INTERACTIVE` | `DOMContentLoaded`開始 |
| `IDB_START` | IndexedDB初期化直前 |
| `IDB_END` | IndexedDB初期化完了・失敗 |
| `UI_BIND_START` | 初期イベント登録直前 |
| `UI_BIND_END` | 初期イベント登録完了 |
| `AUTH_START` | 端末認証開始 |
| `AUTH_END` | 端末認証完了 |
| `CACHE_RENDER_START` | キャッシュ描画開始 |
| `CACHE_RENDER_END` | キャッシュ描画完了 |
| `BOOTSTRAP_LITE_START` | `/api/bootstrap-lite`開始 |
| `BOOTSTRAP_LITE_END` | 同完了 |
| `ESSENTIAL_RENDER_START` | 主要画面描画開始 |
| `ESSENTIAL_RENDER_END` | 主要画面描画完了 |
| `APP_READY` | 初回操作可能状態 |
| `BACKGROUND_START` | 背景データ取得開始 |
| `BACKGROUND_END` | 背景データ反映完了 |
| `STARTUP_FAILED` | 起動失敗画面表示 |

### 8.2.2 記録項目

```javascript
{
    name,
    elapsedMs,
    timestamp,
    online,
    visibilityState,
    navigationType,
    userAgentClass,
    cached,
    status,
    revision,
}
```

個人名、パスワード、端末IDの生値、APIレスポンス本文は記録しない。

### 8.2.3 保存先

Phase 2初期実装では以下を採用する。

1. `performance.mark()`および`performance.measure()`
2. `window.portalStartup.snapshot()`による開発者向け確認
3. 直近1回分を`sessionStorage`へ保存

本番集約APIへの送信は、ログ量、個人情報、保存期間を確定後に別対応とする。

### Phase 2完了条件

- 正常起動、キャッシュ起動、通信失敗のすべてで計測結果を取得できる。
- `APP_START`から`APP_READY`までの総時間を算出できる。
- 認証、API、描画の各区間を分離できる。

---

## Phase 3: 初期JavaScript読込削減

### 目的

初回操作に不要なコードの取得・評価を後回しにする。

### 前提

Phase 2の計測を先に導入し、変更前の基準値を取得する。

### 8.3.1 初期読込グループ

初回起動に必要なファイルを次の責務に限定する。

- 設定
- API共通処理
- キャッシュ
- ランタイム状態
- 起動監視
- 認証
- ナビゲーション最小機能
- ポータルホームの主要表示
- `bootstrap-lite`適用

### 8.3.2 遅延読込候補

次の機能は、該当タブ・管理画面を初めて開いた時点で読み込む候補とする。

- `modules/admin_system/**`
- `modules/performance_day/**`
- `modules/practice_casting/**`
- `modules/date_piece_promotion/**`
- `modules/recordings.js`
- `recordings_feature.js`
- `modules/members/**`
- `modules/payments.js`
- `modules/events.js`
- `modules/scores/**`
- `modules/albums.js`
- 管理者専用アップロード処理

### 8.3.3 ローダー設計

新規候補:

```text
src/static/js/utils/feature_loader.js
```

公開関数:

```javascript
loadFeatureScripts(featureName)
isFeatureLoaded(featureName)
```

要件:

- 同じ機能を重複ロードしない。
- 依存順序を定義できる。
- 読込失敗を利用者へ表示する。
- Promiseをキャッシュする。
- 画面遷移イベントは読込完了後に対象関数を呼ぶ。
- 既存グローバル関数の有無に依存した暗黙判定を最小化する。

### 8.3.4 `defer`適用

依存関係を維持したまま`defer`を付与できるファイルは、静的読込順を保持して`defer`化する。

注意:

- `defer`は記述順を保持するが、既存テストで順序を固定する。
- インラインスクリプトが途中に存在する場合は依存を確認する。
- `DOMContentLoaded`登録ファイルは、すべてのdeferスクリプト評価後に実行されることをテストする。

### Phase 3完了条件

- 初期ローカルJavaScriptのファイル数と合計転送量を変更前より削減する。
- 一般団員のトップ画面表示に管理者専用スクリプトが不要であることを確認する。
- 遅延対象画面を最初に開いた際、ローディング表示後に正常利用できる。
- 二回目以降の画面遷移で再読込しない。

---

## Phase 4: キャッシュおよび復帰処理改善

### 目的

再訪問時と画面復帰時に、保存済みデータを先に表示し、不要な再取得を抑制する。

### 8.4.1 IndexedDB ETag復元

`utils/cache.js`の`get()`を、データだけでなくETagと保存時刻も取得できる形へ拡張する。

候補API:

```javascript
async getEntry(key)
// { data, etag, timestamp } | null
```

`request()`は`getEntry()`からETagを取得し、ページ再読込後も`If-None-Match`を送信する。

既存`get(key)`は互換用として残す。

### 8.4.2 stale-while-revalidate表示

認証済みかつ`/api/bootstrap-lite`キャッシュがある場合:

1. 保存済みデータを先行描画する。
2. 「保存済みデータを表示中」を明示する。
3. 背景で最新データを取得する。
4. 最新取得後、差し替えて表示を解除する。
5. 最新取得失敗時は保存済み表示を継続する。

### 8.4.3 画面復帰の再同期抑制

現行の`visibilitychange`は表示状態へ戻るたびに認証確認を行い得る。

追加状態:

```javascript
appState.lastPortalSessionVerifiedAt
appState.lastEssentialDataLoadedAt
```

設計値:

- 最終認証確認から60秒未満の復帰: 再認証を省略
- 最終主要データ取得から60秒未満の復帰: `loadEssentialData()`を省略
- `online`復帰時: 直前がオフラインの場合のみ再同期
- 多重呼出し: 既存`portalResumeSyncInFlight`で抑止

60秒は設計初期値であり、実測後に調整する。

### Phase 4完了条件

- キャッシュありの再訪問時に、ネットワーク完了前に主要画面を表示できる。
- 60秒以内の短時間復帰で、認証APIと`bootstrap-lite`を重複実行しない。
- オフラインからオンラインへ戻った場合は再同期する。
- キャッシュ破損時はキャッシュを破棄し、通常取得へフォールバックする。

---

## Phase 5: 静的資産およびサーバー側最適化

### 目的

Phase 2の計測により必要性が確認された項目だけを実施する。

### 8.5.1 Bootstrapのローカル配信

Bootstrap CSS・JavaScriptをアプリの静的資産へ含め、外部CDN依存を解消する。

採用条件:

- ライセンス表示を維持する。
- 配布ファイルのバージョンを固定する。
- SRIの代替としてリポジトリ管理下のファイル完全性をCIで確認する。

### 8.5.2 静的キャッシュ期間

現行はバージョン付きURLでも1時間である。

設計案:

- クエリバージョン付きJS/CSS: `public, max-age=31536000, immutable`
- バージョンなし静的資産: 現行相当または短期キャッシュ
- `index.html`: `no-store`

前提:

- 全静的ファイルのURLに更新ごとに変わるバージョンを確実に付ける。
- バージョン付け漏れを静的テストで検出する。

### 8.5.3 `/api/bootstrap-lite`サーバー計測

必要な場合、次の区間をサーバーログへ追加する。

- ETag計算
- 各コレクション読込
- レスポンス生成
- 合計処理時間

ログにデータ本文や個人情報を含めない。

### 8.5.4 `bootstrap-lite`重複読込確認

現行バックエンドは、ETag計算時に対象コレクションを読み込み、その後ペイロード生成時にも同じコレクションを読み込む。

メモリキャッシュで吸収される可能性はあるが、実測で負荷が確認された場合は次のいずれかを採用する。

- 1回読み込んだデータからETagとレスポンスを生成する。
- コレクションバージョン情報のみでETagを構成する。

実測前の変更は禁止する。

---

## 9. ファイル別変更一覧

| ファイル | 変更内容 | Phase | 必要性 |
|---|---|---:|---|
| `src/index.html` | 静的起動画面、起動監視の先行読込、defer化、遅延読込対象除外 | 1,3 | 必須 |
| `src/static/css/style.css` | 起動画面、エラー画面、保存済み表示のスタイル | 1,4 | 必須 |
| `src/static/js/startup_guard.js` | 起動監視、例外捕捉、計測、復旧UI | 1,2 | 必須・新規 |
| `src/static/js/config.js` | タイムアウト・復帰猶予時間の定数 | 1,4 | 必須 |
| `src/static/js/modules/common_helpers/bootstrap_init.js` | 起動状態更新、認証結果分岐、復帰抑制、計測 | 1,2,4 | 必須 |
| `src/static/js/modules/common_helpers/api_runtime.js` | `fetchWithTimeout`、タイムアウト分類、キャッシュ先行利用 | 1,4 | 必須 |
| `src/static/js/auth_feature.js` | 認証結果を3状態化、通信失敗と未認証の分離 | 1 | 必須 |
| `src/static/js/modules/navigation/events.js` | `enterPortal()`の完了条件、起動画面終了 | 1 | 必須 |
| `src/static/js/modules/bootstrap_loader.js` | キャッシュ先行描画、主要データ計測 | 2,4 | 必須 |
| `src/static/js/utils/cache.js` | ETag・timestamp復元、キャッシュエントリ取得 | 4 | 必須 |
| `src/static/js/utils/feature_loader.js` | 機能別遅延ロード | 3 | 必須・新規 |
| `src/backend/core/static_assets.py` | バージョン資産の長期キャッシュ | 5 | 計測後に判定 |
| `src/backend/routers/bootstrap.py` | サーバー側計測 | 5 | 計測後に判定 |
| `src/backend/services/bootstrap_service.py` | 重複読込削減 | 5 | 計測後に判定 |
| `tests/frontend/test_runtime_bootstrap_order.test.js` | 起動順・重複登録・ready保証 | 1,3 | 必須 |
| 新規フロントテスト | タイムアウト、エラーUI、キャッシュ先行表示 | 1,2,4 | 必須 |
| `tests/e2e/**` | スマホ、低速回線、API停止、遅延読込 | 1–4 | 必須 |

---

## 10. 詳細処理設計

### 10.1 正常初回起動

```text
1. HTML表示
2. 静的起動画面表示
3. startup_guard.js開始
4. 必須スクリプト読込
5. DOMContentLoaded
6. IndexedDB初期化
7. UIイベント登録
8. 端末認証確認
9. bootstrap-liteキャッシュ確認
10. キャッシュありなら先行描画
11. bootstrap-lite最新取得
12. 最新主要データ描画
13. APP_READY
14. 起動画面非表示
15. 背景データ取得
```

### 10.2 未認証初回起動

```text
1. HTML表示
2. 静的起動画面表示
3. 必須スクリプト読込
4. 端末認証情報なしを判定
5. ログイン画面を生成・表示
6. APP_READY
7. 起動画面非表示
8. ログイン用パート設定を背景取得
```

ログイン用パート設定の取得失敗は、ログイン画面表示を妨げない。

### 10.3 認証APIタイムアウト

```text
1. 端末認証開始
2. 10秒でタイムアウト
3. 保存済み認証フラグとbootstrap-liteキャッシュを確認
4-a. キャッシュあり: 保存済みデータ表示、オフライン表示
4-b. キャッシュなし: 通信失敗画面、再試行ボタン表示
```

通信失敗を未認証と扱ってログイン情報を消去しない。

### 10.4 `bootstrap-lite`タイムアウト

```text
1. 最新データ取得開始
2. 12秒でタイムアウト
3-a. キャッシュ表示済み: 警告表示を残し、操作可能状態を維持
3-b. キャッシュなし: 再試行画面表示
```

### 10.5 JavaScript読込失敗

```text
1. script要素のerrorをstartup_guardが検知
2. 失敗資産名を開発者向けログへ記録
3. 利用者へ起動失敗表示
4. 再読み込みボタン表示
```

利用者向け表示に内部ファイルパスやスタックトレースを表示しない。

### 10.6 セッション復帰

```text
1. visibilitychangeでvisible
2. 前回認証確認時刻を判定
3. 猶予時間内なら処理終了
4. 猶予時間外なら認証確認
5. 前回主要データ取得時刻を判定
6. 猶予時間外の場合のみbootstrap-lite取得
7. 結果を反映
```

---

## 11. エラー表示設計

| エラー | 利用者向け表示 | 操作 |
|---|---|---|
| JavaScript初期化失敗 | 起動処理に失敗しました | 再読み込み |
| 認証APIタイムアウト・キャッシュなし | サーバーへ接続できません | 再試行 |
| 認証APIタイムアウト・キャッシュあり | 保存済みデータを表示しています | 再接続 |
| `bootstrap-lite`タイムアウト・キャッシュなし | データを取得できません | 再試行 |
| `bootstrap-lite`タイムアウト・キャッシュあり | 保存済みデータを表示しています | 最新データを取得 |
| IndexedDB失敗 | 通常通信で起動を続行 | 操作なし |
| 遅延機能読込失敗 | この機能を読み込めませんでした | 再試行 |

---

## 12. テスト設計

### 12.1 単体テスト

#### 起動監視

- `APP_START`が一度だけ記録される。
- `ready()`で監視タイマーが解除される。
- `window.onerror`で再読み込み画面が表示される。
- `unhandledrejection`で再読み込み画面が表示される。
- 二重読込でもイベントリスナーが重複しない。

#### 通信タイムアウト

- 指定時間でAbortされる。
- 通常レスポンスではタイマーが解除される。
- 外部AbortSignalを尊重する。
- タイムアウトと通常ネットワークエラーを区別できる。
- 401後の認証復旧再送にもタイムアウトが適用される。

#### 認証状態

- 認証済みを`authenticated`として返す。
- 401または認証なしを`unauthenticated`として返す。
- タイムアウトを`unavailable`として返す。
- `unavailable`でローカル認証情報を削除しない。

#### キャッシュ

- IndexedDBからdata、etag、timestampを復元できる。
- 再読み込み後も`If-None-Match`を送信する。
- 304時に保存済みdataを返す。
- キャッシュ破損時に通常取得へ移行する。

#### 復帰抑制

- 60秒以内の復帰でAPIを呼ばない。
- 60秒経過後の復帰で認証確認する。
- オフライン復帰時に再同期する。
- 多重イベントで1回だけ実行する。

### 12.2 結合テスト

- `DOMContentLoaded`から`APP_READY`までのイベント順が正しい。
- ログイン画面表示完了前に起動画面を消さない。
- 主要画面表示完了前に起動画面を消さない。
- キャッシュ先行表示後に最新データへ置換される。
- 背景取得失敗が主要画面操作を妨げない。
- 遅延機能を開いたときだけ対象スクリプトを読み込む。

### 12.3 E2Eテスト

対象端末相当:

- iPhone Safari相当
- Android Chrome相当
- デスクトップChrome

通信条件:

- 通常回線
- Fast 3G相当
- Slow 3G相当
- オフライン
- 途中切断
- 途中復旧

異常条件:

- 認証API 10秒超遅延
- `bootstrap-lite` 12秒超遅延
- 500応答
- 401応答
- JavaScript 1ファイル404
- Bootstrap CDN失敗
- IndexedDB使用不可
- キャッシュ破損
- Cloud Runコールドスタート相当の遅延

状態条件:

- 初回未認証
- 初回認証済み
- キャッシュあり
- キャッシュなし
- セッション切れ
- 画面を短時間バックグラウンド化
- 長時間バックグラウンド化

### 12.4 回帰テスト

- ログイン
- ログアウト
- 管理者ログイン
- 一般団員ログイン
- 権限別メニュー
- お知らせ
- 練習予定
- 本番情報
- 欠席連絡
- 録音
- 楽譜
- 支払
- イベント
- アルバム
- 管理画面

---

## 13. 実装順序

1. 起動監視と静的起動画面を追加する。
2. 起動監視の単体テストを追加する。
3. `fetchWithTimeout()`を追加する。
4. 認証処理を3状態へ変更する。
5. `enterPortal()`の完了条件を修正する。
6. API停止・タイムアウトのテストを追加する。
7. 起動区間計測を追加する。
8. 変更前後の実機計測を行う。
9. 初期JavaScriptを必須・遅延へ分類する。
10. 機能ローダーを追加する。
11. 遅延対象を1機能ずつ移行して回帰テストする。
12. IndexedDBのETag復元を追加する。
13. セッション復帰抑制を追加する。
14. 計測値に基づき、CDN・静的キャッシュ・バックエンドを最適化する。

一度に複数Phaseをまとめて実装せず、Phaseごとにテスト環境へ反映して評価する。

---

## 14. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 遅延ロード対象の依存漏れ | 画面初回表示で関数未定義 | 機能単位の依存表とE2Eテスト |
| キャッシュ先行表示の内容が古い | 利用者が最新と誤認 | 保存済み表示ラベル、取得時刻表示 |
| タイムアウトが短すぎる | コールドスタート時に失敗扱い | 実測P95を基に調整 |
| タイムアウトが長すぎる | 復旧表示が遅い | 上限15秒を初期基準とする |
| 認証通信失敗を未認証扱い | 不要な再ログイン | 3状態へ分離 |
| Bootstrapローカル化で差分発生 | 表示崩れ | 同一バージョン固定、画面回帰テスト |
| 長期キャッシュで古いJSが残る | 新旧コード不整合 | 全資産のバージョン更新をCI検査 |
| 起動ログに個人情報が混入 | 情報管理上の問題 | 許可項目だけを記録 |

---

## 15. 受入基準

次のすべてを満たした場合に、本修正を完了とする。

### 安定性

- JavaScript、認証API、初期データAPIの失敗時に真っ白画面にならない。
- 15秒以内に利用者向け状態と復旧操作を表示する。
- 通信失敗だけを理由に認証情報を削除しない。
- キャッシュありの場合は保存済みデータで操作を継続できる。

### 計測

- `APP_START`から`APP_READY`までを区間別に取得できる。
- 初回、再訪問、画面復帰、コールドスタート相当を区別できる。
- 修正前後のP50・P95を比較記録できる。

### 性能

- 初期JavaScriptのファイル数または転送量が減少する。
- 一般団員の初期表示で管理者専用機能を事前読込しない。
- 通常回線で設計目標値を満たす。

### 回帰

- 既存フロントエンドテストが成功する。
- 既存バックエンドテストが成功する。
- 主要機能のスマートフォンE2Eテストが成功する。
- テスト環境で実機確認後に本番へ反映する。

---

## 16. 実装時の禁止事項

- 原因計測前にCloud RunまたはNeonの設定を変更しない。
- 認証仕様や権限仕様を同時変更しない。
- 目的外のリファクタリングを混在させない。
- 全機能を一度に遅延ロードへ変更しない。
- エラーを握りつぶして起動画面だけ消さない。
- 通信失敗を即座にログアウトとして扱わない。
- キャッシュデータを最新データと表示しない。
- タイムアウト値を複数ファイルへ直書きしない。
- テスト未追加のまま本番へ反映しない。

---

## 17. 実装開始時の完了条件

実装担当者は、最初の作業ブランチでPhase 1だけを対象にする。

Phase 1の完了条件:

```text
- 静的起動画面が表示される
- JavaScript例外時に白画面にならない
- 認証API無応答時に復旧導線が出る
- bootstrap-lite無応答時に復旧導線が出る
- 通信失敗と未認証が分離される
- 既存ログイン・主要画面表示が維持される
- 対応テストが追加される
```

Phase 1のレビューとテスト環境確認が完了するまで、Phase 3以降の遅延ロード変更を同じPRへ含めない。

---

## 18. 再レビュー結論

今回の最重要課題は、単なる「高速化」ではなく、次の順序で解決する必要がある。

1. **白画面を発生させない。**
2. **通信停止を有限時間で検知する。**
3. **遅延区間を計測する。**
4. **初回に不要なコードを遅延させる。**
5. **保存済みデータを安全に先行表示する。**
6. **実測で必要性が確認されたサーバー側項目だけを最適化する。**

最新`main`では、初回表示前に70本のローカルJavaScriptと1本の外部JavaScriptが読み込まれる。通信タイムアウトと起動監視が未実装であるため、Phase 1とPhase 2は本番運用開始前の必須対応と判断する。
