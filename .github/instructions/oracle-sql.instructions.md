---
applyTo: "**/*.{sql,ddl,dml}"
---

# SQL Guidance

対象DBの種類・バージョンに合わせてSQLを記述する。
奏オケポータルの通常のDBはPostgreSQL。Oracleを扱う場合はその環境の仕様を参照する。

- 本番データ、Secret、DB整合性を保護する。
- UPDATE / DELETE の対象範囲を確認する。
- PK、NOT NULL、DEFAULT、INDEX、CONSTRAINTの変更時は影響を確認する。
- トランザクションとロールバック方針を明確にする。
- SQLはパラメータ化し、NULL・空文字・デフォルト値の扱いを確認する。
- 実DBでの実行結果と未実行の検証を区別して報告する。
