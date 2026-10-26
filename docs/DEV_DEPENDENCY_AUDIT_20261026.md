# 開発用依存の監査修正（PR説明・検証記録）

2026-10-26。最新 `origin/main` (`9c76fd9`) から独立させた変更。Vitest系とViteの開発用依存によってnpm auditが失敗し、CIのfrontend-testsとsource-share-zipが監査で停止していた。

Vitestとcoverage-v8の宣言を `^4.1.12` に更新し、ロック上のVitest系を4.1.12、Viteを同じ8.1系列の修正版8.1.6に更新した。Viteは引き続き推移依存で、直接依存やoverrideを追加していない。ロックの再解決で関連する推移依存も更新した。Playwright等の直接依存の宣言は変更していない。

根拠: [Vitest公式advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)、[Vite公式advisory](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw)。最終的な監査判定は当日のnpm auditで確認した。

## 範囲

変更はpackage.json、package-lock.json、本書のみ。本番JS・Python・API・DB・migration・画面・CIの監査条件を変えない。性能改善の未マージコミットを含めない。実環境の設定変更、migration適用、マージ、デプロイは行わない。

## ローカル検証

Windows、Node v24.18.0、npm 11.16.0。専用ワークツリーでnpm ciを実行してから確認した。Linux／Node 20のCI実行結果とは区別する。

| 検証 | 結果 |
|---|---|
| npm ci | 成功 |
| npm audit（全severity） | moderate 3・high 1から0件、終了コード0 |
| npm run test:frontend | 110ファイル・1,191件成功 |
| npm run check:frontend:syntax | 170ファイル成功 |
| npm run test:e2e | 通常の並列設定で95件成功、再試行なし |
| npm run check:release-safety | 全項目成功 |
| npm run zip:source | 成功、生成ZIPの安全検査PASS |

### カバレッジの結果と限界

全件にcoverageを追加した初回実行は1,189件成功・2件失敗。失敗はいずれも `test_tuner_pitch_spectrum.test.js` のノイズ中の精度比較（48,000／44,100 Hz）で、5,000msの時間切れだった。

別ワークツリーの更新前main（旧lock）と更新版で、同じ23件をcoverage付きで順番に比較した。両方とも21件成功・同じ2件が時間切れ。今回の差分だけで新しく発生した失敗とは扱わないが、環境由来だと断定もしない。試験・タイムアウト・CIの期待値は変更していない。

CIと同じ `npm run test:frontend:coverage` では1,173件成功・同じ2件が時間切れ（107ファイル中106成功・1失敗）。終了コード1。通常の1,191件成功と、coverageの失敗を混同しない。CI全体が成功したとはまだ報告しない。

初回のe2eは試験自体が終了コード0・95件成功だったが、ログ表示用Pythonのcp932出力でUnicodeEncodeErrorが発生した。保存済みの試験ログと子プロセス終了コードを確認し、試験失敗とは区別した。以後のローカル表示はUTF-8に補正した。本番や試験コードは変更していない。

生ログは `.tmp/dependency-audit-20261026/`、比較用worktreeは `.tmp/worktrees/npm-audit-baseline-20261026/` に置き、コミットしない。バックエンド全体、実機、実DB／GCSは今回未実行。新しいテストロジックは追加していない。

## レビュー・公開

#150独立版と性能改善PRとは別のmain向けPRとする。先にこの依存更新をmainへ取り込んでから、後続PRでmainを取り込み監査と回帰を再確認する。既存のVitest 5系のDependabot PRは今回変更しない。

push前に公開範囲を告知済み。公開するのは既存mainに対するこの依存更新・検証文書だけで、性能改善第2〜4段階の履歴は含めない。マージ・デプロイは最後にまとめる既存の指示を維持する。

検証ログのSHA-256（生ログ自体は未コミット）:

- audit: `324903409a9de2e9c0222f8c407efb1c0379756d53708c3439f9baa96b6ce4b0`
- unit: `e5ac74bc942519f2c3254821dc89e05988001b941b5615eea06bf5f90f54afa8`
- e2e: `d36b239f21a43ef4dad4f569d576c5116a6098ff463f971bf4e804aec4f11e85`
- baseline-focused: `debe479006e6d8e7310218f4fdf763a6f3429c07e7c912883e2254fc50314a76`
- updated-focused: `42dff6efe8fb49ea79f52ecb571a1d6a85e792b24b2e3b70bb6853846a2163f0`
- coverage: `59249ff2ad1aceb315473aa7df11181bd528e80b12ff86abc4a389538c3c6d41`
