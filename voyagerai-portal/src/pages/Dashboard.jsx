import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space, shadow } from '../lib/tokens';
import { apiFetch } from '../lib/api';

export default function Dashboard() {
  const { user, getAccessTokenSilently } = useAuth0();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessTokenSilently();
        const data = await apiFetch('/api/me', { token });
        setMe(data);
      } catch (e) { setError(e.message); }
    })();
  }, [getAccessTokenSilently]);

  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text }}>
      <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>
        Welcome, {user?.name || user?.email || 'Traveler'}
      </h1>
      <div style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
        VoyagerAI account · sub <code style={{ fontFamily: font.mono }}>{user?.sub || '—'}</code>
      </div>

      {error && (
        <div style={{ marginTop: space.lg, padding: space.lg, background: color.dangerBg, color: color.danger, borderRadius: radius.md }}>
          API error: {error}
        </div>
      )}

      <div style={{ marginTop: space.xl, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: space.lg }}>
        <Stat label="Per-trip cap" value={me?.max_trip_value ? `$${me.max_trip_value.toLocaleString()}` : '—'} hint="Bounded authority claim" />
        <Stat label="MFA"           value={(me?.amr || []).includes('mfa') ? 'Active' : 'Not in token'} hint="amr claim" tone={(me?.amr || []).includes('mfa') ? 'success' : 'warn'} />
        <Stat label="Scopes"        value={(me?.scopes || []).length} hint="From access token" />
        <Stat label="API"           value={me ? 'Connected' : '…'} hint={me?.aud || ''} tone={me ? 'success' : 'info'} />
      </div>

      <Card title="Granted scopes" style={{ marginTop: space.xl }}>
        {(me?.scopes || []).length === 0 ? (
          <span style={{ color: color.textMuted }}>none</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
            {me.scopes.map((s) => (
              <span key={s} style={{
                padding: '4px 10px', borderRadius: radius.pill, fontFamily: font.mono,
                fontSize: font.size.xs, background: color.successBg, color: color.success,
                border: `1px solid ${color.success}33`,
              }}>{s}</span>
            ))}
          </div>
        )}
      </Card>

      <Card title="What to try" style={{ marginTop: space.xl }}>
        <ol style={{ margin: 0, paddingLeft: space.xl, lineHeight: 1.7, color: color.textDim }}>
          <li>Open <strong style={{ color: color.text }}>MCP Server</strong> to watch live OAuth events as the agent works.</li>
          <li>Open <strong style={{ color: color.text }}>AI Assistant</strong> and ask: <em>"Book a flight to Mexico City for $400."</em> (Tier 1, instant)</li>
          <li>Then: <em>"Book a flight to Tokyo for $1,800."</em> (Tier 2, step-up MFA)</li>
          <li>Then: <em>"Book a hotel in Singapore for $4,500."</em> (Tier 3, manager approval via Guardian push)</li>
          <li>Then: <em>"Book a round-the-world trip for $8,000."</em> (Tier 3 + bounded authority — manager approves but it's still blocked)</li>
        </ol>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint, tone = 'info' }) {
  const tint = { success: color.success, warn: color.warn, info: color.info, danger: color.danger }[tone];
  return (
    <div style={{
      background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.lg,
      padding: space.lg, boxShadow: shadow.card,
    }}>
      <div style={{ fontSize: font.size.xs, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: tint, marginTop: space.xs }}>{value}</div>
      <div style={{ fontSize: font.size.xs, color: color.textMuted, marginTop: space.xs }}>{hint}</div>
    </div>
  );
}

function Card({ title, children, style }) {
  return (
    <section style={{
      background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.lg,
      padding: space.xl, ...style,
    }}>
      <h2 style={{ margin: 0, marginBottom: space.lg, fontSize: font.size.lg, fontWeight: font.weight.semibold }}>{title}</h2>
      {children}
    </section>
  );
}
