# メトロノーム 設計対応表 Ver.1.0

作成日: 2026-10-18。[要件追跡表](METRONOME_REQUIREMENTS_MATRIX.md)の97要件を、[基本・詳細設計](METRONOME_DESIGN.md)・[データ/API設計](METRONOME_DATA_API_DESIGN.md)とMT試験へ対応付ける。**これは実装完了表ではない。全実機確認は未実施。** 表の受入は【設計目標】であり試験合格の記録ではない。全機能を最終仕様に含め、phaseは依存順序とする。

01a開始の操作要件はモデル契約を01a、UI/初期実機を01bで完了する。01a→04等はその間の01b/02/03も含む継続範囲。実装時は各行へ別の実装状況表からsource/自動試験/実機/未完を対応付け、設計表を実装済み表に転用しない。数値は[調整値](METRONOME_DESIGN.md#tuning)、全体受入は[試験設計](METRONOME_DESIGN.md#acceptance)。MT-IDの定義は[実装計画§4](METRONOME_IMPLEMENTATION_PLAN.md#4-自動試験は正確な発音と正しい判定を別に検証する)。

<a id="requirements"></a>
## 1. 全97要件の対応

### MB

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MB-01 | BPMを基準音符と組で設定し数値/増減/直接入力できる | [music](METRONOME_DESIGN.md#music) / [transport](METRONOME_DESIGN.md#transport) / [ui](METRONOME_DESIGN.md#ui) | 01a→01b | 上下限/刻み、実機入力。元要件と設計の両条件を満たす  tenths整数正本、十進半端/範囲拒否。| MT-01, MT-02, MT-08 |
| MB-02 | 再生/停止。マイク許可なしでクリック利用、復帰で自動再生しない | [lifecycle](METRONOME_DESIGN.md#lifecycle) / [output](METRONOME_DESIGN.md#output) / [transport](METRONOME_DESIGN.md#transport) | 01b | 初回gesture/消音/割込み。元要件と設計の両条件を満たす | MT-05, MT-10, MT-19 |
| MB-03 | TAPテンポ。正規化timestamp、複数interval、外れ値除外、reset、有効数表示 | [ui](METRONOME_DESIGN.md#ui) / [tuning](METRONOME_DESIGN.md#tuning) | 01b | 4〜8間隔は候補、MAD閾値と実タッチ遅延。元要件と設計の両条件を満たす | MT-01, MT-08, MT-18 |
| MB-04 | 分子/分母で拍子を設定し群と独立に扱う | [music](METRONOME_DESIGN.md#music) / [ui](METRONOME_DESIGN.md#ui) | 01a→01b | 対応分母/上限の安全制約。元要件と設計の両条件を満たす | MT-01, MT-03 |
| MB-05 | 拍の音価をBPM基準/pulse/表示拍感と分離、速度維持換算と速度変更を区別 | [music](METRONOME_DESIGN.md#music) / [tempo](METRONOME_DESIGN.md#tempo) / [transport](METRONOME_DESIGN.md#transport) | 01a→01b | 用語/既定変更操作。元要件と設計の両条件を満たす | MT-01, MT-02, MT-08 |
| MB-06 | group先頭/各pulse/細分のaccentを個別設定、restと独立 | [music](METRONOME_DESIGN.md#music) / [sound](METRONOME_DESIGN.md#sound) | 01a→01b | UI強中弱と小節頭表現。元要件と設計の両条件を満たす | MT-01, MT-03, MT-05 |
| MB-07 | 音色選択。自前合成と短いsampleを比較しライセンス/容量を明記 | [sound](METRONOME_DESIGN.md#sound) / [engine](METRONOME_DESIGN.md#engine) | 01a→01b | 合成基準/短sample選択肢は確定、具体素材/取得元/ライセンスと聴取品質は実装時。元要件と設計の両条件を満たす | MT-04, MT-05, MT-15 |
| MB-08 | master/層別音量、fadeとclip防止。多層でも過大peakを防ぐ | [output](METRONOME_DESIGN.md#output) / [sound](METRONOME_DESIGN.md#sound) | 01a→01b | 音量上限/limiter、実機音割れ。元要件と設計の両条件を満たす | MT-05, MT-08 |
| MB-09 | count-inの小節/拍数、音色、解析開始境界を指定 | [transport](METRONOME_DESIGN.md#transport) / [practice](METRONOME_DESIGN.md#practice) | 01a→01b | 部分小節開始/fermata再開との関係。元要件と設計の両条件を満たす | MT-04, MT-09 |
| MB-10 | 音時計から振り子位置を表示 | [display](METRONOME_DESIGN.md#display) / [ui](METRONOME_DESIGN.md#ui) | 01b | BT/視聴覚同期、reduced-motion。元要件と設計の両条件を満たす | MT-07, MT-18 |
| MB-11 | 対応端末で補助振動、非対応と音/光代替を明示 | [lifecycle](METRONOME_DESIGN.md#lifecycle) / [display](METRONOME_DESIGN.md#display) / [ui](METRONOME_DESIGN.md#ui) | 01b | iOS非対応、Android motor/省電力。元要件と設計の両条件を満たす | MT-10, MT-18 |
| MB-12 | 練習タイマー、終了時安全停止。再生時間/実時間の意味を保存 | [practice](METRONOME_DESIGN.md#practice) / [transport](METRONOME_DESIGN.md#transport) | 01a→01b | pause/fermataを除く既定案。元要件と設計の両条件を満たす | MT-01, MT-09 |
| MB-13 | 端末設定保存と初期化、履歴同意と独立、未知版を上書きしない | [ui](METRONOME_DESIGN.md#ui) / [data:settings](METRONOME_DATA_API_DESIGN.md#settings) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 01b | 保存既定/容量/共有端末説明。元要件と設計の両条件を満たす  小設定16KiB/専用preset IDB、満杯でも他key/認証/再生不変。| MT-13, MT-15 |
| MB-14 | 一時停止/再開は拍位置維持、新原点/count-in、先頭戻しと停止を分ける | [transport](METRONOME_DESIGN.md#transport) | 01a→01b（提案） | 操作の既定、停止残音。元要件と設計の両条件を満たす | MT-08, MT-09 |
### MS

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MS-01 | 単純拍子。meterと小節長/分母音符を保持 | [music](METRONOME_DESIGN.md#music) | 01a | 分子分母上限。元要件と設計の両条件を満たす | MT-01, MT-04 |
| MS-02 | 複合拍子。6/8の付点四分拍と8分拍を別設定として再現 | [music](METRONOME_DESIGN.md#music) / [tempo](METRONOME_DESIGN.md#tempo) | 01a | 付点四分60の小節2秒/8分60の6秒を検査。元要件と設計の両条件を満たす | MT-01, MT-02, MT-04 |
| MS-03 | 加算拍子、2+2+3等任意group、合計=分子の検証 | [music](METRONOME_DESIGN.md#music) / [ui](METRONOME_DESIGN.md#ui) | 01a | 0/負値/過大group拒否。元要件と設計の両条件を満たす | MT-01, MT-03 |
| MS-04 | 拍単位を変更し速度/表示/クリック層を独立維持 | [music](METRONOME_DESIGN.md#music) / [transport](METRONOME_DESIGN.md#transport) | 01a | 音価の変更と拍感変更の説明。元要件と設計の両条件を満たす | MT-01, MT-08 |
| MS-05 | 混合拍子。小節ごとのmeter/groupを保存 | [music](METRONOME_DESIGN.md#music) / [orchestra](METRONOME_DESIGN.md#orchestra) | 02 | 部分小節と反復境界。元要件と設計の両条件を満たす | MT-01, MT-09 |
| MS-06 | 拍子の連続切替、sequence展開、各小節に音色/発音/テンポ参照 | [music](METRONOME_DESIGN.md#music) / [tempo](METRONOME_DESIGN.md#tempo) / [orchestra](METRONOME_DESIGN.md#orchestra) | 02 | 繰返し/展開上限。元要件と設計の両条件を満たす | MT-01, MT-02, MT-09 |
| MS-07 | 再生中の拍子/group変更を次小節既定で確定し音/表示/解析を同時更新 | [transport](METRONOME_DESIGN.md#transport) | 02 | 即時時の部分小節終了規則。元要件と設計の両条件を満たす | MT-08, MT-09 |
### MR

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MR-01 | 32分までの基本細分。BPM基準音価が変わっても全音符位置を正確に保持 | [music](METRONOME_DESIGN.md#music) / [engine](METRONOME_DESIGN.md#engine) | 01a | 最大BPMとの密度予算。元要件と設計の両条件を満たす | MT-01, MT-04, MT-07 |
| MR-02 | 付点音符、付点数を有理倍率で表現 | [music](METRONOME_DESIGN.md#music) | 01a（提案） | 付点数上限、編集表現。元要件と設計の両条件を満たす | MT-01, MT-04 |
| MR-03 | 各種n:m連符。置換する対象音価を明示 | [music](METRONOME_DESIGN.md#music) / [tuning](METRONOME_DESIGN.md#tuning) | 02 | 最大比/入れ子/CPU、32分×n単純解釈を避ける。元要件と設計の両条件を満たす | MT-01, MT-03, MT-04 |
| MR-04 | polyをcycle/pulses/phase独立の層として再生 | [music](METRONOME_DESIGN.md#music) / [engine](METRONOME_DESIGN.md#engine) | 02 | 層数/周期/同時voice上限。元要件と設計の両条件を満たす | MT-03, MT-04, MT-05, MT-07 |
| MR-05 | polyのLCMは表示格子/再合流に使い、巨大格子は層別表示。音を省略しない | [music](METRONOME_DESIGN.md#music) / [ui](METRONOME_DESIGN.md#ui) | 02 | LCM表示上限、分数周期。元要件と設計の両条件を満たす | MT-03, MT-18 |
| MR-06 | swing比A:B、pair両端固定、連符内適用を明示 | [music](METRONOME_DESIGN.md#music) | 02 | 通常2分割のみを既定とする案。元要件と設計の両条件を満たす | MT-03, MT-04 |
| MR-07 | custom rhythmの有理offset/duration/rest/velocity/accent、入力検証 | [music](METRONOME_DESIGN.md#music) / [ui](METRONOME_DESIGN.md#ui) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 02（提案） | 編集操作/展開件数/共有形式。元要件と設計の両条件を満たす | MT-03, MT-04, MT-15 |
| MR-08 | 裏拍offset/mute mask。拍頭の音なしでもスコア位相は維持 | [music](METRONOME_DESIGN.md#music) / [practice](METRONOME_DESIGN.md#practice) | 03 | 0.5拍以外のoffset UI。元要件と設計の両条件を満たす | MT-03, MT-04, MT-09 |
### MP

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MP-01 | 自動tempo up/down。小節/時間/反復境界で段階変更、上下限で終了/反復 | [practice](METRONOME_DESIGN.md#practice) / [transport](METRONOME_DESIGN.md#transport) | 03 | 段階/終了条件のUI。元要件と設計の両条件を満たす | MT-02, MT-08, MT-09 |
| MP-02 | 連続加減速。秒domainの線形/指数BPMを積分し逆関数で発音時刻へ | [tempo](METRONOME_DESIGN.md#tempo) / [practice](METRONOME_DESIGN.md#practice) | 03 | 秒domain線形/指数と楽譜位置終点は確定、最小BPMは調整値。元要件と設計の両条件を満たす | MT-02, MT-04, MT-08 |
| MP-03 | 無音小節でも位相/期待拍/カウントは進め、再発音時に追い付き連打しない | [practice](METRONOME_DESIGN.md#practice) / [transport](METRONOME_DESIGN.md#transport) | 03 | 背景timer/無音時省電力。元要件と設計の両条件を満たす | MT-06, MT-07, MT-09 |
| MP-04 | ランダム無音、単位/確率/seedを保存し再現可能 | [practice](METRONOME_DESIGN.md#practice) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 03 | 小節/音単位の既定。元要件と設計の両条件を満たす | MT-03, MT-09, MT-15 |
| MP-05 | 拍感切替。スコア速度維持で知覚pulse/accentを変更 | [music](METRONOME_DESIGN.md#music) / [practice](METRONOME_DESIGN.md#practice) | 03 | 半/倍/任意層と切替境界。元要件と設計の両条件を満たす | MT-03, MT-08, MT-09 |
| MP-06 | テンポ当て。正解を隠して提示、TAP回答、誤差と有効数を示す | [ui](METRONOME_DESIGN.md#ui) / [practice](METRONOME_DESIGN.md#practice) | 03（提案） | 音提示/無音追従の出題法、回答閾値。元要件と設計の両条件を満たす | MT-01, MT-17, MT-18 |
| MP-07 | 練習programをstep列で保存、tempo/mute/反復/休憩/手動次へを実行 | [practice](METRONOME_DESIGN.md#practice) / [orchestra](METRONOME_DESIGN.md#orchestra) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 03（提案） | step条件/待機/最大長/中断resume。元要件と設計の両条件を満たす | MT-09, MT-11, MT-15 |
| MP-08 | 練習履歴。初期off、本人の端末/account選択、要約と条件を保存 | [practice](METRONOME_DESIGN.md#practice) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) / [data:api](METRONOME_DATA_API_DESIGN.md#api) / [data:schema](METRONOME_DATA_API_DESIGN.md#schema) / [data:capacity](METRONOME_DATA_API_DESIGN.md#capacity) | 03 | 端末/account選択は確定、容量/期限は調整値。元要件と設計の両条件を満たす  再生予算から独立した16予定拍/秒、1800秒・端末詳細36000件/64MiB、accountは要約のみ。| MT-11, MT-13, MT-14 |
| MP-09 | programRun/attempt/recordingIDを開始時固定、一回だけ終了し遅い完了を次試行へ作用させない | [practice](METRONOME_DESIGN.md#practice) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) | 03 | A→B→A解析完了/保存競合。元要件と設計の両条件を満たす | MT-11, MT-12, MT-13 |
### MO

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MO-01 | 長休符を小節/拍でcount、meter変更/反復/seekを越えて位置を保持 | [transport](METRONOME_DESIGN.md#transport) / [orchestra](METRONOME_DESIGN.md#orchestra) | 04 | 残小節表示/途中開始。元要件と設計の両条件を満たす | MT-09 |
| MO-02 | 出番前N拍/小節に数字＋合図音、対応端末振動、重複cueなし | [orchestra](METRONOME_DESIGN.md#orchestra) / [display](METRONOME_DESIGN.md#display) | 04 | 読み上げ採否/言語/予告単位。元要件と設計の両条件を満たす | MT-04, MT-09, MT-18 |
| MO-03 | 指揮pattern。2/3/4拍/加算群の打点と軌跡、音時計同期 | [orchestra](METRONOME_DESIGN.md#orchestra) / [display](METRONOME_DESIGN.md#display) / [ui](METRONOME_DESIGN.md#ui) | 04 | 専門的patternの範囲/編集/動き制限。元要件と設計の両条件を満たす | MT-03, MT-09, MT-18 |
| MO-04 | 楽曲tempo map。小節ID/有理offsetとmeter/音色/mute/curve/cueの列 | [tempo](METRONOME_DESIGN.md#tempo) / [orchestra](METRONOME_DESIGN.md#orchestra) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 04 | 編集/反復/最大展開量。元要件と設計の両条件を満たす | MT-02, MT-09, MT-15 |
| MO-05 | 不定長fermataでwaiting、未来音なし、tap＋選択count-inで新原点再開 | [transport](METRONOME_DESIGN.md#transport) / [orchestra](METRONOME_DESIGN.md#orchestra) | 04 | 再開既定/直前tail/二重発音。元要件と設計の両条件を満たす | MT-08, MT-09, MT-10 |
| MO-06 | metric modulationを旧新音価の秒長等価として方向付き保存 | [tempo](METRONOME_DESIGN.md#tempo) / [transport](METRONOME_DESIGN.md#transport) | 04 | 旧♩=新♪.、四分120→90を検査。元要件と設計の両条件を満たす | MT-02, MT-09 |
| MO-07 | 小節/拍へseek、旧世代予約取消、停止既定/明示再生で位相破綻なし | [tempo](METRONOME_DESIGN.md#tempo) / [transport](METRONOME_DESIGN.md#transport) / [orchestra](METRONOME_DESIGN.md#orchestra) | 04（提案） | count-in/途中小節/反復位置。元要件と設計の両条件を満たす | MT-06, MT-08, MT-09 |
### MA

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MA-01 | 10 ms包絡/実効時刻/epoch等を参照し、attackとpitchChangeを区別してonset検出 | [analysis](METRONOME_DESIGN.md#analysis) | 05 | 実楽器/短hop/flux/帯域検出比較。元要件と設計の両条件を満たす | MT-12, MT-16 |
| MA-02 | タイミング解析は初期排他、同時使用は明示選択/イヤホン申告 | [output](METRONOME_DESIGN.md#output) / [analysis](METRONOME_DESIGN.md#analysis) | 05 | スピーカー/音漏れ/AECの影響。元要件と設計の両条件を満たす | MT-10, MT-16, MT-19 |
| MA-03 | クリック混入を疑う観測に理由を付け、チューナー統計とは別eligibility | [analysis](METRONOME_DESIGN.md#analysis) | 05 | 予定時刻付近一律除外では真の演奏も消える。元要件と設計の両条件を満たす | MT-16, MT-17, MT-19 |
| MA-04 | 出力→空間→入力の往復校正、中央値/分散、route別保存と切替失効 | [analysis](METRONOME_DESIGN.md#analysis) / [display](METRONOME_DESIGN.md#display) / [data:settings](METRONOME_DATA_API_DESIGN.md#settings) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) | 05 | BT/距離/反射/入力遅延、API値二重補正禁止。元要件と設計の両条件を満たす | MT-12, MT-16, MT-17, MT-20 |
| MA-05 | 順序を保つ一対一event対応、先行/遅延msと局所基準拍比率 | [analysis](METRONOME_DESIGN.md#analysis) | 05 | 対応窓/余剰欠落/休符後の拍ずれ。元要件と設計の両条件を満たす 選択1〜2層/合計16予定拍/秒を開始前検証。 | MT-16, MT-17 |
| MA-06 | median/MAD/SDのばらつき、予定IOIに対するtempo安定性を可視化 | [analysis](METRONOME_DESIGN.md#analysis) / [ui](METRONOME_DESIGN.md#ui) | 05 | 加減速を不安定と誤判定しない。元要件と設計の両条件を満たす | MT-12, MT-17, MT-18 |
| MA-07 | 小節/群/pulse位置別、tempoMap/meter/route/calibration/解析版別に傾向集計 | [analysis](METRONOME_DESIGN.md#analysis) / [practice](METRONOME_DESIGN.md#practice) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) | 05 | 全条件混合集計は参考表示。元要件と設計の両条件を満たす | MT-12, MT-17 |
| MA-08 | 有効n/候補N、理由別除外、校正残差/検出信頼性。データ不足は合格保留 | [analysis](METRONOME_DESIGN.md#analysis) / [tuning](METRONOME_DESIGN.md#tuning) / [data:api](METRONOME_DATA_API_DESIGN.md#api) | 05 | 最低n/閾値/楽器別信頼性。音色/奏法の良否を断定しない。元要件と設計の両条件を満たす | MT-16, MT-17, MT-18 |
| MA-09 | チューナー同時表示。入力/出力所有と音量を調停、既存統計除外を維持 | [architecture](METRONOME_DESIGN.md#architecture) / [output](METRONOME_DESIGN.md#output) / [analysis](METRONOME_DESIGN.md#analysis) | 05 | 既存trainer adapter/狭幅/CPU。元要件と設計の両条件を満たす | MT-10, MT-18, MT-19 |
| MA-10 | 合成attack/legato/雑音/混入の正解時刻から誤差とprecision/recallを測定 | [analysis](METRONOME_DESIGN.md#analysis) / [acceptance](METRONOME_DESIGN.md#acceptance) | 05 | 新解析器の実装/計測は未実施。元要件と設計の両条件を満たす | MT-04, MT-16, MT-17 |
| MA-11 | 実楽器群/奏法/音量ごとに校正後誤差・見逃しを確認 | [analysis](METRONOME_DESIGN.md#analysis) / [acceptance](METRONOME_DESIGN.md#acceptance) | 05 | 全実楽器が未試験。元要件と設計の両条件を満たす | MT-16, MT-17 |
### MU

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MU-01 | 基本画面: 大きなtempo/meter/再生停止/音量、日常操作を集約 | [ui](METRONOME_DESIGN.md#ui) | 01b | iPhone片手/狭幅/ズーム。元要件と設計の両条件を満たす | MT-01, MT-08, MT-18 |
| MU-02 | 拍子/リズム編集: 複合/加算、group、accent、細分 | [ui](METRONOME_DESIGN.md#ui) / [music](METRONOME_DESIGN.md#music) | 01b | 任意group入力/誤操作。元要件と設計の両条件を満たす | MT-01, MT-03, MT-18 |
| MU-03 | 高度リズム画面: poly/連符/swing、独立層の位相とLCM表示 | [ui](METRONOME_DESIGN.md#ui) / [music](METRONOME_DESIGN.md#music) | 02 | 高密度/大LCM/表示負荷。元要件と設計の両条件を満たす | MT-03, MT-07, MT-18 |
| MU-04 | 練習画面: tempo変更/無音/拍感/当て/program/履歴への導線 | [ui](METRONOME_DESIGN.md#ui) / [practice](METRONOME_DESIGN.md#practice) | 03 | 設定中と再生中値の明示。元要件と設計の両条件を満たす | MT-09, MT-11, MT-18 |
| MU-05 | 楽曲画面: 小節map/休符/fermata/cue/指揮 | [ui](METRONOME_DESIGN.md#ui) / [orchestra](METRONOME_DESIGN.md#orchestra) | 04 | 小画面編集/seek。元要件と設計の両条件を満たす | MT-09, MT-18 |
| MU-06 | 解析画面: マイク/タイミング評価/結果と信頼性、チューナー同時表示 | [ui](METRONOME_DESIGN.md#ui) / [analysis](METRONOME_DESIGN.md#analysis) | 05 | 狭幅/読上げ/信頼性の誤読。元要件と設計の両条件を満たす | MT-17, MT-18, MT-19 |
| MU-07 | 設定/preset画面: 音色/表示/保存/連携、基本・高度・楽曲の3種 | [ui](METRONOME_DESIGN.md#ui) / [data:settings](METRONOME_DATA_API_DESIGN.md#settings) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) | 01b→05（提案） | account/端末と消去範囲。元要件と設計の両条件を満たす  設定保存/preset IDB/履歴を分離、unknown版保全。| MT-13, MT-15, MT-18 |
| MU-08 | 44 CSS px目標、停止固定、片手/横縦/スクロール/二重touch誤操作防止 | [ui](METRONOME_DESIGN.md#ui) / [lifecycle](METRONOME_DESIGN.md#lifecycle) | 01b→05 | VoiceOver/TalkBack、物理TAP遅延。元要件と設計の両条件を満たす | MT-01, MT-10, MT-18 |
| MU-09 | 光る拍/振り子/指揮は音時計参照、低刺激/静的/reduced-motion、flash制約 | [display](METRONOME_DESIGN.md#display) / [ui](METRONOME_DESIGN.md#ui) | 01b→05 | 最大倍率/全層の輝度・面積・赤/知覚同期。元要件と設計の両条件を満たす | MT-07, MT-18 |
| MU-10 | タブ/設定panelへ詳細を分離し、再生/入力/保存状態は常時可視 | [architecture](METRONOME_DESIGN.md#architecture) / [ui](METRONOME_DESIGN.md#ui) | 01b→05 | 内部tab切替で予期せぬ停止/再開なし。元要件と設計の両条件を満たす | MT-10, MT-18, MT-19 |
### MX

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MX-01 | 全音符有理数score、BPM reference、meter/group/pulse/accent独立、sampleへの最終丸め | [music](METRONOME_DESIGN.md#music) / [tuning](METRONOME_DESIGN.md#tuning) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 01a | 安全整数/展開/数値上限。元要件と設計の両条件を満たす | MT-01, MT-03, MT-04 |
| MX-02 | 位置↔時間の定数/段階/積分逆関数、原点再設定、累積丸めなし | [tempo](METRONOME_DESIGN.md#tempo) | 01a→04 | 曲線endpoint/長時間/seek精度。元要件と設計の両条件を満たす | MT-02, MT-04, MT-09 |
| MX-03 | 不変のeventID/score/audioFrame/条件を音・UI・解析へ配るcompiler | [engine](METRONOME_DESIGN.md#engine) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) / [data:messages](METRONOME_DATA_API_DESIGN.md#messages) | 01a→05 | 最大burst/queue量。元要件と設計の両条件を満たす | MT-03, MT-04, MT-06 |
| MX-04 | 再生中変更のfence、即時/次拍/次小節、同一generation/revision/boundaryで確定 | [transport](METRONOME_DESIGN.md#transport) / [data:messages](METRONOME_DATA_API_DESIGN.md#messages) | 01a→04 | Worklet ack待ち/間に合わない境界の扱い。元要件と設計の両条件を満たす | MT-06, MT-08, MT-09 |
| MX-05 | 期限切れは欠落記録し連打禁止、stopで全予約/振動解除、復帰は手動 | [lifecycle](METRONOME_DESIGN.md#lifecycle) / [engine](METRONOME_DESIGN.md#engine) / [transport](METRONOME_DESIGN.md#transport) | 01a | 既存偽時計で過去7件確認、実音残留未試験。元要件と設計の両条件を満たす | MT-05, MT-06, MT-08, MT-10 |
| MX-06 | 独立機能＋共通音声調停案、入力Context分離、lease/世代、既存排他/明示同時 | [architecture](METRONOME_DESIGN.md#architecture) / [output](METRONOME_DESIGN.md#output) / [data:audio-claim](METRONOME_DATA_API_DESIGN.md#audio-claim) | 01a→05（提案） | 独立機能/共通出力は確定、既存tuner回帰。元要件と設計の両条件を満たす  共通lockのhidden/stop60秒解放、準備中再取得、tuner移行。| MT-05, MT-10, MT-19 |
| MX-07 | outputTimestamp写像、fallback推定、BT/route変更校正失効、音と描画の分離 | [display](METRONOME_DESIGN.md#display) / [analysis](METRONOME_DESIGN.md#analysis) | 01a→05 | latency API精度/視聴覚/入力時計。元要件と設計の両条件を満たす | MT-07, MT-12, MT-16 |
| MX-08 | main/Worker/Worklet/bufferの交換可能backend、有限queue/voiceとclip管理 | [engine](METRONOME_DESIGN.md#engine) / [tuning](METRONOME_DESIGN.md#tuning) / [data:messages](METRONOME_DATA_API_DESIGN.md#messages) | 01a→02 | Worklet未試作、CPU/熱、比較の残条件。元要件と設計の両条件を満たす | MT-04, MT-05, MT-07, MT-08 |
| MX-09 | gesture開始、audioSession状態、Wake Lock任意/拒否表示、hidden/退出/logout停止 | [lifecycle](METRONOME_DESIGN.md#lifecycle) / [output](METRONOME_DESIGN.md#output) / [display](METRONOME_DESIGN.md#display) | 01b | iOS Safari/PWA/消音/着信/省電力。前景基本/背景停止/手動復帰/Wake Lock任意は確定。元要件と設計の両条件を満たす | MT-10, MT-18 |
| MX-10 | schemaVersion/engineProtocol/analysisVersion分離、曲線終点barId/offsetを正本、duration非保存、3種preset JSON、未知版保全/コピー移行 | [music](METRONOME_DESIGN.md#music) / [tempo](METRONOME_DESIGN.md#tempo) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) / [data:presets](METRONOME_DATA_API_DESIGN.md#presets) | 01a→04 | import容量/循環参照/展開上限。元要件と設計の両条件を満たす  tenths整数/範囲と専用preset IDBの保存検証。| MT-02, MT-13, MT-15 |
| MX-11 | 履歴初期off、保存同意/端末/account/未送信破棄/送信済み削除を区別 | [practice](METRONOME_DESIGN.md#practice) / [data:settings](METRONOME_DATA_API_DESIGN.md#settings) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) / [data:api](METRONOME_DATA_API_DESIGN.md#api) | 03→05 | 本人選択は確定、期限は調整値。元要件と設計の両条件を満たす 詳細は端末/要約account、個別観測送信0、256group/1part/256KiB。 | MT-11, MT-13, MT-14, MT-20 |
| MX-12 | owner UUID/組織/member_birth、削除世代、管理者も他人閲覧不可、logout abort | [scope](METRONOME_DESIGN.md#scope) / [practice](METRONOME_DESIGN.md#practice) / [data:local-history](METRONOME_DATA_API_DESIGN.md#local-history) / [data:schema](METRONOME_DATA_API_DESIGN.md#schema) / [data:api](METRONOME_DATA_API_DESIGN.md#api) | 03→05 | 既存identity共通化/削除の機能別範囲。元要件と設計の両条件を満たす  tuner未使用本人の初回owner作成、同時初回/member_birth/認証時刻。| MT-13, MT-14 |
| MX-13 | DB Only、本人account用専用表追加、追加migration/disabled配布/rollback残置、個人履歴test複製禁止 | [scope](METRONOME_DESIGN.md#scope) / [delivery](METRONOME_DESIGN.md#delivery) / [data:schema](METRONOME_DATA_API_DESIGN.md#schema) / [data:migration](METRONOME_DATA_API_DESIGN.md#migration) | 03→05 | 専用表追加は設計前提、現DB版は未照合。前回調査DB操作なし。元要件と設計の両条件を満たす  IF NOT EXISTS/OR REPLACE/DROP TRIGGER後再作成、owner名中立化は将来。 DBはsummary_groupsに限定しraw観測表案撤回。 | MT-13, MT-14, MT-20 |
| MX-14 | capture/transport/attempt/view/owner/save/delete世代分離、event条件snapshot、表示鮮度と保存有効性別 | [transport](METRONOME_DESIGN.md#transport) / [practice](METRONOME_DESIGN.md#practice) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) | 01a→05 | DC-13〜19の競合シナリオ。元要件と設計の両条件を満たす | MT-06, MT-11, MT-12, MT-13 |
| MX-15 | 複数tab音声所有lease、IDB最終transactionの削除世代照合 | [output](METRONOME_DESIGN.md#output) / [practice](METRONOME_DESIGN.md#practice) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) / [data:audio-claim](METRONOME_DATA_API_DESIGN.md#audio-claim) | 01a→05 | Web Locks等選択、H-010はfake-IDBのみ。元要件と設計の両条件を満たす  IDB tabId/heartbeat/確認付き引継ぎ、旧世代/旧出力を失効。| MT-10, MT-13, MT-14, MT-19 |
| MX-16 | 管理者実験室開始、団員公開時route/API/組織/owner認可を一体で受入 | [scope](METRONOME_DESIGN.md#scope) / [lifecycle](METRONOME_DESIGN.md#lifecycle) / [data:api](METRONOME_DATA_API_DESIGN.md#api) | 01b→05（提案） | 管理者開始は確定、団員公開は別受入判断。元要件と設計の両条件を満たす | MT-10, MT-14, MT-19 |
| MX-17 | portalAppState/getAppState/runtimeContext、main.jsと依存manifest/遅延ロード/退出を維持。PortalMetronomeLib/PortalAudioLib/PortalTunerLibを分離し同名ファイルの登録衝突を禁止 | [architecture](METRONOME_DESIGN.md#architecture) / [lifecycle](METRONOME_DESIGN.md#lifecycle) | 01b | 新資産読込み順と既存公開関数回帰。元要件と設計の両条件を満たす | MT-10, MT-19 |
| MX-18 | release IDとWorker/Worklet/shared audio版一致、旧cache/protocol混在停止、m-/a-/t-と機能別Worker/Worklet URL・processor名で衝突回避 | [architecture](METRONOME_DESIGN.md#architecture) / [engine](METRONOME_DESIGN.md#engine) / [data:contract](METRONOME_DATA_API_DESIGN.md#contract) / [data:messages](METRONOME_DATA_API_DESIGN.md#messages) | 01a→05 | 共通資産を両consumer hash対象に含める。元要件と設計の両条件を満たす | MT-06, MT-19, MT-20 |
| MX-19 | 録音/PCM/全FFTを製品保存・送信しない。秘密/内部保存先を団員画面へ出さない | [analysis](METRONOME_DESIGN.md#analysis) / [scope](METRONOME_DESIGN.md#scope) / [data:settings](METRONOME_DATA_API_DESIGN.md#settings) / [data:api](METRONOME_DATA_API_DESIGN.md#api) | 01b→05 | 実装時のpayload/log/ZIP検査。元要件と設計の両条件を満たす | MT-16, MT-20 |
### MQ

| ID | 要件 | 設計参照 | フェーズ | 受入の重点 | MT試験 |
|---|---|---|---|---|---|
| MQ-01 | Offline波形をsample単位で照合、純粋compiler/偽時計と実時間を分ける | [engine](METRONOME_DESIGN.md#engine) / [acceptance](METRONOME_DESIGN.md#acceptance) | 01a→05 | 前回調査499/499誤差0、曲線/全音色/新engineは未試験。元要件と設計の両条件を満たす | MT-01, MT-02, MT-04, MT-06 |
| MQ-02 | 最大BPM×32分×連符置換比×層の負荷を算定、平均/最悪burst/p95/p99/max/欠落を計測 | [engine](METRONOME_DESIGN.md#engine) / [tuning](METRONOME_DESIGN.md#tuning) / [acceptance](METRONOME_DESIGN.md#acceptance) | 01a→05 | 数値は調整値、先読み超え停止MT-07と取消反応MT-08で選定。300ms結果は採用根拠にしない。元要件と設計の両条件を満たす | MT-03, MT-05, MT-07, MT-08 |
| MQ-03 | 同時peak/clip/fade、長時間source参照/queueが有界 | [output](METRONOME_DESIGN.md#output) / [engine](METRONOME_DESIGN.md#engine) / [sound](METRONOME_DESIGN.md#sound) / [data:capacity](METRONOME_DATA_API_DESIGN.md#capacity) | 01a→05 | 現playback長時間ヒープ実測なし。元要件と設計の両条件を満たす 256B推定/5記録/64MiBをMT-13で実測し、origin共有容量/消失を検証。 | MT-05, MT-07 |
| MQ-04 | main busy/GC/DOM/hidden、30分drift/メモリー/熱/電池を別測定し表示が音を駆動しない | [display](METRONOME_DESIGN.md#display) / [engine](METRONOME_DESIGN.md#engine) / [acceptance](METRONOME_DESIGN.md#acceptance) | 01a→05 | busy以外・長時間/電池未測定。元要件と設計の両条件を満たす | MT-07, MT-08 |
| MQ-05 | iOS Safari/PWA、Android、PCの版/経路/省電力ごとに実音精度と停止復帰を記録 | [lifecycle](METRONOME_DESIGN.md#lifecycle) / [acceptance](METRONOME_DESIGN.md#acceptance) / [delivery](METRONOME_DESIGN.md#delivery) | 01b→05 | 前回調査headless Windowsのみ。元要件と設計の両条件を満たす | MT-07, MT-08, MT-10, MT-18 |
| MQ-06 | 明示変更/pause/seek/fermata/非同期A→B/2tab/delete/logoutの競合回帰 | [transport](METRONOME_DESIGN.md#transport) / [practice](METRONOME_DESIGN.md#practice) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) / [data:tests](METRONOME_DATA_API_DESIGN.md#tests) / [data:audio-claim](METRONOME_DATA_API_DESIGN.md#audio-claim) | 01a→05 | Worklet/IDB実機順序、H-010。元要件と設計の両条件を満たす  旧tab復帰・期限guardと準備中、MD-17/19。| MT-06, MT-08, MT-09, MT-10, MT-11, MT-13, MT-19 |
| MQ-07 | WCAG2.3.1のflash数/輝度/面積/赤、最大倍率と全層、低刺激/静的表示 | [ui](METRONOME_DESIGN.md#ui) | 01b→05 | flash解析/実機アクセシビリティ未試験。元要件と設計の両条件を満たす | MT-18 |
| MQ-08 | 既存tunerのDC-01〜19/H-010/未完を追跡し完了扱いしない | [practice](METRONOME_DESIGN.md#practice) / [remaining](METRONOME_DESIGN.md#remaining) / [data:delete](METRONOME_DATA_API_DESIGN.md#delete) / [data:tests](METRONOME_DATA_API_DESIGN.md#tests) | 01a→05 | 詳細対策は実現性調査§7、H-010残。元要件と設計の両条件を満たす | MT-11, MT-12, MT-13, MT-19 |
| MQ-09 | DB Only/通常CI/release安全/共有ZIP除外を維持、試作は.tmp/OS temp | [scope](METRONOME_DESIGN.md#scope) / [delivery](METRONOME_DESIGN.md#delivery) / [data:migration](METRONOME_DATA_API_DESIGN.md#migration) / [data:tests](METRONOME_DATA_API_DESIGN.md#tests) | 01a→05 | 前回調査ZIP実生成なし、既存allowlistをコード確認。元要件と設計の両条件を満たす | MT-14, MT-19, MT-20 |
| MQ-10 | 外部仕様は一次資料/対象版/確認日、結論を確認済/推定/目標/未検証で表示 | [scope](METRONOME_DESIGN.md#scope) / [display](METRONOME_DESIGN.md#display) / [remaining](METRONOME_DESIGN.md#remaining) | 調査→全期 | 実現性調査§4、2026-10-18確認。端末実装と区別。元要件と設計の両条件を満たす | MT-20 |
| MQ-11 | 指定3文書、UTF-8 BOMなし/LF/末尾空白なし。Git既存変更保持、コミット等なし | [scope](METRONOME_DESIGN.md#scope) / [remaining](METRONOME_DESIGN.md#remaining) / [data:tests](METRONOME_DATA_API_DESIGN.md#tests) | 今回調査 | 最終Git状態はチャット報告。元要件と設計の両条件を満たす | MT-20 |
| MQ-12 | MANUAL_DEVICE_QA_CHECKLISTへの追記案を新文書内に記載し既存文書は変更しない | [acceptance](METRONOME_DESIGN.md#acceptance) / [remaining](METRONOME_DESIGN.md#remaining) | 今回調査 | 実装計画§5。実機結果欄は未実施。元要件と設計の両条件を満たす | MT-07, MT-10, MT-13, MT-16, MT-18 |

<a id="changes"></a>
## 2. 調査3文書からの変更

| 変更ID | 指示と反映箇所 | 影響要件/試験 |
|---|---|---|
| MD-REV-01 | 調査計画の試験接頭辞をMT-01〜MT-20へ変更、全参照置換。チューナー3桁AT要件は変更しない | MQ全件、MT全件 |
| MD-REV-02 | PortalMetronomeLib/PortalAudioLib/PortalTunerLib、m-/a-/t-、機能別Worker/Worklet URL/processor登録名を分離。[構成](METRONOME_DESIGN.md#architecture)と両機能同一ページ回帰 | MX-17/MX-18、MA-09、MT-19 |
| MD-REV-03 | tempoMap終点をbarId/有理offset正本、duration非保存。秒domain線形/指数は維持しUからDを導出。[tempo](METRONOME_DESIGN.md#tempo)、[preset](METRONOME_DATA_API_DESIGN.md#presets) | MP-02、MO-04、MX-01/02/10、MT-02/15 |
| MD-REV-04 | 180ms<300ms試験の限界、200〜300msは比較候補。H超えstallとH拡大時の予約取消/stop/即時変更/pause反応 | MX-04/05/08、MQ-02/04/06、MT-07/08 |
| MD-REV-05 | 01a契約/方式比較と01b基本UI/ライフサイクル/初期実機へ分割。旧01機能を落とさず表のphaseを更新 | 01開始の全行、[phase完了条件](METRONOME_DESIGN.md#delivery) |
| MD-REV-06 | 利用者確定: 管理者実験室、独立機能/共通出力/入力分離、合成基準/短sample選択肢、本人保存選択/account専用表、校正端末のみ、秒domain曲線/既定境界、fermata/cue/指揮、前景/補助機能 | MB/MS/MR/MP/MO/MA/MU/MX/MQ関連全行 |
| MD-REV-07 | 詳細化: 機能別epoch推奨、旧attempt固定tokenと同一IDB transaction、owner失効時新表削除trigger。実ブラウザー確認までH-010未完 | MP-09、MX-11〜15、MQ-06/08、MT-11/13/14 |

上記は設計変更の根拠を残す欄であり追加機能の取捨選択ではない。調査3文書の末尾にも2026-10-18の改訂履歴を付けた。仕様の用語/動作は詳細設計を正本とする。旧調査の比較案や過去試験の条件を削除して結果を良く見せない。

<a id="implementation-changes"></a>
## 3. 実装時の変更・未完の記録欄

第2回（2026-10-18）でIC-01〜08を1件ずつ確定済み判断と照合し直した。一括承認はしない。状態は「確定（理由・試験あり）」「撤回」「判断待ち」のいずれか。区分の表記: 自動試験＝純粋関数・模擬時計・fake-indexeddb・使い捨てDB、Chromium＝headless Chromiumの実ブラウザー、実機＝未実施。

| 変更ID | 変更/理由 | 確定済み判断との照合 | 影響要件 | 代替案 | 証拠 | 状態 |
|---|---|---|---|---|---|---|
| IC-01 | 高度なリズムで層なし（`layers: []`）をスウィング指定時だけ許可（拍子のクリックだけのスウィング） | 全機能採用を維持し、型の範囲を広げるだけ | MR-06、MS-07 | 無音の層（層数と密度を無駄に使うため不採用） | `test_metronome_phases` | 確定 |
| IC-02 | 基本プリセットと小節に `subdivision {unit, tuplet {n,m}, dots}` を追加 | 細分・連符・付点の基準音価を明示する設計5章に合う | MB-05、MR-01〜03 | 層で細分を表す（基本画面が複雑になるため不採用） | `test_metronome_model` | 確定 |
| IC-03 | 練習ステップに任意の `startBpmTenths`（整数tenths）。テンポ当ての出題範囲は `tempoStep` の最低・最高、未指定は60〜160 | bpmTenths整数の正本を守る。出題範囲を段階テンポの値で兼ねるのは暫定 | MP-01/06/07 | 専用の出題範囲field（schema改訂で追加する候補） | `test_metronome_phases` | 確定（出題範囲のfield分離は次のschema版で再検討） |
| IC-04 | 記録の保存方法はメモリーだけに持ち、画面を開くたびに「保存しない」から始める | 履歴初期off・本人選択に合う | MP-08、MU-07 | 設定keyへの保存（共有端末で意図せず保存が続くため不採用） | `test_metronome_history` | 確定 |
| IC-05 | （撤回）30分超の練習記録を端末だけに保存 | 確定済みの1800秒記録枠と矛盾 | MP-08、MX-11/13 | — | — | **撤回**。練習・解析とも1800秒で記録を閉じ、続きは本人操作で新記録（R-09） |
| IC-06 | owner初期化はメトロノーム側だけ `members FOR UPDATE → tuner_owners`、同時初回の一意違反は最大3回再試行 | データ設計7.1のロック順どおり。既存チューナーの経路は変えない | MX-12/13、MT-14 | チューナーの経路も変更（別作業） | `test_metronome_practice_postgres`（使い捨てDB） | 確定 |
| IC-07 | compiler Worker・解析Workerは作らない | R-01で対応付けをO(N+M)に有界化し、28800拍＋余剰86400件が3秒未満。Chromiumの実時間計測で主スレッド停止がない限り遅刻0件 | MX-08、MQ-02/04 | Worker化（実機で主スレッド原因の遅刻が出たら再検討） | `test_metronome_review_fixes`、`metronome_backends.spec.js` | 確定（実機のMT-07で見直し） |
| IC-08 | 「止めるまで」の繰り返しの後ろへの小節追加は画面で拒否、拒否された編集は直前の有効な楽曲へ戻す | 編集の正本を壊さない | MO-04、MS-06 | — | `tests/e2e/metronome.spec.js` | 確定 |
| IC-09 | IDB音声claimは1つのstore（`claim`）にclaim記録・単調counter・停止ackを別keyで置く（データ設計3.1の2 store案を1 storeに） | 同じreadwrite transactionでCAS・counter・ackを扱う要件は同じ | MX-15、MQ-06 | 2 store（同じ保証で構成だけ複雑） | `test_metronome_engine_contracts`、`metronome_two_tabs.spec.js` | 確定 |
| IC-10 | 端末の詳細行を256件ごとの列形式＋文字列辞書で保存 | 設計の「辞書の整数参照」「256件ずつ」を具体化。1件約74 B（見積り）で64 MiBの5記録想定に収まる | MP-08、MA-05〜08、MX-11 | 1件1行（見積り約512 B/件で5記録に入らない） | `test_metronome_review_storage` | 確定（実容量はMT-13の実ブラウザーで要確認） |
| IC-11 | 2つの解析対象層の10 ms以内の予定拍は1つの複合拍（層キー `l1+meter`） | 同一観測の重複利用禁止（設計14章）を守るため | MA-05/07 | 層ごとに別々に対応付け（1つの発音を2回使うため不採用） | `test_metronome_review_fixes` | 確定 |
| IC-12 | 256集計群を超えたら、同じ条件・層の中で拍位置を統合（`merged-beats`）、なお超えればアカウント要約を保留して理由を表示（端末は全群） | 上限256を維持し、異条件を混ぜない。黙って切り捨てない | MA-07、MX-13、MP-08 | 記録の分割（同じ試行が複数記録になり結果確認が複雑）、条件の統合（異条件の混合のため不採用） | `test_metronome_review_fixes` | 確定 |
| IC-13 | 解析対象16件/秒の評価は、コンパイル済みのexpectedイベント列で、解析開始位置から1800秒（周期的なら1周期＋1秒）の任意の半開1秒窓の最大件数 | 設計5.1.1「任意の半開1秒窓」を実装の方法として固定 | MA-01/05、MP-08、MX-11 | 平均頻度（密集区間を見逃すため不採用） | `test_metronome_review_fixes` | 確定 |
| IC-14 | （第3回で改訂）試行開始時に削除カウンター（`deleteSeq`）をその場で作ったIndexedDB transactionで読み（ticket）、ticketの後に削除された所有者の試行のトークン確定を拒否。時計は比べない。DB未openで順序が決まらないticketは、先に鳴らす練習では使わない。第2回の削除時刻（lastDeleteAtUtc）の比較は撤回（同一ミリ秒・時計の巻き戻しで誤るため） | 開始時固定token（データ設計6.1）の「収集開始前」を、音を先に鳴らす練習でも守るため | MP-08/09、MX-14/15 | 削除時刻の比較（撤回）、練習でもトークン確定まで再生を待つ（iOSのgesture内開始と両立しないため不採用） | `test_metronome_review_round3`、`test_metronome_review_storage`、`metronome_two_tabs.spec.js` | 確定（Safariの別タブ順序はMD-17で未確認） |
| IC-15 | 出力permitは所有権の確認ごとに発行（Web Lockは保持の確認、IDBは記録の更新commit後）、壁時計期限2秒・更新500 ms、lease単位のguard（全leaseが検証済みの時だけverified） | 引継ぎ時の停止ack／期限付きguardの判断（データ設計3.1）を具体化 | MX-06/15、MQ-06 | 固定時間の待ち（不採用） | `test_metronome_engine_contracts`、Chromium 2タブ | 確定 |
| IC-16 | チューナーの基準音は共通出力管理のleaseで鳴らし、停止後はContextを閉じずに60秒の無操作または全consumerの退出で閉じる | 設計4.1の移行。音量は従来の絶対値と同じ（0.25上限を緩めない） | MX-06、MQ-08、MA-09 | 従来の独自Context（同一ページで所有者が2つになるため不採用） | `test_tuner_shared_output`、チューナーE2E | 確定 |
| IC-17 | チューナーの「メトロノーム」課題は、メトロノームのエンジンが読み込まれていれば新エンジン、未読込なら従来のタイマー経路 | 二重クリックを作らない（同時に1つだけ）。旧経路は読込失敗時の予備 | MA-09、MX-17 | 新エンジンの読込を必須にする（読込失敗で課題が使えなくなるため不採用） | `test_tuner_shared_output` | 確定（旧経路の削除は実機確認後に判断） |
| IC-18 | 保存済み校正は経路キー（経路・sampleRate・OS・ブラウザー主版・入力機器名のhash）、解析版、30日以内が一致する「候補」で、本人の確認で有効 | 校正端末のみ・route変更で失効の確定事項を守る | MA-04、MX-14 | 一致すれば自動で有効（経路の取り違えを防げないため不採用） | `view_analysis`、`test_metronome_review_fixes` | 確定（30日は調整値） |
| IC-19 | 短buffer方式は0.5秒chunk。再生中のchunk内の取消はchunkのgainを取消位置で閉じる（その前の音の尾も切れる） | 設計7章の「old gainを閉じ新chunkへ」 | MX-08、MQ-01 | chunkの再生成（再生中のbufferは変更できない） | `metronome_backends.spec.js` | 確定（比較用。採用方式ではない） |
| IC-20 | 編集は受付時の再生世代に属し、停止・再開始で待機中の編集を実行しない（第3回No.1） | fence（準備→ack→確定）の正本を、古い操作が新しい再生へ持ち込まれないように補う | MX-04、MS-07、MQ-06 | 待機中の編集を新しい再生へ移す（利用者が見ていない変更が鳴るため不採用） | `test_metronome_review_round3` | 確定 |
| IC-21 | 停止ackは全consumerの停止とContextの `suspend()` 完了の後だけ書く。喪失時はmasterを即0、確認できなければackなし（第3回No.4） | 停止ack／期限付きguardの確定判断を、「通知」ではなく「停止の完了」で満たす | MX-06、MX-15、MQ-06 | 通知直後のack（停止前に新タブが鳴り得るため不採用）、固定時間の待ち（不採用） | `test_metronome_review_round3`、`metronome_two_tabs.spec.js` | 確定（実音の二重発音はMD-17/19で未確認） |
| IC-22 | 端末保存とアカウント送信の有効性を分け、送信は最終行の直前に再判定、同意変更の応答待ち中は登録・同期をしない（第3回No.2） | アカウントは本人の同意がある要約だけ、の確定事項を書込の途中でも守る | MP-08、MX-11、MX-13 | 保存開始時の1回判定（撤回中に送信が始まるため不採用） | `test_metronome_review_round3` | 確定 |
| IC-23 | 解析対象頻度の検査範囲は、表示格子の大きさと無関係にパターンの周期（表せなければ1800秒）（第3回No.5） | IC-13の「任意の半開1秒窓」を長周期でも欠けなく適用する | MA-01、MA-05、MP-08 | 64小節の打切り（長周期の密集を見逃すため不採用） | `test_metronome_review_round3` | 確定 |
| IC-24 | 先読みした予定拍は、fenceの確定・一時停止・解析の終了で、鳴らない分を撤回（未確定の拍だけ）（第3回No.6） | 予定拍は実際に鳴らしたイベントと同じ、の原則（設計14章）を先読み区間にも適用 | MA-05、MA-07、MX-04 | 先読みをやめる（遅いtickで拍を取りこぼすため不採用） | `test_metronome_review_round3`、レビュー側の画面再現 | 確定 |
| IC-25 | 出力の同時使用は、チューナーの「同時に使う」＋「イヤホン」の明示選択だけが許可し、退出で解除、解除時は最も古いlease以外を停止。同時表示中のクリックは外部出力として、チューナーの測定中は常に統計から除外（第3回No.8） | 共通出力の既定は1 consumer、同時使用は本人の明示選択（設計4.1）。マイク入力は分離のまま | MA-09、MX-06、MX-17 | メトロノーム側に別の同時使用スイッチ（選択が2か所になるため不採用） | `test_metronome_review_round3`、`test_tuner_workspace` | 確定（混入の実測はMD-13で未確認） |

| 未完ID | 内容 | 影響要件/次の確認 | 状態 |
|---|---|---|---|
| M-OPEN-01 | 先読み・guard・停止反応の採用値、方式の採用 | MX-04/05/08、MQ-02/04、MT-07/08 | Chromiumの比較値あり（[実装状況4章](METRONOME_IMPLEMENTATION_STATUS.md)）、実機未確認 |
| M-OPEN-02 | H-010と音声の引継ぎ・二重発音 | MP-09、MX-11/12/15、MT-13/14、MD-17/19 | 自動試験済み・Chromium 2タブ確認済み（新タブの時計を20秒進め旧タブを6秒止める条件、削除順序は別connection）。実際の15秒失効待ち・音の重複の計測、Safari・実機は未確認 |
| M-OPEN-03 | onset/往復校正/実楽器/合格閾値 | MA全件、MT-16/17、MD-14/15 | 合成信号で自動試験済み、実機未確認、合格表示off |
| M-OPEN-04 | limits-v0と音色素材/対応版 | MB-07、MR-03/04、MQ-02/05 | 調整値のまま、短sample素材は未選定 |
| M-OPEN-05 | 全端末/30分/光/割込み/電池/音声2タブ | MQ-03〜07、全MD | 実機未確認（MD-01〜19は全項目未実施） |
| M-OPEN-06 | 専用DDL/API/失効trigger/rollback | MX-12/13、MT-14/20 | 019・API実装済み、使い捨てDBで確認済み。共有テスト環境/本番DBは未適用（[実装状況](METRONOME_IMPLEMENTATION_STATUS.md)のM-OPEN-10） |
| M-OPEN-07 | 団員公開/出番読み上げ | MX-16、MO-02 | 公開は別判断、読み上げ採否保留 |
| M-OPEN-08 | チューナー同時表示・旧trainer課題のadapter・チューナー再生の共通出力移行 | MA-09、MU-06、MX-17/18、MT-19 | 実装済み・自動試験済み（第2回）。クリックの除外通知と同時使用の明示選択を接続（第3回、IC-25）。同時使用と混入の実機確認（MD-13）は未実施 |
| M-OPEN-09 | アカウントpresetの画面、指揮打点の個別編集画面 | MB-13、MO-03 | 実装済み・自動試験済み（第2回）。実アカウント・iPhone操作は実機未確認 |
| M-OPEN-11 | 端末容量の実測（索引込み・5記録・eviction・永続化拒否） | MP-08、MX-11、MT-13 | 見積り式とfake-indexeddbだけ、実ブラウザー未計測 |

MT試験は自動試験計画、MD-01〜19は[既存チェックリスト](MANUAL_DEVICE_QA_CHECKLIST.md)の7-12（全項目未実施）。未完を他の機能の成功で消さない。headless Chromiumの合格をSafari／iOS／Android／実機の合格へ読み替えない。

## 改訂履歴

| 日付 | 変更 | 影響 |
|---|---|---|
| 2026-10-18 | 初版。97要件の設計/phase/MT対応、レビュー4点・確定事項・01a/01b・未完を追跡 | 全97要件 |

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

### 2026-10-18 第2回（レビュー指摘R-01〜R-09と未完機能A〜D）

| 日付 | 変更 | 影響要件ID |
|---|---|---|
| 2026-10-18 | 3章を再点検。IC-05を撤回（1800秒記録枠に統一）、IC-03・IC-07を証拠付きで更新、IC-09〜IC-19を追加。M-OPEN-08/09を実装済みへ、M-OPEN-11を追加 | MP-08、MA-01/04/05/07、MX-06/08/11/14/15、MQ-01/06/08 |

### 2026-10-18 第3回（再レビューの指摘10件）

| 日付 | 変更 | 影響要件ID |
|---|---|---|
| 2026-10-18 | IC-14を改訂（削除時刻の比較を撤回し、IndexedDBのtransaction順序によるticketへ） | MP-08/09、MX-14/15 |
| 2026-10-18 | IC-20〜25を追加（編集の世代、停止完了後のack、送信可否の分離、周期による検査範囲、先読み拍の撤回、明示的な同時使用と外部出力の除外） | MX-04、MX-06、MX-15、MS-07、MQ-06、MP-08、MX-11、MX-13、MA-01、MA-05、MA-07、MA-09、MX-17 |
| 2026-10-18 | 修正のみ（判断の変更なし）: IDB取得の取消世代、再削除の差分計上、一括解析APIの逐次処理 | MX-15、MP-08、MA-05 |

確定済み判断（管理者実験室のみ、マイク分離、基本クリックはマイク不要、名前空間の分離、bpmTenths整数、履歴初期off、校正は端末のみ、アカウントは要約のみ、停止ack／期限付きguard、調整値）は変更していない。団員公開・出番の読み上げ・合格閾値は決めていない。

### 2026-10-18 再開確認

| 日付 | 修正点 | 影響要件ID・試験 |
|---|---|---|
| 2026-10-18 | 第3回の10件の修正を再確認。一括解析で対応窓右端の発音を確定前に取り込む順序を補正。同時刻候補の曖昧性も維持（追加2試験は修正前失敗・修正後合格） | MA-05〜08、MQ-02、MT-16/17、test_metronome_review_round3 |
| 2026-10-18 | データ/API設計6.1の本文をIC-14のticket/deleteSeq方式に整合。採用済み判断・調整値の変更はなし | MP-08/09、MX-14/15 |

97要件は維持。Safari・実機・実音・実容量と公開前の未完事項は実装状況のM-OPENおよびMDで引き続き追跡する。
