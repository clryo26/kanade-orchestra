# メトロノーム データ・API設計 Ver.1.0

作成日: 2026-10-18。[基本・詳細設計](METRONOME_DESIGN.md)の通信・永続化契約。[97要件対応](METRONOME_DESIGN_TRACEABILITY.md)を併読する。これは設計案であり、API/DB/マイグレーションファイルを実装・適用した状態ではない。全節は別記がなければ【設計目標】、数値制限は[調整値表](METRONOME_DESIGN.md#tuning)のlimits-v0である。実機確認は未実施。

<a id="contract"></a>
## 1. 版・共通型・時計

| 識別子 | 初期案と意味 |
|---|---|
| designVersion | 1.0。設計の版 |
| releaseId/sharedReleaseId | m-hash12/a-hash12。t-hash12を別に維持、配信混在を拒否 |
| protocolVersion | metronome=1、sharedAudioProtocol=1。tuner protocolと別空間 |
| schemaVersion | preset/history/API=1、IDB versionとは独立。未知版を上書きしない |
| compilerVersion/analyzerVersion/statsVersion/randomAlgorithmVersion | 再現・比較の演算規則の版。releaseだけで代用しない |
| limitProfile | limits-v0。容量/数値/調整値の適用版、実験変更を履歴に残す |

`Rational={n:int,d:int}` はgcd=1,d>0、値と演算中間値に安全整数検査。`Position={barId:UUID,offset:Rational}`、bar末尾offsetは正規化しterminalだけ保持。UUIDは例の表示ラベルと異なり実際はRFC形式のランダムUUID、IDを個人情報にしない。日時はUTCのISO8601、経過は音声frameまたはperformance基準、Date.nowを拍時計にしない。

`Event`必須: eventId（決定的な文字列）、occurrenceId、score、layerId、outputFrame（非負safe integer）、durationFrames、accentLevel(group/pulse/subdivision)、soundId、velocity(0..1)、expected(bool)、emit(bool)、conditionKey。条件はscore/tempoMap/meter/pulse/analysis版を不変snapshot化。停止/seekでoutput原点とgenerationを変え、eventIdにgenerationを含めた配信keyで重複抑止する。

capture effectiveFrame2は半sampleを整数で保持し、captureEpoch/sampleRate/baseFrameと対応performance点/不確実性を持つ。outputEpochはContext/sampleRate/route変更で更新。input/outputの時計対応が失効した結果を合格へ使わない。校正offset/profileは端末内だけ、APIへ渡さない。

<a id="messages"></a>
## 2. main ⇔ compiler Worker ⇔ click Worklet

mainはtransportとleaseの唯一の制御者。compiler Workerは譜面/時刻計算、Workletはframe配置と合成/短sample読取りのみ。入力解析Workerと別にし、PCMをこの経路へ送らない。SharedArrayBuffer/COOP/COEPは必須にしない。Worklet内は固定容量配列とcursorを使う。

全envelopeは `namespace:"portal.metronome"`, protocolVersion,releaseId,sharedReleaseId,outputEpoch,leaseId,leaseGeneration,transportGeneration,scoreRevision,ownerTabId,claimGeneration,messageSeq,requestId,type,payload。init前の各世代値は明示nullに限る。応答はrequestId/seq/全世代をechoする。WindowのnamespaceとWorker自身のscopeは混同しない。

| 経路/type | payloadと応答 | 適用/失敗 |
|---|---|---|
| main→Worker/Worklet `init` | sampleRate,capacity,limitProfile,outputOriginFrame,ポート、sound catalog。`ready`は実受入容量/版 | 不一致はVERSION_MISMATCH、音声を開始せず終了 |
| main→Worker `compile` | snapshot,range[start,end),origin,conditionSnapshot。`compiled`にevent count/hash/frame range | 最大1実行+1最新pending、置換された要求はsuperseded応答。旧世代は生成中でも破棄 |
| Worker→main `compiled` | transfer専用コピーのevent数値列+ID辞書 | live storeのbufferをdetachしない。frame順/容量をmainも検証 |
| main→Worklet `append` | batchSeq,frame range,event列,contentHash | `accepted`にbatchSeq/queuedThroughFrame/freeSlots。部分受入禁止、同seq同hashは冪等、異hashはBATCH_CONFLICT |
| main→backend `prepareFence` | operationId,old/newRevision,candidateFrame,newPlan | `prepared`に最早可能frame/締切、staging容量。旧列はまだ有効 |
| main→backend `commitFence` | operationId,確定frame,new batch hash | 締切前にatomic切替、`applied`にactualFrame/newRevision。締切超えFENCE_MISSED、旧列継続、次境界を再提案 |
| main→backend `abortFence` | operationId | staging破棄、旧列保持。commit済みならalreadyAppliedとactualFrameを返す |
| main→backend `cancelFrom` | frame,generation,reason | 未来event/tail gateを取消、`cancelled`に最終render frame/未取消sample範囲。stopは次行優先 |
| main→backend `stop` | newGeneration,reason | generationを即失効、queue/stagingクリア、gate閉鎖。`stopped`を返しlease終了。過去のappendは復活不可 |
| main→共有gate/Worklet `renewPermit` | ownerTabId,claimGeneration,permitSeq,validUntilFrame,expiresAtUtcMs（DB照合/commit後） | 全backendがgateを通る。世代/期限/時計guard不一致でlatched-muted、古い更新で延長不可。詳細§3.1 |
| Worklet→main `telemetry` | renderedThroughFrame,missing/late/underrun,queue count,applied revision | 最大10Hz候補、毎sample通知しない。主スレッドが遅れても音の時計にしない |
| main→統計Worker `analyze` | attemptId,requestId,condition snapshot,専用観測コピー | `result`に同じID/版と品質。UI鮮度と保存の有効性を別に判断 |
| 任意→main `error` | code,requestId,世代、非機密なdetail enum | staleは無視、それ以外は必要なら中断。PCM/機器ID/内部URLをログしない |

メッセージは同一port内seq単調、別port間の順序を仮定しない。mainがcompile→検証→appendを順序制御する。ready/ackのtimeout1秒、compile batch4096event、processor telemetry10Hz、queue4096は調整値。timeout時は無限再送せずleaseを止めinterrupted。停止要求はFIFOの大量appendより優先できる量へbatch制限し、stop/cancelに世代を付ける。postMessageが処理される前の音を取り消せるとは保証しない。

main backend/短chunkも上表と同じack型を返し、source集合の取消後だけappliedを返す。new eventを先に二重予約してからoldを消す順を避け、fenceより前のrender済み領域は変更禁止。異backendの切替は原則停止状態でのみ行い、課題中に暗黙fallbackしない。

<a id="settings"></a>
## 3. 端末設定・校正・保存選択

| 保存先/key | 型と選択 | 消去/版 |
|---|---|---|
| localStorage `portalMetronomeSettings` | UTF-8 JSON16KiB上限（調整値）、schemaVersion1,persistSettings:true,revision,ui/sound/tempo既定。明示「この端末に設定を保存」で初めて書く | offにしたら当該key削除、現在メモリー設定は維持。未知版はread-only/上書き不可 |
| IDB `portalMetronomePresets`, version1 | `presets` store key=[id,revision]、schemaVersion1,persistPresets:true、3種preset envelope。明示保存時だけopen/write、履歴DBとは独立 | 60件/各256KiB/合計2MiB（調整値）、参照/版/容量を同transactionで検証。未知版read-only、上書きしない |
| IDB `portalMetronomeCalibration`, version1, `profiles` | key=アプリ発行routeKey、offset/residual/method/sampleRate/解析版/日時/機器条件。校正時に端末保存を明示選択 | 端末のみ、history保存offでも別同意で利用可能。deviceIdは必要ならメモリーのみ。unknown upgradeは保全 |
| IDB `portalMetronomeHistory`, version1 | 本人識別・履歴保存の選択後のみopen。次節 | 校正/設定とは独立 |
| IDB `portalAudioControl`, version1 | 保存履歴とは別の音声claim制御用。Web Locks不在時のみ。claim/counter store、ownerTabId/世代/heartbeat/permit期限。履歴/機器データなし | 「履歴offで履歴IDBなし」はこの制御DB/任意校正DBを禁止する意味ではない |

メトロノームにA4互換の自動保存例外はない。DC-01の分離原則のみ踏襲。preset名は任意の個人記述を含み得るため共有端末への残存と初期化範囲を説明する。設定/presetをaccountへ自動送信しない。校正のoffset・残差数値・profile・機器条件は送信しない。account結果には補正後eの集計統計（個別eなし）、quality区分、校正済みかどうかのbool/opaque条件tokenを保存し、校正値を復元できる予定/入力生時刻の組を送らない。

localStorageに置くメトロノームの永続データは小さな設定keyだけ。presetは履歴保存offでも本人が明示保存した場合に専用IDBへ保存する。設定保存offは自keyだけを削除し、preset削除は別操作。書込みはserialize/bytes/schema検査後に自keyのsetItem、または専用IDBの原子的transactionで行う。失敗（QuotaExceededError/拒否/upgrade blocked/transaction abort）は前の値を保全し「保存できません」を表示、再生とメモリー上の編集は継続する。localStorage.clear、他key削除、認証キーの変更、他DBの初期化、容量回復目的のポータルデータ削除を禁止する。IDB失敗時にlocalStorageへfallbackしない。16KiBは上限でありorigin残容量の保証ではない。

<a id="audio-claim"></a>
### 3.1 IDB音声claimと引継ぎの契約

`portalAudioControl/v1` のclaims store key=`portal-audio-output`、counters storeの同keyに単調claimGenerationを保持。取得/更新/解放/引継ぎは両storeを含むreadwrite transactionでownerTabId/generationをCASする。claimにstate=preparing/running/stopped/pending-owner、heartbeatAtUtcMs,lastPermitExpiresAtUtcMsを持つ。新ページ実体ごとUUID、heartbeat2秒/stale15秒は調整値。自分以外の有効claimは「別のタブで使用中」、stale時だけ明示確認を出し、確認後の再読取で状態が変われば引継がない。pagehide/hidden/leave/idle60秒は自分の世代だけを失効・削除する。counterは残しABAを防ぐ。

引継ぎ時はgenerationを増やしてpending-ownerをcommitし、旧世代のheartbeat/permit延長/appendを拒否する。旧タブはvisibility/pageshow/resume/出力更新前にDB照合し、不一致なら出力破棄/close/中断表示。古いpagehideが新claimを削除してはならない。処理停止から復帰した旧callbackも新世代として扱わない。

音声側にも `{ownerTabId,claimGeneration,permitSeq,validUntilFrame,expiresAtUtcMs}` を渡す。permit更新はDB照合とlastPermitExpiresAtUtcMsのcommit後にだけ送信し、最大2秒分、500msごとに更新する（いずれも調整値、heartbeat2秒と別）。main/Worker/chunkも共有のfence gateを通し、再生音・tuner持続音の全経路へ適用する。gateは各render quantumで期限を検査し、期限切れ/壁時計逆転・不連続/Context復帰の時計不整合時にlatched-mutedとし、旧permitで復帰しない。壁時計は安全失効にのみ使い拍時計には使わない。AudioContext.currentTimeの停止だけでは期限失効を証明できない。

新ownerは旧stopped/closed ack、または旧permit絶対期限＋排出待ち250ms候補が過ぎたことと期限guard能力を確認してからclaimをreadyにし、**その後の再タップ**で再生する。gateの壁時計検査が使えない/時計が不確か/出力排出上界が未校正の端末では停止ackまたは旧ページ終了確認まで発音不可。OSから既出力sampleを回収できるとは保証しない。

【設計目標・追加判断】旧世代照合だけではrender済み/予約済み音を停止できないため、引継ぎには期限付き共有gateと準備完了条件が必要（MX-06/MX-15/MQ-06）。代替は旧タブ停止ackを必須とする安全側動作。AudioWorklet自体を使えない端末の引継ぎはこの代替とする。壁時計guardの能力/CPU/時計変更/freeze/BT排出は【未検証（実機が必要）】で、MT-19/MD-17/19が終わるまで引継ぎ安全性は未完。Workletの音声時計とページ時計の違いは[Web Audio1.1 WD 2026-09-22](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/)と[仕様issue2413](https://github.com/WebAudio/web-audio-api/issues/2413)を参照（2026-10-18確認）。新たな日時APIが全端末で使えるという前提は置かない。

<a id="presets"></a>
## 4. 3種プリセットのJSONスキーマと検証

JSON Schema draft2020-12相当の構造検証＋下記の意味検証を全て実行する。外部$refの解決/任意URL読込みは禁止、importはデータとして扱う。エディターの一時入力を保存正本へ混ぜない。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "rational": {"type":"object","required":["n","d"],"additionalProperties":false,"properties":{"n":{"type":"integer","minimum":0,"maximum":2147483647},"d":{"type":"integer","minimum":1,"maximum":2147483647}}},
    "position": {"type":"object","required":["barId","offset"],"additionalProperties":false,"properties":{"barId":{"type":"string","format":"uuid"},"offset":{"$ref":"#/$defs/rational"}}},
    "tempo": {"type":"object","required":["bpmTenths","reference"],"additionalProperties":false,"properties":{"bpmTenths":{"type":"integer","minimum":200,"maximum":3000},"reference":{"$ref":"#/$defs/rational"}}},
    "meter": {"type":"object","required":["numerator","denominator"],"additionalProperties":false,"properties":{"numerator":{"type":"integer","minimum":1,"maximum":32},"denominator":{"enum":[1,2,4,8,16,32]}}},
    "groups": {"type":"array","minItems":1,"maxItems":32,"items":{"type":"integer","minimum":1,"maximum":32}},
    "accent": {"type":"object","required":["group","pulse","subdivision"],"additionalProperties":false,"properties":{"group":{"type":"array","items":{"type":"number","minimum":0,"maximum":1}},"pulse":{"type":"array","items":{"type":"number","minimum":0,"maximum":1}},"subdivision":{"type":"number","minimum":0,"maximum":1}}},
    "layer": {"type":"object","required":["id","cycle","pulses","phase"],"additionalProperties":false,"properties":{"id":{"type":"string","maxLength":64},"cycle":{"$ref":"#/$defs/rational"},"pulses":{"type":"integer","minimum":1,"maximum":64},"phase":{"$ref":"#/$defs/rational"},"rhythm":{"type":"array","items":{"type":"object"}}}},
    "curve": {"type":"object","required":["start","end","reference","startBpmTenths","endBpmTenths","curve","domain"],"additionalProperties":false,"properties":{"start":{"$ref":"#/$defs/position"},"end":{"$ref":"#/$defs/position"},"reference":{"$ref":"#/$defs/rational"},"startBpmTenths":{"type":"integer","minimum":200,"maximum":3000},"endBpmTenths":{"type":"integer","minimum":200,"maximum":3000},"curve":{"enum":["constant","linear","exponential"]},"domain":{"const":"seconds"}}},
    "bar": {"type":"object","required":["id","meter","groups","pulse","accent","soundId","mute"],"additionalProperties":false,"properties":{"id":{"type":"string","format":"uuid"},"meter":{"$ref":"#/$defs/meter"},"groups":{"$ref":"#/$defs/groups"},"pulse":{"$ref":"#/$defs/rational"},"accent":{"$ref":"#/$defs/accent"},"soundId":{"type":"string","maxLength":64},"mute":{"type":"boolean"}}}
  },
  "type":"object","required":["schemaVersion","id","revision","kind","title","payload"],"additionalProperties":false,
  "properties":{
    "schemaVersion":{"const":1},"id":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1},"title":{"type":"string","maxLength":120},
    "kind":{"enum":["basic","advanced","score"]},
    "payload":{"type":"object","properties":{
      "tempo":{"$ref":"#/$defs/tempo"},"meter":{"$ref":"#/$defs/meter"},"groups":{"$ref":"#/$defs/groups"},"pulse":{"$ref":"#/$defs/rational"},"accent":{"$ref":"#/$defs/accent"},
      "sound":{"type":"object"},"practice":{"type":"object"},"basePresetId":{"type":"string","format":"uuid"},"baseRevision":{"type":"integer","minimum":1},
      "layers":{"type":"array","minItems":1,"maxItems":4,"items":{"$ref":"#/$defs/layer"}},"swing":{"type":"object"},
      "bars":{"type":"array","minItems":1,"maxItems":10000,"items":{"$ref":"#/$defs/bar"}},"tempoMap":{"type":"array","items":{"$ref":"#/$defs/curve"}},"events":{"type":"array","items":{"type":"object"}},"conductor":{"type":"object"}
    },"additionalProperties":false}
  },
  "allOf":[
    {"if":{"properties":{"kind":{"const":"basic"}}},"then":{"properties":{"payload":{"required":["tempo","meter","groups","pulse","accent","sound"]}}}},
    {"if":{"properties":{"kind":{"const":"advanced"}}},"then":{"properties":{"payload":{"required":["basePresetId","baseRevision","layers"]}}}},
    {"if":{"properties":{"kind":{"const":"score"}}},"then":{"properties":{"payload":{"required":["basePresetId","baseRevision","bars","tempoMap","events"]}}}}
  ]
}
```

上のobject型sound/practice/rhythm/swing/events/conductorは任意JSON許可ではない。次表の型・unknown key拒否が追加の規範スキーマであり、実装時は$defsへ展開する。draftのformat uuidもannotation任せにせずvalidatorでassertする。追加fieldはschemaVersion改訂まで拒否する。

| 型 | 許可fieldと意味制約 |
|---|---|
| sound | kind=synth/sample、id<=64、volume有限0..1。idは同releaseのcatalog限定、URL/実行コードは不可 |
| rhythm item | offset/duration=Rational、duration>0、rest=bool、velocity0..1、accentLevel enum、timingMode=literal/generated、tuplet={n,m,baseUnit,children}（深さ2）。offset<cycle、末尾durationはclip規則を宣言、無宣言越境は拒否 |
| swing | ratio=[A,B]の正有限2数、各1..8、target=ordinaryEighthPairs/customPairs、applyInsideTuplets bool、layerIds既存ID列。customPairsはstart/end有理位置列、重複禁止 |
| practice | countInBars0..8、timer={seconds>0<=7200,clock:activePlayback/wall}、randomMute={unit:bar/event,probability0..1,seed:uint32,algorithmVersion:1}、program={steps,repeat}。他field不可 |
| program step | id UUID、presetId+revision、end={kind:bars/activeSeconds/repeats/manual,value}、countInBars、tempoStep={deltaBpmTenths:int（符号可、0不可）,at:bars/seconds/repeats,every,minBpmTenths:200..3000,maxBpmTenths:200..3000,onLimit:stop/hold/reverse}、mute mask、restSeconds、beatFeel（pulse/層選択）、exercise=play/tempoGuess。条件ごとの必須valueを検証、step最大256 |
| events | cue={id,kind:cue,target:Position,before:{unit:bar/pulse,count},soundId}、fermata={id,kind:fermata,at:Position,resumeCountInPulses:0..32}、modulation={id,kind:modulation,at,oldValue,newValue,oldReference,newReference}、repeat={id,kind:repeat,start,end,count:1..100またはuntilStop}。variant外key不可 |
| conductor | template=two/three/four/additive/custom、points=[{groupIndex,x,y,controls:[{x,y}]}]。0<=x,y<=1、group数一致、control点最大2/区間。audio時間field禁止 |
| basic/advanced/score | basicはbase参照/layers/bars/map/events禁止。advancedはbars/map/events禁止、baseはbasicのみ。scoreのbaseはbasic/advancedのみ、別score参照不可。titleは表示文字としてescape |

Rationalの0はoffset/phaseだけ、reference/pulse/cycle/durationは正。group総和=meter分子、accent.group長=groups長、pulse配列長=その小節で生成したpulse数を必須にする。分割が端数なら生成数を事前表示し配列を再検証。bar指定は親meter/accentの完全置換、旧6/8配列を7/8へ継承しない。styleだけの継承も展開後に検証する。

basePresetId/baseRevisionは完全一致参照、深さ最大2、存在/循環/重複ID/削除参照を検査する。importは全参照を同bundleへ含めるか既存の同ID/同revision/同hashが必要。bundle最大60件/2MiB、展開後event/voice/queue/有理数をcompilerでpreflight。JSONのprototype key（__proto__/prototype/constructor）・重複key・非有限数を拒否し、任意objectをObject.assignでnamespaceへ結合しない。

再生と履歴には参照解決済みsnapshotをコピー保存し、親preset編集が実行中/過去結果へ波及しない。未知schema/unknown enumは生データを保全しread-only、コピー移行と検証に成功した場合だけ新keyへ保存する。起動失敗を理由に既存DBをdeleteしない。

保存/通信/比較ではbpmTenths/startBpmTenths/endBpmTenthsだけを許可し、旧bpm/startBpm/endBpmはunknown fieldとして拒否する。計算はB=tenths/10。TAPや曲線途中はFloat64を維持し、**永続化する設定/端点だけ**0.1BPMへ四捨五入する。正値floor(10B+0.5)は数学上の定義であり、実装は入力の十進文字列（Float64なら最短往復十進表現）をhalf-up処理して整数へ変換し、二進浮動の乗算誤差で半端を下げない。20.05→201、20.15→202、119.95→1200、299.95→3000をMT-01/02/15のfixtureにする。丸め前Bが20..300外/非有限なら拒否、APIの非整数tenthsも拒否する。19.99→200への丸めで範囲内に救済しない。curve途中を毎frame量子化して階段状tempoに変えない。未知版保全を維持し、旧例の変換は明示コピー移行だけとする。

### 4.1 楽譜終点のJSON例

下記はscore.payload中のtempoMap例。b1/b2の実IDはUUID、barの全fieldは上記schemaに従う。6/8+7/8、reference3/8で13/3拍、D=26/7秒は実行時導出である。endBpmTenthsとend位置は別の物理量で、durationとの三重制約を作らない。

```json
{
  "tempoMap": [{
    "start": {"barId":"11111111-1111-4111-8111-111111111111","offset":{"n":0,"d":1}},
    "end": {"barId":"22222222-2222-4222-8222-222222222222","offset":{"n":7,"d":8}},
    "reference":{"n":3,"d":8},"startBpmTenths":600,"endBpmTenths":800,
    "curve":"linear","domain":"seconds"
  }]
}
```

durationSeconds付き旧調査例はschema1製品データではないので通常importはrejectする。移行専用経路なら旧JSONコピーへ新endを利用者に指定してもらい、旧Dと計算Dの差を表示して確認後にdurationを削除、新schemaとして保存する。durationだけからendを推測して黙って移行しない。秒domainとはB(t)の独立変数の意味で、保存終点の種類ではない。

<a id="local-history"></a>
## 5. 端末内の練習履歴・所有者

保存方針はhistoryMode=none/manual/auto（初期none）、destination=local/accountを本人が選ぶ。accountはローカルの一時outboxも利用することを表示し、端末残存を説明する。offで結果はメモリーのみ、再生を妨げない。設定保存の有無とは独立。本人識別前の履歴永続化は禁止する。

本人は共通identity serviceからowner UUID/organization/member_birth/activeを解決する。memberを持たないhidden管理者はACCOUNT_STORAGE_UNAVAILABLE、認証済みdeviceに結び付けた端末限定opaque ownerでlocalだけ利用できる。accountへの後付け移管はしない。logout後はどちらの一覧も表示せず、再認証時に同一ownerを確認する。

| store（portalMetronomeHistory v1） | key・内容・index |
|---|---|
| ownerState | ownerId。localDeleteGeneration,serverHistoryEpoch,consentRevision,policy,ownerBirthToken。書込/削除が必ずscopeに含む |
| sessions | [ownerId,sessionId]。attempt/program、snapshot、状態recording/complete/incomplete、開始/終了、activeDurationMs<=1800000、conditions、versions、summary。index owner/start |
| dictionaries | [ownerId,sessionId,kind,index]。event/condition/score/layerの共通情報を一回保持、timingEventsは整数参照。metadata/snapshotと合計2MiB以下 |
| timingEvents | [ownerId,sessionId,ordinal=0..35999]。予定拍の対応/欠測と余分な発音を区別し、event/condition辞書参照、補正後e/IOI比またはnull、品質/理由。端末だけの詳細、accountへ送らない |
| syncOutbox | [ownerId,operationId]。固定owner/identity/delete/consent token、要約revision/hashの参照、送信状態。詳細を複製しない。送信時だけ最大256KiBの要約bodyを組立てる |
| tombstones | [ownerId,entityType,entityId]。単件削除を旧outboxから復活させない |

観測/辞書と進捗はownerStateを含むreadwrite transactionへ最大256詳細行ずつ書き、イベントごとにtransactionを作らない。snapshot複製、検証/容量estimateは外で行い、await前から固定tokenを保持する。各batch後に主スレッドへ処理を返し、実行済みの詳細36000行をfinalize時に一括書き直さない。完了状態/summary/outbox参照はownerStateと同一transactionで確定する。IDB transaction内でネットワークawaitしない。sample/hz/PCM系列は保存しない。このbatch上限も調整値としてMT-13でcommit/読出し/削除/復旧のp95/最大時間を測る。

端末のメトロノーム保存予算64MiB、1記録1800秒、予定拍28800件＋余分な発音の詳細7200件＝端末詳細最大36000件を調整値とする。本人識別と保存選択は従来どおり。保持90日候補/警告80%は調整値として維持するが、容量不足だけを理由に過去データを自動削除しない。設定/preset専用IDB、校正端末限定、他key/認証不変、失敗表示/再生継続も維持する。

<a id="capacity"></a>
### 5.1 解析頻度・記録時間・端末容量・同期の再見積り

#### 5.1.1 再生予算とは独立した解析対象

**400件/秒はクリック再生の負荷予算であり、観測保存の頻度には使わない。** 解析対象は既定1層、明示選択で最大2層（調整値）。選択層の予定拍だけを対応付け、他のpoly層や細分クリック全体を解析目標へ暗黙に加えない。選択層lの基準音価r、細分音価d_l、連符置換n_l:m_lについて、定速なら `R_target=Σ_l (B/60)*(r/d_l)*(n_l/m_l)`。custom/異周期/tempo curve/swingはコンパイルした予定列から、任意の半開1秒窓内の件数を調べる。合計上限16件/秒を調整値とし、同時刻の別対象層も別予定拍として合算する。

【確認済み（算術）】四分基準120BPMの32分1層は2*8=16件/秒、240BPMの16分1層も4*4=16件/秒、120BPMの16分2層は2*4*2=16件/秒。四分300BPMの32分1層は40件/秒なので解析対象としては拒否するがクリック再生は可能。【推定】16件/秒は人の発音頻度が数十回/秒に達する場合もあることを踏まえた初期対象範囲であり、人の能力上限を計測した値ではない。高速トレモロ等を全て評価できる保証ではなく、MT-16/MD-15で検出性能を確認して見直す。

**評価方法（第2回で確定、IC-13）**: 対象の判定は収集と同じ関数（expected=true、cue・予備拍を除く、選択層）で行い、実際にコンパイルしたイベント列の各予定拍の時刻について、任意の半開1秒窓 [t, t+1) に入る件数の最大値を数える。範囲は解析開始位置から1記録分（1800秒）、ループで周期が分かる場合は1周期＋1秒、有限楽曲は終わりまで、止めるまでの反復は反復部分をもう1周＋1秒まで。平均頻度では判定しない。解析中の編集は、適用前に同じ方法で現在位置から検査する（edit guard）。

解析開始前に選択層数、全予定区間の最大BPM/細分/連符/混合/反復をpreflightし、上限超過や上界計算不能なら `ANALYSIS_TARGET_RATE_EXCEEDED` と対象層/頻度/上限を表示して**解析開始を拒否**する。クリックは継続できる。再生中編集で超える場合も解析条件の変更を拒否して旧条件を維持し、クリック変更だけを望む場合は利用者が明示的に解析終了を選んでから変更する。途中で黙って保存だけ止める方式にしない。

#### 5.1.2 30分の記録枠と端末詳細件数

解析記録の時間枠はT=1800秒（30分、調整値）へ変更する。チューナーの7200秒は流用しない。長い練習全体と評価区間を分け、1回の結果確認・校正見直しができる単位にし、モバイルのtransaction/読出し/復旧を有界にするための設計判断である。練習program/timerの既存7200秒上限は再生の操作設定として維持し、保存sessionのdurationMsとは別物とする。

`N_target=ceil(∫_0^T R_target(t)dt)<=16*1800=28800`。半開区間[開始,終了)で予定拍を数え、フェルマータ待ち/pause/count-in/休憩は記録のactive秒へ含めない。端点の二重計数をしない。7200秒programを自動で4記録へ分割/再開せず、30分で記録だけを明示終了し同じattempt/recordingIdを一回確定、クリックは継続する。開始時に終了時刻を予告し、残り時間/終了/未保存を表示する。続けるには本人が新しい解析試行を開始する。後のprogram完了が閉じた観測範囲を再び開かない（DC-13/17/19）。

予定拍は対応/欠測1行、対応しないattack詳細は別枠 `N_extra_detail<=7200`（4件/秒*30分相当、平均配分であり瞬間発音速度の制限ではない）とし、端末の詳細行は合計36000件以下。余分な発音が枠を超えたらextra_total/除外理由/区間別件数を集計し続け、追加の個別値だけを保持しない。`extraDetailsTruncated=true`,保存件数/総件数/最初の打切り位置を表示し、黙って捨てない。予定拍の保存・解析は続ける。品質不足なら判定保留。雑音等の大量attackで予定拍枠を圧迫しない。生入力を無制限bufferにためない。別タブ/画面退出などの既存停止規則は変えない。

#### 5.1.3 スマートフォン向けの端末予算

【推定】詳細1件の数値core64B、共有ID/条件辞書の按分32B、key/単一session索引/IDB object overheadの仮定160B、計256B/件。UUID/condition全文やScoreSnapshotを各行へ複製せず、session内辞書の整数参照にする。IndexedDB overheadはブラウザー依存で、この内訳は測定値ではない。従来の512B×2コピーは撤回し、outboxへ詳細コピーを作らない。

1記録のmetadata/辞書/score snapshot上限2MiB（調整値）を別枠とし、最大密度の5記録を保持する想定で `S=5*(36000*256+2MiB)+4MiB=60760064B（約57.95MiB）`。全体を切上げ64MiB（67108864B）をメトロノーム独自の初期予算とする【調整値】。4MiBはpreset2MiB、校正/同期待ち要約/墓標/一時組立ての余裕。通常の120BPM四分1層なら30分3600予定拍であり、5記録は件数上限ではなく最大密度時の見積り想定。実際は総bytesで制限する。チューナーの100MBは根拠にしない。

この64MiBも**ポータルorigin共有容量の一部**であり専有枠・保存保証ではない。開始前にメトロノーム使用量/新記録見積りとoriginのestimateを確認し、余裕不足なら履歴保存開始を拒否し、履歴なしのその場解析/クリックを選べる。estimateは予約ではないため実書込失敗も必ず捕捉する。失敗後は新規永続保存を停止し、recordingをincomplete/storage-errorとして可能な範囲で一回閉じ、「保存できない/この端末の詳細のみ/同期待ち」等を区別、書出し・自分の履歴削除を案内する。再生は続け、ポータル他key/認証/他DBへ手を付けない。メモリー結果も有界で、未保存のまま無制限に蓄積しない。

`navigator.storage.persisted()`で状態を確認し、履歴保存を選んだ本人が説明を読んで明示操作した場合だけ`navigator.storage.persist()`を能力検出して要求する。拒否/未対応でも動作可能だが警告を表示し、自動再要求しない。許可はquota拡張やバックアップではなく、本人によるサイトデータ削除等からの復元は保証しない。ブラウザーに詳細が消された場合は「端末詳細なし」を示し、accountから要約だけ復元する。消失時に旧詳細/outboxを空の成功記録で上書きしない。失われる前の書出しと要約同期の限界を説明する。

【確認済み（一次資料）】[WHATWG Storage Standard](https://storage.spec.whatwg.org/#storage-pressure)（Living Standard更新2026-10-06、2026-10-18確認）はoriginのquota見積りとbest-effort/persistentの扱いを規定する。`persist()`の許可/端末挙動は【未検証（実機が必要）】。MT-13で256B仮定、辞書/索引/復旧時間、5記録/近満杯/小quota/消失/永続化拒否を実測して調整する。

#### 5.1.4 accountは要約のみ、観測ごとは送らない

**判断: 観測ごとのe/IOI/発音時刻はaccountへ送らない（event_count=0）。** 端末に詳細、accountにセッション統計と拍位置・条件別集計を置く。tunerの原則に合わせ、通信・DB行数・個人データを抑える。条件別groupは最大256行/記録（調整値）、条件token/選択層/拍位置key、有効n/予定数/欠測/余剰総数/除外理由、median/MAD/SD/IOI統計と判定保留を送る。全体統計はlocalから別に計算し、group中央値の中央値で再生成しない。

groups合計128KiB、compact scoreSummary（実行条件/tempoMap hash/解析版/program参照、完全譜面なし）64KiB、セッション統計32KiBを各上限とし、JSON envelope込み**1記録の要約body256KiB・分割最大1個（part_index=0）**。schema/size/group件数を送信前に検証し、超過時は同期を保留して端末保存・理由表示・書出し案内。異条件を勝手に統合したり先頭256groupだけ送って完全と表示したりしない。予定条件から超過を予測できる場合はaccount保存開始前に案内する。

outboxは要約snapshotのrevision/hash参照だけ保持し、送信時に小さなbodyを組立てる。別端末の結果は要約・集計だけ、詳細グラフ/再解析は「この端末に詳細なし」。既存presetsの明示account保存は別の契約を維持。生録音/PCM/FFT/校正値の非送信も変更しない。

<a id="delete"></a>
## 6. 全削除・H-010・別タブ競合

**推奨設計は機能別の全削除。** メトロノーム履歴を消す操作がチューナー履歴を消さない。既存owner UUID/失効/member_birthを共通化し、削除世代の仕組みは共通サービスで扱うが、メトロノームの数値epochは専用ownerState/prefs行に持つ。既存tuner_owners.history_epochはチューナーだけの削除世代として維持する。member削除/失効は両機能の全データを失効・削除する別のidentity操作。

全削除の範囲は本人のメトロノームsessions/timingEvents/dictionaries/outboxとaccountのsummary_groups/upload一時データ。端末設定/preset/校正は別の初期化操作。画面は「この端末」「アカウント」の対象を明示し、account全削除時は現端末の旧account由来記録も失効させる。別端末のオフラインコピーを即時消去できるとは約束せず、次のidentity/同期時にepoch照合して消す。単件削除にはtombstone、全削除にはepochを使う。

### 6.1 旧試行のtokenを固定し、削除後に読み替えない

1. 試行開始時に `ticket()` でbudget storeの削除カウンター `deleteSeq` を読むtransactionをその場で作る（IC-14第3回改訂）。`beginAttempt` はownerStateのreadwrite transactionで `lastDeleteSeq > ticket.seq` を拒否し、token={ownerId,ownerEpoch,localDeleteGeneration,serverHistoryEpoch,consentRevision}を確定する。初回行作成もこのtransaction。解析はtoken確定後に収集を始める。練習はgesture内の再生と独立してticketを確保し、DB未openで順序が確定できないticket（ordered:false）なら、その試行の保存を拒否して表示する。時刻引数はINVALID_TICKETで拒否する。
2. 解析/容量待ちを含め全ての保存要求はこの固定tokenを持つ。保存開始時に最新世代を取り直して古いpayloadへ付けない。
3. saveはownerState+対象storeの同じreadwrite transactionで、active owner/全token/削除tombstoneを照合し一致時だけ書く。transactionがdeleteより先に完了すればdeleteがその内容を消し、後なら世代不一致でrejectする。
4. deleteはownerStateとbudgetを含む同じreadwrite transactionでlocalDeleteGenerationとDB共通のdeleteSeqを増加し、ownerState.lastDeleteSeqへ記録する。対象データ/outboxの削除も同じtransactionでcommitする。メモリーは同期失効し、BroadcastChannelは通知にだけ使う。通知未着でもDB照合で拒否する。lastDeleteAtUtcは表示用で、正当性の判定には使わない。
5. delete後、新規attemptだけが新tokenを取得できる。旧attemptの解析完了はSTALE_LOCAL_GENERATIONで破棄。削除直後identity再取得で旧outboxを新epochに変換しない。

ticketの読取と全削除は同じDBのbudget storeを共有し、トークン確定後の保存と全削除はownerStateを共有する。この重なるscopeのtransactionのスケジューリングと原子性で順序を決める。タブの壁時計やBroadcastChannelの到着順を正本にしない。Chromiumの2タブ・別接続で確認済みだが、Safari/実機のH-010受入は未完。対応端末でWeb Locksを補助に使っても、通知/lockだけを正当性の根拠にしない。削除transaction内にquota/ネットワーク待ちを入れない。

【確認済み（一次資料）】[IndexedDB 3.0 Working Draft（2025-08-13）2.7.2 Transaction scheduling](https://www.w3.org/TR/2025/WD-IndexedDB-3-20250813/#transaction-scheduling)（2026-10-18再確認）の重なるscopeと先行transactionに関する制約を根拠とする。【推定】上記の線形化で旧payloadの復活経路を塞げる。【未完・未検証（実機が必要）】Safari/Chrome各2タブ/2接続、通知遅延/無通知、quota待ち、タブ停止、delete commit前後クラッシュをMT-13/MD-17で確認するまでH-010対策完了とはしない。fake-indexeddb成功のみで合格にしない。

### 6.2 account全削除と通信の順序

account delete開始時に端末世代を進めて旧outboxを破棄、delete operationIdとexpected serverHistoryEpochを送る。server commit済みなら新epochを返す。応答を失った場合、同operationId再送で同結果、またはidentity再取得でepochを確認する。新しい同期attemptは確認完了まで禁止し、再生は継続可能。409は本人情報を再取得して新規試行だけ許可、旧履歴を再送しない。serverで先行するsaveはdeleteが消し、後続saveはHISTORY_EPOCHで拒否する。

同意撤回はconsentRevisionを進め、未送信と待機中要求をabort/無効化。送信済みデータ削除とは別操作。server保存transactionが撤回より先なら既送信として残り、撤回より後ならconsent不一致で拒否。この直列化点をUIで説明し、ネットワーク中断だけを撤回完了としない。

<a id="schema"></a>
## 7. アカウントDB案（DDL案のみ）

【確認済み】既存017はtuner_owners UUID/organization/member_birth/失効を保持し、member削除/再挿入のtriggerはownerを失効させるがowner行自体は残す（[017](../db/migrations/017_tuner_practice.sql)）。したがってFK ON DELETEだけでは新表のデータが消えない。本設計では既存ownerを共通identityとして参照し、**revoked_at更新時の新表削除trigger**も追加する。既存tuner triggerの関数を直接置換する必要はない。

下記はPostgreSQL用の将来DDL案。現在の017 checksumを書き換えず新migrationで追加する。SQL内の1800000ms/28800予定拍/36000端末詳細/256集計group/1part等もlimits-v0の調整値で、実装時にアプリ/APIと同時に版を合わせる。JSON内部の詳細型/bytes/有限数/禁止fieldはservice validatorが検査し、DBも基本整合を制約する。

```sql
CREATE TABLE IF NOT EXISTS metronome_preferences (
  owner_id UUID PRIMARY KEY REFERENCES tuner_owners(id) ON DELETE CASCADE,
  history_epoch BIGINT NOT NULL DEFAULT 1 CHECK (history_epoch > 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  consent_revision BIGINT NOT NULL DEFAULT 1 CHECK (consent_revision > 0),
  account_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_version TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS metronome_sessions (
  owner_id UUID NOT NULL REFERENCES tuner_owners(id) ON DELETE CASCADE,
  session_uuid UUID NOT NULL,
  history_epoch BIGINT NOT NULL CHECK (history_epoch > 0),
  attempt_uuid UUID NOT NULL,
  program_uuid UUID NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('uploading','complete','incomplete')),
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms BIGINT NOT NULL CHECK (duration_ms BETWEEN 0 AND 1800000),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count = 0), -- raw observations are local only
  target_count INTEGER NOT NULL CHECK (target_count BETWEEN 0 AND 28800),
  valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND target_count),
  local_detail_count INTEGER NOT NULL CHECK (local_detail_count BETWEEN 0 AND 36000),
  extra_detail_count INTEGER NOT NULL CHECK (extra_detail_count BETWEEN 0 AND 7200),
  extra_total BIGINT NOT NULL CHECK (extra_total >= extra_detail_count),
  group_count INTEGER NOT NULL CHECK (group_count BETWEEN 0 AND 256),
  condition_key TEXT NOT NULL,
  versions JSONB NOT NULL CHECK (jsonb_typeof(versions)='object'),
  score_summary JSONB NOT NULL CHECK (jsonb_typeof(score_summary)='object'),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary)='object'),
  content_hash TEXT NOT NULL,
  finalized_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id,session_uuid)
);
CREATE INDEX IF NOT EXISTS idx_metronome_sessions_started
  ON metronome_sessions(owner_id,started_at DESC,session_uuid);
CREATE INDEX IF NOT EXISTS idx_metronome_sessions_condition
  ON metronome_sessions(owner_id,condition_key,started_at DESC,session_uuid);
CREATE TABLE IF NOT EXISTS metronome_summary_groups (
  owner_id UUID NOT NULL,
  session_uuid UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  condition_key TEXT NOT NULL,
  layer_key TEXT NOT NULL,
  beat_position_key TEXT NOT NULL,
  target_count INTEGER NOT NULL CHECK (target_count BETWEEN 0 AND 28800),
  valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND target_count),
  extra_total BIGINT NOT NULL CHECK (extra_total >= 0),
  stats JSONB NOT NULL CHECK (jsonb_typeof(stats)='object'),
  quality JSONB NOT NULL CHECK (jsonb_typeof(quality)='object'),
  PRIMARY KEY(owner_id,session_uuid,ordinal),
  UNIQUE(owner_id,session_uuid,condition_key,layer_key,beat_position_key),
  FOREIGN KEY(owner_id,session_uuid) REFERENCES metronome_sessions(owner_id,session_uuid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metronome_groups_condition
  ON metronome_summary_groups(owner_id,condition_key,session_uuid);
CREATE TABLE IF NOT EXISTS metronome_upload_parts (
  owner_id UUID NOT NULL,
  session_uuid UUID NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index = 0),
  payload_hash TEXT NOT NULL,
  groups JSONB NOT NULL CHECK (jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=256),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner_id,session_uuid,part_index),
  FOREIGN KEY(owner_id,session_uuid) REFERENCES metronome_sessions(owner_id,session_uuid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metronome_parts_expiry ON metronome_upload_parts(expires_at);
CREATE TABLE IF NOT EXISTS metronome_presets (
  owner_id UUID NOT NULL REFERENCES tuner_owners(id) ON DELETE CASCADE,
  preset_uuid UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('basic','advanced','score')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id,preset_uuid,revision)
);
CREATE TABLE IF NOT EXISTS metronome_tombstones (
  owner_id UUID NOT NULL REFERENCES tuner_owners(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('session','preset')),
  entity_uuid UUID NOT NULL,
  history_epoch BIGINT NOT NULL CHECK (history_epoch > 0),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id,entity_type,entity_uuid)
);
CREATE TABLE IF NOT EXISTS metronome_operations (
  owner_id UUID NOT NULL REFERENCES tuner_owners(id) ON DELETE CASCADE,
  operation_uuid UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delete-history','delete-session','delete-preset')),
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id,operation_uuid)
);

CREATE OR REPLACE FUNCTION metronome_revoke_owner_data() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    DELETE FROM metronome_sessions WHERE owner_id=NEW.id;
    DELETE FROM metronome_presets WHERE owner_id=NEW.id;
    DELETE FROM metronome_preferences WHERE owner_id=NEW.id;
    DELETE FROM metronome_tombstones WHERE owner_id=NEW.id;
    DELETE FROM metronome_operations WHERE owner_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_metronome_owner_revoked ON tuner_owners;
CREATE TRIGGER trg_metronome_owner_revoked
  AFTER UPDATE OF revoked_at ON tuner_owners
  FOR EACH ROW EXECUTE FUNCTION metronome_revoke_owner_data();
```

event_count=0（送信した個別観測数）、local_detail_count<=36000、target_count<=28800、extra_detail_count<=7200、group_count<=256と実集計行数/各countの整合、hash、JSON bytesをserviceで検証する。local_detail_count=target_count+extra_detail_count（未完記録は実際に処理した予定拍のみ）を照合する。score_summary/presetのBPMはtenths整数で専用BPM列なし。IF NOT EXISTSは実定義の一致を保証しないためchecksum/実定義も照合する。metronome_timing_eventsのDDL案は撤回し、新規migrationで作らない。端末の残差値はローカルschemaだけで管理する。owner FKは組織照合の代わりではなく、request毎にserverで解決したownerで限定する。API用DB roleの一般アクセスを新しく公開しない。

owner追加/identity取得でpreferences行を冪等作成、既存owner再利用時はmember_birth/device認証時刻を照合する。revoked ownerへ新prefs作成不可。member失効triggerと書込が同時ならowner行ロックで直列化、後続要求はOWNER_REVOKED。新表はproduction→testのsync対象外にし、test側member再挿入でも旧個人履歴を削除する。pg_restoreで失効前のownerを復元する場合は復元一式と端末再認証を運用で確認する。

### チューナー未使用の本人のowner作成

メトロノームGET /identityは共通owner解決のcreate=true経路を使い、tuner使用歴を前提にしない。認証済みdeviceから組織/本人memberを解決、現役members行のcreated_at=member_birth、端末認証時刻がcreated_at以降であることを検査する。hidden/non-memberは従来の端末限定ownerでaccount不可。

既存ownerを探す前に `members(organization_id,id) FOR UPDATE` を取得してmemberの存在/世代をtransaction内で再確認、次に `tuner_owners FOR UPDATE`。現役owner同birthならそのUUID、birth違いなら既存失効関数で失効して新UUIDを挿入する。不存在ownerのSELECT FOR UPDATEだけでは初回INSERTを直列化できないためmembers行を先にロックする。既存の部分一意索引 `uq_tuner_owners_active_member`（organization_id,member_id WHERE revoked_at IS NULL）も重複を防ぐ。

tuner旧経路との競合でunique違反になった場合はtransactionをrollback、現役member/device/birthとownerを最初から再照合して最大3回（調整値、MT-14で見直し）に限定して再試行する。既存UUIDを別のbirthへ上書きせず、409 OWNER_INITIALIZATION_RETRYを返して安全に再試行できるようにする。prefs行はowner取得後INSERT ... ON CONFLICT DO NOTHING、同意初期false。MT-14でメトロノーム初回のみ、tuner/metronome同時初回、member再作成中の競合を試す。

【将来の課題】`tuner_owners`は現在の物理名のまま共通本人管理として使う。service名をpractice owner等へ中立化し、将来は互換view/別名または別migrationでrenameを比較する。今回renameや既存017の書換えをしない。view経由のlock/trigger/既存API互換は別の設計と実DB試験が必要（MX-12/MX-13）。

### 7.1 ロック順と原子性

owner初期化/本人世代を確定する経路では `members FOR UPDATE → tuner_owners` の順。既存member削除経路と逆順にmembersを後取得しない。既存ownerへの通常の全書込は `tuner_owners FOR UPDATE → metronome_preferences FOR UPDATE → 対象sessions（UUID昇順）→ parts/summary_groups/presets/tombstones/operations` の順。ownerのorganization/member_birth/revoked、専用history_epoch、consent_revision/account_consentを同transactionで確認。既存tunerのowner-first順に合わせ逆順取得を避ける。GETも本人を解決しcomplete/incompleteだけ取得、uploadingを結果一覧へ出さない。

finalizeはpart0のhash、group_count/統計counts、schema、scoreSummary、consent/epochを再検証しsummary_groups/summaryの確定とstatus更新を一transaction。部分成功なし。同UUID/同hashの再実行は同結果、異hashはSESSION_CONFLICT。全削除はowner/prefsロック、expected epoch確認、epoch増加、sessions/upload/summary_groups/tombstonesの掃除、operations結果保存を一transaction。preset/preferences同意を無断で消さない。削除operationの冪等結果は先に照合するが、失効owner/他人への応答は許可しない。

operations保存期間と最大件数は調整値（初期90日/owner1000件候補）。期限後の旧operationIdはidentity/expected epoch不一致で拒否し、結果再現を無期限保証しない。削除epochは減らさない。単件tombstoneは同一ownerが有効な間維持、同UUID再作成禁止。

<a id="api"></a>
## 8. API契約

prefix `/api/metronome`。全endpointは既存 `get_system_admin_device_auth` 相当の端末認証を使い、サーバーで本人ownerを解決する。ownerId/memberId/organizationをクライアント指定で切り替えない。管理者にも他人の履歴取得endpointを設けない。Cache-Control:no-store、既存の同一origin/CSRF方針とサイズ制限/レート制限を維持する。sessionはdurationMs<=1800000、targetCount<=28800、localDetailCount<=36000、extraDetailCount<=7200、送信eventCount=0。groupCount<=256、groups合計128KiB/scoreSummary64KiB/summary32KiB、body全体256KiB、partは0のみ1個（すべて調整値）。ネットワークtimeout10秒候補、AbortControllerでowner/logout/世代変更を中断する。

| method/path | 要求 | 成功応答/制約 |
|---|---|---|
| GET /identity | なし | ownerId,organizationScopeToken,memberBirthToken,active,historyEpoch,consentRevision,accountConsent,consentVersion。calibration/deviceIdなし |
| GET /preferences | なし | revision,consentRevision,accountConsent,consentVersion,historyEpoch |
| PUT /preferences | expectedRevision,accountConsent,consentVersion | revision/consentRevision更新。設定/preset/校正を送らない。同意撤回で送信中の後続確定を拒否 |
| POST /sessions | sessionId,attemptId,programId?,historyEpoch,consentRevision,startedAt,durationMs,versions,scoreSummary（64KiB以下、tempo端点はtenths整数、完全譜面なし）、counts,conditionKey,contentHash | 201 sessionId,status=uploading。既存同hashなら200。UUID/容量/epoch/consent/tombstone検証 |
| PUT /sessions/{id}/parts/{index} | index=0のみ、historyEpoch,consentRevision,payloadHash,groups[<=256] | 200 partIndex/hash/groupCount。groups合計128KiB、body256KiB以内。同part異hash409、index!=0は422 |
| POST /sessions/{id}/finalize | historyEpoch,consentRevision,partHashes（1個）,eventCount=0,groupCount,summary,status=complete/incomplete | 200 sessionId/status/revision。durationMs<=1800000、targetCount<=28800、localDetailCount<=36000、extraDetailCount<=7200、groupCount<=256、body256KiB。サーバーはgroup/全体のcount整合を検査 |
| GET /sessions | from/to UTC,condition?,cursor?,limit1..100 | items,nextCursor。開始時刻+UUIDのowner-bound cursor、既定20。期限/範囲検証 |
| GET /sessions/{id} | なし | scoreSummary/summary/versions、groups<=256。個別観測や完全譜面なし、詳細は端末限定。校正値なし |
| DELETE /sessions/{id} | operationId,historyEpoch | 200 deletedId/tombstone。同operation再送冪等。別owner/存在しないidは404 |
| DELETE /history | operationId,historyEpoch | 200 historyEpoch（新値）,deletedCount。本人のメトロノーム履歴だけ。チューナー/preset/校正は対象外 |
| GET /presets | cursor?,limit | 本人が明示account保存したpresetのみ。端末保存を自動収集しない |
| POST /presets | preset envelope,historyEpoch,consentRevision | 201 id/revision。全参照はbundleか既存同owner版、容量と同意検査 |
| DELETE /presets/{id} | operationId,historyEpoch | 200 id。参照中は409 PRESET_IN_USEまたは展開済みsnapshotへコピー後削除を本人選択 |

通常の同期はcreate→PUT part0→finalizeの計3書込requestで、分割は1個だけ。DBの永続観測行は0、1sessionにつき最大256集計行に限定する。DELETE bodyは既存FastAPIの契約に合わせJSONで定義し、client/proxyがbodyを落とさないことをMT-14で検証する。自動retryはGETまたは同一hash/operationIdの冪等操作のみ。part一時保存TTL24時間候補、finalize完了で削除。TTL掃除もowner→session順ロック。ユーザーDB無し/DB停止は503、JSONファイルへfallbackしない。

accountのgroup JSONはordinal(0..255),conditionKey,layerKey,beatPositionKey,targetCount,validCount,missingCount,extraTotal,excludedByReason,stats={medianMs,madMs,sdMs,ioiRatioStats,verdict},quality={calibrated,confidenceClass,extraDetailsTruncated}。数値は有効nがない場合null、countは非負で整合、各行JSON<=512Bを初期調整値として検査する。予定拍のgroupは互いに排他的なpartitionで、各groupのtarget/valid合計を全体と照合。余剰は時刻位置を割り当て不能なら専用unassigned groupへ集計し二重計上しない。

e/IOIの個別値、観測発音時刻、raw input/output時刻対、校正offset/profile、PCM/FFT/包絡/raw deviceIdはpayloadの未知fieldとして拒否する。サーバーは要約の型/count/統計版・条件・保留条件を検証するが、送られていない詳細から精度を独立再計算したとは扱わない。別端末は要約だけを表示し、個別波形/詳細点列を復元できるとは案内しない。

```json
{
  "error": {
    "code":"HISTORY_EPOCH",
    "message":"履歴の状態が変わりました。本人情報を再確認してください。",
    "retryable":false,
    "requestId":"opaque-request-id"
  }
}
```

| HTTP/code | client動作 |
|---|---|
| 401 AUTH_REQUIRED / 403 SYSTEM_ADMIN_REQUIRED | 入力/出力/送信停止、本人情報再確認。団員公開まで403維持 |
| 404 NOT_FOUND | 別ownerの存在を明かさない、同UUIDを新ownerとして再送しない |
| 409 HISTORY_EPOCH | identity再取得、旧attempt/outboxを破棄、新試行だけ新epoch |
| 409 CONSENT_REVISION / CONSENT_REQUIRED | 未送信破棄/保存方針確認、自動同意しない |
| 409 OWNER_REVOKED / MEMBER_RECREATED | owner memory/旧データ表示失効、再認証。再所有禁止 |
| 409 REVISION_CONFLICT / SESSION_CONFLICT / PART_CONFLICT / PRESET_IN_USE | 最新版を示し本人操作で再作成、内容を黙って上書きしない |
| 422 INVALID_SCHEMA / INVALID_RATIONAL / INVALID_TEMPO_MAP / UNSUPPORTED_VERSION | field pathと非機密enumを表示、元データ保全 |
| 413 PAYLOAD_TOO_LARGE / 429 RATE_LIMIT | 制限表示、保存のみ停止/適切に待機。再生tempoへ影響させない |
| 409 ACCOUNT_STORAGE_UNAVAILABLE | hidden管理者など、local保存選択を案内。本人同意なしで移管しない |
| 503 DATABASE_UNAVAILABLE | 未送信を同owner/tokenで保持、勝手なファイルfallbackなし |

<a id="migration"></a>
## 9. マイグレーション・ロールバック案

1. 実装時にmigration chain/checksum/017実適用状態/現役ownerをread-only確認し、最新番号で追加する。今回はファイルを作らない。サービス起動時の自動適用は禁止。
2. 使い捨てPostgreSQLで既存chain→追加DDL、再実行skip、失効trigger、既存tuner削除と機能別epoch、同時save/delete/consent、ロック順、バックアップ復元を確認する。
3. 新owner失効triggerは新表だけを掃除、既存tuner動作を維持。production→testの表allowlistに含めないこと、test側member再作成で個人データが消えることを試験する。
4. 通常リリースのDB手順に従い機能offで配布準備、release/protocol/namespaceの一式を照合し管理者実験室で受入後に有効化する。団員公開は別判断。
5. rollbackは機能off→旧アプリへ戻す。新表/所有者失効保護を残しデータを保全する。旧アプリが新表を参照しないことを回帰確認。旧checksumを編集しない。
6. 新表/triggerを撤去する破壊的rollbackは別判断、バックアップ/復元検証/対象件数確認後のみ。owner失効保護を先に外してデータを残す状態を避ける。schema_migrationsの行削除による自動再適用を意図せず起こさない。

現在の共有/本番DBの版/状態、DDL実行性・性能は未検証。今回DB接続/変更、migration生成、コミット/push/デプロイは行っていない。

<a id="tests"></a>
## 10. 契約試験と未完管理

| 対応MT | 必須ケースと合格条件 |
|---|---|
| MT-02/15 | end位置正本、duration拒否、schema未知/危険key/同ID異hash/循環/展開超過を拒否し旧値を保持 |
| MT-06/08/10/19 | 世代/seq/ack不一致、FENCE_MISSED、stop後append、版違い、双方ロードで登録名/processor/URL衝突なし |
| MT-11/12 | Aの旧解析がBを停止しない、Aの有効保存はB開始で失効しない、条件別集約 |
| MT-13 | 固定token、quota待ち→delete、write先行/後行、通知なし/遅延、2接続/2タブ、クラッシュ/409/同意撤回 |
| MT-14 | server本人解決、member_birth/失効、機能別epoch、owner-first同時transaction、失効trigger全表削除、旧tuner無影響 |
| MT-16/17/20 | 校正は端末内、network/ログ/DB/ZIPにprofile/録音/PCM/全FFTなし、補正後要約のみ |

MT-15にはlocalStorageの近満杯/QuotaExceededErrorとIDB quota/upgrade失敗を含め、メトロノーム保存前後のポータルキーbyte比較・ログイン維持・再生継続を確認する。MT-01/02/15は整数tenths/半端四捨五入/範囲外拒否、MT-14はチューナー未使用本人の初回/同時owner作成を必須にする。

H-010対策と音声claim fallbackは**未完**。実ブラウザーSafari/Chromeの2タブ結果と実装ソースを示すまで完了にしない。DDL/JSON Schema/APIは文書上の設計であり、実装・validator・SQL実行試験は今後行う。未完IDは[設計対応表](METRONOME_DESIGN_TRACEABILITY.md#implementation-changes)に影響要件とともに記録する。

## 改訂履歴

| 日付 | 変更 | 影響 |
|---|---|---|
| 2026-10-18 | 初版。専用namespace/protocol、楽譜終点preset、本人保存/機能別epoch、固定token/H-010、専用表/API/rollback案 | MX-01〜19、MP-08/09、MA-04〜08、MQ-06/08/09 |

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

### 2026-10-18 第2回の実装反映（レビュー指摘R-01〜R-09）

| 対象 | 実装した契約 | 影響要件ID |
|---|---|---|
| 3.1 音声claim | 1つのstore `claim` にclaim記録・単調counter（`counter`）・停止ack（`ack:<tabId>`）を別keyで置く（IC-09）。取得・引継ぎ・更新・解放は同じreadwrite transaction。引継ぎは利用者が確認した所有者・世代・heartbeatとのCAS、新ownerは旧タブのackか「旧タブのguardが検証済み＋旧permit期限＋250 ms」の後だけ発音可。それ以外はpending-ownerのまま発音不可。permitは記録更新のcommit後に発行し、壁時計期限2秒・500 msごとに更新。lease単位のguard（全leaseが検証済みの時だけ記録をverifiedにする） | MX-06、MX-15、MQ-06 |
| 5 端末履歴 | `portalMetronomeHistory` を版2に。`budget` storeで履歴DB全体の推定容量を書込・削除と同じtransactionで加減算し、64 MiB超は書込前にBUDGETで拒否（古い記録を自動で消さない）。行の推定容量はUTF-8 JSON＋160 B。詳細は256件ごとの列形式＋文字列辞書（IC-10、見積り約74 B/件）。ownerStateに `bytesUsed` と `lastDeleteAtUtc`、削除時刻より前に始まった試行のトークン確定を拒否（IC-14）。版1からの移行は容量を数え直すだけでデータを消さない | MP-08、MX-11、MX-14、MX-15 |
| 5.1 頻度・枠 | 解析対象16件/秒の評価方法（上の5.1.1、IC-13）。1800秒の記録枠は練習・解析の両方に適用（IC-05撤回）。経過時間は音声フレームで数える | MP-08、MA-01、MX-11 |
| 5.1.2 余剰発音 | 収集時点から詳細を7200件で打切り、総数・理由別件数・最初の打切り位置を記録。保留中の発音は2048件まで（それを超える殺到は理由 `flood` の余剰として数える） | MA-05〜08 |
| 5.1.4 要約 | 256群を超えたら同条件・同層の中で拍位置を統合、それでも超えればアカウント要約を保留（IC-12）。端末は全群を保持。target/valid合計は端末・送信・サーバーで一致 | MA-07、MX-13 |
| 8 API | 変更なし。アカウントのプリセット画面は既存の `/presets` を使う（本人の明示操作だけ） | MB-13 |

DB（019）とAPIの上限は変更していない。端末側の値（74 B/件など）は本実装の見積り式で、ブラウザーの実使用量の計測（MT-13の実ブラウザー）は未完。

### 2026-10-18 第3回の実装反映（再レビューの指摘10件）

| 対象 | 実装した契約 | 影響要件ID |
|---|---|---|
| 3.1 音声claim | 停止ack（`ack:<tabId>`）は、旧タブの全consumerの停止と共有Contextの `suspend()` 完了の後だけ書く（IC-21）。確認できなければackなし。release()の後に完了した取得・引継ぎは自分の記録を削除する（取消世代） | MX-06、MX-15、MQ-06 |
| 5 端末履歴 | budget storeに削除カウンター（key `deleteSeq`）、ownerStateに `lastDeleteSeq`。単一記録の再削除は墓標の差分だけを計上 | MP-08、MX-11 |
| 6.1 開始時固定token | 試行開始時に `ticket()`（その場で作るreadonly transactionで `deleteSeq` を読む）、トークン確定時に `lastDeleteSeq > ticket.seq` なら `STALE_LOCAL_GENERATION`。時計は比べない（IC-14改訂）。ticketでない値は `INVALID_TICKET` | MP-08/09、MX-14/15 |
| 6.3 アカウント送信 | 送信の可否は最終行を書く直前に再判定、同意変更の応答待ち中はoutbox登録・同期をしない。書込中に変わった場合は登録した項目を削除（IC-22） | MP-08、MX-13 |
| 5.1.1 頻度 | 検査範囲はパターンの周期（表示格子と無関係）、表せなければ1800秒（IC-23） | MA-01、MA-05 |

DB（019）とAPIは変更していない。

### 2026-10-18 再開確認・一括解析の境界修正

| 日付 | 修正点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | 6.1本文をIC-14改訂済みのticket/deleteSeq契約に整合。旧時刻比較ではなく、解析開始前のtoken確定と練習のordered ticket、削除と同じscopeを明記 | MP-08/09、MX-14/15 |
| 2026-10-18 | 一括APIの対応窓右端も包含し、同時刻の全発音を追加後に確定する。曖昧性判定と保留上限は維持。MT-16/17の回帰試験2件追加（修正前失敗・修正後合格） | MA-05〜08、MQ-02 |

保存上限・同意・共有／本番DB・API・019のDDLに変更はない。
