import createOpenApiClient, { type Client, type Middleware } from 'openapi-fetch';
import { ApiError, toApiError } from './errors';
import type { components, paths } from './generated/schema';

export type TokenPair = components['schemas']['TokenPair'];

/**
 * Where tokens live. Use secure storage on devices (Keychain / Keystore), never plain localStorage
 * for refresh tokens on the web if you can avoid it. All methods may be async.
 */
export interface TokenStore {
  get(): TokenPair | null | Promise<TokenPair | null>;
  set(tokens: TokenPair | null): void | Promise<void>;
}

/** A trivial in-memory store: fine for tests and server-side use. */
export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: TokenPair | null = null) {}
  get(): TokenPair | null {
    return this.tokens;
  }
  set(tokens: TokenPair | null): void {
    this.tokens = tokens;
  }
}

export interface ApiClientOptions {
  /** Origin of the API, e.g. "https://api.example.com" (paths already include "/v1"). */
  baseUrl: string;
  tokens: TokenStore;
  /** Called once when the session cannot be continued (refresh refused, revoked, suspended...). Send the user to sign-in. */
  onSessionLost?: (reason: ErrorCodeLike) => void;
  /** Custom fetch (React Native polyfills, tests, retries...). Defaults to the global one. */
  fetch?: typeof fetch;
  /**
   * Serialises token refresh ACROSS tabs/processes. In browsers pass
   * `(fn) => navigator.locks.request('runningapp-token-refresh', fn)`. Within one JS context
   * concurrent refreshes are already collapsed into one.
   */
  withRefreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Refresh this many ms before the access token expires (default 30 s). */
  refreshLeewayMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

type ErrorCodeLike = string;

export type ApiClient = Client<paths> & {
  /** Resolves the current tokens, refreshing if needed. Handy for opening a websocket or a media player. */
  getAccessToken(): Promise<string | null>;
  /** Stores tokens from a login/signup response. */
  setTokens(tokens: TokenPair | null): Promise<void>;
  /** The underlying openapi-fetch client's base URL. */
  readonly baseUrl: string;
};

/** Paths that must never carry (or trigger a refresh of) an Authorization header. */
const PUBLIC_PATHS = [
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/refresh',
  '/v1/auth/verify-email',
  '/v1/auth/password/forgot',
  '/v1/auth/password/reset',
];
const isPublic = (url: string) => PUBLIC_PATHS.some((p) => new URL(url).pathname.endsWith(p));

/** Error codes that mean "this session is over; ask the user to sign in again". */
const SESSION_OVER = new Set([
  'SESSION_REVOKED',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  'TOKEN_INVALID',
  'ACCOUNT_SUSPENDED',
]);

/**
 * Creates the typed API client. Request/response types come from docs/openapi.json, so a changed
 * endpoint is a compile error here rather than a runtime surprise. Authentication is handled for you:
 *  - the bearer token is attached to every non-public request,
 *  - an access token about to expire is refreshed BEFORE the request is sent,
 *  - a 401 TOKEN_EXPIRED triggers ONE refresh and ONE retry of the original request,
 *  - concurrent requests share a single refresh (refresh tokens are single-use: refreshing twice with
 *    the same token would revoke the session).
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const now = options.now ?? Date.now;
  const leeway = options.refreshLeewayMs ?? 30_000;
  const lock = options.withRefreshLock ?? (<T>(fn: () => Promise<T>) => fn());
  let refreshing: Promise<TokenPair | null> | null = null;
  let sessionLostFor: string | null = null;

  const lose = async (reason: string) => {
    await options.tokens.set(null);
    if (sessionLostFor !== reason) {
      sessionLostFor = reason;
      options.onSessionLost?.(reason);
    }
  };

  /** Exchanges the refresh token. Returns the new pair, or null when the session is over. */
  async function refresh(staleAccessToken: string | null): Promise<TokenPair | null> {
    refreshing ??= lock(async () => {
      const current = await options.tokens.get();
      if (!current) return null;
      // Another tab/process already refreshed while we waited for the lock: just use its result.
      if (staleAccessToken !== null && current.accessToken !== staleAccessToken) return current;

      let response: Response;
      try {
        response = await doFetch(new URL('/v1/auth/refresh', options.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
      } catch {
        // Offline: keep the tokens, the next request tries again.
        throw new ApiError({
          code: 'NETWORK_ERROR',
          message: 'Network request failed.',
          status: 0,
        });
      }
      if (response.ok) {
        const body = (await response.json()) as components['schemas']['RefreshResponse'];
        await options.tokens.set(body.tokens);
        sessionLostFor = null;
        return body.tokens;
      }
      const error = toApiError(response.status, await response.json().catch(() => null));
      if (response.status >= 400 && response.status < 500) {
        await lose(error.code);
        return null;
      }
      throw error; // 5xx: transient, keep the tokens
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const retryBodies = new Map<string, Request>();

  const middleware: Middleware = {
    async onRequest({ request, id }) {
      if (isPublic(request.url)) return undefined;
      let tokens = await options.tokens.get();
      if (tokens && Date.parse(tokens.accessTokenExpiresAt) - now() < leeway) {
        tokens =
          (await refresh(tokens.accessToken).catch(() => null)) ?? (await options.tokens.get());
      }
      if (tokens) request.headers.set('authorization', `Bearer ${tokens.accessToken}`);
      // Keep an unread copy: a request body can only be consumed once, and a retry needs it.
      retryBodies.set(id, request.clone());
      return request;
    },

    async onResponse({ request, response, id }) {
      const original = retryBodies.get(id);
      retryBodies.delete(id);
      if (response.status !== 401 || !original || isPublic(request.url)) return undefined;

      const error = toApiError(
        401,
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      if (error.code === 'TOKEN_EXPIRED') {
        const stale =
          /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
        // A transient refresh failure surfaces the original 401.
        const fresh = await refresh(stale).catch(() => null);
        if (!fresh) return undefined;
        const retry = new Request(original, { headers: new Headers(original.headers) });
        retry.headers.set('authorization', `Bearer ${fresh.accessToken}`);
        return doFetch(retry);
      }
      if (SESSION_OVER.has(error.code)) await lose(error.code);
      return undefined;
    },
  };

  const client = createOpenApiClient<paths>({ baseUrl: options.baseUrl, fetch: doFetch });
  client.use(middleware);

  return Object.assign(client, {
    baseUrl: options.baseUrl,
    async getAccessToken() {
      const tokens = await options.tokens.get();
      if (!tokens) return null;
      if (Date.parse(tokens.accessTokenExpiresAt) - now() < leeway) {
        return (await refresh(tokens.accessToken).catch(() => null))?.accessToken ?? null;
      }
      return tokens.accessToken;
    },
    async setTokens(tokens: TokenPair | null) {
      sessionLostFor = null;
      await options.tokens.set(tokens);
    },
  });
}
