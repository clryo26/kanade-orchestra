# ARCHITECTURE.md

## 1. System Overview

オケポータル is an orchestra operations platform built for long-term use by orchestra members and administrators.

The system supports:

- Concert information
- Practice schedules
- Attendance and absence reporting
- Recording management
- Score library
- Member profiles
- Payment status
- Event coordination
- Seating / assignment information
- Announcements
- Albums
- SNS and concert record links
- Admin operations

## 2. Technology Stack

```text
Frontend: Vanilla JavaScript / HTML / CSS
Backend: FastAPI / Python
Database: PostgreSQL
File Storage: Google Cloud Storage
Runtime: Google Cloud Run
CI/CD: GitHub Actions / Cloud Build
```

## 3. High-Level Architecture

```text
Browser / PWA
  ↓
Static frontend assets
  ↓
FastAPI Router Layer
  ↓
Service Layer
  ↓
Repository Layer
  ↓
PostgreSQL

File operations:
Browser / Backend
  ↓
Google Cloud Storage
```

## 4. Layer Responsibilities

### Frontend

Responsible for:

- Rendering screens
- User interaction
- Calling API layer
- Client-side validation
- Lazy loading
- Playback UI
- Download UI

Frontend must not contain backend business logic.

### API Router Layer

Responsible for:

- HTTP route definitions
- Request validation
- Response formatting
- Authentication/authorization dependencies

Routers must not directly execute SQL.

### Service Layer

Responsible for:

- Business rules
- Use-case orchestration
- Cache invalidation
- File workflow coordination
- Audit log triggering

### Repository Layer

Responsible for:

- Database reads/writes
- Query encapsulation
- Transaction handling where needed

Repositories must not contain UI or HTTP concerns.

### Database

PostgreSQL is the source of truth for operational data.

### Google Cloud Storage

GCS is the source of truth for binary files such as:

- Audio recordings
- Scores
- Photos
- Icons
- Attachments

## 5. Data Ownership

| Data type | Source of truth |
|---|---|
| Members | PostgreSQL |
| Schedules | PostgreSQL |
| Performances | PostgreSQL |
| Recordings metadata | PostgreSQL |
| Recording files | GCS |
| Scores metadata | PostgreSQL |
| Score PDF files | GCS |
| Albums metadata | PostgreSQL |
| Photo files | GCS |
| Payments | PostgreSQL |
| Audit logs | PostgreSQL |
| Roles / permissions | PostgreSQL |

## 6. Authentication and Authorization Flow

```text
User enters login information
  ↓
Frontend sends login request
  ↓
Auth router
  ↓
Auth service
  ↓
Member/admin repository
  ↓
Password verification
  ↓
Session / token / compatibility response
  ↓
Frontend displays portal menu
```

Authorization should be role-based and backward compatible with existing login behavior.

## 7. Recording Flow

### Upload

```text
User selects audio file
  ↓
Backend prepares upload metadata or signed URL
  ↓
File stored in GCS
  ↓
Metadata stored in DB
  ↓
Cache invalidated
  ↓
Audit log recorded
```

### Playback

```text
User clicks Play
  ↓
Frontend requests playback URL
  ↓
Backend validates permission
  ↓
Signed URL or stream response is generated
  ↓
Audio starts playback
```

Playback URLs should be generated on demand.

## 8. Score Library Flow

```text
Admin uploads PDF
  ↓
PDF stored in GCS
  ↓
Metadata stored in DB
  ↓
Member views performance / piece
  ↓
PDF view/download URL generated on demand
```

## 9. Caching Strategy

Use cache only for data that can be safely refreshed.

Recommended cached data:

- Announcements
- Schedules
- Performances
- Member lists
- Recording metadata

Invalidate cache after create/update/delete.

Do not cache sensitive tokens or raw passwords.

## 10. Multi-Tenant Readiness

Future versions may support multiple orchestras.

Design should allow adding:

```text
organization_id
```

across operational tables.

Do not hard-code organization-specific values except in configuration.

## 11. PWA Readiness

Future PWA features may include:

- Offline schedule view
- Offline score metadata
- Push notifications
- Background sync

Frontend architecture should avoid patterns that make PWA adoption difficult.

## 12. AI Readiness

Future AI services may include:

- Practice summary generation
- Recording analysis
- SNS draft generation
- Schedule assistance
- Operational insights

AI logic should be isolated under a future service layer such as:

```text
services/ai/
```

## 13. Plugin Readiness

Future feature modules should be addable without touching core logic heavily.

Possible plugin categories:

- Seating diagram generation
- Ticket management
- External calendar integrations
- Notification providers
- AI assistants

## 14. Deployment Architecture

```text
GitHub
  ↓
Cloud Build / GitHub Actions
  ↓
Docker image
  ↓
Cloud Run
  ↓
Cloud SQL PostgreSQL
  ↓
Cloud Storage
```

Cloud Run must listen on the `PORT` environment variable.

## 15. Non-Goals

The system should not:

- Store production operational data in local JSON
- Store uploaded files inside the container filesystem
- Depend on local machine state
- Require manual source edits for organization-specific settings
- Mix routing, business logic, and SQL in one file
