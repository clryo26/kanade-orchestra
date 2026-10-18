# 高機能チューナー 実装状況 Ver.1.0

作成日: 2026-10-17。[設計書](TUNER_ADVANCED_DESIGN.md)、[データ・API設計](TUNER_ADVANCED_DATA_API_DESIGN.md)、[設計対応表](TUNER_ADVANCED_DESIGN_TRACEABILITY.md)に対する実装と検証の状況を記録する。調査資料3点（[実現可能性](TUNER_ADVANCED_FEASIBILITY.md)・[要件表](TUNER_ADVANCED_REQUIREMENTS_MATRIX.md)・[実装計画](TUNER_ADVANCED_IMPLEMENTATION_PLAN.md)）は変更していない。

対象はテスト環境の実験室で、システム管理者だけが使うチューナー。団員への公開、入力和音の分離、移調、録音、外部AIは対象外とし、実装していない。コミット・push・デプロイ・本番DBの変更は行っていない。

## 1. 状態の定義

| 状態 | 意味 |
|---|---|
| 試験済み | 実装済みで、自動試験（Vitest／Playwright／pytest）が合格。合成音・疑似マイク・使い捨てDBでの確認であり、実機・実楽器の確認ではない |
| 実装済み | 実装済みだが、その行専用の自動試験がない（描画・目視項目など） |
| 未検証 | 実装済みだが、合否が実機・実楽器・実測に依存し、まだ測っていない |
| 未完 | 設計の合格条件を満たしていない、または公開を止めている |
| 対象外（境界維持） | 対象外の機能を追加していないことを確認する行 |

実機（iPhone Safari・Android Chrome・PCの各ブラウザー）での確認は、全201行とも**未実施**。調整値・設計目標・未検証の値は、保証値として扱わない。

## 2. フェーズ別の進捗と残件

| Phase | 実装 | 自動検証 | 残件 |
|---|---|---|---|
| 1 測定・表示・音律 | A4 0.1 Hz刻み（390.0～480.0 Hz）・プリセット・数値入力、音律（平均律・純正律の三和音と役割・7度・ピタゴラス・カスタム）、応答速度・合格範囲・メーター範囲、表示固定と測定一時停止、タブ構成、状態チップ | 試験済み | 適応窓切替の公開（Q-006）。iPhoneの初回起動・停止・再開（実機） |
| 2 音源・解析 | 最大4音・音色（サイン・三角・倍音合成）・和音プリセット・持続／指定時間／繰り返し／交互／メトロノーム、同時使用モード（明示選択・統計除外）、音符分割・定常／発音／終了・ビブラート・倍音要約、スペクトログラム（保存しない） | 試験済み（描画は実装済み） | 端末の音声経路（SN-001）、実楽器 |
| 3 練習 | 12種類の課題、期待列との照合（未演奏・誤音・余分）、状態機械（中断は利用者の操作でのみ再開）、結果の個別指標 | 試験済み | 総合スコアの正規化（PR-008、校正前のため常に非表示） |
| 4 保存・診断 | 履歴保存（初期は保存しない）、端末内IndexedDB（標準Float32形式）、アカウントへの要約同期（/api/tuner）、診断（イベント・セッション数併記、条件分離、不足時保留）、楽器・演奏環境、CSV・JSON出力、削除 | 試験済み（API・使い捨てPostgreSQL含む） | 共有テスト環境DBへの017適用（下記8章）、実機 |
| 5 実機・最適化 | 自動試験の範囲で回帰を追加 | — | 実機・実楽器・端末別誤差・30分連続・CPU／電池（N-001, N-003～N-005, N-007, N-011, X-009）はすべて未実施 |

## 3. 201要件の状態

| 状態 | 件数 |
|---|---|
| 試験済み | 159 |
| 実装済み | 31 |
| 未検証 | 7 |
| 未完 | 3 |
| 対象外（境界維持） | 1 |
| 合計 | 201 |

未完・未検証の行: Q-006、PR-008、H-010、X-009、N-001、N-003、N-004、N-005、N-007、N-011。

列「自動検証」の略記: U＝`tests/frontend/test_tuner_<名前>.test.js`、E2E＝`tests/e2e/tuner.spec.js`、API＝`tests/backend/test_tuner_practice_<contract|postgres>.py`。

### T: チューナー

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| T-001 | マイク入力から基音周波数を推定 | 1 | 試験済み | pitch.js・analysis.worker.js（YIN流用、28～4,700 Hz） | U:pitch_spectrum, analysis_pipeline／E2E:疑似マイク440 Hz | 未実施 |
| T-002 | C～B とオクターブ番号を表示 | 1 | 試験済み | music.js・view.js | U:music_settings／E2E | 未実施 |
| T-003 | 英語音名・ドレミ、♯／♭表記の切替 | 1 | 試験済み | settings.js（noteNaming・spelling）・target_model.js spell() | U:target_model（綴りは周波数不変） | 未実施 |
| T-004 | 周波数を小数第1位以上で表示 | 1 | 試験済み | view.js（0.1 Hz表示） | E2E | 未実施 |
| T-005 | 選択した音律の目標周波数との差を表示 | 1 | 試験済み | display_filter.js＋target_model.js | U:target_model, display_filter | 未実施 |
| T-006 | ±50 cent のアナログメーター、表示範囲の変更 | 1 | 試験済み | settings.js METER_RANGES 10/25/50/100・display_filter needleCents | U:target_model（針は範囲で止まり値は丸めない） | 未実施 |
| T-007 | 合格範囲 ±3／±5／±10 cent・任意 | 1 | 試験済み | settings.js toleranceCents（±3/5/10・任意0.5～25） | U:target_model（入る閾値・出る閾値+1） | 未実施 |
| T-008 | 自動判定と指定音判定の切替 | 1 | 試験済み | target_model.js resolve（自動／fixedMidi） | U:target_model | 未実施 |
| T-009 | 発音停止後、最後の値を一定時間表示 | 1 | 試験済み | display_filter.js（保持1秒、目標変更で判定解除） | U:display_filter, target_model | 未実施 |
| T-010 | 表示と解析の一時停止・再開 | 1 | 試験済み | index.js onFreeze／onPauseToggle | U:body_advanced／E2E:固定中もマイク継続、一時停止で解放 | 未実施 |
| T-011 | A4 = 390～480 Hz、0.1 Hz 刻み | 1 | 試験済み | settings.js（a4Tenths 3900～4800）・view.js入力 | U:music_settings／E2E | 未実施 |
| T-012 | プリセット 440／441／442／443 Hz など | 1 | 試験済み | settings.js PRESETS_TENTHS 440/441/442/443 | E2E | 未実施 |
| T-013 | 応答速度: 高速・標準・安定重視 | 1 | 試験済み | settings.js RESPONSE_PRESETS（表示専用） | U:target_model, music_settings | 未実施 |
| T-014 | 画面表示用の平滑化強度を調整 | 1 | 試験済み | display_filter.js（表示平滑化のみ） | U:target_model（生値は不変） | 未実施 |
| T-015 | マイク感度: 自動・手動の入力しきい値 | 1 | 実装済み | settings.js inputThreshold・index.js calibrateNoise | 手動しきい値はU:music_settings。自動校正（2秒ノイズ測定）は自動試験なし | 未実施 |
| T-016 | 入力の相対音量を表示 | 1 | 実装済み | view.js レベルメーター | 自動試験なし（表示のみ） | 未実施 |
| T-017 | 信頼度不足時に警告・測定保留 | 1 | 試験済み | pitch.js invalidReason／qualityFlags・view.js警告 | U:analysis_pipeline, pitch_spectrum | 未実施 |
| T-018 | 音域設定: 全音域・低音重視・高音重視 | 1 | 試験済み | analysis.worker.js PROFILES full/low/high/vibrato | U:analysis_pipeline | 未実施 |
| T-019 | 通常・詳細・全画面 | 1・5 | 実装済み | view.js 詳細表示・画面いっぱい表示（API不可時は画面内最大化） | 自動試験なし。iPhoneの代替表示は実機未実施 | 未実施 |
| T-020 | 画面のスリープ抑制 | 1・5 | 試験済み | index.js／controller.js Wake Lock（遅延取得の解放） | U:body, lifecycle | 未実施 |

### Q: 測定品質

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| Q-001 | 倍音を基音と誤る現象の抑制 | 1・5 | 試験済み | pitch.js（YIN）・spectrum.js | U:pitch_spectrum（合成音：純音・倍音音・基音欠落、C1～C8で±2 cent）。有効率・棄却率・粗大誤り率の別集計表は未作成 | 未実施 |
| Q-002 | オクターブ誤りの抑制 | 1・5 | 試験済み | spectrum.js subharmonicEvidence・isOctaveAmbiguous（flag 8） | U:pitch_spectrum, analysis_pipeline（合成音） | 未実施 |
| Q-003 | 無音・環境ノイズへの誤反応の抑制 | 1・5 | 試験済み | pitch.js 無音・低信頼の棄却（欠測は0にしない） | U:pitch_spectrum（雑音SNR別） | 未実施 |
| Q-004 | 急な音程変化への追従 | 1・5 | 試験済み | analysis.worker.js high/vibratoプロファイル | U:analysis_pipeline（跳躍・レガート境界） | 未実施 |
| Q-005 | ロングトーンで安定して測定 | 1・5 | 試験済み | pitch.js・display_filter.js | U:pitch_spectrum, analysis_pipeline | 未実施 |
| Q-006 | 低音域と高音域で解析条件を最適化 | 1・5 | 未完 | analysis.worker.js 手動プロファイル（試験済み）。適応窓切替は実装したが無効（adaptive:false） | 切替試験の合格条件を満たす実測が未実施のため公開しない（設計5.1） | 未実施 |
| Q-007 | 音量変化による誤判定の抑制 | 1・5 | 試験済み | pitch.js clip検出・RMSしきい値 | U:pitch_spectrum, analysis_pipeline | 未実施 |
| Q-008 | 周波数・信頼度・実効時刻を内部データとして保持 | 1・5 | 試験済み | analysis.worker.js frame（effectiveFrame2・confidence・rms・flags）・measurement_store.js | U:analysis_pipeline, session_store | 未実施 |

### M: 音律

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| M-001 | 12平均律 | 1 | 試験済み | target_model.js equal | U:target_model（A4 390～480、C1～C8、1e-9） | 未実施 |
| M-002 | 純正律・短3度（現行を維持） | 1 | 試験済み | target_model.js（temperament.justTargetと同一） | U:target_model, temperament／E2E | 未実施 |
| M-003 | 純正律・長3度（現行を維持） | 1 | 試験済み | target_model.js（同上） | U:target_model, temperament／E2E | 未実施 |
| M-004 | 純正律・長三和音（根音・長3度・完全5度） | 1 | 試験済み | target_model.js just-major | U:target_model（1, 5/4, 3/2、オクターブ） | 未実施 |
| M-005 | 純正律・短三和音 | 1 | 試験済み | target_model.js just-minor | U:target_model（1, 6/5, 3/2） | 未実施 |
| M-006 | 和声上の役割（根音・3度・5度など）を手動指定 | 1 | 試験済み | target_model.js role・7度（15/8, 9/5既定, 16/9, 7/4） | U:target_model | 未実施 |
| M-007 | ピタゴラス音律 | 1 | 試験済み | target_model.js pythagorean（開始位置-3既定） | U:target_model（折返し表・コンマ） | 未実施 |
| M-008 | カスタム音律（各音の目標偏差） | 1 | 試験済み | target_model.js custom（±100 cent、0.1刻み） | U:target_model | 未実施 |
| M-009 | 平均律と選択音律との差を同時表示 | 1 | 試験済み | view.js 平均律との差 | E2E（純正律で平均律差を同時表示） | 未実施 |
| M-010 | 音律プリセットの保存・呼出 | 1 | 試験済み | settings.js presets.temperament・view_history.js・index.js applyTargetConfig | U:music_settings／E2E:保存・呼出・削除 | 未実施 |

### S: 音源

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| S-001 | 音名・オクターブを指定して再生 | 2 | 試験済み | playback.js・view.js | U:playback／E2E | 未実施 |
| S-002 | Hz を直接指定して再生 | 2 | 試験済み | playback.js（28.0～4,700.0 Hz） | U:playback／E2E（範囲外は鳴らさない） | 未実施 |
| S-003 | A4 設定に連動して再生周波数を更新 | 2 | 試験済み | index.js applyA4Change・view_sound.js refreshFrequencies | U:body, voices_scheduler（glide） | 未実施 |
| S-004 | 音量 0～100% | 2 | 試験済み | playback.js volumeToGain（40%→0.1、master≤0.25） | U:playback／E2E:OfflineAudioContext | 未実施 |
| S-005 | 音色の切替（サイン・三角・倍音合成音など） | 2 | 試験済み | playback.js WAVEFORMS・PeriodicWave（Nyquist未満・最大40成分） | U:voices_scheduler | 未実施 |
| S-006 | 指定音の持続再生（ドローン） | 2 | 試験済み | scheduler.js hold | U:voices_scheduler | 未実施 |
| S-007 | 2～4音の同時発音 | 2 | 試験済み | playback.js startVoices（最大4音、各1/N） | U:voices_scheduler／E2E:4音の実波形ピーク | 未実施 |
| S-008 | 和音プリセット（長三和音・短三和音・各種7の和音） | 2 | 試験済み | view_sound.js CHORDS（長・短・属7・長7・短7・半減7・減7） | U:harmonics_sound | 未実施 |
| S-009 | 2音の交互再生・同時再生 | 2 | 試験済み | scheduler.js alternate・startVoices同時 | U:voices_scheduler | 未実施 |
| S-010 | 選択した音律で再生 | 2 | 試験済み | view_sound.js linked voices（音律・役割に連動） | U:harmonics_sound（純正長3度=5/4） | 未実施 |
| S-011 | クリックノイズを防ぐフェード | 2 | 試験済み | playback.js フェード | E2E:OfflineAudioContext（単音・4音） | 未実施 |
| S-012 | 再生時間（持続・指定秒数・繰り返し） | 2 | 試験済み | scheduler.js hold/timed/repeat/metronome | U:voices_scheduler | 未実施 |
| S-013 | 再生中の音・周波数を表示 | 2 | 実装済み | view_sound.js showSummary・view.js | 自動試験は再生状態のみ | 未実施 |

### SN: 同時使用

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| SN-001 | 同時使用時の警告表示とイヤホンの推奨（特記事項）。端末により音声経路が変わる点も考慮 | 2・5 | 試験済み | view_sound.js 警告・イヤホン申告・session_coordinator.js・workspace.js（flag 16）・stats統計除外 | U:session_store, workspace, stats_worker, body_advanced。実機の音声経路は未実施 | 未実施 |

### A: 解析

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| A-001 | ピッチ履歴グラフ（横軸 時間、縦軸 cent） | 2 | 実装済み | view_analyzer.js・history_graph.js（cent） | 描画の自動試験なし。系列はU:analysis_pipeline | 未実施 |
| A-002 | 周波数履歴（Hz） | 2 | 実装済み | view_analyzer.js（Hz） | 同上 | 未実施 |
| A-003 | 音量履歴 | 2 | 実装済み | view_analyzer.js（10 ms RMS包絡） | 包絡はU:analysis_pipeline | 未実施 |
| A-004 | ピッチと音量を同じ時間軸で表示 | 2 | 実装済み | view_analyzer.js 同一時間軸 | 描画の自動試験なし | 未実施 |
| A-005 | スペクトル表示（既存を継承・拡張） | 2 | 試験済み | spectrum.js・graph.js（既存を拡張） | U:pitch_spectrum, graph／E2E | 未実施 |
| A-006 | スペクトログラム | 2 | 実装済み | spectrogram.js（メモリーのみ、保存しない） | 自動試験なし | 未実施 |
| A-007 | 倍音分析（周波数・相対強度） | 2 | 試験済み | analysis.worker.js harmonics・analysis_stats.js harmonicSummary | U:harmonics_sound（1, 1/2, 1/4の倍音音） | 未実施 |
| A-008 | グラフ上で測定区間を選択 | 2 | 実装済み | view_analyzer.js 区間の開始・終了入力 | 自動試験なし | 未実施 |
| A-009 | 測定中にグラフを固定 | 2 | 試験済み | view_analyzer.js 固定・index.js onFreeze | E2E（固定中も測定継続） | 未実施 |
| A-010 | 測定セッションの保存 | 2→4 | 試験済み | workspace.js saveSnapshot（Phase4で永続化） | U:workspace, storage_local | 未実施 |
| A-011 | アタック（発音開始時刻）検出 | 2 | 試験済み | onset.js・note_events.js | U:analysis_pipeline（再アタック・境界±） | 未実施 |
| A-012 | 発音直後の音程偏差 | 2・5 | 試験済み | analysis_stats.js attack（最初の100 ms、測れなければ欠測） | U:analysis_pipeline | 未実施 |
| A-013 | 定常音の区間を抽出 | 2 | 試験済み | analysis_stats.js steady | U:analysis_pipeline | 未実施 |
| A-014 | 区間の平均音程 | 2 | 試験済み | analysis_stats.js 時間重み平均・中央値 | U:analysis_pipeline | 未実施 |
| A-015 | 音程のばらつき（標準偏差など） | 2 | 試験済み | analysis_stats.js sdCents・p10/p90 | U:analysis_pipeline | 未実施 |
| A-016 | 区間の最大・最小偏差 | 2 | 試験済み | analysis_stats.js min/max | U:analysis_pipeline | 未実施 |
| A-017 | ピッチドリフト | 2 | 試験済み | analysis_stats.js driftCentsPerSec | U:analysis_pipeline | 未実施 |
| A-018 | リリース（音の終了直前）の分析 | 2 | 試験済み | analysis_stats.js release | U:analysis_pipeline | 未実施 |
| A-019 | 安定時間（許容範囲に収まった時間） | 2 | 試験済み | analysis_stats.js stabilization・inToleranceSeconds | U:analysis_pipeline | 未実施 |
| A-020 | 発音の再現性（同じ音を複数回） | 2・4 | 試験済み | note_events.js 再アタック分割・trainer.js reproducibility | U:analysis_pipeline, trainer_diagnosis | 未実施 |
| A-021 | ビブラート検出 | 2 | 試験済み | analysis_stats.js analyzeVibrato（3～10 Hz） | U:analysis_pipeline | 未実施 |
| A-022 | ビブラートの速さ（Hz） | 2 | 試験済み | 同上 rateHz | U:analysis_pipeline | 未実施 |
| A-023 | ビブラートの幅（cent） | 2 | 試験済み | 同上 extent（長窓>30 msは保留） | U:analysis_pipeline | 未実施 |
| A-024 | 中心音程 | 2 | 試験済み | 同上 center（正弦＋線形傾向） | U:analysis_pipeline | 未実施 |
| A-025 | ビブラートの安定性（周期・幅のばらつき） | 2 | 試験済み | 同上 周期・幅のばらつき | U:analysis_pipeline | 未実施 |

### HA: 倍音分析

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| HA-001 | 基音に対する各倍音の相対強度 | 2・5 | 試験済み | analysis_stats.js harmonicSummary（基音不明は未定義、clip除外） | U:harmonics_sound | 未実施 |
| HA-002 | 倍音構成の時間変化 | 2・5 | 実装済み | graph.js／spectrogram.js ライブ表示 | 描画の自動試験なし | 未実施 |
| HA-003 | 発音直後と定常状態のスペクトル比較 | 2・5 | 実装済み | view_analyzer.js 発音直後（4,096点）と定常部（16,384点） | 集計関数はU:harmonics_sound | 未実施 |
| HA-004 | 強弱による倍音バランスの変化 | 2・5 | 試験済み | analysis_stats.js harmonicComparison（同音内で音量順、差6 dB未満は比較しない）・view_analyzer.js | U:harmonics_sound | 未実施 |
| HA-005 | 同じ音・同じ楽器の測定結果を比較 | 2・5 | 試験済み | 同上（同じ解析範囲・同楽器・同取得条件） | U:harmonics_sound | 未実施 |
| HA-006 | 倍音の多さで音の良し悪しを判定しない | 2・5 | 試験済み | 表示文言（良し悪しを判定しない） | U:trainer_diagnosis（断定語なし）・目視確認 | 未実施 |

### P: 練習

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| P-001 | ロングトーン練習（条件設定 → カウントダウン → 演奏と解析 → 結果・保存） | 3 | 試験済み | trainer.js longtone・状態機械・view_trainer.js（練習ごとの試行に記録を固定し、1件のセッションに確定） | U:trainer_diagnosis, review_regressions | 未実施 |
| P-002 | 半音階（上行・下行・往復） | 3 | 試験済み | trainer.js chromatic（上・下・往復、折返し反復の選択） | U:trainer_diagnosis | 未実施 |
| P-003 | 12調の長音階 | 3 | 試験済み | trainer.js major（12調） | U:trainer_diagnosis | 未実施 |
| P-004 | 自然・和声・旋律短音階 | 3 | 試験済み | trainer.js minor（自然・和声・旋律） | U:trainer_diagnosis | 未実施 |
| P-005 | 音程跳躍（2度～2オクターブなど） | 3 | 試験済み | trainer.js leap | U:trainer_diagnosis | 未実施 |
| P-006 | 同音反復（発音・音程の再現性） | 3 | 試験済み | trainer.js repeat | U:trainer_diagnosis | 未実施 |
| P-007 | 強弱変化（クレッシェンド・デクレッシェンド） | 3 | 試験済み | trainer.js dynamics | U:trainer_diagnosis | 未実施 |
| P-008 | 基準音を聴き、表示を隠して演奏 | 3 | 試験済み | trainer.js ear（visible:false）・index.js setDisplayHidden | U:trainer_diagnosis | 未実施 |
| P-009 | 2音の音程差の聴き分け | 3 | 試験済み | trainer.js makeIntervalQuestion／checkIntervalAnswer | U:trainer_diagnosis | 未実施 |
| P-010 | カスタム練習（音列・テンポ・時間） | 3 | 試験済み | trainer.js custom（書式・最大256音） | U:trainer_diagnosis | 未実施 |
| P-011 | メトロノームに合わせた演奏・測定 | 3 | 試験済み | trainer.js metronome・scheduler.js | U:trainer_diagnosis, voices_scheduler | 未実施 |
| P-012 | 段階的なウォームアップメニュー | 3 | 試験済み | trainer.js warmup（段階） | U:trainer_diagnosis | 未実施 |

### PR: 練習結果

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| PR-001 | 音程正確性（目標からの絶対偏差） | 3・4 | 試験済み | trainer.js computeResult accuracy | U:trainer_diagnosis | 未実施 |
| PR-002 | 音程安定性（定常区間のばらつき） | 3・4 | 試験済み | 同上 stability（定常部） | U:trainer_diagnosis | 未実施 |
| PR-003 | 発音安定性（安定するまでの時間） | 3・4 | 試験済み | 同上 stabilization | U:analysis_pipeline | 未実施 |
| PR-004 | 音程維持率（許容範囲内の時間の割合） | 3・4 | 試験済み | 同上 maintenance・coverage | U:trainer_diagnosis（未演奏時間を分母に含む） | 未実施 |
| PR-005 | 再現性（複数回の試行の一致） | 3・4 | 試験済み | 同上 reproducibility（試行単位） | U:trainer_diagnosis | 未実施 |
| PR-006 | 改善度（過去の同条件との比較） | 3・4 | 試験済み | intonation_profile.js improvement | U:trainer_diagnosis | 未実施 |
| PR-007 | 総合スコアは任意、各指標は必ず確認できる | 3・5 | 試験済み | trainer.js score（初期は無効＝null） | U:trainer_diagnosis | 未実施 |
| PR-008 | 練習の種類ごとに基準・重みを変える | 3・5 | 未完 | trainer.js SCORE_MODELS（課題別の重み） | 正規化が未校正のため総合点は常にnull（normalization-unvalidated） | 未実施 |

### I: 個人診断

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| I-001 | 音名・オクターブごとの平均 cent | 4 | 試験済み | intonation_profile.js noteMap・summarize | U:trainer_diagnosis, workspace | 未実施 |
| I-002 | 音ごとの標準偏差 | 4 | 試験済み | 同上 sdCents・session-cluster区間 | U:trainer_diagnosis | 未実施 |
| I-003 | 低音・中音・高音の傾向 | 4 | 試験済み | 同上 registerOf・categoryMap register | U:trainer_diagnosis | 未実施 |
| I-004 | 高くなりやすい・低くなりやすい音 | 4 | 試験済み | 同上 tendency（区間が0を含まない時だけ判定） | U:trainer_diagnosis | 未実施 |
| I-005 | 音ごとの安定度の比較 | 4 | 試験済み | 同上 weakRanking（安定度） | U:trainer_diagnosis | 未実施 |
| I-006 | 上行・下行の比較 | 4 | 実装済み | 同上 categoryMap direction | 集計の共通部分はU:trainer_diagnosis。方向別の専用試験なし | 未実施 |
| I-007 | 跳躍前後の偏差 | 4 | 実装済み | 同上 direction leap・suggestions | 同上 | 未実施 |
| I-008 | 強弱別の比較 | 4 | 実装済み | 同上 categoryMap dynamics | 同上 | 未実施 |
| I-009 | 楽器ごとの傾向 | 4 | 実装済み | 同上 categoryMap instrument | 同上 | 未実施 |
| I-010 | 日・週・月・任意期間の比較 | 4 | 試験済み | 同上 periodKey（日本時間の日・ISO週・月）・periodMap | U:trainer_diagnosis | 未実施 |
| I-011 | 弱点音の抽出 | 4 | 試験済み | 同上 weakRanking | U:trainer_diagnosis | 未実施 |
| I-012 | 改善傾向の判定 | 4 | 試験済み | 同上 improvement（closer／not-comparable／insufficient） | U:trainer_diagnosis | 未実施 |
| I-013 | 自動練習提案 | 4 | 試験済み | 同上 suggestions（根拠のセッション数を併記） | U:trainer_diagnosis | 未実施 |
| I-014 | 音程傾向マップ（色分け、選択で詳細） | 4 | 実装済み | view_diagnosis.js 傾向マップ（文字と線種でも方向を表示）・tuner.css | 描画の自動試験なし | 未実施 |

### DQ: 診断品質

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| DQ-001 | 平均値にサンプル数（イベント数）を併記する | 4 | 試験済み | intonation_profile.js nEvents・nSessions | U:trainer_diagnosis | 未実施 |
| DQ-002 | 短すぎる音・低信頼度の測定を統計から除外 | 4 | 試験済み | 同上 eligibility（短い・低被覆・観測不足・値なし） | U:trainer_diagnosis | 未実施 |
| DQ-003 | 長い1音の影響を過大にしない | 4 | 試験済み | 同上 セッション等重み | U:trainer_diagnosis（30音の1セッションが支配しない） | 未実施 |
| DQ-004 | 比較条件（音律・A4・楽器・練習条件）をそろえる | 4 | 試験済み | 同上 conditionsKey・conditionDifferences・音符単位の条件キー（workspace.js・view_diagnosis.js・API diagnosis） | U:trainer_diagnosis, workspace, review_regressions／API:postgres | 未実施 |
| DQ-005 | データ不足では診断しない | 4 | 試験済み | 同上 insufficient／reference | U:trainer_diagnosis | 未実施 |
| DQ-006 | 楽器・奏法の問題を測定結果だけから断定しない | 4 | 試験済み | 同上 suggestions文言 | U:trainer_diagnosis（故障・不良などの断定語なし） | 未実施 |

### E: 楽器

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| E-001 | 楽器の登録（名前・種類・メーカー・型番・任意名称） | 4 | 実装済み | view_history.js 楽器フォーム・storage_local.js putInstrument | 保存・削除はU:storage_local。フォームの自動試験なし | 未実施 |
| E-002 | 保存先の楽器を選ぶ | 4 | 試験済み | index.js setInstrument・workspace.js conditionsSnapshot | U:workspace（選択した楽器が条件に入る） | 未実施 |
| E-003 | 演奏条件の記録（気温・湿度・ウォームアップ） | 4 | 試験済み | intonation_profile.js normalizeEnvironment・workspace.js setEnvironment・view_history.js | U:trainer_diagnosis, workspace（条件キーに入れず、原因推定に使わない） | 未実施 |
| E-004 | セッティング（リード・マウスピースなど） | 4 | 試験済み | view_history.js settings（版）・settingRevisionを条件キーに含める | U:workspace | 未実施 |
| E-005 | 楽器別の音程分析 | 4 | 実装済み | view_diagnosis.js 条件選択（instrumentIdを含む） | 条件分離はU:trainer_diagnosis | 未実施 |
| E-006 | 条件別の比較 | 4 | 実装済み | view_diagnosis.js 条件の切替（混ぜない） | 2条件の並列比較画面はなく、条件を切り替えて比較する | 未実施 |
| E-007 | 調整・部品交換前後の比較 | 4 | 実装済み | view_history.js 調整・部品交換の記録（保存ごとに楽器の版が変わり別条件） | 自動試験なし | 未実施 |

### H: 履歴

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| H-001 | 履歴の保存（日時・種類・結果） | 4 | 試験済み | storage_local.js・workspace.js | U:storage_local, workspace | 未実施 |
| H-002 | 日付・楽器・練習内容で検索 | 4 | 実装済み | view_history.js 検索・storage_local.js listSessions filters | フィルター専用の試験なし | 未実施 |
| H-003 | セッション詳細（グラフ・統計・条件）を再表示 | 4 | 実装済み | view_history.js 詳細・history_graph.js（端末はpitch系列、DBは要約） | 系列の復元はU:storage_local | 未実施 |
| H-004 | 日別集計 | 4 | 試験済み | view_history.js periodTotals・intonation_profile.js periodKey | U:trainer_diagnosis | 未実施 |
| H-005 | 週別・月別集計 | 4 | 試験済み | 同上 | U:trainer_diagnosis | 未実施 |
| H-006 | 直近の同条件と比較 | 4 | 試験済み | view_history.js sameConditionComparison（音符単位の条件ごとに前回と比較） | U:review_regressions | 未実施 |
| H-007 | 成長グラフ | 4 | 試験済み | history_graph.js・view_history.js growthSeries（条件を選んで描画、条件の違う音符は混ぜない） | 系列はU:review_regressions。描画の自動試験なし | 未実施 |
| H-008 | 苦手音ランキング | 4 | 試験済み | intonation_profile.js weakRanking | U:trainer_diagnosis | 未実施 |
| H-009 | CSV・JSON 出力 | 4 | 試験済み | storage_local.js exportJson／exportCsv（数式の無害化）・API export | U:storage_local／API:contract | 未実施 |
| H-010 | 個別・全履歴の削除 | 4 | 未完 | storage_local.js deleteSession／deleteAll（tombstone・削除世代）・workspace.js deleteAllHistory・API DELETE | U:storage_local, storage_remote, review_regressions／API:postgres。別タブの全削除と保存の競合は実ブラウザーで未確認（9章） | 未実施 |
| H-011 | 自動保存の設定（保存しない・手動・自動） | 4 | 試験済み | workspace.js historyPrefs none/manual/auto | U:workspace／E2E:保存しない設定でIndexedDB・通信なし | 未実施 |

### SC: 画面構成

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| SC-001 | タブ構成（測定・音源・解析・練習・診断。履歴と設定は画面内のメニュー） | 1 | 試験済み | view_tabs.js（測定・音源・解析・練習・診断＋履歴・楽器・設定） | E2E | 未実施 |

### UI: 操作性

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| UI-001 | スマートフォン縦画面が基本 | 1〜4 | 試験済み | tuner.css | E2E:277／320／390／430 pxで横スクロールなし | 未実施 |
| UI-002 | タブ切替で測定音が途切れない | 1〜4 | 試験済み | view_tabs.js・workspace.js（内部タブは測定継続） | E2E（getUserMedia 1回のまま） | 未実施 |
| UI-003 | マイク稼働中の状態を明示 | 1〜4 | 試験済み | view.js 状態チップ（全タブで表示） | E2E | 未実施 |
| UI-004 | 画面を閉じたら音声取得を終了 | 1〜4 | 試験済み | launcher.js leave・index.js stop | U:lifecycle, body／E2E | 未実施 |
| UI-005 | 重要な数値を大きく表示 | 1〜4 | 実装済み | tuner.css | 目視 | 未実施 |
| UI-006 | グラフのズーム・スクロール・表示項目の切替 | 1〜4 | 実装済み | view_analyzer.js ズーム・スクロール・追従 | 自動試験なし | 未実施 |
| UI-007 | 既存ポータルと配色・操作体系を統一 | 1〜4 | 実装済み | tuner.css（ポータルの変数・Bootstrapボタン） | 目視 | 未実施 |
| UI-008 | ダークモード・全画面・高コントラスト | 1〜4 | 実装済み | tuner.css data-theme／data-contrast・tuner-maximized | 自動試験なし | 未実施 |
| UI-009 | 各設定の保存と初期値への復元 | 1〜4 | 試験済み | settings.js setPersist／resetPrefs（プリセットは保持） | U:music_settings | 未実施 |

### X: 技術

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| X-001 | 音声入力は getUserMedia | 1・2 | 試験済み | controller.js | U:lifecycle／E2E | 未実施 |
| X-002 | Web Audio API／AudioWorklet | 1・2 | 試験済み | capture.worklet.js（protocol 2） | U:transport, lifecycle | 未実施 |
| X-003 | 基音検出は既存を評価し、必要なら改善 | 1・2 | 試験済み | pitch.js（YINを流用し範囲・clip・曖昧さを追加） | U:pitch_spectrum（旧範囲の期待値も維持） | 未実施 |
| X-004 | FFT による周波数解析 | 1・2 | 試験済み | fft.js・spectrum.js | U:pitch_spectrum | 未実施 |
| X-005 | 基音と各倍音の相対強度 | 1・2 | 試験済み | spectrum.js relDb・analysis.worker.js harmonics | U:harmonics_sound | 未実施 |
| X-006 | ノイズ対策（入力レベル・信頼度・周波数の連続性） | 1・2 | 試験済み | pitch.js・display_filter.js | U:pitch_spectrum, display_filter | 未実施 |
| X-007 | 内部データ（Hz・時刻・音量・信頼度・測定音） | 1・2 | 試験済み | measurement_store.js | U:session_store | 未実施 |
| X-008 | 表示の更新は毎秒20～30回 | 1・2 | 試験済み | analysis.worker.js（全域30回/秒等）・index.js描画 | U:transport（30回/秒）。実機の描画頻度は未実施 | 未実施 |
| X-009 | 音域別・端末別に性能を評価 | 1・2 | 未検証 | 研究用スクリプト .tmp/tuner-research（合成音の音域別評価） | 端末別の性能評価は実機未実施 | 未実施 |
| X-010 | リアルタイム解析はクライアント側 | 1・2 | 試験済み | 全解析をブラウザー内で実行 | U:integration_contract（音声の通信なし） | 未実施 |
| X-011 | 周波数は Hz で保持し、cent は基準・音律・役割から算出 | 1・2 | 試験済み | Hz保持、centはtarget_modelで算出 | U:target_model | 未実施 |
| X-012 | 計測データと表示用の平滑化データを分離 | 1・2 | 試験済み | measurement_store.js（生値）／display_filter.js（表示） | U:target_model, workspace | 未実施 |

### D: データ

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| D-001 | TunerSettings | 1〜4 | 試験済み | settings.js（portalTunerSettings schemaVersion 1） | U:music_settings | 未実施 |
| D-002 | InstrumentProfile | 1〜4 | 実装済み | storage_local.js instruments・API instruments | U:storage_local（削除）／API:contract | 未実施 |
| D-003 | PracticeSession | 1〜4 | 試験済み | storage_local.js sessions・API sessions | U:storage_local／API:postgres | 未実施 |
| D-004 | NoteEvent | 1〜4 | 試験済み | noteEvents・API parts | U:storage_local, storage_remote／API:postgres | 未実施 |
| D-005 | PracticeResult | 1〜4 | 試験済み | trainer.js computeResult | U:trainer_diagnosis | 未実施 |
| D-006 | MeasurementSeries | 1〜4 | 試験済み | storage_local.js 標準Float32形式（18 B/frame） | U:storage_local（往復誤差≤1e-4 cent） | 未実施 |
| D-007 | IntonationProfile | 1〜4 | 試験済み | intonation_profile.js | U:trainer_diagnosis | 未実施 |
| D-008 | SoundPreset | 1〜4 | 試験済み | settings.js presets.sound・view_sound.js | U:music_settings／E2E | 未実施 |
| D-009 | AnalysisSettings | 1〜4 | 試験済み | index.js analysisConfig・analysis.worker.js configure | U:analysis_pipeline, lifecycle | 未実施 |
| D-010 | 計測値は浮動小数点で保持し、表示時に丸める | 1〜4 | 試験済み | Float32／Float64保持、表示時に丸め | U:storage_local, target_model | 未実施 |

### PV: プライバシー

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| PV-001 | 通常の測定音声をサーバーに送らない | 4 | 試験済み | 音声・PCMの送信経路なし | U:integration_contract（MediaRecorder・送信なし） | 未実施 |
| PV-002 | 統計・結果は利用者が有効にした場合のみ保存 | 4 | 試験済み | workspace.js（初期は保存しない） | U:workspace／E2E | 未実施 |
| PV-003 | 端末内保存とアカウント連携保存の両方を想定し、認証・DB を確認して決める | 4 | 試験済み | storage_local.js（端末）・storage_remote.js＋/api/tuner（要約のみ） | U:storage_remote／API:contract, postgres | 未実施 |
| PV-004 | 将来の録音機能は別の保存・削除方針 | 対象外境界 | 対象外（境界維持） | 録音機能・録音保存先を追加しない | U:integration_contract | 未実施 |

### N: 非機能

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| N-001 | iOS Safari・Android Chrome・PC の主要ブラウザー | 1〜5 | 未検証 | クラシックスクリプト・SharedArrayBuffer不使用 | PCのChromiumで自動試験のみ。iOS Safari・Android Chromeは実機未実施 | 未実施 |
| N-002 | マイク許可後、少ない操作で測定を開始 | 1〜5 | 試験済み | launcher.js（タップ内でAudioContext作成） | U:lifecycle／E2E。iPhoneは未実施 | 未実施 |
| N-003 | 通常演奏で違和感の少ない追従 | 1〜5 | 未検証 | display_filter.js 応答プリセット | 実演奏での体感は未実施 | 未実施 |
| N-004 | 30分以上の連続測定を試験 | 1〜5 | 未検証 | measurement_store.js 30分リング・ロス計数 | 30分連続の実測は未実施（リング上限はU:session_store） | 未実施 |
| N-005 | 基準音を使った端末別の誤差検証 | 5 | 未検証 | — | 別基準源による端末誤差の実測は未実施 | 未実施 |
| N-006 | マイク切断・権限拒否・音声中断への対応 | 1〜5 | 試験済み | controller.js・launcher.js・errors.js | U:lifecycle, body／E2E | 未実施 |
| N-007 | スマホの CPU・メモリー・電池の抑制 | 1〜5 | 未検証 | Worker分離・メモリー上限 | CPU・電池の実測は未実施 | 未実施 |
| N-008 | 許可なく音声・練習履歴を外部送信しない | 1〜5 | 試験済み | 同意・保存先の選択 | U:storage_remote, integration_contract／E2E | 未実施 |
| N-009 | 条件の違うデータを誤集計しない | 1〜5 | 試験済み | conditionsKey・stats除外・条件変更の境界（measurement_store.js conditions） | U:trainer_diagnosis, workspace, review_regressions | 未実施 |
| N-010 | 色以外でも音程の状態が分かる | 1〜5 | 実装済み | 文字・線種・記号の併用 | 目視 | 未実施 |
| N-011 | 電子音だけでなく実楽器（クラリネット・ヴァイオリンなど）で検証 | 1〜5 | 未検証 | — | 実楽器での検証は未実施 | 未実施 |

### AT: 受入

| ID | 要件 | Phase | 状態 | 実装箇所 | 自動検証 | 実機 |
|---|---|---|---|---|---|---|
| AT-001 | A4 = 440・442 Hz などで正しく目標を算出 | 1〜5 | 試験済み | target_model.js | U:target_model | 未実施 |
| AT-002 | 半音階の各音を正しく識別 | 1〜5 | 試験済み | pitch.js | U:pitch_spectrum（C1～C8の合成音） | 未実施 |
| AT-003 | 平均律・純正律が既知の比と一致 | 1〜5 | 試験済み | target_model.js | U:target_model | 未実施 |
| AT-004 | 指定周波数で発音・停止 | 1〜5 | 試験済み | playback.js | E2E:OfflineAudioContext | 未実施 |
| AT-005 | アタック・定常・終了区間を区別 | 1〜5 | 試験済み | note_events.js・analysis_stats.js | U:analysis_pipeline | 未実施 |
| AT-006 | 音程の変化を時間軸に表示 | 1〜5 | 実装済み | graph.js・view_analyzer.js | 描画の自動試験なし | 未実施 |
| AT-007 | 既知の周期・振幅のテスト音でビブラートを解析 | 1〜5 | 試験済み | analysis_stats.js analyzeVibrato | U:analysis_pipeline（既知の周期・振幅） | 未実施 |
| AT-008 | 指定した音列と演奏結果を正しく比較 | 1〜5 | 試験済み | trainer.js align | U:trainer_diagnosis | 未実施 |
| AT-009 | 同条件の音程傾向を正しく集計 | 1〜5 | 試験済み | intonation_profile.js | U:trainer_diagnosis | 未実施 |
| AT-010 | 異なる楽器の結果が混ざらない | 1〜5 | 試験済み | conditionsKey（instrumentId・版） | U:workspace, trainer_diagnosis | 未実施 |
| AT-011 | 保存・読込・比較・削除が正常に動作 | 1〜5 | 試験済み | storage_local.js・storage_remote.js・/api/tuner | U:storage_local, storage_remote／API:postgres | 未実施 |
| AT-012 | 利用中断・権限拒否・復帰を処理 | 1〜5 | 試験済み | controller.js・launcher.js・index.js | U:lifecycle, body, body_advanced／E2E | 未実施 |
| AT-013 | 画面表示と、測定結果が音響的に妥当であることを別の合格条件にする | 1〜5 | 実装済み | 音響（合成音のU試験）と画面（E2E）を別々に判定 | 本書「試験結果」で別に報告 | 未実施 |

## 4. 設計変更の記録

設計書・対応表の該当箇所にも同じ内容を記載した（設計書「17. 実装時の設計変更」、対応表「実装時の変更」）。

| No. | 変更 | 理由 | 影響ID | 代替案 | 検証 |
|---|---|---|---|---|---|
| DC-01 | `deviceSettings`（A4・表示設定）と音律・音源プリセットを IndexedDB ではなく localStorage の `portalTunerSettings`（schemaVersion 1）に置く。A4は常に保存、ほかは「この端末に設定を保存」をオンにしたときだけ保存。プリセットは各20件・各8 KBまで | 履歴保存がオフ（初期値）のとき IndexedDB を一度も開かないため。旧キー `portalTunerReferenceA4Hz` からの移行を単純に保つため | D-001, D-008, M-010, UI-009, T-011 | 設計どおり IndexedDB の `deviceSettings`／`presets` に置く（`storage_local.js` の presets ストアは残し、UIからは使わない） | U:music_settings／E2E（保存しない設定で IndexedDB を開かない、プリセット保存・呼出） |
| DC-02 | Worklet⇔Worker のメッセージ名は既存の `audio`／`return` を維持（設計の `pcm`／`recycle` と同じ内容）。`pitch` は1フレームずつ送る | 試験済みの既存転送経路と互換を保つため | X-002, X-007 | 名前を設計どおりに変更 | U:transport, lifecycle |
| DC-03 | 音符の音高分割は「対称窓 100 ms／120 cent と 350 ms／50 cent＋非最大抑制＋100 msの局所化」 | 移動基準方式では広い・遅いビブラートで分割が連鎖し、レガート境界が最大100 ms ずれたため | A-011, A-013, A-020, AT-005 | 移動基準＋ヒステリシス | U:analysis_pipeline（レガート±50 ms、ビブラート3～10 Hz・±50 centで分割しない） |
| DC-04 | 再アタックは「10 dB以上の落ち込みの後、30 ms以内に6 dB以上の立ち上がり」（立ち上がりのフレームを数える） | 落ち込みの長さを数える方式ではポルタートを見逃したため | A-011, A-020, P-006 | 包絡の微分だけで判定 | U:analysis_pipeline（−15 dBのポルタートは分割、±6 dBのトレモロは分割しない） |
| DC-05 | `/api/tuner` はシステム管理者の端末認証（`get_system_admin_device_auth`）に限定。非表示の管理者アカウントは `ACCOUNT_STORAGE_UNAVAILABLE` で端末内保存に切り替える | 実験室・システム管理者限定の範囲を API でも維持するため | PV-003, H-001～H-011 | 団員認証で公開 | API:contract, postgres |
| DC-06 | プロフィールの同一性は設計どおり `member_birth`（`members.created_at`、更新対象外）で照合し、加えて `members` の AFTER DELETE／AFTER INSERT トリガーで所有者を失効・データ削除する。端末認証時刻が `member_birth` より前なら再認証を求める | 削除・再作成・一括置換・本番→テスト同期のどの経路でも古い履歴を引き継がないため。`db_upsert_rows` は `created_at` を更新しないので不変性を確認できた（UUID移行は不要と判断） | PV-003, H-010, D-003, AT-011 | 団員の不変UUID列を追加する移行 | API:postgres（12件：削除・再作成・同期・遅延送信・他団体・失効） |
| DC-07 | チューナーの表は本番→テスト同期（`sync_prod_to_test`）の対象にしない。同期で団員を削除・再挿入すると、テスト環境の所有者はトリガーで失効する | 個人の練習履歴を本番からテストへ複製しないため（安全側） | H-010, PV-003 | 同期対象に追加 | API:postgres（再挿入で失効） |
| DC-08 | 状態チップと状態表示（「タップして測定を再開」を含む）をタブの外に置き、全タブで表示 | 音源タブなどで測定の一時停止・中断が見えず、再開ボタンも押せなかったため | UI-003, SC-001, T-010, N-006 | 各タブに複製 | E2E（全タブでチップ表示、背景から復帰） |
| DC-09 | 「recording」のまま残ったセッションは、2分以上更新がないものだけ「未完了」に復旧する（所有者確定時） | 別タブで記録中のセッションを誤って閉じないため | H-001, A-010 | 起動時に一律復旧 | U:workspace, storage_local |
| DC-10 | 演奏環境（E-003）は条件キーに含めず、記録・表示のみ | 設計の「原因推定には使わない」を守り、条件の細分化で比較できなくなるのを避けるため | E-003, DQ-004 | 条件キーに含める | U:trainer_diagnosis, workspace |
| DC-11 | 強弱による倍音比較（HA-004）は、同じ解析範囲・同じ音で音量差6 dB以上のときだけ比較とし、それ未満は並記のみ（6 dBは調整値） | 音量差が小さいと強弱の違いと言えないため | HA-004, HA-005 | 音量差の条件なし | U:harmonics_sound |
| DC-12 | 適応窓切替は実装したが無効（`adaptive:false`）のまま公開しない | 設計5.1の切替試験に合格する実測をしていないため（設計どおりの保留） | Q-006, T-018 | — | 手動プロファイルは U:analysis_pipeline |
| DC-13 | 練習の自動保存は、その練習が開始した記録だけを練習のセッションとし、終了・中止の時点で記録を止め（同期的）、結果を同じセッションに確定する。別の画面が始めた記録は引き継がない | 終了後も記録が続き、「記録中」と「保存完了」の2件ができていた（レビュー指摘1） | P-001, H-001, H-011, A-010 | 結果だけを別セッションで保存し記録は破棄 | U:review_regressions（終了後の入力が保存されない、中止も1件） |
| DC-14 | 全削除は所有者ごとの「削除世代」を進め（同じタブは即時、他のタブは ownerSettings.historyGeneration）、容量確認後と書込トランザクション内で照合する | 容量確認中の保存要求が全削除の後に成功し、履歴が復活した（指摘2） | H-010, AT-011, D-003 | 全削除でも削除済みの印を残す | U:review_regressions（同一タブ・別タブ・chunk・楽器） |
| DC-15 | A4・目標の定義・許容幅の変更を、測定ストアに条件付きの境界として記録する。解析（Worker・代替計算とも）は各音符をその時点の条件で判定し、保存では条件の違う音符に音符単位の条件キー（target.conditionKey）を付け、端末とサーバーの診断はそのキーで集計する | 変更前の測定も変更後の目標で解析されていた（指摘3）。境界が本番の画面では記録されていなかった | T-005, T-011, A-014, DQ-004, N-009, AT-009 | 条件変更でセッションを分割 | U:review_regressions／API:postgres（音符単位の条件キー） |
| DC-16 | 全削除の後、およびサーバーが削除世代の不一致（409 HISTORY_EPOCH）を返した後は、本人情報を取り直して新しい世代で保存する | 全削除後の新しい履歴が旧世代で送られ、拒否・破棄されていた（指摘4） | H-010, PV-003, AT-011 | 削除応答の世代だけを反映 | U:review_regressions |

| DC-17 | 練習ごとに「試行」（課題・測定範囲・記録ID）を作って固定し、解析の完了・保存は開始した試行にだけ作用させる。画面の更新は現在の試行のときだけ。次の練習の開始時、解析中の前の試行は自分で確定し、解析が新しい要求に置き換えられた場合は結果なし（`evaluation-superseded`）で確定する | 前の練習の解析完了が、次の練習の記録を止めていた（2回目のレビュー指摘1） | P-001～P-012, H-001, H-011 | 解析中は次の練習を開始させない | U:review_regressions（解析待ちの間に次の練習を開始） |
| DC-18 | 履歴詳細の「前回（同じ条件）との比較」と成長グラフは、音符単位の条件キーで音符を分け、条件ごとに比較・描画する（成長グラフは条件を選択）。期間ごとの集計の「差の中央値」は全条件をまとめた参考値と明記する | セッションの条件キーだけで前回を選び、全音符の中央値を出していたため、条件の違う音符が混ざっていた（指摘2） | H-006, H-007, DQ-004, N-009 | 途中で条件を変えた記録を比較から除外 | U:review_regressions |
| DC-19 | 保存の有効性（所有者・削除世代・同意）と画面の鮮度を分ける。保存世代は画面からの退出でだけ進め、別の練習・保存の開始では前の保存を無効にしない。確定時は所有者が有効なら端末に確定し、その時点の同意があれば送信待ちに追加する | 練習Aの解析待ち中にBを開始すると、Aが端末には保存されるがアカウントへ送られなかった（3回目のレビュー指摘） | P-001, H-001, H-011, PV-002, PV-003 | 練習ごとに保存世代を持つ | U:review_regressions（A解析待ち→B開始→A完了でA・Bとも送信、ログアウト後の完了は別アカウントで送らない） |

DC-13～DC-16 は 2026-10-18 のコードレビューで再現された4件、DC-17・DC-18 は2回目、DC-19 は3回目のレビューで再現された問題（いずれも実機に依存しない）への修正。レビューの操作順をそのまま `tests/frontend/test_tuner_review_regressions.test.js` と `tests/backend/test_tuner_practice_postgres.py` に回帰試験として追加した。

**未解決（H-010）: 別タブでの全削除と保存の競合。** 保存要求は呼び出しの時点で、所有者の削除世代を読むトランザクションを同期的に作り、書き込みのトランザクション内で同じ値か照合する。同じタブの全削除は、メモリー上の世代で即時に拒否する。別のタブの全削除に対しては、IndexedDB が接続をまたいでもトランザクションを作成順に実行することを前提にしている。この前提は fake-indexeddb でしか確認しておらず、実ブラウザー（Safari・Chrome）の複数タブでは確認していない。そのため、別タブでの全削除の安全性は確認済みとしない（MANUAL_DEVICE_QA_CHECKLIST 7-11-5 に確認項目を追加）。

## 5. 試験と結果（2026-10-18、Windows 11・Node・Chromium）

| 確認 | 結果 |
|---|---|
| `uv run python -m compileall -q src/backend tests` | 合格 |
| `uv run ruff check .` | 合格（指摘0件） |
| `uv run pytest` | 667件合格、14件スキップ（使い捨てPostgreSQLのDSN未指定の試験） |
| `TUNER_TEST_DSN` を指定した `uv run pytest`（使い捨て PostgreSQL 16、Docker） | 680件合格、1件スキップ（メニュー設定のPostgreSQL試験は別DSNが必要） |
| `npm run check:frontend:syntax`／`check:frontend:load-order`／`check:frontend:state-access` | 合格（135ファイル、違反0件） |
| `npm run test:frontend` | 89ファイル・918件合格 |
| `npm run test:e2e` | 58件合格（最終実行）。直前の実行では、チューナーと無関係な `ui_css_reliability.spec.js` の団員ホーム表示（お知らせ要素の描画待ち）が1件失敗し、単独の3回反復では1回失敗・2回合格。チューナーを読み込まない試験で、断続的な失敗として扱う |
| `npm run generate:tuner-release`／`check:tuner-release` | 合格（全ファイル同じリリースID） |
| `python scripts/check_operational_checklists.py`／`npm run check:release-safety` | 合格 |

既存の期待値は下げていない。範囲変更（31～4,400 Hz → 28～4,700 Hz）で雑音試験の旧条件（C1、SNR 20 dB、±6 cent）が満たせなくなったため、旧範囲での元の期待値を維持し、新範囲が旧範囲より不正確でないこと（400種の乱数で同じ分布）を相対比較で追加した。新たな絶対上限は設けていない。

疑似マイク用のWAVは試験時にOSの一時フォルダー（`portal-tuner-e2e`）に生成し、リポジトリ・ZIPには含めない。

## 6. 精度・性能の条件と限界

- 精度の数値は合成音（48 kHz／44.1 kHz、純音・倍音音・基音欠落・雑音混合）での結果。実楽器・実マイク・部屋の反響・端末の前段処理（自動利得・雑音抑制）は含まない。
- 解析プロファイル: 全音域（長窓、28～4,700 Hz、30回/秒）、低音（長窓、28～880 Hz、20回/秒）、高音・ビブラート（短窓、110～4,700 Hz、40回/秒）。実際の範囲は端末のサンプリング周波数とNyquistで制限する。
- ビブラートは短窓プロファイルで速さ±0.1 Hz・幅±10%（合成音）。長窓（30 ms超）では幅が減衰するため値を出さず保留する。
- 発音直後（最初の100 ms）は窓の都合で測れないことがあり、その場合は欠測とし後の値で埋めない。
- 基音が弱い・欠落する高音（C6～C8）や低音はオクターブ曖昧として印を付け、正確な値として数えない。
- 同時使用モードでは、再生音が演奏音の倍音と重なると混入を判定できない。同時使用中の値は参考表示で、診断・成長の統計に使わない。イヤホンの申告も保証ではない。
- 端末内の保存上限は100 MB・1セッション2時間・10,000音（設計値）。上限に達すると保存だけを止め、測定は続ける。端末内保存は暗号化されない。
- 総合スコアは正規化が未校正のため表示しない（常に null）。
- 表示更新は20～30回/秒を目標とした設計値で、実機の描画頻度・CPU・電池は未測定。

## 7. 実機確認（すべて未実施）

PCのChromium（疑似マイク）では、iPhone Safari の初回許可・オーディオセッション・バックグラウンド・Wake Lock・音声経路を確認できない。手順は [MANUAL_DEVICE_QA_CHECKLIST.md](MANUAL_DEVICE_QA_CHECKLIST.md) の「7-11. 高機能チューナー」に追加した。最初に確認するのは「7-11-1. 初回起動・停止・再開（タブ構成）」。

確認の前提（阻害要因）: 今回の版をテスト環境へデプロイすること（デプロイは今回の作業範囲外）。アカウント同期の確認には、共有テスト環境DBへのマイグレーション017の適用が必要（8章）。

## 8. DBマイグレーションとロールバック

- 追加: `db/migrations/017_tuner_practice.sql`。表 `tuner_owners`、`tuner_preferences`、`tuner_instruments`、`tuner_presets`、`tuner_sessions`、`tuner_upload_parts`、`tuner_note_events`、`tuner_tombstones`、関数 `tuner_revoke_member_owner`・`tuner_members_owner_guard`、`members` のトリガー2つ。既存の表・列は変更しない。
- 適用: 通常のリリース手順（`deploy-test.yml`／`promote-production.yml` の `scripts/migrate_db.py`）。起動時の自動適用はしない。
- 今回の適用: 使い捨ての PostgreSQL 16（Docker、ローカル）で 001～017 を `scripts/migrate_db.py` により適用し、再実行で全件スキップを確認。共有テスト環境DBの接続情報はGitHubのSecretにだけあり、ローカルから適用していない（未適用）。本番DBは変更していない。
- ロールバック（アプリ）: 017適用後に前の版のアプリへ戻しても、前の版はチューナーの表を参照しないため動作に影響しない。トリガーは団員の削除・新規挿入時にチューナーの表だけを変更する。
- ロールバック（DB、必要な場合のみ・手作業）: チューナーの履歴を消してよいことを確認し、バックアップを取ってから次を実行する。`schema_migrations` から 017 の行を消すと、次回のリリースで再適用される。

```sql
DROP TRIGGER IF EXISTS trg_tuner_members_owner_guard_delete ON members;
DROP TRIGGER IF EXISTS trg_tuner_members_owner_guard_insert ON members;
DROP FUNCTION IF EXISTS tuner_members_owner_guard();
DROP FUNCTION IF EXISTS tuner_revoke_member_owner(TEXT, BIGINT, TEXT);
DROP TABLE IF EXISTS tuner_note_events, tuner_upload_parts, tuner_tombstones, tuner_sessions, tuner_presets, tuner_instruments, tuner_preferences, tuner_owners;
DELETE FROM schema_migrations WHERE version = '017';
```

- 本番→テスト同期（`sync_prod_to_test`）では、団員の削除・再挿入によりテスト環境の所有者が失効し、その練習要約が削除される（安全側）。DB全体の復元（pg_restore）では、復元時点の団員とチューナーの表がそろって戻る。

## 9. 未完一覧（消さずに追跡する）

| ID | 内容 | 次の作業 |
|---|---|---|
| Q-006 | 適応窓切替を公開していない | 実機・実楽器で切替試験（設計5.1の条件）を行い、合格したら有効化 |
| PR-008 | 総合スコアの正規化が未校正 | 実演奏データで課題別の正規化を校正 |
| X-009, N-001, N-003, N-004, N-005, N-007, N-011 | 実機・実楽器・端末別の評価が未実施 | MANUAL_DEVICE_QA_CHECKLIST 7-11 を実施 |
| （全行） | 実機確認が未実施 | 同上 |
| — | 共有テスト環境DBへの017適用が未実施 | 通常のテスト環境デプロイで `migrate_db.py` を実行 |
| H-010 | 別タブでの全削除と保存の競合（4章の未解決事項）の安全性が実ブラウザーで未確認 | 実ブラウザーの2タブで、片方の保存中に他方で全削除し、履歴が復活しないことを確認する。確認できなければ、BroadcastChannel 等による別タブへの即時通知か、全削除中の書込禁止を追加する |

## 共通出力管理への移行（2026-10-18、メトロノーム第2回）

[メトロノームの設計4.1](METRONOME_DESIGN.md#output)に沿って、チューナーの基準音・音源パターンの再生を、メトロノームと共有するページ単位の出力管理（`src/static/js/modules/audio/output_manager.js`）へ移した。測定（マイク）のAudioContextは従来どおり別で、変更していない。

| 項目 | 変更後 |
|---|---|
| 再生のContext | ページの出力管理が唯一の所有者。チューナーはleaseのbusへ鳴らす。音量の絶対値は従来どおり（0.25の上限を緩めない） |
| 停止・退出 | 停止でleaseを終える（音は残らない）。Contextは60秒の無操作か、チューナーとメトロノームの両方が画面を離れた時に閉じる（従来は停止の約80 ms後に閉じていた） |
| 別タブ | 音を使う権利（Web Locks、使えない端末はIndexedDBの記録）を画面の表示中に保持。別のタブが使用中なら「再生」は案内を出して鳴らさない |
| メトロノームとの排他 | メトロノームが音を使っている間は、チューナーの基準音を鳴らさず案内する（同時使用の明示選択時だけ両立） |
| 練習の「メトロノーム」課題 | メトロノームのエンジンが読み込まれていればそれでクリックと光の拍を出す（音あり課題は従来どおり同時使用とイヤホンの申告が必要、クリックの区間は統計から除外）。未読込なら従来のタイマー経路 |
| release | チューナーのrelease idに共通音声のid（`a-…`）を含め、launcherの `TUNER_AUDIO_RELEASE_ID` で共通音声を読み込む |

試験: `tests/frontend/test_tuner_shared_output.test.js`（独自Context／lease、排他、取消、課題、名前空間）、チューナー契約試験、`tests/e2e/tuner.spec.js`（停止後のlease無し・退出でContextが閉じることに期待値を変更）。実機での同時使用・混入・Bluetooth・旧タブ復帰は未確認（メトロノームのMD-13/17/19）。

### 2026-10-18 メトロノーム第3回の追加

- 音の画面の「同時に使う」＋「イヤホン」の選択を、共通出力管理の同時使用の許可にもつなげた（退出で解除）。選択していない間は、メトロノームの再生中に基準音を鳴らさない（従来どおり）。
- メトロノームの解析画面でチューナーを同時表示している間、鳴ったメトロノームのクリックを外部出力として受け取り、測定中は同時使用の宣言がなくても統計から除外する（基準音の再生状態の表示は変えない）。
- 試験: `tests/frontend/test_tuner_workspace.test.js`（外部出力の除外）、`tests/frontend/test_metronome_review_round3.test.js`（接続の契約）。実機での混入の確認（MD-13）は未実施。
