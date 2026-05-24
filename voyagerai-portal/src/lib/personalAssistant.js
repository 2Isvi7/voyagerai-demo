// Independent Auth0Client for the 3rd-party "Personal AI Assistant" app.
//
// Why a second client? The user is signed in to the VoyagerAI Portal (1st-party)
// with one set of scopes. A 3rd-party app — conceptually a different company —
// needs DELEGATED, scope-restricted access. The cleanest way is two independent
// SPA app records in Auth0 (different client_id) and two independent token caches
// inside the portal. @auth0/auth0-react can only host one Auth0Provider at a time,
// so we drop down to @auth0/auth0-spa-js (which auth0-react wraps anyway) for the
// second client.
//
// `prompt: 'consent'` is sent on the authorize request, so Auth0 always shows the
// consent screen — that's the demo moment. In a real product you'd let it skip
// after the first authorization.

import { Auth0Client } from '@auth0/auth0-spa-js';

let client = null;

function getClient() {
  if (client) return client;
  const clientId = import.meta.env.VITE_PERSONAL_ASSISTANT_CLIENT_ID;
  if (!clientId || clientId.startsWith('<')) {
    throw new Error(
      'VITE_PERSONAL_ASSISTANT_CLIENT_ID is not set. Configure the 3rd-party app per ' +
      'docs/AUTH0-TENANT-VOYAGERAI.md §8 and add the value to voyagerai-portal/.env.'
    );
  }
  client = new Auth0Client({
    domain: import.meta.env.VITE_AUTH0_DOMAIN,
    clientId,
    authorizationParams: {
      audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      scope: 'openid profile email read:trips read:expenses offline_access',
      redirect_uri: window.location.origin,
    },
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
  });
  return client;
}

export async function authorizePersonalAssistant() {
  const c = getClient();
  await c.loginWithPopup({
    authorizationParams: { prompt: 'consent' },
  });
  const user = await c.getUser();
  return user;
}

export async function getPersonalAssistantToken() {
  return getClient().getTokenSilently();
}

export async function getPersonalAssistantUser() {
  if (!client) return null;
  try {
    const isAuthed = await client.isAuthenticated();
    if (!isAuthed) return null;
    return client.getUser();
  } catch (_) { return null; }
}

export async function logoutPersonalAssistant() {
  if (!client) return;
  // openUrl: false keeps us on the page; we're just clearing local state for the demo.
  await client.logout({ openUrl: false });
  client = null;
}
