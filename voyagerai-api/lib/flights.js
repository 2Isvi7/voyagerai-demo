// Mock flight catalog. Each destination ships 3 cabin options whose prices
// straddle the policy tiers (Tier 1 ≤ $500, Tier 2 ≤ $2000, Tier 3 > $2000),
// so the demo presenter can pick any tier from a single search by clicking the
// matching card — no need to type prices and no risk of LLM price hallucination.
//
// `search` is deterministic per input so the demo replays identically across runs.
// `findById` is what `book_travel({ flight_id })` uses to look up the canonical
// price + destination — the tool ignores `amountUSD` from args when a flight_id
// is supplied so the LLM cannot influence the charged amount.

// Static seed table. Tier hints align with lib/policy.js thresholds. Add more
// destinations as needed; keep three cabins each so the tier coverage stays.
const CATALOG = {
  'mexico city': [
    { airline: 'Aeroméxico', cabin: 'Economy',         price_usd: 420,  layovers: 0, duration_h: 4.5 },
    { airline: 'Aeroméxico', cabin: 'Premium Economy', price_usd: 1450, layovers: 0, duration_h: 4.5 },
    { airline: 'Aeroméxico', cabin: 'Business',        price_usd: 3200, layovers: 0, duration_h: 4.5 },
  ],
  'tokyo': [
    { airline: 'ANA',        cabin: 'Economy',         price_usd: 850,  layovers: 1, duration_h: 14 },
    { airline: 'ANA',        cabin: 'Premium Economy', price_usd: 1850, layovers: 1, duration_h: 14 },
    { airline: 'ANA',        cabin: 'Business',        price_usd: 5400, layovers: 0, duration_h: 12 },
  ],
  'singapore': [
    { airline: 'Singapore Airlines', cabin: 'Economy',         price_usd: 980,  layovers: 1, duration_h: 22 },
    { airline: 'Singapore Airlines', cabin: 'Premium Economy', price_usd: 1950, layovers: 1, duration_h: 22 },
    { airline: 'Singapore Airlines', cabin: 'Business',        price_usd: 4500, layovers: 0, duration_h: 19 },
  ],
  'berlin': [
    { airline: 'Lufthansa', cabin: 'Economy',         price_usd: 620,  layovers: 1, duration_h: 11 },
    { airline: 'Lufthansa', cabin: 'Premium Economy', price_usd: 1450, layovers: 1, duration_h: 11 },
    { airline: 'Lufthansa', cabin: 'Business',        price_usd: 3700, layovers: 0, duration_h: 10 },
  ],
  'london': [
    { airline: 'British Airways', cabin: 'Economy',         price_usd: 540,  layovers: 0, duration_h: 7 },
    { airline: 'British Airways', cabin: 'Premium Economy', price_usd: 1500, layovers: 0, duration_h: 7 },
    { airline: 'British Airways', cabin: 'Business',        price_usd: 4200, layovers: 0, duration_h: 7 },
  ],
  'paris': [
    { airline: 'Air France',  cabin: 'Economy',         price_usd: 580,  layovers: 0, duration_h: 8 },
    { airline: 'Air France',  cabin: 'Premium Economy', price_usd: 1620, layovers: 0, duration_h: 8 },
    { airline: 'Air France',  cabin: 'Business',        price_usd: 4400, layovers: 0, duration_h: 8 },
  ],
  'são paulo': [
    { airline: 'LATAM',       cabin: 'Economy',         price_usd: 720,  layovers: 1, duration_h: 9 },
    { airline: 'LATAM',       cabin: 'Premium Economy', price_usd: 1700, layovers: 1, duration_h: 9 },
    { airline: 'LATAM',       cabin: 'Business',        price_usd: 3900, layovers: 0, duration_h: 9 },
  ],
  // RTW intentionally lands above max_trip_value so the bounded-authority
  // demo (Tier 3 + cap) still works from a flight click.
  'round-the-world': [
    { airline: 'OneWorld RTW', cabin: 'Economy',         price_usd: 4900, layovers: 6, duration_h: 90 },
    { airline: 'OneWorld RTW', cabin: 'Premium Economy', price_usd: 7200, layovers: 6, duration_h: 90 },
    { airline: 'OneWorld RTW', cabin: 'Business',        price_usd: 9800, layovers: 6, duration_h: 90 },
  ],
};

// In-memory id store. Built lazily from CATALOG so ids stay stable per process.
const FLIGHTS_BY_ID = {};
(function build() {
  Object.entries(CATALOG).forEach(([dest, options]) => {
    options.forEach((opt, i) => {
      const id = makeId(dest, opt.cabin);
      FLIGHTS_BY_ID[id] = {
        id,
        destination: titleCase(dest),
        destination_slug: dest,
        ...opt,
        // Synthetic schedule the portal can render. Keep it simple: tomorrow at 09:00.
        departure: '09:00 AM',
        arrival:   '— ' + opt.duration_h + 'h flight',
      };
    });
  });
})();

function makeId(dest, cabin) {
  const slug = dest.replace(/[^a-z]/gi, '').slice(0, 6).toUpperCase();
  const cab  = cabin.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  return `FL-${slug}-${cab}`;
}

function titleCase(s) {
  return s.split(/[\s-]+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Search by destination string. Loose match so "Mexico City", "mexico city", "CDMX"
// all resolve. Returns { destination, flights[] }. Throws if nothing matches.
function search({ destination }) {
  const q = (destination || '').toLowerCase().trim();
  if (!q) throw new Error('destination is required');

  // Synonym table for demo. Keep small and obvious; the LLM gets the slug list in
  // the tool description so it has a hint about valid destinations.
  const SYNONYMS = {
    cdmx: 'mexico city',
    'mexico df': 'mexico city',
    df: 'mexico city',
    rtw: 'round-the-world',
    'around-the-world': 'round-the-world',
    'sao paulo': 'são paulo',
    saopaulo: 'são paulo',
  };

  const slug = SYNONYMS[q] || q;
  const options = CATALOG[slug];
  if (!options) {
    const err = new Error(`No flights for "${destination}". Demo destinations: ${Object.keys(CATALOG).join(', ')}.`);
    err.code = 'unknown_destination';
    throw err;
  }
  const flights = options.map((o) => FLIGHTS_BY_ID[makeId(slug, o.cabin)]);
  return { destination: titleCase(slug), flights };
}

function findById(id) {
  return FLIGHTS_BY_ID[id] || null;
}

module.exports = { search, findById, CATALOG, FLIGHTS_BY_ID };
