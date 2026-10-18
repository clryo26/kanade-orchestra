# メトロノーム機能の実現性と設計前調査

確認日: 2026-10-18。対象: 利用者提示の「メトロノーム機能 統合仕様案 Ver.1.0」全文。2026-10-18設計改訂: 決定事項と修正4点を反映。詳細契約は[基本・詳細設計](METRONOME_DESIGN.md)、[データ/API設計](METRONOME_DATA_API_DESIGN.md)を正本とする。調査基準: HEAD `061240a9d5bd98e196c5e5ef8a6e95f4744f8422`。全フェーズの機能を最終仕様に含め、01a・01b・02〜05は依存関係に沿う実装順序とする。機能の削除や優先順位付けは行わない。

**【推定】全機能は、音楽時間モデル・出力所有権・個人履歴を最初から分離すれば実装可能である。ただし、全端末での背景再生、音声と同精度の振動、楽器によらない発音判定精度は保証できない。**【設計目標】独立したメトロノームをシステム管理者の実験室から開始し、チューナーとは共通の音声調停を介して連携する。【確認済み】既存100 ms先読み方式は今回の180 ms主スレッド負荷で予約遅延を生じ、Workerから主スレッドへの通知だけでは解消しなかった。【設計目標】AudioWorkletを主候補、先読み方式を比較候補とし、共通イベント列で比較する。【未検証（実機が必要）】iPhone/iPad/Android、PWA、Bluetooth、実楽器、長時間発音精度の受入は未実施である。

本書のラベルは以下の意味で使う。関連文書は[要件追跡表](METRONOME_REQUIREMENTS_MATRIX.md)と[実装計画](METRONOME_IMPLEMENTATION_PLAN.md)。本書は設計前の提案であり、製品実装・端末動作の完成宣言ではない。

| 区分 | 意味 |
|---|---|
| 確認済み | コードの読取り、一次資料の記述、今回の計測で直接確認。公式文書の確認は実機動作確認と区別する |
| 推定 | 確認した事実からの技術的判断。性能・互換性の保証ではない |
| 設計目標 | 採用を推奨するモデル・振る舞い・試験。実装済みではない |
| 調整値 | 上限・閾値・先読み等の比較候補や暫定安全制限。実測で確定し、保証値としない。初期profileは詳細設計を参照 |
| 未検証（実機が必要） | 当該OS/端末/経路・楽器で測る必要がある事項。その他の未試験も「未検証」と明記する |

## 1. 既存チューナーは安全管理を再利用し、音楽時間を拡張する

【確認済み】作業前に[AGENTS.md](../AGENTS.md)とGitを確認し、開始時の `git status --short` は空だった。今回は新規3文書と `.tmp/metronome-research/` の試作のみを作成し、ソース・既存設計文書・チェックリストを変更しない。コミット、push、デプロイ、DB操作は行わない。指定されたSYSTEM_DESIGNの正本は `docs/` ではなくルートの[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md)である。

以下のコード読取り結果は【確認済み】、再利用判断は【設計目標】である。行番号は調査時点の位置を示す。

| 対象・根拠 | 確認した実装 | 再利用するもの / 分離・改修する境界 |
|---|---|---|
| [scheduler.js:13–116](../src/static/js/modules/tuner/scheduler.js#L13) | 先読み100 ms、タイマー25 ms、開始余裕30 ms。hold/timed/repeat/alternate/metronome。BPM30〜240、拍数1〜12。定速 `t0+k*60/bpm`、先頭accentはbool。時計/タイマー注入、stop世代あり | 偽時計・音時計予約の責務を再利用。分母、群、曲線、層、pause/seekは新モデルへ。既予約音の取消は音源側の責務 |
| [playback.js:1–48、202–223、364–402](../src/static/js/modules/tuner/playback.js#L1) | 入力とは別の再生専用Contextをsession所有。最大4音、master上限0.25、voice数正規化、20/30 msフェード。クリック1000/1500 Hz・20 ms・立上り2 ms | タップ内await前の生成/resume、ゲイン安全策を参照。高密度用音源は分離。clickごとの配列参照はreleaseまで残るためonended解放・有界管理が必要（ヒープ増加量は未測定） |
| [session_coordinator.js:1–126](../src/static/js/modules/tuner/session_coordinator.js#L1) | visibility/capture/output/displayFrozen/practice/persistenceを分離。captureEpoch/playbackGeneration/ownerEpoch/saveGeneration。初期排他、同時使用とイヤホン申告で許可 | 直交状態・世代・同意を共通調停へ。入力Contextと出力Contextの実体は同一化しない |
| [launcher.js:19–20、123–156、316–330](../src/static/js/modules/tuner/launcher.js#L19)、[index.js:23–31、915–931](../src/static/js/modules/tuner/index.js#L23) | MAIN_SCRIPTSを依存順ロード、TAB_GROUPSで遅延ロード。権限・可視性・起動世代をawait後も確認。退出で音源/測定/描画を解放。復帰で測定は再試行するが音源・練習は自動再開しない | 起動契約と退出を参照。クリックだけの利用でマイクや解析全体をロードしない。新機能も復帰後は手動再生 |
| [trainer.js:147–148、241–248、293–322](../src/static/js/modules/tuner/trainer.js#L147)、[view_trainer.js:217–226、479–501](../src/static/js/modules/tuner/view_trainer.js#L217) | metronome課題は持続音target1件と定速クリック。既存DPは音高を含み開始許容max(100 ms,25%拍)。光の拍は独立setTimeout | 課題UI・試行単位を参照し、新エンジンのadapter候補にする。クリックごとのタイミング解析や音との同期として流用しない |
| [onset.js:1–30、77–145](../src/static/js/modules/tuner/onset.js#L1)、[note_events.js:1–173](../src/static/js/modules/tuner/note_events.js#L1) | 10 ms RMS、50 ms中央値から6 dB上昇、20 ms確認後候補時刻へ遡及、offset30 ms、再attackは10 dB dip/30 ms内rise。音高変化でも音符分割 | 実効時刻・gap・境界処理は再利用候補。音高変化を楽器のattackと同一視しない。閾値と10 ms hopの楽器別精度を再評価 |
| [measurement_store.js:1–27、75–175、235–252](../src/static/js/modules/tuner/measurement_store.js#L1) | 30分、40 Hz pitch/100 Hz envelopeの有界リング、150 ms並替え、late保持、epoch別sampleRate/時計対応、条件境界、半フレームeffectiveFrame2 | コピーsnapshot、原データ不変、時計/条件識別子を再利用。テンポマップ・校正版・出力欠落を追加する設計 |
| [workspace.js:29–35、315–417](../src/static/js/modules/tuner/workspace.js#L29) | 出力通知受信時のdeps.nowを入力時計へ写像。clickでstart−0.25〜start＋0.5秒を除外。history初期none、同意撤回で未送信を破棄 | チューナー統計の保守的除外を維持。予定出力時刻に基づく別のメトロノーム解析を作る。連続クリックへの既存除外幅流用は有効データを失う |
| [storage_local.js:1–35、321–340、552–584](../src/static/js/modules/tuner/storage_local.js#L1)、[storage_remote.js:96–225](../src/static/js/modules/tuner/storage_remote.js#L96) | 保存時のみIDB、owner/削除世代、同意、outbox owner固定、logout abort。未知版/upgrade失敗はread-only。PCM等非保存 | 所有者・削除transaction・同期原則を再利用。音高履歴の表・validatorへタイミング履歴を押し込まない |
| [settings.js:1–13、44–61、186–236](../src/static/js/modules/tuner/settings.js#L1) | schema1 localStorage、A4は保存、他設定はpersistSettings選択時、preset各20件/8KB、未知版上書きなし | 端末設定と個人履歴を分離する設計を参照。メトロノームは独立key/schema/容量を定義 |

【確認済み】[TUNER_ADVANCED_DESIGN.md:134–143](TUNER_ADVANCED_DESIGN.md#L134)と[controller.js:196–215](../src/static/js/modules/tuner/controller.js#L196)は、音声秒・performance時刻・UTCを分離する。[データ/API設計:90以降](TUNER_ADVANCED_DATA_API_DESIGN.md#L90)は保存契約、[実装状況:394–440](TUNER_ADVANCED_IMPLEMENTATION_STATUS.md#L394)は合成信号/疑似マイクと実機未完の区別を示す。既存の20〜30 Hz描画は目標、総合スコアはnull、適応窓は無効、Q-006/PR-008/X-009・N系/全実機/共有テスト017/H-010は未完として扱う。過去文書にあるPostgreSQL16使い捨て試験の結果を、今回の本番・共有DB確認に読み替えない。

### 独立機能と共通出力管理を確定事項として反映する

| 論点 | 推奨【設計目標】 | 代替と制約 |
|---|---|---|
| チューナー内1タブか独立か | 独立メトロノーム。基本クリックはマイク権限不要、音高解析ロード不要。チューナー同時表示と既存課題はadapterで接続 | 1タブなら導線は短いが現在の入場時測定とタブライフサイクルを再設計し、7画面と楽曲操作を収容する必要がある |
| 公開範囲 | システム管理者限定の実験室から開始 | 団員公開は別の受入判断。機能を削る意味ではなく、認可・実機受入を満たして公開範囲を広げる |
| Context/出力管理 | 入力Contextは独立、共通AudioOutputManagerが出力Contextの唯一の所有者となりlease/generation・音量合算・Audio Sessionを調停する（確定） | 各機能が別出力Contextを所有する案は移行量を抑えるが音量合算・Audio Session競合を調停する必要。共通化の実装前に回帰試験する |
| scheduler共有 | 新しい純粋なスコアcompiler/tempo mapとイベント契約を共有 | 現行scheduler/playback実体の直接共用は表現・寿命・遅刻処理が不足。置換可能なadapterにする |

【確認済み】実験室の認可は `portalAuthVerified` とpermissionのシステム管理者厳密一致、hostのDOM接続/親hidden/visibilityを含む（[improvement_suggestions.js:392–624](../src/static/js/modules/improvement_suggestions.js#L392)）。[routes.js:388–438、594–599、640–673](../src/static/js/modules/navigation/routes.js#L388)は遷移・logout時に退出し、遷移世代で古い履歴復帰を拒否する。`portalAppState` が正本で、認証参照は `getAppState()` / `portalRuntimeContext.appState` を用いる（[app_state.js:128–142](../src/static/js/store/app_state.js#L128)、[runtime_context.js:15–33](../src/static/js/utils/runtime_context.js#L15)）。新しい音声状態は機能内に閉じ、別の共有app stateを増設しない。

【確認済み】本番入口はmain.js、src/index.htmlの順はapp_state→runtime_context→main.js（[1335–1337](../src/index.html#L1335)）。チューナーのMAIN_SCRIPTSはmusic→temperament→target_model→display_filter→settings→errors→audio→scheduler→playback→graph→view→controller→onset→note_events→analysis_stats→measurement_store→session_coordinator→view_tabs→workspace→index。TAB_GROUPSはsound、analysis、practice、historyごとに必要資産を遅延ロードする（上表のlauncher/index）。【設計目標】メトロノームは `window.PortalMetronomeLib`、共通出力は `window.PortalAudioLib`、チューナーは従来の `window.PortalTunerLib` に登録する。依存manifestを一元化し、共有audioの依存を両機能のrelease生成対象に含める。release接頭辞m-/a-/t-、Worker/Workletの機能別URL・processor名も分離する。MT-19で同一ページ両ロード・逆順ロードの非上書きを検証する（MX-17/MX-18）。

【確認済み】tuner releaseはJS/CSSの改行正規化と識別行除外後SHA256から `t-`＋12桁を生成し、Worker/Workletも同じrevで取得、混在を停止する（[TUNER_DESIGN.md:208–220](TUNER_DESIGN.md#L208)、[generate_tuner_release.mjs:19–83](../scripts/generate_tuner_release.mjs#L19)）。DB OnlyとZIP allowlistは[SYSTEM_DESIGN.md:47–68](../SYSTEM_DESIGN.md#L47)、[create-source-zip.py:20–29、63–145](../scripts/create-source-zip.py#L20)にある。`.tmp/` は共有ZIPのinclude root外でgit/docker ignore対象。今回はZIPを生成していない。【設計目標】団員公開前にメニューだけでなくroute/history復帰/API認可を変更し、別組織・hidden member・失効端末・匿名・管理者でも他人の履歴を読めないことを検証する。

## 2. 仕様の語を確定し、音楽位置と実時間を分ける

以下はすべて【設計目標】。比較候補を残しつつ、今回確定した解釈を推奨欄へ反映する。詳細な操作/型は新規設計書が正本。

| あいまいな語 | 解釈候補 | 推奨する具体的振る舞い |
|---|---|---|
| 拍の音価/BPM基準 | 計時基準、表示の拍、クリック単位を同一にする / 分ける | BPM reference、meter、groups、pulse、表示beatFeelを独立。基準変更時に「速度維持して換算」「数値維持して速度変更」を選ぶ |
| 拍単位の変更/拍感切替 | 音価変更 / 半テンポ・倍テンポ / アクセント再配置 | スコア速度を維持し、知覚拍層とaccentだけを境界で切替。速度変更は別操作。カスタム音価も保持 |
| テンポ当て | 自分でTAPし答える / 隠されたテンポに合わせる | 正解テンポを隠して提示→TAPで回答→BPM誤差と有効tap数を表示。無音追従は別の練習ステップ |
| 練習プログラム | 単なるpreset集 / 時間・小節で進む手順列 | count-in、tempo curve、反復、無音、休憩、目標を持つstep列。試行IDと終了条件を固定。フェルマータ/手動次へにも対応 |
| ランダム無音 | 各音抽選 / 小節抽選 | 単位と確率を保存しseed付き再現。小節単位を既定、音単位も明示選択。解析の期待拍は消さない |
| 出番予告 | 残小節表示 / 音声読み上げ / 合図音 | 指定小節・拍前に数字＋合図音/対応時振動。読み上げ採否・言語・遅延は別決定。カウントインと分離 |
| 指揮パターン | 拍番号 / 軌跡 / 自動の専門指揮 | 群拍ごとの打点と補間軌跡。2/3/4拍と加算群のpreset＋編集。演奏表現や指揮の良否を評価しない |
| 振動 | 精密なクリック代替 / 補助通知 | 対応端末の補助。実効タイミング保証なし。iOSは非対応表示＋音/光代替、機能要件自体は残す |
| 画面消灯対策 | ロック中も継続 / 自動消灯を抑える | 明示選択のScreen Wake Lock。拒否/解放を表示。手動ロック/背景では停止し、復帰後自動再生しない |
| タイマー | 壁時計 / 有効再生時間 / 楽譜時間 | 有効再生時間を既定。pause・フェルマータ待機を除外。別設定で実時間終了も選べるよう意味を保存 |
| アクセント3階層 | 小節/群/細分 / 群/拍/細分 | 仕様どおりgroup先頭・各pulse・subdivisionを個別設定。小節頭はgroup属性で強調。rest/velocity/timbreを独立にする |
| 連符・BPM等の上限 | 無制限 / 有界入力 | 機能を落とさず、分子分母・BPM・連符比・層・展開件数の安全上限を測定で決定。現段階の数値例は製品上限ではない |

### 有理数位置と基準音価を正本にする

【設計目標】スコア位置sは全音符単位の既約有理数 `{n,d}`（d>0）。meter={numerator,denominator}、groupsは分母音符数の配列で総和=numerator。BPMの保存/通信正本は `{bpmTenths,reference:{n,d}}`（B=bpmTenths/10）、pulseは刻む単位、accentはgroup/pulse/subdivisionの各層、tempo curve・音色・mute・cueは小節/区間イベントとして分離する。単純4/4=[1,1,1,1]、複合6/8=[3,3]、加算7/8=[2,2,3]、混合は小節列で拍子を切り替える。音符長とgroup表示を一致させる制約は設けない。

【確認済み（算術）】6/8でBPM60・基準付点四分3/8なら小節2秒、群拍1秒、8分1/3秒。基準8分1/8でBPM60なら小節6秒、群拍3秒。同じ速度を保つ基準変更は `Bnew=Bold*rold/rnew` で、付点四分60→8分180となる。BPM60の数値を固定して基準だけを変える操作は速度も変える。

【設計目標】32分は1/32、d個の付点は元音価×`(2-2^-d)`、n:m連符は元音価×m/n。固定tick幅を正本にせず、最終描画時だけ `round(sampleRate*tAbsolute)` にする。毎回「区間原点＋正確なスコア位置」から求め、`next += interval` の浮動誤差を積み上げない。小節長prefixとテンポ区間積分prefixを保持し、seekは二分探索する。安全整数を超える有理数や過剰展開はエラーとして説明し、黙って丸めない。

【設計目標】ポリリズムは独立したcycle、pulses、phaseを持つ層で表す。3:2を同一cycleで重ねる表示格子はLCM(3,2)=6、音は3＋2回（共通先頭をまとめれば4時点）であり格子全部を発音しない。異周期の層は分母を共通化した整数周期のLCMで再合流点を求める。LCMが大きい場合は層ごとの位相表示に切り替え、音を間引かない。スウィングA:Bは対象pair内の境界を `pairStart+pairLength*A/(A+B)` へ移し両端を固定する。連符内への適用を明示し、既定は通常の2分割pairのみ。裏拍は有理offsetとmute mask、customはoffset/duration/velocity/rest/accent階層の列とする。

### テンポ曲線は積分と逆関数で拍時刻を求める

【設計目標】経過秒を独立変数にする（確定事項） `domain:"seconds"`。区間基準音価rに対する到達拍数は `u=(s-s0)/r`、`u(t)=∫[0,t] B(x)/60 dx`、B(t)>0とする。スコア拍に対して線形なBPMは別の曲線なのでdomainを混ぜない。曲線の保存終点は `end:{barId,offset}` を正本とし、endBpmTenths/10と区間拍数Uから所要時間Dを計算する。durationSecondsは保存しない。秒数指定専用の曲線型は今回採用しない。段階変化は新しい定数区間、基準音価変更は区間境界で表す。

| 曲線 | 積分・拍数u(t) | 拍時刻t(u) / 終点の扱い |
|---|---|---|
| 一定B0 | B0*t/60 | 60u/B0 |
| 線形BPM B0+a*t | (B0*t+a*t²/2)/60 | `120u/(B0+sqrt(B0²+120*a*u))`。a≈0は一定式。D秒でB1ならa=(B1−B0)/D |
| 指数BPM B0*exp(k*t) | B0*expm1(k*t)/(60k) | `log1p(60k*u/B0)/k`。k≈0は一定式。D秒ならk=ln(B1/B0)/D |

【確認済み（算術）】U拍でB0→B1に達する秒数は線形で `D=120U/(B0+B1)`、指数で `D=60U*ln(B1/B0)/(B1−B0)`、B1≈B0では一定式の極限を使う。【設計目標】線形はBPM数値の一定増減、指数は一定割合の増減としてUIで区別する。区間prefix時間＋逆積分で絶対時刻へ変換し、負の平方根域・ゼロBPM・終点外を検証する。テンポ0で停止を表さない。

### 編集・待機・再開は同じ境界を音と解析へ渡す

| 操作 | 推奨する確定規則【設計目標】 |
|---|---|
| BPM変更 | 既定は次の選択pulse。次小節/即時も選択可能。即時は現在の出力スコア位置を連続に保ち、新しい原点を作り拍頭を再発音しない |
| 拍子/groups変更 | 既定は次小節。即時/次拍の場合は現在小節を部分区間で終了し新小節へ移る明示操作。リズム変更は詳細設計の操作表に従う。未確定UI値と再生中revisionを区別 |
| pause/resume | 現在出力位置と区間内位相を保存、未来音を取消。resumeは新AudioContext原点に対応付け、必要ならcount-in。performance時計停止時間を楽譜へ足さない |
| seek | 新transport generationを作り旧予約を取消。位置変更後は停止を既定。再生しながらseekは明示操作。欠落拍の追い付き連打をしない |
| fermata | 所定スコア位置でwaiting、先の音を予約しない。不定長を有限durationに偽装しない。利用者tapで新原点、即次拍/予備拍付き再開を選ぶ |
| 長休符/cue | スコアは進め発音だけmute。残小節・群拍・出番前N拍を同じ列から生成。seek/反復でもcue重複を防ぐ |
| metric modulation | 旧側/新側の音価と等号方向を明示。旧♩秒長=新♪.秒長、両BPM基準♩ならBnew=Bold*(3/16)/(1/4)、120→90 |
| stop/退出/背景/logout | source.stop/disconnect、Worklet終了フレーム、generation失効、振動終了、Wake Lock解放。復帰後自動再生しない。「停止」と「先頭へ」を分ける |

【設計目標】変更境界fenceを `{transportGeneration,tempoMapRevision,effectiveScore,effectiveAudioFrame}` として一度確定し、音・表示・解析へ同時配布する。主スレッド先読み済みsourceは境界以降だけ取消・再予約する。Workletは同じfenceを受理してからUIを確定表示し、受理が間に合わない場合は次の有効境界へ明示的に遅らせる。旧世代からのack/解析結果は現transportを操作できない。即時の意味は物理的ゼロ遅延ではなく、音声量子/メッセージ伝達後の最初の安全境界とし実測する。

### 共通schemaで基本・高度・楽曲presetを保存する

【設計目標】schemaVersionはデータ形、engineProtocolは再生メッセージ、analysisVersionは判定法の版で分ける。共通schemaにkind=basic/advanced/scoreを持ち、機能を欠落させずUIの見せ方を変える。未知majorは元データを保持して再生/上書きを拒否、既知旧版は純粋変換しコピー移行。件数・有理数・参照・循環・展開量・危険なキーを検査する。以下は構造例で全機能の列挙ではない。

```json
{
  "schemaVersion": 1,
  "presets": [
    {
      "id": "basic-uuid", "kind": "basic", "title": "6/8 基本",
      "tempo": {"bpmTenths": 600, "reference": {"n": 3, "d": 8}},
      "meter": {"numerator": 6, "denominator": 8}, "groups": [3, 3],
      "pulse": {"n": 1, "d": 8},
      "accent": {"group": [1, 0.8], "pulse": [1, 0.4, 0.4, 0.8, 0.4, 0.4], "subdivision": 0.25},
      "sound": {"kind": "synth", "id": "click", "volume": 0.5},
      "practice": {"countInBars": 1, "timer": {"seconds": 60, "clock": "activePlayback"}}
    },
    {
      "id": "advanced-uuid", "kind": "advanced", "title": "3対2",
      "basePresetId": "basic-uuid",
      "layers": [
        {"id": "a", "cycle": {"n": 3, "d": 4}, "pulses": 3, "phase": {"n": 0, "d": 1}},
        {"id": "b", "cycle": {"n": 3, "d": 4}, "pulses": 2, "phase": {"n": 0, "d": 1}}
      ],
      "swing": {"ratio": [2, 1], "target": "ordinaryEighthPairs", "applyInsideTuplets": false},
      "practice": {"randomMute": {"unit": "bar", "probability": 0.25, "seed": 42}}
    },
    {
      "id": "score-uuid", "kind": "score", "title": "楽曲練習",
      "basePresetId": "advanced-uuid",
      "bars": [
        {"id": "b1", "meter": {"numerator": 6, "denominator": 8}, "groups": [3, 3], "soundId": "click", "mute": false},
        {"id": "b2", "meter": {"numerator": 7, "denominator": 8}, "groups": [2, 2, 3], "accent": {"group": [1, 0.8, 0.8], "pulse": [1, 0.4, 0.8, 0.4, 0.8, 0.4, 0.4], "subdivision": 0.25}, "soundId": "click", "mute": true}
      ],
      "tempoMap": [{"start": {"barId": "b1", "offset": {"n": 0, "d": 1}}, "reference": {"n": 3, "d": 8}, "startBpmTenths": 600, "curve": "linear", "domain": "seconds", "endBpmTenths": 800, "end": {"barId": "b2", "offset": {"n": 7, "d": 8}}}],
      "events": [
        {"kind": "cue", "barId": "b2", "beforePulses": 2},
        {"kind": "fermata", "barId": "b2", "offset": {"n": 7, "d": 8}, "resume": "countIn"}
      ],
      "extensions": {}
    }
  ]
}
```

【設計目標】basePresetIdはインポート時に解決・循環検出し、再生開始時に不変snapshotへ展開する。編集した親presetが再生中の子へ暗黙反映されない。小節のmeter/groups指定は親の値を置換し、pulse/accent配列を小節ごとに再検証する。例の2小節は13/8全音符=13/3基準拍で、線形60→80の所要時間は26/7秒（実行時の計算結果でありJSONには保存しない）となり末尾fermataに一致する。展開済みコピーを保存する方式も選択肢で、参照の可搬性は設計確定事項である。

## 3. 小規模試作は先読み不足を確認し、実音精度は未検証である

【確認済み】再現コマンドはリポジトリルートで `node .tmp/metronome-research/measure.cjs`。既存インストールを使用し、追加インストールなし。2回実行したうち最終結果を採用した。環境はWindows `win32 10.0.26300 x64`、Playwright1.61.1、付属Chromium149.0.7827.55、headless、`--autoplay-policy=no-user-gesture-required`。これは試験バイナリー版であり一般配布最新版の主張ではない。試作と結果は `.tmp/metronome-research/measure.cjs` / `results.json` に置き、共有ZIP対象外である。

| 試験 | 条件 | 今回の結果【確認済み】 | 解釈の限界 |
|---|---|---|---|
| Offline波形 | mono10秒、44.1/48 kHz、BPM137の24分割相当、499個の1sample impulseを整数sample絶対時刻予約 | 両sampleRateで499/499検出、最大絶対誤差0 sample | 丸めた予約位置と描画位置の一致。音響出力、曲線compiler、マイク精度の試験ではない |
| main-idle | 100 ms先読み/25 ms timer、10 ms間隔200件、予定2秒、観測2.5秒 | 遅刻0、最大補充間隔26.60 ms | 単一headless条件 |
| main-busy | 同上、450 msごと180 ms busy loop | 遅刻32/200、最大71.13 ms、p95 51.02 ms、最大補充180.50 ms | 遅刻はJS投入遅延であり聴こえた時刻ではない |
| worker-busy | Worker25 ms→main message、同じ負荷/先読み | 遅刻36/200、最大82.74 ms、p95 62.63 ms、最大補充195.60 ms | mainで音源を予約する限りWorker通知は負荷を迂回できない。方式の普遍的優劣は断定しない |
| main-wide-busy | 300 ms先読み/25 ms timer、同負荷 | 遅刻0、最大補充180.50 ms | 180 ms停止が300 ms先読みより短い条件の結果に限る。先読み採用値の根拠にはしない。停止/即時変更/pauseの予約取消反応は未測定 |
| 既存scheduler偽時計 | BPM240、開始0.03秒、timerを2秒停止 | 過去予定7件、最大1.72秒遅れをhandlerへ渡す | 既存の期限切れ再投入を確認。実音は未測定 |
| stop後callback | 捕捉済みtimerをstop後に再実行 | running=false、追加0件 | 予約済みAudioNodeの停止保証ではない |

【確認済み】live試験のsampleRateは44100、APIが返したbaseLatencyは10 ms、outputLatencyは64 msだった。**これらはheadless API値であり物理機器の遅延計測ではない。** 遅刻指標は `max(0,currentTime−scheduledTime)` の全イベント分布で、p95には遅刻0も含む。CPU型番・温度・実GC・DOM負荷を統制していない。端末受入の代替にしない。

### 四方式を同じ譜面イベントで比較する

| 方式 | 精度・負荷・長時間の見通し | モバイル差と編集 | 判定 |
|---|---|---|---|
| main先読み | 予約済み区間は音声時計で発音。補充停止がhorizonを超えると切れる。絶対時刻生成なら累積誤差を避けられる | 導入容易、背景抑制/GCに依存、予定source取消必須 | 【確認済み】今回100/25は負荷で遅刻。【設計目標】互換/比較用 |
| Worker駆動 | 譜面計算をmainから分離できる。mainへ戻す予約はmessage待ちに依存 | hiddenの万能回避ではない。OS停止は救えない | 【確認済み】今回通知だけの方式では改善なし。【推定】compiler供給に有用 |
| AudioWorklet | 音声描画スレッド内でframeに配置、main描画負荷から分離。自身の締切超過/キュー欠乏/OS停止は残る | HTTPS、機能検出、有限キュー、revision/ack、サンプル長可変対応。process内allocation/JSON/sortを避ける | 【設計目標】主候補。【未検証】試作と同条件比較は次段階 |
| 事前buffer | 短いクリックbuffer共有は有効。全区間描画は補充負荷を抑えるがメモリーと変更コスト増 | fermata/即時編集はchunk切替。48 kHz mono float32で10分115.2 MB、30分345.6 MB（算術） | 【推定】短い音源/小節chunkに有用。全曲固定buffer単独は対話機能に不向き |

【設計目標】先読み200〜300 ms/20〜25 ms timerは比較候補であって採用値ではない。既存100/25も保持して比較する。MT-07では先読みより長い停止、MT-08では先読み拡大時の停止・即時変更・一時停止と予約済み音取消の反応遅れを測る。300/25の1条件合格をスマホ仕様にしない。Workletは十分先の譜面chunkと曲線を持ち、mainから毎拍通知を待たず発音する。遅刻イベントは鳴らさず欠落数を記録し、正しい将来位相へ進む。stopは追跡中sourceとゲインを停止し、onendedで集合から外す。音声スレッドへの停止伝達自体も遅れるため、手動停止・背景イベント・予約済み音の残りは実測対象にする。

【設計目標】最悪頻度はBPM上限・連符比・層数未確定なので確定できない。基準音価r（全音符単位）、32分をn:mで置換する層ごとに、保守的上界を `R=(Bmax/60)*Σ(32*r*n/m)` events/sとする。四分基準なら32r=8。仮にBmax300、7:4、4層なら280/s、25 msあたり平均7件、300 ms先読み84件。32分の各slotをT個に置換する別の定義なら倍率Tであり、B400/T9/4層なら1920/sとなる。**どちらも負荷試験の仮定で製品上限ではない。** 独立周期は層別頻度を合算しLCM全格子を発音しない。同時発音数と音のtailで残るvoice数、メッセージ/queue容量、最悪burstを別に予算化する。

### 表示は音声時計から位相を読む

【設計目標】getOutputTimestampの対応点から `pEvent=timestamp.performanceTime+1000*(event.audioTime−timestamp.contextTime)` でperformance時刻へ写す。この場合outputLatencyを重ね足ししない。rAFは現在出力位置から振り子・拍・指揮図を再計算し、フレーム欠落は表示だけを飛ばす。未対応はcurrentTimeと利用可能な遅延値から推定し精密同期未保証と表示、表示補正は校正とは別保存。Bluetoothの固定遅延と変動を分け、経路変更で無効化する（根拠は§4のWeb Audio/出力同期資料）。

【設計目標】自前合成クリックは容量と原音ライセンス管理を抑えやすい。短いサンプルは音色の選択肢として維持し、再配布条件・出典・音源容量・切り出し点・decode時間を記録して判断する。短いenvelopeで端を連続にし、全層同時peakとtail重なりをOfflineで検査、master/層別gainでクリップを防止する。チューナーの4音・0.25は既存保護値であり新仕様の上限ではない。limiter/compressor追加時は遅延と音色変化も測る。

## 4. 公式仕様は前景動作を支え、背景・振動・割込みは別受入にする

以下の外部記述は一次資料の【確認済み】である。確認日はすべて2026-10-18。版付き資料の導入時点と、2026年の全端末の実装状況を同一視しない。実機のOS/browser版は今回取得していない。

| 一次資料・対象版 | 確認した内容 | 設計への適用 |
|---|---|---|
| [Web Audio Recommendation 2021-06-17](https://www.w3.org/TR/2021/REC-webaudio-20210617/)、[1.1 WD 2026-09-22](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/) | 時刻指定、Offline、Worklet。過去のstartは即時開始。1.1は勧告済みではない | 時刻指定と期限切れ除外。将来仕様と搭載を分ける |
| [A tale of two clocks 2013-01-09](https://web.dev/articles/audio-scheduling) | JS timerと音声時計、先読み、rAF分離、長い先読みと編集のトレードオフ | 定期callback自体を拍時計にしない |
| [AudioWorklet Chrome66](https://developer.chrome.com/blog/audio-worklet/)、[design pattern 2018-06-18](https://developer.chrome.com/blog/audio-worklet-design-pattern/) | render thread、当時128frame、44.1 kHzで約3 ms予算、非同期供給/underflow | 固定128を仮定せず実配列長を使い、有界処理にする |
| [Audio output latency](https://web.dev/articles/audio-output-latency)、Web Audio1.1 §1.2 | outputLatencyは推定、getOutputTimestamp写像、経路変更で変化。資料搭載表はChrome/Edge102、Firefox70、Safari18.4 | 値の存在と精度を分け、Bluetooth往復校正の代わりにしない |
| [Chrome autoplay（Web Audioは71から）](https://developer.chrome.com/blog/autoplay/)、[WebKit144211](https://bugs.webkit.org/show_bug.cgi?id=144211)、[248265（Safari15報告）](https://bugs.webkit.org/show_bug.cgi?id=248265) | user gestureで開始/resume。スライド後touchendが有効と限らない | 明確な再生ボタン内await前にContext生成/resume、失敗時は停止表示 |
| [Audio Session WD 2024-11-13](https://www.w3.org/TR/2024/WD-audio-session-20241113/)、[WebKit237322 comment6、2024-09-25/iOS17以降](https://bugs.webkit.org/show_bug.cgi?id=237322#c6) | WD既定auto、playback/play-and-record、interrupted等。WebKit実装者はplaybackで消音スイッチ下のWeb Audioを説明 | 単一管理者でfeature detection。音のみplayback、入力併用play-and-recordを候補に実機検証。WDのautoと実装ambientを同一視しない |
| [WebKit261554、2024-03-01修正記録](https://bugs.webkit.org/show_bug.cgi?id=261554) | playbackでも背景suspendした不具合の履歴 | 全iOSで背景継続可能という根拠にはならない |
| [Screen Wake Lock WD 2026-09-29](https://www.w3.org/TR/2026/WD-screen-wake-lock-20260929/)、[Safari16.4/2023-03-27](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)、[Safari18.4/2025-03-31](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) | 可視fully active対象、hiddenで拒否/解放、省電力等で解放可。Safari16.4導入、Home Screen修正はiOS/iPadOS18.4 | 自動消灯防止の補助。SafariタブとPWAを別試験。CPU/背景音声継続保証にしない |
| [Vibration CR Draft 2026-05-21](https://www.w3.org/TR/2026/CRD-vibration-20260521/)、[WebKit171766、2017年削除](https://bugs.webkit.org/show_bug.cgi?format=multiple&id=171766) | Chromium実装、WebKit反対、Firefox129削除。visible/sticky activation、falseやhidden打切り | iOS Safariは非対応扱い。AndroidもAPI存在/trueだけで実振動保証にしない |
| [Chrome88 timer throttling、2021年説明](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)、[Chrome57背景方針](https://developer.chrome.com/blog/background_tabs) | 条件次第でhidden timerを1秒/1分間隔に検査、無音音源は免除されない。背景rAF停止 | Android省電力/無音練習も試験。Workerに同じ数値を無条件外挿しない |
| [WCAG2.2 SC2.3.1 Understanding、2025-09-17更新](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html) | 任意の1秒で3回超flashを避けるか一般/赤flash閾値以下。最大倍率、面積、輝度、赤を評価 | 光をoff可能にするだけで済ませない。全層合算を検証 |

【設計目標】iOS Safari/PWAとも画面表示中の再生を契約とし、ロック・背景・着信・Siri・出力抜去などは停止/状態表示/手動再開へ。消音スイッチはaudioSessionの存在と設定別に確認し、「必ず鳴る/必ず止まる」と事前断定しない。Android Chromeの振動は音の補助で、端末振動設定・省電力・motor遅延によって制限される。PCもタブ非表示と出力変更の影響を受ける。OSに止められた後の処理をページだけで保証できないため、復帰時に必ず状態照合して旧予約を無効化する。

【設計目標】TAPはpointerdownのevent.timeStampをperformance時計へ正規化し、直近4〜8間隔のmedian/MADで外れ値を除外、残った間隔平均から60/meanを求める候補。観測数・再入力/resetを表示し、長い無操作でリセットする。閾値・必要回数は試験で確定する。物理タッチ→callbackの遅延は未測定。44 CSS px以上を設計目標に、停止ボタンの固定、片手縦画面、数値入力、スクロール誤判定、二重pointerの除外を検証する。

【確認済み（算術）】180 BPM四分pulseは3 Hz、240 BPMは4 Hzで、細分全てを点滅させるとさらに増える。【設計目標】既定は振り子/位置移動/小さな低コントラストindicator、全画面や飽和赤flashを避ける。全細分を明滅へ変換せず、光機能を維持しながら安全な面積・輝度・flash数に抑える。最大ズーム/全画面/全層合算で評価し、reduced-motionと静的拍番号も用意する。【未検証（実機が必要）】リフレッシュ、知覚同期、motor、VoiceOver/TalkBackと片手操作。

## 5. 連携解析は校正と観測の有効性を別に管理する

【設計目標】初期排他、同時使用は明示選択＋イヤホン申告を継承する。チューナー統計は出力区間を引き続き除外する。一方、メトロノーム解析はクリックを基準とするため、別eligibilityを定義し、有線イヤホンを推奨する。スピーカーのクリック付近を一律除外すると本来の拍上の演奏も消える。クリック音との相関・帯域/音色特徴は混入疑いの補助フラグにし、確実な分離やAECの万能性を約束しない。混入した観測を合格へ使わず、除外数を示す。

【設計目標】校正は既知クリックを出力し、スピーカー→マイクの包絡/相関から往復offsetの中央値とばらつきを測る。入力/出力Contextはperformance対応点で結びcaptureEpochを固定する。outputLatencyは入力・空間伝搬・検出遅延を含まず、往復offsetへ二重加減算しない。反射・距離・AECの影響を記録し、経路/sampleRate/OS-browser主要版/検出版/測定日時/手法/残差を端末内に保存する。アプリ生成local route keyを使い、deviceIdをサーバーへ送らない。BT接続/切断、入力変更、割込みで校正を失効させる。

【推定】10 ms包絡と検出閾値は量子化と楽器依存の遅延を持ち、弦・金管・低音の遅いattack、レガート、トレモロで誤分割/欠測が起こり得る。onsetの20 ms確認は候補時刻へ戻るので単に20 msを引く補正は誤りである。音高安定時刻とattackを区別し、pitchChangeを真の発音に数えない。【設計目標】短hop、帯域別包絡、spectral flux、立上りfitを合成信号と実楽器で比較する。音楽的な意図や音色/奏法の良否を断定しない。

| 指標 | 定義案【設計目標】 | 有効性の条件 |
|---|---|---|
| 先行/遅延 | 共通時計上 `e_i=(observedInput_i−calibrationOffset)−scheduledOutput_i`。正=遅れ、負=先行 | 校正・時計対応・出力eventID・onset種別が有効 |
| 拍に対する割合 | `100*e_i/localReferenceBeatDuration_i`。加減速位置の局所BPMから求める | 32分間隔や群拍とBPM基準拍を混同せず分母を表示 |
| 先行傾向/ばらつき | 残差median、MAD、標準偏差を別表示 | tempo/meter/拍位置/経路/校正/解析版で分層 |
| テンポ安定性 | 観測IOI/予定IOIの比の変動。意図した加減速を差し引く | 欠測/長休符越えを連続IOIにしない |
| 対応・位置別傾向 | 時間窓と順序を保つ一対一対応、余剰/欠落は別数。小節/群/pulse位置別集約 | nearestだけの対応を避け、休符後の1拍ずれを検査 |
| 合格/保留 | 有効n/候補N、除外理由別数、校正残差、検出信頼性を併記 | 最低n/閾値は未確定。データ不足/混入/gap/校正不足/出力欠落は保留 |

【設計目標】合成信号では正解sample indexを持つ急峻attackと5〜200 ms ramp、低/高音、複合音、振幅変調、連打、レガート音高遷移、雑音、クリック混入、clipping、gap、sampleRate変更を生成する。onset誤差分布、precision/recall、誤分割、欠測、校正回収誤差を測る。実機は打楽器/弦/木管/金管/低音、音量/奏法/距離を横断し参照録音と照合する。製品は録音/PCMを保存も送信もしない。QA用参照音声は明示した一時データとして管理し製品履歴から分離する。【未検証（実機が必要）】楽器別精度、最低観測数、合格閾値、BT変動、capture/output時計ドリフト。

## 6. 保存は端末設定と本人の練習履歴を分離する

【設計目標】設定/presetは端末保存を基本とし、保存可否を明示する。履歴は初期offで端末内/アカウントを本人が選ぶ。保存しない場合に履歴IDBを作らない。共有端末のpreset名等も個人情報になり得るため、消去範囲を説明する。保存量上限・期限はメトロノームとして決定し、チューナーの100MB/2h/10000eventsを無根拠に転用しない。

【確認済み】既存API `/api/tuner` はsystem admin依存（[routers/tuner.py:15–21](../src/backend/routers/tuner.py#L15)）。owner UUIDはサーバー側で組織と現役memberから解決しmember_birth/device認証時刻を照合、member削除/再挿入triggerで旧所有者を失効する。他人IDは404、管理者でも他人の履歴を読めない（[tuner_service.py:181–204、498–503](../src/backend/services/tuner_service.py#L181)、[017:144–194](../db/migrations/017_tuner_practice.sql#L144)）。書込みと全削除はowner行ロック→active/history_epoch確認の順で直列化する（[repository:1–8](../src/backend/repositories/tuner_repository.py#L1)）。

【設計目標】このidentity・consent・削除世代の仕組みを共通化するが、解析データ表は別にする。アカウント保存用の専用表を追加する設計は確定事項である。校正値は端末内のみ、設定/端末presetの保存は利用者が選択する。outboxは開始時のowner/historyEpochに固定し、古い送信を新世代へ付け替えない。同意撤回は未送信を破棄し、送信済みの消去は別操作と説明する。ローカルIDBは暗号化済みではなく、共有端末で機密保存とは案内しない。全削除は機能別epochを推奨し、根拠と別タブ競合対策はデータ/API設計で定める。

| 保存対象 | 保存先の提案【設計目標】 | DB影響 |
|---|---|---|
| UI/音量/端末preset | 小設定だけlocalStorage16KiB、端末presetは履歴別の専用IDB、本人選択保存（調整値） | 不要 |
| 楽曲/preset | 履歴別の専用IDB portalMetronomePresets、任意JSON入出力。account同期は本人同意の別設定 | account採用時に専用preset表 |
| 校正 | 端末内route別、raw deviceId非送信 | DB不要。校正値は端末内だけに保存しクラウド保存は設計しない（確定） |
| 練習履歴/要約/有効onset | 初期off。詳細onsetは端末、accountへは本人同意でセッション/条件/拍位置別の集計だけ。PCM/録音/全FFT非保存 | 本人account用専用表は集計のみ、個別観測の送信/DB保存なし（修正3再訂） |

【設計目標】表候補は既存owner FKを参照する `metronome_sessions`（program/tempoMap snapshot、各version、要約）、`metronome_summary_groups`（session/条件/拍位置別の集計だけ。個別観測は端末内）、`metronome_presets`、必要なら機能別consent/history_epoch。本人のみread/write、組織・member_birth検査、削除整合、上限・TTL、production→test同期除外を定義する。既存tuner_sessionsへkindだけ追加する案はvalidator/診断の音高契約と混ざるため推奨しない。migration番号は実装時の最新列で採番する。ロールバックは機能off→旧アプリへ戻し新表を残置、データ保全後の別手順でのみ破壊的削除を検討する。今回はmigrationファイル作成もDB適用も行わない（手順候補は[実装計画](METRONOME_IMPLEMENTATION_PLAN.md)）。

## 7. DC-01〜DC-19を追跡し、H-010を完了扱いにしない

以下の既存変更理由は[TUNER_ADVANCED_IMPLEMENTATION_STATUS.md:351–374](TUNER_ADVANCED_IMPLEMENTATION_STATUS.md#L351)で【確認済み】。対策はメトロノームの【設計目標】である。

| 既存項目 | 学んだ制約 | メトロノームの設計対策 |
|---|---|---|
| DC-01 | 設定と履歴は別の保存同意 | 設定/preset、history、校正の保存/削除範囲を分ける |
| DC-02 | Worklet転送protocol互換 | release/engineProtocol/メッセージ版を照合、混在停止 |
| DC-03 | 音高分割は対称窓 | onsetとpitch changeを分け、未来窓由来の実効時刻を保持 |
| DC-04 | 再attackはdip後riseの時間で判断 | 閾値横断時刻/確認時刻を分け、連打/遅いattackを検証 |
| DC-05 | APIも管理者限定 | 実験室UIだけでなくendpoint認可を維持 |
| DC-06 | member birth/triggerで旧owner失効 | 数値memberIDの再利用で旧履歴が復活しない |
| DC-07 | testへ個人履歴を複製しない | 新表も同期除外・fixture合成化 |
| DC-08 | 状態表示をタブ外に | 常時見える再生/入力/保存/割込みの状態 |
| DC-09 | 直近recordingを誤復旧しない | heartbeat/終了理由を保持し他タブの実行を未完と誤認しない |
| DC-10 | 記録環境と解析条件keyを区別 | メモと評価へ影響するtempo/route/calibrationを別管理 |
| DC-11 | 強弱倍音比較の限定条件 | クリック混入検出の音色依存を隠さず確実な分離と呼ばない |
| DC-12 | 未検証の適応窓を無効化 | 新検出法は版付き比較、実機前に精度保証しない |
| DC-13 | 記録が二重化した | programRun/attempt/recordingIDを開始時固定し同期的にその記録だけ閉じる。pause/fermataの収集範囲も固定 |
| DC-14 | quota待ち後の保存で全削除が復活した | 容量検査後かつ同一書込transaction内に削除世代照合。preset/校正も各削除範囲に適用 |
| DC-15 | 新条件で過去区間を再解析した | eventごとtempoMapRevision/meter/group/subdivision/route/calibration/analyzerRevision。変更境界を新attackとして数えない |
| DC-16 | 全削除後のidentityが古い | 409 HISTORY_EPOCH/全削除後再取得。旧outboxを新epochへ付替えない |
| DC-17 | Aの遅い解析完了がBを停止した | attempt snapshot固定。AはAのみ確定、UIはcurrentのみ。supersededは理由付き結果なし。transport操作を禁止 |
| DC-18 | 比較/成長graphが条件を混合した | 加減速/拍子/拍位置/校正別集計。全条件medianは参考に限定 |
| DC-19 | B開始で有効なAの保存/送信が失われた | UI鮮度generationとowner/delete/consentによる保存有効性を分離。別練習開始だけでA保存を失効させない |
| H-010 | 別IDB接続transaction順序はfake-indexeddbのみ | Safari/Chrome2タブで削除・保存競合を実測。BroadcastChannelは通知、最終整合性はtransaction内世代照合 |

【設計目標】複数タブ音声は共通Web Lock、退出/hidden/停止60秒で解放し再操作前に再取得。IDB代替はtabId/heartbeat/世代CASと確認付き引継ぎ、旧出力の停止確認または期限guardを必須にする（詳細設計§4、未検証）。音声leaseの調停と履歴削除の整合性は別の問題である。退出/背景/logoutでtransportとcaptureを失効、音の予約・振動・Wake Lockを解放し、復帰時に自動再生しない。

## 8. 未検証事項と設計の決定事項

【未検証】AudioWorklet試作、全曲/チャンクbuffer比較、GC/DOM描画負荷、30分ドリフト、メモリー勾配、停止後の実音残り、全最大密度、マイク合成信号の新判定器、ライブDB状態、共有ZIP実生成。【未検証（実機が必要）】iOS/iPadOS Safari/PWA、Android通常/省電力、消音/割込み/ロック/Wake Lock、振動、BT/有線/本体、実楽器校正・精度、光/タッチ/アクセシビリティ、2タブ競合。具体的な追記手順案は[実装計画の実機確認表](METRONOME_IMPLEMENTATION_PLAN.md#5-実機チェックリストへの追記案今回は既存文書を変更しない)にまとめた。

| 項目 | 決定事項/残る調整【設計目標】 | 根拠・残る確認 |
|---|---|---|
| 公開範囲 | 管理者実験室開始（確定）、団員公開は別判断 | 画面/route/API/履歴復元認可と実機受入が条件 |
| UIと音声統合 | 独立機能＋共通出力調停、入力Context分離（確定） | マイク不要、同時表示/既存trainerはadapter |
| 音色 | 合成を基準、短サンプル選択肢を設計（確定） | 具体的素材のみ実装時判断。出典/ライセンス/容量/decodeを記録 |
| 履歴/楽曲preset | 履歴初期off、端末/本人accountを本人が選択（確定） | 専用表を設計、設定/端末presetは選択保存、校正端末のみ |
| tempo curve/変更単位 | 秒domain、線形/指数両対応。BPM次拍/拍子次小節を既定 | 即時の意味、表示と予約取消、比較条件を確定 |
| 上限と品質閾値 | BPM/連符比/層/イベント容量、最低n/許容誤差は実測して決定 | 現仕様に数値上限がなく最悪負荷/合格基準を固定できない |
| fermata/cue/指揮 | tap/予備拍任意、数字/合図音、2/3/4/加算群の打点/軌跡編集（確定） | 音声読み上げだけ採否保留 |
| 背景/振動の期待水準 | 前景動作、Wake Lock補助、背景停止。振動は対応端末の補助 | ブラウザー/OSの制限を利用者へ正確に示す |

これらの判断は全機能採用の方針を変えない。制限がある端末では代替表示と明示した対応範囲を用意し、受入結果を版付きで更新する。

【設計目標・確定事項の反映】01aは時間モデル・tempo map・transport/fence・共通出力契約と方式比較、01bは基本/拍子/設定UI・gesture/退出/背景/logout停止と初期実機確認。独立機能、管理者実験室、adapter連携、合成基準、本人選択の端末/account履歴、端末のみ校正を設計前提とする。曲線は秒domainの線形/指数、BPM次拍・拍子次小節を既定に各操作で境界選択。fermataはtapと任意予備拍、cueは数字/合図音（読み上げ保留）、指揮は2/3/4/加算群の打点・軌跡編集、前景基本/背景停止・手動再開、Wake Lock任意、iOS振動は音/光代替。上限/閾値は調整値であり詳細設計の暫定安全上限を使って実測する。旧表の代替案は比較履歴であり決定事項を再び未確定にはしない。

## 改訂履歴

| 日付 | 修正点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | レビュー修正1: 試験IDをMT-01〜MT-20へ統一、チューナーの3桁AT要件とは分離 | MQ-01〜12、MX-17/MX-18 |
| 2026-10-18 | 修正2: PortalMetronomeLib/PortalAudioLib分離、release/Worker/Worklet/登録名非衝突と同一ページ回帰 | MX-06/MX-17/MX-18、MA-09 |
| 2026-10-18 | 修正3: tempoMapの楽譜位置終点を正本、durationSeconds非保存、秒domain線形/指数維持 | MP-02、MO-04、MX-01/MX-02/MX-10 |
| 2026-10-18 | 修正4: 180ms<300msの試験限界、先読み超え停止と取消反応をMT-07/MT-08へ追加、200〜300msは比較候補 | MX-04/MX-05/MX-08、MQ-02/MQ-04/MQ-06 |
| 2026-10-18 | 利用者決定事項反映、01a基盤契約/比較と01b基本UI/ライフサイクル/初期実機へ分割 | MB全件、MS-01〜04、MR-01/MR-02、MU/MX/MQの01開始行、MP/MO/MAの関連契約 |

【設計目標・修正3再訂】400件/秒は再生負荷であり保存観測数には使わない。解析は選択1〜2層の合計16予定拍/秒を開始前検証、記録1800秒で予定28800件＋余剰詳細7200件。推定256B/件と5記録/metadataの算式から端末64MiBを調整値とする。accountは個別観測なし・最大256集計group/1part/256KiB。容量/保持保証ではなく、空き不足/消失/persist拒否を扱う。旧288万件/4GiB案は撤回、詳細正本はデータ設計§5.1。

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
