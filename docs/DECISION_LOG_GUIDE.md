# DECISION_LOG_GUIDE

最終更新: 2026-07-02

## 目的

設計判断を [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md) に統一し、判断理由の追跡を容易にする。

## 記録フォーマット

以下のフォーマットで ADR を追加する。

```markdown
## ADR-XXX: タイトル

- Status: Proposed / Accepted / Superseded
- Context: 背景と課題
- Decision: 採用した判断
- Consequence: 影響範囲とトレードオフ
- Related: 関連ファイル/文書
```

## 運用ルール

- 新規の設計判断は `docs/ARCHITECTURE_DECISIONS.md` のみ更新する。
- 仕様変更を伴う実装PRでは、判断追記の要否を PR テンプレートでチェックする。
- 既存文書に判断理由が散在している場合は、ADRへ移植して参照リンクを残す。

## 追加タイミング

- API 仕様の互換判断をしたとき
- データ構造/保存先を変更したとき
- CI や QA ゲートの必須要件を変更したとき
- フロントの読み込み順や状態管理など、横断ルールを変更したとき

## ステータス運用

- `Proposed`: 検討中
- `Accepted`: 採用済み
- `Superseded`: 後続ADRで置き換え済み
