# 本番・テスト環境の画面識別と相互リンク

最終更新: 2026-07-25

## 目的

同一ソースを本番・テストの両Cloud Runへ展開したまま、`APP_ENV` に基づいて画面名称を識別し、
管理者にだけ反対側の環境へのアクセス経路を提供する。

## 環境判定と表示

- `APP_ENV=production`: `{団体略称}ポータル`
- `APP_ENV=test`: `{団体略称}ポータル(テスト環境)`
- その他・未設定: 本番と同じ従来名称。環境切替リンクは表示しない。

団体略称は既存の団体設定と優先順を利用する。固定文字列には置き換えない。
名称はブラウザタイトル、ヘッダー、ログイン画面、application-name系メタ情報、
動的・サーバー生成Web Manifestへ同じ値を反映する。

## 公開メタ情報

認証不要かつ `Cache-Control: no-store` の `GET /api/revision` は、既存の
`cloudRunRevision` に加えて次を返す。

- `appEnv`: `APP_ENV` をtrim・小文字化した値
- `otherEnvironmentUrl`: 検証済みの `OTHER_ENVIRONMENT_URL`

環境種別とCloud Run公開URLは機密情報ではない。DB、GCS、認証情報、Secretは返さない。
URLは絶対HTTPS URLとして検証し、未設定・空・HTTP・不正URL・userinfo付きURLは空文字にする。

## 管理者メニュー

既存の管理者権限判定を変更しない。管理者メニューを閲覧でき、かつ次の条件を満たす場合だけ、
既存ツールバーのボタン様式でリンクを表示する。

- production: 「テスト環境を開く」→テスト環境URL
- test: 「本番環境を開く」→本番環境URL

リンクは新しいタブで開き、`rel="noopener noreferrer"` を設定する。
URLが未設定・無効の場合は表示しない。

## 設定とデプロイ

Cloud Run共通のruntime環境変数:

- `OTHER_ENVIRONMENT_URL`

GitHub Variables:

- `PROD_PORTAL_URL=https://kanade-orchestra-apmcj4meeq-dt.a.run.app`
- `TEST_PORTAL_URL=https://kanade-orchestra-test-apmcj4meeq-dt.a.run.app`

受け渡し:

- `Deploy Test`: `PROD_PORTAL_URL` → テストCloud Runの `OTHER_ENVIRONMENT_URL`
- `Promote Production`: `TEST_PORTAL_URL` → 本番Cloud Runの `OTHER_ENVIRONMENT_URL`

GitHub Variableが未登録または空の場合、workflowは空の `OTHER_ENVIRONMENT_URL` を追加しない。
その場合、アプリは環境切替リンクを表示しない。

正式URLは次のCloud Run `status.url` から取得した。

```powershell
gcloud run services describe kanade-orchestra --project=kanade-orchestra --region=asia-northeast2 --format="value(status.url)"
gcloud run services describe kanade-orchestra-test --project=kanade-orchestra --region=asia-northeast2 --format="value(status.url)"
```
