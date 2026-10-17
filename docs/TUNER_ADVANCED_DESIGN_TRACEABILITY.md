# 高機能チューナー 設計対応表 Ver.1.0

作成日: 2026-10-17。調査用の[201要件](TUNER_ADVANCED_REQUIREMENTS_MATRIX.md)を、今回の設計と受入観点へ対応付ける。これは実装完了表ではない。各行の実装箇所・自動検証の結果・状態（試験済み／実装済み／未検証／未完）は[実装状況](TUNER_ADVANCED_IMPLEMENTATION_STATUS.md)に記録し、実機確認は全行未実施として扱う。

仕様ID112件と調査用ID89件をそのまま保持した。Phaseは設計上の着手・完成予定であり、旧調査表の候補から変更した箇所は[設計14章](TUNER_ADVANCED_DESIGN.md#delivery)を優先する。対象外の将来録音も境界要件として行を残す。各行の受入は元要件と下記の観点の両方を満たすこととし、一般的な画面テストだけでは合格にしない。

音響S=合成音、U=純粋関数、E=ブラウザー結合、D=実機、API=DB／認可試験。元調査表の検証方法を引き継ぎ、保存・所有者に関わる行はAPI試験を追加する。全体条件は[受入設計](TUNER_ADVANCED_DESIGN.md#acceptance)、保存契約は[データ設計](TUNER_ADVANCED_DATA_API_DESIGN.md#tests)を参照。

## T: チューナー

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| T-001 | マイク入力から基音周波数を推定 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-002 | C～B とオクターブ番号を表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-003 | 英語音名・ドレミ、♯／♭表記の切替 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-004 | 周波数を小数第1位以上で表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-005 | 選択した音律の目標周波数との差を表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-006 | ±50 cent のアナログメーター、表示範囲の変更 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-007 | 合格範囲 ±3／±5／±10 cent・任意 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-008 | 自動判定と指定音判定の切替 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-009 | 発音停止後、最後の値を一定時間表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) | 1 | 無効化後1秒保持、目標変更では旧判定を解除 |
| T-010 | 表示と解析の一時停止・再開 | [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1 | 表示固定は継続、測定pauseはマイク解放 |
| T-011 | A4 = 390～480 Hz、0.1 Hz 刻み | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-012 | プリセット 440／441／442／443 Hz など | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-013 | 応答速度: 高速・標準・安定重視 | [ui](TUNER_ADVANCED_DESIGN.md#ui) | 1 | 応答速度の表示パラメーターと解析条件を分離 |
| T-014 | 画面表示用の平滑化強度を調整 | [ui](TUNER_ADVANCED_DESIGN.md#ui) | 1 | 表示平滑化設定を変更しても分析結果は不変 |
| T-015 | マイク感度: 自動・手動の入力しきい値 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-016 | 入力の相対音量を表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-017 | 信頼度不足時に警告・測定保留 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-018 | 音域設定: 全音域・低音重視・高音重視 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 1 | 範囲端・設定変更・表示と生値の分離 |
| T-019 | 通常・詳細・全画面 | [ui](TUNER_ADVANCED_DESIGN.md#ui) | 1・5 | iPhoneはAPI不可時に画面内最大化 |
| T-020 | 画面のスリープ抑制 | [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1・5 | 遅延取得・退出・復帰・拒否時の継続 |

## Q: 測定品質

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| Q-001 | 倍音を基音と誤る現象の抑制 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-002 | オクターブ誤りの抑制 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-003 | 無音・環境ノイズへの誤反応の抑制 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-004 | 急な音程変化への追従 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-005 | ロングトーンで安定して測定 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-006 | 低音域と高音域で解析条件を最適化 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-007 | 音量変化による誤判定の抑制 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |
| Q-008 | 周波数・信頼度・実効時刻を内部データとして保持 | [capture](TUNER_ADVANCED_DESIGN.md#capture) / [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1・5 | 合成音の有効率・棄却・粗大誤りを併記 |

## M: 音律

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| M-001 | 12平均律 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-002 | 純正律・短3度（現行を維持） | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-003 | 純正律・長3度（現行を維持） | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-004 | 純正律・長三和音（根音・長3度・完全5度） | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-005 | 純正律・短三和音 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-006 | 和声上の役割（根音・3度・5度など）を手動指定 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-007 | ピタゴラス音律 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-008 | カスタム音律（各音の目標偏差） | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-009 | 平均律と選択音律との差を同時表示 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |
| M-010 | 音律プリセットの保存・呼出 | [temperament](TUNER_ADVANCED_DESIGN.md#temperament) | 1 | 既知比・根音・役割・綴り・octaveを照合 |

## S: 音源

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| S-001 | 音名・オクターブを指定して再生 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-002 | Hz を直接指定して再生 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-003 | A4 設定に連動して再生周波数を更新 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-004 | 音量 0～100% | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-005 | 音色の切替（サイン・三角・倍音合成音など） | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-006 | 指定音の持続再生（ドローン） | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-007 | 2～4音の同時発音 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-008 | 和音プリセット（長三和音・短三和音・各種7の和音） | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-009 | 2音の交互再生・同時再生 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-010 | 選択した音律で再生 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-011 | クリックノイズを防ぐフェード | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-012 | 再生時間（持続・指定秒数・繰り返し） | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |
| S-013 | 再生中の音・周波数を表示 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2 | 実波形・予約時刻・停止・世代競合 |

## SN: 同時使用

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| SN-001 | 同時使用時の警告表示とイヤホンの推奨（特記事項）。端末により音声経路が変わる点も考慮 | [sound](TUNER_ADVANCED_DESIGN.md#sound) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 2・5 | 全倍音重複の限界・統計除外・実機経路 |

## A: 解析

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| A-001 | ピッチ履歴グラフ（横軸 時間、縦軸 cent） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-002 | 周波数履歴（Hz） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-003 | 音量履歴 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-004 | ピッチと音量を同じ時間軸で表示 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-005 | スペクトル表示（既存を継承・拡張） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-006 | スペクトログラム | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-007 | 倍音分析（周波数・相対強度） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-008 | グラフ上で測定区間を選択 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-009 | 測定中にグラフを固定 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-010 | 測定セッションの保存 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2→4 | Phase2はメモリー結果、Phase4で明示的な永続保存 |
| A-011 | アタック（発音開始時刻）検出 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-012 | 発音直後の音程偏差 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [capture](TUNER_ADVANCED_DESIGN.md#capture) | 2・5 | 最初の100 msが測れなければ欠測、後値で埋めない |
| A-013 | 定常音の区間を抽出 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-014 | 区間の平均音程 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-015 | 音程のばらつき（標準偏差など） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-016 | 区間の最大・最小偏差 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-017 | ピッチドリフト | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-018 | リリース（音の終了直前）の分析 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-019 | 安定時間（許容範囲に収まった時間） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-020 | 発音の再現性（同じ音を複数回） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・4 | 同音再アタックの試行を分け、目標変更分割は数えない |
| A-021 | ビブラート検出 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-022 | ビブラートの速さ（Hz） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-023 | ビブラートの幅（cent） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-024 | 中心音程 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |
| A-025 | ビブラートの安定性（周期・幅のばらつき） | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 2 | 真値のある系列で区間・時刻・欠測を検証 |

## HA: 倍音分析

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| HA-001 | 基音に対する各倍音の相対強度 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |
| HA-002 | 倍音構成の時間変化 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |
| HA-003 | 発音直後と定常状態のスペクトル比較 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |
| HA-004 | 強弱による倍音バランスの変化 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |
| HA-005 | 同じ音・同じ楽器の測定結果を比較 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |
| HA-006 | 倍音の多さで音の良し悪しを判定しない | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 2・5 | 窓・音域・基音不明・飽和・取得条件を照合 |

## P: 練習

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| P-001 | ロングトーン練習（条件設定 → カウントダウン → 演奏と解析 → 結果・保存） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-002 | 半音階（上行・下行・往復） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-003 | 12調の長音階 | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-004 | 自然・和声・旋律短音階 | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-005 | 音程跳躍（2度～2オクターブなど） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-006 | 同音反復（発音・音程の再現性） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-007 | 強弱変化（クレッシェンド・デクレッシェンド） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-008 | 基準音を聴き、表示を隠して演奏 | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-009 | 2音の音程差の聴き分け | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-010 | カスタム練習（音列・テンポ・時間） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-011 | メトロノームに合わせた演奏・測定 | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |
| P-012 | 段階的なウォームアップメニュー | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3 | 期待列・時刻・未演奏・誤音・中断を検証 |

## PR: 練習結果

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| PR-001 | 音程正確性（目標からの絶対偏差） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-002 | 音程安定性（定常区間のばらつき） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-003 | 発音安定性（安定するまでの時間） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-004 | 音程維持率（許容範囲内の時間の割合） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-005 | 再現性（複数回の試行の一致） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-006 | 改善度（過去の同条件との比較） | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) | 3・4 | 個別指標・有効時間・条件・不確実性を確認 |
| PR-007 | 総合スコアは任意、各指標は必ず確認できる | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) | 3・5 | 総合スコアは任意・初期非表示、各指標を必ず表示 |
| PR-008 | 練習の種類ごとに基準・重みを変える | [trainer](TUNER_ADVANCED_DESIGN.md#trainer) / [decisions](TUNER_ADVANCED_DESIGN.md#decisions) | 3・5 | 重みは課題別、正規化と公開は校正後。未完として追跡 |

## I: 個人診断

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| I-001 | 音名・オクターブごとの平均 cent | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-002 | 音ごとの標準偏差 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-003 | 低音・中音・高音の傾向 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-004 | 高くなりやすい・低くなりやすい音 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-005 | 音ごとの安定度の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-006 | 上行・下行の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-007 | 跳躍前後の偏差 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-008 | 強弱別の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-009 | 楽器ごとの傾向 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-010 | 日・週・月・任意期間の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-011 | 弱点音の抽出 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-012 | 改善傾向の判定 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-013 | 自動練習提案 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |
| I-014 | 音程傾向マップ（色分け、選択で詳細） | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) | 4 | 階層集計・条件分離・不足時保留 |

## DQ: 診断品質

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| DQ-001 | 平均値にサンプル数（イベント数）を併記する | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |
| DQ-002 | 短すぎる音・低信頼度の測定を統計から除外 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |
| DQ-003 | 長い1音の影響を過大にしない | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |
| DQ-004 | 比較条件（音律・A4・楽器・練習条件）をそろえる | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |
| DQ-005 | データ不足では診断しない | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |
| DQ-006 | 楽器・奏法の問題を測定結果だけから断定しない | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | フレームを独立試行として水増ししない |

## E: 楽器

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| E-001 | 楽器の登録（名前・種類・メーカー・型番・任意名称） | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-002 | 保存先の楽器を選ぶ | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-003 | 演奏条件の記録（気温・湿度・ウォームアップ） | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-004 | セッティング（リード・マウスピースなど） | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-005 | 楽器別の音程分析 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-006 | 条件別の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |
| E-007 | 調整・部品交換前後の比較 | [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 4 | プロフィールsnapshot・変更前後の条件分離 |

## H: 履歴

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| H-001 | 履歴の保存（日時・種類・結果） | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-002 | 日付・楽器・練習内容で検索 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-003 | セッション詳細（グラフ・統計・条件）を再表示 | [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) / [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 端末はpitch系列、DBは要約。未保存スペクトログラムは再現しない |
| H-004 | 日別集計 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-005 | 週別・月別集計 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-006 | 直近の同条件と比較 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-007 | 成長グラフ | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-008 | 苦手音ランキング | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-009 | CSV・JSON 出力 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-010 | 個別・全履歴の削除 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |
| H-011 | 自動保存の設定（保存しない・手動・自動） | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [diagnosis](TUNER_ADVANCED_DESIGN.md#diagnosis) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [api](TUNER_ADVANCED_DATA_API_DESIGN.md#api) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 本人分離・保存選択・再表示・同期削除 |

## SC: 画面構成

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| SC-001 | タブ構成（測定・音源・解析・練習・診断。履歴と設定は画面内のメニュー） | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1 | 内部タブ継続・外部退出解放 |

## UI: 操作性

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| UI-001 | スマートフォン縦画面が基本 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-002 | タブ切替で測定音が途切れない | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-003 | マイク稼働中の状態を明示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-004 | 画面を閉じたら音声取得を終了 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-005 | 重要な数値を大きく表示 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-006 | グラフのズーム・スクロール・表示項目の切替 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-007 | 既存ポータルと配色・操作体系を統一 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-008 | ダークモード・全画面・高コントラスト | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |
| UI-009 | 各設定の保存と初期値への復元 | [ui](TUNER_ADVANCED_DESIGN.md#ui) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜4 | 277〜430 px・代替操作・状態明示 |

## X: 技術

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| X-001 | 音声入力は getUserMedia | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-002 | Web Audio API／AudioWorklet | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-003 | 基音検出は既存を評価し、必要なら改善 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-004 | FFT による周波数解析 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-005 | 基音と各倍音の相対強度 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-006 | ノイズ対策（入力レベル・信頼度・周波数の連続性） | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-007 | 内部データ（Hz・時刻・音量・信頼度・測定音） | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-008 | 表示の更新は毎秒20～30回 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-009 | 音域別・端末別に性能を評価 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-010 | リアルタイム解析はクライアント側 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-011 | 周波数は Hz で保持し、cent は基準・音律・役割から算出 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |
| X-012 | 計測データと表示用の平滑化データを分離 | [architecture](TUNER_ADVANCED_DESIGN.md#architecture) / [capture](TUNER_ADVANCED_DESIGN.md#capture) / [analyzer](TUNER_ADVANCED_DESIGN.md#analyzer) | 1・2 | 既存経路・時刻・未平滑化・縮約転送 |

## D: データ

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| D-001 | TunerSettings | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-002 | InstrumentProfile | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-003 | PracticeSession | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-004 | NoteEvent | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-005 | PracticeResult | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-006 | MeasurementSeries | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-007 | IntonationProfile | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-008 | SoundPreset | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-009 | AnalysisSettings | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |
| D-010 | 計測値は浮動小数点で保持し、表示時に丸める | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [contract](TUNER_ADVANCED_DATA_API_DESIGN.md#contract) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [schema](TUNER_ADVANCED_DATA_API_DESIGN.md#schema) / [stats](TUNER_ADVANCED_DATA_API_DESIGN.md#stats) | 1〜4 | 型・版・単位・保存復元 |

## PV: プライバシー

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| PV-001 | 通常の測定音声をサーバーに送らない | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [scope](TUNER_ADVANCED_DESIGN.md#scope) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 同意なし保存・音声通信がないことを確認 |
| PV-002 | 統計・結果は利用者が有効にした場合のみ保存 | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [scope](TUNER_ADVANCED_DESIGN.md#scope) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 同意なし保存・音声通信がないことを確認 |
| PV-003 | 端末内保存とアカウント連携保存の両方を想定し、認証・DB を確認して決める | [persistence](TUNER_ADVANCED_DESIGN.md#persistence) / [scope](TUNER_ADVANCED_DESIGN.md#scope) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 4 | 同意なし保存・音声通信がないことを確認 |
| PV-004 | 将来の録音機能は別の保存・削除方針 | [scope](TUNER_ADVANCED_DESIGN.md#scope) / [local](TUNER_ADVANCED_DATA_API_DESIGN.md#local) / [security](TUNER_ADVANCED_DATA_API_DESIGN.md#security) | 対象外境界 | 録音機能・保存先を追加せず、将来別方針とする |

## N: 非機能

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| N-001 | iOS Safari・Android Chrome・PC の主要ブラウザー | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-002 | マイク許可後、少ない操作で測定を開始 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-003 | 通常演奏で違和感の少ない追従 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-004 | 30分以上の連続測定を試験 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-005 | 基準音を使った端末別の誤差検証 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 5 | 別基準源・距離・部屋・端末を記録し端末誤差を測る |
| N-006 | マイク切断・権限拒否・音声中断への対応 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-007 | スマホの CPU・メモリー・電池の抑制 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-008 | 許可なく音声・練習履歴を外部送信しない | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-009 | 条件の違うデータを誤集計しない | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-010 | 色以外でも音程の状態が分かる | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |
| N-011 | 電子音だけでなく実楽器（クラリネット・ヴァイオリンなど）で検証 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) / [lifecycle](TUNER_ADVANCED_DESIGN.md#lifecycle) | 1〜5 | 実機結果と設計目標を分けて受入 |

## AT: 受入

| ID | 要件 | 設計参照 | Phase | 受入の重点 |
|---|---|---|---|---|
| AT-001 | A4 = 440・442 Hz などで正しく目標を算出 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-002 | 半音階の各音を正しく識別 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-003 | 平均律・純正律が既知の比と一致 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-004 | 指定周波数で発音・停止 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-005 | アタック・定常・終了区間を区別 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-006 | 音程の変化を時間軸に表示 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-007 | 既知の周期・振幅のテスト音でビブラートを解析 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-008 | 指定した音列と演奏結果を正しく比較 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-009 | 同条件の音程傾向を正しく集計 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-010 | 異なる楽器の結果が混ざらない | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-011 | 保存・読込・比較・削除が正常に動作 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-012 | 利用中断・権限拒否・復帰を処理 | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |
| AT-013 | 画面表示と、測定結果が音響的に妥当であることを別の合格条件にする | [acceptance](TUNER_ADVANCED_DESIGN.md#acceptance) | 1〜5 | UIと音響精度を独立した合格条件にする |

## 実装時の変更

| No. | 影響ID | 内容（理由・代替案・検証は実装状況4章） |
|---|---|---|
| DC-01 | D-001, D-008, M-010, UI-009, T-011 | 端末設定とプリセットを localStorage に置く |
| DC-02 | X-002, X-007 | 転送メッセージ名は既存の `audio`／`return` |
| DC-03 | A-011, A-013, A-020, AT-005 | 音高分割を対称窓＋非最大抑制に変更 |
| DC-04 | A-011, A-020, P-006 | 再アタックの判定を立ち上がりで数える |
| DC-05 | PV-003, H-001～H-011 | APIはシステム管理者限定 |
| DC-06 | PV-003, H-010, D-003, AT-011 | `member_birth`＋団員トリガーで所有者を失効 |
| DC-07 | H-010, PV-003 | チューナーの表は本番→テスト同期の対象外 |
| DC-08 | UI-003, SC-001, T-010, N-006 | 状態表示を全タブ共通にする |
| DC-09 | H-001, A-010 | 記録中のまま残ったセッションの復旧条件 |
| DC-10 | E-003, DQ-004 | 演奏環境は条件キーに含めない |
| DC-11 | HA-004, HA-005 | 強弱比較に音量差6 dBの条件 |
| DC-12 | Q-006, T-018 | 適応窓切替は無効のまま（未完） |
| DC-13 | P-001, H-001, H-011, A-010 | 練習の記録を1件のセッションに確定 |
| DC-14 | H-010, AT-011, D-003 | 全削除の削除世代で保留中の保存を拒否 |
| DC-15 | T-005, T-011, A-014, DQ-004, N-009, AT-009 | 音符ごとにその時点の条件で判定 |
| DC-16 | H-010, PV-003, AT-011 | 全削除後に本人情報を取り直す |
| DC-17 | P-001～P-012, H-001, H-011 | 練習ごとの試行に記録を固定 |
| DC-18 | H-006, H-007, DQ-004, N-009 | 履歴の比較・成長グラフを条件ごとに |
| DC-19 | P-001, H-001, H-011, PV-002, PV-003 | 保存の有効性と画面の鮮度を分ける |
