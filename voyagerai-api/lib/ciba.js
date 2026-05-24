// True CIBA flow (RFC 9126 / OIDC CIBA, Auth0 implementation).
//
//   1. POST /bc-authorize  →  { auth_req_id, expires_in, interval }
//      Manager's Guardian app pops a structured "Approve / Reject" prompt
//      with the binding_message we provided.
//   2. POST /oauth/token (grant=ciba)  →  poll until manager taps Approve/Reject.
//      Approved → 200 with access_token (issued on behalf of the manager,
//                  scope=approve:travel).
//      Pending  → 400 authorization_pending — keep polling.
//      Rejected → 400 access_denied.
//      Expired  → 400 expired_token.
//
// The agent app authenticates both endpoints with private_key_jwt (no shared secret).

const events = require('./events');
const { buildClientAssertion } = require('./jwt');

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

function getIssuer() {
  const raw = (process.env.ISSUER_BASE_URL || '').trim();
  const withScheme = raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`;
  return withScheme.replace(/\/+$/, '');
}

function commonClientAuthFields() {
  const issuer = getIssuer();
  const clientId = process.env.AUTH0_AGENT_CLIENT_ID;
  if (!clientId) throw new Error('AUTH0_AGENT_CLIENT_ID is required for CIBA');
  const assertion = buildClientAssertion({ issuer, clientId });
  return { issuer, clientId, assertion };
}

// Initiate the CIBA backchannel auth. Returns { auth_req_id, expires_in, interval }.
// Auth0's binding_message charset is alphanumerics + whitespace + `+-_.,:#`.
// Anything else (e.g. $, ?, ', !) makes /bc-authorize reject the request.
function sanitizeBindingMessage(s) {
  if (!s) return 'Approval required';
  // Replace common substitutions for readability, then strip the rest.
  const cleaned = s
    .replace(/\$/g, 'USD ')
    .replace(/[^A-Za-z0-9\s+\-_.,:#]/g, '');
  // Auth0 caps at 64 chars (truncates aggressively in the Guardian UI).
  return cleaned.length > 64 ? cleaned.slice(0, 61).trimEnd() + '...' : cleaned;
}

async function bcAuthorize({ managerUserId, bindingMessage, scope, audience }) {
  if (!managerUserId) throw new Error('managerUserId required');
  bindingMessage = sanitizeBindingMessage(bindingMessage);

  // OIDC CIBA spec mandates `openid` scope. Prepend it if the caller didn't include it.
  const scopes = (scope || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes('openid')) scopes.unshift('openid');
  const finalScope = scopes.join(' ');

  const { issuer, clientId, assertion } = commonClientAuthFields();
  // Auth0 requires login_hint.format = "iss_sub" with both iss (tenant URL, trailing slash)
  // and sub (auth0 user_id). The plain "sub" format is not accepted.
  const loginHint = JSON.stringify({
    format: 'iss_sub',
    iss: issuer.endsWith('/') ? issuer : issuer + '/',
    sub: managerUserId,
  });

  const body = new URLSearchParams();
  body.append('client_id', clientId);
  body.append('client_assertion_type', CLIENT_ASSERTION_TYPE);
  body.append('client_assertion', assertion);
  body.append('login_hint', loginHint);
  body.append('binding_message', bindingMessage || 'Approval required');
  body.append('scope', finalScope);
  if (audience) body.append('audience', audience);

  const res = await fetch(`${issuer}/bc-authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`bc-authorize ${res.status}: ${text}`);
  }
  const data = JSON.parse(text);
  return { auth_req_id: data.auth_req_id, expires_in: data.expires_in, interval: data.interval };
}

// Poll the CIBA token endpoint once. Returns a normalized state.
async function pollToken({ auth_req_id }) {
  const { issuer, clientId, assertion } = commonClientAuthFields();
  const body = new URLSearchParams();
  body.append('grant_type', CIBA_GRANT);
  body.append('auth_req_id', auth_req_id);
  body.append('client_id', clientId);
  body.append('client_assertion_type', CLIENT_ASSERTION_TYPE);
  body.append('client_assertion', assertion);

  const res = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));

  if (res.ok && data.access_token) {
    return { state: 'approved', access_token: data.access_token, scope: data.scope, raw: data };
  }
  switch (data.error) {
    case 'authorization_pending': return { state: 'pending' };
    case 'slow_down':              return { state: 'slow_down' };
    case 'access_denied':          return { state: 'rejected' };
    case 'expired_token':          return { state: 'expired' };
    default:                       return { state: 'error', detail: data, http: res.status };
  }
}

// High-level: kick off CIBA and run the polling loop in the background.
// onResult is called once with the final outcome. Timeline events fire along the way.
async function startCibaApproval({ managerUserId, bindingMessage, scope, audience, bookingId, onResult }) {
  let ack;
  try {
    ack = await bcAuthorize({ managerUserId, bindingMessage, scope, audience });
  } catch (e) {
    events.emitTimeline({
      kind: 'ciba.error',
      label: 'CIBA initiate failed',
      http: 'POST /bc-authorize',
      body: { manager: managerUserId, error: e.message },
      decision: 'failed',
    });
    onResult({ status: 'error', detail: e.message });
    return null;
  }

  events.emitTimeline({
    kind: 'ciba.bc_authorize',
    label: 'CIBA: backchannel auth initiated',
    http: 'POST /bc-authorize',
    body: {
      manager: managerUserId,
      binding_message: bindingMessage,
      scope,
      auth_req_id: ack.auth_req_id,
      expires_in: ack.expires_in,
      interval: ack.interval,
    },
    decision: 'sent',
  });

  // Background polling loop.
  let intervalMs = (ack.interval || 5) * 1000;
  const deadline = Date.now() + (ack.expires_in || 120) * 1000;
  let polls = 0;

  const tick = async () => {
    if (Date.now() > deadline) {
      events.emitTimeline({ kind: 'ciba.expired', label: 'CIBA: deadline reached', body: { bookingId, auth_req_id: ack.auth_req_id, polls } });
      onResult({ status: 'expired', auth_req_id: ack.auth_req_id, polls });
      return;
    }
    polls++;
    let r;
    try { r = await pollToken({ auth_req_id: ack.auth_req_id }); }
    catch (e) {
      events.emitTimeline({ kind: 'ciba.error', label: 'CIBA poll error', body: { error: e.message } });
      onResult({ status: 'error', detail: e.message, auth_req_id: ack.auth_req_id });
      return;
    }

    if (r.state === 'pending') {
      setTimeout(tick, intervalMs);
    } else if (r.state === 'slow_down') {
      intervalMs += 5000;
      setTimeout(tick, intervalMs);
    } else if (r.state === 'approved') {
      events.emitTimeline({ kind: 'ciba.approved', label: 'CIBA: approved by manager', body: { bookingId, auth_req_id: ack.auth_req_id, polls, scope: r.scope } });
      onResult({ status: 'approved', access_token: r.access_token, scope: r.scope, auth_req_id: ack.auth_req_id, polls });
    } else if (r.state === 'rejected') {
      events.emitTimeline({ kind: 'ciba.rejected', label: 'CIBA: rejected by manager', body: { bookingId, auth_req_id: ack.auth_req_id, polls } });
      onResult({ status: 'rejected', auth_req_id: ack.auth_req_id, polls });
    } else if (r.state === 'expired') {
      events.emitTimeline({ kind: 'ciba.expired', label: 'CIBA: auth_req_id expired', body: { bookingId, auth_req_id: ack.auth_req_id, polls } });
      onResult({ status: 'expired', auth_req_id: ack.auth_req_id, polls });
    } else {
      events.emitTimeline({ kind: 'ciba.error', label: 'CIBA: unexpected response', body: { bookingId, auth_req_id: ack.auth_req_id, detail: r.detail, http: r.http } });
      onResult({ status: 'error', detail: r.detail, auth_req_id: ack.auth_req_id });
    }
  };

  setTimeout(tick, intervalMs);
  return { auth_req_id: ack.auth_req_id, expires_in: ack.expires_in, interval: ack.interval };
}

module.exports = { startCibaApproval, bcAuthorize, pollToken };
