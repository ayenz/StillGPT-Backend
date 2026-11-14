import { AppError } from '../errors.js';

export interface TokenProvider {
  getToken(): Promise<string>;
}

/** Personal Access Token: static. Docs: fine for testing/POC, not recommended for production. */
export function patTokenProvider(pat: string): TokenProvider {
  return { getToken: async () => pat };
}

/**
 * Service Account key → short-lived SAT (max 12 h) via openapi.qoder.sh, refreshed 5 min before expiry.
 * Recommended for production by Qoder (Teams/Enterprise).
 */
export function serviceAccountTokenProvider(saKey: string, openApiBaseUrl: string, fetchImpl = fetch): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const exchange = async () => {
    const res = await fetchImpl(`${openApiBaseUrl}/api/v1/serviceToken/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', audience: 'qoder', scope: 'qca.access', ttl_seconds: 43200 }),
    });
    if (!res.ok) throw new AppError(502, 'upstream_auth', `Service account token exchange failed (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new AppError(502, 'upstream_auth', 'Service account token exchange returned no token');
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 43200) * 1000 };
    return cached.token;
  };

  return {
    async getToken() {
      if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
      inflight ??= exchange().finally(() => (inflight = undefined));
      return inflight;
    },
  };
}
