# 第2段階A 監査主体の再利用可否 v1.0

2026-10-21 / 詳細設計v1.3 / 読取対象: `9c76fd920fab12a1e3c5286c0c6adbc2e9099309`

## 1. 判定

**今回の読取調査だけで、監査主体の再利用を有効化してよいと判定した経路はない。** 同一性を確認する候補と、既存の再取得を維持する経路を分ける。監査内容が変わる可能性を受け入れて有効化する設計にはしない。

現状は認証の依存処理でrequest.stateへの監査用受渡しを行っていない。今回の資料作成でもソースは変更しない。

## 2. 現在の監査契約

- audit_middleware.pyはawait call_next(request)の後、finallyでshould_auditを判定し、同期的にwrite_audit_logを呼ぶ。応答の送信完了後という保証ではない。
- should_auditは有効設定時の/api/配下のPOST/PUT/PATCH/DELETE。/api/system/audit-logs配下は除外。通常GETは対象外で、診断GETの専用記録は別経路。
- write_audit_logはDB有効を確認後、X-Device-Idがあればdevice_auth_recordで主体を再取得し、取得失敗時は{}として既存のINSERTを行う。statusがエラーでも認証時の結果だけで主体を空にしない。
- 主体の記録値はactor_device_id（要求ヘッダー）、actor_member_id（fk_int）、actor_member_name（member_nameまたはname）、actor_permission。ほかにaction/method/path/status/target/request_id/user_agent/ip/detailを記録する。
- device_auth_recordはデバイス取得に失敗/不存在の場合、メモリ代替を返すことがある。通常のDB経路は団員が紐づけば現在の団員の権限・氏名等も読む。取得元を表す印は現状の戻り値にない。
- 現在のServer-Timingは監査前の時間。DBの主体取得・INSERTはいずれも共通プールを使用するが、借用回数は団員紐付けなどの経路で異なる。

根拠: core/audit_middleware.py、services/audit_service.py:26–133、services/auth_service.py:129–178、core/auth_dependencies.py、core/authorization.py。

## 3. 静的な経路の一覧

[PERF_STAGE2A_AUDIT_ROUTES.csv](PERF_STAGE2A_AUDIT_ROUTES.csv) はPython構文解析で採取した、75個のPOST/PUT/PATCH/DELETEルート宣言。デコレーター位置、関数、ローカルprefix込みパス、Depends、直接の認証呼出しを記録する。

TunerUser等の同一ファイルの `名前 = Depends(...)` も展開した。空欄は「認証不要」ではなく、依存宣言/直接呼出しが採取対象に現れないという意味である。サービス内の権限検査、汎用extraのname別操作、各API内部の分岐を1行へ潰して安全と判定しない。

router_registry.pyの登録対象を読取確認した。noticesはbootstrapルーターからincludeされる。CSVは実稼働のOpenAPI・通信・認証結果を確認した一覧ではなく、登録時の条件や本番設定の証明でもない。

| ファイル/グループ | 宣言数 | 認証入口の特徴 | 今回の可否 |
|---|---:|---|---|
| auth_api.py | 3 | ログイン、パスワード設定、端末削除。互換gateway経由の認可を含む | 再取得維持。認証そのものを変更する |
| routers/access_logs.py | 1 | Depends経由 | 候補に留める。actorの同時変更と失敗分岐を未試験 |
| routers/albums.py | 5 | get_device_auth。汎用extraとname別の権限/資産処理 | 再取得維持。name別に分類してから判断 |
| routers/announcements.py | 3 | 管理者依存 | 候補。並行する権限取消等の同一性は未証明 |
| routers/events.py | 3 | 団員/管理者依存 | 候補。同上 |
| routers/improvement_suggestions.py | 4 | 団員/システム管理者依存 | 候補。同上 |
| routers/members.py | 5 | 管理者/団員依存。自分や他の監査主体を変更し得る | 再取得維持。プロフィール/権限/削除を含む |
| routers/metronome.py | 8 | 名前付きDependsを含む | 第2段階の主体共有へ一律に組み入れない。既存再取得 |
| routers/notices.py | 3 | ルート依存をCSVへ記録 | 候補。失敗/並行変更の同一性は未証明 |
| routers/notifications.py | 3 | get_device_auth | 候補。同上 |
| routers/performances.py | 3 | 管理者依存、資産操作を含む | 候補。処理中の主体変更も試験が必要 |
| routers/recordings.py | 5 | 録音担当依存、変換/アップロード | 候補。長い操作と並行権限変更の検証が必要 |
| routers/schedules.py | 3 | 管理者依存 | 候補。並行変更の同一性は未証明 |
| routers/scores.py | 9 | 楽譜担当等の依存と専用サービス | 候補。アップロード/チケット/ジョブ/中止の状態を維持 |
| routers/system.py | 6 | システム管理者・本番操作権限 | 権限変更/運用操作は再取得維持。その他も候補止まり |
| routers/tuner.py | 11 | 名前付きDependsを含む | 音声機能の認証/監査を一律変更しない。既存再取得 |

宣言数は一般APIの種類数や実行回数ではない。汎用extra1宣言から多数のcollectionへ分岐する。追加の再利用候補を設定する場合は、その分岐まで対象を狭める。

## 4. 必ず既存の取得へ戻す条件

| 状態・経路 | 理由・処理 |
|---|---|
| 認証/認可失敗 | 現在も監査時にdevice_auth_recordを呼ぶ。依存で失敗したことだけでactor={}にしない |
| 認証依存未実行・主体未設定 | handlerやサービス内の独自認証を無理に同一視しない |
| fallback_auth_device利用 | DBの現在値と同じ保証がない。既存の再取得へ戻す（再取得も代替を返す場合の既存値は維持） |
| 取得元不明、JSONローカル/DBの区別不明 | DB由来の確認済み主体とみなさない |
| 氏名・権限・団員・デバイスを変更する操作 | 認証時点と監査時点が違う。自分以外の変更でも並行操作の影響を確認 |
| 非同期ジョブ・長い資産操作・運用操作 | 処理時間中に主体の現在値が変わり得る。単に認証成功しただけでは再利用しない |
| 同時の権限取消・団員削除・device取消等で値が変わり得る | 既存の「監査時に読む」契約と異なる。安全を証明できなければ未有効化 |

## 5. 再利用を実装する場合の受渡し契約

1. 依存処理の薄いアダプター等で、認証の成否・取得元・device一致・候補経路を内部情報として保持する。既存の直接関数呼出しとの互換性を維持する。
2. request.stateへは監査に必要な主体項目と判定情報だけを受け渡す。認証record全体や資格情報をログへ流さない。handlerが元dictを変更しても監査用の値が意図せず変わらない形にする。
3. middlewareのfinallyで読み、**明示した許可経路＋成功＋DB由来＋値の同一性を保証**する場合だけwrite_audit_logへ渡す。
4. 「再利用情報なし」と「確認済みだが主体が空」を区別し、空dictのtruthinessだけで再取得の省略を決めない。
5. 条件を満たさない場合は既存の主体再取得を実行する。監査の例外が本体結果を上書きしない既存契約を維持する。

取得元の印は外部の認証JSONに追加しない。メモリ代替認証や監査の非同期化をこの整理に便乗して変更しない。

## 6. S2-18の確認項目と計測

- 実際のmiddleware/Depends構成でrequest.stateの共有を確認する。200/201/204、401/403、500、call_next例外で件数とstatus/主体/target等を旧処理と比較する。
- DBデバイス＋団員、member_idなし、失効団員、device不存在、DB例外による代替、取得元不明、主体再取得失敗を別ケースにする。
- 自分の氏名/権限変更、別要求の権限取消・団員削除・device取消を途中に挿入し、旧処理と同じ監査値になるかを検証する。
- 主体取得の接続回数・待ち時間、INSERTの待ち/実行、監査全体、イベントループへの影響を分離して記録する。共通プール最大5を二重計上しない。

今回これらの試験・実DB計測は行っていない。候補経路で同一性を立証できなければ再利用を有効化せず、PERF-R22の効果は未達として残す。無理に安全条件を緩めて完了扱いにしない。
