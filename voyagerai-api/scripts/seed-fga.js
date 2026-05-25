#!/usr/bin/env node
// Seed Auth0 FGA with the demo tuples. Idempotent — safe to re-run; tuples that
// already exist are silently skipped.
//
// Usage:
//   cd voyagerai-api && npm run seed-fga
//
// Requires the FGA_* env vars in .env (see docs/AUTH0-TENANT.md §9).

require('dotenv').config();

const { CredentialsMethod, OpenFgaClient } = require('@openfga/sdk');

const REQUIRED = ['FGA_API_URL', 'FGA_STORE_ID', 'FGA_CLIENT_ID', 'FGA_CLIENT_SECRET', 'FGA_API_AUDIENCE'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Missing env: ${missing.join(', ')}.\n  See docs/AUTH0-TENANT.md §9.`);
  process.exit(1);
}

const client = new OpenFgaClient({
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

const TUPLES = [
  // ── traveler — engineering cost center ──
  { user: 'user:traveler',        relation: 'member',      object: 'cost_center:engineering'   },
  { user: 'user:traveler',        relation: 'owner',       object: 'user_profile:traveler'     },
  { user: 'cost_center:engineering', relation: 'cost_center', object: 'user_profile:traveler'  },

  // ── peer-eng — same cost center as traveler (will be allowed by membership) ──
  { user: 'user:peer-eng',        relation: 'member',      object: 'cost_center:engineering'   },
  { user: 'user:peer-eng',        relation: 'owner',       object: 'user_profile:peer-eng'     },
  { user: 'cost_center:engineering', relation: 'cost_center', object: 'user_profile:peer-eng'  },

  // ── vp-engineering — different cost center (will be DENIED for traveler) ──
  { user: 'user:vp-engineering',  relation: 'owner',       object: 'user_profile:vp-engineering'         },
  { user: 'cost_center:executive', relation: 'cost_center', object: 'user_profile:vp-engineering'        },
  // (no member tuple for traveler in cost_center:executive — that's the demo punchline)
];

async function main() {
  console.log(`Seeding ${TUPLES.length} tuples to FGA store ${process.env.FGA_STORE_ID}…\n`);
  let added = 0, skipped = 0;
  for (const t of TUPLES) {
    try {
      await client.write({ writes: [t] });
      console.log(`  ✓ ${t.user} · ${t.relation} · ${t.object}`);
      added++;
    } catch (e) {
      // Auth0 FGA returns a specific error for duplicates we tolerate.
      const msg = e?.message || String(e);
      if (/already exist|write_failed_due_to_invalid_input/i.test(msg)) {
        console.log(`  • ${t.user} · ${t.relation} · ${t.object} (already exists)`);
        skipped++;
      } else {
        console.error(`  ✗ ${t.user} · ${t.relation} · ${t.object}`);
        throw e;
      }
    }
  }
  console.log(`\nDone — ${added} added, ${skipped} already existed.`);
  console.log('\nVerify with:');
  console.log(`  user:traveler        can_view user_profile:traveler         → expect ALLOWED`);
  console.log(`  user:traveler        can_view user_profile:peer-eng         → expect ALLOWED (same cost center)`);
  console.log(`  user:traveler        can_view user_profile:vp-engineering   → expect DENIED  (different cost center)`);
}

main().catch((e) => {
  console.error('\nSeed failed:', e.message);
  process.exit(1);
});
