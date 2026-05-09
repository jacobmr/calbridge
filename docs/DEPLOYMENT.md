# Calbridge — Deployment & Project Status

> Last updated: 2026-05-09

---

## Infrastructure

| Service | Provider | Status | URL |
|---|---|---|---|
| Hosting | Vercel (huddlehealth/calbridge) | ✅ Live | https://www.mical.net |
| Database | Turso (libSQL) | ✅ Connected | libsql://calbridge-jacobr.aws-us-east-1.turso.io |
| Secrets | SOPS + age (inventory repo) | ✅ Encrypted | `/data/dev/inventory/secrets/calbridge.enc.env` |

### Domains
- **Canonical:** `https://www.mical.net`
- **Redirect:** `https://mical.net` → `https://www.mical.net`

---

## Environment Variables

All secrets are stored in the inventory repo and pushed to Vercel production.

| Variable | Status | Source |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ Set | Turso dashboard |
| `TURSO_AUTH_TOKEN` | ✅ Set | Turso CLI (`turso db tokens create calbridge`) |
| `CALBRIDGE_DEK` | ✅ Generated | `openssl rand -base64 32` |
| `SESSION_SIGNING_KEY` | ✅ Generated | `openssl rand -base64 32` |
| `APP_BASE_URL` | ✅ Set | `https://www.mical.net` |
| `CRON_SECRET` | ✅ Generated | `openssl rand -base64 32` |
| `INTERNAL_DISPATCH_HMAC` | ✅ Generated | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` | ❌ Waiting | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | ❌ Waiting | Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | ✅ Set | `https://www.mical.net/api/oauth/google/callback` |
| `MS_CLIENT_ID` | ❌ Empty | Future (Microsoft OAuth) |
| `MS_CLIENT_SECRET` | ❌ Empty | Future (Microsoft OAuth) |
| `MS_REDIRECT_URI` | ✅ Set | `https://www.mical.net/api/oauth/microsoft/callback` |

### Managing Secrets

Secrets are encrypted with [SOPS](https://github.com/getsops/sops) + age.

```bash
# Decrypt and view
cd /data/dev/inventory
sops -d secrets/calbridge.enc.env

# Edit
sops edit secrets/calbridge.enc.env

# Push to Vercel (after editing)
cd /data/dev/calbridge
sops -d /data/dev/inventory/secrets/calbridge.enc.env | while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  [[ -z "$value" ]] && continue
  echo "$value" | vercel env add "$key" production
done
```

---

## API Endpoints

### OAuth
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/google/init` | Starts Google OAuth flow |
| `GET` | `/api/oauth/google/callback` | Handles Google OAuth callback |

### Auth
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/me` | Returns current user (requires session) |
| `POST` | `/api/auth/logout` | Destroys session and clears cookie |

### Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + DB connectivity |

### Scopes Requested (Google)
- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/calendar.events`

---

## Static Pages

| Page | File | Live URL |
|---|---|---|
| Landing page | `public/index.html` | https://www.mical.net/ |
| Privacy Policy | `public/privacy.html` | https://www.mical.net/privacy |
| Terms of Service | `public/terms.html` | https://www.mical.net/terms |
| OAuth Setup Ref | `public/oauth-setup.html` | https://www.mical.net/oauth-setup |
| Logo | `public/logo.svg` | https://www.mical.net/logo.svg |

Clean URLs are enabled via `vercel.json` — all `.html` extensions are stripped automatically.

---

## Google OAuth Configuration

### OAuth Consent Screen
| Field | Value |
|---|---|
| App name | `Calbridge` |
| User support email | `support@mical.net` |
| App logo | `https://www.mical.net/logo.svg` (convert to PNG 120×120) |
| App domain | `www.mical.net` |
| Authorized domains | `www.mical.net`, `mical.net` |
| Privacy Policy URL | `https://www.mical.net/privacy` |
| Terms of Service URL | `https://www.mical.net/terms` |
| Developer contact | `jacob@salundo.com` |

### Authorized Redirect URIs
Add both to your OAuth 2.0 Client ID:

```
https://www.mical.net/api/oauth/google/callback
https://mical.net/api/oauth/google/callback
```

---

## Database Migrations

Migration runner: `db/migrate.mjs`

```bash
# Run against production Turso DB
npm run db:migrate
```

Migrations are idempotent — the runner tracks applied migrations in `schema_migrations`.

**Current schema:** `db/migrations/0001_init.sql`

---

## Testing

```bash
npm test
```

- Crypto tests: `test/crypto.test.mjs`
- OAuth tests: `test/oauth.google.test.mjs`

OAuth tests use a local SQLite file (`file:./.test-calbridge.db`) and mock Google API responses.

---

## Branding

See `docs/BRANDING.md` for:
- Positioning, tagline, and elevator pitch
- Target audience and value propositions
- Color palette and typography
- Messaging pillars and competitive differentiation

---

## Next Steps

1. **Get Google OAuth credentials** from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. **Update secrets file** with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
3. **Push secrets to Vercel**
4. **Run `npm run db:migrate`** against production Turso
5. **Test the OAuth flow:**
   - Visit `https://www.mical.net/api/oauth/google/init`
   - Complete Google consent
   - Verify redirect to `https://www.mical.net/`
   - Check `GET /api/auth/me` returns user object

---

## Project Structure

```
calbridge/
├── api/                     # Vercel serverless functions
│   ├── auth/
│   │   ├── me.mjs
│   │   └── logout.mjs
│   ├── health.mjs
│   └── oauth/
│       └── google/
│           ├── init.mjs
│           └── callback.mjs
├── db/
│   ├── client.mjs
│   ├── migrate.mjs
│   └── migrations/
│       └── 0001_init.sql
├── docs/
│   ├── BRANDING.md
│   └── DEPLOYMENT.md       # ← this file
├── lib/
│   ├── crypto.mjs
│   └── session.mjs
├── public/                  # Static files (served by Vercel)
│   ├── index.html
│   ├── privacy.html
│   ├── terms.html
│   ├── oauth-setup.html
│   ├── logo.svg
│   └── style.css
├── test/
│   ├── crypto.test.mjs
│   └── oauth.google.test.mjs
├── package.json
├── vercel.json
└── .env.example
```

---

## Inventory References

- **Project census:** `/data/dev/inventory/projects/project-census.yaml`
- **OAuth apps:** `/data/dev/inventory/cloud-services/oauth/current-oauth-apps.yaml`
- **Vercel projects:** `/data/dev/inventory/cloud-services/vercel/vercel-projects.yaml`
- **Turso databases:** `/data/dev/inventory/cloud-services/turso/turso-databases.yaml`
- **Secrets:** `/data/dev/inventory/secrets/calbridge.enc.env`
