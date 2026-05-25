import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space, shadow } from '../lib/tokens';
import { apiFetch, apiBase } from '../lib/api';

const MFA_ACR = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

// Default prompts (1st-party Travel Agent). The 3rd-party Personal AI Assistant tab
// passes its own list via the `quickPrompts` prop — see MCPServer.jsx.
const DEFAULT_QUICK_PROMPTS = [
  {
    tier:    'Tier 1',
    label:   'CDMX · $400',
    tone:    'success',
    range:   '≤ $500',
    sub:     'instant',
    prompt:  'Book a flight to Mexico City for $400.',
  },
  {
    tier:    'Tier 2',
    label:   'Tokyo · $1,800',
    tone:    'warn',
    range:   '$500–$2,000',
    sub:     'step-up MFA',
    prompt:  'Book a flight to Tokyo for $1,800.',
  },
  {
    tier:    'Tier 3',
    label:   'Singapore · $4,500',
    tone:    'info',
    range:   '> $2,000',
    sub:     'manager CIBA',
    prompt:  'Book a hotel in Singapore for $4,500.',
  },
  {
    tier:    'Tier 3 + cap',
    label:   'RTW · $8,000',
    tone:    'danger',
    range:   '> max_trip_value',
    sub:     'bounded authority blocks',
    prompt:  'Book a round-the-world trip for $8,000.',
  },
];

function uuid() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function Assistant({
  embedded = false,
  // Optional override: a function that returns a Promise<accessToken>. Defaults to the
  // 1st-party Auth0Provider token. The 3rd-party Personal AI Assistant tab passes its
  // own provider so requests carry that app's scope-restricted token.
  tokenProvider = null,
  agentLabel = 'VoyagerAI Travel Agent · 1st-party · acting as you',
  // Subtitle shown below the title in non-embedded mode.
  pageTitle = 'AI Assistant',
  // Quick-prompt buttons in the empty state and above the input. Defaults to the
  // 1st-party tier-based booking prompts.
  quickPrompts = DEFAULT_QUICK_PROMPTS,
}) {
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const getToken = tokenProvider || (() => getAccessTokenSilently());
  const [sessionId] = useState(uuid);
  const [messages, setMessages] = useState([]);     // [{role:'user'|'assistant', content, toolResults?: [...]}, ...]
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingBooking, setPendingBooking] = useState(null); // { bookingId, amountUSD, destination }
  const sseRef = useRef(null);
  const bookingSseRef = useRef(null);
  const messagesEndRef = useRef(null);
  // Latest messages mirrored into a ref so the SSE handler can read them WITHOUT
  // putting `messages` in the effect's deps (that re-opens the EventSource on every
  // keystroke and silently drops `done` events → input stays disabled forever).
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Connect the per-session SSE once. Deps are stable identifiers only.
  useEffect(() => {
    const url = `${apiBase}/api/agent/chat/stream/${sessionId}`;
    const es = new EventSource(url);
    sseRef.current = es;

    es.onmessage = (msg) => {
      let evt; try { evt = JSON.parse(msg.data); } catch (_) { return; }

      if (evt.type === 'chunk') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + evt.text }];
          }
          return [...prev, { role: 'assistant', content: evt.text, streaming: true }];
        });
      } else if (evt.type === 'tool_result') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const enriched = last && last.role === 'assistant'
            ? { ...last, toolResults: [...(last.toolResults || []), evt] }
            : null;
          if (enriched) return [...prev.slice(0, -1), enriched];
          return [...prev, { role: 'assistant', content: '', streaming: true, toolResults: [evt] }];
        });
      } else if (evt.type === 'requires_stepup') {
        const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user');
        sessionStorage.setItem('voyagerai.resume_prompt', lastUser?.content || '');
        loginWithRedirect({
          authorizationParams: { acr_values: MFA_ACR },
          appState: { returnTo: '/assistant' },
        });
      } else if (evt.type === 'requires_ciba_approval') {
        setPendingBooking({
          bookingId: evt.bookingId,
          amountUSD: evt.amountUSD,
          destination: evt.destination,
          authReqId: evt.auth_req_id,
          expiresIn: evt.expires_in,
          status: 'pending',
        });
      } else if (evt.type === 'done') {
        setStreaming(false);
        setMessages((prev) => prev.map((m) => ({ ...m, streaming: false })));
      } else if (evt.type === 'error') {
        setMessages((prev) => [...prev, { role: 'system', content: `Error: ${evt.message}` }]);
        setStreaming(false);
      }
    };

    return () => { es.close(); sseRef.current = null; };
  }, [sessionId, loginWithRedirect]);

  // After MFA redirect: resume the prompt that triggered the step-up.
  useEffect(() => {
    const resume = sessionStorage.getItem('voyagerai.resume_prompt');
    if (resume) {
      sessionStorage.removeItem('voyagerai.resume_prompt');
      // tiny delay so SSE is open
      setTimeout(() => send(resume), 250);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the booking status when a CIBA approval is in flight.
  useEffect(() => {
    if (!pendingBooking || pendingBooking.status !== 'pending') return undefined;
    const url = `${apiBase}/api/bookings/${pendingBooking.bookingId}/stream`;
    const es = new EventSource(url);
    bookingSseRef.current = es;
    es.onmessage = async (msg) => {
      let evt; try { evt = JSON.parse(msg.data); } catch (_) { return; }
      if (evt.type === 'status' && (evt.status === 'approved' || evt.status === 'rejected')) {
        setPendingBooking((prev) => (prev ? { ...prev, status: evt.status } : prev));
        es.close();
        if (evt.status === 'approved') {
          // Ask the API to finalize (re-evaluates bounded authority).
          // Use the cached access token — getAccessTokenSilently with no options
          // returns the cached token if not expired, falls back to refresh only if needed.
          try {
            const token = await getToken();
            await apiFetch('/api/agent/resume', {
              token, method: 'POST', body: { sessionId, bookingId: pendingBooking.bookingId },
            });
          } catch (e) {
            setMessages((prev) => [...prev, {
              role: 'system',
              content: `Resume failed: ${e.message}. ` +
                       `If this says "Missing Refresh Token", enable "Allow Offline Access" on the API in Auth0 ` +
                       `and sign out + back in.`,
            }]);
          }
        } else if (evt.status === 'rejected') {
          setMessages((prev) => [...prev, { role: 'system', content: 'Manager rejected the request.' }]);
        } else if (evt.status === 'expired') {
          setMessages((prev) => [...prev, { role: 'system', content: 'CIBA request timed out (manager did not respond).' }]);
        }
      }
    };
    return () => { es.close(); bookingSseRef.current = null; };
  }, [pendingBooking, sessionId, getAccessTokenSilently]);

  // Autoscroll to bottom on new messages
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = useCallback(async (text) => {
    if (!text.trim() || streaming) return;
    setStreaming(true);
    const newUser = { role: 'user', content: text };
    setMessages((prev) => [...prev, newUser]);
    setInput('');

    const history = [...messages, newUser]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const token = await getToken();
      await apiFetch('/api/agent/chat', { token, method: 'POST', body: { sessionId, messages: history } });
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'system', content: `Error: ${e.message}` }]);
      setStreaming(false);
    }
  }, [streaming, messages, getAccessTokenSilently, sessionId]);

  const onSubmit = (e) => { e.preventDefault(); send(input); };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: embedded ? '100%' : 'calc(100vh - 56px)',
      fontFamily: font.family,
    }}>
      {!embedded && (
        <header style={{ padding: `${space.lg} ${space.xxl} 0` }}>
          <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>{pageTitle}</h1>
          <p style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
            {agentLabel}
          </p>
        </header>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.xl, display: 'flex', flexDirection: 'column', gap: space.md }}>
        {messages.length === 0 && <Hint onPick={(p) => send(p)} disabled={streaming} prompts={quickPrompts} />}
        {messages.map((m, i) => <Bubble key={i} message={m} onPickFlight={(f) => send(`Book flight ${f.id} (${f.destination} · ${f.cabin} · $${f.price_usd.toLocaleString()}). Use flight_id="${f.id}".`)} />)}
        {pendingBooking?.status === 'pending' && (
          <CibaWaitingCard
            booking={pendingBooking}
            onResend={async () => {
              try {
                const token = await getToken();
                const r = await apiFetch(`/api/bookings/${pendingBooking.bookingId}/resend`, {
                  token, method: 'POST',
                });
                setPendingBooking((prev) => prev ? { ...prev, authReqId: r.auth_req_id, resendCount: r.resend_count } : prev);
              } catch (e) {
                // Most common cause: the API was restarted after the booking was created,
                // so PENDING_BOOKINGS[id] no longer exists. Tell the user how to recover.
                if (e.status === 400 && /unknown_booking/.test(e.body || '')) {
                  setPendingBooking(null);
                  setMessages((prev) => [...prev, {
                    role: 'system',
                    content: 'The pending booking is gone (the API was restarted). Pick a Tier 3 prompt above to start a fresh CIBA flow.',
                  }]);
                } else {
                  setMessages((prev) => [...prev, { role: 'system', content: `Resend failed: ${e.message}` }]);
                }
              }
            }}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      <QuickBar onPick={(p) => send(p)} disabled={streaming} prompts={quickPrompts} />

      <form onSubmit={onSubmit} style={{
        padding: `${space.md} ${space.xl} ${space.xl}`, borderTop: `1px solid ${color.border}`, background: color.surface,
        display: 'flex', gap: space.md, flexShrink: 0,
      }}>
        <input
          type="text" value={input} onChange={(e) => setInput(e.target.value)} disabled={streaming}
          placeholder='Type, or pick a quick prompt above ↑'
          style={{
            flex: 1, padding: `${space.md} ${space.lg}`, borderRadius: radius.md,
            border: `1px solid ${color.border}`, background: color.bg, color: color.text,
            fontSize: font.size.body, fontFamily: font.family, outline: 'none',
          }}
        />
        <button type="submit" disabled={streaming || !input.trim()} style={{
          padding: `${space.md} ${space.xl}`, borderRadius: radius.md, border: 0,
          background: streaming ? color.border : color.brand, color: '#fff',
          fontSize: font.size.body, fontWeight: font.weight.semibold,
          cursor: streaming ? 'not-allowed' : 'pointer',
        }}>{streaming ? '…' : 'Send'}</button>
      </form>
    </div>
  );
}

function QuickBar({ onPick, disabled, prompts = DEFAULT_QUICK_PROMPTS }) {
  const tone = (t) => ({ success: color.success, warn: color.warn, info: color.info, danger: color.danger }[t]);
  return (
    <div style={{
      padding: `${space.md} ${space.xl} 0`,
      background: color.surface,
      borderTop: `1px solid ${color.border}`,
      display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'center',
      flexShrink: 0,
    }}>
      <span style={{ fontSize: font.size.xs, color: color.textMuted, marginRight: space.sm, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Quick prompts</span>
      {prompts.map((q) => (
        <button
          key={q.tier}
          type="button"
          disabled={disabled}
          onClick={() => onPick(q.prompt)}
          title={q.prompt}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: space.sm,
            padding: '6px 12px', borderRadius: radius.pill,
            border: `1px solid ${tone(q.tone)}55`,
            background: `${tone(q.tone)}15`, color: tone(q.tone),
            fontSize: font.size.xs, fontWeight: font.weight.semibold,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            fontFamily: font.family,
          }}
        >
          <span style={{ fontWeight: font.weight.bold }}>{q.tier}</span>
          <span style={{ color: color.textDim, fontWeight: font.weight.normal }}>·</span>
          <span style={{ color: color.text }}>{q.label}</span>
        </button>
      ))}
    </div>
  );
}

function Hint({ onPick, disabled, prompts = DEFAULT_QUICK_PROMPTS }) {
  return (
    <div style={{
      padding: space.xl, color: color.textMuted, fontSize: font.size.md, lineHeight: 1.7,
      maxWidth: 760, margin: `${space.xl} auto 0`, textAlign: 'center',
    }}>
      <div style={{ marginBottom: space.lg }}>
        Try one of these — or type your own.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: space.md }}>
        {prompts.map((q, i) => <TierCard key={`${q.tier}-${i}`} q={q} onPick={onPick} disabled={disabled} />)}
      </div>
    </div>
  );
}

function TierCard({ q, onPick, disabled }) {
  const tint = { success: color.success, warn: color.warn, info: color.info, danger: color.danger }[q.tone];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(q.prompt)}
      style={{
        textAlign: 'left',
        padding: space.lg,
        borderRadius: radius.md,
        background: color.surface,
        border: `1px solid ${tint}55`,
        color: color.text,
        fontFamily: font.family,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'transform 100ms ease, border-color 100ms ease',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.xs }}>
        <span style={{ fontSize: font.size.xs, color: tint, fontWeight: font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{q.tier}</span>
        <span style={{ fontSize: font.size.xs, color: color.textMuted }}>{q.range}</span>
      </div>
      <div style={{ fontSize: font.size.body, color: color.text, fontWeight: font.weight.semibold, marginBottom: space.xs }}>
        {q.label}
      </div>
      <div style={{ fontSize: font.size.xs, color: color.textMuted, marginBottom: space.sm }}>
        {q.sub}
      </div>
      <div style={{ fontSize: font.size.xs, color: color.textDim, fontFamily: font.mono, lineHeight: 1.45 }}>
        "{q.prompt}"
      </div>
    </button>
  );
}

function Bubble({ message, onPickFlight }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '70%',
        padding: `${space.md} ${space.lg}`,
        borderRadius: radius.lg,
        background: isUser ? color.brand : isSystem ? color.dangerBg : color.surface,
        color: isUser ? '#fff' : isSystem ? color.danger : color.text,
        border: isUser ? 'none' : `1px solid ${color.border}`,
        fontSize: font.size.body, lineHeight: 1.55,
      }}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{message.content || (message.streaming ? '…' : '')}</div>
        {message.toolResults?.map((tr, i) => <ToolResultCard key={i} tr={tr} onPickFlight={onPickFlight} />)}
      </div>
    </div>
  );
}

function ToolResultCard({ tr, onPickFlight }) {
  const r = tr.result || {};
  if (tr.name === 'search_flights' && Array.isArray(r.flights)) {
    return <FlightOptionsCard destination={r.destination} flights={r.flights} onPick={onPickFlight} />;
  }
  // Booking confirmation
  if (tr.name === 'book_travel' && r.status === 'allowed') {
    return (
      <div style={{ marginTop: space.md, padding: space.md, background: color.successBg, color: color.success, border: `1px solid ${color.success}55`, borderRadius: radius.md, fontSize: font.size.md }}>
        ✓ Booked: {r.destination} · ${r.amountUSD?.toLocaleString()} · Tier {r.tier}
        {r.booking_id && <div style={{ fontSize: font.size.xs, marginTop: 2, opacity: 0.7, fontFamily: 'inherit' }}>Booking ID: {r.booking_id}</div>}
      </div>
    );
  }
  if (tr.name === 'book_travel' && r.status === 'bounded_authority_exceeded') {
    return (
      <div style={{ marginTop: space.md, padding: space.md, background: color.dangerBg, color: color.danger, border: `1px solid ${color.danger}55`, borderRadius: radius.md, fontSize: font.size.md }}>
        ✗ Blocked by bounded authority — requested ${r.amountUSD?.toLocaleString()}, cap ${r.cap?.toLocaleString()}
      </div>
    );
  }
  if (tr.name === 'book_travel' && r.status === 'requires_stepup') {
    return null; // the redirect will fire via 'requires_stepup' SSE event
  }
  if (tr.name === 'book_travel' && r.status === 'requires_ciba') {
    return null; // CibaWaitingCard renders below
  }
  if (r.error === 'insufficient_scope') {
    return <PermissionDeniedCard tool={r.tool} required={r.required} held={r.held} />;
  }
  if (r.error === 'fga_denied') {
    return <FgaDeniedCard result={r} />;
  }
  if (r.error === 'fga_not_configured') {
    return <FgaNotConfiguredCard message={r.message} />;
  }
  if (tr.name === 'get_user_trips' && r.fga_check?.allowed) {
    return <FgaAllowedCard result={r} />;
  }
  if (tr.name === 'save_trip_to_vault' && r.status === 'saved') {
    return <VaultSavedCard result={r} />;
  }
  if (tr.name === 'save_trip_to_vault' && (r.error === 'tokenvault_not_configured' || r.error === 'vault_grant_missing' || r.error === 'vault_failed')) {
    return <VaultErrorCard error={r.error} message={r.message} />;
  }
  return null;
}

function FlightOptionsCard({ destination, flights, onPick }) {
  return (
    <div style={{ marginTop: space.md }}>
      <div style={{ fontSize: font.size.xs, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: space.sm }}>
        {flights.length} flights to {destination} · pick one to book
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
        {flights.map((f) => <FlightOption key={f.id} flight={f} onPick={onPick} />)}
      </div>
    </div>
  );
}

function FlightOption({ flight, onPick }) {
  const tone =
    flight.price_usd <= 500   ? color.success :
    flight.price_usd <= 2000  ? color.warn    :
    color.info;
  const tier =
    flight.price_usd <= 500   ? 'Tier 1 · instant' :
    flight.price_usd <= 2000  ? 'Tier 2 · MFA'     :
    'Tier 3 · CIBA';
  return (
    <button
      type="button"
      onClick={() => onPick?.(flight)}
      style={{
        padding: space.md,
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderLeft: `3px solid ${tone}`,
        borderRadius: radius.md,
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: font.family,
        color: color.text,
        transition: 'transform 100ms ease, border-color 100ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.borderColor = tone; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = color.border; e.currentTarget.style.borderLeft = `3px solid ${tone}`; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <strong style={{ fontSize: font.size.body }}>{flight.airline} · {flight.cabin}</strong>
        <span style={{
          padding: '1px 8px', borderRadius: radius.pill, fontSize: font.size.xs,
          background: `${tone}22`, color: tone, fontWeight: font.weight.semibold,
        }}>{tier}</span>
      </div>
      <div style={{ fontSize: font.size.md, color: color.textDim, marginBottom: space.xs }}>
        {flight.duration_h}h{flight.layovers > 0 ? ` · ${flight.layovers} layover${flight.layovers > 1 ? 's' : ''}` : ' · nonstop'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono }}>{flight.id}</span>
        <span style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: color.text }}>
          ${flight.price_usd.toLocaleString()}
        </span>
      </div>
    </button>
  );
}

function VaultSavedCard({ result }) {
  return (
    <div style={{
      marginTop: space.md, padding: space.lg,
      background: color.surface, border: `1px solid ${color.success}55`,
      borderLeft: `3px solid ${color.success}`, borderRadius: radius.md, color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%',
          background: `${color.success}22`, color: color.success,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: font.size.md, fontWeight: font.weight.bold,
        }}>✓</span>
        <span style={{ fontWeight: font.weight.semibold, color: color.success, fontSize: font.size.body }}>
          Saved to VoyagerVault
        </span>
        <span style={{
          marginLeft: 'auto', padding: '1px 8px', borderRadius: radius.pill,
          background: color.successBg, color: color.success,
          fontSize: font.size.xs, fontFamily: font.mono,
        }}>token vault</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55, marginBottom: space.md }}>
        <strong style={{ color: color.text }}>{result.summary}</strong> ·{' '}
        {result.destination} · {result.dates}
      </div>
      <div style={{
        background: color.surfaceAlt, border: `1px solid ${color.border}`,
        borderRadius: radius.sm, padding: space.md, fontSize: font.size.xs, fontFamily: font.mono,
        lineHeight: 1.7, marginBottom: space.md,
      }}>
        <div><span style={{ color: color.textMuted }}>vault.id&nbsp;&nbsp;:&nbsp;</span>{result.id}</div>
        <div><span style={{ color: color.textMuted }}>token.aud&nbsp;:&nbsp;</span>https://api.voyagervault.demo</div>
        <div><span style={{ color: color.textMuted }}>token.scope:&nbsp;</span>write:vault</div>
        <div><span style={{ color: color.textMuted }}>obo.user&nbsp;&nbsp;:&nbsp;</span>X-On-Behalf-Of header</div>
      </div>
      <span style={{ fontSize: font.size.xs, color: color.textMuted, fontStyle: 'italic' }}>
        Auth0 brokered a short-lived, audience-scoped token at the moment of need. The agent never held a static VoyagerVault credential.
      </span>
    </div>
  );
}

function VaultErrorCard({ error, message }) {
  const isConfig = error === 'tokenvault_not_configured' || error === 'vault_grant_missing';
  const tone = isConfig ? color.warn : color.danger;
  return (
    <div style={{
      marginTop: space.md, padding: space.lg,
      background: color.surface, border: `1px solid ${tone}55`,
      borderLeft: `3px solid ${tone}`, borderRadius: radius.md, color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{ fontWeight: font.weight.semibold, color: tone, fontSize: font.size.body }}>
          {isConfig ? '⚠︎ VoyagerVault not configured' : '✗ VoyagerVault call failed'}
        </span>
        <span style={{
          marginLeft: 'auto', padding: '1px 8px', borderRadius: radius.pill,
          background: `${tone}22`, color: tone,
          fontSize: font.size.xs, fontFamily: font.mono,
        }}>{error}</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55 }}>
        {message || 'See docs/AUTH0-TENANT.md §10 for setup.'}
      </div>
    </div>
  );
}

function FgaDeniedCard({ result }) {
  const { user, relation, object } = result.fga_check || {};
  return (
    <div style={{
      marginTop: space.md, padding: space.lg,
      background: color.surface, border: `1px solid ${color.danger}55`,
      borderLeft: `3px solid ${color.danger}`, borderRadius: radius.md, color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%',
          background: `${color.danger}22`, color: color.danger,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: font.size.md, fontWeight: font.weight.bold,
        }}>✗</span>
        <span style={{ fontWeight: font.weight.semibold, color: color.danger, fontSize: font.size.body }}>
          Auth0 FGA · access denied
        </span>
        <span style={{
          marginLeft: 'auto', padding: '1px 8px', borderRadius: radius.pill,
          background: color.dangerBg, color: color.danger,
          fontSize: font.size.xs, fontFamily: font.mono,
        }}>fga.check · denied</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55, marginBottom: space.md }}>
        Even though the agent has the <code style={{ fontFamily: font.mono, color: color.text }}>read:trips</code> scope, Auth0 FGA blocked this read because you don't share an authorization relationship with{' '}
        <strong style={{ color: color.text }}>{result.target_label}</strong> (cost center{' '}
        <code style={{ fontFamily: font.mono }}>{result.target_cost_center}</code>).
        OAuth scopes ask <em>“can the caller call this tool?”</em> · FGA asks <em>“on which records?”</em>
      </div>
      <div style={{
        background: color.surfaceAlt, border: `1px solid ${color.border}`,
        borderRadius: radius.sm, padding: space.md, fontSize: font.size.xs, fontFamily: font.mono,
        lineHeight: 1.7,
      }}>
        <div><span style={{ color: color.textMuted }}>user&nbsp;&nbsp;&nbsp;&nbsp;:&nbsp;</span>{user}</div>
        <div><span style={{ color: color.textMuted }}>relation:&nbsp;</span>{relation}</div>
        <div><span style={{ color: color.textMuted }}>object&nbsp;&nbsp;:&nbsp;</span>{object}</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: color.textMuted }}>result&nbsp;&nbsp;:&nbsp;</span>
          <span style={{ color: color.danger, fontWeight: font.weight.semibold }}>✗ allowed=false</span>
        </div>
      </div>
    </div>
  );
}

function FgaAllowedCard({ result }) {
  const { user, relation, object } = result.fga_check || {};
  return (
    <div style={{
      marginTop: space.md, padding: space.lg,
      background: color.surface, border: `1px solid ${color.success}55`,
      borderLeft: `3px solid ${color.success}`, borderRadius: radius.md, color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%',
          background: `${color.success}22`, color: color.success,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: font.size.md, fontWeight: font.weight.bold,
        }}>✓</span>
        <span style={{ fontWeight: font.weight.semibold, color: color.success, fontSize: font.size.body }}>
          Auth0 FGA · access allowed
        </span>
        <span style={{
          marginLeft: 'auto', padding: '1px 8px', borderRadius: radius.pill,
          background: color.successBg, color: color.success,
          fontSize: font.size.xs, fontFamily: font.mono,
        }}>fga.check · allowed</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55, marginBottom: space.md }}>
        FGA allowed the read on <strong style={{ color: color.text }}>{result.target_label}</strong>{' '}
        (cost center <code style={{ fontFamily: font.mono }}>{result.target_cost_center}</code>) — you share a member relationship through that cost center.
      </div>
      <div style={{
        background: color.surfaceAlt, border: `1px solid ${color.border}`,
        borderRadius: radius.sm, padding: space.md, fontSize: font.size.xs, fontFamily: font.mono,
        lineHeight: 1.7,
      }}>
        <div><span style={{ color: color.textMuted }}>user&nbsp;&nbsp;&nbsp;&nbsp;:&nbsp;</span>{user}</div>
        <div><span style={{ color: color.textMuted }}>relation:&nbsp;</span>{relation}</div>
        <div><span style={{ color: color.textMuted }}>object&nbsp;&nbsp;:&nbsp;</span>{object}</div>
      </div>
    </div>
  );
}

function FgaNotConfiguredCard({ message }) {
  return (
    <div style={{
      marginTop: space.md, padding: space.lg,
      background: color.surface, border: `1px solid ${color.warn}55`,
      borderLeft: `3px solid ${color.warn}`, borderRadius: radius.md, color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{
          fontWeight: font.weight.semibold, color: color.warn, fontSize: font.size.body,
        }}>⚠︎ Auth0 FGA not configured</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55 }}>
        {message || 'Set the FGA_* env vars in voyagerai-api/.env, run npm run seed-fga, and try again.'}
      </div>
    </div>
  );
}

// CISO-friendly view of an authorization denial. Shows: what the agent tried,
// the missing scope, what scopes the agent does have, and a clear next step.
function PermissionDeniedCard({ tool, required, held }) {
  const heldList = Array.isArray(held) ? held.filter((s) => !['openid', 'profile', 'email', 'offline_access'].includes(s)) : [];
  const isBookingTool = tool === 'book_travel';
  return (
    <div style={{
      marginTop: space.md,
      padding: space.lg,
      background: color.surface,
      border: `1px solid ${color.danger}55`,
      borderLeft: `3px solid ${color.danger}`,
      borderRadius: radius.md,
      color: color.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%',
          background: `${color.danger}22`, color: color.danger,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: font.size.md, fontWeight: font.weight.bold,
        }}>✗</span>
        <span style={{ fontWeight: font.weight.semibold, color: color.danger, fontSize: font.size.body }}>
          Permission denied
        </span>
        <span style={{
          marginLeft: 'auto', padding: '1px 8px', borderRadius: radius.pill,
          background: color.dangerBg, color: color.danger,
          fontSize: font.size.xs, fontFamily: font.mono,
        }}>HTTP 403 · insufficient_scope</span>
      </div>
      <div style={{ color: color.textDim, fontSize: font.size.md, lineHeight: 1.55, marginBottom: space.md }}>
        This agent tried to call <code style={{ fontFamily: font.mono, color: color.text }}>{tool}</code> but it doesn't have the required scope. Auth0 enforced the boundary at the API level — no data was returned.
      </div>
      <div style={{
        background: color.surfaceAlt, border: `1px solid ${color.border}`,
        borderRadius: radius.sm, padding: space.md, fontSize: font.size.xs, fontFamily: font.mono,
        lineHeight: 1.7,
      }}>
        <div>
          <span style={{ color: color.textMuted }}>required:&nbsp;</span>
          <span style={{ color: color.danger, fontWeight: font.weight.semibold }}>✗ {required}</span>
        </div>
        {heldList.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={{ color: color.textMuted }}>held&nbsp;&nbsp;&nbsp;:&nbsp;</span>
            {heldList.map((s, i) => (
              <span key={s}>
                <span style={{ color: color.success, fontWeight: font.weight.semibold }}>✓ {s}</span>
                {i < heldList.length - 1 && <span style={{ color: color.textMuted }}>&nbsp;&nbsp;</span>}
              </span>
            ))}
          </div>
        )}
      </div>
      {isBookingTool && (
        <div style={{
          marginTop: space.md, padding: `${space.sm} ${space.md}`,
          borderRadius: radius.sm,
          background: `${color.brand}11`, border: `1px dashed ${color.brand}55`,
          color: color.textDim, fontSize: font.size.xs, lineHeight: 1.55,
        }}>
          → To book travel, switch to the <strong style={{ color: color.brandHi }}>Travel Agent · 1st-party</strong> tab. That agent's token includes the <code style={{ fontFamily: font.mono }}>book:travel</code> scope.
        </div>
      )}
    </div>
  );
}

function CibaWaitingCard({ booking, onResend }) {
  const [resending, setResending] = useState(false);
  const handleResend = async () => {
    if (resending) return;
    setResending(true);
    try { await onResend(); } finally { setResending(false); }
  };
  return (
    <div style={{
      alignSelf: 'flex-start', maxWidth: '70%',
      padding: space.lg, background: color.surface,
      border: `1px solid ${color.warn}55`, borderRadius: radius.lg,
      boxShadow: shadow.card,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <div style={{
          width: 24, height: 24, borderRadius: '50%',
          border: `2px solid ${color.warn}55`, borderTopColor: color.warn,
          animation: 'va-spin 0.9s linear infinite',
        }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: font.weight.semibold, color: color.text }}>Waiting for manager approval</div>
          <div style={{ fontSize: font.size.md, color: color.textDim, marginTop: 2 }}>
            Auth0 sent a Guardian push for <strong>{booking.destination}</strong> · ${booking.amountUSD?.toLocaleString()}
          </div>
        </div>
      </div>
      <div style={{ marginTop: space.md, fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono, lineHeight: 1.6 }}>
        booking_id: {booking.bookingId}
        {booking.authReqId && <><br />auth_req_id: {booking.authReqId}</>}
        {booking.resendCount > 0 && <><br />resends: {booking.resendCount}</>}
      </div>
      <div style={{ marginTop: space.md, display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleResend}
          disabled={resending}
          style={{
            padding: '6px 14px', borderRadius: radius.md,
            border: `1px solid ${color.warn}66`,
            background: resending ? color.surfaceAlt : `${color.warn}15`,
            color: color.warn, fontWeight: font.weight.semibold,
            fontSize: font.size.xs, cursor: resending ? 'wait' : 'pointer',
            fontFamily: font.family,
          }}
        >
          {resending ? 'Resending…' : '↻ Resend Guardian push'}
        </button>
        <span style={{ fontSize: font.size.xs, color: color.textMuted, fontStyle: 'italic' }}>
          Use this if Guardian didn't show the prompt.
        </span>
      </div>
      <style>{`@keyframes va-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
