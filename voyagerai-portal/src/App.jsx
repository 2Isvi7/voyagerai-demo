import { useAuth0, Auth0Provider } from '@auth0/auth0-react';
import { Routes, Route, useNavigate, Navigate } from 'react-router-dom';

import Layout from './components/Layout';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Assistant from './pages/Assistant';
import MCPServer from './pages/MCPServer';
import Authorization from './pages/Authorization';
import TokenInspector from './pages/TokenInspector';
import AuditTrail from './pages/AuditTrail';
import ConnectedAgents from './pages/ConnectedAgents';
import ToolAuthorization from './pages/ToolAuthorization';
import Impact from './pages/Impact';
import ROICalculator from './pages/ROICalculator';
import Compliance from './pages/Compliance';
import Settings from './pages/Settings';

import { color, font } from './lib/tokens';

function Auth0ProviderWithNavigate({ children }) {
  const navigate = useNavigate();
  const onRedirectCallback = (appState) =>
    navigate(appState?.returnTo || window.location.pathname);

  return (
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin + '/dashboard',
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
        scope:
          'openid profile email read:profile read:trips read:expenses book:travel',
      }}
      onRedirectCallback={onRedirectCallback}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      {children}
    </Auth0Provider>
  );
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();

  if (isLoading) return <LoadingScreen text="Verifying session…" />;
  if (!isAuthenticated) {
    loginWithRedirect({ appState: { returnTo: window.location.pathname } });
    return null;
  }
  return children;
}

function LoadingScreen({ text = 'Starting VoyagerAI…' }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontFamily: font.family,
        background: color.bg,
        color: color.textDim,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: 28,
            height: 28,
            margin: '0 auto 12px',
            border: `2px solid ${color.border}`,
            borderTopColor: color.brand,
            borderRadius: '50%',
            animation: 'va-spin 0.9s linear infinite',
          }}
        />
        <p style={{ fontSize: font.size.body, margin: 0 }}>{text}</p>
      </div>
      <style>{`@keyframes va-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function AppRoutes() {
  const { isLoading } = useAuth0();
  if (isLoading) return <LoadingScreen />;

  return (
    <Routes>
      <Route path="/" element={<Landing />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/mcp" element={<MCPServer />} />
        <Route path="/auth0/authorization" element={<Authorization />} />
        <Route path="/auth0/tokens" element={<TokenInspector />} />
        <Route path="/auth0/audit" element={<AuditTrail />} />
        <Route path="/auth0/connected-agents" element={<ConnectedAgents />} />
        <Route path="/mcp/tool-authorization" element={<ToolAuthorization />} />
        <Route path="/business/impact" element={<Impact />} />
        <Route path="/business/roi" element={<ROICalculator />} />
        <Route path="/business/compliance" element={<Compliance />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <Auth0ProviderWithNavigate>
      <AppRoutes />
    </Auth0ProviderWithNavigate>
  );
}
