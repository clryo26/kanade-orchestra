# GitHub Copilot Project Instructions

奏オケポータルは Python / FastAPI と JavaScript のWebアプリケーションです。
環境、設計、通常の検証コマンドは AGENTS.md と README.md を参照してください。

ソース調査、直接編集、テスト、Git操作には通常の開発ツールを使用できます。
ユーザーの依頼に沿って作業し、既存の未コミット変更を保持してください。
認証・認可、DB整合性、Secret保護、通常のCI/CDとデータ保護機構を維持してください。
実際の変更・検証結果と未確認事項を正確に報告してください。

.github/prompts/ のテンプレートは任意で利用できます。
テスト環境への反映を依頼された場合は scripts/deploy_to_test.ps1 を利用できます。
このスクリプトはpush・PR・merge・CI・テスト環境反映まで行うため、依頼内容に合わせて使用してください。
