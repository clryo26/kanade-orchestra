# 高機能チューナー 変更計画（設計書作成のための材料）

- 作成日: 2026-10-17（調査時点の HEAD `675c69e`）
- 前提資料:
  - [TUNER_ADVANCED_FEASIBILITY.md](TUNER_ADVANCED_FEASIBILITY.md)（調査結果）
  - [TUNER_ADVANCED_REQUIREMENTS_MATRIX.md](TUNER_ADVANCED_REQUIREMENTS_MATRIX.md)（追跡表）
  - [TUNER_DESIGN.md](TUNER_DESIGN.md)（現行設計）

この資料は、設計書で決めるべきことと変更の候補をまとめたものであり、確定設計ではない。「候補値」と書いた数値は、実験で決める前の仮の値である。実装は、この調査結果をユーザーが確認してから始める。

---

## 1. 守る前提（現行から引き継ぐ）

- 公開範囲の判定は launcher の1か所に置く（現在はシステム管理者のみ）。
- 本体と処理は遅延読み込みとし、初期ページのスクリプトを増やさない。
- 共有状態を `portalAppState` に追加しない。チューナーの状態は本体の中に閉じる。
- 最初のタップで AudioContext を同期的に準備する（iOS）。世代番号で、遅れて届いた結果を破棄する。退出時は同期的に、何度呼ばれてもよい形で解放する。
- 音声は Worker 内で処理し、保存も送信もしない。
- すべてのファイルに同じリリース識別子を持たせる（`generate_tuner_release.mjs`）。新しいファイルも同じ仕組みに入れる。
- 解析値と表示用の補正値を分ける。解析・保存・統計には、補正前の値と実効時刻を使う。
- 既存のテスト（Vitest 168件・E2E 22件）は、仕様変更に合わせて意図的に変える場合を除いて維持する。

---

## 2. 推奨構成

```
[Worker] analysis.worker.js
  ├ pitch.js（YIN。2段階の窓を追加: 全音域用 31 Hz～、高音用 例 110 Hz～）
  ├ spectrum.js（16,384 点に加え、短い FFT 例 4,096 点を追加）
  ├ onset.js（新規: 10 ms ごとの RMS 包絡と発音・終了の候補）
  └ 結果 v2: {frameId, startFrame, endFrame, centerFrame, sampleRate, frequency, confidence, rmsDbfs,
             reason, levelChange, engine, flags: {playbackContaminated, clipped, dropout, gap}}
        │（MessagePort。50 ms ごと。必要なら 5～10 フレームずつまとめて送る）
[主スレッド・測定層]
  ├ measurement_store.js（新規: 列ごとの型付き配列のリングバッファー。直近 N 分）
  ├ note_events.js（新規: 発音候補と音程フレームから音符イベントを作る。規則の版あり）
  ├ target_model.js（temperament.js を拡張: 平均律・純正3度・三和音・役割・ピタゴラス・カスタム）
  └ analysis_stats.js（新規: 区間の統計、ドリフト、安定時間、ビブラートの当てはめ）
[表示層]（タブはすべて #systemTunerHost 内）
  ├ view.js（測定タブ。既存）＋ view_tabs.js（新規）
  ├ view_sound.js／view_analyzer.js／view_trainer.js／view_diagnosis.js（新規）
  ├ history_graph.js（新規: 縮約して描く）、spectrogram.js（新規）
  └ display_filter.js（既存。応答速度の設定を追加。表示専用）
[音源層]
  ├ playback.js（既存を拡張: 複数音、音色、正規化）
  └ scheduler.js（新規: 音声時刻による先読みスケジューラー。交互・繰り返し・メトロノーム）
[練習・分析層]
  ├ trainer.js（新規: 練習の状態機械、課題の音列、評価）
  └ intonation_profile.js（新規: イベント単位の集計、データ不足の保留、規則に基づく提案）
[保存層]（利用者が有効にしたときだけ使う）
  ├ storage_local.js（新規: IndexedDB。利用者ごとのデータベース名）
  └ storage_remote.js（新規: API クライアント。要約を冪等に送信）
```

- **Worker から主スレッドへの通知:** 現行の結果（`pitch` メッセージ）は表示のために残す。v2 の項目は同じメッセージに追加し、互換を保つ。プロトコル番号（`TUNER_PROTOCOL`）は 2 に上げ、版の混在を検出する。
- **チャンク:** 毎秒30回の解析が必要なら、`audio.js` の `CHUNK_SIZE` を 2,048 から 1,024 にする（転送は約 47 回/秒）。プールの容量も見直す。
- **SharedArrayBuffer・COOP／COEP:** 導入しない（調査結果 10.1）。

---

## 3. 状態遷移（設計書で確定する）

### 3.1 音声の状態（チューナー全体で1つ）

| 状態 | マイク | 再生 | 解析 | 表示 | 入る条件 |
|---|---|---|---|---|---|
| hidden | なし | なし | なし | なし | 退出・ログアウト・権限喪失 |
| starting | 取得中 | — | なし | 準備中 | 入場・再開ボタン |
| measuring | あり | なし | あり | 更新 | 開始の成功 |
| display-frozen | あり | 任意 | あり（記録は続ける） | 固定 | T-010・A-009 の「表示の固定」 |
| analysis-paused | あり（保持）または なし | 任意 | なし | 固定 | T-010 の「解析の停止」（マイクを保持するかは未定） |
| playing-exclusive | なし | あり | なし | 再生中の表示 | 既定の再生（現行の方式） |
| playing-with-measure | あり | あり | あり（混入判定は補助。区間に `simultaneousPlayback` のフラグを付ける） | 更新（警告つき） | 同時使用モード（利用者がイヤホン使用を宣言した場合）。この区間は、実機検証が済むまで既定で診断・履歴の統計から除外する |
| resume-required | なし | なし | なし | 再開ボタン | 中断・自動再生の制限 |
| unavailable | なし | なし | なし | 案内 | 起動失敗 |

- 内部タブの切替は状態を変えない（launcher の `guard` は `#systemTunerHost` が見えているかだけを確認する）。
- ページ全体の非表示（`visibilitychange`・`pagehide`）、ポータルのタブ移動、ログアウトでは、従来どおり hidden（背景の場合は自動再開の予約つき）へ移る。
- 同時使用からの切替（例: playing-with-measure → measuring）では、マイクを解放せず、同時再生の区間を閉じるだけにする。再生の停止直後の残響を考慮し、区間の終わりは停止時刻に余裕（例: 250 ms。現行の `POST_PLAYBACK_DELAY_MS` と同じ。候補値）を加えた時刻にする。
- 混入判定は、奏者の音の倍音に重なる再生音（同音、オクターブ上、第3倍音など）を識別できない。このため判定結果は警告に使い、統計に含めてよい根拠にはしない。

### 3.2 練習の状態（`trainer.js`）

```
idle → configuring → countdown → recording ⇄ paused → result → (saving → saved | save-failed) → idle
               ↘ cancelled ↙（どこからでも）
```

- recording 中に音声が中断（resume-required）したら paused に移り、区間を閉じる。再開後は新しい区間として続ける。
- 条件（音律・A4・役割・楽器）を変えた場合も、新しい区間にする。
- 保存の失敗は練習結果の表示を妨げない。端末内に保留し、再送は利用者が操作する。

---

## 4. データ契約（項目の候補）

すべての時刻は、次の2つを持つ。

- 音声の時刻（`centerFrame / sampleRate`）
- 壁時計の時刻（`performance.timeOrigin + performance.now()` から求めた UTC ms）

| エンティティ | 主な項目（候補） | 備考 |
|---|---|---|
| TunerSettings | `a4Tenths`（例 4420）、`temperamentId`、`rootMidi`、`role`、`toleranceCents`、`meterRangeCents`、`responseProfile`（fast／normal／stable）、`noteNaming`（en／solfege／both）、`accidental`（sharp／flat／auto）、`registerProfile`、`inputThreshold`（auto／dBFS 値）、`displayMode`、`saveMode`（none／manual／auto）、`schemaVersion` | 現行の `portalTunerReferenceA4Hz` から移行する（整数 Hz × 10） |
| InstrumentProfile | `id`（UUID）、`ownerKey`、`name`、`kind`、`maker`、`model`、`nickname`、`settings[]`（リード・マウスピースなど）、`registerRanges`、`createdAt`、`archivedAt` | 削除の代わりにアーカイブ（履歴を保つ）するかは未定 |
| PracticeSession | `id`（UUID・端末で生成）、`ownerKey`、`instrumentId`、`kind`（free／longtone／scale…）、`startedAt`、`endedAt`、`segments[]`（区間ごとの `conditions` のスナップショット: A4・音律・根音・役割・許容範囲・目標音列）、`environment`（気温・湿度・ウォームアップ、任意）、`engine`（リリース識別子・`pitchEngine`・パラメーター）、`statsVersion`、`device`（UA の要約・`sampleRate`・確認済みのマイク設定） | 音声は持たない |
| MeasurementSeries | `sessionId`、`segmentIndex`、`sampleRate`、`frameHop`、`encoding`（`standard-v1`／`compact-v1`）。列（標準形式）: `centerFrame`（u32）、`hz`（Float32）、`confidence`（Float32）、`rmsDbfs`（Float32）、`reason`（u8）、`flags`（u8）。圧縮形式では `confidence` を u8（255段階）、`rmsDbfs` を i8（1 dB）にする | 30分（36,000 フレーム）で、標準形式 18 B/フレームが 0.648 MB（時刻を Float64 秒にすると 22 B = 0.792 MB）、圧縮形式 12 B/フレームが 0.432 MB（同 16 B = 0.576 MB）。既定は端末内のみで、標準形式を推奨。Float32 化による Hz の誤差は最大約 0.0001 cent で、表示用の丸めはしない（調査結果 9.5） |
| NoteEvent | `id`、`sessionId`、`segmentIndex`、`onsetTime`、`offsetTime`、`onsetSource`（rms／pitch）、`targetMidi`、`targetHz`、`frameCount`、`validFrameCount`、`medianCents`、`meanCents`、`sdCents`、`p10`／`p90`、`attackCents`、`releaseCents`、`stableMs`、`driftCentsPerSec`、`vibrato`（{rate, extent, center, residual}／null）、`rmsMeanDb`、`quality`（excluded の理由）、`segmenterVersion` | 統計の基本単位 |
| PracticeResult | `sessionId`、`metrics`（指標ごとの値・n・分母）、`score`（任意）、`criteriaId`、`statsVersion` | 指標は個別に必ず保持 |
| IntonationProfile | `ownerKey`、`instrumentId`、`conditionsKey`（A4・音律・役割の正規化）、`midi`、`eventCount`、`sessionCount`、`medianCents`、`ciLow`／`ciHigh`、`sd`、`period`、`statsVersion` | 派生データ。NoteEvent から再計算できる |
| SoundPreset | `id`、`ownerKey`、`voices[]`（{source: hz／note／linked, hz, midi, role}）、`waveform`、`volume`、`duration`（hold／seconds／repeat）、`temperamentLink` | — |
| AnalysisSettings | `minEventMs`、`minValidFrames`、`minConfidence`、`stableWindowMs`、`stableToleranceCents`、`attackWindowMs`、`releaseWindowMs`、`vibratoRateRange`、`excludePlayback`、`version` | 候補値は実験で決める |

**集計単位:**

- 次の4つを分ける。
  - フレーム（50 ms）
  - 音符イベント
  - 試行（練習課題の1回）
  - セッション
- 診断の n は、イベント数とセッション数で表示する。フレーム数は参考値として別に表示する。

**指標の式（候補）:** 代表値は中央値を基本にする。

| 指標 | 式 |
|---|---|
| 正確性 | 課題の目標 Hz からの cent の、イベント内中央値の絶対値。最寄りの音へ丸めた結果は使わない |
| ばらつき | 定常区間の cent の標準偏差、または四分位範囲 |
| 維持率 | 許容範囲内の有効フレーム数 ÷ 有効フレーム数。分母から除いた無音・棄却・再生中・欠落のフレーム数は別に表示する。欠測を 0 cent として数えない |
| 安定するまでの時間 | 発音から「直近 200 ms の中央値が ±許容範囲に入り、以後 300 ms 維持」までの時間（候補値） |
| ドリフト | 定常区間の直線の傾き（cent/秒） |
| アタック | 発音後、最初の有効値から 50 ms 間の中央値と、定常区間の中央値との差（候補値） |
| リリース | 最後の有効値から遡る 200 ms 間と、定常区間との差（候補値） |
| ビブラート | 3～10 Hz の正弦の当てはめで、速さ・片側の幅・中心・残差を求める。周期ごとの推定のばらつきを安定性とする |
| 再現性 | 同じ課題の試行ごとの中央値の標準偏差（試行数を表示） |
| 傾向 | 音ごとのイベント中央値の中央値と、ブートストラップなどによる信頼区間 |

**判定の保留:** 次のいずれかに当たる場合は「データ不足」と表示する。

- 最小のイベント数（候補値 5）に満たない。
- 最小のセッション数（候補値 2）に満たない。
- 信頼区間が ±許容範囲より広い。

**統計から除外する条件:**

- 1つのイベント内の有効フレームが 3 未満
- 平均信頼度が閾値未満
- 同時再生の区間（混入判定の結果にかかわらず、既定で除外する。含める条件は実機検証の後に決める）
- 区間の途中で条件が変わった

---

## 5. ファイル単位の変更候補

| ファイル | 変更の種類 | 内容 | 主なテスト |
|---|---|---|---|
| `pitch.js` | 改修 | 2段階の窓（または窓の長さの引数）、高音域の基音確認、結果に `centerFrame` を追加 | `test_tuner_pitch_spectrum` に高音域の基音欠落・ビブラート・グリッサンドを追加 |
| `spectrum.js` | 改修 | 短い FFT のアナライザー、クリッピングの検出、基音に対する相対強度 | 同上 |
| `onset.js` | 新規 | RMS 包絡と発音・終了の候補 | 新規 `test_tuner_onset` |
| `analysis.worker.js` | 改修 | 結果 v2、同時再生のフラグと混入判定（補助。再生中の全成分の周波数を `playback-state` メッセージで受け取る）、プロトコル 2 | `test_tuner_transport` |
| `capture.worklet.js`・`audio.js` | 改修 | チャンクの大きさ（必要な場合）、プロトコル 2 | `test_tuner_transport` |
| `controller.js` | 改修 | 表示の固定・解析の停止、同時使用の状態、Worker への再生周波数の通知 | `test_tuner_lifecycle` |
| `launcher.js` | 改修（小） | `MAIN_SCRIPTS` に新しいファイルを追加。`guard` は変えない | `test_tuner_lifecycle`、`test_tuner_integration_contract` |
| `index.js` | 改修 | タブ、測定層・音源層・練習層の結合。再生と測定の方式の選択 | `test_tuner_body` |
| `display_filter.js` | 改修 | 応答速度・合格範囲・メーターの範囲を設定にする（表示専用のまま） | `test_tuner_display_filter` |
| `temperament.js` → `target_model.js` | 改修 | 共通の目標モデル（8.1）。`justTarget` は互換の関数として残す | `test_tuner_temperament` |
| `music.js` | 改修（小） | ♯・♭の表記選択 | `test_tuner_music_settings` |
| `settings.js` | 改修 | TunerSettings、0.1 Hz 単位、プリセット、移行、保存失敗の扱いを維持 | `test_tuner_music_settings` |
| `playback.js` | 改修 | 複数音・音色（PeriodicWave）・正規化・各音のフェード | `test_tuner_playback` |
| `scheduler.js` | 新規 | 先読みスケジューラー（音声時刻）。交互・繰り返し・メトロノーム | 新規 `test_tuner_scheduler` |
| `measurement_store.js` | 新規 | 型付き配列のリングバッファー、区間、上限 | 新規 |
| `note_events.js` | 新規 | イベント分割（E2-E の規則から出発）。規則の版 | 新規（合成音で正解のある試験） |
| `analysis_stats.js` | 新規 | 統計・ドリフト・ビブラート | 新規 |
| `trainer.js` | 新規 | 練習の状態機械と評価 | 新規 |
| `intonation_profile.js` | 新規 | 集計・保留・提案の規則 | 新規 |
| `storage_local.js`・`storage_remote.js` | 新規 | IndexedDB と API | 新規、E2E |
| `view*.js`・`history_graph.js`・`spectrogram.js`・`graph.js` | 新規・改修 | 画面 | E2E、目視 |
| `tuner.css` | 改修 | タブ、ダークモード、最大化表示 | E2E（レイアウト）、目視 |
| `scripts/generate_tuner_release.mjs` | 変更なし（新しいファイルも `tuner/` 配下なら自動で対象） | — | `check:tuner-release` |
| `improvement_suggestions.js` | 変更なし（予定） | タブはホストの中に作るため | 既存 |
| `docs/TUNER_DESIGN.md`・`docs/MANUAL_DEVICE_QA_CHECKLIST.md` | 更新 | 各フェーズで仕様と手順を更新 | `check:ops:checklists` |

**読み込み量:** 本体のファイル数が増えるため、タブごとの遅延読み込みも検討する。

- 例えば、測定タブは現行のファイルだけで開始し、解析・練習・診断のファイルは最初にそのタブを開いたときに読み込む。
- その場合も、全ファイルのリリース識別子の一致を確認する。

---

## 6. DB・API の追加候補（Phase 4。適用は承認後）

- **migration:** `db/migrations/017_tuner_practice.sql`（候補）。既存の型に合わせる。
  - `organization_id TEXT NOT NULL DEFAULT 'default'` と索引を付ける。
  - 文字列の長さの CHECK を付ける。

| テーブル（候補） | 主な列 |
|---|---|
| `tuner_owners` | `id UUID PK`、`organization_id`、`member_id BIGINT NULL`、`created_at`、`deleted_at`。所有者の識別子を会員 ID と分け、会員 ID の再利用による取り違えを防ぐ |
| `tuner_instruments` | InstrumentProfile |
| `tuner_sessions` | PracticeSession（条件のスナップショットとエンジン版は JSONB） |
| `tuner_note_events` | NoteEvent（統計列＋JSONB）。`(owner_id, conditions_key, midi)` に索引 |
| `tuner_results` | PracticeResult |
| `tuner_settings` | TunerSettings（任意。端末内を正とするなら不要） |

- MeasurementSeries は既定で DB に置かない。送る場合は、別のテーブルまたは GCS に、バイナリと上限サイズを決めて保存する（要決定）。

**API（候補）:** `src/backend/routers/tuner.py`、`services/tuner_service.py`、`repositories/tuner_repository.py`。

| エンドポイント | 認証 |
|---|---|
| `GET/POST/PATCH/DELETE /api/tuner/instruments` | `get_device_auth`。所有者は自分のみ |
| `POST /api/tuner/sessions`（冪等キー = 端末で生成した UUID。同じ ID の再送は同じ結果を返す） | 同上 |
| `GET /api/tuner/sessions?from&to&instrument&kind`、`GET /api/tuner/sessions/{id}`、`DELETE /api/tuner/sessions/{id}`、`DELETE /api/tuner/sessions`（全件） | 同上 |
| `GET /api/tuner/export?format=csv|json` | 同上。CSV の数式実行を防ぐ |

**認可:**

- 各要求で、端末の `member_id` から `tuner_owners` を引き、`organization_id` で絞り込む。
- 他人のデータを管理者が見られるようにするかは未定。既定は見られないことを推奨する。
- 隠しシステム管理者（`member_id` なし）は対象外とし、端末内保存のみとする。

**その他の要件:**

- **会員の削除:** `member_service.delete_member` から `tuner_owners` を論理削除し、関連データを削除する（または ON DELETE CASCADE）。会員 ID の採番方式（`BaseRepository.next_id`）で再利用が起きるかを、設計前に確認する。
- **入力の上限:** 1セッションあたりのイベント数、JSON の大きさ（例: 1 MB。候補値）、文字列の長さ。
- **パス:** 新しい API パスの追加であり、既存の API パスは変えない。
- **本番の運用:** データベースのみで運用する方針に合わせ、JSON での代替を作らない。

---

## 7. フェーズごとの実装順序と受入基準

開発順序は追加仕様7章に従う。すべてのフェーズが完了した状態を完成形とする。各フェーズの受入基準では、画面の動作と測定結果の音響的な妥当性を別に判定する（AT-013）。

### Phase 1: 既存チューナーの基盤強化

- **内容:**
  - 結果 v2（実効時刻・信頼度・理由・フラグ・エンジン版）、測定層（リングバッファー）
  - 2段階の窓と高音域の基音確認
  - A4（範囲・刻みはユーザーの決定に従う）とプリセット
  - 合格範囲・メーターの範囲・応答速度・入力しきい値・入力レベル・信頼度の警告
  - 自動判定と指定音判定、♯・♭とドレミの表記
  - 目標モデル（三和音・役割・ピタゴラス・カスタム・比較表示）
  - タブの枠組み（測定タブ）、表示の固定・解析の停止、詳細表示と最大化表示
  - Wake Lock をタブ間で継続
- **依存:** なし（最初に高リスク項目 8章の 1～3 を検証する）
- **受入基準（案）:**
  - 既存の Vitest・E2E がすべて成功する（意図的な変更は除く）。
  - 合成音の試験で、次を満たす。
    - C1～C8 の定常音: 現行と同等以上。
    - C6～C8 の弱い基音・基音欠落: オクターブ誤りが有効フレームの 1% 未満（候補値）。
    - グリッサンド: 実効時刻の真値との差が ±1 cent 以内。
  - 音律の目標値が既知の比と 1e−9 の精度で一致する。
  - iPhone の実機で、7-1～7-10 と新しい項目（タブ切替で測定が途切れない、など）を確認する。

### Phase 2: サウンド・音響解析

- **内容:**
  - 音源: 複数音・音色・ドローン・和音・交互と同時・再生時間・音律連動・状態表示
  - 同時使用モード: 利用者の宣言、同時再生区間のフラグ、補助としての混入判定（統計からは既定で除外）
  - 解析: ピッチ・周波数・音量の履歴、スペクトログラム、倍音分析、音符イベント、ロングトーン解析（アタック・定常・ドリフト・リリース・安定時間）、ビブラートの基本
- **依存:** Phase 1 の測定層・目標モデル
- **受入基準（案）:**
  - 4音の最大ピークが 1.0 未満で、クリッピングがない（OfflineAudioContext の試験）。
  - スケジューラーの予定と実際の再生時刻の差が、1オーディオブロック以内（オフライン）。
  - 合成音で次を満たす（いずれも候補値）。
    - アタック・定常・終了区間の境界: 正解から ±50 ms 以内
    - ビブラートの速さ: ±0.1 Hz
    - ビブラートの幅: ±10%
  - 同時再生の区間が、診断・履歴の統計に含まれない（既定）。
  - 混入判定（補助）は、奏者の倍音に重ならない再生音について、−20 dB 以上の回り込みを検出する（合成音）。重なる組み合わせを判定できないことは、試験で明示して記録する。
  - 実機（11章）で、スピーカーとイヤホンでの回り込みの量を記録する。

### Phase 3: 練習トレーナー

- **内容:** ロングトーン・半音階・長短音階・跳躍・同音反復・強弱・音感・インターバル聴音・カスタム・メトロノーム・ウォームアップ、練習結果の評価（指標は個別に表示、総合スコアは任意）。
- **依存:** Phase 2 の音符イベント・スケジューラー
- **受入基準（案）:** 合成した演奏データ（ずれを与えた音列）で、次の4項目を正しく判定する。
  - 期待する音列との対応
  - 指標の値
  - 分母（除外したフレーム数の表示を含む）
  - 中断時の区間の分割

### Phase 4: 個人分析・履歴管理

- **内容:**
  - 楽器プロフィール
  - 保存設定（保存しない・手動・自動）
  - 端末内保存、アカウント連携（承認された方式で）
  - 履歴の一覧・詳細・比較、日・週・月の集計
  - 音別・音域別・条件別の分析、音程傾向マップ、弱点、規則に基づく提案
  - CSV・JSON 出力、削除
- **依存:** Phase 3 の結果、6章の DB・API（承認後）
- **受入基準（案）:**
  - 正解のある合成データで、集計と保留が正しい。
  - 楽器・条件・エンジン版の違うデータが混ざらない。
  - 会員の削除・ログアウト・アカウント切替で、他人のデータが見えない（pytest・E2E）。
  - 音声を送信しない（契約テスト）。

### Phase 5: 総合品質向上

- **内容:**
  - ビブラート解析の精度向上
  - 詳細な倍音分析（アタックと定常の比較、強弱別）
  - 長期比較
  - 端末別の最適化
  - 30分以上の実機試験
  - 実楽器での評価
  - 総合テスト
- **依存:** Phase 1～4
- **受入基準（案）:** 11章の実機試験の合格基準（ユーザーと決める）、実楽器での誤差の分布を公表できる形でまとめる（条件付き）。

---

## 8. 初期段階で検証すべき高リスク項目

| 順 | 項目 | 理由 | 方法 |
|---|---|---|---|
| 1 | iPhone での30分連続測定の負荷（CPU・発熱・電池・中断） | PC の値（2.6% 程度）から推測できない | 11章の手順。現行のままでも実施できる |
| 2 | iPhone での再生と測定の同時使用（経路・音量・回り込み） | 同時使用モードを採用するかの判断材料 | 試験用の別ページ（`.tmp` などの隔離した PoC）で、再生と、マイクの帯域電力の記録 |
| 3 | 2段階の窓の切替の安定性 | ビブラート・アタックの精度改善の前提 | 合成音と実楽器で、切替の境界付近の音を評価 |
| 4 | 短い同音反復の分割 | P-006・A-020 が成り立つか | RMS 包絡による発音検出を試作し、E2-E を再実行 |
| 5 | 実楽器の音の入手と評価方法 | 精度の数値目標を決めるため | 収録の同意と方針を決めて小規模に収録 |
| 6 | 会員 ID の再利用の有無 | 履歴の取り違えを防ぐ | `BaseRepository.next_id` と、DB の `members.id` の採番方式を確認 |
| 7 | MDN の対応表による最低版の確定 | 対応を約束する版 | MDN の表と実機で確認 |

---

## 9. 既存機能の回帰検証計画

| 対象 | 方法 |
|---|---|
| 起動・解放・世代管理・履歴復帰・ログアウト | 既存の `test_tuner_lifecycle`・`test_tuner_history_restore`・`test_tuner_body`、E2E 22件。タブを追加した後も、ポータルのタブ移動で解放されることを E2E に追加 |
| 判定（平均律・純正3度）と A4 | 既存の `test_tuner_temperament`・`test_tuner_display_filter`・`test_tuner_music_settings`。目標モデルへ移した後も同じ値になることを確認 |
| 再生（音名・Hz・純正値・フェード・停止後の再開） | 既存の `test_tuner_playback`・E2E（OfflineAudioContext） |
| Worklet と Worker の転送 | 既存の `test_tuner_transport`。プロトコル 2 で版の混在を検出 |
| 初期ページの読み込み | 初期スクリプト数の既存テスト、`check:frontend:load-order`・`check:frontend:state-access` |
| 版管理 | `check:tuner-release`、`test_tuner_integration_contract` |
| ポータル全体 | `npm run qa:local`（Lint・型・pytest・Vitest・E2E）、`check:release-safety` |
| 実機 | `MANUAL_DEVICE_QA_CHECKLIST.md` の 7章を各フェーズで更新して実施 |

カバレッジ（`vitest.config.js`）は現在 `frontend_testable_logic.js` だけが対象である。チューナーを対象に加えるかは、CI の閾値に影響するため別途決める。

---

## 10. 設計書作成前に決める事項

| 事項 | 推奨案（理由は調査結果 3章・9章） |
|---|---|
| A4 の範囲・刻み・プリセット | 内部は 0.1 Hz 単位。範囲は現行の 430～450 を維持し、プリセットを追加。390～480 にする場合、C1 は 28.99 Hz（A4 = 390）、C8 は 4,566.56 Hz（A4 = 480）になる。これに余裕を加えた探索範囲（例: 28～4,700 Hz。候補値）へ広げる必要があり、分析が約 89 ms に延びる影響と、再生上限（4,400 Hz）の見直しを受け入れる必要がある |
| 再生と測定の同時使用 | 既定は交互（現行）。同時使用は、イヤホン使用を宣言したときの別モードとし、リアルタイム表示に限る。同時再生区間は、実機検証が済むまで診断・履歴の統計から既定で除外する。混入判定は補助（警告）とし、診断データの正しさの保証には使わない |
| 一時停止の意味 | 「表示の固定」と「解析の停止」を分ける。解析の停止中もマイクを保持するか |
| 保存方式 | 端末内保存から始め、アカウント連携は要約のみ。生の時系列は既定で端末内のみ |
| アカウント連携の所有者 | 会員 ID とは別の所有者 ID。隠しシステム管理者は端末内のみ |
| 管理者が他人の履歴を見られるか | 見られない（団員の個人情報として扱う） |
| 団員への開放の時期と条件 | Phase 1 の実機確認の完了後に判断 |
| 純正律の根音の決め方 | 平均律の根音（現行どおり） |
| ピタゴラス音律の既定 | 基準音を選択でき、切れ目は E♭～G♯ |
| 7度などの比 | 候補を表示して選ばせるか、1つに固定するか |
| ビブラートの幅の定義 | 片側（±A）と山から谷（2A）の両方を表示するか、どちらか一方か |
| 対応を約束する最低版 | iOS／iPadOS の Safari 17 以降（Wake Lock をホーム画面のアプリで使うなら 18.4 以降）。Android の Chrome は最新の2つの主要版。MDN と実機で確認してから確定 |
| 実楽器の収録 | 団員の同意、保存場所、削除の方針を決めてから小規模に実施 |
| 指標の候補値 | 実験で決める（4章の候補値を出発点にする） |
