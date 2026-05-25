import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space } from '../lib/tokens';
import { apiFetch } from '../lib/api';

export default function Vault() {
  const { getAccessTokenSilently } = useAuth0();
  const [entries, setEntries] = useState(null); // null = loading, [] = empty
  const [error, setError] = useState(null);

  const reload = async () => {
    setError(null);
    try {
      const token = await getAccessTokenSilently();
      const r = await apiFetch('/api/vault/trips', { token });
      setEntries(r.entries || []);
    } catch (e) {
      setError(e.message);
      setEntries([]);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, []);

  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text, maxWidth: 880, margin: '0 auto' }}>
      <header style={{ marginBottom: space.xl }}>
        <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>VoyagerVault</h1>
        <p style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md, lineHeight: 1.55 }}>
          A separate-audience downstream service for trip notes. The Travel Agent reaches it via a Token Vault flow:
          Auth0 brokers a short-lived access token (<code style={{ fontFamily: font.mono }}>aud=https://api.voyagervault.demo</code>,
          scope <code style={{ fontFamily: font.mono }}>write:vault</code>) at the moment of need — the agent never holds
          a static credential for this service.
        </p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
        <button type="button" onClick={reload} style={{
          padding: '6px 14px', borderRadius: radius.md,
          border: `1px solid ${color.border}`, background: color.surface,
          color: color.text, fontSize: font.size.xs, cursor: 'pointer', fontFamily: font.family,
        }}>↻ Refresh</button>
        <span style={{ fontSize: font.size.xs, color: color.textMuted }}>
          Storage is in-memory — entries reset on API restart.
        </span>
      </div>

      {error && (
        <div style={{
          padding: space.md, marginBottom: space.lg,
          background: color.dangerBg, color: color.danger,
          border: `1px solid ${color.danger}55`, borderRadius: radius.md,
          fontSize: font.size.md,
        }}>{error}</div>
      )}

      {entries === null && (
        <div style={{ padding: space.xl, color: color.textMuted, textAlign: 'center' }}>Loading…</div>
      )}

      {entries && entries.length === 0 && (
        <div style={{
          padding: space.xxl, textAlign: 'center',
          background: color.surface, border: `1px dashed ${color.border}`,
          borderRadius: radius.lg, color: color.textMuted, fontSize: font.size.md, lineHeight: 1.7,
        }}>
          No vault entries yet.<br />
          <span style={{ fontSize: font.size.xs }}>
            Go to <strong>MCP Server → Travel Agent</strong> and pick the <strong>Token Vault · + VoyagerVault</strong> quick prompt.
          </span>
        </div>
      )}

      {entries && entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
          {entries.map((e) => <Entry key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}

function Entry({ entry }) {
  return (
    <div style={{
      padding: space.lg,
      background: color.surface,
      border: `1px solid ${color.border}`,
      borderLeft: `3px solid ${color.success}`,
      borderRadius: radius.md,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space.xs }}>
        <strong style={{ fontSize: font.size.body, color: color.text }}>{entry.summary}</strong>
        <span style={{ fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono }}>{entry.id}</span>
      </div>
      <div style={{ fontSize: font.size.md, color: color.textDim, marginBottom: space.sm }}>
        {entry.destination} · {entry.dates}
      </div>
      {entry.notes && (
        <div style={{
          padding: space.md, background: color.surfaceAlt,
          borderRadius: radius.sm, fontSize: font.size.md, color: color.text,
          lineHeight: 1.55, marginBottom: space.sm,
        }}>{entry.notes}</div>
      )}
      <div style={{ display: 'flex', gap: space.md, fontSize: font.size.xs, color: color.textMuted, fontFamily: font.mono }}>
        <span>by: {entry.agent_sub}</span>
        <span>·</span>
        <span>at: {(entry.ts || '').slice(0, 19).replace('T', ' ')}</span>
      </div>
    </div>
  );
}
