# Calbridge — Agent Guide

## Project Overview

Calbridge is a calendar-bridging SaaS application. It lets users connect calendars from multiple providers (Google Calendar, Microsoft Graph/Outlook, and ICS feeds), define sync flows between them, and expose public booking pages for scheduled event types.

The codebase is intentionally small and self-contained. It runs as **Vercel serverless functions** (`api/**/*.mjs`) backed by a **Turso/libSQL** SQLite database. There is no frontend build step; any UI is assumed to be served from the same Vercel project as static files or handled by separate routes not present in this repository.

## Technology Stack

- **Runtime**: Node.js >= 20 (ES modules only, `"type": "module"` in `package.json`)
- **Platform**: Vercel (serverless functions)
- **Database**: Turso / libSQL (SQLite-compatible, remote or local file)
- **Language**: JavaScript (`.mjs` extension everywhere)
- **Test runner**: Node.js built-in test runner (`node --test`)
- **Package manager**: npm

## Project Structure

```
├── api/                # Vercel serverless function handlers
│   └── health.mjs      # Health-check endpoint (also verifies DB connectivity)
├── db/                 # Database client and migrations
│   ├── client.mjs      # Singleton libSQL client factory
│   ├── migrate.mjs     # Custom migration runner
│   └── migrations/     # Ordered .sql migration files
│       └── 0001_init.sql
├── lib/                # Shared business logic
│   ├── crypto.mjs      # AES-256-GCM encryption helpers for tokens
│   └── session.mjs     # Cookie-based session management
├── test/               # Test files (mirrors lib/ structure)
│   └── crypto.test.mjs
├── package.json
├── vercel.json         # Vercel config (clean URLs, function limits)
└── .env.example        # Required environment variables
```

### Module Conventions

- Every source file uses the `.mjs` extension.
- All imports include the full extension: `import { x } from '../lib/crypto.mjs'`.
- No bundler or transpiler is used; code runs directly through Node.js.

## Environment Variables

Copy `.env.example` to `.env` for local development. The following variables are required at runtime:

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | libSQL database URL (e.g. `file:./.calbridge.db` locally, or a `libsql://` URL for Turso) |
| `TURSO_AUTH_TOKEN` | Auth token for remote Turso databases (omit for local file) |
| `CALBRIDGE_DEK` | Base64-encoded 32-byte AES data-encryption key for token storage |
| `SESSION_SIGNING_KEY` | Base64-encoded 32-byte HMAC key for session cookies |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 credentials |
| `GOOGLE_REDIRECT_URI` | Must match the registered redirect URI (default: `https://mical.net/api/oauth/google/callback`) |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Microsoft Graph OAuth credentials |
| `MS_REDIRECT_URI` | Microsoft OAuth callback (default: `https://mical.net/api/oauth/microsoft/callback`) |
| `APP_BASE_URL` | Canonical base URL of the deployment (default: `https://mical.net`) |
| `CRON_SECRET` | Shared secret for invoking cron/background endpoints |
| `INTERNAL_DISPATCH_HMAC` | HMAC secret for internal service-to-service dispatch |

## Build and Development Commands

```bash
# Install dependencies
npm install

# Run tests
npm test

# Apply database migrations
npm run db:migrate

# Local development server (Vercel CLI)
npm run dev
```

There is no build or compile step. The project runs directly from source.

## Testing Strategy

- Use Node.js native `node:test` and `node:assert/strict`.
- Test files live in `test/` and are named `*.test.mjs`.
- Tests are invoked with: `node --test 'test/**/*.test.mjs'`.
- The crypto test sets `process.env.CALBRIDGE_DEK` in a `before` hook so that `lib/crypto.mjs` can load its key without an external `.env` file.
- When writing new tests that touch `db/client.mjs`, call `resetDbForTest()` between test groups if you need to reinitialize the client with different environment state.

## Database and Migrations

- The database schema is managed by a **custom migration runner** (`db/migrate.mjs`).
- Migration files are plain SQL stored in `db/migrations/` and are executed in filename order.
- The runner maintains a `schema_migrations` table to track applied migrations.
- Each migration runs inside a write transaction; if any statement fails, the transaction is rolled back.
- Statements are split on `;` after stripping comments. Avoid `;` inside string literals in migrations, or split the migration into multiple files.

### Adding a Migration

1. Create a new `.sql` file in `db/migrations/` with a lexicographically sortable name (e.g. `0002_add_index.sql`).
2. Run `npm run db:migrate`.

### Key Schema Entities

- `users` — application users.
- `tenants` — workspaces/organizations, each owned by a user.
- `oauth_accounts` — linked calendar provider accounts (encrypted tokens).
- `calendars` — calendar connections within a tenant.
- `sync_flows` — rules defining how events copy from one calendar to another.
- `event_types` — public scheduling page configurations.
- `bookings` — scheduled appointments created via event types.
- `sync_runs` — history of sync executions.
- `rate_limits`, `kv_cache` — operational support tables.
- `audit_log` — append-only audit trail.
- `sessions` — cookie-backed user sessions.
- `oauth_states` — transient OAuth state parameters.

## Security Considerations

- **Token encryption**: OAuth refresh/access tokens are encrypted at rest with AES-256-GCM (`lib/crypto.mjs`). The DEK is supplied via environment variables and can be rotated by introducing a new key ID (`CALBRIDGE_DEK_1`, etc.).
- **Session cookies**: Sessions are signed with HMAC-SHA256 and stored in `HttpOnly; Secure; SameSite=Lax` cookies (`lib/session.mjs`).
- **Timing-safe comparison**: Cookie MAC verification uses `timingSafeEqual`.
- **No plaintext secrets**: Nothing in `.env.example` contains real values; `.env` and `.env.local` are gitignored.
- **Rate limiting table**: `rate_limits` exists for application-level rate limiting, but the enforcement logic lives in the API handlers (not centrally middleware-driven).

## Code Style Guidelines

- Use `async` / `await` for asynchronous code.
- Prefer early returns over deep nesting.
- Use plain objects and destructuring; there is no TypeScript or heavy framework enforcing structure.
- When throwing HTTP-oriented errors, attach a numeric `statusCode` property to the Error object (e.g. `err.statusCode = 401`) so that API handlers can map it to the correct response status.
- Database queries use the libSQL prepared-statement style (`{ sql: '...', args: [...] }`).
- Timestamps are stored as milliseconds since epoch (`INTEGER`) unless the column name explicitly ends in `_at` and is documented otherwise.
- JSON-shaped columns end in `_json` and are stored as TEXT.

## Deployment

- Deploy via Vercel. The `vercel.json` enables `cleanUrls` and sets a 60-second max duration for serverless functions.
- Ensure all environment variables from `.env.example` are configured in the Vercel dashboard.
- Run `npm run db:migrate` against the production database after deploying schema changes.
