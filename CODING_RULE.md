# CODING_RULE.md

## 1. General Principles

Code must be easy to understand, easy to test, and safe to modify.

Prefer clarity over cleverness.

Existing behavior must be preserved unless a change is explicitly requested.

## 2. Python Backend Rules

### Formatting

- Follow PEP8.
- Use type hints for public functions.
- Use docstrings for non-trivial functions/classes.
- Remove unused imports.
- Avoid wildcard imports.

### Layering

Routers must not directly access the database.

Correct flow:

```text
router → service → repository → database
```

Incorrect flow:

```text
router → SQL
service → raw SQL without repository
```

### Router rules

Routers should:

- Define endpoints
- Validate inputs
- Call service functions
- Return responses

Routers should not:

- Contain business logic
- Contain SQL
- Contain file conversion logic
- Contain large helper functions

### Service rules

Services should:

- Implement business logic
- Coordinate repositories
- Coordinate GCS operations
- Handle cache invalidation
- Trigger audit logging

Services should not:

- Know frontend details
- Return raw database cursor objects

### Repository rules

Repositories should:

- Encapsulate SQL
- Return domain dictionaries/models
- Handle database-specific details

Repositories should not:

- Contain UI logic
- Contain HTTP response logic
- Perform business decisions beyond query composition

## 3. JavaScript Frontend Rules

### File organization

Do not add new feature implementation to large legacy files.

Use:

```text
src/static/js/modules/
src/static/js/components/
src/static/js/utils/
src/static/js/dialogs/
src/static/js/api.js
```

### API calls

All API calls should go through `api.js`.

Direct `fetch()` in feature modules is prohibited unless explicitly justified.

### Module rules

Each module should own one feature area, such as:

- recordings
- schedules
- members
- scores
- albums
- payments
- events
- announcements

### UI rules

Reusable UI should be componentized.

Examples:

- Buttons
- Tables
- Cards
- Modal dialogs
- Toast messages
- Pagination controls

### State rules

Shared state should be managed via a store or clear state module.

Avoid scattered global variables.

## 4. Database Rules

- Use migrations for schema changes.
- Never modify schema manually without documenting it.
- Add indexes for frequent filters/sorts.
- Add constraints where data integrity requires them.
- Avoid N+1 queries.
- Prefer explicit column lists over `SELECT *` for performance-sensitive queries.

## 5. Cloud Storage Rules

Binary files must be stored in GCS.

Do not store uploaded production files in the repository or container filesystem.

Metadata belongs in the database.

## 6. Error Handling Rules

Errors should be:

- Logged with context
- Returned to the frontend in a consistent format
- Safe for users to see
- Detailed enough in logs for diagnosis

Do not expose secrets, raw SQL, or stack traces to users.

## 7. Logging Rules

Use structured logging where possible.

Include:

- Request ID
- Actor where available
- Action
- Target entity
- Error context

Do not log passwords, tokens, or secrets.

## 8. Testing Rules

For important changes, add or update tests.

Priority test areas:

- Login
- Authorization
- Recording playback
- Recording upload
- Schedules
- Absence reporting
- Events
- Payments
- DB migrations

## 9. Performance Rules

Use lazy loading for heavy data.

Generate signed URLs only when needed.

Use pagination for potentially large lists.

Avoid loading all recordings/photos/audit logs at once.

## 10. Security Rules

Always consider:

- SQL injection
- XSS
- CSRF
- Authentication bypass
- Authorization bypass
- Unsafe upload
- Secret leakage

Passwords must not be stored in plain text unless supporting a temporary legacy migration path, and such paths should be documented.

## 11. Documentation Rules

When architecture changes, update:

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `ROADMAP.md`
- relevant deployment/setup documents

## 12. Prohibited Changes Without Explicit Approval

Do not do these without explicit instruction:

- Change UI layout significantly
- Rename existing API endpoints
- Delete production data
- Change login behavior incompatibly
- Remove existing features
- Change database source of truth away from DB-only
- Store uploaded files locally in production
