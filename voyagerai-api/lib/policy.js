// Pure function: maps a booking request + the calling JWT's claims to one of:
//   { tier: 1, decision: 'allow' }                       — instant
//   { tier: 2, decision: 'requires_stepup' }             — Auth0 step-up MFA needed
//   { tier: 3, decision: 'requires_ciba' }               — Manager Guardian push
//   { tier: 3, decision: 'bounded_authority_exceeded' }  — even with manager approval, blocked
//
// Bounded authority is a custom claim the Login Action injects:
//   "https://voyagerai.demo/max_trip_value": <usd>
// It's the per-trip cap *enforced by Auth0/the API* — the manager can't override it.
// That is the demo punchline for Tier 3.

const BOUNDED_AUTHORITY_CLAIM = 'https://voyagerai.demo/max_trip_value';
const AMR_CLAIM = 'https://voyagerai.demo/amr';

// Auth0 puts `amr` in the ID token by default, NOT the access token. A Login Action
// (`inject-bounded-authority`) mirrors event.authentication.methods into the custom
// claim above. We check the custom claim first, then fall back to standard `amr`
// for tenants where it happens to be in the access token already.
function readAuthMethods(jwtPayload) {
  const custom = jwtPayload?.[AMR_CLAIM];
  if (Array.isArray(custom) && custom.length) return custom;
  const standard = jwtPayload?.amr;
  if (Array.isArray(standard) && standard.length) return standard;
  return [];
}

function evaluate({ amountUSD, jwtPayload, cibaApproved = false }) {
  if (!Number.isFinite(amountUSD) || amountUSD <= 0) {
    return { tier: 0, decision: 'invalid', reason: 'amount must be a positive number' };
  }

  // Tier 1: ≤ $500
  if (amountUSD <= 500) {
    return { tier: 1, decision: 'allow', reason: 'tier1_under_500' };
  }

  // Tier 2: >$500 and ≤ $2000 — require recent MFA on this token
  if (amountUSD <= 2000) {
    const methods = readAuthMethods(jwtPayload);
    if (methods.includes('mfa')) {
      return { tier: 2, decision: 'allow', reason: 'mfa_satisfied', amr: methods };
    }
    return { tier: 2, decision: 'requires_stepup', reason: 'mfa_required', amr: methods };
  }

  // Tier 3: > $2000 — Manager CIBA approval AND bounded authority check
  if (!cibaApproved) {
    return { tier: 3, decision: 'requires_ciba', reason: 'manager_approval_required' };
  }

  // CIBA approved — now enforce the per-trip cap from the JWT
  const cap = Number(jwtPayload?.[BOUNDED_AUTHORITY_CLAIM]);
  if (Number.isFinite(cap) && amountUSD > cap) {
    return {
      tier: 3,
      decision: 'bounded_authority_exceeded',
      reason: `requested $${amountUSD} exceeds per-trip cap $${cap}`,
      bounded_authority: { max: cap, requested: amountUSD, allowed: false },
    };
  }

  return {
    tier: 3,
    decision: 'allow',
    reason: 'ciba_approved_within_cap',
    bounded_authority: { max: cap || null, requested: amountUSD, allowed: true },
  };
}

module.exports = { evaluate, BOUNDED_AUTHORITY_CLAIM };
