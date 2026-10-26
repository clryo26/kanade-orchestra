# Python実行依存の監査と更新計画

2026-10-26。性能改善とは別に進める。ここではアプリの依存、Docker、DB、配備先を変更しない。

## 監査の対象と判定

`npm run check:security:python`（`python scripts/audit_python_dependencies.py`）を実行する。
Dockerfileと`.python-version`のPython版が一致することを確認し、`uv.lock`から開発依存を除いてexportする。
Linux・そのPython版のプロファイルを作り、exportにない版へ変わっていないことを確認する。
監査ツールはPython 3.11と修正版filelockを使うが、監査の対象はツール自身の環境ではない。
アプリ依存をインストールせず、明示したrequirementsをpip-auditに渡す。

- 報告があれば終了1。準備失敗、タイムアウト、欠落・skip、壊れた出力は終了2。除外リストは設けない。
- CIの独立ジョブで実行し、quality-gatesの前提にする。監査が赤でも別ジョブのバックエンド・ブラウザ試験は実行できる。失敗の無視はしない。
- 現行の既知の報告があるため、この監査修正単独のPRは赤になる。依存更新の検証が済むまでマージしない。監査修正だけのために保護を緩めない。
- 一時requirementsは実行後に除去する。ログはパッケージ・版・報告ID・要約だけとし、生JSONやartifactを保存しない。
- 本番イメージのインストール済み依存やOSパッケージの監査、各報告の適用性・悪用可能性の判断は別途必要。

今回の実行：Linux/Python 3.10、74パッケージ、skip 0、14パッケージに報告、終了1。
対象requirementsのSHA256は`23619e1cb0c6ee84874659db18af903f38bf5b36a771b3d5fbd66c99e651a823`。
報告件数は独立した脆弱性の数とは扱わない。監査データベースの更新で結果は変わり得る。

## 更新の順序と受入条件

1. **Python更新とPillow**：Python 3.12を第一候補にし、現行の録音処理を維持できる最小の更新範囲を調べる。Python 3.10は2026-10-01でEOL。3.12のEOL予定は2028-10で、3.11より更新猶予がある。3.13以降はaudioop削除の影響をpydub経路で別途確認する。3.12採用も依存解決・wheel・Linux実行を確認するまでは未確定。
2. **アップロードとHTTPの入口**：FastAPI・Starlette・python-multipartを互換性のある組合せで更新する。必要なPydantic・httpx・anyioの変更も同じ単位で検証する。h11/uvicornもこの単位で確認する。
3. **残る報告**：aiohttp、certifi、msgpack、multidict、pyasn1、python-dotenv、setuptools、urllib3などを、利用箇所と修正版を確認して更新する。不要なライブラリの最新版への一括変更は避ける。

2026-10-26のPyPIメタデータではPillow 13.0.0はPython>=3.11、FastAPI 0.162.0はStarlette>=0.46.0・Pydantic>=2.9.0を要求する。これは候補調査であり、その組合せを採用・検証済みという意味ではない。librosaなど録音・数値計算の部品まで無条件に最新版にしない。

Python更新時はDockerfile、`.python-version`、`requires-python`、Lint/型検査の対象版、CIと同期スクリプトのPython指定を揃える。監査ツールの版指定は実行環境とは別に管理する。

各更新PRではロック差分と監査の前後比較を示し、残った報告を隠さない。Linux Dockerのビルド・起動、バックエンド全体（PostgreSQLを含む）、フロント・通常並列のe2eを通す。画像ではアルバム・チラシ・団員紹介、JPEG/PNG/WebP/HEIF・EXIF回転・不正画像を確認する。アップロードではmultipart、サイズ制限、422/403、JSON応答、ダウンロード/Range、認証を確認する。録音は変換・解析の短い固定音源を実際に処理する。実iPhoneでの表示・再生は自動試験と区別して記録する。

マージ・配備は別の判断とし、TESTへの自動配備とmigrationの副作用を含めて確認する。#156の修正や未マージの性能改善は、この監査修正に含めない。

## 根拠

- [pip-audit公式](https://github.com/pypa/pip-audit#usage)
- [Pythonサポート期間](https://devguide.python.org/versions/)
- [Python 3.13の削除項目](https://docs.python.org/3.13/whatsnew/3.13.html#removed-modules-and-apis)
- [PillowのPyPIメタデータ](https://pypi.org/pypi/Pillow/json)
- [FastAPIのPyPIメタデータ](https://pypi.org/pypi/fastapi/json)
