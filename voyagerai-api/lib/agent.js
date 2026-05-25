// Agent loop: OpenAI SDK function-calling against the user's JWT.
// Streams text chunks via the per-session SSE; emits a parallel global timeline of
// every OAuth/policy event so the MCP Server page can show it live.

const OpenAI = require('openai');
const policy = require('./policy');
const ciba   = require('./ciba');
const events = require('./events');
const audit  = require('./audit');
const fga    = require('./fga');
const tokenvault = require('./tokenvault');
const flights = require('./flights');

const openai = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

const AGENT_MODEL = process.env.AGENT_MODEL || 'gpt-4o-mini';

// ─── Mock data — keyed by user sub for the demo ──────────────────────────────
// Real life: replace with DB / FGA-checked queries.

function mockTripsFor(userSub) {
  return [
    { id: 'TRP-001', destination: 'Mexico City',  start: '2026-06-12', end: '2026-06-15', amountUSD: 420,  status: 'confirmed', owner: userSub },
    { id: 'TRP-002', destination: 'Tokyo',        start: '2026-07-01', end: '2026-07-08', amountUSD: 1850, status: 'confirmed', owner: userSub },
    { id: 'TRP-003', destination: 'Berlin',       start: '2026-08-22', end: '2026-08-26', amountUSD: 1100, status: 'pending',   owner: userSub },
  ];
}

// Demo user_profile slugs. Maps the LLM-friendly targetUserId arg to FGA object IDs
// and mock trip data. The FGA tuples seeded by scripts/seed-fga.js use these slugs.
const DEMO_USER_PROFILES = {
  traveler: {
    slug: 'traveler',
    label: 'You (Traveler)',
    cost_center: 'engineering',
    trips: [
      { id: 'TRP-T01', destination: 'Mexico City', amountUSD: 420,  start: '2026-06-12', status: 'confirmed' },
      { id: 'TRP-T02', destination: 'Tokyo',       amountUSD: 1850, start: '2026-07-01', status: 'confirmed' },
    ],
  },
  'peer-eng': {
    slug: 'peer-eng',
    label: 'Lara Martinez · Engineering',
    cost_center: 'engineering',
    trips: [
      { id: 'TRP-P01', destination: 'Madrid',  amountUSD: 1300, start: '2026-09-04', status: 'confirmed' },
      { id: 'TRP-P02', destination: 'Toronto', amountUSD: 850,  start: '2026-10-18', status: 'pending' },
    ],
  },
  'vp-engineering': {
    slug: 'vp-engineering',
    label: 'VP of Engineering · Executive cost center',
    cost_center: 'executive',
    trips: [
      { id: 'TRP-V01', destination: 'Davos',     amountUSD: 12_400, start: '2027-01-21', status: 'confirmed' },
      { id: 'TRP-V02', destination: 'Singapore', amountUSD: 9_200,  start: '2026-11-05', status: 'confirmed' },
    ],
  },
};

// The current logged-in user maps to user:traveler in the FGA store. In real life
// the JWT sub would map to a profile via DB lookup.
function callerFgaUser(/* userSub */) {
  return 'user:traveler';
}

function mockExpensesFor(userSub) {
  return [
    { id: 'EXP-101', tripId: 'TRP-001', category: 'flight',  amountUSD: 280, date: '2026-06-12', owner: userSub },
    { id: 'EXP-102', tripId: 'TRP-001', category: 'hotel',   amountUSD: 140, date: '2026-06-13', owner: userSub },
    { id: 'EXP-103', tripId: 'TRP-002', category: 'flight',  amountUSD: 1450, date: '2026-07-01', owner: userSub },
    { id: 'EXP-104', tripId: 'TRP-002', category: 'hotel',   amountUSD: 400, date: '2026-07-02', owner: userSub },
  ];
}

// ─── Pending bookings (Tier 3 in flight) ─────────────────────────────────────
const PENDING_BOOKINGS = {}; // { bookingId: { destination, amountUSD, type, dates, agentSub, userSub, status, auth_req_id, decidedAt } }

function getBooking(id) { return PENDING_BOOKINGS[id]; }

// Called by lib/ciba.js when the CIBA polling loop reaches a final state.
// Updates booking + pushes status SSE so the portal's waiting card transitions.
//
// IMPORTANT: when the user clicks "Resend", a new CIBA flow starts and the booking's
// auth_req_id is replaced. The OLD polling loop is still running and may fire its
// onResult later (with stale auth_req_id). We ignore those — only the latest
// auth_req_id can transition the booking.
function onCibaResult(bookingId, result) {
  const b = PENDING_BOOKINGS[bookingId];
  if (!b) return;
  if (b.status !== 'pending') return; // already finalized
  if (result.auth_req_id && b.auth_req_id && b.auth_req_id !== result.auth_req_id) {
    console.log(`[ciba] ignoring stale result for ${bookingId}: got ${result.auth_req_id.slice(0,8)}…, current ${b.auth_req_id.slice(0,8)}…`);
    return;
  }
  b.status = result.status;             // 'approved' | 'rejected' | 'expired' | 'error'
  b.manager_access_token = result.access_token || null;
  b.ciba_polls = result.polls || null;
  b.decidedAt = new Date().toISOString();
  events.pushBooking(bookingId, { type: 'status', status: b.status, bookingId, polls: result.polls });
}

// Resend the CIBA push. Used when Guardian gets stuck and the manager doesn't see
// the original notification. Starts a NEW CIBA flow with the same parameters; the
// old polling loop continues but its result will be ignored (stale auth_req_id).
async function resendCiba(bookingId) {
  const b = PENDING_BOOKINGS[bookingId];
  if (!b) return { error: 'unknown_booking' };
  if (b.status !== 'pending') return { error: 'not_pending', status: b.status };

  events.emitTimeline({
    kind: 'ciba.resend',
    label: `CIBA: resending push (attempt ${(b.resend_count || 0) + 2})`,
    body: { bookingId, previous_auth_req_id: b.auth_req_id },
  });

  const ack = await ciba.startCibaApproval({
    managerUserId: process.env.AUTH0_MANAGER_USER_ID,
    bindingMessage: `Approve ${b.type} to ${b.destination} for USD ${Number(b.amountUSD).toLocaleString('en-US')}`,
    scope: 'approve:travel',
    audience: process.env.AUDIENCE,
    bookingId,
    onResult: (result) => onCibaResult(bookingId, result),
  });

  if (ack) {
    b.auth_req_id = ack.auth_req_id;
    b.resend_count = (b.resend_count || 0) + 1;
    return { ok: true, auth_req_id: ack.auth_req_id, resend_count: b.resend_count };
  }
  return { error: 'ciba_start_failed' };
}

// ─── Tool schema (OpenAI function-calling format) ────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_profile',
      description: 'Return the signed-in user profile (sub, email, name, roles).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_trips',
      description: 'List the signed-in user\'s trips.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_trips',
      description:
        'List trips for ANOTHER user. Authorization is enforced by Auth0 FGA — the API checks ' +
        '`user:<caller> can_view user_profile:<targetUserId>` and returns the trips only if ' +
        'allowed. Use this when the user asks for trips of a coworker, manager, or a specific name. ' +
        'Demo targets: "traveler" (yourself), "peer-eng" (Lara, same cost center as you), ' +
        '"vp-engineering" (the VP of Engineering — different cost center).',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: {
            type: 'string',
            enum: ['traveler', 'peer-eng', 'vp-engineering'],
            description: 'Slug of the target user_profile.',
          },
        },
        required: ['targetUserId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expenses',
      description: 'List the signed-in user\'s expenses, optionally filtered by tripId.',
      parameters: {
        type: 'object',
        properties: { tripId: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_flights',
      description:
        "Search the corporate-travel catalog for flight options to a destination. " +
        'Returns 3 cabin options (Economy / Premium Economy / Business) per destination, ' +
        'each with a real price the user can pick from. ALWAYS call this before book_travel ' +
        'when the user mentions a destination without a specific price — let the user choose ' +
        'a cabin from the cards rather than guessing a price.',
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            description: 'Destination city. Demo destinations: Mexico City, Tokyo, Singapore, Berlin, London, Paris, São Paulo, round-the-world.',
          },
        },
        required: ['destination'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_trip_to_vault',
      description:
        "Save a confirmed trip to VoyagerVault — the user's secured trip-notes service. " +
        'Auth0 Token Vault brokers a short-lived, audience-scoped token at the moment of ' +
        'need; the agent never holds a static credential for VoyagerVault. Call this after ' +
        'a successful booking, or when the user explicitly asks to save a trip note.',
      parameters: {
        type: 'object',
        properties: {
          summary:     { type: 'string', description: 'Short title (e.g. "Trip to Mexico City · June 12")' },
          destination: { type: 'string', description: 'Destination city' },
          dates:       { type: 'string', description: 'Human-readable date range, e.g. "2026-06-12 to 2026-06-15"' },
          notes:       { type: 'string', description: 'Optional notes (itinerary highlights, hotel, etc.)' },
        },
        required: ['summary', 'destination', 'dates'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_travel',
      description:
        'Book a trip on the user\'s behalf. PREFER passing flight_id from a prior search_flights ' +
        'result — that way the canonical price/destination from the catalog is used (the API ' +
        'ignores any amountUSD you pass when flight_id is supplied). Authorization is enforced ' +
        'server-side via 3 tiers: ≤ $500 instant; ≤ $2000 requires step-up MFA; > $2000 requires ' +
        'Manager CIBA approval AND must stay within the user\'s per-trip authority cap.',
      parameters: {
        type: 'object',
        properties: {
          flight_id:   { type: 'string', description: 'ID from a search_flights result (e.g. "FL-TOKYO-BUS"). When set, destination/amountUSD/type are derived from the catalog.' },
          destination: { type: 'string' },
          amountUSD:   { type: 'number', description: 'Total trip cost in USD. Ignored if flight_id is set.' },
          type:        { type: 'string', enum: ['flight', 'hotel', 'package'] },
          dates:       { type: 'string', description: 'e.g. "2026-09-12 to 2026-09-15"' },
        },
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM = `You are an AI assistant for VoyagerAI, an internal corporate travel platform. Be brief and businesslike.

You have access to tools for getting profile/trips/expenses and booking travel. CALL TOOLS — don't ask the user for confirmation, the system enforces policy server-side.

When a tool returns an error, surface it plainly to the user:
- "insufficient_scope" → tell the user this assistant doesn't have permission for that action (state the scope it's missing).
- "requires_stepup" → tell the user the system is asking for MFA in their browser; then stop.
- "requires_ciba" → tell the user their manager has been notified for approval; then stop.
- "bounded_authority_exceeded" → explain that even with manager approval, the trip exceeds the per-trip cap (state the cap), and suggest splitting it.
- "fga_denied" → explain Auth0 FGA blocked the lookup because the user doesn't share an authorization relationship with that target. Mention the cost_center if available. Suggest the user ask the data owner directly.
- "allowed" → confirm the booking with destination and amount.
- "vault_grant_missing" → explain the Travel Agent isn't authorized for VoyagerVault yet (Auth0 setup pending). Point at docs §10.
- "tokenvault_not_configured" → explain VoyagerVault audience isn't configured on this demo; point at docs §10.
- "status: saved" (from save_trip_to_vault) → confirm "Saved to VoyagerVault." Mention Auth0 brokered a short-lived, scoped token at the moment of need — the agent never held a static credential. That's the Token Vault punchline.

When the user asks for "VP Engineering's trips", "Lara's trips", "my coworker's trips", call get_user_trips with the appropriate targetUserId.

When the user names a destination without a price (e.g. "book a flight to Tokyo"), CALL search_flights FIRST with that destination. Don't book yet — render the options as a tool result and let the user pick a cabin. The portal renders the options as clickable cards. ONLY call book_travel after a user picks an option (their next message will reference a flight_id like FL-TOKYO-BUS), and pass that flight_id — don't pass amountUSD when you have a flight_id.

After a successful Tier 1 booking, proactively offer "Want me to save this to VoyagerVault?" — but call save_trip_to_vault only after the user says yes. If the user explicitly asks to save a known trip, call it directly.

Never invent trips, expenses, flights, or money values that didn't come from a tool call.`;

// ─── Tool dispatch ───────────────────────────────────────────────────────────

async function runTool({ name, args, jwtPayload, userAccessToken, sessionId, agentSub, userSub }) {
  const userScopes = (jwtPayload?.scope || '').split(' ').filter(Boolean);

  events.emitTimeline({
    kind: 'mcp.tool_call',
    label: `Tool Call: ${name}`,
    http: `POST /api/mcp/tools/${name}`,
    body: { args, agent_sub: agentSub, user_sub: userSub, scopes: userScopes },
  });

  // Helper: tag every insufficient_scope response with enough context for the
  // portal to render a clear "Permission denied" card without an LLM round-trip.
  const denyScope = (toolName, required) => {
    audit.record({ agent_sub: agentSub, user_sub: userSub, tool: toolName, decision: 'denied', reason: 'insufficient_scope', scopes: userScopes });
    return {
      error: 'insufficient_scope',
      tool: toolName,
      required,
      held: userScopes,
    };
  };

  if (name === 'get_profile') {
    if (!userScopes.includes('read:profile')) return denyScope(name, 'read:profile');
    audit.record({ agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'allowed', reason: 'scope_satisfied', scopes: userScopes });
    return {
      sub:    jwtPayload.sub,
      email:  jwtPayload.email || jwtPayload.name || null,
      scopes: userScopes,
      max_trip_value: jwtPayload[policy.BOUNDED_AUTHORITY_CLAIM] ?? null,
      amr: jwtPayload['https://voyagerai.demo/amr'] || jwtPayload.amr || [],
    };
  }

  if (name === 'get_trips') {
    if (!userScopes.includes('read:trips')) return denyScope(name, 'read:trips');
    audit.record({ agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'allowed', reason: 'scope_satisfied', scopes: userScopes });
    return { trips: mockTripsFor(userSub) };
  }

  if (name === 'get_user_trips') {
    if (!userScopes.includes('read:trips')) return denyScope(name, 'read:trips');

    const targetSlug = args?.targetUserId;
    const target = DEMO_USER_PROFILES[targetSlug];
    if (!target) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'unknown_target', scopes: userScopes,
      });
      return { error: 'unknown_target', target: targetSlug, valid: Object.keys(DEMO_USER_PROFILES) };
    }

    if (!fga.isConfigured()) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'fga_not_configured', scopes: userScopes,
      });
      return {
        error: 'fga_not_configured',
        message:
          'Auth0 FGA is not configured on this server. Set FGA_API_URL, FGA_STORE_ID, ' +
          'FGA_CLIENT_ID, FGA_CLIENT_SECRET, FGA_API_AUDIENCE in voyagerai-api/.env. ' +
          'See docs/AUTH0-TENANT.md §9.',
      };
    }

    const fgaUser = callerFgaUser(userSub);
    const fgaObject = `user_profile:${target.slug}`;

    let fgaResult;
    try {
      fgaResult = await fga.check({ user: fgaUser, relation: 'can_view', object: fgaObject });
    } catch (e) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'fga_error', scopes: userScopes,
        fga: { user: fgaUser, relation: 'can_view', object: fgaObject, error: e.message },
      });
      return { error: 'fga_error', message: e.message };
    }

    if (!fgaResult.allowed) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'fga_denied', scopes: userScopes,
        fga: fgaResult,
      });
      return {
        error: 'fga_denied',
        target: target.slug,
        target_label: target.label,
        target_cost_center: target.cost_center,
        fga_check: { user: fgaUser, relation: 'can_view', object: fgaObject, allowed: false },
        message:
          `Auth0 FGA denied access. ${fgaUser} has no \`can_view\` relationship with ${fgaObject} ` +
          `(target's cost_center is "${target.cost_center}").`,
      };
    }

    audit.record({
      agent_sub: agentSub, user_sub: userSub, tool: name,
      decision: 'allowed', reason: 'fga_allowed', scopes: userScopes,
      fga: fgaResult,
    });
    return {
      target: target.slug,
      target_label: target.label,
      target_cost_center: target.cost_center,
      fga_check: { user: fgaUser, relation: 'can_view', object: fgaObject, allowed: true },
      trips: target.trips,
    };
  }

  if (name === 'get_expenses') {
    if (!userScopes.includes('read:expenses')) return denyScope(name, 'read:expenses');
    let exps = mockExpensesFor(userSub);
    if (args?.tripId) exps = exps.filter((e) => e.tripId === args.tripId);
    audit.record({ agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'allowed', reason: 'scope_satisfied', scopes: userScopes });
    return { expenses: exps };
  }

  if (name === 'save_trip_to_vault') {
    if (!userScopes.includes('book:travel')) return denyScope(name, 'book:travel');

    if (!tokenvault.isConfigured()) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'tokenvault_not_configured', scopes: userScopes,
      });
      return {
        error: 'tokenvault_not_configured',
        message:
          'Token Vault is not configured on this server. Set VOYAGERVAULT_AUDIENCE in ' +
          'voyagerai-api/.env and follow docs/AUTH0-TENANT.md §10.',
      };
    }

    const { summary, destination, dates, notes } = args || {};
    if (!summary || !destination || !dates) {
      return { error: 'invalid_request', message: 'summary, destination, dates are required' };
    }

    let stored;
    try {
      stored = await tokenvault.saveTripToVault({
        userAccessToken,
        payload: { summary, destination, dates, notes },
      });
    } catch (e) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: 'vault_failed', scopes: userScopes,
        error: { code: e.code, message: e.message },
      });
      return {
        error: e.code === 'unauthorized_client' || e.code === 'access_denied'
          ? 'vault_grant_missing'
          : 'vault_failed',
        code: e.code || null,
        message:
          e.code === 'unauthorized_client' || e.code === 'access_denied'
            ? 'The Travel Agent is not authorized for VoyagerVault. In Auth0 → APIs → VoyagerVault → Machine to Machine, grant the Travel Agent the write:vault and read:vault scopes.'
            : (e.message || 'Vault call failed'),
      };
    }

    audit.record({
      agent_sub: agentSub, user_sub: userSub, tool: name,
      decision: 'allowed', reason: 'vault_entry_created', scopes: userScopes,
      vault: { id: stored.id, owner_sub: stored.owner_sub },
    });

    return {
      status: 'saved',
      id: stored.id,
      summary: stored.summary,
      destination: stored.destination,
      dates: stored.dates,
      notes: stored.notes,
      ts: stored.ts,
    };
  }

  if (name === 'search_flights') {
    if (!userScopes.includes('read:trips')) return denyScope(name, 'read:trips');
    try {
      const result = flights.search({ destination: args?.destination });
      events.emitTimeline({
        kind:  'mcp.tool_result',
        label: `search_flights → ${result.flights.length} options for ${result.destination}`,
        body:  { destination: result.destination, count: result.flights.length },
      });
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'allowed', reason: 'catalog_hit', scopes: userScopes,
      });
      return result;
    } catch (e) {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name,
        decision: 'denied', reason: e.code || 'search_failed', scopes: userScopes,
      });
      return { error: e.code || 'search_failed', message: e.message };
    }
  }

  if (name === 'book_travel') {
    if (!userScopes.includes('book:travel')) return denyScope(name, 'book:travel');

    // If flight_id is set, the canonical price/destination/type come from the
    // catalog. This defends against the LLM passing a different amountUSD by
    // mistake (or by attack) — the server is the source of truth for prices.
    let amount, destination, tripType;
    if (args?.flight_id) {
      const f = flights.findById(args.flight_id);
      if (!f) {
        return { error: 'unknown_flight', flight_id: args.flight_id, message: `Flight ${args.flight_id} not in catalog. Search first.` };
      }
      amount      = f.price_usd;
      destination = f.destination;
      tripType    = 'flight';
    } else {
      amount      = Number(args?.amountUSD);
      destination = args?.destination;
      tripType    = args?.type;
      if (!destination || !Number.isFinite(amount) || !tripType) {
        return { error: 'invalid_request', message: 'Pass flight_id, or destination + amountUSD + type.' };
      }
    }

    const decision = policy.evaluate({ amountUSD: amount, jwtPayload });

    events.emitTimeline({
      kind: 'policy.evaluate',
      label: `Policy: Tier ${decision.tier} — ${decision.decision}`,
      body: { amountUSD: amount, ...decision },
    });

    if (decision.decision === 'allow') {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'allowed',
        reason: decision.reason, scopes: userScopes,
        bounded_authority: decision.bounded_authority || null,
      });
      return {
        status: 'allowed',
        booking_id: `TRP-${Date.now().toString(36).toUpperCase()}`,
        destination: destination,
        amountUSD: amount,
        type: tripType,
        tier: decision.tier,
      };
    }

    if (decision.decision === 'requires_stepup') {
      audit.record({ agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'denied', reason: 'mfa_required', scopes: userScopes });
      // Signal portal via session SSE; the LLM gets a structured tool result it can explain.
      events.pushSession(sessionId, { type: 'requires_stepup', amountUSD: amount, destination: destination });
      return { status: 'requires_stepup', amountUSD: amount, destination: destination };
    }

    if (decision.decision === 'requires_ciba') {
      const bookingId = `BK-${Date.now().toString(36).toUpperCase()}`;
      PENDING_BOOKINGS[bookingId] = {
        ...args, amountUSD: amount, agentSub, userSub,
        status: 'pending', createdAt: new Date().toISOString(),
      };

      // Kick off true CIBA. Polling happens in the background; onResult fires once.
      // Note: binding_message is sanitized in lib/ciba.js (Auth0 rejects $, ?, !, etc.).
      const ack = await ciba.startCibaApproval({
        managerUserId: process.env.AUTH0_MANAGER_USER_ID,
        bindingMessage: `Approve ${tripType} to ${destination} for USD ${amount.toLocaleString('en-US')}`,
        scope: 'approve:travel',
        audience: process.env.AUDIENCE,
        bookingId,
        onResult: (result) => onCibaResult(bookingId, result),
      });

      if (ack) PENDING_BOOKINGS[bookingId].auth_req_id = ack.auth_req_id;

      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'pending',
        reason: 'ciba_required', scopes: userScopes,
        ciba: { auth_req_id: ack?.auth_req_id || null, status: 'pending' },
      });

      events.pushSession(sessionId, {
        type: 'requires_ciba_approval',
        bookingId,
        amountUSD: amount,
        destination: destination,
        auth_req_id: ack?.auth_req_id || null,
        expires_in: ack?.expires_in || null,
      });

      return { status: 'requires_ciba', booking_id: bookingId, amountUSD: amount, destination: destination };
    }

    if (decision.decision === 'bounded_authority_exceeded') {
      audit.record({
        agent_sub: agentSub, user_sub: userSub, tool: name, decision: 'denied',
        reason: 'bounded_authority_exceeded', scopes: userScopes,
        bounded_authority: decision.bounded_authority,
      });
      return {
        status: 'bounded_authority_exceeded',
        amountUSD: amount,
        destination: destination,
        cap: decision.bounded_authority?.max,
        message: decision.reason,
      };
    }

    return { error: 'invalid_request', reason: decision.reason };
  }

  return { error: 'unknown_tool', name };
}

// Special path: when CIBA approval comes in, the portal calls /resume which re-runs
// book_travel with cibaApproved=true so bounded authority is checked.
async function resumeBookingAfterCiba({ bookingId, jwtPayload, agentSub, userSub, sessionId }) {
  const b = getBooking(bookingId);
  if (!b) return { error: 'unknown_booking' };
  if (b.status !== 'approved') return { error: 'not_approved', status: b.status };

  const decision = policy.evaluate({ amountUSD: b.amountUSD, jwtPayload, cibaApproved: true });
  events.emitTimeline({
    kind: 'policy.evaluate',
    label: `Policy (resume): Tier ${decision.tier} — ${decision.decision}`,
    body: { bookingId, amountUSD: b.amountUSD, ...decision },
  });

  if (decision.decision === 'allow') {
    audit.record({
      agent_sub: agentSub, user_sub: userSub, tool: 'book_travel', decision: 'allowed',
      reason: 'ciba_approved_within_cap',
      ciba: { auth_req_id: b.auth_req_id, status: 'approved' },
      bounded_authority: decision.bounded_authority,
    });
    return {
      status: 'allowed', booking_id: `TRP-${Date.now().toString(36).toUpperCase()}`,
      destination: b.destination, amountUSD: b.amountUSD, type: b.type, tier: 3,
    };
  }

  if (decision.decision === 'bounded_authority_exceeded') {
    audit.record({
      agent_sub: agentSub, user_sub: userSub, tool: 'book_travel', decision: 'denied',
      reason: 'bounded_authority_exceeded',
      ciba: { auth_req_id: b.auth_req_id, status: 'approved' },
      bounded_authority: decision.bounded_authority,
    });
    return {
      status: 'bounded_authority_exceeded',
      amountUSD: b.amountUSD,
      destination: b.destination,
      cap: decision.bounded_authority?.max,
      message: decision.reason,
    };
  }

  return { error: 'unexpected_decision', decision: decision.decision };
}

// ─── Streaming chat loop ─────────────────────────────────────────────────────

async function streamChat({ messages, jwtPayload, userAccessToken, sessionId, agentSub, userSub }) {
  // history = system + user-supplied messages
  const history = [{ role: 'system', content: SYSTEM }, ...messages];

  // Multi-turn until the model returns no tool call
  for (let turn = 0; turn < 6; turn++) {
    const stream = await openai.chat.completions.create({
      model: AGENT_MODEL,
      messages: history,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: true,
    });

    let assistantContent = '';
    const toolCalls = []; // { id, name, args }

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        assistantContent += delta.content;
        events.pushSession(sessionId, { type: 'chunk', text: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          toolCalls[idx] = toolCalls[idx] || { id: '', name: '', args: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }

    // Persist the assistant message in history (with tool calls if any)
    if (toolCalls.length === 0) {
      history.push({ role: 'assistant', content: assistantContent });
      events.pushSession(sessionId, { type: 'done' });
      return;
    }

    history.push({
      role: 'assistant',
      content: assistantContent || null,
      tool_calls: toolCalls.map((t) => ({
        id: t.id, type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });

    // Execute each tool, append role:'tool' messages, loop again.
    for (const tc of toolCalls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.args || '{}'); } catch (_) {}

      const result = await runTool({
        name: tc.name, args: parsedArgs,
        jwtPayload, userAccessToken, sessionId, agentSub, userSub,
      });

      events.pushSession(sessionId, { type: 'tool_result', name: tc.name, result });
      history.push({
        role: 'tool', tool_call_id: tc.id, name: tc.name,
        content: JSON.stringify(result),
      });
    }
  }

  events.pushSession(sessionId, { type: 'done', reason: 'max_turns' });
}

module.exports = { streamChat, resumeBookingAfterCiba, resendCiba, getBooking, onCibaResult };
