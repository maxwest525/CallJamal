# CLAUDE.md — Noah Connect Virtual Office

## Project Overview

Noah Connect is a **multi-tenant Virtual Office** platform built with Node.js/Express. Each tenant gets their own AI agent instance, routed via a catchall email domain. The system manages SMS (SlickText), Gmail, Slack, AI chat, video huddles, and internal messaging for small teams.

## Quick Start

```bash
npm install
npm run dev        # nodemon hot-reload on localhost:3000
npm start          # production
```

Deployed on **Vercel** as a serverless Node.js app (`vercel.json` routes all traffic to `server.js`).

## Architecture

```
server.js              → Express app entry point (vault loader → dotenv → middleware → routes)
routes/                → Express routers mounted at /api/*
lib/                   → Shared clients & helpers (Supabase, SlickText, Gmail, Slack, AI, Auth, Webhooks)
public/                → SPA frontend (index.html + static assets)
database/              → SQL migrations (run manually in Supabase SQL Editor)
config/vault.json      → Runtime-saved API keys (gitignored, written by Integrations UI)
```

## Multi-Tenant Model

Tenants are isolated by **catchall email prefix**. If the domain is `trumoveinc.com`, then:
- `clientA@trumoveinc.com` → Tenant "clientA"
- `clientB@trumoveinc.com` → Tenant "clientB"

Each tenant has its own:
- AI agent configuration (system prompt, provider, temperature)
- Client contacts scoped to tenant
- Gmail inbox filtered by `to:` address matching their prefix
- Activity log isolated by `tenant_id`

Tenant resolution happens in `lib/tenants.js` via the `resolveTenant` middleware which extracts the tenant slug from the request (header `X-Tenant`, query param, or authenticated email prefix).

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Database |
| `SLICKTEXT_PUBLIC_KEY` / `SLICKTEXT_PRIVATE_KEY` | SMS |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth |
| `CATCHALL_DOMAIN` | Multi-tenant email domain (e.g. `trumoveinc.com`) |
| `AI_PROVIDER` | `gemini` or `claude` |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | AI backends |
| `DAILY_CO_API_KEY` / `DAILY_CO_DOMAIN` | Video huddles |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | Slack |

## Database

All tables live in **Supabase (PostgreSQL)**. Run migrations in order from `database/`:
1. `schema.sql` — core tables (users, clients, messages, conversations, activity)
2. `gmail_tokens.sql` — persisted OAuth tokens
3. `internal_messages.sql` — team chat
4. `tenants.sql` — multi-tenant isolation

RLS is enabled; backend uses the `service_role` key for full access.

## Conventions

- Routes return JSON: `{ data }` on success, `{ error: "message" }` on failure.
- All phone numbers stored in E.164 (`+1XXXXXXXXXX`).
- Activity logging via `logActivity()` from `lib/supabase.js`.
- Rate limiting: 200 req/15min general, 30 req/min on SMS endpoints.
- Auth: optional Google Workspace SSO gated by `GOOGLE_AUTH_REQUIRED=true`.
- Vault: keys saved via the in-app Integrations tab persist to `config/vault.json` and override `.env`.

## Testing

No test suite currently. Validate manually:
```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"Noah Connect Virtual Office",...}
```

## Deployment (Vercel)

Push to `main` → auto-deploys. Environment variables configured in Vercel dashboard.
The `vercel.json` rewrites all requests to the Express handler in `server.js`.
