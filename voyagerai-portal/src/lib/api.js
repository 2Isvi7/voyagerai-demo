// Thin fetch wrapper that injects the Auth0 access token.
// Phase 1: tools authenticate as the user via the SPA's silent token.
// Phase 2: 3rd-party agent flows will use a separate getAccessTokenSilently scope.

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3002';

export async function apiFetch(path, { token, method = 'GET', body, headers = {}, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const apiBase = BASE;
