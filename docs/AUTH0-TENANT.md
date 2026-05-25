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
- `read:grants`, `delete:grants` *(Phase 3.3 — Connected Agents page lists/revokes user-consented OAuth grants)*
- `read:clients` *(Phase 3.3 — enriches each grant with the app's friendly name)*
- `create:guardian_enrollment_tickets`, `read:guardian_enrollments`

> Note: `read:grants`/`delete:grants` are **not** the same as `read:client_grants`/`delete:client_grants`. The latter is for client-credentials grants between APIs; the former is for user-consented OAuth authorizations (3rd-party apps), which is what Connected Agents shows.

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

## 9. Auth0 FGA — relationship-based authorization

Powers the **`get_user_trips`** tool. OAuth scopes answer *“can the caller call this tool?”*; FGA answers *“on which records?”* The agent has `read:trips`, but FGA decides which `user_profile`s it's allowed to read.

### 9.1 Create the store

Auth0 Dashboard → **Fine-Grained Authorization** → **+ Create Store** → name it `voyagerai-demo`.

### 9.2 Paste the model

In the new store: **Model → Edit** → paste this and **Save**:

```
model
  schema 1.1

type user

type cost_center
  relations
    define member: [user]

type user_profile
  relations
    define owner: [user]
    define cost_center: [cost_center]
    define can_view: owner or member from cost_center
```

> **Why this model?** Each user has a `user_profile` record. The profile is owned by its user and tagged with a cost center. A caller is allowed to view a profile if they *own* it OR are a *member* of the same cost center. This mirrors how org charts gate visibility in real corporate platforms — your peers in the same team see your trips, the VP in another cost center does not.

### 9.3 Create API credentials

Store → **Settings → Authorized Clients → + Create Client** → name `voyagerai-api`.
- Permissions: select **Read** and **Write** (`fga:store:write`, `fga:store:read`, `fga:store:check`).
- Copy the **Client ID** and **Client Secret** before leaving the page.

In **Settings**, also copy:
- **Store ID** (UUID)
- **API URL** (e.g. `https://api.us1.fga.dev`)
- **API Audience** (e.g. `https://api.us1.fga.dev/`)

### 9.4 Fill in the API `.env`

```
FGA_API_URL=https://api.us1.fga.dev
FGA_STORE_ID=01JXXXXXXXXXXXXXXXXXXXXX
FGA_CLIENT_ID=<from 9.3>
FGA_CLIENT_SECRET=<from 9.3>
FGA_API_AUDIENCE=https://api.us1.fga.dev/
# FGA_API_TOKEN_ISSUER=auth.fga.dev   # default; only set if your region differs
```

### 9.5 Seed the demo tuples

```
cd voyagerai-api
npm run seed-fga
```

This script is idempotent — it writes 8 tuples for three demo users:

| User                | cost_center  | Outcome for `user:traveler` `can_view` |
|---------------------|--------------|----------------------------------------|
| `user:traveler`     | engineering  | ALLOWED (self · owner)                 |
| `user:peer-eng`     | engineering  | ALLOWED (same cost center)             |
| `user:vp-engineering` | executive  | DENIED (different cost center)         |

### 9.6 Demo flow (one-liner test in the portal)

In the **Travel Agent · 1st-party** tab on `/mcp`:
- Pick **FGA · allow** quick prompt → *“Show me Lara's upcoming trips.”* → FGA allows, trips render with a green “Auth0 FGA · access allowed” card. Right-pane timeline shows `fga.check · allowed`.
- Pick **FGA · deny** quick prompt → *“Show me VP Engineering's upcoming trips.”* → FGA denies, agent surfaces a red “Auth0 FGA · access denied” card. Timeline shows `fga.check · denied`.

The agent and the human see exactly the same boundary — that's the punchline.

### 9.7 If FGA isn't set up yet

The API still boots. Calls to `get_user_trips` return `fga_not_configured` with a pointer back to this section. Every other Phase 1 / Phase 2A demo flow keeps working.

---

## 10. Token Vault — VoyagerVault (mock downstream service)

Powers the **`save_trip_to_vault`** tool. Demonstrates the Token Vault pattern *without* needing access to Google Cloud / Microsoft Azure / Slack admin: a tiny in-process service called **VoyagerVault** plays the role of the external SaaS. Every part of the OAuth dance is real — separate audience, scoped tokens, JWT validation, audit — only the "downstream service" lives in the same Express app.

> **Why a mock?** The CISO point of Token Vault is *"the agent never holds long-lived credentials for downstream services — Auth0 brokers a short-lived, scoped token at the moment of need."* That story is true for any downstream service whose tokens flow through Auth0. Whether the audience is `https://www.googleapis.com/...` or `https://api.voyagervault.demo` is implementation; the security model is identical.

### 10.1 Create the VoyagerVault API (2nd Auth0 API resource)

Auth0 Dashboard → **APIs → + Create API**:
- **Name**: `VoyagerVault`
- **Identifier**: `https://api.voyagervault.demo` (this becomes the JWT `aud`; must match `VOYAGERVAULT_AUDIENCE` in `.env`)
- **Signing Algorithm**: RS256

Save. Then on the new API → **Permissions** tab → add:
- `read:vault` — Read vault entries
- `write:vault` — Write vault entries

### 10.2 Authorize the Travel Agent for VoyagerVault

Auth0 Dashboard → APIs → **VoyagerVault** → **Machine to Machine Applications** tab → find **VoyagerAI Travel Agent** → toggle ON → expand the permissions row and grant both:
- `read:vault`
- `write:vault`

Save. (The Travel Agent already authenticates via `private_key_jwt` from §3 — no new keys, no new app.)

### 10.3 Fill in `voyagerai-api/.env`

```
# Token Vault — VoyagerVault
VOYAGERVAULT_AUDIENCE=https://api.voyagervault.demo
# Default base URL (same Express app on the same port). Override only if you split it.
# VOYAGERVAULT_BASE_URL=http://localhost:3002
```

Restart the API. You should see in the boot log:
```
VoyagerAI API listening on :3002
  audience: https://api.voyagerai.demo
  vault:    https://api.voyagervault.demo
```

### 10.4 Demo flow

1. In **MCP Server → Travel Agent**, click the **Token Vault · + VoyagerVault** quick prompt.
2. Watch the right-pane Event Timeline — three events fire in order:
   1. `tokenvault.exchange` — `POST /oauth/token` with `grant_type=client_credentials`, `audience=https://api.voyagervault.demo`, `private_key_jwt` assertion. Auth0 returns a vault-scoped access token.
   2. `vault.write` — `POST /api/vault/trips` with `Authorization: Bearer <vault token>` and `X-On-Behalf-Of: <user JWT>`. The vault validates BOTH (agent identity + user identity) and stores the entry.
   3. The agent's confirmation card shows the brokered token's audience and scope.
3. Open the **VoyagerVault** page from the sidebar — your saved entry is there with the agent identity stamped on it.

### 10.5 What this captures (CISO talking points)

- **No static downstream credential.** The Travel Agent has no VoyagerVault API key in code or config. Every call mints a fresh token from Auth0.
- **Audience-scoped tokens.** The user-facing JWT (`aud=https://api.voyagerai.demo`) is *not* valid against VoyagerVault. Reuse is impossible by design.
- **Double-bound writes.** The vault token proves agent identity; the `X-On-Behalf-Of` header (signed user JWT, validated separately) proves the user the action was on behalf of. One leaked token alone can't impersonate.
- **Audited.** Every exchange and every write surfaces in the Event Timeline and the Audit Trail with `decision: allowed/denied`, the agent client_id, and the user sub.

### 10.6 If Token Vault isn't set up yet

The API still boots. Calls to `save_trip_to_vault` return `tokenvault_not_configured` (no `VOYAGERVAULT_AUDIENCE`) or `vault_grant_missing` (Travel Agent not authorized for the API yet) with a pointer back to this section. Every other Phase 1 / 2 demo flow keeps working.

### 10.7 Going from mock → real Google Calendar later

Swap two things, no portal changes needed:
- In `lib/tokenvault.js`, replace the `client_credentials` grant with `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token` + `subject_token=<user JWT>` + `connection=google-oauth2`.
- In `lib/agent.js`, replace the `saveTripToVault` call with one that hits Google Calendar's `events.insert` endpoint.

Tool name, audit log shape, and UI cards stay the same. The model proves the pattern is service-agnostic.

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
