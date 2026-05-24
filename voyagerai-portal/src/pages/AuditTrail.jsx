import { useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { color, font, radius, space, shadow } from '../lib/tokens';
import { apiFetch } from '../lib/api';

const REASON_LABELS = {
  tier1_under_500:           { label: 'Tier 1 (under $500)',     tone: 'success' },
  mfa_satisfied:             { label: 'MFA satisfied',           tone: 'success' },
  ciba_approved_within_cap:  { label: 'CIBA approved · within cap', tone: 'success' },
  scope_satisfied:           { label: 'Scope satisfied',          tone: 'success' },
  ciba_required:             { label: 'CIBA pending',             tone: 'warn' },
  mfa_required:              { label: 'MFA required',             tone: 'warn' },
  insufficient_scope:        { label: 'Insufficient scope',       tone: 'danger' },
  bounded_authority_exceeded:{ label: 'Bounded authority exceeded', tone: 'danger' },
  fga_denied:                { label: 'FGA denied',               tone: 'danger' },
};

export default function AuditTrail() {
  const { getAccessTokenSilently } = useAuth0();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ decision: 'all', tool: 'all' });

  // Refetch on a 5s heartbeat so the trail stays fresh during the demo.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const token = await getAccessTokenSilently();
        const data = await apiFetch('/api/audit?limit=200', { token });
        if (!cancelled) { setRows(data.rows || []); setLoading(false); setError(null); }
      } catch (e) { if (!cancelled) { setError(e.message); setLoading(false); } }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [getAccessTokenSilently]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter.decision !== 'all' && r.decision !== filter.decision) return false;
      if (filter.tool !== 'all' && r.tool !== filter.tool) return false;
      return true;
    });
  }, [rows, filter]);

  const stats = useMemo(() => {
    const total = rows.length;
    const allowed = rows.filter((r) => r.decision === 'allowed').length;
    const denied  = rows.filter((r) => r.decision === 'denied').length;
    const pending = rows.filter((r) => r.decision === 'pending').length;
    const agents  = new Set(rows.map((r) => r.agent_sub).filter(Boolean)).size;
    return { total, allowed, denied, pending, agents };
  }, [rows]);

  const exportCsv = () => {
    if (!rows.length) return;
    const cols = ['ts','agent_sub','user_sub','tool','decision','reason','scopes','ciba','bounded_authority'];
    const csv = [
      cols.join(','),
      ...rows.map((r) => cols.map((c) => {
        const v = r[c];
        if (v == null) return '';
        if (typeof v === 'object') return JSON.stringify(v).replace(/"/g, '""').replace(/\n/g, ' ');
        return `"${String(v).replace(/"/g, '""')}"`;
      }).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voyagerai-audit-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: space.xxl, fontFamily: font.family, color: color.text }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: font.size.xxl, fontWeight: font.weight.bold }}>Agent Audit Trail</h1>
          <div style={{ marginTop: space.xs, color: color.textMuted, fontSize: font.size.md }}>
            Every agent action logged with full provenance.
          </div>
        </div>
        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <ComplianceBadge label="FINRA" />
          <ComplianceBadge label="SEC" />
          <ComplianceBadge label="SOX" />
          <button onClick={exportCsv} disabled={!rows.length} style={{
            marginLeft: space.md, padding: `${space.sm} ${space.lg}`, borderRadius: radius.md,
            border: 0, background: color.brand, color: '#fff',
            fontSize: font.size.md, fontWeight: font.weight.semibold,
            cursor: rows.length ? 'pointer' : 'not-allowed', opacity: rows.length ? 1 : 0.5,
            fontFamily: font.family,
          }}>↓ Export for Audit</button>
        </div>
      </div>

      <div style={{ marginTop: space.xl, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: space.lg }}>
        <Stat label="Total actions" value={stats.total} />
        <Stat label="Allowed"        value={stats.allowed} tone="success" />
        <Stat label="Denied"         value={stats.denied}  tone="danger" />
        <Stat label="Unique agents"  value={stats.agents} />
      </div>

      <div style={{ marginTop: space.xl, display: 'flex', gap: space.sm, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: font.size.xs, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: space.sm }}>Filter</span>
        <FilterChip active={filter.decision === 'all'}      onClick={() => setFilter((f) => ({ ...f, decision: 'all' }))}      label="All" />
        <FilterChip active={filter.decision === 'allowed'}  onClick={() => setFilter((f) => ({ ...f, decision: 'allowed' }))}  label="✓ Allowed" tone="success" />
        <FilterChip active={filter.decision === 'denied'}   onClick={() => setFilter((f) => ({ ...f, decision: 'denied' }))}   label="✗ Denied"  tone="danger" />
        <FilterChip active={filter.decision === 'pending'}  onClick={() => setFilter((f) => ({ ...f, decision: 'pending' }))}  label="⌛ Pending" tone="warn" />
        <span style={{ width: 1, height: 16, background: color.border, margin: `0 ${space.sm}` }} />
        <FilterChip active={filter.tool === 'all'}          onClick={() => setFilter((f) => ({ ...f, tool: 'all' }))}          label="All tools" />
        {['get_profile','get_trips','get_expenses','book_travel'].map((t) => (
          <FilterChip key={t} active={filter.tool === t} onClick={() => setFilter((f) => ({ ...f, tool: t }))} label={t} />
        ))}
      </div>

      <div style={{
        marginTop: space.xl,
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        boxShadow: shadow.card,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '110px 1.2fr 1fr 1fr 1.4fr 0.8fr',
          gap: space.md,
          padding: `${space.md} ${space.lg}`,
          background: color.surfaceAlt,
          borderBottom: `1px solid ${color.border}`,
          fontSize: font.size.xs,
          color: color.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          <div>Time</div>
          <div>Tool</div>
          <div>Decision</div>
          <div>Reason</div>
          <div>Scopes / FGA / CIBA</div>
          <div>Bounded auth</div>
        </div>

        {loading && <Empty>Loading…</Empty>}
        {error && <Empty tone="danger">Error: {error}</Empty>}
        {!loading && !error && filtered.length === 0 && (
          <Empty>No matching actions yet. Talk to the AI Assistant — events appear here in real time.</Empty>
        )}

        {filtered.map((r, i) => <Row key={`${r.ts}-${i}`} r={r} />)}
      </div>
    </div>
  );
}

// ── subcomponents ────────────────────────────────────────────────────────────

function Row({ r }) {
  const cfg = REASON_LABELS[r.reason] || { label: r.reason || '—', tone: r.decision === 'denied' ? 'danger' : r.decision === 'allowed' ? 'success' : 'info' };
  const decisionTint = { allowed: color.success, denied: color.danger, pending: color.warn }[r.decision] || color.textMuted;
  const time = (r.ts || '').slice(11, 19);
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '110px 1.2fr 1fr 1fr 1.4fr 0.8fr',
      gap: space.md,
      padding: `${space.md} ${space.lg}`,
      borderBottom: `1px solid ${color.border}`,
      alignItems: 'center',
      fontSize: font.size.md,
    }}>
      <div style={{ color: color.textMuted, fontFamily: font.mono, fontSize: font.size.xs }}>{time}</div>
      <div style={{ fontFamily: font.mono, color: color.text }}>{r.tool || '—'}</div>
      <div>
        <span style={{
          padding: '2px 10px', borderRadius: radius.pill, fontSize: font.size.xs,
          fontWeight: font.weight.semibold,
          background: `${decisionTint}22`, color: decisionTint,
          border: `1px solid ${decisionTint}55`,
        }}>{r.decision || '—'}</span>
      </div>
      <div>
        <Tone tone={cfg.tone}>{cfg.label}</Tone>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: font.size.xs, fontFamily: font.mono, color: color.textDim }}>
        {r.scopes && <div>scope: {Array.isArray(r.scopes) ? r.scopes.join(' ') : r.scopes}</div>}
        {r.fga    && <div>fga: {r.fga.relation} {r.fga.allowed ? '✓' : '✗'}</div>}
        {r.ciba   && <div>ciba: {r.ciba.status} ({(r.ciba.auth_req_id || '').slice(0,8)}…)</div>}
      </div>
      <div style={{ fontFamily: font.mono, fontSize: font.size.xs, color: color.textDim }}>
        {r.bounded_authority
          ? <>${r.bounded_authority.requested?.toLocaleString()} {r.bounded_authority.allowed ? '✓' : '✗'} cap ${r.bounded_authority.max?.toLocaleString()}</>
          : '—'}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'info' }) {
  const tint = { info: color.text, success: color.success, danger: color.danger, warn: color.warn }[tone];
  return (
    <div style={{
      background: color.surface, border: `1px solid ${color.border}`,
      borderRadius: radius.lg, padding: space.lg, boxShadow: shadow.card,
    }}>
      <div style={{ fontSize: font.size.xs, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: font.size.xxl, fontWeight: font.weight.bold, color: tint, marginTop: space.xs }}>{value}</div>
    </div>
  );
}

function FilterChip({ active, onClick, label, tone }) {
  const tint = { success: color.success, danger: color.danger, warn: color.warn }[tone] || color.brand;
  return (
    <button type="button" onClick={onClick} style={{
      padding: '4px 12px', borderRadius: radius.pill,
      border: `1px solid ${active ? tint : color.border}`,
      background: active ? `${tint}22` : 'transparent',
      color: active ? tint : color.textDim,
      fontSize: font.size.xs, fontWeight: font.weight.medium,
      cursor: 'pointer', fontFamily: font.family,
    }}>{label}</button>
  );
}

function ComplianceBadge({ label }) {
  return (
    <span style={{
      padding: '2px 10px', borderRadius: radius.pill,
      border: `1px solid ${color.border}`,
      color: color.textMuted, fontSize: font.size.xs,
      fontFamily: font.mono,
    }}>{label}</span>
  );
}

function Tone({ tone, children }) {
  const tint = { success: color.success, danger: color.danger, warn: color.warn, info: color.info }[tone] || color.textDim;
  return <span style={{ color: tint, fontSize: font.size.md }}>{children}</span>;
}

function Empty({ children, tone }) {
  const tint = tone === 'danger' ? color.danger : color.textMuted;
  return (
    <div style={{ padding: space.xxl, textAlign: 'center', color: tint, fontSize: font.size.md }}>
      {children}
    </div>
  );
}
