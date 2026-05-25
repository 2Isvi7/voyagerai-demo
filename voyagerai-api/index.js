// VoyagerAI API — Auth0 for AI Agents demo (Phase 1)
//   - JWT validation against the VoyagerAI API audience
//   - MCP-style tool endpoints, scope-gated
//   - Streaming agent chat (OpenAI function-calling), per-session SSE
//   - Global "MCP Event Timeline" SSE for the demo's right-hand panel
//   - CIBA-equivalent flow via Auth0 Guardian Mgmt API push
//   - Bounded-authority custom claim enforced server-side

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { auth, requiredScopes } = require('express-oauth2-jwt-bearer');

const events = require('./lib/events');
const audit  = require('./lib/audit');
const agent  = require('./lib/agent');
const voyagervault = require('./lib/voyagervault');
const mgmt   = require('./lib/mgmt');

const app = express();
app.use(cors());
app.use(express.json());

// Normalize ISSUER_BASE_URL — accept tenant.auth0.com OR https://tenant.auth0.com.
// express-oauth2-jwt-bearer needs a full URL with scheme; without it, every JWT
// validation throws "Invalid URL" before the audience/scope checks run.
const ISSUER = (() => {
  const raw = (process.env.ISSUER_BASE_URL || '').trim();
  if (!raw) throw new Error('ISSUER_BASE_URL is required');
  const withScheme = raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`;
  return withScheme.replace(/\/+$/, '');
})();
// Write back so libs that read process.env.ISSUER_BASE_URL directly (lib/ciba.js,
// lib/tokenvault.js) get the normalized value with the scheme.
process.env.ISSUER_BASE_URL = ISSUER;

const checkJwt = auth({
  audience: process.env.AUDIENCE,
  issuerBaseURL: ISSUER,
});

function decodeJwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch (_) { return {}; }
}

// ─── Health + RFC 8414 discovery ─────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, service: 'voyagerai-api', port: Number(process.env.PORT) || 3002 }));

// Proxy Auth0's OIDC discovery so the demo can show a single ".well-known" call.
app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
  try {
    const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    const meta = await r.json();
    // Augment with the MCP tools endpoint so the timeline can show it.
    meta.tools_endpoint = `${process.env.PORTAL_URL || ''}/api/mcp/tools`;
    events.emitTimeline({
      kind: 'oauth.discovery',
      label: 'OAuth Server Discovery',
      http: 'GET /.well-known/oauth-authorization-server',
      body: { issuer: meta.issuer, scopes_supported: meta.scopes_supported },
    });
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: 'discovery_failed', detail: e.message });
  }
});

// ─── MCP Event Timeline (SSE, public — read-only diagnostic stream) ──────────

app.get('/api/mcp/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ kind: 'connected', ts: new Date().toISOString() })}\n\n`);
  events.registerTimeline(res);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20_000);
  req.on('close', () => { clearInterval(heartbeat); events.dropTimeline(res); });
});

// ─── Read-only metadata for the portal (post-login) ──────────────────────────

app.get('/api/me', checkJwt, (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const payload = decodeJwtPayload(token);
  // amr lives in the custom claim (Auth0 only puts amr in ID tokens by default —
  // the inject-bounded-authority Action mirrors it into the access token).
  const amr = payload['https://voyagerai.demo/amr'] || payload.amr || [];
  res.json({
    sub:    payload.sub,
    scopes: (payload.scope || '').split(' ').filter(Boolean),
    amr,
    max_trip_value: payload['https://voyagerai.demo/max_trip_value'] ?? null,
    iss:    payload.iss,
    aud:    payload.aud,
  });
});

// ─── Per-session chat SSE ────────────────────────────────────────────────────

app.get('/api/agent/chat/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
  events.registerSession(sessionId, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20_000);
  req.on('close', () => { clearInterval(hb); events.dropSession(sessionId, res); });
});

// Send a message. The chat stream MUST already be open with the same sessionId.
// Note: scope is NOT checked at the route level — the agent loop dispatches each
// tool call individually, and each tool enforces its own required scope. That way
// the 3rd-party Personal AI Assistant (read:trips/read:expenses only) can chat,
// and book_travel returns a structured insufficient_scope error the LLM can explain.
app.post('/api/agent/chat',
  checkJwt,
  async (req, res) => {
    const { sessionId, messages } = req.body || {};
    if (!sessionId || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'sessionId and messages[] required' });
    }
    const tokenStr = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const jwtPayload = decodeJwtPayload(tokenStr);
    const userSub = jwtPayload.sub;
    // azp = authorized party (client_id of the app holding the token). Lets the audit
    // log distinguish 1st-party Travel Agent calls from 3rd-party Personal AI Assistant
    // calls — same user, different agent identity.
    const agentSub = jwtPayload.azp || jwtPayload.client_id || userSub;

    res.json({ ok: true, sessionId });

    // Run the loop async (results stream over SSE, not this HTTP response)
    agent.streamChat({ messages, jwtPayload, userAccessToken: tokenStr, sessionId, agentSub, userSub })
      .catch((e) => {
        events.pushSession(sessionId, { type: 'error', message: e.message });
        events.pushSession(sessionId, { type: 'done' });
      });
  }
);

// Resume a Tier 3 booking after CIBA approval. The portal calls this when its
// SSE booking-status feed reports the manager approved. Same loose-scope policy as
// /api/agent/chat — the resume path internally re-runs the policy check.
app.post('/api/agent/resume',
  checkJwt,
  async (req, res) => {
    const { sessionId, bookingId } = req.body || {};
    if (!sessionId || !bookingId) return res.status(400).json({ error: 'sessionId and bookingId required' });

    const tokenStr = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const jwtPayload = decodeJwtPayload(tokenStr);
    const userSub = jwtPayload.sub;
    const agentSub = jwtPayload.azp || jwtPayload.client_id || userSub;

    const result = await agent.resumeBookingAfterCiba({
      bookingId, jwtPayload, sessionId, agentSub, userSub,
    });

    events.pushSession(sessionId, { type: 'tool_result', name: 'book_travel', result });
    events.pushSession(sessionId, { type: 'done' });
    res.json(result);
  }
);

// ─── Booking status (for the "Waiting for Manager" screen) ───────────────────

app.get('/api/bookings/:id/status', (req, res) => {
  const b = agent.getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: req.params.id,
    status: b.status,
    destination: b.destination,
    amountUSD: b.amountUSD,
    type: b.type,
    auth_req_id: b.auth_req_id,
  });
});

// Re-send the CIBA push when Guardian gets stuck. Same parameters as the original
// /bc-authorize call; old auth_req_id is silently abandoned (its polling result
// will be ignored as stale by onCibaResult).
app.post('/api/bookings/:id/resend',
  checkJwt,
  requiredScopes('book:travel'),
  async (req, res) => {
    try {
      const result = await agent.resendCiba(req.params.id);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'resend_failed', detail: e.message });
    }
  }
);

// SSE stream for one booking's status changes. The CIBA polling loop in lib/agent.js
// pushes status updates here when the manager approves/rejects in their Guardian app.
app.get('/api/bookings/:id/stream', (req, res) => {
  const { id } = req.params;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const b = agent.getBooking(id);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', status: b?.status || 'unknown' })}\n\n`);
  events.registerBooking(id, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20_000);
  req.on('close', () => { clearInterval(hb); events.dropBooking(id, res); });
});

// ─── Connected Agents — 3rd-party apps the user authorized ───────────────────
// Reads Auth0 Mgmt API. The 1st-party Travel Agent never appears here (auto-grant,
// not user-consented). The Personal AI Assistant (Phase 2B-i) is the canonical
// entry: scopes `read:trips read:expenses`, audience `https://api.voyagerai.demo`.

app.get('/api/connected-agents', checkJwt, async (req, res) => {
  if (!mgmt.isConfigured()) {
    return res.status(503).json({
      error: 'mgmt_not_configured',
      message: 'Auth0 Mgmt API M2M not configured. See docs/AUTH0-TENANT.md §7.',
    });
  }
  const userId = req.auth?.payload?.sub;
  try {
    const grants = await mgmt.listUserGrantsEnriched(userId);
    // Hide 1st-party clients — they're system grants, not user-consented apps.
    const visible = grants.filter((g) => !g.client?.is_first_party);
    res.json({ user_id: userId, grants: visible });
  } catch (e) {
    res.status(500).json({ error: e.code || 'mgmt_failed', message: e.message });
  }
});

app.delete('/api/connected-agents/:grantId', checkJwt, async (req, res) => {
  if (!mgmt.isConfigured()) {
    return res.status(503).json({ error: 'mgmt_not_configured' });
  }
  const userId = req.auth?.payload?.sub;
  const { grantId } = req.params;
  try {
    // Verify the grant belongs to the calling user before revoking. Auth0 doesn't
    // bind the grantId to the caller's identity — without this check, any user
    // could revoke any other user's grants if they guessed an id.
    const grant = await mgmt.getGrant(grantId);
    if (!grant) return res.status(404).json({ error: 'not_found' });
    if (grant.user_id !== userId) {
      return res.status(403).json({ error: 'forbidden', message: 'Grant does not belong to caller' });
    }
    await mgmt.deleteGrant(grantId);
    audit.record({
      agent_sub: req.auth?.payload?.azp || userId,
      user_sub: userId,
      tool: 'revoke_grant',
      decision: 'allowed',
      reason: 'user_revoked_grant',
      grant: { id: grantId, client_id: grant.client_id || grant.clientID, audience: grant.audience },
    });
    res.json({ ok: true, id: grantId });
  } catch (e) {
    res.status(500).json({ error: e.code || 'mgmt_failed', message: e.message });
  }
});

// ─── Audit trail (read for Phase 2 UI) ───────────────────────────────────────

app.get('/api/audit', checkJwt, (req, res) => {
  const { agent: agentParam, decision, tool, limit } = req.query;
  res.json({ rows: audit.list({ agent: agentParam, decision, tool, limit: Number(limit) || 100 }) });
});

// ─── VoyagerVault — mock downstream service (separate audience) ──────────────
// Lives in the same Express app for simplicity, but with its own audience and JWT
// validation. The agent reaches it via Token Vault flow (see lib/tokenvault.js).

voyagervault.mountRoutes(app);

// ─── Server ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3002;
app.listen(PORT, () => {
  console.log(`VoyagerAI API listening on :${PORT}`);
  console.log(`  audience: ${process.env.AUDIENCE}`);
  console.log(`  issuer:   ${ISSUER}`);
  if (process.env.VOYAGERVAULT_AUDIENCE) {
    console.log(`  vault:    ${process.env.VOYAGERVAULT_AUDIENCE}`);
  }
});
