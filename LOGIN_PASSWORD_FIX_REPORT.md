# ログインパスワード修正レポート

## 現象
ログイン時に `Invalid member password` が表示され、団員ログインできない。

## 原因
`app_core.py` 分割後、パスワード処理を `src/backend/services/security_service.py` に移した際、既存データで使われていた可能性のある `pbkdf2$sha256$...` 形式のハッシュ検証が実装されていませんでした。

そのため、保存済みパスワードが PBKDF2 形式の場合、入力パスワードが正しくても不一致扱いになっていました。

## 修正内容
`src/backend/services/security_service.py` を修正しました。

- 新規パスワード保存形式を `pbkdf2$sha256$<iterations>$<salt>$<hex_hash>` に統一
- 既存の PBKDF2 形式を検証可能に修正
- 旧 `sha256$<salt>$<hash>` 形式も引き続き検証可能
- 初期開発時の平文パスワードも互換対応
- `is_hashed_password()` が PBKDF2 / SHA256 の両方をハッシュ済みとして判定するよう修正

## 確認
以下の構文チェックを実施済みです。

- `src/backend/services/security_service.py`
- `src/backend/app_core.py`
- `src/backend/auth_api.py`

また、PBKDF2 / 旧SHA256 / 平文互換の簡易検証も実施済みです。
