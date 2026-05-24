// Design tokens for VoyagerAI portal.
// Inspired by the Crestline Finance reference UI (dark, navy/teal, accent gradients).
// Use these instead of inline hex values so the look stays consistent and themeable.

export const color = {
  // surfaces
  bg:         '#0B0F1A',  // page background
  surface:    '#111726',  // panels / sidebar
  surfaceAlt: '#161E2F',  // raised cards
  surfaceHi:  '#1B2438',  // hover / active row
  border:     '#222B40',
  borderHi:   '#2E3A55',

  // text
  text:       '#E8ECF1',
  textDim:    '#A8B2C4',
  textMuted:  '#6E7A91',

  // brand
  brand:      '#6366F1',  // VoyagerAI indigo
  brandHi:    '#818CF8',
  accent:     '#22D3EE',  // teal for "live" indicators

  // semantic
  success:    '#10B981',
  successBg:  'rgba(16,185,129,0.12)',
  warn:       '#F59E0B',
  warnBg:     'rgba(245,158,11,0.12)',
  danger:     '#EF4444',
  dangerBg:   'rgba(239,68,68,0.12)',
  info:       '#38BDF8',
  infoBg:     'rgba(56,189,248,0.12)',

  // method chips (HTTP / decision)
  chipPost:   '#A78BFA',
  chipGet:    '#60A5FA',
  chipDeny:   '#F87171',
};

export const radius = {
  sm: '6px',
  md: '10px',
  lg: '14px',
  pill: '999px',
};

export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
};

export const font = {
  family: "'Inter','Segoe UI',system-ui,-apple-system,sans-serif",
  mono:   "'JetBrains Mono','SF Mono',ui-monospace,monospace",
  size: {
    xs:   '11px',
    sm:   '12px',
    md:   '13px',
    body: '14px',
    lg:   '16px',
    xl:   '20px',
    xxl:  '28px',
  },
  weight: {
    normal:   400,
    medium:   500,
    semibold: 600,
    bold:     700,
  },
};

export const shadow = {
  card:    '0 1px 2px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.18)',
  hover:   '0 2px 8px rgba(0,0,0,0.35), 0 12px 28px rgba(0,0,0,0.22)',
  ring:    '0 0 0 3px rgba(99,102,241,0.35)',
};

// Reusable style helpers (objects, not classes — we don't ship a CSS framework).
export const card = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.lg,
  boxShadow: shadow.card,
};

export const chip = (variant = 'info') => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '2px 10px',
  borderRadius: radius.pill,
  fontSize: font.size.xs,
  fontWeight: font.weight.semibold,
  background: color[`${variant}Bg`] || color.infoBg,
  color: color[variant] || color.info,
  border: `1px solid ${color[variant] || color.info}33`,
});
