import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { jwtDecode } from 'jwt-decode';
import { color, font, radius, space, shadow } from '../lib/tokens';

// Annotations shown next to specific claims when they appear in the payload.
// Helps a CISO read a JWT without needing the OIDC spec open.
const CLAIM_NOTES = {
  iss:   'Issuer (Auth0 tenant)',
  sub:   'User identity (resource owner)',
  aud:   'Audience — the API this token is for',
  azp:   'Authorized party (which app holds the token)',
  scope: 'OAuth scopes granted at login',
  amr:   'Authentication methods — present if user did MFA on this token',
  'https://voyagerai.demo/amr':            'Bounded-authority Action mirrored amr here (access tokens don\'t get amr by default)',
  'https://voyagerai.demo/max_trip_value': 'Per-trip cap enforced server-side, even after manager CIBA approval',
  iat:   'Issued at',
  exp:   'Expires at',
  jti:   'Unique token id',
};

const ALL_TOOLS = [
  { name: 'get_profile',  scope: 'read:profile'  },
  { name: 'get_trips',    scope: 'read:trips'    },
  { name: 'get_expenses', scope: 'read:expenses' },
  { name: 'book_travel',  scope: 'book:travel'   },
  { name: 'approve_travel', scope: 'approve:travel' },
];

export default function TokenInspector() {
  const { getAccessTokenSilently } = useAuth0();
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try { setToken(await getAccessTokenSilently()); }
      catch (e) { setError(e.message); }
    })();
  }, [getAccessTokenSilently]);

  if (error) return <ErrorPane error={error} />;
  if (!token) return <Loading />;

  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header  = decodeJWTSegment(headerB64);
  const payload = decodeJWTSegment(payloadB64);

  const scopes = (payload.scope || '').split(' ').filter(Boolean);
  const cap = payload['https://voyagerai.demo/max_trip_value'];
  const summary = cap ? `Broad scopes + bounded authority ($${Number(cap).toLocaleString()} max trip)` : 'Broad scopes';

  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text }}>
      <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>Agent Token Inspector</h1>
      <div style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
        Decode and compare JWT tokens across 1st-party and 3rd-party agents.
      </div>

      <div style={{ marginTop: space.xl, display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
        <Tab active>Travel Agent · 1st-party</Tab>
        <Tab disabled>Personal Assistant · 3rd-party (Phase 2B)</Tab>
        <Tab disabled>Tax Agent · 3rd-party (Phase 3)</Tab>
      </div>

      <div style={{
        marginTop: space.lg,
        padding: `${space.md} ${space.lg}`,
        background: color.surfaceAlt,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        fontSize: font.size.md,
        color: color.textDim,
        display: 'flex', alignItems: 'center', gap: space.md,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color.brand }} />
        {summary}
      </div>

      <div style={{ marginTop: space.lg, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space.lg }}>
        <Card title="Encoded JWT" subtitle="header.payload.signature">
          <div style={{
            fontFamily: font.mono, fontSize: font.size.xs, lineHeight: 1.55,
            wordBreak: 'break-all', color: color.text,
          }}>
            <span style={{ color: color.danger }}>{headerB64}</span>
            <span style={{ color: color.textMuted }}>.</span>
            <span style={{ color: color.brand }}>{payloadB64}</span>
            <span style={{ color: color.textMuted }}>.</span>
            <span style={{ color: color.warn }}>{sigB64}</span>
          </div>
          <Legend />
        </Card>
        <Card title="Decoded payload" subtitle="hover a claim for details">
          <div style={{ fontFamily: font.mono, fontSize: font.size.xs, lineHeight: 1.65 }}>
            {renderJsonWithAnnotations(payload)}
          </div>
        </Card>
        <Card title="Decoded header">
          <pre style={{
            margin: 0, fontFamily: font.mono, fontSize: font.size.xs,
            color: color.textDim, lineHeight: 1.55,
          }}>{JSON.stringify(header, null, 2)}</pre>
        </Card>
        <Card title="MCP Tool Access" subtitle={`${ALL_TOOLS.filter(t => scopes.includes(t.scope)).length}/${ALL_TOOLS.length} tools`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            {ALL_TOOLS.map((t) => {
              const granted = scopes.includes(t.scope);
              return (
                <div key={t.name} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: `${space.xs} ${space.md}`,
                  borderRadius: radius.sm,
                  background: granted ? color.successBg : 'transparent',
                  border: `1px solid ${granted ? color.success + '55' : color.border}`,
                }}>
                  <span style={{ fontFamily: font.mono, fontSize: font.size.xs, color: granted ? color.text : color.textMuted }}>
                    {granted ? '✓' : '✗'} {t.name}
                  </span>
                  <span style={{ fontFamily: font.mono, fontSize: font.size.xs, color: color.textMuted }}>
                    {t.scope}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function decodeJWTSegment(b64) {
  try { return jwtDecode(`x.${b64}.x`); }
  catch (_) {
    // fallback for header (jwt-decode by default decodes payload only)
    try { return JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))); }
    catch (_) { return {}; }
  }
}

function renderJsonWithAnnotations(obj, indent = 0) {
  const entries = Object.entries(obj);
  return (
    <div style={{ paddingLeft: indent ? space.lg : 0 }}>
      <span style={{ color: color.textMuted }}>{'{'}</span>
      {entries.map(([key, value], i) => {
        const note = CLAIM_NOTES[key];
        const isObj = value && typeof value === 'object' && !Array.isArray(value);
        return (
          <div key={key} style={{ paddingLeft: space.lg, position: 'relative' }} title={note || ''}>
            <span style={{ color: color.brandHi }}>"{key}"</span>
            <span style={{ color: color.textMuted }}>: </span>
            {isObj
              ? renderJsonWithAnnotations(value, indent + 1)
              : <span style={{ color: typeof value === 'string' ? color.success : color.warn }}>
                  {JSON.stringify(value)}
                </span>}
            {i < entries.length - 1 && <span style={{ color: color.textMuted }}>,</span>}
            {note && (
              <span style={{
                marginLeft: space.md, padding: '1px 8px', borderRadius: radius.pill,
                fontSize: '10px', color: color.textMuted, background: color.surfaceAlt,
                border: `1px solid ${color.border}`, fontFamily: font.family,
              }}>{note}</span>
            )}
          </div>
        );
      })}
      <span style={{ color: color.textMuted }}>{'}'}</span>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <section style={{
      background: color.surface, border: `1px solid ${color.border}`,
      borderRadius: radius.lg, padding: space.lg, boxShadow: shadow.card,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.md }}>
        <h3 style={{ margin: 0, fontSize: font.size.body, fontWeight: font.weight.semibold }}>{title}</h3>
        {subtitle && <span style={{ fontSize: font.size.xs, color: color.textMuted }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function Tab({ children, active, disabled }) {
  return (
    <span style={{
      padding: `${space.sm} ${space.lg}`, borderRadius: radius.md,
      background: active ? color.brand + '22' : 'transparent',
      border: `1px solid ${active ? color.brand : color.border}`,
      color: active ? color.brandHi : disabled ? color.textMuted : color.textDim,
      fontSize: font.size.md,
      fontWeight: active ? font.weight.semibold : font.weight.normal,
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}>{children}</span>
  );
}

function Legend() {
  return (
    <div style={{
      marginTop: space.md, paddingTop: space.md, borderTop: `1px dashed ${color.border}`,
      display: 'flex', gap: space.lg, fontSize: font.size.xs,
    }}>
      <Dot color={color.danger} label="Header" />
      <Dot color={color.brand} label="Payload" />
      <Dot color={color.warn} label="Signature" />
    </div>
  );
}

function Dot({ color: c, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: color.textMuted }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />{label}
    </span>
  );
}

function Loading() {
  return (
    <div style={{ padding: space.xxl, color: color.textMuted, fontFamily: font.family }}>
      Loading token…
    </div>
  );
}

function ErrorPane({ error }) {
  return (
    <div style={{ padding: space.xxl, fontFamily: font.family }}>
      <div style={{
        padding: space.lg, background: color.dangerBg, color: color.danger,
        borderRadius: radius.md, fontSize: font.size.md,
      }}>Couldn't load token: {error}</div>
    </div>
  );
}
