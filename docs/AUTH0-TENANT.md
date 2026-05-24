# Auth0 Tenant Setup — VoyagerAI Demo

End-to-end walkthrough to configure your Auth0 tenant for the VoyagerAI demo.

> Total time: ~30 min for Phase 1; +20 min for Phase 2 (FGA + 3rd-party app); +15 min for Phase 3 (Token Vault + extra app).

You can do this in any tenant, but a **clean dev tenant** is recommended so you can wipe and re-do without disturbing other demos.

---

## 0. Prerequisites

- Auth0 tenant (free or paid)
- Auth0 Mgmt API enabled (it is by default)
- For Phase 1 CIBA: Auth0 Guardian app installed on a phone you control (this becomes the "Manager" device)
- For Phase 2: an Auth0 FGA store (Auth0 → **Fine-Grained Authorization** → Create Store)
- For Phase 3: a Google Cloud project with the Calendar API enabled

---

## 1. Create the API (audience)

Auth0 Dashboard → **Applications → APIs → + Create API**

| Field | Value |
|---|---|
| Name | `VoyagerAI API` |
| Identifier | `https://api.voyagerai.demo` |
| Signing Algorithm | `RS256` |

Tab **Permissions** — add these scopes:

| Scope | Description |
|---|---|
| `read:profile`     | Read user profile |
| `read:trips`       | Read user's trips |
| `read:expenses`    | Read user's expenses |
| `book:travel`      | Book a trip |
| `approve:travel`   | Manager-only: approve high-value trips |

Tab **Settings** — turn on:

- **Enable RBAC**: ON
- **Add Permissions in the Access Token**: ON
- **Allow Skipping User Consent**: ON for *your own tenant only* (so the 1st-party flow doesn't prompt)

Save.

---

## 2. Create the SPA (the portal)

**Applications → Applications → + Create Application** → *Single Page Application*

Name: `VoyagerAI Portal`

Tab **Settings**:

| Field | Value |
|---|---|
| Allowed Callback URLs    | `http://localhost:3000, http://localhost:3000/dashboard` |
| Allowed Logout URLs      | `http://localhost:3000` |
| Allowed Web Origins      | `http://localhost:3000` |
| Application Login URI    | (leave blank) |
| Refresh Token Behavior   | Rotating |
| Refresh Token Expiration | Inactivity 1 day, Absolute 7 days |

Tab **Connections**: leave default (Username-Password-Authentication).

Copy the **Client ID** → `VITE_AUTH0_CLIENT_ID` in `voyagerai-portal/.env`.

---

## 3. Create the 1st-party Travel Agent (M2M with private_key_jwt)

**Applications → Applications → + Create Application** → *Machine to Machine*

Name: `VoyagerAI Travel Agent`. Authorize against `VoyagerAI API` with scopes:
`read:profile read:trips read:expenses book:travel`.

Tab **Credentials**:

- **Authentication Method**: switch from **Client Secret (Post)** to **Private Key JWT** (RFC 7521)
- Generate a key pair locally and save it inside the API folder:
  ```bash
  cd voyagerai-api
  openssl genpkey -algorithm RSA -out agent-private.pem -pkeyopt rsa_keygen_bits:2048
  openssl rsa -pubout -in agent-private.pem -out agent-public.pem
  # Convert public key to JWK (npx, online tool, etc.) — Auth0 needs JWK for the public key.
  ```
- Paste the **public JWK** into Auth0 (Credentials tab → Add Public Key)
- The **private key** stays in `voyagerai-api/agent-private.pem` (already gitignored).
- In `voyagerai-api/.env`, point at the file:
  ```
  AUTH0_AGENT_PRIVATE_KEY_FILE=./agent-private.pem
  ```
  > ⚠️ Do NOT do `base64 < agent-private.pem` and paste the output — that's double-encoded *and* multi-line, dotenv will truncate it silently and the agent will fail to authenticate. The file pointer is the only sane path.

Copy the **Client ID** → API env var `AUTH0_AGENT_CLIENT_ID`.

> Why `private_key_jwt`? It's the same authentication method shown in the reference video — agents prove their identity with a key, never a shared secret. CISO-friendly: if the secret leaks, you can rotate it without redeploying.

---

## 4. Add the bounded-authority + amr Action

**Actions → Library → + Build Custom** → *Login / Post Login*

Name: `inject-bounded-authority`

```javascript
exports.onExecutePostLogin = async (event, api) => {
  // 1) Bounded authority (per-trip cap) — Tier 3 enforcement.
  const cap = event.user.user_metadata?.max_trip_value_usd ?? 5000;
  api.accessToken.setCustomClaim('https://voyagerai.demo/max_trip_value', cap);

  // 2) Mirror authentication methods into the access token. Auth0 only puts `amr`
  // in the ID token by default; the API needs it in the access token to enforce
  // step-up MFA on Tier 2 bookings.
  const methods = (event.authentication?.methods || []).map((m) => m.name);
  api.accessToken.setCustomClaim('https://voyagerai.demo/amr', methods);
};
```

Click **Deploy**. Then **Actions → Triggers → Login flow** → drag `inject-bounded-authority` into the flow.

> The API enforces both claims server-side in `voyagerai-api/lib/policy.js`. Tier 2 reads `https://voyagerai.demo/amr` (looking for `mfa`). Tier 3 reads `https://voyagerai.demo/max_trip_value` even after the manager approves via CIBA — that's the demo punchline.

---

## 5. Roles + demo users

**User Management → Roles → + Create Role**

| Role     | Permissions (from VoyagerAI API)            |
|----------|----------------------------------------------|
| Traveler | `read:profile read:trips read:expenses book:travel` |
| Manager  | All of the above **plus** `approve:travel` |

**User Management → Users → + Create User** (twice):

| Email                          | Role     | Notes |
|--------------------------------|----------|-------|
| `traveler@voyagerai.demo`      | Traveler | Will be the daily-use user in the demo |
| `manager@voyagerai.demo`       | Manager  | Receives the CIBA push |

(Use `Username-Password-Authentication` connection. Set strong passwords.)

---

## 6. Enable true CIBA (Client-Initiated Backchannel Authentication)

This demo uses **real OIDC CIBA** (RFC 9126), not a Guardian push notification. The manager approves directly inside the Auth0 Guardian app — no browser sign-in, no deep links.

### 6.1 Enable CIBA on the tenant

Auth0 Dashboard → **Settings → Advanced** → scroll to **Settings**:
- ✅ **Enable Client Initiated Backchannel Authentication Flow**: ON

(On modern tenants this may already be on by default. If you don't see the toggle, run:
`PATCH https://<tenant>/api/v2/tenants/settings { "flags": { "allow_legacy_delegation_grant_types": false }}` via Mgmt API — but usually the dashboard toggle is enough.)

### 6.2 Enable CIBA grant on the Travel Agent

**Applications → Applications → VoyagerAI Travel Agent → Settings → Advanced Settings → Grant Types**:
- ✅ `urn:openid:params:grant-type:ciba` — ENABLE
- (Keep `client_credentials` enabled too)

### 6.3 Authorize the agent for `approve:travel`

The agent itself needs to be allowed to *request* CIBA tokens with the `approve:travel` scope (it asks Auth0 on behalf of the manager — Auth0 then asks the manager).

**Applications → APIs → VoyagerAI API → Machine to Machine Applications**:
- Expand **VoyagerAI Travel Agent**
- ✅ Toggle ON: `read:profile`, `read:trips`, `read:expenses`, `book:travel`, **`approve:travel`** ← important

### 6.4 Enroll the Manager in Guardian Push

1. As `manager@voyagerai.demo`, sign into Auth0 (any app — even just `https://manage.auth0.com/dashboard/u/<tenant>/login`).
2. Auth0 prompts to enroll MFA. Choose **Push Notification (Auth0 Guardian)**.
3. Install the **Auth0 Guardian** app on a phone you control. Scan the QR.
4. Done — the Guardian app will now show structured CIBA prompts when the agent requests approval.

### 6.5 Capture the Manager's `user_id`

**User Management → Users → manager@voyagerai.demo** → copy the `user_id` (e.g. `auth0|abc123…`) → API env var `AUTH0_MANAGER_USER_ID`.

> The agent calls `POST /bc-authorize` with `login_hint={"format":"sub","sub":"<this id>"}`. Auth0 looks up the user, finds their Guardian enrollment, and pushes a structured CIBA prompt to the phone. The manager taps **Approve** or **Reject** *inside the Guardian app* — no browser sign-in, no MFA challenge, no deep link.

---

## 7. Mgmt API (M2M for Guardian + grant revocation)

**Applications → Applications → + Create Application** → *Machine to Machine* — name `VoyagerAI Mgmt`. Authorize against **Auth0 Management API** with at least:

- `read:users`
- `read:user_idp_tokens` (Phase 3)
- `read:client_grants`, `delete:client_grants` (Phase 3)
- `create:guardian_enrollment_tickets`, `read:guardian_enrollments`

Copy `Client ID` → API env var `AUTH0_MGMT_CLIENT_ID`. Copy `Client Secret` → `AUTH0_MGMT_CLIENT_SECRET`.

---

## 8. (Phase 2B) Personal AI Assistant — 3rd-party app

**Applications → Applications → + Create Application** → *Single Page Application*

Name: `Personal AI Assistant`.

Tab **Settings**:

| Field | Value |
|---|---|
| Allowed Callback URLs | `http://localhost:3000` |
| Allowed Logout URLs   | `http://localhost:3000` |
| Allowed Web Origins   | `http://localhost:3000` |
| Refresh Token Behavior | Rotating |
| Refresh Token Expiration | Inactivity 1 day, Absolute 7 days |

Tab **APIs** (this is the critical step):

- Authorize against **VoyagerAI API**
- Toggle **only** these scopes: ✅ `read:trips`, ✅ `read:expenses`
- Leave OFF: ❌ `book:travel`, ❌ `approve:travel`, ❌ `read:profile`

> That deliberate restriction is the demo: when this app's agent tries `book_travel`, the API returns `403 insufficient_scope`. The CISO sees the boundary in real time.

The portal forces a consent screen every time by sending `prompt=consent` on the authorize call, so you don't need to play with the "Allow Skipping User Consent" toggle on the API.

Copy the new app's **Client ID** → `voyagerai-portal/.env`:

```
VITE_PERSONAL_ASSISTANT_CLIENT_ID=<3rd-party-client-id>
```

> Recap: the SPA you already use (`VoyagerAI Portal`) holds the *user's* identity — that's the 1st-party Travel Agent. The new SPA `Personal AI Assistant` is conceptually a *separate company's app* asking the user for delegated read-only access. Same Auth0 tenant, two independent app records, two independent token caches inside the portal.

---

## 9. (Phase 2) Auth0 FGA store

Auth0 Dashboard → **Fine-Grained Authorization** → Create Store named `voyagerai`.

Paste this authorization model (Authorization Model tab → Edit):

```
model
  schema 1.1

type user

type cost_center
  relations
    define member: [user]
    define approver: [user]

type trip
  relations
    define cost_center: [cost_center]
    define owner: [user]
    define can_view: owner or member from cost_center
    define can_approve: approver from cost_center
```

Generate API credentials (Settings → API Credentials → Create) and copy:
- `FGA_STORE_ID`, `FGA_API_URL`, `FGA_CLIENT_ID`, `FGA_CLIENT_SECRET`, `FGA_API_AUDIENCE` → API `.env`

Demo seed tuples are written by `scripts/seed-fga.js` (Phase 2).

---

## 10. (Phase 3) Token Vault — Google Calendar

Auth0 Dashboard → **Authentication → Social → + Google / OAuth2**

If you don't already have one configured:
1. In Google Cloud Console, create OAuth credentials (Web application). Add Authorized redirect URI: `https://<your-tenant>.auth0.com/login/callback`.
2. In Auth0, paste the Google `Client ID` + `Client Secret`.
3. In **Permissions**, add `https://www.googleapis.com/auth/calendar.events`.

Auth0 Dashboard → **Token Vault → Connections → + New Connection** → choose `google-oauth2`. Confirm scopes include `calendar.events`.

API `.env`:
- `GOOGLE_CALENDAR_CONNECTION_ID=<the connection id>`

> The API exchanges the user's Auth0 access token for a Google access token via Token Vault, then calls `POST https://www.googleapis.com/calendar/v3/calendars/primary/events`. The Google access token never crosses the browser.

---

## 11. Verify the env files

`voyagerai-portal/.env` (Phase 1):
```
VITE_AUTH0_DOMAIN=<your-tenant>.auth0.com
VITE_AUTH0_CLIENT_ID=<step 2 client id>
VITE_AUTH0_AUDIENCE=https://api.voyagerai.demo
```

`voyagerai-api/.env` (Phase 1 — **separate folder** from `acmebank-api/` so the AcmeBank demo keeps working):
```
PORT=3002
ISSUER_BASE_URL=https://<your-tenant>.auth0.com
AUDIENCE=https://api.voyagerai.demo

# Mgmt API M2M (step 7)
AUTH0_MGMT_DOMAIN=<your-tenant>.auth0.com
AUTH0_MGMT_CLIENT_ID=<step 7 mgmt client id>
AUTH0_MGMT_CLIENT_SECRET=<step 7 mgmt secret>

# 1st-party Travel Agent (step 3)
AUTH0_AGENT_CLIENT_ID=<step 3 client id>
AUTH0_AGENT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# CIBA target (step 6)
AUTH0_MANAGER_USER_ID=auth0|...

# Agent runtime (existing)
OPENAI_API_KEY=<...>
OPENAI_BASE_URL=<optional, e.g. anthropic gateway>
AGENT_MODEL=claude-haiku-4-5

PORTAL_URL=http://localhost:3000
```

---

## 12. Smoke test (after Phase 1 code lands)

1. `cd voyagerai-portal && npm install && npm run dev` → http://localhost:3000
2. `cd voyagerai-api && npm install && npm start` → :3002

> The AcmeBank demo (`acmebank-api/` + `acmebank-tesorero-portal/`) stays untouched on its own ports (3001 / 3000-legacy). The two demos do not share state.
3. Click **Open Dashboard**, log in as `traveler@voyagerai.demo`.
4. Watch network tab — the portal should call Auth0 PKCE, get a token, and the API should accept it.
5. Visit `/mcp` — the live event timeline should connect via SSE and show the *agent* token request when you ask the assistant a question.

If any of those fail, see `docs/TROUBLESHOOTING.md`.

---

## What this demo touches that "regular" Auth0 doesn't

For CISO Q&A:

- **Bounded authority** — a custom claim issued at login, enforced server-side. Same pattern as `act` for OAuth delegation, but for *limits* instead of identity.
- **CIBA (Client-Initiated Backchannel Authentication)** — async, out-of-band approval. Your phone gets the prompt, not the user's browser. Crucial for AI agents that act on your behalf when you're not at your desk.
- **Token Vault** — Auth0 stores the user's access tokens for Google / Slack / etc., and the API exchanges its own token for a downstream one. The agent never touches a refresh token, never holds a password.
- **Fine-Grained Authorization (FGA)** — relationship-based authz (Google Zanzibar style). The same `can_view` decision the human gets, your agent inherits — no more, no less.
