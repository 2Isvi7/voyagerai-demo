// Append-only audit log. Phase 1: in-memory. Phase 2: persist to disk + read for the
// Audit Trail UI. Keep the schema stable from day one so Phase 2 doesn't have to migrate.

const log = [];
const MAX = 500;

function record(evt) {
  const row = {
    ts: new Date().toISOString(),
    agent_sub: evt.agent_sub || null,        // who is acting (1st-party agent, 3rd-party agent)
    user_sub: evt.user_sub || null,          // on whose behalf
    tool: evt.tool || null,
    decision: evt.decision || null,          // 'allowed' | 'denied'
    reason: evt.reason || null,              // policy reason: 'tier1' | 'mfa_satisfied' | 'ciba_approved' | 'bounded_authority_exceeded' | 'insufficient_scope' | 'fga_denied'
    scopes: evt.scopes || null,
    fga: evt.fga || null,                    // { user, relation, object, allowed }
    ciba: evt.ciba || null,                  // { auth_req_id, status }
    bounded_authority: evt.bounded_authority || null, // { max, requested, allowed }
    metadata: evt.metadata || null,
  };
  log.unshift(row);
  if (log.length > MAX) log.length = MAX;
  return row;
}

function list({ agent, decision, tool, limit = 100 } = {}) {
  let out = log;
  if (agent)    out = out.filter((r) => r.agent_sub === agent);
  if (decision) out = out.filter((r) => r.decision === decision);
  if (tool)     out = out.filter((r) => r.tool === tool);
  return out.slice(0, limit);
}

module.exports = { record, list };
