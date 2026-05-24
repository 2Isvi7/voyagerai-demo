import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { color, font, radius, space, shadow } from '../lib/tokens';

export default function Landing() {
  const { isAuthenticated, loginWithRedirect } = useAuth0();
  const navigate = useNavigate();

  const goToDashboard = () => {
    if (isAuthenticated) navigate('/dashboard');
    else loginWithRedirect({ appState: { returnTo: '/dashboard' } });
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          `radial-gradient(900px 600px at 80% -10%, ${color.brand}22, transparent 60%),` +
          `radial-gradient(900px 600px at -10% 90%, ${color.accent}1A, transparent 60%),` +
          color.bg,
        color: color.text,
        fontFamily: font.family,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Header onCta={goToDashboard} />
      <main
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: `${space.xxl} ${space.xl}`,
        }}
      >
        <div style={{ maxWidth: 760, textAlign: 'center' }}>
          <Pill>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color.success }} />
            Secured by Auth0 for AI Agents
          </Pill>
          <h1
            style={{
              fontSize: '64px',
              lineHeight: 1.05,
              margin: `${space.lg} 0 ${space.md}`,
              fontWeight: font.weight.bold,
              letterSpacing: '-0.02em',
            }}
          >
            AI-Powered<br />
            <span
              style={{
                background: `linear-gradient(90deg, ${color.brandHi}, ${color.accent}, ${color.warn})`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              Travel Management
            </span>
          </h1>
          <p
            style={{
              color: color.textDim,
              fontSize: font.size.lg,
              lineHeight: 1.55,
              maxWidth: 600,
              margin: '0 auto',
            }}
          >
            VoyagerAI combines intelligent travel agents with enterprise-grade authorization.
            Your AI agent can book trips, file expenses, and update your calendar — all within
            secure, scoped, and auditable boundaries.
          </p>

          <div style={{ display: 'flex', gap: space.md, justifyContent: 'center', marginTop: space.xxl }}>
            <button onClick={goToDashboard} style={ctaPrimary}>
              Open Dashboard →
            </button>
            <a href="#story" style={ctaSecondary}>Learn More</a>
          </div>

          <div
            id="story"
            style={{
              marginTop: '120px',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: space.lg,
              textAlign: 'left',
            }}
          >
            <Tile
              title="The agent acts as me, with limits."
              desc="Step-up MFA + bounded authority + manager approval via Auth0 CIBA. Your agent can never exceed the rules you set."
            />
            <Tile
              title="The agent only sees what I see."
              desc="Fine-Grained Authorization (FGA) and 3rd-party consent ensure agents inherit — never expand — your permissions."
            />
            <Tile
              title="The agent never holds my password."
              desc="Token Vault stores credentials for Google, Slack, and more. Revoke access in one place — anytime."
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function Header({ onCta }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${space.lg} ${space.xl}`,
        borderBottom: `1px solid ${color.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.md,
            background: `linear-gradient(135deg, ${color.brand}, ${color.accent})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: font.weight.bold,
            fontSize: font.size.lg,
          }}
        >
          V
        </div>
        <span style={{ fontWeight: font.weight.semibold, fontSize: font.size.body }}>VoyagerAI</span>
      </div>
      <button onClick={onCta} style={ctaPrimary}>Go to Dashboard →</button>
    </header>
  );
}

function Pill({ children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space.sm,
        padding: `${space.xs} ${space.md}`,
        borderRadius: radius.pill,
        border: `1px solid ${color.border}`,
        color: color.textDim,
        fontSize: font.size.sm,
        background: color.surface,
      }}
    >
      {children}
    </span>
  );
}

function Tile({ title, desc }) {
  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding: space.xl,
        boxShadow: shadow.card,
      }}
    >
      <h3 style={{ margin: 0, fontSize: font.size.lg, fontWeight: font.weight.semibold }}>{title}</h3>
      <p style={{ marginTop: space.md, color: color.textDim, fontSize: font.size.body, lineHeight: 1.55 }}>{desc}</p>
    </div>
  );
}

const ctaPrimary = {
  background: color.brand,
  color: '#fff',
  border: 0,
  borderRadius: radius.md,
  padding: '10px 18px',
  fontSize: font.size.body,
  fontWeight: font.weight.semibold,
  cursor: 'pointer',
  boxShadow: shadow.card,
};

const ctaSecondary = {
  background: 'transparent',
  color: color.text,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: '10px 18px',
  fontSize: font.size.body,
  fontWeight: font.weight.medium,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
};
