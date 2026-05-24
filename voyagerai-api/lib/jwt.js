// Sign a `client_assertion` JWT for OAuth private_key_jwt (RFC 7521 §4.2).
// The agent's M2M app authenticates with this every time it calls /bc-authorize
// or /oauth/token (CIBA polling). Same key, two endpoints.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedKey = null;

function loadAgentPrivateKey() {
  if (cachedKey) return cachedKey;

  const file = process.env.AUTH0_AGENT_PRIVATE_KEY_FILE;
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    cachedKey = fs.readFileSync(abs, 'utf8');
    return cachedKey;
  }

  const inline = process.env.AUTH0_AGENT_PRIVATE_KEY || '';
  if (!inline) {
    throw new Error(
      'No agent private key configured. Set AUTH0_AGENT_PRIVATE_KEY_FILE (recommended) ' +
      'or AUTH0_AGENT_PRIVATE_KEY in voyagerai-api/.env. See docs §3.'
    );
  }
  cachedKey = inline.replace(/\\n/g, '\n');
  return cachedKey;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Build a fresh client_assertion JWT. Every call returns a NEW JWT (new jti, fresh iat/exp).
function buildClientAssertion({ issuer, clientId }) {
  if (!clientId) throw new Error('clientId required');
  if (!issuer)   throw new Error('issuer required');

  const header = { alg: 'RS256', typ: 'JWT' };
  if (process.env.AUTH0_AGENT_KEY_ID) header.kid = process.env.AUTH0_AGENT_KEY_ID;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: issuer.endsWith('/') ? issuer : issuer + '/',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 120, // 2 min validity is plenty for a single OAuth call
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), loadAgentPrivateKey()).toString('base64url');
  return `${signingInput}.${sig}`;
}

module.exports = { buildClientAssertion, loadAgentPrivateKey };
