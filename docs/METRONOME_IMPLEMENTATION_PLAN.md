# メトロノーム機能 実装・検証計画

確認日: 2026-10-18。対象: 「メトロノーム機能 統合仕様案 Ver.1.0」全文。全フェーズの全機能を最終仕様に含める。**フェーズは実装の依存順序であり、後期機能の不採用や優先順位を意味しない。** 本書のファイル名・方式・試験・工程は【設計目標】であり実装済みではない。既存コード/公式文書/今回の計測に基づく【確認済み】の証拠と【推定】は[実現性調査](METRONOME_FEASIBILITY.md)、全要件IDは[要件追跡表](METRONOME_REQUIREMENTS_MATRIX.md)に記載した。

初回調査は新しい3文書のみを成果物とした。今回の設計改訂はこの3文書の指定修正と新規設計3文書に限定し、ソース・設定・他の既存文書を変更しない。試作は `.tmp/metronome-research/` のみ。コミット、push、デプロイ、DB変更は行わない。以下の実装手順は今後の作業案であり、今回実行した作業の記録とは区別する。

## 1. 全機能を収容する基盤を01で確定する

【設計目標】独立したメトロノームを管理者実験室に追加し、マイク不要の基本クリックと、同意付き解析を分ける。音楽位置は全音符単位の有理数、時刻は音声秒/出力frame、表示と解析は同じ不変イベント列を読む。入力Contextを出力Contextへ統合せず、共通出力管理者のlease/generationとAudio Session管理を介してチューナーと調停する。01で全曲・不定長待機・独立poly層・条件snapshotを表せるschema/transport契約を定義し、後期に音楽時間の正本を作り直さない。

| フェーズ | 実装対象と作業 | 主な依存/ID | 次へ進む条件【設計目標】 |
|---|---|---|---|
| 01a 基盤契約と比較 | 音楽時間/テンポマップ/transport/fence/共通出力の契約。AudioWorklet主候補、先読み/短bufferを同一イベント列で比較 | MX-01〜08/10/14/15/18、MS-01〜04、MR-01/02等のモデル | MT-01〜09、先読みを超える停止、予約取消を含む停止/即時変更/pause反応を計測。200〜300 msは比較候補で採用値ではない |
| 01b 基本UIと初期端末 | 基準音符BPM/TAP、単純/複合/加算、accent/細分、合成音/音量/count-in、振り子/補助振動/timer、保存選択、基本/拍子/設定画面、gesture/退出/背景/logout停止 | MB全件の操作、MU-01/02/07〜10、MX-09/16/17/19、01a契約 | MT-10/18/19/20と既存tuner回帰、iPhone/Android/PC初期実機。基本利用でマイク/音高解析/履歴不要 |
| 02 高度なリズム | 混合拍子/連続切替、n:m連符、独立poly周期/phase/LCM表示、swing、custom rhythm。高度画面。次小節編集と音/表示revision整合、有限queue/voiceの最大密度検査 | MS-05〜07、MR-03〜07、MU-03、MX-03/04/08/10 | 曲/層の位置と出力波形一致、LCM格子過大でも音を省略しない。最大burst/peak/メモリー/停止、端末負荷の実測で上限を確定 |
| 03 練習トレーナー | 段階tempo up/down、線形/指数加減速、無音小節/seed付きランダム、裏拍、拍感切替、tempo当て、step program、履歴。試行/記録/保存世代を分離。練習画面と結果導線 | MR-08、MP-01〜09、MU-04、MX-11〜15 | ramp積分/逆関数境界一致、mute中も期待位相維持。A実行→B開始→A完了/保存と全削除競合を検証。保存offでIDB/送信なし、account専用表とowner/API試験 |
| 04 オーケストラ特化 | 長休符、出番予告、指揮軌跡、楽曲map、fermata待機/手動再開、metric modulation、seek。小節ごとmeter/tempo/音色/mute、部分小節/反復/途中開始 | MO-01〜07、MU-05、MS-06、MP-02、MX-02〜05/10 | 長休符/混合拍子/fermata前後に重複・旧音・位置ずれなし。旧♩=新♪.の方向と120→90換算、seek/反復cue、count-in再開とtimer定義を確認 |
| 05 演奏解析・連携 | 明示同時使用、チューナー同時表示/既存trainer adapter、校正、attack検出改良比較、先行遅延/拍比/ばらつき/tempo安定/拍位置別集計、n/除外/信頼性/保留。解析画面。全端末/実楽器の最終受入 | MA全件、MU-06、MX-06/07/11〜15、MQ全件 | 合成信号と実楽器で検出/校正誤差を評価、閾値/最低nを確定。本人隔離/2tab/停止復帰/30分/光/電池まで版付き受入。団員公開は別の公開判断 |

【設計目標】付点音符は01、custom rhythmは02、tempo当て/programは03、pauseは01、seekは04、設定/preset画面は01から段階拡張という配置は、仕様の一覧を具体工程へ割り当てた提案である。正式仕様にフェーズが明記された機能の順序は変えない。05の精度受入を待たず、音が出る01から実機停止・gesture・光/音量安全を確認する。

## 2. ファイル候補と既存機能への影響を限定する

【設計目標】登録先は `window.PortalMetronomeLib`、共通出力部品は `window.PortalAudioLib`。`PortalTunerLib` へ登録しない。同名ファイルでも登録名/URL/release IDを分ける（MX-17/MX-18、MT-19）。共通出力管理は確定事項であり専用Context方式への選択待ちではない。

以下は【設計目標】でファイルは未作成。最終名称は既存命名と実装時の構成に合わせる。業務処理はservices/core/repositoriesへ置き、app_core.pyに新しい業務ロジックを足さない。本番入口main.jsと既存公開関数/UIイベント、依存順を維持する。

| 対象 | 新規/変更候補 | 責務・影響 |
|---|---|---|
| 純粋な音楽時間 | `src/static/js/modules/metronome/rational.js`, `score_model.js`, `tempo_map.js`, `event_compiler.js` | score→absolute time/frame、meter/group、連符/swing/poly、prefix/seek。DOM/Context/保存に依存させない |
| transport | 同 `transport.js`, `session_coordinator.js` | stopped/running/paused/waiting/interrupted、generation/revision/fence、境界確定、source取消 |
| 再生backend | 同 `scheduler.js`, `playback.js`, `click_processor.js`, `compiler_worker.js` | main先読み/Worker供給/Worklet/短buffer比較。既知曲線/譜面先渡し、queue上限、onended解放、遅刻drop |
| 共通音声調停 | `src/static/js/modules/audio/output_manager.js` 等（配置は提案） | 出力Contextの唯一owner、lease、音量合算、Audio Session、終了。チューナー変更はadapterと明示契約に絞る |
| 起動/画面 | metronome `launcher.js`, `index.js`, `view.js`, `view_rhythm.js`, `view_practice.js`, `view_score.js`, `view_analyzer.js`、専用CSS | 7画面、初回tap前準備、遅延ロード、状態表示、iPhone操作。クリックだけでマイク/解析を読まない |
| 設定/練習/保存 | 同 `settings.js`, `presets.js`, `trainer.js`, `workspace.js`, `storage_local.js`, `storage_remote.js` | schema、immutable snapshot、program、owner/delete/consent/outbox。チューナー履歴を混在させない |
| 解析 | 同 `calibration.js`, `onset_adapter.js`, `timing_analysis.js` | capture時計対応、校正、attack識別、assignment、品質/保留。既存onset/storeは契約を明示して参照 |
| ポータル接続 | `improvement_suggestions.js`, `navigation/routes.js`、logout関連、必要なloader manifest | 実験室の管理者判定、host可視性、await後の起動世代、退出/履歴復帰。新しいapp state正本を増やさない |
| チューナー接続 | tuner `playback.js`, `session_coordinator.js`, `launcher.js`, `index.js`, `trainer.js`, `view_trainer.js`, `workspace.js` の必要箇所 | 出力lease/共通adapter、予定時刻と受信時刻を分離。従来の保守的統計除外を緩めない |
| release | `scripts/generate_tuner_release.mjs` と新metronome release生成/manifest候補 | 共通audio、Worker/Worklet、CSS含めconsumerごとhash対象。改行正規化/識別行除外を統一、旧cache/protocol混在で停止 |
| account保存を選ぶ場合 | `src/backend/routers/metronome.py`, `services/metronome_service.py`, `repositories/metronome_repository.py`、`core/`のmodel/validator、`db/migrations/<最新採番>_metronome_practice.sql` | 本人owner解決、容量/版検証、history_epoch、DB Only。ルーターは薄く、録音/PCM列なし |
| 自動試験 | `tests/frontend/metronome_*.test.js`、既存配置に合わせたbrowser/e2e、`tests/test_metronome_*.py` | 純関数/波形/ブラウザー/APIと実機を区別。実装に同型の無意味な試験ではなく境界/競合を検証 |
| 後日の文書更新 | SYSTEM_DESIGN、専用詳細設計/API設計、release/Cloud Run/手動QA文書 | 実装時に仕様/運用差分を更新。今回これらは変更しない |

【設計目標】既存tunerを含む共通出力管理へadapterを介して移行する（確定事項）。回帰試験で既存契約を維持する。共有AudioContextを直接参照し合う構造を作らず、lease/generationで停止範囲を定義する。メトロノーム停止がチューナー入力を誤停止しない一方、退出/logoutは両方を確実に終了させる。

## 3. 境界と識別子を実装前に固定する

| 契約 | 設計目標 | 失敗時の扱い |
|---|---|---|
| スコア/テンポ | 全音符有理数、基準音価r、bpmTenths整数200..3000（計算B=tenths/10）。秒domainの線形/指数は積分/逆関数。区間prefix＋絶対計算 | 過大/不正な分数、負/ゼロBPM、展開超過を理由付き拒否。部分的に再生しない |
| 変更fence | generation/revision/score/audioFrameを一組で確定、source再予約/Worklet ack/UI/解析で共有 | 既予約より手前へ遡って変更しない。間に合わない場合は次の境界を表示し適用 |
| 時間写像 | input frame/effectiveFrame2、output frame、performance、UTCを明示。outputTimestamp利用時はoutputLatencyを二重加算しない | capture epoch/routeが変われば校正を失効、比較不可を表示 |
| 試行 | programRun/attempt/recordingID/課題/範囲を開始時snapshot | 古い解析は元試行だけを確定。現試行や音を止めない |
| 表示と保存 | viewGenerationはUI鮮度、owner/save/delete/history epoch/consentは保存有効性 | B開始で本人Aの有効保存を落とさない。logout/削除後は旧保存を新本人・新世代へ付替えない |
| conditions | tempoMapRevision、meter/group/pulse、route/calibration、analyzerVersionをeventごと保持 | 異条件の値を合格/成長へ合算しない。条件境界を真onsetに数えない |
| 退出 | 全予約を止め、processor有効終了frame更新、timer/source/振動/Wake Lock/所有leaseを解放 | 背景/着信で通知が遅れる場合も復帰照合。勝手に音を再開しない |
| 複数tab | 音声は一所有者、履歴はtransaction内削除世代照合。通知だけに整合性を頼らない | 退出/hidden/stop60秒で解放、準備中再取得。IDB確認付き引継ぎは旧音停止/世代guardで二重発音を拒否。H-010実機未試験を残課題表示 |

【設計目標】即時/次拍/次小節の適用単位を操作ごとに見せる。BPMは次pulse、meterは次小節を既定、volumeは短fadeで適用、mute/accentは選択境界、fermata再開は新原点とする。seek直後は停止既定。実時間timerと有効再生timerを区別し、pause/fermata待機をどちらに含めるか保存する。

## 4. 自動試験は正確な発音と正しい判定を別に検証する

試験IDは計画内の識別子。以下は【設計目標】、今回実行した試験は表の後に限定して記載する。

| 試験ID | 方法/条件 | 期待結果・報告値 | 対応要件 |
|---|---|---|---|
| MT-01 | 純粋モデル: 単純/6/8両基準/7/8群/混合、付点/素数連符、有理数正規化  bpmTenths200..3000の整数正本、十進四捨五入/端点/範囲外拒否。| 小節長・イベント数・境界一致。group合計不正/安全整数超過拒否 | MX-01、MS全件、MR-01〜03 |
| MT-02 | 定数/段階/線形/指数、加速/減速、a/k≈0、長区間、区間境界  start/endBpmTenthsからの変換、TAP/換算の半端丸め、曲線途中を量子化しない。| 積分と逆関数の往復、B>0、単調増加時間、端点連続。許容誤差はsample境界から決める | MX-02、MP-01/02 |
| MT-03 | poly異周期/phase、3:2、巨大LCM、swing/連符重畳、custom | 実発音列と表示格子を混同しない。表示省略でも全イベント保持 | MR-03〜07 |
| MT-04 | Offline44.1/48/対応sampleRate、既知impulseと実クリック波形 | 理論frameと開始sampleを比較、最大/分位誤差・欠落/重複。音色のenvelope開始点を定義 | MQ-01、MX-03 |
| MT-05 | 全層同時/最大tail/音量変更/fade/stop、波形peak測定 | clipなし、急な不連続なし、有界voice/source/queue、終了後参照解放 | MB-07/08、MQ-03 |
| MT-06 | 偽時計で補充50/100/250 ms/2秒停止、stop後の古callback/ack | 過去音を連打せず欠落数記録、将来位相不変、旧世代の出力0 | MX-05/14、MQ-06 |
| MT-07 | 実時間main/Worker/Worklet/chunkを同一列、idle/busy/DOM/GC、各条件反復。各先読みHに対し0.5H/H/1.5H/2Hおよび2秒の停止を加える | 投入遅延p50/p95/p99/max、補充間隔、underrun/欠落、CPU/memory。Worklet出力dropoutは別観測 | MX-08、MQ-02/04 |
| MT-08 | 再生中BPM/meter/音価/音色/mute変更、即時/次拍/次小節、先読み範囲内取消。Hを長くし停止/即時変更/一時停止の要求→最終旧音→新revision/無音の反応時間を測る | 同じfence、重複/旧音なし。表示予約revisionと実際のrevisionが一致 | MX-04、MS-07 |
| MT-09 | pause/resume/seek/fermata/長休符/反復/cue、metric120→90 | 正しい位置、新原点、再開二重音なし、cue一回、timer意味の一貫 | MB-14、MO全件 |
| MT-10 | hidden/route/logout中のresume待ち・load待ち・Worklet ack待ち | await後の権限/可視性/世代確認、予定音取消、復帰自動再生なし | MX-05/09/16/17 |
| MT-11 | A課題→遅い解析→B課題→A完了/保存、A/B逆順保存 | AはAのみ確定、B停止なし、A有効保存維持、UIはBのみ。DC-13/17/19再発なし | MP-09、MX-14 |
| MT-12 | BPM/拍子/校正変更をまたぐ観測、条件境界/pitchChange | 条件snapshotで分層、偽attackなし、旧条件を新設定で再評価しない | MA-01/07、DC-15/18 |
| MT-13 | IDB保存off/quota/2tab/delete/logout/409、1〜2層の合計16予定拍/秒開始前検査、1800秒/28800予定拍/7200余剰詳細、推定256B/件・metadata2MiB×5記録＋4MiB→64MiB、persist拒否/削除・復旧を実測 | 上限超過は解析開始拒否/再生継続、余剰打切り表示、要約だけ256group/1part/256KiB・個別送信0、条件集計整合、削除復活なし。H-010は実ブラウザーまで未完 | MX-11/12/15、MP-08、MA-05〜08、MQ-03/04 |
| MT-14 | API匿名/団員/管理者/別組織/hidden/失効/同数値member再作成、他人ID  tuner未使用本人のmetronome初回owner作成、members行lock/部分一意索引、両機能同時初回/再試行/端末認証時刻を検証。| 実験室認可、本人のみ、404/権限拒否、member_birth失効、DB Only/個人同期除外 | MX-12/13/16 |
| MT-15 | preset旧/未知版、巨大JSON/危険key/循環参照/過剰展開、storage upgrade失敗  設定16KiB/専用preset IDB・unknown版・保存失敗を確認。localStorage近満杯で設定保存してもポータル他keyのbytes不変・ログイン維持・再生継続。tenths整数/丸め/範囲検証。| コピー移行、未知版保全/拒否、read-only、破損データが既存値を上書きしない | MX-10 |
| MT-16 | attack5〜200 ms ramp/低高音/複合音/連打/legato/雑音/混入/clip/gap | onset誤差・precision/recall・誤分割・欠測・校正回収誤差、信頼性と保留。PCMは一時メモリー | MA-01〜08/10 |
| MT-17 | 先行/遅延既知合成列、意図したramp、長休符後、n不足 | 符号/ms/局所基準拍比、順序対応、IOI比安定性、n/除外理由、保留を検証 | MA-05〜08 |
| MT-18 | 最大zoom/全画面/全層、flash輝度/面積/赤、reduced-motion、読上げ | WCAG2.3.1基準内、安全な初期表示、状態/停止操作を認識 | MU-08/09、MQ-07 |
| MT-19 | 旧cache/新main/旧Worklet/worker、release不一致、チューナー通常起動、同一ページ両機能の正順/逆順/遅延ロード  共通lockのtuner移行、running競合表示、stop60秒/hidden解放・準備中再取得、IDB確認付き引継ぎ/世代/旧permit失効/旧tab復帰で二重発音なし。| PortalMetronomeLib/PortalAudioLib/PortalTunerLib・登録名・m-/a-/t-・Worker/Worklet URL・processor名の非衝突、混在で停止/再読込案内、権限/読込順/既存UI/音源/測定の回帰なし | MX-17/18、MA-09 |
| MT-20 | release safety/ZIP include list、payload/log/ネットワーク観測 | .tmp/録音/PCM/秘密/.env/.git/実データを含めない、不要送信なし | MX-19、MQ-09 |

【設計目標】01実装時は数値上限を決める前に、基準音価rと各層の連符置換比n:mを含む `R=(Bmax/60)*Σ(32*r*n/m)` と瞬間voice数を算定する。仮の四分300BPM/7:4/4層=280events/sに加え、異周期の同時集中、細分slot全置換、最大tailのstressを作る。200〜300 msは比較候補で採用値ではなく、MT-07/MT-08で先読み超え停止と予約取消反応を測ってqueue容量と余裕を決め、平均頻度だけで決めない。実機出力の許容誤差/欠落基準は製品上限と使用端末の計測後に明示する。現段階で「常に1 ms以内」等の保証値は置かない。

【確認済み】今回の試作 `node .tmp/metronome-research/measure.cjs` はWindows/Playwright1.61.1/Chromium149.0.7827.55 headlessのみ。Offline499/499・最大0sample（44.1/48k）、100ms/25ms idle遅刻0、180ms busyで32件/最大71.13ms、Worker通知で36件/最大82.74ms、300ms先読みで0件。既存schedulerの2秒stallで過去7件/最大1.72秒、stop後古callbackは0件。遅刻はJS予約投入時刻で実音時刻ではない。Worklet、新モデル、GC/DOM、30分、校正/解析、モバイルは未試験。再現条件と結果の全体は[実現性調査§3](METRONOME_FEASIBILITY.md#3-小規模試作は先読み不足を確認し実音精度は未検証である)に記載した。

【設計目標】実装時は変更範囲に応じcompileall/Ruff/pytest、frontend syntax/Vitest/Playwright、release safetyを実行し、必要な前提ディレクトリ/fixtureを準備する。保護対象や権限拒否を回避目的で変更しない。失敗時は既存mainでも再現するか確認し、新規変更由来と既存失敗を区別する。今回は文書のみのためこれらの全アプリ試験を合格済みと報告しない。文書はencoding/LF/末尾空白、local link、ID/phase網羅、Git diff/statusで検証する。

## 5. 実機チェックリストへの追記案（今回は既存文書を変更しない）

【確認済み】既存[MANUAL_DEVICE_QA_CHECKLIST.md:162–225](MANUAL_DEVICE_QA_CHECKLIST.md#L162)のチューナー実機項目は未実施と明記されている。以下は後日その文書へ追加する案で、今回結果は全て【未検証（実機が必要）】。試験記録には実行日、端末型番、OS完全build、browser完全版、Safariタブ/PWA、電源/省電力、入力/出力経路、sampleRate、release/protocol、AudioContext.state、API有無を必須にする。iPhone/iPad SafariとHome Screen、Android Chrome通常/省電力、PC Chrome/Edge/Safari等の対象版は実装時に確定し、旧対応下限と当時の最新版を分ける。

| QA-ID | 手順案 | 期待結果/記録 | 結果 |
|---|---|---|---|
| MD-01 | 初回/再訪の明確な再生ボタン、ロード遅延、スクロール後、resume待ち中退出 | gesture内生成/resume、拒否理由を表示。退出後に音が始まらない。基本クリックでマイク許可不要 | 未実施 |
| MD-02 | iOS消音ON/OFF×本体/有線/BT、音量0、audioSession有/無、playback/play-and-record | 鳴る/止まる/音量/経路と他アプリ音声への影響を記録。機能検出だけで成功にしない | 未実施 |
| MD-03 | Safariタブ/PWA別にWake Lock取得/拒否/release、省電力、30秒/5分/15分前景 | 自動消灯抑制の実効を記録。拒否/解放表示、機能は利用者任意。背景継続保証にしない | 未実施 |
| MD-04 | 大量予約中にロック/ホーム/別タブ/退出/logout、戻る/進む/画面復帰 | 予約音と振動停止、旧ロード/ack無効、復帰は停止して手動開始。実音停止までの時間も記録 | 未実施 |
| MD-05 | 着信/Siri/アラーム/他アプリ、イヤホン抜去、BT切断/再接続 | interrupted/suspendedを正しく表示、手動再開、route/校正失効。マイク終了後も音量/経路確認 | 未実施 |
| MD-06 | Android通常/省電力、無音小節を含む前景/hidden5分超、振動設定ON/OFF | 背景停止契約と復帰、振動API戻り値と実motorを別記録。停止でvibrate(0)等の終了 | 未実施 |
| MD-07 | 基準録音/ループバックで低高BPM/32分/連符/poly/ramp、負荷有無、各30分 | click間隔誤差p50/p95/p99/max、欠落/重複、drift、熱/電池、source/queue/memory勾配。JS投入遅延と実音誤差を別報告 | 未実施 |
| MD-08 | 本体/有線/BTごと音と拍/振り子/指揮を撮影、timestamp API有/無、表示補正 | 音/表示のずれと変動。outputLatency二重補正なし、描画落ちで音が変わらない | 未実施 |
| MD-09 | 再生中BPM/meter/groups、pause/resume/seek、反復/fermata再開、cue/count-in | 適用境界表示、位相/小節位置維持、古い音/二重音/追い付き連打なし、timer定義一致 | 未実施 |
| MD-10 | TAP8回以上、外れtap/reset/長休止、片手/縦横/ズーム/画面端/スクロール | 有効数と推定BPM、誤touch除外、44px目標、停止固定。物理接触→callback遅延を別測定 | 未実施 |
| MD-11 | 最大BPM/細分/全層/全画面/最大ズームの映像・輝度/面積/赤flash、reduced-motion | WCAG2.3.1内、低刺激/静的表示、初期安全。確認前に光過敏のある人へ試験を依頼しない | 未実施 |
| MD-12 | VoiceOver/TalkBack/キーボード、基本/詳細/状態/結果/停止/信頼性を操作 | 読上げ/focus/ラベル/変更通知、色だけに依存せず片手で停止できる | 未実施 |
| MD-13 | チューナー単独→排他→明示同時/イヤホン、クリック/基準音/入力の切替 | 音声所有/音量安全、tuner統計除外維持。metronomeは別eligibility/n表示 | 未実施 |
| MD-14 | route固定で往復校正複数回、本体/有線/BT、距離/入力設定変更 | 中央値/残差/条件表示、切替失効、outputLatency二重補正なし。PCM保存/送信なし | 未実施 |
| MD-15 | 打楽器/弦/木管/金管/低音、遅いattack/legato/強弱/連打、クリック漏れ | onset正解との誤差/precision/recall/除外数、n不足/混入/校正不足は保留、奏法の良否を断定しない | 未実施 |
| MD-16 | A練習→解析/保存遅延→B開始→A完了、BPM/拍子/校正変更を挟む | AはAだけ確定、B停止なし、A有効保存維持、異条件の成長/合格混合なし | 未実施 |
| MD-17 | Safari/Chrome各2タブ、IDB2接続でquota待ち保存/全削除/identity再取得、logout/別owner  音声claim tabId/heartbeat/stale確認付き引継ぎ、旧tab復帰/時計変更/permit失効、runningは奪わずhidden/stop60秒解放も確認。| 削除復活なし、old outbox再所有なし、H-010の実transaction順序を記録。音声は一所有者 | 未実施 |
| MD-18 | 初期履歴off、端末/account選択、同意撤回、削除/容量満杯/unknown schema | 不要IDB/送信なし、未送信破棄と送信済み削除の区別、read-only保全/本人隔離 | 未実施 |
| MD-19 | 旧タブを残して新release読込み、Worker/Worklet cache混在、旧タブ復帰  tuner共通lock移行、片方running中の他方stopでは解放しない。旧版混在拒否、再表示準備中/再取得/再タップ、fallback引継ぎの旧音停止を確認。| 不一致停止/再読込案内、勝手な発音/二重ownerなし、既存tuner起動維持 | 未実施 |

【設計目標】MD-07/08/14/15用の参照録音はQAの明示した一時データとして扱い、製品履歴/共有ZIPに入れない。製品実装は録音/PCM非保存・非送信を維持する。実機失敗はOS/browser/route別の制限表へ残し、全端末成功と要約しない。前景を基本とし背景停止/手動復帰、Wake Lock任意という確定事項を検証し、端末制限を明示する。

## 6. DB・リリース・共有ZIPへの影響

【推定】端末だけの設定/preset/履歴にはサーバーDB migrationは不要だが、最終仕様は本人account保存も選べるため専用表の追加設計が必要である。【設計目標】既存owner UUID/member_birth/active/history_epochの解決原則を共通化し、メトロノーム専用表を追加する。既存チューナー017の実装文書は過去の使い捨てDB試験を記録しているが、本番/共有DBの現在状態は今回未照合である。

| 構成案 | 最低限の列・制約案 | 削除/ロールバックの考慮 |
|---|---|---|
| metronome_sessions | UUID、owner FK/組織、history_epoch、recording/attempt/program ID、開始/終了/状態、schema/解析版、tempoMap/条件snapshot、要約、容量 | owner本人のみ、ID冪等、記録一回確定。全削除範囲を明示 |
| metronome_summary_groups | session FK、ordinal0..255、condition/layer/拍位置key、件数/統計/品質。観測ごとの値は端末のみ | 個別観測DB表案を撤回、最大256集計行/記録、owner/session整合・削除連鎖 |
| metronome_presets | owner FK、UUID、schema、kind、検証済JSON、版/更新時刻 | 容量/循環/展開上限。共有/公開は別仕様、他人読取不可 |
| consent/機能別epoch | 既存owner配下を汎化するか専用表。savedPolicy/削除世代 | tunerと共通全削除か機能別かを先に確定。古い送信は新epochへ移さない |
| 校正 | 端末だけに保存。account保存は設計しない（確定） | route/OS/browser/sampleRate変更で無効、精度の過信を防ぐ |

【設計目標】migrationは実装時の最新番号で追加し、既存checksum/適用chainを `scripts/migrate_db.py` の運用に合わせて検証する。新表/制約/索引/ownerロック順、再適用skip、owner失効、全削除と同時保存、production→test同期除外を使い捨てDBで確認する。既存列を壊す変更を避け、アプリをoffに戻せる追加形式にする。

| 順序 | 将来の作業案 | 完了証拠/今回の状態 |
|---|---|---|
| 1 | 仕様/保存先/削除範囲/対応版/上限を確定し、専用環境でコード/DB試験 | 今回は提案のみ |
| 2 | migration chain/checksum、backup/復元、追加表の容量/認可、test個人データ非複製を確認 | live DB未確認 |
| 3 | 実験室機能offの配布準備、main/launcher/shared audio/Worker/Worklet/CSSのrelease一式生成 | 今回生成/配布なし |
| 4 | `docs/PRODUCTION_RELEASE_CHECKLIST.md` と `docs/CLOUD_RUN_GCS_DB_CHECK.md` に沿って本番の読取りpreflight、通常のリリース手順で必要migrationを適用 | 今回は本番/DB操作なし。録音のGCS連携は本機能に追加しない |
| 5 | 管理者実験室だけ有効化し、版/認可/音/停止/保存offを確認。受入結果を記録 | 今回有効化なし |
| 6 | 団員公開を選ぶ場合、メニュー/route/API/履歴復帰/所有者隔離/全対象端末受入後に範囲変更 | 未確定 |
| 7 | rollbackは機能off→旧アプリへ戻し新表/データを保持。必要時はbackupから別の復元手順 | DROPでのrollbackは既定にしない。データ削除は別の明示手順 |

【確認済み】共有ZIPはinclude rootsのallowlistで `.tmp/` を含まず、さらに.env/.git/.venv/node_modules/実データ/credentials等を除外する（[create-source-zip.py](../scripts/create-source-zip.py)）。【設計目標】将来 `npm.cmd run check:release-safety` と必要に応じ `npm.cmd run zip:source` の実際の生成物を確認し、新sample音の再配布条件と容量も点検する。調査スクリプトをsrc/tests/scriptsへ移して成果物へ紛れ込ませない。通常CI/CD/Lint/型/データ保護を維持する。

## 7. 確定事項と実装着手時の調整

| 論点 | 推奨【設計目標】 | 確定しないと影響する箇所 |
|---|---|---|
| UI/出力統合 | 独立機能＋共通出力調停、入力分離（確定） | adapter/loader/遷移/lease/既存tuner移行回帰 |
| 管理者実験室/団員公開 | 管理者開始、受入後公開判断 | UI/API/route認可、対象端末/案内 |
| BPM/連符/周期/層/queue上限 | 全機能維持の上で実測に基づく安全上限 | 密度予算、拒否表示、保証する品質条件 |
| 音色とsample採否 | 合成を基準に短sampleも比較 | ライセンス、配布容量、decode/peak |
| 基準拍/表示拍感、tempo curve/変更境界 | 独立モデル、秒domain線形/指数、BPM次拍/拍子次小節 | 保存schema、編集fence、誤解防止 |
| tempo当て/program/cue/指揮/fermata | 詳細設計のstep schema、tap/予備拍任意、数字/合図音、群拍template編集 | cue音声読み上げだけ採否保留 |
| タイマー/TAP/振動/背景の期待 | 有効再生timer、4〜8間隔候補、補助振動、前景Wake Lock/背景停止 | 合格条件、端末制限、物理精度の案内 |
| 設定/preset/履歴/校正 | 本人選択の端末設定/preset、履歴初期off・端末/account選択、校正端末のみ（確定） | 専用表追加/owner共通化/同意、機能別削除推奨、容量/期限は調整値 |
| 解析の最低n/合格閾値/許容誤差 | 校正/検出試験後に決定、不足は保留 | 結果UI、信頼性、実楽器受入 |
| 対応OS/browserの下限と実機調達 | Safari/PWAを別列、Android省電力/PC/BT別経路 | QA実行範囲、制限表、公開受入 |

【未検証】新エンジン/保存/解析の実装はまだなく、上記の受入試験も未実施である。今回の成果は、全機能の依存と制約を表し、試作が証明した範囲を限定し、今後の実装・実機確認を具体化した3文書である。

【設計目標・確定事項】公開は管理者実験室開始、独立機能と共通出力（入力分離）、合成基準/具体sampleは実装時、設定/preset保存は本人選択、履歴off→端末/account本人選択、校正端末のみ。秒domain線形/指数は楽譜位置終点からDを計算しdurationを保存しない。BPM次拍/meter次小節を既定に操作別境界選択、fermata tap/予備拍任意、cue数字/合図音（読み上げ保留）、群拍指揮template編集、前景/背景停止/手動復帰・Wake Lock任意・iOS振動代替を設計する。従来の「実装着手前に確定」表のうちこれらは確定済みで、残るのは具体素材・測定上限/閾値・団員公開判断等である。詳細正本は[基本・詳細設計](METRONOME_DESIGN.md)と[データ/API設計](METRONOME_DATA_API_DESIGN.md)。

## 改訂履歴

| 日付 | 修正点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | レビュー修正1: 試験IDをMT-01〜MT-20へ統一、チューナーの3桁AT要件とは分離 | MQ-01〜12、MX-17/MX-18 |
| 2026-10-18 | 修正2: PortalMetronomeLib/PortalAudioLib分離、release/Worker/Worklet/登録名非衝突と同一ページ回帰 | MX-06/MX-17/MX-18、MA-09 |
| 2026-10-18 | 修正3: tempoMapの楽譜位置終点を正本、durationSeconds非保存、秒domain線形/指数維持 | MP-02、MO-04、MX-01/MX-02/MX-10 |
| 2026-10-18 | 修正4: 180ms<300msの試験限界、先読み超え停止と取消反応をMT-07/MT-08へ追加、200〜300msは比較候補 | MX-04/MX-05/MX-08、MQ-02/MQ-04/MQ-06 |
| 2026-10-18 | 利用者決定事項反映、01a基盤契約/比較と01b基本UI/ライフサイクル/初期実機へ分割 | MB全件、MS-01〜04、MR-01/MR-02、MU/MX/MQの01開始行、MP/MO/MAの関連契約 |

【設計目標・整合追記】設定localStorage16KiB/preset専用IDBは維持。解析1〜2層合計16予定拍/秒、記録1800秒/予定28800件＋余剰詳細7200件、端末予算64MiB。accountは個別観測送信0・条件/拍位置別group256・1part(index0)/body256KiB。旧400件/秒による保存見積りは撤回する。

### 2026-10-18 レビュー5点の改訂

| 日付 | 修正点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | 修正1: preset専用IDB、設定localStorage16KiB、他key/認証不変・失敗表示/再生継続、MT-15 | MB-13、MU-07、MX-10、MQ-09 |
| 2026-10-18 | 修正2: lock退出/hidden/stop60秒解放、準備中再取得、IDB heartbeat/世代/確認付き引継ぎ・旧出力失効、tuner移行、MT-19/MD-17/19 | MX-06、MX-15、MQ-06、MX-17/MX-18 |
| 2026-10-18 | 旧修正3（今回撤回）: 再生400件/秒を観測頻度に誤適用した288万件/4GiB見積り。下記の再訂を正本とする | MP-08、MA-05〜08、MX-11/MX-13、MQ-03/MQ-04 |
| 2026-10-18 | 修正4: bpmTenths/startBpmTenths/endBpmTenths整数200..3000、保存時四捨五入/範囲外拒否、MT-01/02/15 | MB-01/MB-03、MP-02、MO-04、MX-01/MX-02/MX-10 |
| 2026-10-18 | 修正5: DDL冪等記法、tuner未使用の初回owner作成/同時作成、物理名中立化は将来、MT-14 | MX-12/MX-13、MQ-08/MQ-09 |

### 2026-10-18 修正3のやり直し

| 日付 | 理由・変更点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | 再生負荷400件/秒と観測頻度を混同した前提を撤回。解析対象1〜2層/合計16予定拍/秒を開始前検証、30分1800秒/予定28800件＋余剰詳細7200件 | MP-08、MA-01/MA-05〜08、MX-11、MQ-02/MQ-03 |
| 2026-10-18 | 7200秒の記録枠/512B×2/4GiBを撤回。256B/件推定・最大密度5記録/各metadata2MiB＋余裕4MiB→64MiBを調整値に。origin共有/空き不足/消失/persist/書出しを明記 | MB-13、MP-08、MX-10/MX-11/MX-15、MQ-03/MQ-04 |
| 2026-10-18 | 詳細は端末、accountはセッション/条件/拍位置集計だけ。個別観測送信0、最大256group/1part(index0)/256KiB。DB raw表案をsummary_groupsへ変更しDDL/API/MT-13を整合 | MP-08、MA-06/MA-07、MX-11/MX-13/MX-19、MQ-06/MQ-09 |

修正1・2・4・5と、引継ぎ時の停止ack／期限付き出力guardの追加判断は維持する。本改訂は保存上限・対象解析頻度・要約同期の修正だけで、実装/実機/SQL実行の合格ではない。
