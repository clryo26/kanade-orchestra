---
applyTo: "**/*.{sql,ddl,dml}"
---

# Oracle SQL Instructions

## 基本方針

Oracle 19c を前提にする。ただし、利用バージョンが明示されている場合はその指定を優先する。

## 禁止事項

- 本番DBに対する破壊的SQLを安易に提示しない。
- WHERE句なしのUPDATE / DELETEを提示しない。
- PK、NOT NULL、DEFAULT、INDEX、CONSTRAINTの変更は影響範囲を明記せずに提案しない。
- COMMIT / ROLLBACK 方針を勝手に変更しない。

## SQL提示時の必須事項

- 対象テーブル
- 対象カラム
- 変更内容
- 実行前確認SQL
- 実行SQL
- 実行後確認SQL
- ロールバック方針または戻しSQL
- 未確認事項

## INSERT / UPDATE / DELETE の注意

- INSERT文では `VALUES` を使用する。
- NULL、空文字、デフォルト値の扱いを明記する。
- CHAR型の場合、桁数と空白埋めの影響を考慮する。
- 主キー項目にNULLは設定できない前提で扱う。

## 断定禁止

実DBで実行していない限り、以下は禁止する。

- 確認済み
- 問題なし
- 正常終了
- 完了

必ず「未実行」「未確認」と明記する。
