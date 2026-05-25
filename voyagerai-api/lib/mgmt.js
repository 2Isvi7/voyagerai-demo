// Auth0 Management API wrapper. Currently used by the Connected Agents page to
// list and revoke a user's OAuth authorization grants.
//
// M2M client setup: see docs/AUTH0-TENANT.md §7. Required scopes for the Mgmt M2M:
//   - read:grants     (list user grants)
//   - delete:grants   (revoke one)
//   - read:clients    (look up the client's friendly name for each grant)
//
// All calls cache the M2M token (Auth0 issues a 24h token by default) so we don't
// burn one rate-limit slot per page load. Client metadata is cached per-process
// since it doesn't change in a demo.

const events = require('./events');

const REQUIRED = ['AUTH0_MGMT_DOMAIN', 'AUTH0_MGMT_CLIENT_ID', 'AUTH0_MGMT_CLIENT_SECRET'];

let tokenCache = null;          // { access_token, expires_at }
const clientCache = new Map();  // clientId -> { name, description, app_type, ... }

function isConfigured() {
  return REQUIRED.every((k) => !!process.env[k]);
}

function ensureConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      'Mgmt API not configured. Set AUTH0_MGMT_DOMAIN, AUTH0_MGMT_CLIENT_ID, ' +
      'AUTH0_MGMT_CLIENT_SECRET in voyagerai-api/.env. See docs/AUTH0-TENANT.md §7.'
    );
    err.code = 'MGMT_NOT_CONFIGURED';
    throw err;
  }
}

function mgmtBaseUrl() {
  return `https://${process.env.AUTH0_MGMT_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

async function getMgmtToken() {
  if (tokenCache && tokenCache.expires_at > Date.now() + 60_000) return tokenCache.access_token;

  ensureConfigured();
  const url = `${mgmtBaseUrl()}/oauth/token`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     process.env.AUTH0_MGMT_CLIENT_ID,
      client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
      audience:      `${mgmtBaseUrl()}/api/v2/`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `HTTP ${res.status}`);
    err.code = json.error || 'mgmt_token_failed';
    err.status = res.status;
    throw err;
  }
  tokenCache = {
    access_token: json.access_token,
    expires_at:   Date.now() + (json.expires_in || 3600) * 1000,
  };
  return tokenCache.access_token;
}

async function mgmtFetch(path, opts = {}) {
  const token = await getMgmtToken();
  const url = `${mgmtBaseUrl()}/api/v2${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.message || json?.error_description || `HTTP ${res.status}`);
    err.code = json?.errorCode || json?.error || `mgmt_${res.status}`;
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

// List grants the user authorized. Auth0 returns:
//   [{ id, clientID, user_id, audience, scope: [...] }, ...]
// We normalize `clientID`/`client_id` capitalization variants.
async function listUserGrants(userId) {
  const grants = await mgmtFetch(`/grants?user_id=${encodeURIComponent(userId)}&per_page=100`);
  return (grants || []).map((g) => ({
    id:        g.id,
    client_id: g.client_id || g.clientID,
    user_id:   g.user_id,
    audience:  g.audience,
    scope:     Array.isArray(g.scope) ? g.scope : (typeof g.scope === 'string' ? g.scope.split(' ').filter(Boolean) : []),
  }));
}

// Get a client's metadata. Cached per-process. Friendly fields only.
async function getClient(clientId) {
  if (clientCache.has(clientId)) return clientCache.get(clientId);
  try {
    const c = await mgmtFetch(`/clients/${encodeURIComponent(clientId)}?fields=name,description,app_type,client_id,logo_uri,is_first_party`);
    const summary = {
      client_id:      c.client_id || clientId,
      name:           c.name || clientId,
      description:    c.description || null,
      app_type:       c.app_type || null,
      logo_uri:       c.logo_uri || null,
      is_first_party: !!c.is_first_party,
    };
    clientCache.set(clientId, summary);
    return summary;
  } catch (e) {
    // Fall back to id-only — don't blow up the whole list because one client wasn't found.
    const fallback = { client_id: clientId, name: clientId, description: null, app_type: null, logo_uri: null, is_first_party: false };
    clientCache.set(clientId, fallback);
    return fallback;
  }
}

// Resolve one grant to { ...grant, client: {...} } so the portal can show a name.
async function listUserGrantsEnriched(userId) {
  const grants = await listUserGrants(userId);
  events.emitTimeline({
    kind:  'mgmt.list_grants',
    label: `Mgmt API: list grants for ${userId} (${grants.length})`,
    http:  `GET /api/v2/grants?user_id=${userId}`,
    body:  { count: grants.length, ids: grants.map((g) => g.id) },
    decision: 'allowed',
  });
  return Promise.all(grants.map(async (g) => ({
    ...g,
    client: await getClient(g.client_id),
  })));
}

async function getGrant(grantId) {
  // /grants doesn't have a single-id GET. We fetch all and filter — fine for demo scale.
  const all = await mgmtFetch(`/grants?per_page=100`);
  return (all || []).find((g) => g.id === grantId) || null;
}

async function deleteGrant(grantId) {
  await mgmtFetch(`/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  events.emitTimeline({
    kind:  'mgmt.revoke_grant',
    label: `Mgmt API: revoked grant ${grantId}`,
    http:  `DELETE /api/v2/grants/${grantId}`,
    decision: 'allowed',
  });
}

module.exports = { isConfigured, getMgmtToken, listUserGrants, listUserGrantsEnriched, getClient, getGrant, deleteGrant };
