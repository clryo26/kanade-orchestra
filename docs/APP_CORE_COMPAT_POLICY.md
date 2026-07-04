# APP_CORE_COMPAT_POLICY

最終更新: 2026-07-02

## 目的

`src/backend/app_core.py` を互換専用レイヤとして扱い、今後の新規機能が app_core に流入するのを防ぐ。

## 方針

- app_core は互換公開面維持を目的とする。
- 新規ビジネスロジックは `services/`, `core/`, `repositories/` に実装する。
- 新規で app_core の公開シンボルを増やす場合は、互換維持の理由を設計記録に残す。

## 禁止事項

- app_core を新規機能の主要実装先にすること。
- 互換理由なしに app_core へ関数追加すること。

## 例外

- 既存互換テストが要求する公開面維持
- 段階移行中の短期ブリッジ（期限明記）

## 運用

- 互換公開面は [docs/APP_CORE_EXPORT_INVENTORY.md](docs/APP_CORE_EXPORT_INVENTORY.md) で管理する。
- CI の import boundary / public surface テストを維持する。
- Phase8-B 以降は `npm run check:release-safety` でも import boundary を再検証する。
