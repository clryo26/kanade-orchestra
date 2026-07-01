# ROADMAP.md

## Vision

オケポータル will evolve from a single-orchestra portal into a long-term orchestra operations platform.

The long-term goal is to reduce operational burden, improve information sharing, and help members and organizers focus more on music.

## Version 5.0: Productization Foundation

Theme: turn the current feature-rich system into a maintainable product-grade platform.

### Goals

- Complete Repository Pattern
- Complete Service Layer separation
- Reduce legacy monolithic files
- Improve DB performance
- Improve cache and pagination
- Strengthen login and authorization tests
- Improve audit logging
- Improve CI/CD
- Improve documentation

### Key tasks

- Fully remove DB access from routers
- Keep app setup files thin
- Remove or isolate legacy frontend files
- Add repository-level tests
- Add auth compatibility tests
- Add migration safety checks
- Add performance-oriented indexes
- Improve Cloud Run startup reliability

## Version 5.5: Operations Stability

Theme: make daily operation safe and recoverable.

### Goals

- Backup and restore workflow stabilization
- Migration rollback workflow
- Monitoring and alerting
- Admin operation auditability
- Better operational dashboards

### Key tasks

- Scheduled DB backups
- GCS metadata consistency checks
- Audit log viewer
- Admin dashboard
- Storage usage dashboard
- Error log dashboard

## Version 6.0: PWA and Notification Platform

Theme: improve member usability on smartphones.

### Goals

- PWA offline support
- Push notifications
- Better iPhone support
- Faster mobile load time
- Background sync readiness

### Candidate features

- Offline schedule view
- Offline concert information
- Offline score metadata
- Push notification for schedule changes
- Push notification for new recordings
- Push notification for payment reminders

## Version 6.5: Advanced Operations Features

Theme: support more complex orchestra workflows.

### Candidate features

- Stage layout auto generation
- Seating diagram management
- Instrument transport management
- Rehearsal day mode
- Performance day checklist
- Part leader dashboards
- Conductor / inspector views

## Version 7.0: Multi-Tenant Platform

Theme: support multiple orchestras in one system.

### Goals

- Add organization-level data model
- Separate settings per organization
- Allow custom branding
- Organization-specific roles
- Organization-specific storage paths

### Technical preparation

- Add `organization_id` to major tables
- Add tenant-aware repositories
- Add organization settings
- Add organization-level permissions

## Version 8.0: AI-Assisted Operations

Theme: use AI to reduce operation and communication workload.

### Candidate AI features

- Practice summary generation
- SNS draft generation
- Concert announcement draft generation
- Recording memo summarization
- Absence trend analysis
- Payment reminder draft generation
- Schedule conflict detection
- Operational assistant chat

### Architecture

- Add `services/ai/`
- Keep AI integrations optional
- Use feature flags
- Log AI actions safely

## Version 9.0: Music and Rehearsal Intelligence

Theme: support musical improvement and rehearsal planning.

### Candidate features

- Recording analysis
- Tempo comparison
- Practice progress tracking
- Section-specific rehearsal notes
- Conductor comments database
- Piece difficulty and risk tracking

## Version 10.0: Orchestra Ecosystem Platform

Theme: become a reusable platform for orchestras, wind ensembles, and community music groups.

### Candidate features

- Plugin marketplace-like architecture
- External system integrations
- Public concert pages
- Ticketing integration
- Donation integration
- Multi-language support
- Public archive site generation

## Continuous Improvement Themes

These apply to every version:

- Preserve existing behavior
- Improve test coverage
- Improve performance
- Improve security
- Improve documentation
- Reduce complexity
- Avoid monolithic files
- Keep Cloud Run deployment stable
