# Python実行依存の監査と更新計画

2026-10-26。性能改善とは別に進める。ここではアプリの依存、Docker、DB、配備先を変更しない。

## 監査の対象と判定

`npm run check:security:python`（`python scripts/audit_python_dependencies.py`）を実行する。
Dockerfileと`.python-version`のPython版が一致することを確認し、`uv.lock`から開発依存を除いてexportする。
Linux・そのPython版のプロファイルを作り、exportにない版へ変わっていないことを確認する。
監査ツールはPython 3.11と修正版filelockを使うが、監査の対象はツール自身の環境ではない。
アプリ依存をインストールせず、明示したrequirementsをpip-auditに渡す。

- 新しい報告、または解消済みで一覧から除くべき項目があれば終了1。期限切れ・一覧の不正・準備失敗・タイムアウト・欠落/skip・壊れた出力は終了2。期限内の既知報告だけなら終了0。
- CIの独立ジョブで実行し、quality-gatesの前提にする。監査が赤でも別ジョブのバックエンド・ブラウザ試験は実行できる。失敗の無視はしない。
- 期限付き一覧を使って監査の導入を依存更新から分ける。新規報告と期限切れはCIを止める。依存更新PRごとに解消した項目を削除し、空になれば全報告で失敗する。マージと配備は別途判断する。
- 一時requirementsは実行後に除去する。ログはパッケージ・版・報告ID・要約だけとし、生JSONやartifactを保存しない。
- 本番イメージのインストール済み依存やOSパッケージの監査、各報告の適用性・悪用可能性の判断は別途必要。

初回（a8b23d4）：Linux/Python 3.10、74パッケージ、skip 0、14パッケージに報告、終了1。
対象requirementsのSHA256は`23619e1cb0c6ee84874659db18af903f38bf5b36a771b3d5fbd66c99e651a823`。
報告件数は独立した脆弱性の数とは扱わない。監査データベースの更新で結果は変わり得る。

## 期限付きの既知報告

`PYTHON_RUNTIME_KNOWN_FINDINGS.json`に、パッケージ・厳密な版・報告ID・対応理由・担当・期限を記録する。初期値はレビュー済み初回結果の14パッケージ、重複を除いた82の「パッケージ×版×報告ID」。独立した脆弱性82件という意味ではない。報告IDはパッケージ単位で理由等を共有して列挙する。

高優先のPillow・FastAPI・Starlette・python-multipartとHTTP入口のh11は2026-11-02、それ以外は2026-11-09を期限とする（開始から7日・14日）。担当はリポジトリ管理者。期限はその日のUTC終了まで有効で、翌日から失敗する。自動延長や新規報告の自動追加は行わない。変更・延長には理由を示したレビューが必要。高優先は10月30日、残りは11月6日（各期限の3日前）に進捗と修正版・検証の見通しを確認し、必要な延長は期限前に理由付きでレビューする。

全件をpip-auditに問い合わせ、結果の「パッケージ×版×報告ID」を一覧と比較する。`--ignore-vuln`は使わない。同じIDが別のパッケージや別の版で見つかった場合は新規として止め、別名のIDを自動承認しない。既知報告も件数とIDをログに残す。解消・ID変更で一覧の項目が観測されなくなった場合も失敗させ、更新PRで一覧を整理する。期限切れは現在の検出有無によらず失敗する。依存を変更していないのにstaleになった場合は、監査DB側のID変更・取り下げも確認する。取り下げや別名への変更と確認できれば一覧だけを整理する（新IDの追加には通常の理由・担当・期限とレビューが必要）。不明な新規報告を自動的に既知扱いしない。

CIで監査するのはPR・main更新・手動実行のときであり、毎日の自動監査は設定していない。依存の安全性を証明する一覧ではなく、既知報告の対応期限を管理する暫定の運用である。

## 更新の順序と受入条件

1. **Python 3.10のまま入口を先に更新**：FastAPI・Starlette・python-multipart・h11の修正版を、必要なPydantic・anyio・テスト用httpxと合わせて検証する。Python更新の完了を待たない。
2. **残る報告**：Python 3.10対応の修正版を優先して、aiohttp、certifi、msgpack、multidict、pyasn1、python-dotenv、setuptools、urllib3などの利用箇所と互換性を確認する。
3. **Python更新とPillowの残件**：Python更新は別作業・別の目標日（11月9日）で進める。3.12を第一候補とするが、画像修正を急ぐための3.11への移行案も比較する。Pillowの現行期限11月2日は変更しない。10月30日に移行・検証が間に合うか判断し、必要な場合だけPillowの該当項目の期限延長を理由付きでレビューする。Python 3.10は既にEOLであり、修正版の有無とは別に更新を進める。3.13以降のaudioop削除の影響も確認する。

2026-10-26のPyPIメタデータではPillow 13.0.0はPython>=3.11、FastAPI 0.162.0はStarlette>=0.46.0・Pydantic>=2.9.0を要求する。これは候補調査であり、その組合せを採用・検証済みという意味ではない。librosaなど録音・数値計算の部品まで無条件に最新版にしない。

### Python 3.10候補の実監査（2026-10-26）

隔離した一時ディレクトリで現行pyproject/lockのコピーだけを変更し、Linux/Python 3.10の依存解決と全件監査を実施した。実アプリの更新・インストール・動作試験の結果ではない。

| 対象 | 現行 | 候補 | 候補での報告ID数（パッケージ内で重複除去） |
| --- | --- | --- | ---: |
| FastAPI | 0.104.1 | 0.162.0 | 0 |
| Starlette | 0.27.0 | 1.7.0 | 0 |
| python-multipart | 0.0.6 | 0.0.32 | 0 |
| h11 | 0.14.0 | 0.16.0 | 0 |
| anyio | 3.7.1 | 4.15.1 | 0 |
| Pillow | 12.3.0 | 12.3.0（3.10対応最新版） | 37 |

必要な周辺候補はPydantic 2.14.1、pydantic-core 2.50.1、開発用httpx 0.28.1など。旧httpx 0.24.1の依存制約がh11更新を妨げるため、テストクライアントも同時に更新する。ほかにannotated-doc/opentelemetry-api/typing-inspectionが加わり、sniffioが外れる。全ロック差分を実装PRで確認する。

初回74パッケージ・14パッケージに82の報告ID組に対し、候補は76パッケージ・skip 0・9パッケージに62組（20組減）。残りはPillowと上記の低優先8パッケージで、監査自体は終了1。独立した脆弱性数や悪用可能性の評価ではない。候補requirements SHA256は`aaaf22cb98586d90f0f0b1b996c09cdac053205f0f4a3224bebe5b9ed6ecd94b`、候補lock SHA256は`1e4bd077fd4292e986a872ac58c14973c27e2b2e16de189bfa62ad39751bf3f6`。生データは`.tmp/python310-security/`に置き、コミットしない。

PyPIでPython 3.10対応のPillow 12系に新しい修正版はなく、今回の監査の修正版指定はすべて13.0.0。Python 3.10のままPillowの37組を解消できたとは扱わない。新しい12系の公開状況は期限前に再確認する。

Python更新時はDockerfile、`.python-version`、`requires-python`、Lint/型検査の対象版、CIと同期スクリプトのPython指定を揃える。監査ツールの版指定は実行環境とは別に管理する。

各更新PRではロック差分と監査の前後比較を示し、残った報告を隠さない。Linux Dockerのビルド・起動、バックエンド全体（PostgreSQLを含む）、フロント・通常並列のe2eを通す。画像ではアルバム・チラシ・団員紹介、JPEG/PNG/WebP/HEIF・EXIF回転・不正画像を確認する。アップロードではmultipart、サイズ制限、422/403、JSON応答、ダウンロード/Range、認証を確認する。録音は変換・解析の短い固定音源を実際に処理する。実iPhoneでの表示・再生は自動試験と区別して記録する。

マージ・配備は別の判断とし、TESTへの自動配備とmigrationの副作用を含めて確認する。#156の修正や未マージの性能改善は、この監査修正に含めない。

## Python 3.12 / Pillow 13の実装単位

`fix/python312-pillow-security-20261026`では、#158を土台にPython 3.12とPillow 13.0.0へ更新する。Docker・`.python-version`・requires-python・型/Lint対象版・アプリを実行するCI/同期ジョブを3.12へ揃える。監査ツールの独立した3.11指定は維持する。3.10/3.11のCIマトリクスは3.12の1組へ置き換える。マージ・配備済みという意味ではない。

3.12/Linuxの実監査は75パッケージ、skip 0、8パッケージに25の既知報告ID組、新規・staleとも0、終了0。Pillowの37組だけを一覧から削除し、期限を延長しない。残る8パッケージの11月9日の期限は維持する。requirements SHA256は`4b06a91960dcbb3b0294ac2df6f8f17c81a538069be6f6ef83450bcc739a7705`。独立した脆弱性数や適用性の判断ではない。

数値計算は既存のロックにあったPython別分岐から、NumPy 2.4.6・SciPy 1.17.1・scikit-learn 1.9.0などの3.12対応版を選ぶ。古いPython向けの分岐が不要になった分、lockが縮む。librosa・pydub・uvicornなどの直接指定は変更しない。

JPEG・PNG・WebP・HEIF・EXIF回転・不正画像は既存の画像試験で確認する。実コーデックでのWAV→MP3変換と再生時間取得、librosaの有限なRMS計算を回帰試験に追加する。現在のHTTP録音解析サービスはplaceholderなので、librosaの計算試験を実装済みの解析APIの試験とは扱わない。受付画像形式は変えない。実iPhone・認証済みTEST/本番の受入と、マージ・配備は別途行う。

## 残る8パッケージの更新（2026-10-26）

最新main `90efb32`から独立した更新。aiohttp 3.14.5、certifi 2026.10.23、msgpack 1.2.3、multidict 6.9.1、pyasn1 0.6.4、python-dotenv 1.2.4、setuptools 84.2.1、urllib3 2.8.0へ更新する。multidictは修正済み6系に留める。aiohttpの必要条件によりyarlも1.25.1へ更新する。

setuptools 82以降はpkg_resourcesを含まないため、これを使うimageio-ffmpegを0.6.0、librosaを同じ0.10系の0.10.2.post1へ更新する。初回の実音声試験が旧librosaのpkg_resources参照で失敗したことを確認し、更新後のWAV→MP3・再生時間・有限RMS計算で互換性を確認する。アプリの処理、受付形式、認証、DB schemaは変更しない。

更新後のLinux/Python 3.12本番依存は75パッケージ。実監査で報告0・skip 0、旧25件はすべて解消したため既知一覧を空にする。新規・staleとも0、終了0。期限の延長や除外追加は行わない。requirements SHA256: `be7e0bdff164326b6d8497c40bf287b02e64aa672f96ec5bb9d75fb5a0d9170e`。監査対象はDockerで使うpyproject.toml/uv.lockの依存であり、旧src/backend/requirements.txtやOSパッケージを監査したという意味ではない。

配備は最後に一括で行う。Deploy Testはdisabled_manuallyを維持し、この更新では配備・migration・実DB/GCS操作を行わない。実iPhone・認証済みTEST/本番の受入、既知のASGI切断時ログ差は別の確認事項として残す。

## 根拠

- [pip-audit公式](https://github.com/pypa/pip-audit#usage)
- [Pythonサポート期間](https://devguide.python.org/versions/)
- [Python 3.13の削除項目](https://docs.python.org/3.13/whatsnew/3.13.html#removed-modules-and-apis)
- [PillowのPyPIメタデータ](https://pypi.org/pypi/Pillow/json)
- [FastAPIのPyPIメタデータ](https://pypi.org/pypi/fastapi/json)
- [setuptoolsのpkg_resources廃止](https://setuptools.pypa.io/en/stable/deprecated/pkg_resources.html)
- [imageio-ffmpegの互換修正](https://github.com/imageio/imageio-ffmpeg/releases)
- [librosa 0.10.2の互換修正](https://librosa.org/doc/0.10.2/changelog.html)
