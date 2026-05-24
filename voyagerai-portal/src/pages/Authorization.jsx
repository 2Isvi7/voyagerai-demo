import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space, shadow } from '../lib/tokens';
import { apiFetch } from '../lib/api';

export default function Authorization() {
  const { user, getAccessTokenSilently } = useAuth0();
  const [me, setMe]   = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessTokenSilently();
        const data  = await apiFetch('/api/me', { token });
        setMe(data);
      } catch (e) { setError(e.message); }
    })();
  }, [getAccessTokenSilently]);

  if (error) return <Pane><Banner tone="danger">Couldn't load: {error}</Banner></Pane>;
  if (!me)   return <Pane><div style={{ color: color.textMuted }}>Loading…</div></Pane>;

  const scopes = me.scopes || [];
  const amr    = me.amr    || [];
  const cap    = me.max_trip_value;
  const isManager = scopes.includes('approve:travel');
  const isTraveler = scopes.includes('book:travel');
  const mfaActive = amr.includes('mfa');

  return (
    <Pane>
      <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>Authorization</h1>
      <div style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
        Effective permissions for the signed-in user, sourced from the access token.
      </div>

      {/* Identity */}
      <Card title="Identity" style={{ marginTop: space.xl }}>
        <Row label="Name"     value={user?.name || user?.email || '—'} />
        <Row label="Email"    value={user?.email || '—'} />
        <Row label="User ID"  value={me.sub} mono />
        <Row label="Issuer"   value={me.iss} mono dim />
        <Row label="Audience" value={me.aud} mono dim />
      </Card>

      {/* Roles */}
      <Card title="Roles" style={{ marginTop: space.xl }} subtitle="Inferred from scopes in the access token">
        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          <RoleBadge active={isTraveler} label="Traveler" desc="Can book travel up to the per-trip cap" />
          <RoleBadge active={isManager}  label="Manager"  desc="Can approve Tier 3 travel via CIBA" tone="warn" />
        </div>
      </Card>

      {/* Scopes */}
      <Card title="Scopes granted" style={{ marginTop: space.xl }} subtitle="OAuth scopes in the current access token">
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
          {ALL_SCOPES.map((s) => {
            const granted = scopes.includes(s.name);
            return (
              <div key={s.name} style={{
                display: 'grid', gridTemplateColumns: '24px 220px 1fr',
                gap: space.md, alignItems: 'center',
                padding: `${space.sm} ${space.md}`,
                borderRadius: radius.sm,
                background: granted ? color.successBg : 'transparent',
                border: `1px solid ${granted ? color.success + '55' : color.border}`,
              }}>
                <span style={{ color: granted ? color.success : color.textMuted, fontSize: font.size.lg, textAlign: 'center' }}>
                  {granted ? '✓' : '✗'}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: font.size.xs, color: granted ? color.text : color.textMuted }}>
                  {s.name}
                </span>
                <span style={{ fontSize: font.size.md, color: color.textDim }}>{s.desc}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Active policies */}
      <Card title="Travel-booking policy applied to you" style={{ marginTop: space.xl }} subtitle="3-tier authorization enforced server-side on book_travel">
        <Tier
          band="Tier 1" range="≤ $500" tone="success"
          requires="None — instant."
          appliesToYou={isTraveler}
          why="You have book:travel"
        />
        <Tier
          band="Tier 2" range="$500–$2,000" tone="warn"
          requires={mfaActive ? `Step-up MFA — already done (amr: ${amr.join(', ')})` : 'Step-up MFA — not yet on this token'}
          appliesToYou={isTraveler}
          why={mfaActive ? 'amr contains "mfa"' : 'amr does not contain "mfa"'}
        />
        <Tier
          band="Tier 3" range="> $2,000" tone="info"
          requires="Manager CIBA approval, polled by the agent."
          appliesToYou={isTraveler}
          why="approve:travel held by Manager role"
        />
        <Tier
          band="Bounded authority cap" range={cap ? `> $${cap.toLocaleString()}` : 'unconfigured'} tone="danger"
          requires={cap ? 'Always blocks — even after manager CIBA approval.' : 'No cap configured (Action did not run).'}
          appliesToYou={!!cap}
          why={cap ? `Custom claim: https://voyagerai.demo/max_trip_value = $${cap.toLocaleString()}` : '—'}
        />
      </Card>

      {/* Session */}
      <Card title="Active session" style={{ marginTop: space.xl }} subtitle="Authentication context on the current access token">
        <Row label="Authentication methods (amr)" value={amr.length ? amr.join(', ') : '(none yet — will populate on login or step-up)'} />
        <Row label="MFA active" value={mfaActive ? '✓ Yes' : '✗ Not on this token'} tone={mfaActive ? 'success' : 'warn'} />
        <Row label="Per-trip cap"     value={cap ? `$${cap.toLocaleString()}` : '—'} tone="info" />
      </Card>
    </Pane>
  );
}

const ALL_SCOPES = [
  { name: 'openid',         desc: 'Sign-in identity.' },
  { name: 'profile',        desc: 'Standard profile claims (name, picture).' },
  { name: 'email',          desc: 'Email address.' },
  { name: 'offline_access', desc: 'Refresh tokens are issued.' },
  { name: 'read:profile',   desc: 'AI agent can read your VoyagerAI profile.' },
  { name: 'read:trips',     desc: 'AI agent can list your trips.' },
  { name: 'read:expenses',  desc: 'AI agent can list your expenses.' },
  { name: 'book:travel',    desc: 'AI agent can book travel on your behalf — gated by the 3-tier policy.' },
  { name: 'approve:travel', desc: 'Manager scope — can approve Tier 3 bookings via CIBA.' },
];

// ── subcomponents ────────────────────────────────────────────────────────────

function Pane({ children }) {
  return <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text }}>{children}</div>;
}

function Card({ title, subtitle, style, children }) {
  return (
    <section style={{
      background: color.surface, border: `1px solid ${color.border}`,
      borderRadius: radius.lg, padding: space.xl, boxShadow: shadow.card, ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.lg }}>
        <h2 style={{ margin: 0, fontSize: font.size.lg, fontWeight: font.weight.semibold }}>{title}</h2>
        {subtitle && <span style={{ fontSize: font.size.xs, color: color.textMuted }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, mono, dim, tone }) {
  const tint = { success: color.success, warn: color.warn, info: color.info, danger: color.danger }[tone];
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '6px 0', borderBottom: `1px solid ${color.border}`,
    }}>
      <span style={{ fontSize: font.size.xs, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{
        fontSize: font.size.md,
        color: tint || (dim ? color.textDim : color.text),
        fontFamily: mono ? font.mono : 'inherit',
        textAlign: 'right',
      }}>{value}</span>
    </div>
  );
}

function RoleBadge({ active, label, desc, tone = 'success' }) {
  const tint = active ? { success: color.success, warn: color.warn }[tone] : color.textMuted;
  return (
    <div style={{
      flex: 1, minWidth: 240,
      padding: space.lg, borderRadius: radius.md,
      background: active ? `${tint}11` : color.surfaceAlt,
      border: `1px solid ${tint}55`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
        <span style={{
          width: 22, height: 22, borderRadius: '50%',
          background: active ? tint : color.surfaceAlt,
          color: '#fff', fontWeight: font.weight.bold,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: font.size.xs,
          border: active ? 'none' : `1px solid ${color.border}`,
        }}>{active ? '✓' : '–'}</span>
        <span style={{ fontWeight: font.weight.semibold, color: active ? color.text : color.textMuted, fontSize: font.size.body }}>{label}</span>
      </div>
      <div style={{ fontSize: font.size.md, color: color.textDim }}>{desc}</div>
    </div>
  );
}

function Tier({ band, range, tone, requires, appliesToYou, why }) {
  const tint = { success: color.success, warn: color.warn, info: color.info, danger: color.danger }[tone];
  return (
    <div style={{
      padding: `${space.md} ${space.lg}`,
      borderLeft: `3px solid ${appliesToYou ? tint : color.border}`,
      background: appliesToYou ? `${tint}08` : 'transparent',
      borderRadius: radius.sm,
      marginBottom: space.sm,
      display: 'grid', gridTemplateColumns: '180px 1fr', gap: space.md,
      alignItems: 'baseline',
    }}>
      <div>
        <div style={{ fontWeight: font.weight.semibold, color: appliesToYou ? tint : color.textMuted, fontSize: font.size.md }}>{band}</div>
        <div style={{ fontSize: font.size.xs, color: color.textMuted }}>{range}</div>
      </div>
      <div>
        <div style={{ color: appliesToYou ? color.text : color.textMuted, fontSize: font.size.md, lineHeight: 1.5 }}>{requires}</div>
        <div style={{ marginTop: 2, fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono }}>{why}</div>
      </div>
    </div>
  );
}

function Banner({ children, tone }) {
  const bg = { danger: color.dangerBg, warn: color.warnBg, info: color.infoBg, success: color.successBg }[tone] || color.surface;
  const fg = { danger: color.danger,   warn: color.warn,   info: color.info,   success: color.success   }[tone] || color.text;
  return <div style={{ padding: space.lg, background: bg, color: fg, borderRadius: radius.md, fontSize: font.size.md }}>{children}</div>;
}
