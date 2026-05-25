// Token Vault — broker short-lived, scoped tokens for downstream services.
//
// In a real Token Vault flow Auth0 stores OAuth tokens for external SaaS (Google,
// Slack, etc.) and the agent exchanges the user's JWT for a service-specific token
// at the moment of need. This demo can't reach external SaaS (no Google Cloud
// access), so the "downstream service" is a small internal API: VoyagerVault.
// The CISO story is the same — the agent never holds a static credential for the
// downstream service, Auth0 brokers a short-lived audience-scoped token, every
// call is logged, scopes are checked.
//
// Flow:
//   1. Agent receives the user's JWT via /api/agent/chat.
//   2. To call VoyagerVault, agent does NOT use the user's JWT directly (different
//      audience). It calls Auth0 /oauth/token with client_credentials +
//      private_key_jwt + audience=VOYAGERVAULT_AUDIENCE → gets a token with
//      scope `write:vault`.
//   3. Agent calls /api/vault/trips with two things:
//        - Authorization: Bearer <vault token>   (proves the agent is allowed)
//        - X-On-Behalf-Of: <user JWT>            (binds the action to the user)
//   4. VoyagerVault validates both, stores the trip note keyed by user sub.
//
// In production the same plumbing maps onto real Token Vault by swapping
// client_credentials for the federated-connection grant — caller code doesn't change.

const events = require('./events');
const { buildClientAssertion } = require('./jwt');

const CA_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

let cachedToken = null; // { access_token, expires_at }

function isConfigured() {
  return !!process.env.VOYAGERVAULT_AUDIENCE
      && !!process.env.AUTH0_AGENT_CLIENT_ID
      && !!process.env.ISSUER_BASE_URL;
}

// Fetch (or reuse) the agent's vault-scoped token. M2M client_credentials with
// private_key_jwt, separate audience from the main API.
async function getVaultToken() {
  if (cachedToken && cachedToken.expires_at > Date.now() + 30_000) {
    return cachedToken.access_token;
  }

  const issuer = process.env.ISSUER_BASE_URL;
  const tokenUrl = (issuer.endsWith('/') ? issuer : issuer + '/') + 'oauth/token';
  const audience = process.env.VOYAGERVAULT_AUDIENCE;

  const clientAssertion = buildClientAssertion({
    issuer,
    clientId: process.env.AUTH0_AGENT_CLIENT_ID,
  });

  const body = new URLSearchParams({
    grant_type:            'client_credentials',
    audience,
    client_id:             process.env.AUTH0_AGENT_CLIENT_ID,
    client_assertion_type: CA_TYPE,
    client_assertion:      clientAssertion,
    scope:                 'write:vault read:vault',
  });

  events.emitTimeline({
    kind:  'tokenvault.exchange',
    label: `Token Vault: requesting downstream token (${audience})`,
    http:  `POST ${tokenUrl}`,
    body:  { grant_type: 'client_credentials', audience, scope: 'write:vault read:vault' },
  });

  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    events.emitTimeline({
      kind:  'tokenvault.error',
      label: `Token Vault: ${json.error || res.status}`,
      http:  `POST ${tokenUrl}`,
      body:  { error: json.error, error_description: json.error_description },
      decision: 'failed',
    });
    const err = new Error(json.error_description || json.error || `HTTP ${res.status}`);
    err.code = json.error || 'token_exchange_failed';
    err.status = res.status;
    throw err;
  }

  cachedToken = {
    access_token: json.access_token,
    expires_at:   Date.now() + (json.expires_in || 3600) * 1000,
  };

  events.emitTimeline({
    kind:  'tokenvault.exchange',
    label: 'Token Vault: downstream token issued',
    body:  { audience, expires_in: json.expires_in, scope: json.scope },
    decision: 'allowed',
  });

  return cachedToken.access_token;
}

// Save a trip note to VoyagerVault on behalf of the user. The user JWT is sent as
// a header (On-Behalf-Of pattern) so the vault knows which user owns the entry.
async function saveTripToVault({ userAccessToken, payload }) {
  const vaultBase = process.env.VOYAGERVAULT_BASE_URL || `http://localhost:${process.env.PORT || 3002}`;
  const url = `${vaultBase}/api/vault/trips`;

  const vaultToken = await getVaultToken();

  events.emitTimeline({
    kind:  'vault.write',
    label: `VoyagerVault: save trip "${payload.summary}"`,
    http:  `POST ${url}`,
    body:  { summary: payload.summary, destination: payload.destination, dates: payload.dates },
  });

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:    `Bearer ${vaultToken}`,
      'X-On-Behalf-Of': userAccessToken,
      'Content-Type':   'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    events.emitTimeline({
      kind:  'vault.error',
      label: `VoyagerVault: ${json.error || res.status}`,
      body:  json,
      decision: 'failed',
    });
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.code = json.error || 'vault_failed';
    err.status = res.status;
    throw err;
  }

  events.emitTimeline({
    kind:  'vault.write',
    label: `VoyagerVault: entry stored · ${json.id}`,
    body:  { id: json.id, owner_sub: json.owner_sub },
    decision: 'allowed',
  });

  return json;
}

module.exports = { isConfigured, getVaultToken, saveTripToVault };
