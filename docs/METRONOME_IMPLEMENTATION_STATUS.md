# メトロノーム 実装状況

確認日: 2026-10-18（第2回: レビュー指摘R-01〜R-09の修正、未完機能A〜Dの実装。第3回: 再レビューの指摘10件の修正、2.1節）。対象: [基本・詳細設計](METRONOME_DESIGN.md)、[データ/API設計](METRONOME_DATA_API_DESIGN.md)、[実装計画](METRONOME_IMPLEMENTATION_PLAN.md)、[設計対応表](METRONOME_DESIGN_TRACEABILITY.md)。公開範囲はシステム管理者の実験室だけで、団員への公開は別の判断とする（設計1章）。作業はworktree `C:\AITool\okeportal-metronome`（ブランチ `feat/metronome-20261018`、基点 `3b9a3d9`、未コミット）で行った。

| 表記 | 意味 |
|---|---|
| 自動試験済み | 実装済みで、純粋関数・模擬時計・fake-indexeddb・使い捨てPostgreSQLの自動試験が合格 |
| Chromium確認済み | headless Chromium（Playwright）の実ブラウザーで合格（OfflineAudioContext、実時間、実IndexedDB、Web Locks、2タブ）。Safari／iOS／Android／実機ではない |
| 実機未確認 | 実機・実楽器・実音・Safari／PWA・Bluetoothの確認がない。MD-01〜19はすべて未実施 |
| 未完 | 実装していない、または必要な確認がないため完了にしない |

## 1. 全フェーズの判定

全フェーズの機能は実装した。ただし**全フェーズ完了とは表現できない**。各フェーズの完了条件（設計17章）は実機確認（MD-01〜19）を含み、Safari／iOS／Android／Bluetooth／実楽器での確認、先読み・guardの採用値、合格閾値の決定がまだないため（5章の未完）。

| フェーズ | 実装 | 自動試験／ブラウザー | 残る受入条件 |
|---|---|---|---|
| 01a 基盤 | 有理数位置、プリセット検証、秒domainテンポ曲線、イベントコンパイラー、transport（fenceの準備・確認・確定）、3方式の再生backend、共通出力管理 | 自動試験済み、Chromium確認済み（Offline比較・実時間停止） | 先読み・guardの採用値（実機のMT-07/08）、方式の採用決定 |
| 01b 基本画面 | 基本・拍子・設定、TAP、音色、予備拍、タイマー、表示、Wake Lock・振動、設定保存、端末プリセット、実験室組込み、退出・背景・ログアウト停止 | 自動試験済み、Chromium確認済み（E2E） | iPhone／Android／PC初期実機（MD-01〜12） |
| 02 高度なリズム | 4層ポリリズム、カスタムリズム、連符、スウィング、共通格子（256マス超は層ごと）、密度検査、拍子の連続切替 | 自動試験済み、Chromium確認済み | 最大密度・最大tailでの端末負荷 |
| 03 練習 | 無音・ランダム無音・裏拍・拍感、加減速、練習プログラム、テンポ当て、記録（初期off、端末／アカウント、64 MiB予算、30分記録枠） | 自動試験済み、Chromium確認済み（実IndexedDBのH-010順序） | Safariの2タブ（MD-17）、端末容量・永続化の実機 |
| 04 オーケストラ | 楽曲、長休符、テンポ変化、出番予告、フェルマータ、メトリック・モジュレーション、繰り返し、小節番号から再生、指揮の図（打点・軌跡の編集・保存・復元） | 自動試験済み、Chromium確認済み | 実機の表示と音の同期（MD-08）、出番の音声読み上げ（採否保留） |
| 05 演奏解析 | 明示マイク（別Context）、校正（端末だけ・確認付き再利用）、発音検出、有界の対応付け、指標と保留、解析対象16件/秒の事前検査、チューナー同時表示 | 自動試験済み（合成信号）、Chromium確認済み（疑似マイク） | 実楽器の検出精度と合格閾値（合否表示は無効のまま） |

## 2. レビュー指摘R-01〜R-09

各指摘は、再現する回帰試験を先に追加し、修正後に合格を確認した（試験ファイルは3章）。

| ID | 原因 | 修正 | 試験結果 |
|---|---|---|---|
| R-01 | 対応付けが全予定拍×全発音の動的計画表（28800×28800で約7.47 GB）。発音を全件保持 | 窓 min(150 ms, 隣接間隔の45%) が隣同士で重ならないことを使い、順序保存・一対一・曖昧判定を保ったまま予定拍ごとの判断に分解。窓の幅だけ保持するstream処理（O(N+M)）、詳細は予定拍28800・余剰7200で打切り（総数・理由は継続集計、打切り位置を表示）、発音が殺到した場合も保留件数を2048に制限 | 旧動的計画との一致（無作為60例）、28800拍＋余剰86400件で3秒未満・保留200件未満、打切り表示 |
| R-02 | IDB引継ぎが確認時の所有者と照合せず上書き、世代がclaim削除後に再利用、固定2.5秒待ちで安全扱い、Web Lockの遅れた取得を解放しない、permitが所有権と無関係 | 確認した所有者・世代・heartbeatとのCAS、別keyの単調counter、旧タブの停止ackか「検証済みguard＋旧permit期限＋250 ms」でのみ新タブを有効化（それ以外は準備中のまま発音不可）、permitは所有権の確認（IDBはcommit後）ごとに発行・500 ms更新・壁時計期限、Context停止・claim喪失で全permit失効、取得待ちの撤回後に来たロックを即解放、lease単位のguard（全leaseが検証済みの時だけverified）。同じ管理をチューナーにも適用 | 自動試験（CAS拒否・第三タブ・ack待ち・検証済みguard・世代不再利用・DB失敗・Context停止・遅れたロック）、Chromium 2タブ（Web Locksの使用中表示、IDBの確認付き引継ぎで旧タブが停止→新タブ再生） |
| R-03 | fenceの応答前にtransportの正本（区間・現在snapshot）を切替、accepted:falseを無視、timeout時に半端な状態、WorkletのreplaceFromが容量不足で旧キューを破壊、古いstopが世代を戻す | transportを準備→ack→確定にし、確定前は旧テンポマップ・旧revisionで位置と条件を計算（区間の履歴で、fence前は旧・後は新）。accepted:falseは旧計画を継続、timeoutは中断、古い世代のackは無視、編集は直列。Workletは容量確認後にだけ置換、世代は単調、取消・遅いfenceで鳴っている音の尾を両backendで同じ規則（取消位置以後に始まった音を5 msでfade）。画面は「適用予定」→確定後に告知 | 自動試験（保留中の位置・拒否・timeout・古いack・連続編集・pause競合、Worklet処理器の容量拒否・古いstop・permit・取消fade）、Chromium実時間（編集応答・pause・停止の反応を計測） |
| R-04 | 解析対象頻度が小節のpulse数だけで、細分（32分）や連符・層・曲線を無視（300BPM・32分＝40件/秒を5件/秒と判定） | 実際のコンパイル済みexpectedイベント列（収集と同じ判定関数）で、解析開始位置から1800秒（または1周期＋1秒）の任意の半開1秒窓の最大件数を数える。解析開始前と、解析中の編集適用前（edit guard）に検査、超過は理由を表示して拒否、クリック単独は継続可 | 300BPM・32分＝拒否、120BPM・32分＝16件で許可、2層合算、加減速中の密集区間を検出、休符はexpectedに数えない |
| R-05 | 保存オフ後もトークン待ちの処理が書込を開始、削除後に得たトークンで削除前の観測を保存し得た | 保存選択・所有者・削除・同意・同期の世代を分離し、各await後と各書込直前に確認。削除時刻を記録し、それより前に始まった試行のトークン確定を拒否。半端な記録は保存オフ時に削除。古い試行の正常な保存は新試行の開始で無効にしない | 遅延identity＋保存オフ、別タブ全削除、同意撤回、ログアウト、DC-19、Chromium実IndexedDBの2タブ削除競合 |
| R-06 | 64 MiBが定数だけ、詳細1件が見積り512 B（設計の5記録に入らない） | 履歴DB全体（全本人・詳細・辞書・outbox・墓標）の予算を同じtransactionで加減算し超過は書込前に拒否（BUDGET）。詳細を256件ごとの列形式＋文字列辞書に変更（見積り約74 B/件、許容291 B/件）。記録開始前に予算とoriginの空きを確認、保存待ち10件・メモリー結果20件の上限、使用量表示・書出し・本人操作だけのpersist要求。他のポータルキーに触れない | 予算の加減算と拒否、実測見積り、v1→v2移行、書出しの範囲、保存待ちの上限 |
| R-07 | マイク開始が1つのcaptureを共有し、古い成功・失敗・終了が新しいcaptureを止め得た。保存済み校正を同じブラウザー系統・sampleRateだけで有効化 | 開始ごとのcapture sessionと世代、古いsessionの結果は無視。経路キーにOS・ブラウザー主版・入力機器名のhash。保存済み校正はキー・解析版・30日以内が一致する候補で、本人の確認で初めて有効。読込・保存・削除は要求番号で遅着を無視 | 自動試験（キー・版・期限の判定）、Chromium（疑似マイクの開始・停止でクリック継続） |
| R-08 | 条件キーに瞬間BPMを入れ加減速中の各拍を別条件化、境界判定が全層共通、256群超を切捨て | 条件キーはrevision・小節構造・層・経路・校正・解析版・出力。境界はrevisionか実行（世代）が変わった後の層ごとの最初の拍だけ。同時刻の2層は1つの複合拍。256群超は同条件内で拍位置を統合、なお超えればアカウント要約を保留（端末は全群保持）。target/valid合計は端末・送信・サーバーで一致 | 加減速は1条件、2層の境界、257群・257条件、複合拍、合計一致 |
| R-09 | IC-05（30分超を端末だけに保存）が確定済みの1800秒記録枠と矛盾、表示の間隔で経過時間を過少計上 | IC-05を撤回。練習・解析とも記録は1800秒で一度閉じ、クリックとプログラムは継続、新しい記録は本人の操作で開始。経過時間は音声フレームで計測（表示が遅れても減らない、一時停止・中断では止まる）。DDL・APIの1800000 msは変更なし | 15分間の表示停止を含む1800秒の区切り、続きの新記録、一時停止の除外 |

## 2.1 第3回レビューの指摘（P1 1〜6、P2 7〜10）

再現手順（レビュー側の `repro.cjs`・`view-repro.cjs` と同じ条件）を `tests/frontend/test_metronome_review_round3.test.js` に回帰試験として追加し、修正後に合格を確認した。レビュー側の再現スクリプトも修正後のコードで再実行し、10件とも再現しないことを確認した（同一ミリ秒の件は、時刻を渡す旧呼び出しが `INVALID_TICKET` で拒否されるようになったため、新しい順序の試験で確認）。

| No | 原因 | 修正 | 試験結果 |
|---|---|---|---|
| 1（P1／R-03） | 編集の直列chainが、待機中の編集の受付時の世代を見ていなかった。停止→再生の後に古い編集Bが新しい再生で実行された | 編集は受付時の再生世代に属し、chainで順番が来た時に世代が変わっていれば実行せず `stale` で終える（IC-20）。画面は、最新の編集が古くなった場合だけ直前に確定した設定へ戻す。新しい再生は開始時の設定を読み込む | 停止→再生→Aの応答の順で、Bはbackendへ送られず、新しい再生は120 BPM・revision 1のまま。停止中の編集は次の開始に反映 |
| 2（P1／R-05） | アカウント送信の可否（toAccount）を保存開始時に1回だけ計算していた。同意撤回の応答待ちの間に、最終保存・outbox登録・同期開始まで進んだ | 端末保存とアカウント送信の有効性を分離（IC-22）。送信の可否は最終行を書く直前に再計算し、同意変更の応答待ち中は登録も同期も始めない。書込中に同意が変わった場合は、登録したoutbox項目を同期前に削除し、端末の記録だけ残す | 詳細書込中の撤回で最終行は `enqueue:false`、同期0回。最終行の書込中の変更でoutbox項目を削除、同期0回 |
| 3（P1／R-05・IC-14） | 試行開始時刻と削除時刻を壁時計で比べていた。同一ミリ秒では削除前の試行が受理され、時計を戻すと削除後の試行が拒否された | IC-14を改訂。試行開始時に、DB全体の削除カウンター（budget storeの `deleteSeq`）をその場で作ったreadonly transactionで読む（ticket）。IndexedDBは重なるtransactionを作成順に実行するため、削除はticketの前か後かのどちらかに決まる。トークン確定時に、ticketの後に削除された所有者の試行を拒否する。時計は比べない。DBが未openでticketの位置が決まらない場合（ordered:false）は、先に鳴らす練習では保存しない（`NOT_READY`）。時刻を渡す旧呼び出しは `INVALID_TICKET` で拒否 | 同一ミリ秒の削除で拒否、時計を戻した後の新試行は受理（fake-indexeddb）。Chromiumの2タブ（別connection、同じ時刻）でも削除後のトークンが拒否され、新試行は受理 |
| 4（P1／R-02） | 所有権喪失の通知直後に停止ackを書いていた。停止処理（Workletへの非同期メッセージ）の完了を待っていなかった | ackは「出力が実際に止まった」ことの表明とし、全consumerの停止Promiseと、共有Contextの `suspend()` の完了（音声threadがそのContextを描画しない）を待ってから書く（IC-21）。喪失時はmasterを即0にする。完了を確認できなければackを書かず、新タブは検証済みguard＋permit期限、またはackを待ち続ける（安全側）。次の再生には新しいタップが必要で、その時にmasterを戻す | 停止が完了しない場合は新タブが発音不可、完了後にack→新タブが所有者。出力管理でsuspendの完了前は新タブ不可、完了後に可、中断の二重通知なし |
| 5（P1／R-04） | 表示用の格子が大きい（perLayer）場合、検査範囲を64小節で打ち切っていた | 検査範囲を表示上限から分離し、小節と全層の周期の公倍数（パターンの周期）で決める（IC-23）。予定拍は無音の乱数に依存しないため、1周期で以後を代表する。周期が表せない場合は1800秒全体 | 100全音符周期・160〜160.32秒に17件の例で拒否（at 160.32秒） |
| 6（P1／R-03・R-08） | 解析画面は250 ms先まで予定拍を取り込むが、fenceの確定で旧予定拍を撤回せず、一時停止・停止・中断で鳴らなかった予定拍も欠落として数えた | 対応付けに `withdrawFrom`（未確定の予定拍だけを撤回、確定済みは変えない）を追加。fenceの確定（`fenceApplied`）でfence以後を撤回し、適用位置から取り込み直す（遅いfenceは、fenceから適用位置までは何も鳴らないため撤回だけ）。一時停止は取消位置以後、解析の終了時は現在の出力位置より後を撤回（IC-24） | 撤回は未確定の拍だけ。レビュー側の画面再現で旧拍が残らない（置換後の拍は鳴る前に停止したため欠落にもならない） |
| 7（P2／R-02） | IDBのclaim取得に取消世代がなく、acquire直後のreleaseの後に取得が完了するとheldになった | Web Locksと同じ規則で、release()がrequest世代を上げ、遅れて完了した取得・引継ぎは自分が書いた記録を削除して `released` を返す | 取得完了後もheldにならず、別タブが取得できる |
| 8（P2／A） | 同時表示adapterは通常のクリックをチューナーの出力除外へ通知していなかった。`setConcurrentAllowed()` を呼ぶ製品コードがなかった | adapterはチューナーの実行中、鳴ったクリックを外部出力（`external:true`）として通知し、チューナーは測定中ならsimultaneous宣言がなくても除外区間にする（基準音の再生状態は変えない）。出力の同時使用は、チューナーの音の画面の「同時に使う」＋「イヤホン」（既存の明示選択）だけが許可し、チューナーの退出で戻す。同時使用を切ると最も古いlease以外を止める（IC-25） | adapterの通知（鳴った分だけ・二重なし）、チューナー側の除外区間、明示選択前はOUTPUT_BUSY・選択後は両立・解除で1つに。製品コードの接続の契約試験 |
| 9（P2／R-06） | 同じ記録の再削除で、既存の墓標の容量を差し引かずに再計上した | 再削除は墓標を置き換え、差分だけを計上（最初の削除時刻を保持） | 3回削除しても計上値が変わらない |
| 10（P2／R-01） | 一括API（align／analyze）が全発音を先に追加してから処理し、保留上限2048で正しい発音を余剰にした | 一括APIも逐次処理（予定拍を少し先まで追加、同時刻の全発音を追加後にadvance）。再開確認で窓右端を包含する順序も補正 | 3000拍・3000発音で有効3000・余剰0。1000/1100 msの予定拍と1045 msの発音で右端も対応。同時刻の2候補は曖昧として除外 |

範囲: 自動試験（Node・fake-indexeddb・模擬画面）とheadless Chromium。Chromiumの引継ぎ試験は、新タブの時計だけを20秒進め、旧タブの主スレッドを6秒止める条件であり、実際の15秒失効待ちや音の重複の計測ではない。実音の二重発音、Safari、実機（MD-01〜19）は未確認。

## 3. 未完機能A〜D

| ID | 実装 | 試験 | 残り |
|---|---|---|---|
| A チューナー連携 | チューナーの基準音・音源パターンを共通出力管理のleaseで再生（Context・claim・Audio Session・master 0.25を一本化、音量は従来と同じ絶対値）。チューナー画面にclaimの保持と解放、別タブ使用中・メトロノーム使用中の案内。チューナーの「メトロノーム」課題を新エンジンへ接続（音あり＝同時使用とイヤホン申告が必要のまま、光の拍も音声時計、出力区間を統計除外へ通知）。メトロノームの解析画面にチューナーの同時表示（表示だけではマイクを使わず、明示ボタンで開始、閉じると自分が開始した分だけ終了）。チューナーのreleaseに共通音声のidを含める | 自動試験（独自Context／lease、排他、取消、課題のlease、表示の開始・終了、名前空間・URL・releaseの非衝突）、既存チューナーE2E（停止後はleaseなし、退出でContext終了に期待値を変更） | 実機での同時使用・混入（MD-13）、旧タイマー経路はメトロノームの部品未読込時の予備として残る |
| B アカウントのプリセット | 設定画面から明示的に開く画面。今の設定（基本・高度・楽曲の連鎖）の保存、一覧、呼び出し、削除（参照中は拒否）、端末のプリセットを1件ずつ送る操作。同意、未知の版の読み取り専用表示、容量・競合・オフラインの表示。端末データを自動では送らない | 自動試験（連鎖の組立て、エラー表示、API・DB試験は前回のもの） | 実機・実アカウントでの確認 |
| C 指揮表示 | 打点の数値入力・44 pxの移動ボタン・図のドラッグ、拍グループ数との整合検査、型へのリセット、楽曲（打点を含む）の端末保存・呼び出し。reduced-motionは打点と番号だけ | 自動試験（整合・移動・連鎖） | iPhoneでのドラッグ操作と音声時計との同期の実機確認（MD-08/10） |
| D 再生方式の比較 | AudioWorklet・main先読み・短buffer（0.5秒chunk）を同じイベント列で切替可能（設定の比較用項目）。Chromiumで比較を自動化 | Chromium Offline（3方式の発音位置が一致、理論位置との差1 sample以内）、実時間停止0.5H〜2H・2秒と反応時間（4章） | 実機での計測。200〜300 ms等は採用値にしない（調整値のまま） |

Worker（compiler／解析）の判断: 対応付けはR-01でO(N+M)・有界になり、28800拍＋余剰86400件の処理が3秒未満（Node）、1回の表示更新で扱うのは窓の幅だけである。コンパイルは数拍ずつで、Chromiumの実時間計測で主スレッドの停止がない限り遅刻は0件だった。したがって今回はWorkerを作らない（IC-07）。主スレッドが原因の遅刻が実機で出た場合（MT-07/MD-07）に見直す。

## 4. 計測した値（headless Chromium、デスクトップ。実機の値ではない）

`npx playwright test tests/e2e/metronome_backends.spec.js` の結果（`.tmp/metronome-backend-offline.json`／`-realtime.json`、共有ZIP対象外）。 再開後の再測定（2026-10-18T10:50:38.663Z、headless Chromium、1 worker）へ更新。以下は今回の観測値で、反応時間・欠落数の保証値でも採用値でもない。

| 項目 | AudioWorklet（先読み1.0秒） | main（0.3秒） | 短buffer（0.3秒） |
|---|---|---|---|
| Offline: 発音位置の理論値との差 | 最大1 sample | 最大1 sample | 最大1 sample |
| Offline: 3方式の発音位置 | 一致 | 一致 | 一致 |
| 主スレッド停止0.5H／H | 欠落0／0 | 0／0 | 0／0 |
| 停止1.5H／2H | 遅刻2／（2秒）許可切れ8 | 遅刻1／1 | 遅刻1／2 |
| 停止2秒 | 許可切れで破棄8（数えて記録） | 遅刻7＋許可切れ1 | 遅刻7＋許可切れ1 |
| 位相のずれ・二重予約 | なし | なし | なし |
| 編集の応答（ack）／fenceまでの余裕 | 1.1 ms／138 ms | 0.4 ms／249 ms | 0.4 ms／270 ms |
| pauseの応答／取消位置までの余裕 | 0.3 ms／229 ms | 0.1 ms／337 ms | 0.2 ms／357 ms |

停止2秒でAudioWorkletが破棄したのは、壁時計の出力許可（2秒）が切れたためで、設計どおりの安全側の動作（追いつき連打なし）。

記録の端末容量の見積り（`tests/frontend/test_metronome_review_storage.test.js`、本実装の見積り式でありブラウザーの実使用量ではない）: 詳細1件あたり約74 B（列形式）、1記録の上限36000件で約2.6 MiB。

## 5. 未完（完了にしないもの）

| ID | 内容 | 必要な確認 |
|---|---|---|
| M-OPEN-01 | 先読み・guard・停止反応の採用値と方式の決定 | 実機のMT-07/08・MD-07/08（4章はheadlessの比較値） |
| M-OPEN-02 | H-010と音声の引継ぎ・二重発音の実機確認 | Chromiumの2タブは確認済み（時計をずらし主スレッドを6秒止める条件、削除順序は別connection）。実際の15秒失効待ち・音の重複の計測、SafariのMD-17、旧タブ復帰時の実音（MD-19）は未確認 |
| M-OPEN-03 | 発音検出・校正の実楽器精度と合格閾値 | MT-16/17の拡張、MD-14/15。合否表示は無効のまま |
| M-OPEN-05 | 全端末・30分・光・割込み・電池・Bluetooth | MD-01〜19（[手動確認](MANUAL_DEVICE_QA_CHECKLIST.md)7-12、全項目未実施） |
| M-OPEN-07 | 団員公開、出番の音声読み上げ | 公開は別判断、読み上げは採否保留 |
| M-OPEN-10 | 共有テスト環境DB・本番DBへの019の適用 | 通常のリリース手順。今回は未適用（019の変更なし） |
| M-OPEN-11 | 端末容量の実測（索引込み、5記録、eviction、永続化拒否） | 実ブラウザーのMT-13（今回は見積り式とfake-indexeddb、Chromiumの順序だけ） |

## 6. 変更ファイル（第2回）

| 区分 | ファイル |
|---|---|
| 共通出力 | `src/static/js/modules/audio/output_manager.js`（page manager、CAS引継ぎ、counter、ack、permit、lease guard） |
| 再生・transport | `metronome/click_processor.js`（protocol 2）、`playback.js`（短buffer追加）、`transport.js`（準備・確認・確定）、`index.js`、`settings.js`、`view.js` |
| 解析 | `timing_analysis.js`（stream aligner、targetRate、条件追跡、群の統合／保留）、`calibration.js`（capture session、経路キー、候補）、`view_analysis.js`、`tuner_adapter.js`（新規） |
| 保存・練習 | `storage_local.js`（DB v2、予算、列形式、削除時刻、書出し）、`storage_remote.js`（プリセットAPI）、`workspace.js`（世代、上限）、`trainer.js`（音声フレーム計時、30分記録枠）、`view_practice.js` |
| 楽曲・プリセット | `view_score.js`（打点編集、楽曲の保存・呼び出し）、`view_account_presets.js`（新規）、`launcher.js`（engine読込、依存の追加）、`src/static/css/metronome.css` |
| チューナー | `tuner/playback.js`（共通出力provider）、`tuner/index.js`（provider・claim・案内・出力通知）、`tuner/view_trainer.js`（課題の新エンジン接続）、`tuner/launcher.js`（共通音声の読込とid）、`scripts/generate_tuner_release.mjs`（共通音声idを含める） |
| 試験 | `tests/frontend/test_metronome_engine_contracts.test.js`、`test_metronome_review_fixes.test.js`、`test_metronome_review_storage.test.js`、`test_tuner_shared_output.test.js`（新規）、既存のメトロノーム試験とチューナー契約試験の更新、`tests/e2e/metronome_backends.spec.js`、`metronome_two_tabs.spec.js`（新規）、`tests/e2e/tuner.spec.js`（停止後の期待値） |
| 文書 | 本書、設計・データ/API設計・対応表の改訂、`docs/MANUAL_DEVICE_QA_CHECKLIST.md`（7-12の注記）、`docs/TUNER_ADVANCED_IMPLEMENTATION_STATUS.md`（共通出力への移行） |

第3回で変更したファイル（第2回の変更に追加）:

| 区分 | ファイル |
|---|---|
| 共通出力 | `audio/output_manager.js`（停止完了後のack、喪失時のmaster消音とsuspend、IDB取得の取消世代、同時使用の解除） |
| 再生・transport | `metronome/transport.js`（編集の世代）、`metronome/index.js`（古い編集の画面復元、leaseの同時使用可、制御文字の正規表現をエスケープ表記に） |
| 解析 | `timing_analysis.js`（周期による検査範囲、`withdrawFrom`、一括APIの逐次処理）、`view_analysis.js`（予定拍の撤回と取り込み直し、案内文）、`tuner_adapter.js`（クリックの外部出力通知） |
| 保存 | `storage_local.js`（削除ticket・`deleteSeq`、再削除の差分計上）、`workspace.js`（送信可否の分離と直前確認、ticket）、`view_practice.js`（練習の試行は `observing`） |
| チューナー | `tuner/index.js`（同時使用の宣言を共通出力へ、退出で解除）、`tuner/workspace.js`（外部出力の除外） |
| 試験 | `tests/frontend/test_metronome_review_round3.test.js`（新規）、`test_metronome_review_storage.test.js`（IC-14の試験をticketに）、`test_tuner_workspace.test.js`（外部出力）、`tests/e2e/metronome_two_tabs.spec.js`（ticketの2タブ試験を追加、H-010試験をticketに） |
| 生成物 | release id（メトロノーム・共通音声・チューナー）を再生成 |

DB（`db/migrations/019_metronome_practice.sql`）とサーバーのAPIは第2回・第3回で変更していない（30分の上限と要約の上限はすでに一致していたため）。019は使い捨てDBで適用・再実行スキップを確認済みで、共有／本番には未適用。

## 7. 最終確認の結果

2026-10-18、worktree `C:\AITool\okeportal-metronome`（未コミット）で再開後に確認。Pythonは同worktreeの.venvを使用し、DB試験はID・イメージ・ループバック公開ポートを照合した専用コンテナだけで実行。

| 確認 | 結果 |
|---|---|
| `uv run python -m compileall -q src/backend tests` | 成功 |
| `uv run ruff check .` | 成功 |
| `uv run pytest` | 705件成功、3件skip（専用DSN未設定のmenu-settings・promotion試験）。メトロノームのDB試験は接続先を確認した使い捨てローカルDB（Docker）で実行 |
| `npm run check:frontend:syntax` | 164ファイル成功 |
| `npm run check:frontend:load-order`／`check:frontend:state-access` | 成功（違反0件） |
| `npm run test:frontend`相当（Vitest、frontend＋integration） | 再開後に100ファイル・1079件成功。一括解析の窓右端・同時刻候補の回帰試験2件を追加（追加前1077件） |
| E2E（headless Chromium） | 再開後はmetronome・backends・two_tabs・tunerの4 specを1 workerで実行し43件成功（2.7分）。一時データと127.0.0.1:18019のサーバーを使用。全体は今回再実行していない。第3回の引継ぎログでは全体69件成功・1件失敗（attendance.spec.js、HEADでも失敗。練習時間の再表示と古い期待値の不一致）。範囲外の出欠試験は変更していない |
| 並列負荷時の揺れ | 2タブ試験の主スレッド停止（6秒）と同時に `ui_css` 系が1回だけ時間切れになったことがある。停止を14秒から6秒に短縮した後の一括実行では再発なし |
| `check:tuner-release`／`check:metronome-release` | 再開後に整合確認（`t-b0635dde6c4d`、`m-d398086cbcb2`、共通音声 `a-bab6e0cd35e7`） |
| `npm run check:release-safety` | 成功 |
| 文書 | 97要件が要件表・本書9章・対応表で一致、未定義のMT/IC参照なし、IC-01〜25あり。追加・変更した文書はUTF-8・BOMなし・LF・行末空白なし（既存のCRLF文書は形式を維持） |
| 実機（MD-01〜19） | 全項目未実施 |
| 共有ZIP | 作成していない（`npm run zip:source` は未実行） |

## 8. DB適用と戻し方

- 適用: 通常のリリース手順で `scripts/migrate_db.py` を実行する（アプリ起動時には適用しない）。019は追加だけで、017の表・関数・トリガーを変更しない。
- 確認: `schema_migrations` に `019` があり、`tuner_owners` にトリガー `trg_metronome_owner_revoked` があること。システム管理者で `/api/metronome/identity` がエラーにならないこと。
- 本番→テストの同期: 同期対象は許可リスト（`scripts/sync_prod_to_test_preflight.py` の `TARGET_DB_TABLES`）で、メトロノームの表は含まれない（契約試験で確認）。
- 戻し方: 前の版のアプリはメトロノームの表を参照しないため、アプリだけを戻せる。表を消すと記録の削除になるため、バックアップを取ってから別の手順で行う。`schema_migrations` の行を消して再適用を起こさない。
- 端末側: 履歴DBは版2（予算の表を追加）。版1のデータは移行時に容量を数え直し、削除しない。

## 9. 97要件の状況

状態は1章の表記による。「実機未確認」の要件は、自動試験・Chromiumで確認していても実機のMD項目が残る。試験の略称: model=`test_metronome_model`、transport=`test_metronome_transport`、engine=`test_metronome_engine_contracts`、phases=`test_metronome_phases`、history=`test_metronome_history`、review=`test_metronome_review_fixes`、storage=`test_metronome_review_storage`、shared_output=`test_tuner_shared_output`、helpers=レビュー試験のB/C、backend=`tests/backend/test_metronome_practice_*`、E2E=`tests/e2e/metronome*.spec.js`。

| ID | 実装箇所 | 自動試験・ブラウザー | 状態 | 残る確認 |
|---|---|---|---|---|
| MB-01 | score_model, view, index | model, E2E | 自動試験済み・Chromium確認済み・実機未確認 | MD-10 |
| MB-02 | index, output_manager, launcher | E2E（マイク0） | Chromium確認済み・実機未確認 | MD-01 |
| MB-03 | tap, view | model | 自動試験済み・実機未確認 | MD-10（物理遅延） |
| MB-04 | score_model, view | model | 自動試験済み・実機未確認 | MD-09 |
| MB-05 | score_model（IC-02）, index | model | 自動試験済み | — |
| MB-06 | event_compiler, view | model | 自動試験済み | — |
| MB-07 | sounds（合成） | model, Offline | 自動試験済み・Chromium確認済み | 短sample素材は未選定 |
| MB-08 | output_manager, playback | engine, Offline（peak≤1） | 自動試験済み・Chromium確認済み・実機未確認 | MD-02（音量・経路） |
| MB-09 | transport, event_compiler | transport | 自動試験済み・実機未確認 | MD-09 |
| MB-10 | index（音声時計） | E2E | Chromium確認済み・実機未確認 | MD-08 |
| MB-11 | index（補助） | — | 実装済み・実機未確認 | MD-06 |
| MB-12 | index, trainer（音声フレーム） | storage（R-09） | 自動試験済み・実機未確認 | MD-03 |
| MB-13 | settings, presets, view_account_presets | model, history, helpers | 自動試験済み・実機未確認 | MD-18 |
| MB-14 | transport（pause/resume） | transport, engine | 自動試験済み・実機未確認 | MD-09 |
| MS-01 | score_model | model | 自動試験済み | — |
| MS-02 | score_model, view | model | 自動試験済み | — |
| MS-03 | score_model, view | model | 自動試験済み | — |
| MS-04 | index（速度維持換算） | model | 自動試験済み | — |
| MS-05 | score_model, view_score | phases | 自動試験済み | — |
| MS-06 | view_advanced（連続切替）, view_score | phases, E2E | 自動試験済み・Chromium確認済み | — |
| MS-07 | transport（fence） | transport, engine | 自動試験済み・Chromium確認済み・実機未確認 | MD-09 |
| MR-01 | score_model, event_compiler | model | 自動試験済み | — |
| MR-02 | rational, score_model | model | 自動試験済み | — |
| MR-03 | score_model（tuplet）, view_advanced | model, phases | 自動試験済み | — |
| MR-04 | event_compiler（層）, view_advanced | phases, Offline | 自動試験済み・Chromium確認済み | — |
| MR-05 | event_compiler.polyGrid, view_advanced | phases | 自動試験済み | — |
| MR-06 | event_compiler.applySwing（IC-01） | phases | 自動試験済み | — |
| MR-07 | score_model（rhythm）, view_advanced | phases, review（R-04） | 自動試験済み | — |
| MR-08 | event_compiler（offbeat/mask） | phases | 自動試験済み | — |
| MP-01 | trainer（段階テンポ） | phases | 自動試験済み | — |
| MP-02 | tempo_map, view_practice（加減速） | model, phases | 自動試験済み | — |
| MP-03 | event_compiler（emitだけ） | phases | 自動試験済み | — |
| MP-04 | event_compiler（seed hash） | model | 自動試験済み | — |
| MP-05 | event_compiler（beatFeel） | phases | 自動試験済み | — |
| MP-06 | trainer, view_practice | phases | 自動試験済み | — |
| MP-07 | trainer（validateProgram） | phases | 自動試験済み | — |
| MP-08 | workspace, storage_local, storage_remote, API, 019 | history, storage, backend, E2E | 自動試験済み・Chromium確認済み・実機未確認 | MD-18、MT-13の実容量 |
| MP-09 | trainer, workspace（世代） | history, storage | 自動試験済み・実機未確認 | MD-16 |
| MO-01 | view_score（長休符） | phases | 自動試験済み | — |
| MO-02 | event_compiler（cue）, view_score | phases | 自動試験済み | 音声読み上げは採否保留 |
| MO-03 | view_score（打点編集・軌跡） | phases, helpers | 自動試験済み・実機未確認 | MD-08/10（iPhoneのドラッグ） |
| MO-04 | tempo_map, view_score | model, phases | 自動試験済み | — |
| MO-05 | transport（waiting） | transport | 自動試験済み・実機未確認 | MD-09 |
| MO-06 | tempo_map（modulation） | phases | 自動試験済み | — |
| MO-07 | transport（seek）, view_score | transport | 自動試験済み・実機未確認 | MD-09 |
| MA-01 | onset_adapter, calibration（capture） | phases | 自動試験済み・実機未確認 | MD-15 |
| MA-02 | view_analysis（明示開始、別Context） | E2E | Chromium確認済み・実機未確認 | MD-13 |
| MA-03 | onset_adapter（品質区分） | phases | 自動試験済み・実機未確認 | MD-15（混入） |
| MA-04 | timing_analysis.calibrate, calibration（候補・確認） | phases, review | 自動試験済み・実機未確認 | MD-14 |
| MA-05 | timing_analysis（stream aligner） | review（R-01） | 自動試験済み・実機未確認 | MD-15 |
| MA-06 | timing_analysis（統計） | phases | 自動試験済み | — |
| MA-07 | timing_analysis（条件・群） | review（R-08） | 自動試験済み | — |
| MA-08 | timing_analysis（n・除外・保留） | phases, review | 自動試験済み | 最低n・閾値は未決定 |
| MA-09 | tuner_adapter（同時表示）, view_analysis | shared_output | 自動試験済み・実機未確認 | MD-13 |
| MA-10 | onset_adapter（合成試験） | phases | 自動試験済み | — |
| MA-11 | — | — | 未完 | 実楽器の受入（MD-15） |
| MU-01 | view.renderBasic | E2E | Chromium確認済み・実機未確認 | MD-10/12 |
| MU-02 | view.renderRhythm | E2E | Chromium確認済み・実機未確認 | MD-12 |
| MU-03 | view_advanced | E2E | Chromium確認済み・実機未確認 | MD-12 |
| MU-04 | view_practice | E2E | Chromium確認済み・実機未確認 | MD-12 |
| MU-05 | view_score | E2E | Chromium確認済み・実機未確認 | MD-12 |
| MU-06 | view_analysis | E2E | Chromium確認済み・実機未確認 | MD-12/13 |
| MU-07 | view.renderSettings, view_account_presets | E2E, helpers | Chromium確認済み・実機未確認 | MD-12/18 |
| MU-08 | metronome.css | E2E（375 px、44 px） | Chromium確認済み・実機未確認 | MD-10 |
| MU-09 | index（静的表示・reduced-motion） | E2E | Chromium確認済み・実機未確認 | MD-11（WCAG2.3.1の実測） |
| MU-10 | view（タブ） | E2E | Chromium確認済み | — |
| MX-01 | rational, score_model | model | 自動試験済み | — |
| MX-02 | tempo_map | model, phases | 自動試験済み | — |
| MX-03 | event_compiler, transport（tag） | model, engine | 自動試験済み | — |
| MX-04 | transport（準備・確認・確定） | engine（R-03）, 実時間 | 自動試験済み・Chromium確認済み・実機未確認 | MD-09 |
| MX-05 | playback, click_processor（遅刻は破棄・計数） | engine, 実時間 | 自動試験済み・Chromium確認済み・実機未確認 | MD-07 |
| MX-06 | output_manager（共通出力、入力分離）, tuner/playback | engine, shared_output | 自動試験済み・実機未確認 | MD-13 |
| MX-07 | index, view_analysis（outputTimestamp） | — | 実装済み・実機未確認 | MD-08 |
| MX-08 | playback（3方式） | Offline・実時間比較 | Chromium確認済み | 方式の採用は実機計測後 |
| MX-09 | output_manager（gesture、Audio Session） | engine | 自動試験済み・実機未確認 | MD-01/02 |
| MX-10 | score_model, settings, presets（版・未知版） | model | 自動試験済み | — |
| MX-11 | workspace（初期off） | history | 自動試験済み・実機未確認 | MD-18 |
| MX-12 | API, repository, 019 | backend（使い捨てDB） | 自動試験済み | 共有／本番DBに未適用 |
| MX-13 | 019, repository | backend（使い捨てDB） | 自動試験済み | 共有／本番DBに未適用 |
| MX-14 | transport, workspace, calibration（世代） | engine, storage, review | 自動試験済み | — |
| MX-15 | output_manager（claim・permit）, storage_local（token） | engine, 2タブ | 自動試験済み・Chromium確認済み・実機未確認 | Safari・実機（MD-17/19） |
| MX-16 | improvement_suggestions, routes（管理者のみ） | E2E（団員は表示なし） | Chromium確認済み | 団員公開は別判断 |
| MX-17 | launcher, routes（portalAppState） | E2E, 契約試験 | 自動試験済み・Chromium確認済み | — |
| MX-18 | release生成（m-/a-/t-） | release check, shared_output | 自動試験済み・実機未確認 | MD-19（旧cache） |
| MX-19 | 全体（録音・PCM非保存） | backend契約, release safety | 自動試験済み | — |
| MQ-01 | playback | Offline比較 | Chromium確認済み・実機未確認 | MD-07 |
| MQ-02 | event_compiler.preflight | model | 自動試験済み | 端末負荷の上限は実機後 |
| MQ-03 | output_manager, playback | Offline（peak） | Chromium確認済み・実機未確認 | MD-07（30分） |
| MQ-04 | transport, backend | 実時間停止 | Chromium確認済み・実機未確認 | MD-07（実機・GC・30分） |
| MQ-05 | — | — | 未完 | MD-01〜19（全端末） |
| MQ-06 | transport, output_manager | engine, 2タブ | 自動試験済み・Chromium確認済み・実機未確認 | MD-09/17 |
| MQ-07 | index（光の刺激を抑えた表示） | — | 実装済み・実機未確認 | MD-11 |
| MQ-08 | tuner（共通出力移行） | チューナー契約・E2E | 自動試験済み・Chromium確認済み・実機未確認 | MD-13/19 |
| MQ-09 | 全体 | pytest, release safety | 自動試験済み | — |
| MQ-10 | 文書 | — | 文書 | — |
| MQ-11 | 文書 | 文字コード確認 | 確認済み | — |
| MQ-12 | MANUAL_DEVICE_QA_CHECKLIST 7-12 | — | 文書（項目は未実施）・実機未確認 | MD-01〜19 |

## 改訂履歴

| 日付 | 修正点 | 影響要件ID |
|---|---|---|
| 2026-10-18 | 上限停止から再開し、第3回10件の修正・回帰試験とGit状態を確認。一括解析の窓右端・同時刻候補の処理順を修正し、2試験の失敗→合格を確認。設計本文6.1を既存の削除ticket契約へ整合 | MA-05〜08、MQ-02、MP-08/09、MX-14/15 |
| 2026-10-18 | 7章の試験件数・release ID・今回の対象E2Eと引継ぎログの全体E2Eを区別して更新。107ファイルの開始時コピーとSHA-256を管理外の.tmpに保持。新しい調整値・機能選択・DB/API変更はなし | MX-17/18、MQ-09〜12 |

今回追加した本体修正はtiming_analysisの対応窓の処理順だけで、その他のメトロノーム資産の変更はrelease IDの生成更新。チューナー・共通音声・backend・019・他の未コミット作業は再開時の内容を維持。実音・実機・Safari・実容量の未完項目は5章のまま。コミット・push・デプロイ・共有ZIP作成・共有／本番DB適用は行っていない。
