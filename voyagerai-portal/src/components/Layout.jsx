import { useAuth0 } from '@auth0/auth0-react';
import { NavLink, Outlet } from 'react-router-dom';
import { color, font, radius, space } from '../lib/tokens';

const NAV_SECTIONS = [
  {
    items: [
      { to: '/dashboard',  label: 'Dashboard',     icon: '▦' },
      { to: '/assistant',  label: 'AI Assistant',  icon: '✦' },
    ],
  },
  {
    title: 'AUTH0',
    items: [
      { to: '/auth0/authorization',     label: 'Authorization',     icon: '◇' },
      { to: '/auth0/tokens',            label: 'Token Inspector',   icon: '⌗' },
      { to: '/auth0/audit',             label: 'Audit Trail',       icon: '≡' },
      { to: '/auth0/connected-agents',  label: 'Connected Agents',  icon: '⚯' },
    ],
  },
  {
    title: 'MCP',
    items: [
      { to: '/mcp',                       label: 'MCP Server',          icon: '◈' },
      { to: '/mcp/tool-authorization',    label: 'Tool Authorization',  icon: '⚿' },
      { to: '/vault',                     label: 'VoyagerVault',        icon: '⚿' },
    ],
  },
  {
    title: 'BUSINESS',
    items: [
      { to: '/business/impact',     label: 'Impact',          icon: '↗' },
      { to: '/business/roi',        label: 'ROI Calculator',  icon: '$' },
      { to: '/business/compliance', label: 'Compliance',      icon: '✓' },
    ],
  },
  {
    title: 'SETTINGS',
    items: [{ to: '/settings', label: 'Settings', icon: '⚙' }],
  },
];

export default function Layout() {
  const { user, logout } = useAuth0();

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '232px 1fr',
        minHeight: '100vh',
        background: color.bg,
        color: color.text,
        fontFamily: font.family,
        fontSize: font.size.body,
      }}
    >
      <Sidebar />
      <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar user={user} onLogout={() => logout({ logoutParams: { returnTo: window.location.origin } })} />
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      style={{
        background: color.surface,
        borderRight: `1px solid ${color.border}`,
        padding: `${space.lg} 0`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: `0 ${space.lg} ${space.lg}`, display: 'flex', alignItems: 'center', gap: space.md }}>
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
        <span style={{ fontWeight: font.weight.semibold, fontSize: font.size.body }}>
          VoyagerAI
        </span>
      </div>

      <nav style={{ flex: 1 }}>
        {NAV_SECTIONS.map((section, i) => (
          <div key={i} style={{ marginBottom: space.lg }}>
            {section.title && (
              <div
                style={{
                  padding: `0 ${space.lg}`,
                  fontSize: font.size.xs,
                  fontWeight: font.weight.semibold,
                  letterSpacing: '0.08em',
                  color: color.textMuted,
                  marginBottom: space.sm,
                }}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function NavItem({ to, label, icon }) {
  return (
    <NavLink
      to={to}
      end={to === '/mcp'}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: space.md,
        padding: `${space.sm} ${space.lg}`,
        color: isActive ? color.text : color.textDim,
        background: isActive ? color.surfaceHi : 'transparent',
        borderLeft: `3px solid ${isActive ? color.brand : 'transparent'}`,
        fontWeight: isActive ? font.weight.semibold : font.weight.normal,
        textDecoration: 'none',
        transition: 'background 120ms ease, color 120ms ease',
      })}
    >
      <span style={{ width: 16, textAlign: 'center', color: color.textMuted }}>{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

function Topbar({ user, onLogout }) {
  return (
    <header
      style={{
        height: 56,
        borderBottom: `1px solid ${color.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: `0 ${space.xl}`,
        background: color.surface,
        gap: space.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, color: color.textDim, fontSize: font.size.md }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${color.brand}, ${color.accent})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: font.weight.bold,
            fontSize: font.size.xs,
          }}
        >
          {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
        </div>
        <span>{user?.name || user?.email || 'User'}</span>
      </div>
      <button
        onClick={onLogout}
        style={{
          background: 'transparent',
          color: color.textDim,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: '6px 12px',
          fontSize: font.size.md,
          cursor: 'pointer',
        }}
      >
        Sign out
      </button>
    </header>
  );
}
