// Auth0 FGA wrapper. Lazy-init so the rest of the API keeps working when FGA isn't
// configured yet (the new get_user_trips tool returns a clear error pointing to docs).
//
// Authorization model — see docs/AUTH0-TENANT.md §9:
//
//   model
//     schema 1.1
//
//   type user
//
//   type cost_center
//     relations
//       define member: [user]
//
//   type user_profile
//     relations
//       define owner: [user]
//       define cost_center: [cost_center]
//       define can_view: owner or member from cost_center
//
// Demo tuples (seeded by scripts/seed-fga.js):
//   user:traveler        owner       user_profile:traveler
//   cost_center:eng      cost_center user_profile:traveler
//   user:traveler        member      cost_center:eng
//
//   user:vp-engineering  owner       user_profile:vp-engineering
//   cost_center:exec     cost_center user_profile:vp-engineering
//
// Result: traveler can_view user_profile:traveler  → ALLOWED (owner)
//         traveler can_view user_profile:vp-engineering → DENIED (different cost center)

const events = require('./events');

let cached = null;
const REQUIRED = ['FGA_API_URL', 'FGA_STORE_ID', 'FGA_CLIENT_ID', 'FGA_CLIENT_SECRET', 'FGA_API_AUDIENCE'];

function isConfigured() {
  return REQUIRED.every((k) => !!process.env[k]);
}

function buildClient() {
  // require lazily so missing dep doesn't crash the API at boot before user installs
  const { CredentialsMethod, OpenFgaClient } = require('@openfga/sdk');
  return new OpenFgaClient({
    apiUrl:  process.env.FGA_API_URL,
    storeId: process.env.FGA_STORE_ID,
    credentials: {
      method: CredentialsMethod.ClientCredentials,
      config: {
        clientId:        process.env.FGA_CLIENT_ID,
        clientSecret:    process.env.FGA_CLIENT_SECRET,
        apiTokenIssuer:  process.env.FGA_API_TOKEN_ISSUER || 'auth.fga.dev',
        apiAudience:     process.env.FGA_API_AUDIENCE,
      },
    },
  });
}

function getClient() {
  if (cached) return cached;
  if (!isConfigured()) {
    const err = new Error(
      'FGA not configured. Set the FGA_* env vars in voyagerai-api/.env. ' +
      'See docs/AUTH0-TENANT.md §9.'
    );
    err.code = 'FGA_NOT_CONFIGURED';
    throw err;
  }
  cached = buildClient();
  return cached;
}

// Check a single tuple. Emits a `fga.check` timeline event with the decision so the
// MCP Server panel shows it live. Returns { allowed, user, relation, object }.
async function check({ user, relation, object }) {
  const client = getClient();
  let result;
  try {
    result = await client.check({ user, relation, object });
  } catch (e) {
    events.emitTimeline({
      kind:  'fga.error',
      label: 'FGA check failed',
      http:  'POST /stores/:id/check',
      body:  { user, relation, object, error: e.message },
      decision: 'failed',
    });
    throw e;
  }
  const allowed = !!result.allowed;
  events.emitTimeline({
    kind:  'fga.check',
    label: `FGA: ${user} ${relation} ${object} → ${allowed ? 'allowed' : 'denied'}`,
    http:  'POST /stores/:id/check',
    body:  { tuple_key: { user, relation, object }, allowed },
    decision: allowed ? 'allowed' : 'denied',
  });
  return { allowed, user, relation, object };
}

module.exports = { check, isConfigured, getClient };
