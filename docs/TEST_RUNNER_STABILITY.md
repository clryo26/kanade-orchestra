# Frontend Test Runner Stability

Updated: 2026-07-04

## Purpose

Keep the frontend test suite deterministic in constrained CI and agent environments.

## Policy

`vitest.config.js` runs the frontend suite in a single forked worker (`pool: 'forks'`, `maxWorkers: 1`).

The suite exercises shared browser-like globals and module-level state. A single worker avoids intermittent worker-process exits during repeated validation runs while leaving the production application unchanged.

## Validation

After changing Vitest configuration, run:

```bash
npm run test:frontend
npm run test:frontend:integration
npm run check:frontend:syntax
npm run check:frontend:load-order
npm run check:frontend:state-access
```

## Test Fixture Isolation

Tests that write local upload assets must redirect every module-level runtime-path binding to the temporary pytest directory. `tests/conftest.py` therefore patches both the compatibility facade and `album_service.UPLOAD_DIR`. The album upload regression test verifies that the photo is written beneath the fixture's temporary upload root, preventing test artifacts from accumulating under `src/uploads/`.
