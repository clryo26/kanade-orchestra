# PDF.js 4.10.38 (vendored, legacy build)

Used by `src/static/js/modules/scores/pdf_viewer.js` (sheet library and
desired-piece reference scores). The portal copy is loaded first; jsDelivr
with the same version and build is only a fallback.

## Why this version

- CVE-2024-4367 / GHSA-wgrm-67xf-hhpq (arbitrary JavaScript when opening a
  malicious PDF with `isEvalSupported: true`, the default): affected
  `pdfjs-dist <= 4.1.392`, patched in `4.2.67`. The previous copy (3.11.174)
  was affected; no 3.x release has the fix.
- GHSA-hq66-cqwq-w95j / CVE-2026-16633 (scripting, `enableScripting`):
  affected `>= 5.6.83`, patched in `6.2.108`. 4.10.38 is outside this range,
  and the portal does not load the scripting sandbox anyway.
- 4.10.38 is the last 4.x release: the same rendering API as before
  (`getDocument`, `getPage`, `render`), delivered as an ES module.
- The legacy build is used for older iOS/Safari versions of members.
- Defence in depth: every document is opened with `isEvalSupported: false`
  (the advisory's workaround), also through the fallback source.

Advisories checked on 2026-10-19 at
https://github.com/mozilla/pdf.js/security/advisories (2 published). Library
bugs may also be reported only in Mozilla's Bugzilla; re-check before
updating.

## Source

- npm `pdfjs-dist@4.10.38`, integrity
  `sha512-/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ==`
- Files `legacy/build/pdf.min.mjs` and `legacy/build/pdf.worker.min.mjs`,
  unchanged:
  - `pdf.min.mjs` SHA-256 44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72
  - `pdf.worker.min.mjs` SHA-256 bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d
- The fallback
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/` served the
  same bytes on 2026-10-19 (cdnjs has no legacy build of 4.10.38).
- License: Apache-2.0 (`LICENSE`, from the same package).

The byte comparison only shows that the files are the published ones. It is
not a safety check; safety rests on the version (outside the advisories'
ranges) and on the options above.

## How it is verified

- `tests/frontend/test_sheet_pdfjs_security.test.js`: source order, version
  check (another version is refused, also a PDF.js left on the page), worker
  from the same place, `isEvalSupported: false` on every open, worker version
  mismatch reported as a library problem.
- `tests/e2e/sheet_library_reliability.spec.js`: the real library from this
  directory renders real PDFs in Chromium (the CDN blocked), and the fallback
  is used when the portal copy cannot be loaded.

The library and the worker must always be updated together (same version and
build). `.mjs` is served as JavaScript (`src/backend/core/static_assets.py`).
