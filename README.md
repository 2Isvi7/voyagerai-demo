# VoyagerAI — Auth0 for AI Agents Demo

A live, full-stack demo showing **how Auth0 protects an AI agent that books travel on a user's behalf**. Built for CISO audiences — every Auth0-for-AI pattern is visible in the UI as it happens.

> **Audience:** Auth0 SEs and security leaders. Use cases are intentionally simple (corporate travel) so the conversation stays on the identity story, not the domain.

---

## What it demonstrates

| Auth0 pattern | What you see in the demo |
|---|---|
| **Bounded authority** | Custom JWT claim `https://voyagerai.demo/max_trip_value` enforced server-side. Even after the manager approves, a trip over the cap is blocked. |
| **Step-up MFA** | Tier 2 bookings ($500–$2,000) trigger `acr_values=mfa`. Token returns with `amr=['mfa']`, agent retries automatically. |
| **CIBA (RFC 9126)** | Tier 3 bookings dispatch a structured prompt to the manager's Auth0 Guardian app. Manager taps Approve **inside Guardian** — no browser sign-in. |
| **`private_key_jwt`** | The 1st-party Travel Agent authenticates to Auth0 with an RSA-signed `client_assertion`. No shared secret. |
| **3rd-party consent** | A separate "Personal AI Assistant" SPA asks for delegated read-only access. Auth0 shows a real consent screen. The agent never gets `book:travel` and the API enforces it (`403 insufficient_scope`). |
| **Identity-bound audit** | Every tool call (allowed or denied) recorded against the agent's `azp` and the user's `sub` — exportable to CSV with FINRA / SEC / SOX framing. |

A live "Event Timeline" pane shows every OAuth, FGA, and CIBA call in real time as the agent works. That's the centerpiece of the demo.

---

## Three CISO-friendly stories

1. **The agent acts as me, with limits.**
   1st-party agent + step-up MFA + CIBA + bounded authority. The 4 booking tiers are wired to live Auth0 controls.

2. **The agent only sees what I let it see.**
   3rd-party Personal AI Assistant arrives via real Auth0 consent screen, with read-only scopes. Tries to book → blocked at the API. (FGA integration is Phase 2B-ii.)

3. **The agent never holds my password.** *(Phase 3, planned)*
   Token Vault for Google Calendar — agent calls Google APIs without ever touching the user's Google credential.

---

## Architecture

```
┌─────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│  voyagerai-portal/  │    │   voyagerai-api/     │    │   Auth0 Tenant       │
│  React + Vite       │◄──►│   Express + LLM      │◄──►│   OIDC · Guardian    │
│  :3000              │SSE │   :3002              │M2M │   FGA · Token Vault  │
└──────────┬──────────┘    │   MCP-style endpoints│    └──────────┬───────────┘
           │               └──────────┬───────────┘               │
           │ JWT (1st-party + 3rd-party tokens)                   │ CIBA push
           │                          │                           │ (structured)
           ▼                          ▼                           ▼
   Browser (Traveler)          Live event timeline →         Manager device
                               streamed to portal SSE         (Auth0 Guardian)
```

---

## Quickstart

**Requirements:** Node 20+, an Auth0 tenant, ~30 min for the tenant setup.

```bash
# 1. Configure Auth0 — follow docs/AUTH0-TENANT.md sections 1-7 (Phase 1)
#    and section 8 (Phase 2B 3rd-party app).

# 2. Install
(cd voyagerai-api    && npm install)
(cd voyagerai-portal && npm install)

# 3. Configure local env
cp voyagerai-api/.env.example    voyagerai-api/.env
cp voyagerai-portal/.env.example voyagerai-portal/.env
# Fill the values from your Auth0 tenant.

# 4. Save the agent's RSA private key locally (NEVER commit):
#    voyagerai-api/agent-private.pem
# Reference it in voyagerai-api/.env:
#    AUTH0_AGENT_PRIVATE_KEY_FILE=./agent-private.pem

# 5. Run (separate terminals)
(cd voyagerai-api    && npm start)        # :3002
(cd voyagerai-portal && npm run dev)      # :3000

# 6. Open http://localhost:3000 and sign in as the demo Traveler.
```

---

## Demo script (live, ~6 min)

Open `/mcp` for the split chat + Event Timeline view. Use the **Quick prompts** chip bar — no typing during the demo.

**Act 1 — 1st-party agent (Travel Agent tab)**

1. *"Book a flight to Mexico City for $400"* → Tier 1, instant. Timeline shows `private_key_jwt` token request → tool call.
2. *"Book a flight to Tokyo for $1,800"* → Tier 2 step-up. Auth0 redirects to MFA in-line, agent retries.
3. *"Book a hotel in Singapore for $4,500"* → Tier 3. Manager phone gets a **CIBA prompt** in Guardian. Manager taps Approve — booking completes via SSE.
4. *"Book a round-the-world trip for $8,000"* → Tier 3 + bounded authority. Manager approves, but the API blocks it: cap is $5,000. Agent explains.

**Act 2 — 3rd-party agent (Personal AI Assistant tab)**

1. Switch tab → click **Authorize via Auth0**. A popup with the Auth0 consent screen appears, listing the requested scopes (`read:trips`, `read:expenses`).
2. Approve. Click **Upcoming trips** / **YTD spend** — both work.
3. Click **Try to book ✗** → big red **Permission denied** card showing required scope vs held scopes, plus "switch to 1st-party agent" hint.

**Closing**

Open `/auth0/audit` — the trail shows the same user with two distinct agent identities. Click **Export for Audit** for the CSV.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 · Vite · `@auth0/auth0-react` 2 · `@auth0/auth0-spa-js` (3rd-party flow) |
| API      | Node 20 · Express 5 · `express-oauth2-jwt-bearer` · OpenAI SDK (works with any OpenAI-compatible gateway) |
| Identity | Auth0 OIDC · Guardian · CIBA · Management API |

---

## Repo layout

```
.
├── voyagerai-portal/        — React SPA (the user-facing app)
│   └── src/
│       ├── pages/           — Landing, Dashboard, Assistant, MCPServer, Audit, Tokens, etc.
│       ├── components/      — Layout (sidebar nav)
│       ├── lib/             — design tokens, fetch wrapper, 3rd-party Auth0 client
│       └── hooks/           — SSE consumer
├── voyagerai-api/           — Express MCP-style API
│   ├── index.js             — routes
│   └── lib/
│       ├── policy.js        — pure 3-tier evaluator + bounded authority
│       ├── ciba.js          — true CIBA (bc-authorize + polling)
│       ├── jwt.js           — private_key_jwt assertion signer
│       ├── agent.js         — OpenAI tool loop
│       ├── events.js        — SSE pub/sub (per-session + global timeline + per-booking)
│       └── audit.js         — append-only audit log
├── docs/
│   └── AUTH0-TENANT.md      — full Auth0 dashboard walkthrough
├── CLAUDE.md                — notes for Claude Code agents working on this repo
└── README.md                — this file
```

---

## License

MIT — see [LICENSE](LICENSE).
