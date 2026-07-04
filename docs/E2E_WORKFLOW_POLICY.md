# E2E Workflow Policy

Updated: 2026-07-03

## Summary

The `E2E` GitHub Actions workflow is manual-only.

It is triggered by `workflow_dispatch` and is not triggered automatically by `push` or `pull_request`.

## Reason

The previous `pull_request.paths` trigger could start the workflow check context even when none of the path filters matched. In that state GitHub reported `No jobs were run`, which created noisy notifications even though the E2E tests had not failed.

## Operation

- Use `.github/workflows/ci.yml` for normal push and pull request validation.
- Use `.github/workflows/e2e.yml` manually from GitHub Actions when E2E confirmation is needed before release.
- Keep deploy and build workflows independent from E2E trigger changes.

## Re-enabling Automatic E2E

If automatic E2E is needed again, prefer a direct `pull_request` or `push` trigger with a job that always has a runnable condition. Avoid combinations that create a workflow run with no runnable jobs.
