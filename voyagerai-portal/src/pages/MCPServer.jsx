import { useEffect, useState } from 'react';
import { color, font, radius, space, shadow } from '../lib/tokens';
import { apiBase } from '../lib/api';
import { useEventStream } from '../hooks/useEventStream';
import Assistant from './Assistant';
import {
  authorizePersonalAssistant,
  getPersonalAssistantToken,
  getPersonalAssistantUser,
  logoutPersonalAssistant,
} from '../lib/personalAssistant';

const TABS = [
  {
    id: 'first-party',
    label: 'Travel Agent',
    sub: '1st-party',
    tone: 'success',
    scopes: ['read:profile', 'read:trips', 'read:expenses', 'book:travel'],
  },
  {
    id: 'third-party',
    label: 'Personal AI Assistant',
    sub: '3rd-party',
    tone: 'info',
    scopes: ['read:trips', 'read:expenses'],
  },
];

// Personal Assistant has only read:trips + read:expenses. The first 3 prompts work,
// the 4th is the demo punchline — it triggers insufficient_scope on book_travel.
const PA_QUICK_PROMPTS = [
  {
    tier:    'Read trips',
    label:   'Upcoming trips',
    tone:    'success',
    range:   'read:trips',
    sub:     'list scope',
    prompt:  'Show me my upcoming trips.',
  },
  {
    tier:    'Read trips',
    label:   'YTD spend',
    tone:    'success',
    range:   'read:expenses',
    sub:     'aggregate scope',
    prompt:  'What is my year-to-date travel spend?',
  },
  {
    tier:    'Read expenses',
    label:   'Tokyo trip details',
    tone:    'info',
    range:   'read:expenses',
    sub:     'filter scope',
    prompt:  'Show me the expenses for my Tokyo trip.',
  },
  {
    tier:    'Boundary',
    label:   'Try to book ✗',
    tone:    'danger',
    range:   'book:travel',
    sub:     'denied — no scope',
    prompt:  'Book me a flight to Berlin for $400.',
  },
];

export default function MCPServer() {
  const { events: timeline, connected } = useEventStream(`${apiBase}/api/mcp/events`);
  const [activeTab, setActiveTab] = useState('first-party');
  const [paUser, setPaUser] = useState(null);          // Personal Assistant user (after consent)
  const [paStatus, setPaStatus] = useState('idle');    // idle | authorizing | authorized | error
  const [paError, setPaError] = useState(null);

  // On mount: hydrate Personal Assistant state if there's a cached session
  useEffect(() => {
    (async () => {
      const u = await getPersonalAssistantUser();
      if (u) { setPaUser(u); setPaStatus('authorized'); }
    })();
  }, []);

  const startConsent = async () => {
    setPaStatus('authorizing');
    setPaError(null);
    try {
      const u = await authorizePersonalAssistant();
      setPaUser(u);
      setPaStatus('authorized');
    } catch (e) {
      setPaError(e.message);
      setPaStatus('error');
    }
  };

  const revoke = async () => {
    await logoutPersonalAssistant();
    setPaUser(null);
    setPaStatus('idle');
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      fontFamily: font.family, color: color.text,
    }}>
      <Header connected={connected} />

      <Tabs activeTab={activeTab} onChange={setActiveTab} paStatus={paStatus} />

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        flex: 1, minHeight: 0,
        borderTop: `1px solid ${color.border}`, overflow: 'hidden',
      }}>
        <div style={{
          borderRight: `1px solid ${color.border}`, minWidth: 0,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {activeTab === 'first-party' && (
            <Assistant embedded />
          )}
          {activeTab === 'third-party' && paStatus === 'authorized' && (
            <Assistant
              key="3p" /* fresh state on switch */
              embedded
              tokenProvider={getPersonalAssistantToken}
              agentLabel={`Personal AI Assistant · 3rd-party · ${paUser?.email || paUser?.name || 'authorized'}`}
              quickPrompts={PA_QUICK_PROMPTS}
            />
          )}
          {activeTab === 'third-party' && paStatus !== 'authorized' && (
            <ConsentInvite status={paStatus} error={paError} onAuthorize={startConsent} />
          )}
        </div>
        <div style={{
          minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            padding: `${space.md} ${space.lg}`,
            borderBottom: `1px solid ${color.border}`,
            fontWeight: font.weight.semibold, fontSize: font.size.body,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <span>Event Timeline</span>
            <span style={{ fontSize: font.size.xs, color: connected ? color.success : color.textMuted }}>
              {connected ? '● live' : '● disconnected'}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.md }}>
            {timeline.length === 0 && (
              <div style={{ color: color.textMuted, fontSize: font.size.md, padding: space.xl, textAlign: 'center' }}>
                Ask the assistant something. OAuth events stream here in real-time.
              </div>
            )}
            {timeline.map((evt, i) => <TimelineEvent key={`${evt.ts}-${i}`} evt={evt} />)}
          </div>
        </div>
      </div>

      {paStatus === 'authorized' && (
        <PaSessionBar user={paUser} onRevoke={revoke} />
      )}
    </div>
  );
}

// ─── subcomponents ───────────────────────────────────────────────────────────

function Header({ connected }) {
  return (
    <header style={{ padding: `${space.lg} ${space.xl}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: font.size.xl, fontWeight: font.weight.bold }}>MCP Server</h1>
        <div style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
          Agents connect inbound from DCR to tool calls, secured by Auth0.
        </div>
      </div>
    </header>
  );
}

function Tabs({ activeTab, onChange, paStatus }) {
  const tone = (t) => ({ success: color.success, info: color.info, warn: color.warn, danger: color.danger }[t]);
  return (
    <div style={{
      padding: `0 ${space.xl} 0`,
      display: 'flex', gap: space.sm, alignItems: 'center', flexShrink: 0,
    }}>
      {TABS.map((t) => {
        const active = t.id === activeTab;
        const tint = tone(t.tone);
        const indicator =
          t.id === 'third-party' && paStatus === 'authorized' ? '●' :
          t.id === 'third-party' && paStatus === 'authorizing' ? '…' :
          t.id === 'third-party' ? '○' : '●';
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              padding: `${space.sm} ${space.lg}`,
              borderRadius: `${radius.md} ${radius.md} 0 0`,
              border: `1px solid ${active ? tint : color.border}`,
              borderBottom: active ? `1px solid ${color.bg}` : `1px solid ${color.border}`,
              background: active ? color.surfaceHi : 'transparent',
              color: active ? color.text : color.textDim,
              fontSize: font.size.md, fontFamily: font.family,
              fontWeight: active ? font.weight.semibold : font.weight.normal,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: space.sm,
              position: 'relative', top: 1,
            }}
          >
            <span style={{ color: tint }}>{indicator}</span>
            <span>{t.label}</span>
            <span style={{
              padding: '1px 8px', borderRadius: radius.pill, fontSize: font.size.xs,
              background: `${tint}22`, color: tint, fontWeight: font.weight.semibold,
            }}>{t.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

function ConsentInvite({ status, error, onAuthorize }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: space.xxl,
    }}>
      <div style={{
        maxWidth: 520, padding: space.xxl,
        background: color.surface, border: `1px solid ${color.border}`,
        borderRadius: radius.lg, boxShadow: shadow.card, textAlign: 'center',
      }}>
        <div style={{
          width: 56, height: 56, margin: `0 auto ${space.lg}`,
          borderRadius: radius.md,
          background: `${color.info}22`, border: `1px solid ${color.info}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: color.info, fontSize: '28px', fontWeight: font.weight.bold,
        }}>P</div>
        <h2 style={{ margin: 0, fontSize: font.size.xl, fontWeight: font.weight.bold }}>
          Authorize Personal AI Assistant
        </h2>
        <p style={{ marginTop: space.md, color: color.textDim, fontSize: font.size.md, lineHeight: 1.6 }}>
          A separate, third-party app is requesting <strong>read-only</strong> delegated access
          to your VoyagerAI account. Auth0 will show you a consent screen with the exact scopes
          before issuing a token.
        </p>
        <div style={{
          marginTop: space.lg, padding: space.md,
          background: color.surfaceAlt, border: `1px solid ${color.border}`,
          borderRadius: radius.md, textAlign: 'left',
          fontFamily: font.mono, fontSize: font.size.xs, color: color.textDim,
          lineHeight: 1.7,
        }}>
          requested scopes:
          <br />  ✓ read:trips
          <br />  ✓ read:expenses
          <br />  ✗ book:travel <span style={{ color: color.danger }}>(deliberately excluded)</span>
        </div>
        {error && (
          <div style={{
            marginTop: space.lg, padding: space.md,
            background: color.dangerBg, color: color.danger,
            borderRadius: radius.md, fontSize: font.size.md,
          }}>{error}</div>
        )}
        <button
          type="button"
          onClick={onAuthorize}
          disabled={status === 'authorizing'}
          style={{
            marginTop: space.xl, padding: `${space.md} ${space.xl}`,
            background: color.brand, color: '#fff', border: 0,
            borderRadius: radius.md, fontSize: font.size.body,
            fontWeight: font.weight.semibold, cursor: status === 'authorizing' ? 'wait' : 'pointer',
            fontFamily: font.family,
          }}
        >
          {status === 'authorizing' ? 'Opening Auth0 consent…' : 'Authorize via Auth0 →'}
        </button>
        <p style={{ marginTop: space.md, color: color.textMuted, fontSize: font.size.xs, fontStyle: 'italic' }}>
          A popup will open against your Auth0 tenant. You'll see the consent screen and can approve or deny.
        </p>
      </div>
    </div>
  );
}

function PaSessionBar({ user, onRevoke }) {
  return (
    <div style={{
      flexShrink: 0,
      padding: `${space.sm} ${space.xl}`,
      background: color.surfaceAlt,
      borderTop: `1px solid ${color.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: font.size.xs,
    }}>
      <span style={{ color: color.textMuted }}>
        Personal AI Assistant authorized for{' '}
        <span style={{ color: color.text }}>{user?.email || user?.name || 'demo user'}</span>
      </span>
      <button
        type="button"
        onClick={onRevoke}
        style={{
          padding: '4px 12px', background: 'transparent',
          color: color.textDim, border: `1px solid ${color.border}`,
          borderRadius: radius.pill, fontSize: font.size.xs,
          cursor: 'pointer', fontFamily: font.family,
        }}
      >Revoke local session</button>
    </div>
  );
}

function TimelineEvent({ evt }) {
  const cfg = kindStyle(evt.kind);
  const ts = (evt.ts || '').slice(11, 19);
  return (
    <div style={{
      background: color.surface,
      border: `1px solid ${color.border}`,
      borderLeft: `3px solid ${cfg.color}`,
      borderRadius: radius.md,
      padding: space.md,
      marginBottom: space.sm,
      fontSize: font.size.md,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
        <span style={{
          padding: '1px 8px', borderRadius: radius.pill, fontSize: font.size.xs,
          background: `${cfg.color}22`, color: cfg.color, fontWeight: font.weight.semibold,
        }}>{cfg.label}</span>
        <span style={{ fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono }}>{ts}</span>
        <span style={{ fontWeight: font.weight.semibold, color: color.text, marginLeft: space.xs }}>{evt.label || evt.kind}</span>
      </div>
      {evt.http && (
        <div style={{ fontSize: font.size.xs, color: color.textDim, fontFamily: font.mono, marginBottom: space.xs }}>{evt.http}</div>
      )}
      {evt.body && (
        <pre style={{
          margin: 0, padding: space.sm, background: color.bg, color: color.textDim,
          fontSize: font.size.xs, fontFamily: font.mono, borderRadius: radius.sm,
          overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{JSON.stringify(evt.body, null, 2)}</pre>
      )}
    </div>
  );
}

function kindStyle(kind = '') {
  if (kind.startsWith('oauth'))    return { label: 'OAUTH',  color: color.chipPost };
  if (kind.startsWith('mcp'))      return { label: 'MCP',    color: color.brand };
  if (kind.startsWith('policy'))   return { label: 'POLICY', color: color.warn };
  if (kind.startsWith('ciba.appr'))return { label: 'CIBA',   color: color.success };
  if (kind.startsWith('ciba.rej')) return { label: 'CIBA',   color: color.danger };
  if (kind.startsWith('ciba'))     return { label: 'CIBA',   color: color.info };
  if (kind.includes('error'))      return { label: 'ERROR',  color: color.danger };
  return { label: kind.toUpperCase(), color: color.textMuted };
}
