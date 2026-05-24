# CLAUDE.md

Notes for Claude Code (claude.ai/code) when working on this repo.

## Overview

**VoyagerAI** is an Auth0-for-AI Agents demo built around a corporate travel use case. Two services, both required:

| Service | Tech | Port | Purpose |
|---|---|---|---|
| `voyagerai-portal` | React + Vite | 3000 | SPA — Travel Agent (1st-party) + Personal AI Assistant (3rd-party) tabs, MCP Event Timeline, Token Inspector, Audit Trail |
| `voyagerai-api`    | Express      | 3002 | OAuth 2 Resource Server + AI agent loop. JWT validation, scope enforcement at the tool layer, CIBA, audit log, SSE |

Auth0 tenant config: see `docs/AUTH0-TENANT.md`.

## Run

```bash
# Two terminals
cd voyagerai-api && npm start          # :3002
cd voyagerai-portal && npm run dev     # :3000
```

The API's `start` script sets `NODE_TLS_REJECT_UNAUTHORIZED=0` because some corp networks intercept TLS for the LLM gateway. For production, use `NODE_EXTRA_CA_CERTS` instead.

## Architecture

### Authorization tiers (server-side, in `voyagerai-api/lib/policy.js`)

| Tier | Amount (USD) | Gate |
|---|---|---|
| 1 | ≤ $500           | Has `book:travel` scope. Instant. |
| 2 | $500–$2,000      | Step-up MFA — token must carry `amr=['mfa']` (mirrored from ID token by the `inject-bounded-authority` Action). |
| 3 | > $2,000         | Manager CIBA approval **and** trip ≤ `https://voyagerai.demo/max_trip_value` (custom claim). The cap is enforced AFTER the manager approves — that's the demo punchline. |

Policy is a pure function. Test it with `node -e "require('./lib/policy').evaluate({...})"`.

### Agents

- **1st-party Travel Agent (M2M)**: authenticated to Auth0 with `private_key_jwt`. Holds RSA key in `voyagerai-api/agent-private.pem` (gitignored). Used to initiate CIBA via `/bc-authorize`.
- **3rd-party Personal AI Assistant (SPA)**: separate Auth0 application. Portal uses `@auth0/auth0-spa-js` directly (a second `Auth0Client`) for an isolated token cache. Always sends `prompt=consent` so the consent screen fires on every demo run.

### CIBA flow

Real OIDC CIBA (RFC 9126), not Guardian Push notifications:

1. `lib/ciba.js → bcAuthorize()` POSTs to `/bc-authorize` with `login_hint={"format":"iss_sub","iss":...,"sub":...}`, `binding_message`, `scope=openid approve:travel`.
2. `lib/ciba.js → pollToken()` polls `/oauth/token` with `grant_type=urn:openid:params:grant-type:ciba` until 200 OK / `access_denied` / `expired_token`.
3. Polling runs in the background; result is delivered via callback to `lib/agent.js → onCibaResult` → SSE → portal updates booking status.

**Stale auth_req_id protection**: if the user clicks "Resend", `PENDING_BOOKINGS[id].auth_req_id` is replaced. `onCibaResult` ignores callbacks whose `auth_req_id` doesn't match the current one — old polling loops fade silently.

### Important `binding_message` charset

Auth0 accepts only alphanumerics + whitespace + `+-_.,:#`. Anything else (e.g. `$`, `?`, `!`) makes `/bc-authorize` reject. `lib/ciba.js → sanitizeBindingMessage` defangs callers.

### Login Action (Auth0 dashboard)

The `inject-bounded-authority` Action is required for both Tier 2 (`amr` mirroring) and Tier 3 (`max_trip_value` cap). Code in `docs/AUTH0-TENANT.md §4`.

### SSE channels (`lib/events.js`)

Three independent streams:
- `pushSession(sessionId, ...)` — per-chat: chunks, tool results, control flow events for one Assistant conversation
- `emitTimeline(...)` — global MCP Event Timeline (right pane on `/mcp`)
- `pushBooking(bookingId, ...)` — per-Tier-3-booking status (consumed by the portal's CIBA waiting card)

### Tool-level scope enforcement

`/api/agent/chat` only requires authentication, NOT `book:travel`. Each individual tool in `lib/agent.js → runTool` checks its own scope and returns `{ error: 'insufficient_scope', tool, required, held }` if missing. That structured error is what the portal renders as the "Permission denied" card — no LLM round-trip needed.

## Reused patterns

- `lib/policy.js` is a pure function — no side effects. Reuse from a Next.js / serverless rewrite.
- `lib/jwt.js` builds RFC 7521 client assertions with raw Node `crypto` — no `jsonwebtoken` dependency.
- `voyagerai-portal/src/lib/tokens.js` has the design tokens (colors, spacing, fonts). All inline styles reference these — there's no Tailwind.

## Env vars

- `voyagerai-portal/.env` — `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`, `VITE_PERSONAL_ASSISTANT_CLIENT_ID`, `VITE_API_URL`
- `voyagerai-api/.env` — `PORT`, `ISSUER_BASE_URL`, `AUDIENCE`, `AUTH0_MGMT_*`, `AUTH0_AGENT_CLIENT_ID`, `AUTH0_AGENT_PRIVATE_KEY_FILE`, `AUTH0_MANAGER_USER_ID`, `OPENAI_*`, `AGENT_MODEL`, `PORTAL_URL`

The agent's RSA private key MUST live in a file referenced by `AUTH0_AGENT_PRIVATE_KEY_FILE`. Embedding it inline (`AUTH0_AGENT_PRIVATE_KEY=...`) is supported but error-prone — `dotenv` truncates multi-line values silently.

## Linting

```bash
cd voyagerai-portal && npm run lint
```

API has no linter configured — keep it simple Node CommonJS, no TS.

## Demo recovery tips

- **Guardian got stuck and didn't show the prompt**: click **↻ Resend Guardian push** on the waiting card. Stale auth_req_id protection means double-approving is safe.
- **API restarted mid-demo**: `PENDING_BOOKINGS` is in-memory. The portal will show "The pending booking is gone" if you try to resend an orphan. Just fire a fresh Tier 3 prompt.
- **MFA loop after step-up**: confirm the `inject-bounded-authority` Action is deployed AND in the Login flow. Without it, `amr` never reaches the access token and the policy keeps asking for step-up.
- **`Connection error` from OpenAI SDK**: corp TLS interception. The `start` script already sets `NODE_TLS_REJECT_UNAUTHORIZED=0` — confirm you ran `npm start` (not `node index.js` directly).

## Phase status

- ✅ Phase 1 — portal shell + 1st-party agent + step-up MFA + CIBA + bounded authority + Audit Trail UI + Token Inspector + Authorization page
- ✅ Phase 2A — Token Inspector + Audit Trail UI + Authorization page
- ✅ Phase 2B-i — 3rd-party Personal AI Assistant + consent screen + Permission Denied card
- ⏳ Phase 2B-ii — Auth0 FGA store + relationship-based access control on `get_trips` / `book_travel`
- ⏳ Phase 3 — Token Vault for Google Calendar + time-bounded 3rd-party "Tax Agent" + Settings → Agent Control Panel
