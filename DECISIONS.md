# DECISIONS.md

This document records important architectural decisions and the reasons behind them.

## Decision 001: Treat オケポータル as an operations platform

### Decision

The project is treated as an orchestra operations platform, not a small utility app.

### Reason

The feature set now includes schedules, recordings, scores, payments, attendance, events, members, albums, announcements, audit logs, and permissions. Long-term maintainability is required.

### Consequence

Architecture and coding rules prioritize maintainability, scalability, and operational safety.

---

## Decision 002: Use PostgreSQL as the operational source of truth

### Decision

Operational data is stored in PostgreSQL.

### Reason

JSON storage became insufficient for concurrency, search, sorting, filtering, and long-term reliability.

### Consequence

Local JSON should not be used as the production data source. All operational data should flow through repositories.

---

## Decision 003: Use Google Cloud Storage for binary files

### Decision

Recordings, scores, photos, icons, and attachments are stored in Google Cloud Storage.

### Reason

Cloud Run containers are ephemeral and unsuitable for persistent file storage. GCS is scalable and appropriate for large files.

### Consequence

The database stores file metadata only.

---

## Decision 004: Adopt Repository Pattern

### Decision

Database access should be centralized in repository classes/modules.

### Reason

This reduces coupling between API routes and database schema and makes future DB changes safer.

### Consequence

Routers and services must not execute raw SQL directly.

---

## Decision 005: Adopt Service Layer

### Decision

Business logic should live in services.

### Reason

Routers should remain thin. Services make logic easier to test and reuse.

### Consequence

New feature logic should be added under `services/`, not directly in routers or app setup files.

---

## Decision 006: Preserve UI and API compatibility during refactoring

### Decision

Refactoring must not change UI or API behavior unless explicitly requested.

### Reason

The portal is already used as an operational tool. Unintentional changes can disrupt users.

### Consequence

Compatibility checks are mandatory after major refactoring.

---

## Decision 007: Keep Cloud Run compatibility as a hard requirement

### Decision

The application must run correctly on Google Cloud Run.

### Reason

Cloud Run is the production runtime.

### Consequence

The app must listen on the `PORT` environment variable and avoid local-only assumptions.

---

## Decision 008: Generate signed URLs only when needed

### Decision

Recording, score, and photo URLs should be generated on demand.

### Reason

Generating URLs for every file during list rendering causes slow initial loads.

### Consequence

List APIs should return metadata; playback/download APIs should generate URLs when requested.

---

## Decision 009: Add audit logging for operational safety

### Decision

Important operations should be logged in audit logs.

### Reason

For long-term operation, administrators need to know who changed or deleted data.

### Consequence

Create/update/delete/upload/download/login operations should be audit targets.

---

## Decision 010: Prepare for role-based access control

### Decision

Permissions should support multiple roles beyond admin/member.

### Reason

Orchestra operations involve conductors, inspectors, treasurers, section leaders, and general members.

### Consequence

The role model should be extensible and must not break existing logins.

---

## Decision 011: Prepare for multi-tenant operation

### Decision

Future architecture should allow multiple orchestras to use one platform.

### Reason

The system may eventually be reused by other orchestras or ensembles.

### Consequence

Avoid hard-coding one orchestra's assumptions in core logic. Future `organization_id` support should be considered.

---

## Decision 012: Prepare for AI-assisted operations

### Decision

Future AI features should be isolated in a dedicated service layer.

### Reason

AI features are useful but should not pollute core business logic.

### Consequence

Future AI features should live under `services/ai/` or similar boundaries.

---

## Decision 013: Keep documentation as part of the system

### Decision

Architecture, coding rules, roadmap, and decisions are maintained as project assets.

### Reason

AI-assisted development requires stable written rules to avoid inconsistent modifications.

### Consequence

Major changes should update the relevant documentation.

---

## Decision 014: Enforce DB Only operation

### Decision

Production data path is DB Only (PostgreSQL).

### Reason

Local JSON fallback is useful only for emergency local development and should not be treated as an operational source.

### Consequence

`src/data/*.json` is excluded from normal production workflow, and CI/CD checks target DB-backed behavior.

---

## Decision 015: Keep app.js as deprecated test compatibility layer

### Decision

`main.js` is the production frontend entrypoint. `app.js` remains only for test compatibility during transition.

### Reason

Frontend tests still reference legacy fragments while production runtime has already moved to split modules and main entry.

### Consequence

No new production logic should be added to `app.js`; migration targets are `main.js`, `modules/`, `utils/`, and `frontend_testable_logic.js`.
