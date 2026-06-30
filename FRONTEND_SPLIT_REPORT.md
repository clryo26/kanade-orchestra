# フロントエンド分割レポート

## 目的
巨大化していた `src/static/js/main.js` から、機能別モジュールへ処理を移動し、今後の保守・修正を行いやすくした。

## 主な変更

### 1. main.js の役割を縮小
`main.js` は以下を中心に残した。

- グローバル状態 `appState`
- 共通ユーティリティ
- 初期読み込み処理
- 共通メニュー制御
- モジュール横断の処理

### 2. 機能別モジュールへ移動
以下の機能を `src/static/js/modules/` 配下へ分離した。

- `announcements.js`：お知らせ
- `performances.js`：演奏会情報
- `schedules.js`：練習予定
- `recordings.js`：録音データ取得系
- `members.js`：団員登録・団員表示
- `absences.js`：欠席連絡
- `payments.js`：支払状況
- `events.js`：イベント調整
- `scores.js`：楽譜ライブラリ
- `albums.js`：アルバム
- `sns.js`：SNS・演奏会記録

### 3. 読み込み順を整理
`src/index.html` の script 読み込み順を整理し、`main.js` の後に機能別モジュールを読み込むようにした。

`auth_feature.js` はログイン処理を上書きしないよう最後に読み込む。

### 4. app.js は互換用として残置
既存テストや仕様書が `src/static/js/app.js` を参照しているため、今回の修正では削除せず、互換用ファイルとして残している。

## 確認内容

- `node --check` による JavaScript 構文確認済み
- `main.js` と各 modules の重複関数定義を解消
- `index.html` のキャッシュバージョンを更新

## 今後の改善候補

- `app.js` 参照テストを `main.js` / modules 参照へ移行
- `app.js` の削除
- 共通API処理を `api.js` にさらに集約
- `main.js` に残る描画処理の追加分割
- ES Modules 化
