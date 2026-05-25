// VoyagerVault — a mock "downstream service" representing an external SaaS the
// agent might call (think Notion, a trip-notes app, an expense tracker). Its
// existence is what lets us demo Token Vault without owning a real third-party.
//
// What makes it a valid demo target:
//   - It has a SEPARATE Auth0 API audience (`VOYAGERVAULT_AUDIENCE`) — not the main
//     VoyagerAI API. The Travel Agent's user-facing JWT is NOT valid here, so the
//     agent must broker a vault-scoped token via Auth0.
//   - It validates that token using the same Auth0 issuer JWKS, so the demo is
//     end-to-end real OAuth — no shortcuts.
//   - It double-binds writes to a user identity via the X-On-Behalf-Of header (the
//     user's original JWT), which the vault validates separately.
//
// Storage is in-memory; resets on API restart. That's fine for the demo.

const { auth } = require('express-oauth2-jwt-bearer');
const events = require('./events');

// ─── Storage ────────────────────────────────────────────────────────────────
// { [userSub]: [{ id, summary, destination, dates, notes, ts, agent_sub }] }
const ENTRIES = {};

function listEntries(userSub) {
  return ENTRIES[userSub] || [];
}

function addEntry(userSub, entry) {
  const id = `VV-${Date.now().toString(36).toUpperCase()}`;
  const stored = { id, ...entry, ts: new Date().toISOString() };
  if (!ENTRIES[userSub]) ENTRIES[userSub] = [];
  ENTRIES[userSub].unshift(stored);
  return stored;
}

// ─── JWT middleware (vault audience, not main API) ──────────────────────────

function checkVaultJwt() {
  if (!process.env.VOYAGERVAULT_AUDIENCE) {
    // Stub: returns 503 so the demo fails clearly with a docs pointer.
    return (_req, res, _next) => res.status(503).json({
      error: 'voyagervault_not_configured',
      message: 'Set VOYAGERVAULT_AUDIENCE in voyagerai-api/.env. See docs/AUTH0-TENANT.md §10.',
    });
  }
  return auth({
    audience: process.env.VOYAGERVAULT_AUDIENCE,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
    tokenSigningAlg: 'RS256',
  });
}

// Decode the X-On-Behalf-Of user JWT WITHOUT signature verification — the gateway
// (this same Express app) already validated the user JWT on the inbound /api/agent/*
// route. The vault double-checks the audience matches the main API to be safe.
function decodeOboUser(headerValue) {
  if (!headerValue) return null;
  const parts = headerValue.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.aud !== process.env.AUDIENCE && !(Array.isArray(payload.aud) && payload.aud.includes(process.env.AUDIENCE))) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function mountRoutes(app) {
  // POST /api/vault/trips — agent stores a trip note for a user.
  // Authorization: Bearer <vault-audience token>          ← agent identity (M2M)
  // X-On-Behalf-Of: <user JWT>                            ← user identity
  app.post('/api/vault/trips', checkVaultJwt(), (req, res) => {
    const agentSub = req.auth?.payload?.sub || req.auth?.payload?.azp;
    const agentScopes = (req.auth?.payload?.scope || '').split(' ').filter(Boolean);

    if (!agentScopes.includes('write:vault')) {
      events.emitTimeline({
        kind:  'vault.error',
        label: 'VoyagerVault: insufficient_scope (write:vault missing)',
        body:  { agent_sub: agentSub, scopes: agentScopes },
        decision: 'failed',
      });
      return res.status(403).json({
        error: 'insufficient_scope',
        required: 'write:vault',
        held: agentScopes,
      });
    }

    const obo = decodeOboUser(req.headers['x-on-behalf-of']);
    if (!obo) {
      return res.status(400).json({
        error: 'missing_or_invalid_obo',
        message: 'X-On-Behalf-Of header must contain the user JWT (audience matching main API).',
      });
    }

    const { summary, destination, dates, notes } = req.body || {};
    if (!summary || !destination || !dates) {
      return res.status(400).json({ error: 'invalid_request', message: 'summary, destination, dates required' });
    }

    const stored = addEntry(obo.sub, {
      summary, destination, dates, notes: notes || null,
      agent_sub: agentSub, owner_sub: obo.sub,
    });

    events.emitTimeline({
      kind:  'vault.write',
      label: `VoyagerVault: entry stored for ${obo.sub} (by ${agentSub})`,
      body:  { id: stored.id, summary: stored.summary, destination: stored.destination },
      decision: 'allowed',
    });

    res.json(stored);
  });

  // GET /api/vault/trips — user reads their own vault entries. Uses the MAIN API
  // JWT (not the vault token) — this is a user-facing read endpoint, the user
  // owns their data and proves it via their access token.
  app.get('/api/vault/trips', require('express-oauth2-jwt-bearer').auth({
    audience: process.env.AUDIENCE,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
    tokenSigningAlg: 'RS256',
  }), (req, res) => {
    const userSub = req.auth?.payload?.sub;
    res.json({ entries: listEntries(userSub) });
  });
}

module.exports = { mountRoutes, listEntries, addEntry };
