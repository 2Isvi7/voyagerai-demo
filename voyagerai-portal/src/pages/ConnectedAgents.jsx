import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space } from '../lib/tokens';
import { apiFetch } from '../lib/api';

export default function ConnectedAgents() {
  const { getAccessTokenSilently } = useAuth0();
  const [state, setState] = useState({ loading: true, grants: [], error: null });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const token = await getAccessTokenSilently();
      const r = await apiFetch('/api/connected-agents', { token });
      setState({ loading: false, grants: r.grants || [], error: null });
    } catch (e) {
      setState({ loading: false, grants: [], error: e.message });
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  const onRevoke = async (grantId) => {
    if (!window.confirm('Revoke this app\'s access? It will need user consent again on the next login.')) return;
    try {
      const token = await getAccessTokenSilently();
      await apiFetch(`/api/connected-agents/${grantId}`, { token, method: 'DELETE' });
      load();
    } catch (e) {
      alert(`Revoke failed: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text, maxWidth: 880, margin: '0 auto' }}>
      <header style={{ marginBottom: space.xl }}>
        <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>Connected Agents</h1>
        <p style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md, lineHeight: 1.55 }}>
          Third-party apps you have authorized to act on your VoyagerAI account, queried live from
          Auth0's Management API. Revoke any of them in one click — they'll re-prompt for consent on
          the next login.
        </p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
        <button type="button" onClick={load} style={{
          padding: '6px 14px', borderRadius: radius.md,
          border: `1px solid ${color.border}`, background: color.surface,
          color: color.text, fontSize: font.size.xs, cursor: 'pointer', fontFamily: font.family,
        }}>↻ Refresh from Auth0</button>
        <span style={{ fontSize: font.size.xs, color: color.textMuted }}>
          GET /api/v2/grants?user_id=…
        </span>
      </div>

      {state.error && (
        <div style={{
          padding: space.md, marginBottom: space.lg,
          background: color.dangerBg, color: color.danger,
          border: `1px solid ${color.danger}55`, borderRadius: radius.md, fontSize: font.size.md,
        }}>{state.error}</div>
      )}

      {state.loading && (
        <div style={{ padding: space.xl, color: color.textMuted, textAlign: 'center' }}>
          Loading from Auth0…
        </div>
      )}

      {!state.loading && !state.error && state.grants.length === 0 && (
        <div style={{
          padding: space.xxl, textAlign: 'center',
          background: color.surface, border: `1px dashed ${color.border}`,
          borderRadius: radius.lg, color: color.textMuted, fontSize: font.size.md, lineHeight: 1.7,
        }}>
          No third-party apps authorized.<br />
          <span style={{ fontSize: font.size.xs }}>
            On <strong>MCP Server → Personal AI Assistant</strong>, click <strong>Authorize via Auth0</strong> to grant a 3rd-party app and watch it appear here.
          </span>
        </div>
      )}

      {!state.loading && state.grants.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
          {state.grants.map((g) => <GrantCard key={g.id} grant={g} onRevoke={() => onRevoke(g.id)} />)}
        </div>
      )}
    </div>
  );
}

function GrantCard({ grant, onRevoke }) {
  const [revoking, setRevoking] = useState(false);
  const handle = async () => {
    if (revoking) return;
    setRevoking(true);
    try { await onRevoke(); } finally { setRevoking(false); }
  };
  return (
    <div style={{
      padding: space.lg,
      background: color.surface,
      border: `1px solid ${color.border}`,
      borderLeft: `3px solid ${color.info}`,
      borderRadius: radius.md,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.sm }}>
        <div>
          <strong style={{ fontSize: font.size.body, color: color.text }}>
            {grant.client?.name || grant.client_id}
          </strong>
          <span style={{
            marginLeft: space.sm, padding: '1px 8px', borderRadius: radius.pill,
            background: `${color.info}22`, color: color.info,
            fontSize: font.size.xs, fontWeight: font.weight.semibold,
          }}>{grant.client?.app_type || '3rd-party'}</span>
        </div>
        <button type="button" onClick={handle} disabled={revoking} style={{
          padding: '4px 12px', borderRadius: radius.pill,
          border: `1px solid ${color.danger}55`,
          background: revoking ? color.surfaceAlt : `${color.danger}15`,
          color: color.danger, fontSize: font.size.xs, fontWeight: font.weight.semibold,
          cursor: revoking ? 'wait' : 'pointer', fontFamily: font.family,
        }}>{revoking ? 'Revoking…' : '✗ Revoke'}</button>
      </div>
      {grant.client?.description && (
        <div style={{ fontSize: font.size.md, color: color.textDim, marginBottom: space.sm }}>
          {grant.client.description}
        </div>
      )}
      <div style={{
        background: color.surfaceAlt, border: `1px solid ${color.border}`,
        borderRadius: radius.sm, padding: space.md, fontSize: font.size.xs, fontFamily: font.mono,
        lineHeight: 1.7,
      }}>
        <div><span style={{ color: color.textMuted }}>grant.id&nbsp;&nbsp;:&nbsp;</span>{grant.id}</div>
        <div><span style={{ color: color.textMuted }}>client.id&nbsp;:&nbsp;</span>{grant.client_id}</div>
        <div><span style={{ color: color.textMuted }}>audience&nbsp;&nbsp;:&nbsp;</span>{grant.audience}</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: color.textMuted }}>scopes&nbsp;&nbsp;&nbsp;&nbsp;:&nbsp;</span>
          {grant.scope.length === 0
            ? <span style={{ color: color.textMuted }}>(none)</span>
            : grant.scope.map((s, i) => (
                <span key={s}>
                  <span style={{ color: color.success, fontWeight: font.weight.semibold }}>✓ {s}</span>
                  {i < grant.scope.length - 1 && <span style={{ color: color.textMuted }}>&nbsp;&nbsp;</span>}
                </span>
              ))}
        </div>
      </div>
    </div>
  );
}
