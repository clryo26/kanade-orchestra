# 高機能チューナー データ・API設計 Ver.1.0

作成日: 2026-10-17。[基本・詳細設計](TUNER_ADVANCED_DESIGN.md)の補足契約。本書は実装案であり、DB・API・保存を追加した状態ではない。本文の制限値は初期設計値とする。

<a id="contract"></a>
## 1. 版と音声解析データ

`designVersion`、配信ファイルの`releaseId`、メッセージの`protocolVersion`、保存の`schemaVersion`、解析の`engineVersion`、統計の`statsVersion`は独立して持つ。releaseIdが違うWorkerは接続せず、protocolVersionが違うメッセージは処理しない。保存データに配信版だけを記録して解析方式の版の代わりにしない。

### 1.1 通信

| 経路 | 種類・内容 | 契約 |
|---|---|---|
| main → Worklet/Worker | `init` | protocolVersion=2、releaseId、captureEpoch、sampleRate、MessagePort、バッファプール |
| Worklet → Worker | `pcm` | epoch、sequence、startFrame、length、gap、Float32 PCMのtransfer。欠落時は途中の塊を捨てる |
| Worker → Worklet | `recycle` | 使用済みArrayBufferをtransferで返す。未返却時は新規割当を続けず欠落を通知 |
| main → Worker | `configure` | settingsRevision、対象周波数範囲、解析モード、axisId。適用したrevisionを結果に返す |
| Worker → main | `pitchBatch` | epoch、sequence、settingsRevision、最大50 ms分のPitchFrame。表示用平滑値は含めない |
| Worker → main | `envelopeBatch` | epoch、区間中央時刻、10 msごとのRMS・clip・gap。最大50 ms分、発音区切り用 |
| Worker → main | `spectrum` | axisId、区間、対数縮約した最大512点、基音・倍音。全FFT配列はWorker内 |
| main → 統計Worker | `analyze` | requestId、sessionRevision、選択区間、条件snapshot、transfer可能な数値列 |
| 統計Worker → main | `result` | 同じrequestIdとrevision、statsVersion、各指標と除外数。古い要求は破棄 |

PCMは録音ファイルを作らず、解析終了後に再利用する。SharedArrayBufferは使用しない。128サンプル固定と仮定せず、Workletが受け取った実際の配列長を処理する。メインスレッドはPCMを中継しない。停止時にport、Worker、Worklet、track、Contextをそれぞれ解放する。

### 1.2 PitchFrameと時計

生フレームは`captureEpoch`、`analysisStartFrame`、`analysisEndFrameExclusive`、`effectiveFrame=(start+end-1)/2`、`frequencyHz`、`confidence`、`rmsDbfs`、`qualityFlags`、`invalidReason`を持つ。frequencyHzは有効時のみ正の有限数、無効時はnull。0 Hz・0 centで欠測を表さない。信頼度は0〜1のアルゴリズム値で、正答確率ではない。

音声フレーム時計を解析の基準にし、performance時計とUTCはepochの対応表に記録する。UTC変更で音声区間を伸縮しない。別AudioContext間の再生区間は対応表と不確実幅を持ち、入力の遅延を`getOutputTimestamp()`だけから求めない。再開・sampleRate変更・入力欠落は区間境界であり、連続補間しない。

| フラグ | 意味 |
|---|---|
| bit0 `inputGap` | 入力欠落または時刻不連続 |
| bit1 `transient` | アタック・急変、定常指標には不採用 |
| bit2 `clipped` | 入力飽和の疑い |
| bit3 `octaveAmbiguous` | 基音の候補を識別できない |
| bit4 `playbackOverlap` | 基準音・メトロノーム等の出力と重なる |
| bit5 `boundaryUncertain` | 時計対応・目標変更境界が不確実 |
| bit6 `profileTransition` | 窓・解析プロファイル切替確認中 |
| bit7 reserved | 未知bitのあるデータは統計対象にしない |

invalidReasonは0=有効、1=小音量、2=低信頼度、3=範囲外、4=欠落、5=立上り未確定、6=曖昧、7=その他。複数理由はフラグと除外カウンターにも残す。各指標は必要条件を別に定義し、全フラグを一律に「無音」と表示しない。

<a id="local"></a>
## 2. 端末保存

IndexedDB名は`portalTunerAdvanced`、初期schemaVersion=1。アカウント連携前も所有者namespaceを設け、他アカウントへの移管・共有を行わない。ログアウト時は表示とメモリーを消し、古い非同期処理をownerEpochで無効化する。端末に残った履歴をログイン前に一覧化しない。

Phase1〜3で本人識別APIが未導入の間は、履歴の永続保存は提供しない。A4・音律・音源preset等の端末設定だけを保存する。Phase4の履歴は本人識別APIで確認したowner UUIDで分離する。隠し管理者などmemberを持たない利用者は端末限定のランダムUUID領域を使い、アカウント同期を表示しない。端末設定と個人履歴は異なるstoreに置く。

| store | key／主な内容 |
|---|---|
| `deviceSettings` | 固定key。A4、表示設定、schemaVersion。ログアウトで消さない |
| `ownerSettings` | ownerId。保存モード・保存先・履歴保持設定・通知を最後に確認した版 |
| `instruments` | [ownerId, instrumentId]。名称、種類、音域、環境メモ、保守記録 |
| `presets` | [namespace, presetId, revision]。音律・音源・練習設定。不変snapshot |
| `sessions` | [ownerId, sessionId]。条件、epoch一覧、区間、要約、保存状態、各版 |
| `seriesChunks` | [ownerId, sessionId, chunkIndex]。約1秒分の数値列、時計と形式header |
| `noteEvents` | [ownerId, sessionId, eventId]。区切り・目標・統計・品質 |
| `syncOutbox` | [ownerId, operationId]。要約のみ、所有者世代、削除世代、試行状態 |
| `localTombstones` | [ownerId, entityType, entityId]。削除要求・同期状態 |

同じセッションのchunkと進捗更新は1 transactionにまとめる。保存中断後は最後に完了したchunkまでを「未完了」として復旧できる。保存の世代が変わった書込完了はUIを更新しない。保存なしへ変更した後は新規書込を止め、作成途中の今回分を削除するか、既存の保存済み分を残すかを画面で区別する。保存なしへの変更だけで過去履歴を無断削除しない。

### 2.1 数値列の形式

標準形式を採用し、圧縮形式は将来の別formatVersionとする。各chunkのheaderにepochId、sampleRate、baseFrame、count、formatVersion、engineVersionを記録する。

| 標準列 | 型 | B/frame |
|---|---|---|
| `relativeCenterTimes2` | Uint32、`2×(effectiveFrame-baseFrame)` | 4 |
| `frequencyHz` | Float32、無効はNaN（JSON化時はnull） | 4 |
| `confidence` | Float32 | 4 |
| `rmsDbfs` | Float32 | 4 |
| `invalidReason` | Uint8 | 1 |
| `qualityFlags` | Uint8 | 1 |
| 合計 | 時刻・理由・フラグ込み | 18 |

半サンプルの中央時刻を整数で保持する。baseFrameで相対化し、2時間のセッション上限とは別にUint32の上限も検査する。sampleRateが通常と異なる場合もオーバーフロー前にchunk基準を更新する。時刻をFloat64秒で保持する代替形式なら22 B/frameとなる。いずれもheader・IDB・indexのオーバーヘッドを含まない。

20 Hzで30分36,000フレームなら標準0.648〜0.792 MB、40 Hzならその2倍。周波数のFloat32化による誤差は最大約0.0001 cent。表示丸め・表示平滑化は保存しない。confidenceと音量は標準では量子化しない。圧縮形式12〜16 B/frameでは最大約0.002と0.5 dBの誤差があるため、統計判定を同一とみなさない。スペクトログラム・PCM・全FFTは永続保存しない。

### 2.2 容量・削除・復旧

設計上限は端末100 MB／保持90日／1セッション2時間・10,000イベント。上限は設定画面に表示し、容量警告を80%で出す。到達時は新しい保存を止め、測定を続け、削除・エクスポートを案内する。保持期限による自動削除は有効化時に説明し、期限超過の件数を通知する。容量不足だけを理由に未通知で古い履歴を削除しない。

`navigator.storage.estimate()`の値を参考表示し、永続化の要求が失敗しても利用可能にする。Safari等による消去、プライベートモード、ブラウザーデータ削除からの復旧は保証しない。migration失敗・未知schemaでは既存データを初期化せず、対応可能なエクスポートと保存停止を優先する。端末保存は同一originのスクリプトから隔離する暗号化保管ではないことも説明する。

### 2.3 アプリケーションモデル

| 型 | 必須のまとまり |
|---|---|
| `TunerSettings` | schemaVersion、a4Tenths、音名表記、許容幅、メーター範囲、responsePreset、表示平滑ms、入力閾値、音域、画面・保存設定 |
| `AnalysisSettings` | 窓profile、engineVersion、校正、閾値、対象指標、倍音範囲。表示設定と別型 |
| `InstrumentProfile` | ownerId、instrumentId、revision、名称・種類・型番、setting履歴、音域境界、環境・保守メモ |
| `SoundPreset` | presetId、revision、最大4voiceの指定方式・周波数またはnote/role、音色係数、音律snapshot、音量、時間・繰返し |
| `PracticeSession` | sessionId、ownerId、開始UTC、音声epoch群、条件snapshot、練習定義、状態・中断、保存設定、版、結果参照 |
| `NoteEvent` | 区間、観測・目標、音響指標、品質、倍音要約。6章の契約 |
| `MeasurementSeries` | sessionId、形式版、epoch別chunk、時刻・Hz・信頼度・dBFS・フラグ。2.1の契約 |
| `PracticeResult` | sessionId、exerciseVersion、期待と観測の対応、未演奏・誤音、個別指標、有効時間・coverage、任意scoreとscoreModelVersion |
| `IntonationProfile` | ownerId、conditionKey、期間、音域・音別の平均／中央値／SD、nEvents、nSessions、推定区間、除外、生成時刻・statsVersion |

条件やpresetを参照IDだけで保存せず、実行時の版と内容をsnapshotにする。復元時の現在設定で過去のcentやスコアを勝手に再計算しない。再解析を提供する場合は元結果を残し、新しいstatsVersionの派生結果として扱う。

<a id="schema"></a>
## 3. DB構成案

既存のPostgreSQL・psycopg・接続プールとrepositoryの作法に合わせる。マイグレーション番号は実装時に空きを確認する（現時点候補017）。新たなJSONファイルを本番データソースにしない。DBには要約と設定だけを保存し、時系列・音声用のGCSバケットやAPIは追加しない。

| table | 主な列・制約 |
|---|---|
| `tuner_owners` | UUID PK、organization_id、member_id、member_birth、history_epoch、created_at、revoked_at。現役ownerはorganization/member/birthで一意 |
| `tuner_instruments` | owner_id、instrument_uuid、revision、profile_json、created_at、updated_at、deleted_at |
| `tuner_preferences` | owner_id PK、revision、preferences_json。履歴送信への同意は別fieldと版を記録 |
| `tuner_presets` | owner_id、preset_uuid、revision、kind、payload_json。過去の利用snapshotを後から変更しない |
| `tuner_sessions` | owner_id、session_uuid、history_epoch、revision、status、condition_key、started_at、duration_ms、versions_json、summary_json、instrument_snapshot、target_snapshot、event_count、content_hash |
| `tuner_note_events` | owner_id、session_uuid、event_uuid、ordinal、start_ms、end_ms、target_json、stats_json、quality_json |
| `tuner_upload_parts` | owner_id、session_uuid、part_index、payload_hash、events_json、expires_at。確定前の一時要約 |
| `tuner_tombstones` | owner_id、entity_type、entity_uuid、deleted_at、history_epoch。遅延送信を拒否する識別子のみ |

session UUIDはクライアント生成、一意性はownerとの組。イベントはowner/sessionへの複合FKを持ち、別ownerへの付替えを拒否する。indexはowner/started_at、owner/condition_key/started_at、owner/instrument/started_at。任意JSONには型・配列長・有限数・文字数の上限を設け、SQLの検索対象となる日時やIDをJSON内だけに置かない。

団員削除では対象ownerを失効させ、チューナー履歴・preset・一時uploadを削除する。団員再作成時は同じ数値member_idでも新ownerとする。DB一括置換・同期・復元がmember_birthを再生成／保持する規則を、実装前に確認する。単なる`member_id`一致やdevice認証レコード内の古いmember情報ではownerを復元しない。

<a id="api"></a>
## 4. API契約案

prefixは`/api/tuner`。既存の認証・組織解決・通信ラッパー・タイムアウト・CSRF等の防御を継承する。ownerIdをクライアントに選択させず、認証済みの現役memberと組織から毎回解決する。管理者向けの他人参照APIは作らない。隠し管理者は本人保存APIについて「アカウント保存不可」を返し、端末限定機能を使う。

| method/path | 内容 |
|---|---|
| GET `/identity` | 本人owner UUID、historyEpoch、対応schema、accountStorageAvailable。履歴本文は返さない |
| GET/PUT `/preferences` | 本人設定。PUTはrevision必須。端末の保存なし設定をサーバー既定で上書きしない |
| GET/POST `/instruments` | 本人の楽器一覧／登録 |
| PATCH/DELETE `/instruments/{id}` | revision付き変更／削除。履歴のsnapshotは保持、現在一覧からは除外 |
| GET/POST `/presets` | 種別付き本人preset一覧／不変revision登録 |
| DELETE `/presets/{id}` | 今後の候補から削除。過去履歴のsnapshotは保持 |
| POST `/sessions` | UUID・historyEpoch・条件snapshotを受け、`uploading`を作成。同じ本文は冪等 |
| PUT `/sessions/{id}/parts/{index}` | 500イベント以下・1 MiB以下の要約part。同じindex・hashは再送可、違う本文は409 |
| POST `/sessions/{id}/finalize` | part数、イベント数、hashを照合し、transactionで要約を確定。確定前のsessionは履歴・診断一覧へ出さない |
| GET `/sessions` | 本人のみ。期間・楽器・条件・メニュー、cursor、limit既定20／上限100 |
| GET `/sessions/{id}` | 条件・要約・品質・版。イベントはcursor付き別field／ページで最大500件 |
| GET `/diagnosis` | 同一conditionKeyの本人要約を集計。期間・音域別。件数・不確実性・除外を返す |
| GET `/export` | 本人要約をJSONまたはCSVでページ取得。端末の時系列は含めない |
| DELETE `/sessions/{id}` | 本人の1件削除。tombstoneを先に確保し、遅延upsertを拒否 |
| DELETE `/history` | 本人の全履歴削除とhistoryEpoch加算を同じtransactionで実施 |

端末の数値列付きJSONエクスポートはローカル処理で行う。CSVには条件・単位・有効数・除外数・版を含め、表計算の数式と解釈される文字列を無害化する。importは今回提供しない。

要求例の共通形は`{schemaVersion:1, historyEpoch:3, clientOperationId:UUID, ...payload}`。レスポンスは`{schemaVersion:1, revision:1, data:...}`。日時はUTC ISO8601、音声内時刻はミリ秒、周波数Hz、偏差cent、音量dBFS。非有限数はJSONへ送らない。最大1 session 10,000イベント、2時間、1 part 1 MiB。クラウド初期上限は本人2,000 session／200,000イベント／50 MBとし、超過は保存拒否と管理画面での自己削除案内にする。他人の容量は返さない。

認証切れ401、本人保存不可403、他ownerのIDは404、revision・削除世代不一致409、削除済みID410、型・値域400、request過大413、保存上限超過は409と`STORAGE_LIMIT`、一時障害503を区別する。エラーに内部保存先・SQL・他人の存在を含めない。送信失敗を理由に測定を止めない。

### 4.1 同期と削除の競合

サーバーはowner行をロックしてhistoryEpochと失効を検査した後に書く。DELETEも同じロック順にする。削除前の世代のoutboxは再送しない。全削除後の新しい保存は、新historyEpochを確認してから新session UUIDで開始する。単一削除のtombstoneはownerが現役の間保持し、同じIDを作り直さない。失効ownerへの再ログインは旧ownerを復活させない。

単一削除と確定・part送信が競合しても、削除済みsessionへ書けない。ログアウトで取得中リクエストをabortし、サーバー側でも要求時に現役認証を検査する。クライアントのabortだけを認可対策にしない。24時間で期限切れの未確定uploadは次回本人要求時などの上限付き清掃で消し、測定処理に重い掃除を入れない。

オフラインは端末保存を続ける。本人確認が必要な同期は保留し、別アカウントでのログインをきっかけに送らない。同期再開時はowner UUID・historyEpoch・同意設定を再確認する。要約の送信同意を撤回したら未送信outboxを消す。既に送信済みの履歴は別の明示的な削除操作とする。

<a id="security"></a>
## 5. 本人確認と境界

既存のmember_idは再利用され得る。member_birthはDBの不変な作成世代を使い、現在の団員行と一致することをサービス層で検査する。認証端末レコードが古い場合、現在のmemberの作成時刻より前の認証ではownerを解決しない。必要な場合は再認証へ誘導する。管理者への昇格・降格は他人の履歴へのアクセス権を生まない。

この確認がDB復元・同期で保証できなければ、先に団員の不変UUID／認証世代を導入する移行を設計・検証し、アカウント履歴の公開を保留する。既存全APIの認証方式を今回の設計だけで一括変更する意味ではない。

実装分担はrouter=入力とHTTP、service=認可・同意・削除競合・集計、repository=owner付きDB操作とする。ownerなしの汎用`get_by_id()`をチューナーのAPIから呼ばない。診断ログはUUIDの一部と件数・エラー分類に絞り、時系列・メモ・機密認証値を出さない。

<a id="stats"></a>
## 6. 音符・統計・診断の結果形式

`NoteEvent`はeventId、区間、観測音、目標snapshot、exerciseStepId、onsetEvidence、attack/steady/release区間、除外理由、coverage、平均・中央値・SD・最小最大・p10/p90、drift、stableSeconds、vibrato結果、発音部・定常部の倍音要約を持つ。倍音要約は各区間最大40成分、平均電力・相対dB・有効数・窓長を持ち、全FFTを含めない。この容量はpitch系列の18〜22 B/frameとは別で、クラウドpartの上限にも含める。欠測指標はnullとreasonを返す。目標変更による分割には`boundaryType=targetChange`を付け、発音回数へ加算しない。

`conditionKey`は正規化した次のsnapshotのhashとする：楽器・音域・音律／根音／role・A4・目標方式・練習メニューとtempo・指定強弱・入力処理の実効値・解析窓／engineVersion・statsVersion・校正状態。端末・入力機器・環境が不明なら`unknown`を明記し、同条件が保証されたと表示しない。表示色・表示平滑化・グラフ軸は統計条件から除く。

音符内では有効時間重み、音符間とセッション間は階層を保つ。診断のnはフレーム数ではなくイベント数・セッション数を併記する。`validSeconds`、`eligibleSeconds`、`requestedSeconds`、`excludedByReason`を保存する。同時再生区間をeligibleから除いても、その除外秒数を消さない。95%区間はセッション単位bootstrapで、独立セッション不足なら保留する。

スコアは個別指標と別形式の`scoreModelVersion`で保持し、初期は既定非表示。校正前の重み・正規化を客観的な音楽評価として公開しない。表示する場合は指標からの再現式、基準値、欠測時の扱い、検証結果を版付きで確定することが公開条件。スコア未確定でも偏差・安定時間・再現性の実測指標と練習結果は利用できる。

<a id="tests"></a>
## 7. 契約の検証

- 音声epoch、半サンプル中央時刻、非等間隔hop、欠落、窓切替、Float32誤差、保存復元を往復検証する。
- 保存なしでは履歴store・outboxへの書込と通信が0であることを確認する。設定保存は別に検証する。
- 複数アカウント・組織・member_id再利用・古いdevice・隠し管理者・降格で本人分離を検証する。
- 書込／finalize／DELETEの競合、全削除後の旧outbox、別ownerログイン後の旧完了、同じpartの再送を実DBで検証する。
- quota、IDB禁止、未知schema、migration中断、未確定upload、オフライン、時計変更でも測定と削除・エクスポートが壊れないことを確認する。
- クライアント要約は演奏の真正性をサーバーが保証するものではない。構造・上限・整合性を検査し、録音を送って真正性を確認する機能は追加しない。

## 8. 実装時の変更

詳細は[実装状況](TUNER_ADVANCED_IMPLEMENTATION_STATUS.md)の4章。

- DC-01: 1章・2章の `deviceSettings` と `presets`（端末設定の名前付きプリセット）は localStorage `portalTunerSettings`（schemaVersion 1、A4は `a4Tenths`）に置く。A4は常に、表示設定とプリセットは利用者が「この端末に設定を保存」を選んだときだけ保存する。IndexedDB `portalTunerAdvanced` の `presets` ストアは作成するが、画面からは使わない。
- DC-02: 1章の `pcm`／`recycle` は既存名 `audio`／`return` のまま、内容（epoch・sequence・startFrame・gap・transfer、欠落時の途中の塊の破棄）は設計どおり。
- DC-05: 4章のAPIはシステム管理者の端末認証に限定する。
- DC-06／DC-07: 5章の `member_birth` 照合に加え、`members` の AFTER DELETE／AFTER INSERT トリガー（`tuner_members_owner_guard`）で所有者を失効し、練習要約を削除する。チューナーの表は本番→テスト同期の対象にしない。マイグレーションは `db/migrations/017_tuner_practice.sql`。
- DC-14: 端末保存の全削除は所有者ごとの削除世代（`ownerSettings.historyGeneration`）を進め、書込トランザクション内で照合する。
- DC-15: 音符イベントの `target` に、その音符を判定した条件（`a4Tenths`・`toleranceCents`・`definition`）と、セッションの条件と異なる場合の `conditionKey` を持たせる。`GET /diagnosis` は `COALESCE(target.conditionKey, セッションの条件キー)` で集計する（表の変更なし）。
- DC-16: 全削除（`DELETE /history`）の後と、409 `HISTORY_EPOCH` の後は `GET /identity` で世代を取り直す。
