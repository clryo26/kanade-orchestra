# フロントエンド分割仕上げレポート

## 実施内容

### 1. app.js廃止準備

- 本番画面では `src/static/js/app.js` を読み込まない構成を維持しました。
- `app.js` は既存フロントエンドテストが参照しているため、互換用のレガシースナップショットとして残置しました。
- 実行時の本体は `main.js` と `modules/` 配下へ整理しています。

### 2. main.js追加分割

`src/static/js/main.js` から以下の機能群を追加分離しました。

- `modules/common_helpers.js`
  - 共通ヘルパー、APIリクエスト、キャッシュ無効化、HTMLエスケープ、トースト表示など
- `modules/bootstrap_loader.js`
  - 初期データ読込、ブートストラップデータ反映、追加データ読込
- `modules/navigation.js`
  - ポータルメニュー、管理メニュー、タブ切替、アクセスログ記録
- `modules/upload_forms.js`
  - アップロードフォーム、ファイル選択、アップロード処理
- `modules/admin_system.js`
  - 認証端末、アクセスログ、パート設定、会場設定、団体設定、DBビュー
- `modules/portal_views.js`
  - ホーム、演奏会記録、プロフィール編集、マニュアル、チラシプレビュー
- `modules/performance_day.js`
  - 本番スケジュール、衣装、タイムライン、Excel出力
- `modules/practice_casting.js`
  - 演奏指示管理、PDF表示、乗り番表管理
- `modules/date_piece_promotion.js`
  - イベント調整、楽曲情報、練習指示、演奏希望曲、広報素材

### 3. 読み込み順整理

`src/index.html` のJS読み込み順を更新し、以下の順番にしました。

1. config / api / utils
2. main.js
3. 共通・基盤モジュール
4. 既存機能モジュール
5. auth_feature.js

`auth_feature.js` はログイン処理を上書きしないよう最後に読み込む構成を維持しています。

### 4. 構文チェック

以下を実行済みです。

```bash
npm run check:frontend:syntax
```

結果: 成功

※ `npm run test:frontend` は、この環境に `vitest` がインストールされていないため未実行です。CIまたはローカルで `npm install` 後に実行してください。

## 効果

- `main.js` はポータル起動処理と共有状態中心に縮小しました。
- 機能別モジュールへの分離が進み、今後の修正対象を絞りやすくなりました。
- `app.js` は実行系から切り離し、テスト互換用に残す段階へ移行しました。

## 次の改善候補

1. `app.js` 参照テストを `main.js` / `modules/` 参照へ置き換える
2. `app.js` を完全削除する
3. `date_piece_promotion.js` がまだ大きいため、イベント調整・楽曲情報・演奏希望曲・広報素材に再分割する
4. Repository層を本格導入してJSON/DB移行を容易にする
