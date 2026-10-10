# メニュー管理

システム管理の「メニュー管理」で、ホーム／ドロワー共通のメインメニューをON/OFFにし、一括保存する。通常21項目、通知設定がメニュー定義にある場合は22項目となる。保存成功後に反映し、失敗時は編集中の値を保持して再試行できる。

対象は `portalMenuGroups()` の各項目だけ。システム管理入口は対象外。管理／システム内の個別メニュー、ツールバー、操作ボタン、画面内ボタンは変更しない。メニュー管理自身も対象外。表示OFFは機能停止やアクセス拒否を意味しない。従来の認証・認可・エキストラや管理担当の表示制御を維持する。

## 保存と配信

- `GET /api/system/menu-settings` は編集一覧を取得する。
- `PUT /api/system/menu-settings` は `visibility` に通常21キーすべてとbooleanを指定して一括保存する。通知設定キーは任意で、定義されている場合に追加する。両APIは既存のシステム管理者認証を要求する。
- 管理APIの `optional_keys` は通知設定キーを示す。画面は共通表示設定を適用する前のメニュー定義で有無を判断し、未実装の項目は表示しない。任意キーを省略した保存でもDBの既存値を削除しない。未知キーや必須キー不足は従来どおり拒否する。
- 固定キーは既存のtab/action値。`system` や未知のキー、不完全な一覧は保存できない。
- `menu_visibility_settings` の `(organization_id, menu_key)` ごとに `visible` と `updated_at` を保存する。設定なしはON。同じ団体の全ユーザーに共通で、他団体の設定とは分離する。
- bootstrap-lite／bootstrap-core／bootstrapの `menu_visibility` に配信する。ETagに団体IDと同じ設定スナップショットを含め、変更時は200、新旧同一時は304を返す。管理用一覧や認証情報は配信しない。
- 既存request処理が保存成功時にbootstrapのIndexedDBキャッシュを無効化する。保存端末は即時再描画。他端末は起動、更新、既存の復帰時再取得で反映する。オフライン先行表示は最後に取得した設定を使用する。
- 明示的なローカルJSONモードは全ONで表示できるが、保存は503とする。JSONやメモリーへの代替永続化は設けない。DBモードの取得エラーを未設定扱いにはしない。

## マイグレーション

`db/migrations/016_menu_visibility_settings.sql` を新設する。既存マイグレーションは変更しない。PostgreSQLでこのマイグレーションを適用してから機能を利用する。通常のマイグレーション手順は `uv run python scripts/migrate_db.py`。このコマンドは未適用の他のマイグレーションも処理するため、運用時は適用対象を確認する。

## 検証

backend `test_menu_settings.py`、frontend `test_menu_management.test.js`、E2E `menu_management.spec.js` で対象範囲、初期値、保存、権限維持、配信とキャッシュ、失敗時を確認する。既存通知テストも実行する。

`test_menu_settings_postgres.py` は `MENU_SETTINGS_TEST_DSN` に明示した使い捨てローカルDBだけを使用し、DDL、永続化、団体分離、NOT NULL違反時の一括ロールバックを確認する。本番／テスト環境のDB接続設定は利用しない。
