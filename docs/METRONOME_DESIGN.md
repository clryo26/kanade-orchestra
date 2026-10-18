# メトロノーム 基本・詳細設計 Ver.1.0

作成日: 2026-10-18。入力: 統合仕様案 Ver.1.0（前回提示された全文）、[実現性調査](METRONOME_FEASIBILITY.md)、[97要件](METRONOME_REQUIREMENTS_MATRIX.md)、[実装計画](METRONOME_IMPLEMENTATION_PLAN.md)。今回の利用者決定を優先する。全機能を最終対象とし、01a・01b・02〜05は実装順序である。

これは実装完了表ではない。ソース、マイグレーション、DB、公開設定は変更していない。通信・保存・DDLは[データ/API設計](METRONOME_DATA_API_DESIGN.md)、各要件の設計・試験参照は[設計対応表](METRONOME_DESIGN_TRACEABILITY.md)を参照する。節へのリンクは明示した英字anchorを正本とする。

| 表記 | 意味 |
|---|---|
| 確認済み | 既存コード、一次資料または前回の計測で確認した事実。実機試験の成功とは別 |
| 推定 | 事実からの技術的判断。品質保証ではない |
| 設計目標 | 本書の実装契約・採用設計。未実装であり性能保証ではない |
| 調整値 | 暫定の試験入力・安全制限。計測後に版付きで変更する |
| 未検証（実機が必要） | 実端末・実楽器・物理経路での未試験。その他の未試験も未検証と明記 |

以下の仕様文・必須条件・表の規則は、別ラベルのない限りすべて【設計目標】である。

<a id="scope"></a>
## 1. 対象・確定事項と公開条件

独立したメトロノームをシステム管理者の実験室に置く。基本クリックはマイク許可なし、音高解析のロードなしで利用可能。チューナーとは出力Contextの所有・lease・世代・音量合算・Audio Sessionだけを共通化し、入力Context/track/解析の所有は分ける。同時表示と既存trainerのメトロノーム課題はadapterで接続する。

音色は合成を基準に短サンプルも選択可能な構造。設定/端末preset保存は本人選択、履歴は初期offで端末内または本人accountを選択。校正値は端末内のみ。録音・PCM・全FFTを永続保存・送信しない。アカウント用専用表はデータ設計で定める。

背景・ロック・割込みは中断して手動再開する。Wake Lockと振動は補助、iOSの振動は音と光で代替する。全機能採用は端末能力の一律保証を意味しない。団員への公開は別判断で、次の全条件を満たすまで管理者限定を維持する。

| 公開受入 | 必須証拠 |
|---|---|
| 認可 | 画面/route/戻る進む/履歴復元/APIの匿名・一般団員・失効端末・他組織・hidden member試験。現在は一般団員を拒否 |
| 本人隔離 | owner/member_birth/同意/削除世代、他人ID404、管理者も他人閲覧不可、ログアウト後非同期処理無効 |
| 端末 | 01b初期確認だけでなく05の版付き対応表、実音・停止残音・背景復帰・光・2タブ・保存競合を受入 |
| 運用 | DB chain/checksum/復元と機能off rollback、release混在停止、端末制限の利用者向け説明、個人データtest非複製 |
| 公開判断 | 97要件の未完/制限を示した受入記録と公開範囲の別の決定。メニュー表示変更だけで公開しない |

<a id="architecture"></a>
## 2. 構成・名前空間・読み込み・リリース

既存のclassic script/IIFE、純粋関数のmodule.exports、WorkerのimportScriptsを踏襲する。グローバルの正本は登録用namespaceだけとし、DOMや認証状態の複製を置かない。

| 配置候補（すべて未作成） | 登録先と責務 |
|---|---|
| `modules/metronome/rational.js`, `score_model.js`, `tempo_map.js` | `window.PortalMetronomeLib.rational/scoreModel/tempoMap`。正規化・位置・積分、DOM不要 |
| 同 `event_compiler.js`, `transport.js`, `session_coordinator.js` | 同 `eventCompiler/transport/sessionCoordinator`。不変イベント、状態、世代 |
| 同 `scheduler.js`, `playback.js`, `click_processor.js`, `compiler_worker.js` | 同 `scheduler/playback`、Worker自身のscope。交換可能backendと有界再生 |
| `modules/audio/output_manager.js`, `audio_session.js` | 第3の `window.PortalAudioLib.outputManager/audioSession`。tuner/metronomeの双方が参照 |
| metronome `launcher.js`, `index.js`, `view*.js`, 専用CSS | `PortalMetronomeLib.launcher/...`。`#systemMetronomeHost` 配下。CSSは `.metronome-*` |
| 同 `settings.js`, `presets.js`, `trainer.js`, `workspace.js`, `storage_*.js` | 端末設定、課題、所有者、保存。業務をindexへ集めない |
| 同 `calibration.js`, `onset_adapter.js`, `timing_analysis.js`, `analysis.worker.js` | 独立入力の時刻/発音/統計。tuner adapter経由で必要な共通型だけ参照 |
| 同 `tuner_adapter.js` と既存tunerのadapter接続 | 既存公開イベントを維持し、旧trainerの定速課題を新engineへ翻訳 |
| backend `routers/metronome.py`, `services/metronome_service.py`, `repositories/metronome_repository.py`, `core/`の型 | 薄いrouter、サービスの業務、repositoryのDB。app_coreは互換ファサード |

`PortalTunerLib` にメトロノームを登録しない。既存tunerの同名ファイル/登録名を上書きしない。共有moduleの初期化は1回、二重ロードは同一releaseのみ冪等、別releaseは拒否する。

本番入口main.js、app_state→runtime_context→mainの順は維持する。認証はgetAppState()/portalRuntimeContext.appState、`portalAppState`以外の正本を作らない。実験室入場でmanifestと基本資産を先読みし、再生ボタン準備完了を表示する。依存順は shared audio → rational → score_model → tempo_map → event_compiler → transport → scheduler/playback → settings/presets → coordinator → view → index。launcherは先に薄く用意する。

| 遅延グループ | 読込み契機と順序 |
|---|---|
| 基本/拍子/設定 | 入場で上記基本列とCSS。マイク/音高/履歴DBを読まない |
| 高度 | 初回表示で層編集→高度view。純粋な全型のvalidatorは01aから存在 |
| 練習/楽曲 | trainer→workspace→view_practice、score_editor→view_score。音声は再生成しない |
| 解析/チューナー | 明示開始で入力/校正/onset/timing worker→adapter→view。単なる同時表示要求で出力を再開しない |
| 履歴 | 本人識別/保存選択後にstorage_local/remote→history view。初期offで履歴IDBなし |

失敗したload Promiseだけキャッシュから外し再試行。await後は必ず権限/host可視性/launch世代を照合。基本module未準備なら再生は有効化せず、必要なら「準備完了後に再タップ」を求める。

releaseは `m-<hash12>`（metronome）、`a-<hash12>`（shared audio）、既存の`t-`を分ける。実ファイル本文をLF正規化し識別行を除外してhash、共有資産hashもconsumer manifestへ含める。配信URLは `/static/js/modules/metronome/compiler_worker.js?rev=m-...`、`.../metronome/click_processor.js?rev=m-...`、共有は `.../audio/...?...a-...`。tuner URLを再利用しない。processor登録名は `portal-metronome-click-v1-m-<hash12>`、将来のtuner processorと別。Context内addModule cacheは完全URLで管理する。release、sharedRelease、protocolの不一致は出力停止/lease解放/再読込み案内。MT-19で同一ページの正順・逆順・並行ロード、旧cache、片方終了、各Worker/Workletを確認する。

### 2.1 adapter契約

`tunerAdapter.mount({host,launchEpoch,authSnapshot})` はメトロノーム内の明示した同時表示領域へtuner view/controllerを接続する。既存の隠れた実験室hostを起動せず、launcherの認可/可視性判定へ渡すhostをこの領域へ切り替えるadapterを設ける。見えないhostを可視と偽装しない。mountだけではマイク/音源を開始せず、明示マイク開始は独立capture ownerを要求する。unmountはそのadapterが開始したcaptureだけを閉じ、metronome出力を止めない。portal全体のleave/logoutはcomposerが両方を解放する。既存tuner単独入口と公開UIイベントは残す。

`trainerAdapter.start({attemptId,bpmTenths,beatsPerBar,count,targetSnapshot})` は旧定速課題をScoreSnapshotに変換し、同一メトロノームengineのtransport/leaseを1つだけ利用する。既存の持続音target・結果の音高評価はtuner側に残し、クリックと光の拍だけ新event時計へ接続する。別の独立練習がrunningならOUTPUT_BUSYを返し、利用者が停止/切替を選ぶ。二重クリックを同時生成しない。`stop(attemptId)`/`result(attemptId)` は同じ試行にだけ作用する。音高結果と新タイミング指標は別欄・別eligibilityで返す。MT-11/19で単独入口・composer・旧課題を切替え、host/owner/lease/イベント解除を確認する。

<a id="lifecycle"></a>
## 3. 起動・退出・復帰のライフサイクル

1. enterでlaunchEpochを進め、本人の管理者権限、host接続、祖先hidden、document.visibilityStateを確認する。機能内画面切替ではleaveしない。資産とoriginの音声claimを非同期で準備し、Contextはまだ作らない。claim取得後だけ再生ボタンを有効化する。競合なら「準備を再試行」からclaimを取得して再タップを求める。
2. 明確な再生pointer操作の同期部分で、準備済みclaimを照合して共通managerの`unlockFromGesture()`を呼び、Contextを生成しresumeを開始する。マイクは要求しない。await前に呼ぶことを契約化し、gesture中にWeb Lockの非同期取得を待たない。
3. lease/資産load/resume/Worklet initの各await後にlaunchEpoch、ownerEpoch、権限/可視性を再確認。失効なら当該lease/sourceを破棄し音を始めない。成功後にだけtransportを開始する。
4. suspend/interrupted/route変更はinterrupt(reason)。入力trackは当該capture ownerが止める。Wake Lock取得成功が後着でも、退出済みなら直ちにreleaseする。
5. leave、hidden、pagehide、logout、権限失効で同期的に世代を失効し、master/lease gateを閉じ、予定source/Worklet/タイマー/振動を停止。非同期closeを待つ前に古い完了を無効化する。最後のleaseでContext/portを解放する。
6. 再表示はstoppedまたはinterrupted表示。lockを再取得する間は準備中で再生を無効化する。マイク、クリック、課題を自動再開しない。本人再確認と再タップで新原点・新captureEpochを作る。

【確認済み】既存launcherのawait後照合と排他管理は[調査§1](METRONOME_FEASIBILITY.md#1-既存チューナーは安全管理を再利用し音楽時間を拡張する)に根拠を記載した。【未検証（実機が必要）】通知が遅れるOS割込み、既に物理出力へ送られた音の停止所要時間。ページから既出力sampleを回収できるとは約束しない。

<a id="output"></a>
## 4. 共通出力管理・排他・音量

managerはContextの唯一のowner。利用側へContextを自由にcloseできる参照を渡さず、lease scopedのsource factory、bus、時計snapshot、cancel APIを渡す。

| API案 | 契約 |
|---|---|
| prepareClaim(consumer,launchEpoch) | 入場準備でorigin lock/claimを確保、Contextは作らない。同一ページmanagerの利用者間で共有、退出/hidden/全consumer停止60秒で解放。再操作時に再取得、取得待ちは準備中 |
| unlockFromGesture() | 同期生成/resume開始。戻りPromise成功だけで再生開始しない |
| acquire({consumer,launchEpoch,mode}) | 一意leaseIdとoutputEpoch/leaseGenerationを返す。既定exclusive。競合時は409相当OUTPUT_BUSY、黙って他機能を停止しない |
| requestConcurrent({captureOwner,headphonesDeclared}) | 毎入場の明示選択。入力/出力双方の同意と権限を確認、tuner統計除外を通知 |
| cancel(leaseId,generation,fromFrame) | 当該bus/sourceのみ取消。世代不一致はno-op。render済みsampleは取消不可 |
| release(leaseId) / shutdown(reason) | releaseは冪等、shutdownはlogout等の全体停止。片方の通常stopで他方の入力を閉じない |

出力busはconsumer→層→voice。各voiceのpeakを1以内へ正規化し、tail込み最大同時voice数Vの上限からbus gainを1/V以下とする。全leaseのbus peak予算和をmaster予算内に収める。初期master上限0.25、fade5 msは調整値で、チューナーの既存上限0.25を移行で緩めない。音量0も状態は再生中。音量合算は知覚音量の加算ではなくsample peakの保守的な予算である。上限超過は開始前に拒否し、動的に無断間引きしない。limiter導入は遅延/音色を測った別改訂。

Audio Sessionはmanagerだけが書く。音のみplayback、明示入力併用play-and-recordを能力検出後に要求し、input ownerの終了後に再計算する。type変更失敗や経路変更は中断、校正無効、再タップ。既存値の復元はまだ同じmanager世代を所有する場合だけ。初期排他では出力開始前にcapture ownerへ停止要求し完了確認、同時使用選択時だけ両立させる。

複数タブの音声はorigin共通 `portal-audio-output` Web Lock（exclusive）をContext取得前に保持する。再生中は保持し続け、競合は「別のタブで使用中」と表示し黙って奪わない。**画面退出・hidden・pagehide、またはmanager内の全consumerがstoppedのまま60秒（調整値）**で、gate閉鎖/予約取消/lease世代失効後にContextをcloseしlockを解放する。paused/waitingはstoppedと同一視せず、退出/hiddenまたは明示stopで解放する。いずれかがrunningならidle解放しない。同一ページのtunerを含め全consumerを見て判定する。

再表示/操作再開は先にclaimを非同期取得し「準備中」を表示、取得後のみ再生を有効化する。再タップの同期部分でContextを新規生成/resumeし、タップ内でlock取得をawaitしない。release後の旧Contextやleaseを再利用しない。通常停止時はidle解放までclaimを保持できるが発音はしない。

Web Locks非対応では `portalAudioControl` IDBの1行をreadwrite transactionでCASする。record={ownerTabId,claimGeneration,state,heartbeatAtUtcMs,lastPermitExpiresAtUtcMs}、tabIdはページ実体ごとのランダムUUID（複製タブへsessionStorageで継承しない）。heartbeatは2秒、15秒更新なしを「応答なし」候補とする調整値。pagehideで自分のtabId/generationと一致する記録だけ削除を試み、失敗はstale検出へ任せる。epoch用の単調generationは削除せず別counter行に残す。

応答なしでは「別のタブが応答しません。このタブで使いますか」と確認し、同意後に再読取/CASでgenerationを増やしpending-ownerへ引継ぐ。確認中に更新が再開したら拒否し、同意前に乗っ取らない。旧タブは更新・append・resume・再表示前にtabId/generationを照合し、不一致なら全出力破棄/Context閉鎖して中断表示、leaseを新世代へ付替えない。

**世代照合だけで音声スレッドの予約済み音は止まらない。** 新ownerが実際に発音できるのは旧ownerのstopped/closed ack、または旧permit失効＋出力排出待ちを確認した後だけ。詳細は[音声claimデータ契約](METRONOME_DATA_API_DESIGN.md#audio-claim)。frame時計の停止を壁時計の期限切れと取り違えない。期限guardを検証できないbackend/端末では旧tabを閉じるか停止ackを得るまで引継ぎは準備中のまま発音不可。この安全条件を満たせない場合の自動TTL取得は採用しない。【未検証（実機が必要）】freeze/復帰・時計変更・BT残音と旧世代の二重発音防止。

### 4.1 チューナーへの移行

shared managerを先に版付きで導入し、tuner playbackのContext生成/close、音量、Audio Session、source追跡をlease APIへ置換する。tuner入力は別ownerのまま。旧直接出力経路との混在をmanifestで検出し、どちらかがlock非対応の旧版なら同時利用を開始せず再読込みを案内する。段階導入中も同一ページはmanagerを1個にし、tuner/metronome両方へ同じorigin lock/idle/hidden/pagehide契約を適用してから機能を有効化する。

MT-19は両機能単独・正順/逆順ロード・別タブのrunning/stop60秒/hidden/再表示・旧版混在・IDB stale引継ぎ→旧tab復帰を含める。片方のstopで他方のrunning lockを解放せず、logoutでは全体を閉じる。実機MD-17/19が通るまで移行/代替claimを完了扱いにしない。

<a id="music"></a>
## 5. 音楽時間・拍子・リズムのモデル

scoreは全音符単位の既約有理数 `{n,d}`。n/dは安全整数、d>0、浮動のtickを永続正本にしない。barの長さ=numerator/denominator、groupsは分母音符個数の正整数列で総和=numerator。位置は `{barId,offset}`、offsetは小節先頭からの全音符長、終点のみbarLengthを許す。内部で次小節0へ正規化し、楽曲末尾はterminal positionを残す。反復はbarIdとは別にoccurrence/iterationを持つ。

保存/通信/比較のBPM正本は整数bpmTenths（200〜3000、調整値）。表示/計算ではB=bpmTenths/10へ変換する。tempo.reference=r、BPM=B、pulse（刻む音価）、beatFeel（知覚層）、meter/groupsは独立。6/8=[3,3]でr=3/8,B=60なら小節2秒、r=1/8,B=60なら6秒。同じ速度を保つreference変更はBnew=Bold*rold/rnew。数値固定のreference変更は実速度変更として別操作/条件境界を作る。

| 型 | 生成・検証規則 |
|---|---|
| 単純/複合/加算/混合 | 4/4=[1,1,1,1]、6/8=[3,3]、7/8=[2,2,3]、混合はbar列。group変更でもbar長はmeterから求める |
| accent | group/pulse/subdivisionの3個別規則。eventは最も粗い該当層を選び、その層のvelocity/timbreを使用。groupを優先し、3層分の音を重複発音しない。mute/restは最後に別適用 |
| 付点/細分 | 32分=1/32、付点d個は元音価×(2−2^−d)。分割の基準音価を明示、bar端の端数は範囲内イベントだけ生成 |
| 連符 | baseUnitをn:mで置換し長さ=baseUnit*m/n。入れ子も有理倍率を積算し深さ/密度制限。曖昧な「7連符」だけでは保存不可 |
| poly | layerごとcycle/pulses/phase、score原点固定。groupやbarで勝手に位相resetしない。cycle reset選択は明示設定 |
| LCM | 3:2の共通cycle表示は6格子、発音は3+2voice/4時点。異周期は分母共通化後整数周期LCM。巨大格子は層別位相表示へ、音列を省略しない |
| swing | pairの両端固定、内部境界=A/(A+B)。通常8分pair既定。tuplets内はapplyInsideTuplets=true時だけ。poly層別に対象を指定 |
| 裏拍 | 有理offsetとmaskをpulse層へ適用、barを跨いでも位相維持。元の期待拍を削除せず発音maskと分ける |
| custom | layerのcycle内offset/duration/rest/velocity/accentをソートし検証。重複位置は別voice IDとして保持、同一ID重複は拒否 |

生成順は有理位置の細分/連符→swing→layer phase/裏拍→group/pulse分類→accent→mute。既にswing済みのcustomは`timingMode:literal`で再適用しない。pulseがgroup境界と一致しない場合もgroup打点の独立eventを生成でき、同一layer/同位置なら最優先accentで統合する。

<a id="tempo"></a>
## 6. テンポマップ・積分・seek

曲線は**経過秒に対して**線形または指数のBPMとし、保存する終端は楽譜位置endである。種類`constant`/`linear`/`exponential`、start/end position、reference、startBpmTenths/endBpmTenthsが正本。durationSecondsは入力/永続JSON/APIで禁止する。秒指定の別曲線型は今回導入しない。練習stepの実時間timerと曲線の二重指定を混同しない。

bar prefixからscore位置s0/s1、U=(s1−s0)/r>0を求める。区間のB0=startBpmTenths/10、B1=endBpmTenths/10（いずれも>0）、所要時間Dは以下で導出する。楽譜終点を動かす編集はUとDを再計算してrevisionを進める。TAP/換算/加減速途中は浮動計算可だが、保存する設定/端点/段階幅はtenths整数へ量子化する。正のBPMはfloor(10*B+0.5)で0.1BPMへ四捨五入（正確な十進入力では十進桁で処理）。丸め前Bが20〜300外、非有限、または整数結果が200〜3000外なら拒否しclampしない。APIのbpmTenthsは整数だけを受け、非整数をサーバーで丸めない。metric modulation等の正確な比率は元音価式を保持し、端点量子化による差を表示して確定する。

| 曲線 | Dと係数 | 拍数u(t) / 逆関数t(u) |
|---|---|---|
| constant | B1=B0、D=60U/B0 | B0*t/60 / 60u/B0 |
| linear | D=120U/(B0+B1)、a=(B1−B0)/D | (B0*t+a*t²/2)/60 / `120u/(B0+sqrt(B0²+120*a*u))` |
| exponential | D=60U*ln(B1/B0)/(B1−B0)、k=ln(B1/B0)/D | B0*expm1(k*t)/(60k) / `log1p(60k*u/B0)/k` |

B1≈B0では一定式の極限、指数計算はlog1p/expm1を用い相対差1e−8を暫定切替調整値にする。検証ではさらに小さい差と大きい減速を比較し、数値誤差を1 sample未満に抑えることを設計目標とする。端点は数学上の正本に固定し、浮動誤差で逆転した値は許容誤差内だけclip、範囲外は拒否。

区間は[start,end)で重複禁止、stepは同位置の新BPM開始。曲線間の空白は直前BPMを保持しreferenceを継承、楽曲先頭のtempoは必須。reference変更は必ず区間境界、速度維持/数値維持/metric modulationの種類を記録。有限楽曲のbar追加/削除で終点不明なら実行拒否。反復は有限展開のoccurrenceを持つ。無限repeatは1cycleを繰返し計算し総展開しない。

bar prefixは有理数、区間prefix時間はFloat64の補償和、各eventはprefix時間＋区間の逆関数から直接求める。sample frameは原点frame＋round(sampleRate*tAbsolute)。前音の丸めた間隔を累積しない。seekはbar prefix/tempo prefixを二分探索し、同時にrandom seed/step/iterationの状態を再構築する。不定長fermataより先の絶対時刻は未確定とし、fermataで原点を区切る。

【確認済み（算術）】6/8+7/8は13/8全音符、r=3/8なら13/3拍。秒domain線形60→80のD=26/7秒。この値は説明用計算結果であり保存しない。JSONの正本は[データ設計](METRONOME_DATA_API_DESIGN.md#presets)。

<a id="engine"></a>
## 7. イベントコンパイラーと交換可能な再生backend

compilerは不変ScoreSnapshotとrevision、区間、原点、limitProfileを入力に、`eventId/occurrence/score/frame/layerId/accent/soundId/velocity/expected/emit/conditionKey`を生成する。eventIdはscoreRevision/occurrence/layer/localOrdinalから決定し、UIの再描画で変えない。expected=trueでもmuteでemit=falseを許す。解析対象は既定1層/明示時最大2層、予定拍合計16件/秒以下を開始前に検証する。polyの全層を無条件に演奏目標へしない。超過は解析開始を理由付き拒否、クリックは継続可能。

同一イベント列をmain先読み、Worker compiler→main予約、AudioWorklet生成、短buffer/chunkへ渡す。backendはprepare/commit/cancel/stop/clockSnapshot/telemetryを実装し、GUIはbackendを分岐しない。AudioWorkletを主候補とし、採用は01a比較で決める。短bufferは音色データを共有、複数小節chunkはfenceで分割できる長さに限定する。

queueはcapacityとframe horizonの両方で有界。先頭から処理しprocess内でsort/JSON/動的allocationをしない。Workletは実入力配列長を使い128固定にしない。over-capacityはbatch全体をreject、同じseq再送は冪等、空キューは無音＋underrun記録。期限切れeventは欠落として記録し現在時刻へ詰めて鳴らさない。音楽位置は進め、位相の追い付き連打を禁止する。

main方式は各sourceをlease/generation/frameでSet管理し、onendedでdisconnect/remove。stopはfuture source.stop、gate fade、timer取消を併用。WorkletはvalidUntilFrame/generation/cancel fenceで将来を破棄する。cancel後に来た古batch/ackは無効。chunk再生は取消位置でold gainを閉じ新chunkへ渡す。tailの扱いは操作表による。未発音sourceの取消もonendedだけに依存せず解放を確認する。

【確認済み】前回headless計測の300ms先読み/180ms停止で遅刻0件は停止が先読みより短い1条件であり、先読み採用値の根拠ではない。100/25と200〜300ms/20〜25msは比較候補のみ。MT-07でHを超える停止、MT-08でH拡大に伴う予約取消/停止/即時変更/pause反応を測る。出力停止後の音響残留とJS投入遅延を別記する。

<a id="transport"></a>
## 8. transport・変更境界fence

| 状態 | 遷移と保持 |
|---|---|
| stopped | 再生なし。開始で新transportGeneration/原点。stopは位置0へ、seekは指定位置へ停止 |
| running | count-in/performing/restのphaseを別fieldで保持。muteでもrunning |
| paused | score位置/区間位相/iteration/stepを保持。resumeで新原点、count-in任意 |
| waiting | fermata/手動step待ち。未来を予約しない。利用者tapで継続しpauseとは別理由を保持 |
| interrupted | 背景/着信/権限/出力欠落/版不一致。理由と安全な再開位置、手動復帰のみ |

世代はlaunchEpoch、outputEpoch、leaseGeneration、transportGeneration、scoreRevision、captureEpoch、attemptId、viewGeneration、ownerEpoch、saveGeneration、localDeleteGeneration、historyEpoch、consentRevisionを分ける。pending revisionはUIに「適用予定」と表示し、再生中revisionを上書きしない。

fence={operationId,transportGeneration,oldRevision,newRevision,score,outputFrame,effectiveMode}。通常編集は現在の**未render**位置より後、guardFrames以上先の候補でprepare。compiler/processorが候補frameとbatch全量の受入をackするまでcommitしない。commitは締切前に到達した場合だけatomicにold futureを取消しnewへ切替、appliedで実frame/revisionを返す。old tailはgateで指定frame以後を閉じる。未commitのprepareでは旧列を継続する。締切を過ぎたcommitは拒否し、次境界を再提案する。main backendも取消可能source集合に対し同じ契約を実装する。

ack timeoutや新旧の確定が判別不能ならlease gateを閉じinterrupted、推測してrunningを継続しない。即時は「操作要求時刻への遡及」ではなく、取消可能な最短の安全frame。UIには実適用位置/反応時間を示す。outputTimestampで推定した既に聴こえる位置とrender frontierには遅延差がある。pause位置は最終的に確定したcancel frameのscoreを保存し、要求受付時の表示位置を正本にしない。

| 操作 | 既定 / 選択できる境界 | 位相・取消・解析への反映 |
|---|---|---|
| BPM | 次pulse / 即時・次拍・次小節 | fence位置連続、そこから新tempo区間。曲線途中なら残り区間を明示編集、過去は不変 |
| 基準音価 | 次pulse / 3境界 | 速度維持換算か実速度変更を必ず指定。condition境界 |
| meter/groups | 次小節 / 3境界 | 即時/次拍は現barをpartialとして閉じ新bar occurrenceを開始、拍番号resetを予告。既存楽曲はruntime editとしてsnapshot |
| accent/リズム/音色 | 次pulse / 3境界 | old future取消、同一位置二重音なし。poly phaseは維持、resetは明示 |
| 音量 | 即時短fade / 3境界 | pending gain automationを取消して連続値からramp。master安全予算は常に適用 |
| mute/無音 | 次pulse / 3境界 | emitのみ変更、expected/score保持。即時はtail gateも閉じる |
| pause | 即時 / 次拍・次小節での予約pauseも可 | fence以後取消、phase保存。timer active時計停止。無効な観測境界を記録 |
| resume | 新原点 / 任意count-in後 | 選択pulseを基準に予備拍生成、保存位置から本演奏、gapを補間しない |
| seek | 即時停止 / 明示した再生seek | generation更新、旧列/予告/解析区間閉鎖、新位置へ。跨いだ音を追発音しない |
| fermata | 指定位置waiting、tap再開 | 終点以後queueなし。予備拍offなら次の未消費eventから、onなら予備拍後。終点event再発音をevent consumptionで防止 |
| 長休符 | 小節列のmask | runningを維持し残小節/拍を表示、音だけ無音。mixed meter/反復も同列 |
| 出番予告 | targetのN小節/拍前 | 数字＋専用合図音、mute中もcueは別bus mask。発生済みcueはoccurrence別に一回 |
| metric modulation | 指定位置 / 3境界 | 旧音価と新音価の秒長等価。旧♩=新♪.、基準♩ならBnew=0.75Bold（120→90）。reference換算と区別 |
| stop | 即時（選択で遅らせない） | 世代失効/全予約取消、当該bus fade、位置0。記録はその試行のみ同期閉鎖 |
| 退出/背景/logout/割込み | 即時安全停止 | 全関連lease/capture/振動/Wake Lock解放、reason保存、復帰自動再生なし |

次拍はその時点で選択中pulseの次境界、次小節はoccurrenceの次bar boundary。group拍へ適用したい場合はpulse設定を先に指定する。安全guardで予定境界に間に合わなければ黙って即時へ変えず次の同種境界を提示する。

<a id="display"></a>
## 9. 音声時計からの画面同期と端末制約

`getOutputTimestamp()`が有効なら対応点から `pEvent=performanceTime+1000*(audioTime−contextTime)`。rAFは現在performance時刻に対応するscoreを逆写像し拍/振り子/指揮位置を描く。描画遅延でも音は変更しない。この写像へoutputLatencyを重ね足ししない。未対応/不正値ならcurrentTimeと取得可能なlatency推定から出力位置を近似し「表示同期は推定」と表示、表示offset調整を校正と別に端末保存する。

Bluetoothの固定delay/変動、経路変更を分ける。経路変更で時計対応と校正を失効、手動再開する。振動は音声sample単位同期を保証しない。Wake Lock拒否/解放を表示し、再表示時に希望設定がある場合のみ再要求、再生は自動再開しない。iOSは振動非対応と音/光代替を表示する。

【確認済み（一次資料）】基礎となる時刻指定/Offline/Workletは[Web Audio REC 2021-06-17](https://www.w3.org/TR/2021/REC-webaudio-20210617/)。音声clockとUI clockは異なる。Web Locksの排他は[W3C Web Locks](https://www.w3.org/TR/web-locks/)を参照（両資料を2026-10-18再確認）。Safari/PWA、Audio Session、Wake Lock、Chrome timer/Vibrationの対象版と一次資料は[調査§4](METRONOME_FEASIBILITY.md#4-公式仕様は前景動作を支え背景振動割込みは別受入にする)を引き継ぐ。版の導入記録を全端末の動作保証へ格上げしない。【未検証（実機が必要）】消音スイッチ/着信/ロック/PWA/BT/省電力のすべて。

<a id="sound"></a>
## 10. 音色と音量の安全策

合成はサイン/短い帯域noise/wood系の減衰波をsoundDefinitionにする。sampleも同じduration/peak/attack metadata契約。素材追加時にsource URL、作者、ライセンス名/本文参照、再配布/加工/帰属条件、原本hash、変換手順、配布bytes、各対象端末decode時間/peak/sampleRateを台帳へ記録する。条件未確認素材は配布しない。具体的素材の選定は実装時判断。

最大tail込みvoice予算、全層同時peak、fade、極端なaccent/音量、decode失敗をMT-05で検査。sample未準備なら再生前に代替合成を本人に示し選択、再生途中に無断で音色変更しない。低い初期音量から利用者が調整できる。物理音圧はブラウザーgain値から保証しない。

<a id="ui"></a>
## 11. 7画面・タッチ・光の安全

| 画面 | 操作と常時表示 |
|---|---|
| 基本 | BPM/基準音符、meter、再生/停止、音量を大きく。count-in/timer、振り子、保存選択への導線 |
| 拍子・リズム編集 | numerator/denominator/groups/pulse/accent/細分。現在値とpending値、反映単位 |
| 高度なリズム | layer/cycle/phase、連符、swing、custom、LCM/層別表示、密度検証 |
| 練習支援 | step/tempo変化/mute/裏拍/拍感/テンポ当て、記録方針、試行終了/結果 |
| 楽曲 | bar map、tempo curve、休符/cue/fermata、反復/seek、指揮編集 |
| 演奏解析 | 明示マイク開始、校正/入力品質、ms/拍比/安定性、n/除外/保留、tuner同時表示 |
| 設定・preset | basic/advanced/score保存/呼出/初期化、音色/表示/Wake Lock、履歴/同意/削除/校正 |

全画面で停止ボタン、running/paused/interrupted、入力の有無、保存先/未保存/同期待ちを常時表示。iPhone縦画面で停止を固定し、touch target44 CSS px以上を設計目標に、スクロール/keyboard/zoomで隠れないよう検証する。内部保存先や管理者情報を団員向け画面へ出さない。

TAPはprimary pointerdownのみ、重複pointerを除外。event.timeStampをperformance基準へ正規化、異常/逆順は拒否。直近8間隔、最低4有効間隔を暫定調整値とし、中央値から `max(3*MAD,0.1*median)` 超を除外、残り平均から60/mean。最初のtapは基準のみ。長休止は `max(3秒,3*直近中央値)` でreset、入力数とreset操作を表示。推定BPMを適用ボタンで確定し意図しない連続tempo変更を避ける。物理touch遅延は別にMD-10で測る。

光は既定で小面積の低コントラスト位置移動、全画面flash/飽和赤を使わない。reduced-motionは振り子/軌跡補間を止め静的拍番号へ。最大zoom/全画面/全層合算で任意1秒に3回超flashを避けるか一般/赤flash閾値以下と確認する。[WCAG 2.2 SC2.3.1解説](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)（2026-10-18再確認）を受入根拠とする。180BPMで3Hzという算術だけで安全合格にしない。高密度時は全細分を光らせず静的/位置表示へ切り替え、視覚情報を残す。

状態/停止/設定/結果にaccessible name、tab順、focus復帰、数字/符号のテキスト。拍ごとのaria-live読み上げは行わず、状態変化と結果をpolite通知する。出番の音声読み上げは保留だが、支援技術が数字/状態を読めることは必須。VoiceOver/TalkBack/keyboardで検証する。

<a id="practice"></a>
## 12. 練習プログラム・試行・世代

programはstep列で、各stepはpreset snapshot、終了条件bars/activeSeconds/repeats/manual、tempo stepまたは曲線、mute、休憩、count-inを持つ。無限/循環step参照は禁止し、repeatは回数か明示untilStop。自動開始せず利用者startで実行する。active timerはrunning本演奏だけ、count-in/pause/waiting/休憩を除外。実時間timerはperformance基準で休止中も進むが、停止後復帰時に期限超過を表示し無断再生しない。

段階tempoは指定bar/time/repeat境界でclampして上限到達時stop/hold/reverseを指定。連続曲線は秒domain、bars終端を正本にする。activeSeconds終了stepでは曲線とは別のtransport停止条件とし、曲線を途中で打ち切ったことを結果に残す。

無音はemit maskだけ。ランダム無音はseedとrandomAlgorithmVersionを固定し、seed/occurrence/layer/event keyから決定するカウンタ型hashで再現し、seekで乱数消費順が変わらない。単位bar既定、eventも選択可能。拍感変更は速度維持でpulse/accentだけ変更。テンポ当ては正解を隠して提示→停止/回答TAP→BPM誤差/有効数表示、正解漏れのariaラベルを避ける。合否閾値未校正なら数値だけ表示する。

| 既存問題 | 組み込む対策と受入 |
|---|---|
| DC-13 | attempt作成時にrecordingIdを固定。終了/中止で同期的にcollectionを閉じ同じ1件へ結果確定。他画面の記録を引継がない |
| DC-14 | attempt開始前に固定したlocalDeleteGeneration/historyEpochを保持。quota await後および書込transaction内で照合、削除後に読直して旧payloadを新世代へしない |
| DC-15 | tempo/meter/pulse/route/calibration/analyzer版の境界をevent条件snapshotへ。解析待ち中に現在設定を参照しない |
| DC-16 | 全削除/409後identity再取得、新しいattemptだけ新世代。旧outboxは破棄し付替えない |
| DC-17 | Aの解析はAだけ確定、Bをstopしない。request supersedeはevaluation-supersededとしてAを結果なし確定 |
| DC-18 | 拍位置/tempoMap/route/校正/解析版別に比較・成長表示。全条件medianは参考値 |
| DC-19 | viewGenerationはUI鮮度のみ、保存はowner/save/delete/consent有効性。B開始だけで有効なA保存を失効させない |

leave/logoutはsaveGeneration/ownerEpochを失効、別練習開始はviewGeneration/attemptIdだけ更新。解析/保存の完了はtransportを操作できない。記録の未完復旧は実行中タブのheartbeat/lock確認後に行い、直近recordingを一律に閉じない。MT-11/12/13で順序を反転し回帰確認する。

<a id="orchestra"></a>
## 13. 楽曲・オーケストラ

bar sequenceはmeter/groups/tempo参照/sound/発音mask/反復を保持。長休符は残bar数と当該barのpulse数を同じscore位置から表示し、mixed meterでも一定拍数を仮定しない。出番targetとbefore単位（bar/pulse）を保存、targetから逆に位置を計算する。cueが楽曲先頭以前なら警告し先頭へ無断丸めしない。cue数字＋合図音は通常muteと別設定、予備拍と重複時は識別音/表示に統合規則を適用する。

fermataはscore上のgateで、手前までcompileし終端以後を投入しない。利用者tapで消費済み終端eventを再発音せず、予備拍offなら次の未消費event、onなら選択pulseのcount-in後に新原点で再開。中断/seekでgateを通過した事実を明示し、無断で待機をスキップしない。

指揮templateは2/3/4拍と加算群、groupごとの正規化座標(x,y in0..1)/打点phase/補間control pointを持つ。編集は拍数/順序/範囲を検証し、音のgroup打点と同じeventを参照。tempoを軌跡の速さから計算しない。reduced-motionでは打点と番号だけ。専門的な指揮法の優劣を判定しない。

<a id="analysis"></a>
## 14. 校正・発音・対応付け・信頼性

メトロノーム入力は独立Context/owner/captureEpoch。tuner同時表示でも入力trackを暗黙に奪わない。同時入力要求は明示同意と機器能力を確認、競合なら一方を本人が選ぶ。既存tunerの基準音/クリック重複区間の診断・成長除外を維持する。メトロノーム側は別eligibilityでクリック基準の解析を行い、tunerの±250ms等の除外をそのまま使わない。

校正は既知クリック列のループバックから共通performance時計上の往復offset中央値/残差MADを推定。出力sample→入力effectiveFrameの対応点をepochごと保持。outputLatencyは往復値へ重ね加減算しない。物理伝搬/入力処理/検出遅延を一括offsetとして扱い、ループバック校正から演奏意図の開始時刻まで保証しない。イヤホン経路は同経路の物理ループバックができなければ未校正とし、スピーカー校正値を流用しない。校正不十分時の値は参考/保留。

校正profileは端末内routeKey、sampleRate、OS/browser主要版、検出版、実施時刻/手法/残差のみ。serverへ校正値やraw deviceIdを送らない。アカウント履歴には校正有効性/品質区分/opaque condition tokenだけを残し（残差幅等の校正値は端末内のみ）、別端末では再校正。route/割込み/sampleRate変更で失効する。

onsetは10ms包絡/20ms確認後の候補実効時刻を出発点とし、20msを機械的に引かない。短hop/帯域包絡/flux/立上りfitを比較し解析版を付ける。pitchChangeと真のattackを区別、legatoにはattack不明を付け無理に評価しない。遅い弦/金管/低音、雑音、クリック漏れ、clip/gapは品質理由を残す。混入は相関/帯域特徴で疑いを示すが確実な除去とは呼ばない。

対応は開始前preflightを通った選択target層（合計16件/秒以下）と観測attackの順序制約DP。コストは|残差|/対応窓、挿入/欠落は別penalty、同一観測の重複利用禁止。対応窓の暫定上限はmin(150ms,隣接期待間隔の45%)、校正不確実幅が窓以上なら保留。最良/次点差不足もambiguousとする。count-in/休憩/出力欠落/条件境界の不確かな観測を合格へ使わない。

| 指標 | 定義と表示条件 |
|---|---|
| 先行/遅延 | e=観測入力時刻−往復offset−予定出力時刻、正が遅れ。msと `100*e/(60/localBpm)` を併記、分母はBPM基準音価 |
| 傾向/ばらつき | eのmedian、MAD、SDを分離。拍位置/条件別、有効n/候補Nと理由別除外数 |
| tempo安定性 | 対応した連続観測IOI/予定IOIの比の変動。意図したrampを不安定に数えず、欠測/長休符越えを除外 |
| 合格/保留 | 校正有効/混入なし/出力有効/最低n・coverage・残差条件をすべて満たす場合のみ閾値判定。最低n不足は保留 |
| 比較 | conditionKey一致のevent群で比較。セッションの代表値だけで条件混在を隠さない |

最低nや合格誤差は下表の調整値で、実楽器校正前は**合格判定を無効**にして参考値だけ表示する。音色・奏法の良し悪し、楽器故障や原因を断定しない。MT-16/17とMD-14/15で合成信号と実楽器を別に検証する。

<a id="tuning"></a>
## 15. 調整値・暫定安全上限・決定手順

下記はすべて【調整値】。製品仕様や精度保証ではなく、未計測時に無制限入力/メモリー増加を避けるための開発初期profile `limits-v0`。複数条件のうち厳しい制約を適用し、超過は理由付きで開始前拒否する。過剰入力を黙ってclamp/間引きしない。

| 項目 | 暫定安全上限/初期候補 | 確定する測定・失敗時 |
|---|---|---|
| BPM/基準音価 | bpmTenths整数200〜3000（表示20〜300/0.1刻み）、referenceは1/32〜1全音符 | MT-01/02/07、基準音価込み密度で拒否。BPM上限だけで保証しない |
| meter/連符 | numerator1〜32、denominator1/2/4/8/16/32、連符n,m1〜16、入れ子深さ2、付点3個 | MT-01/03、表現と負荷/有理数の安全性を計測 |
| 有理数 | 正規化後abs(n),d<=2^31−1、演算中Number safe integer範囲を必須検査 | gcd前の積でoverflowする場合も拒否。BigInt移行は別schema判断 |
| poly/展開 | 最大4層、1compile窓4096event、有限曲10000bar、program256step | MT-03/07、同時集中と最大tailで評価 |
| 発音予算 | 合計400events/s、同時voice64、queue4096、LCM表示256格子 | MT-05/07、LCMだけは層表示へ。発音超過は開始拒否 |
| 先読み/timer | 100/25、200/20、300/25msを比較候補。採用値なし | MT-07で0.5H/H/1.5H/2H/2秒停止、MT-08の取消反応と両立して決定 |
| fence/期限 | guard2 render quantum、ack timeout1秒、実行許可先2秒、fade5ms | MT-08/10、超過はinterrupted。停止反応の保証値ではない |
| 解析/保存 | 対象既定1層/明示時2層・合計16予定拍/秒、記録1800秒、予定拍28800件/余剰詳細7200件/端末詳細計36000件。端末予算64MiB（5最大密度記録×推定256B/件＋各2MiB metadata＋4MiB余裕） | MT-13/16で実測。対象上限超過は解析開始前拒否、クリック継続可。quota失敗は表示/保存停止/書出し案内 |
| 要約同期 | 個別観測送信0、集計group256/記録、part0だけ1個、body256KiB。groups128KiB/scoreSummary64KiB/summary32KiB | MT-13/14でbytes/件数/DB行数/保留を確認。観測詳細は端末のみ |
| preset/設定 | preset専用IDB計60件/各256KiB/合計2MiB、設定localStorage16KiB、import2MiB（変更なし） | MT-15、他key/認証不変 |
| claim | stopped無操作60秒、heartbeat2秒、stale15秒、permit2秒/更新500ms、排出待ち250ms候補 | MT-19、MD-17/19。runningは解放しない。期限guard未確認時は停止ackまで新発音不可 |
| TAP | 8間隔/最低4、3MADまたは10%、reset max(3秒,3中央値) | MT-01とMD-10、誤touch/極低tempoで調整 |
| 校正/解析 | 校正20クリック/残差MAD10ms以内候補、最低20有効観測/coverage80%、許容median30ms・MAD20ms候補 | MT-16/17、楽器/経路別MD-14/15。受入前は合格判定off |
| 対応窓/信頼性 | min(150ms,IOI45%)、DP penaltyと曖昧差はfixture比較で決定 | 非一意なら保留、nを増やして無理に合格させない |
| 表示/音量 | 30Hz上限候補、master0.25、44px目標 | MT-05/18と実機。flash合否はWCAG基準で別評価 |

保存予算は[観測頻度と容量の算式](METRONOME_DATA_API_DESIGN.md#capacity)を正本とする。400events/sは再生負荷だけの上限で、解析16予定拍/秒とは独立。120BPM32分1層または240BPM16分1層が16件/秒。記録枠は7200秒流用を撤回し、結果確認/校正見直しとモバイル復旧を有界にする1800秒へ変更。program/timerの7200秒は再生設定として維持し記録時間とは分ける。30分到達は予告/表示して同じ記録を一回閉じ、再生は継続、新記録は本人操作。余剰7200件以後は個別値なし・総数/理由を継続集計して打切りを表示する。64MiBもorigin共有容量の一部であり確保/永続保存保証ではない。persistは明示操作時のみ、拒否/削除時の状態と書出し案内を設ける。accountには個別観測0・セッション/拍位置/条件別集計だけを送る。

暫定profileの合法入力でも全組合せが再生可能とはしない。compilerが瞬間burst、tail同時数、queue占有、rational範囲をpreflightし、繰返し周期の上界も検査する。未知/上界計算不能は拒否して説明する。

決定手順: fixture/端末/OS-browser/経路/release/limitProfile/条件を固定→純関数/Offline→同一イベント列のbackend比較→H超え停止と取消反応→30分/電池/実音→実楽器の見逃し/誤検出→限界より余裕を取ってprofile改訂。p50/p95/p99/max/欠落/重複/underrunと失敗条件をすべて記録する。許容誤差の製品値は測定と利用者受入後に決め、都合よく試験期待値を下げない。

<a id="acceptance"></a>
## 16. 試験・受入

試験IDの正本は[実装計画§4](METRONOME_IMPLEMENTATION_PLAN.md#4-自動試験は正確な発音と正しい判定を別に検証する)のMT-01〜MT-20。チューナーのAT-001等の要件と混同しない。ここでは追加受入を含む実行契約を固定する。

| MT-ID | 重点と方法 | 完了証拠 |
|---|---|---|
| MT-01 | 純粋モデル、有理/拍子/6/8両基準、TAP/タイマー。bpmTenths整数200..3000、十進の半端/範囲外拒否を検証。 | 正解列、不正入力/上限拒否、snapshot不変 |
| MT-02 | 楽譜終点からD、積分逆関数、加速/減速/極限。端点tenthsをBPMへ変換、丸め後の積分、曲線途中は浮動のまま。 | 13/3拍→26/7秒、端点/seek/境界誤差、duration禁止 |
| MT-03 | poly/LCM/phase/連符/swing/custom | 表示縮約でも音列不変、上限preflight |
| MT-04 | Offline44.1/48k等でsample照合 | onset定義別誤差/欠落/重複。単純impulse成功を全音色成功にしない |
| MT-05 | peak/fade/最大tail/clip/source解放 | lease合算安全、onended/stop解放、memory有界 |
| MT-06 | 偽時計stall/古callback/ack/cancel | 過去event連打なし、旧世代無効 |
| MT-07 | 同一列でmain/Worker/Worklet/chunk、idle/busy/DOM/GC、H超え停止 | Hごと0.5H/H/1.5H/2H/2秒、各条件反復。投入遅延と実音/underrun/停止許可期限を別測定 |
| MT-08 | 各HでBPM/meter/volume/mute/pause/stop・即時/次拍/次小節 | 要求→受理→cancel ack→最終旧音/無音→新音/表示、取消済み予約/残音、実適用fenceを測る |
| MT-09 | pause/resume/seek/fermata/休符/cue/modulation | 二重音/位置破綻なし、timer/予備拍/消費済みevent整合 |
| MT-10 | load/resume/ack/Wake Lock待ち中の退出/hidden/logout | await後再照合、手動復帰のみ、後着解放 |
| MT-11 | A→B→A解析/保存完了、逆順確定 | DC-13/17/19を再発しない |
| MT-12 | tempo/route/校正変更を跨ぐ解析/比較 | DC-15/18の条件混合なし |
| MT-13 | off/quota/2tab/delete/logout/409/クラッシュ、解析16件/秒の開始前拒否/編集境界、1800秒・28800予定拍＋7200余剰詳細、64MiBの256B仮定/5記録/metadata/索引/復旧・persist拒否/消失、要約256group/1part/256KiBを実測 | 個別観測送信0、条件別集計一致、打切り/容量エラー可視、他key不変。H-010は実ブラウザーまで未完 |
| MT-14 | 本人/他人/組織/member再生成/hidden/API/DDL。tuner未使用からowner作成、両機能同時初回とmembers行lock/一意制約/再試行。 | 本人のみ、owner失効全表削除、機能別epoch、旧tuner無影響 |
| MT-15 | 3preset/参照/循環/未知版/巨大JSON/危険key/upgrade。専用preset IDBと設定16KiB、localStorage近満杯でも他key不変/ログイン維持/再生継続。BPM整数/丸め/範囲も確認。 | schema完全検証、コピー移行、破損時上書きなし |
| MT-16 | 合成attack/legato/noise/混入/校正 | 正解sample誤差、precision/recall、保留と除外 |
| MT-17 | 既知残差/IOI/ramp/欠測/n不足 | 符号/分母/一対一/条件別、合格offと保留 |
| MT-18 | flash/最大zoom/reduced-motion/読み上げ/操作 | WCAG2.3.1判定とVoiceOver/TalkBack、停止常時可視 |
| MT-19 | 同一ページtuner/metronome正順・逆順・並行・cache混在。running中は奪わず、stop60秒/hidden解放、準備中再取得、IDB確認付き引継ぎ→旧tab復帰/旧permitで二重発音なし。tuner共通lock移行も確認。 | 3namespace/登録名/release/URL/processor衝突なし、片方停止で他方破壊なし |
| MT-20 | ZIP/ログ/payload/release/通常CI | PCM/録音/全FFT/秘密/tmp混入なし、DB Only |

実機は[実装計画§5のMD-01〜19](METRONOME_IMPLEMENTATION_PLAN.md#5-実機チェックリストへの追記案今回は既存文書を変更しない)を引継ぐ。型番/OS完全版/browser完全版/SafariタブかPWA/経路/電源/省電力/sampleRate/release/API状態を記録。自動headless、合成信号、実機音響、実楽器、画面目視を別々に合否報告する。今回これらの新規試験は未実施。

<a id="delivery"></a>
## 17. フェーズ別完了条件

| フェーズ | 完了に必要な設計/実装/検証 |
|---|---|
| 01a | 全機能の型/tempo終点/transport/fence/出力lease/message契約、limitProfile。MT-01〜09で同一列backend比較、H超え停止と取消反応。方式選定記録。Worklet未試作のまま採用完了としない |
| 01b | 基本/拍子/設定画面、基本音、初回tap/退出/背景/logout、MT-10/18/19/20、iPhone/Android/PC初期実機。設定保存選択/マイク不要/namespace不衝突 |
| 02 | 混合/連続拍子/poly/連符/swing/custom、MT-03/05/07/08/15。queue/密度/最大tailの上限を版付き確定 |
| 03 | 全練習、attempt/記録/保存分離、端末と本人accountの履歴。MT-11〜15/17、機能別全削除と2tabの安全確認 |
| 04 | 全楽曲/長休符/cue/指揮編集/fermata/modulation、MT-02/09。反復/seek/予備拍/曲線終端整合 |
| 05 | 校正/onset/指標/tuner adapter、MT-12/16/17/19、全MD。実楽器別残差と合格閾値/保留。30分/電池/BT/光/2tab含む最終受入 |

各phaseの完了は後期機能の不採用を意味しない。失敗/制限/実機未完は97行の実装状況表を実装時に別途設けて追跡する。今回の設計対応表へ実装済み印を付けない。

<a id="remaining"></a>
## 18. 設計値と残る確認

| 項目 | 現在区分/残件 | 完了証拠 |
|---|---|---|
| 独立機能/管理者/共通出力/入力分離/本人保存選択 | 確定した設計前提、未実装 | 受入は上記各phase |
| 先読み/Worklet/短buffer | 設計目標、方式比較未完 | MT-07/08、実音と停止反応 |
| limits/解析n/許容誤差 | 調整値、合格公開off | profile改訂根拠/端末別測定 |
| H-010/音声2tab | 未完、実機が必要 | MT-13とMD-17、削除後旧保存/再送0 |
| 全iOS/Android/PWA/BT/実楽器/30分 | 未検証（実機が必要） | 版付きMD記録、制限表 |
| sample音素材 | 実装時選定 | ライセンス/容量/decode台帳 |
| 出番音声読み上げ | 採否保留 | 言語/遅延/音声Session影響の別判断 |
| 団員公開 | 別判断 | §1受入完了後の公開範囲決定 |
| migration/DB/production/test | 設計案のみ、現在状態未照合 | 将来のread-only preflightと通常リリース |

未完にはID、責任範囲、次の検証、阻害要因、採用profile/端末版を付ける。Q-006/PR-008等のチューナー未完をメトロノーム完成で解消したと扱わない。仕様逸脱が必要なら対応表の「実装時の変更」に理由/影響ID/代替/証拠を記録し、全機能採用の方針を無断で変更しない。

## 改訂履歴

| 日付 | 変更 | 影響 |
|---|---|---|
| 2026-10-18 | 初版。利用者決定、調査修正4点、01a/01b、97要件の詳細契約 | 全97要件 |

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

### 2026-10-18 第2回の実装反映（レビュー指摘R-01〜R-09と未完機能A〜D）

| 節 | 実装で確定した内容 | 影響要件ID |
|---|---|---|
| 4 出力管理 | ページに1つの出力管理（メトロノームとチューナーで共有）。consumerごとにclaimを保持・解放し、最後のconsumerの退出か60秒のlease無しでContextを閉じる。Context が running を離れたら全permitを失効し、再生には新しいタップが必要。Web Lockの取得待ちを撤回した後に来たロックは即解放。チューナーの基準音もleaseで鳴らす（4.1、IC-16） | MX-06、MX-09、MX-15、MQ-08 |
| 7 再生方式 | AudioWorklet・main先読み・短buffer（0.5秒chunk、IC-19）を同じイベント列で切替可能（設定の比較用）。どれも採用値ではない。compiler／解析Workerは作らない（IC-07）。比較の数値は[実装状況4章](METRONOME_IMPLEMENTATION_STATUS.md)（headless Chromium） | MX-08、MQ-01、MQ-04 |
| 8 fence | 準備→backendのack→確定。確定前の位置・条件は旧テンポマップと旧revision、確定後はfence前が旧・後が新（区間の履歴）。accepted:falseは旧計画を継続し理由を表示、ack timeoutは中断、古い世代のackは無視、編集は直列。Workletの置換は容量を確かめてからで、足りなければ旧キューを残して拒否。取消・遅いfenceでは、取消位置以後に始まった音を両backendとも5 msでfade。世代は単調で、古いstopは世代を戻さない | MX-04、MX-05、MS-07、MQ-06 |
| 12 練習 | 1800秒で記録を閉じ、プログラムとクリックは継続、新しい記録は本人の操作（IC-05撤回）。経過時間は音声フレームで数え、表示の遅れで減らさない | MP-07〜09 |
| 13 指揮 | 打点の数値・ボタン・ドラッグでの編集、拍グループ数との整合検査、型へのリセット、楽曲（打点を含む）の保存・呼び出し | MO-03 |
| 14 解析 | 対応付けは、窓 min(150 ms, 隣接間隔の45%) が隣同士で重ならないことを使い、順序保存・一対一・曖昧判定を保ったまま予定拍ごとの判断に分解（O(N+M)、保持は窓の幅だけ）。2層の10 ms以内の予定拍は1つの複合拍（IC-11）。条件はrevision・小節構造・層・経路・校正・解析版・出力で表し、瞬間BPMを含めない。境界は層ごと。マイクは開始ごとのcapture session。保存済み校正は本人の確認で有効（IC-18）。チューナーの同時表示は表示だけではマイクを使わない | MA-01、MA-04、MA-05、MA-07、MA-09 |
| 15 調整値 | 解析対象16件/秒は任意の半開1秒窓の最大件数で評価（IC-13）。端末履歴は64 MiBを実際に予算として加減算。heartbeat 2秒・stale 15秒・permit 2秒・更新500 ms・排出待ち250 msは実装値（調整値のまま） | MP-08、MX-11、MX-15 |

これらは自動試験とheadless Chromiumでの確認であり、実機（MD-01〜19）・Safari・実楽器の合格ではない。団員公開・出番の読み上げ・合格閾値は決めていない。

### 2026-10-18 第3回の実装反映（再レビューの指摘10件）

| 節 | 実装で確定した内容 | 影響要件ID |
|---|---|---|
| 4 出力管理 | 所有権を失ったら即masterを0にし、Contextのsuspend完了を停止の完了とする。同時使用はチューナーの明示選択だけが許可し、退出で解除（IC-21、IC-25） | MX-06、MX-15、MA-09 |
| 8 fence | 編集は受付時の再生世代に属し、停止・再開始で待機中の編集は実行しない（IC-20） | MX-04、MS-07 |
| 14 解析 | 先読みした予定拍は、fenceの確定・一時停止・解析の終了で鳴らない分を撤回し、fence後を取り込み直す（IC-24）。一括APIも逐次処理。解析対象頻度はパターンの周期で検査（IC-23） | MA-01、MA-05、MA-07 |
| 2.1 チューナー | 同時表示中のメトロノームのクリックは外部出力としてチューナーへ通知し、測定中は統計から除外（マイク入力の分離は変えない） | MA-09、MX-17 |

自動試験とheadless Chromiumでの確認であり、実音の二重発音・Safari・実機（MD-01〜19）の合格ではない。

### 2026-10-18 再開確認・対応窓の包含

| 日付 | 修正点 | 影響要件ID・試験 |
|---|---|---|
| 2026-10-18 | 一括解析も対応窓の右端を含み、同時刻の発音をすべて取り込んでから予定拍を確定する。余剰上限と曖昧性判定は維持。境界の回帰試験2件を追加 | MA-05〜08、MQ-02、MT-16/17 |
| 2026-10-18 | 第3回の修正とIC-14・IC-20〜25を再確認。検証結果は実装状況7章へ更新し、実機未確認との区別を維持 | MP-08/09、MX-04/06/14/15、MA-01/05/07/09 |

新しい機能選択・調整値の決定は行っていない。
