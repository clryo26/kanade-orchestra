# Hidden administrator configuration

本番・テストでは環境変数を設定せず、隠し管理者ログインを無効のまま運用します。

The hidden administrator login is disabled unless both HIDDEN_ADMIN_NAME and HIDDEN_ADMIN_PASSWORD_HASH are configured. Empty names after the existing NFKC/whitespace normalization also disable it.

HIDDEN_ADMIN_PASSWORD_HASH accepts the PBKDF2-SHA256 representation produced by src.backend.services.security_service.hash_password. Plaintext and legacy member-password formats are rejected for this privileged account. Generate a new credential locally using the existing hash_password function. Store only the resulting hash in Secret Manager. Do not put the plaintext password in an environment variable, command history, source file, workflow, or shared log.

The login normalizes the supplied name and password using the existing rules. It checks the password with verify_password, whose PBKDF2 digest comparison uses secrets.compare_digest, and compares UTF-8 name bytes with hmac.compare_digest. Password verification is performed for configured accounts even when the supplied name differs. The hash string itself is explicitly rejected as a submitted password, so the ordinary member verifier's legacy plaintext fallback cannot authenticate this account with the configured hash.

## Cloud Run and GitHub Actions

Enabling this optional account requires operator-managed configuration in each environment.

| Setting | Operator action |
| --- | --- |
| HIDDEN_ADMIN_NAME | Choose a new account name and set it for the appropriate Cloud Run service. |
| HIDDEN_ADMIN_PASSWORD_HASH | Bind to a version of a Secret Manager secret containing the newly generated hash. |
| Service identity | Grant the service runtime identity access to that specific secret. |
| Future deployments | Preserve both settings in the deployment configuration. |

The tracked deployment steps in .github/workflows/deploy-test.yml and .github/workflows/promote-production.yml use --set-env-vars. Add HIDDEN_ADMIN_NAME to their environment specifications if the optional login is to be enabled. Reference the password hash secret with --update-secrets HIDDEN_ADMIN_PASSWORD_HASH=<secret-id>:<version>. Use different secret resources for production and test and configure the referenced names through the appropriate GitHub environment. Secret identifiers and versions should be configurable; do not embed secret values in the workflow. The existing workflows are left for a separately reviewed environment configuration change. Deploying the code without enabling settings disables the hardcoded login.

The configuration owner should replace the exposed credentials. Removing the source literals does not remove them from existing Git history. Any session revocation or deployment is a separate operational action.

## Tests

Backend tests request the hidden_admin_credentials fixture only when the artificial account is needed. The fixture hashes an artificial password at runtime and restores the environment after each test. Dedicated tests cover absent/partial configuration, normalized input, incorrect credentials, plaintext/malformed hashes, and constant-time comparison calls.

The Playwright-managed local server receives an artificial name and a runtime-generated PBKDF2 hash. The smoke test uses the matching artificial values. Existing externally managed servers must have their own appropriate test configuration.
