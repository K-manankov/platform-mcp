import { createHash } from 'node:crypto';

import { awaitCallback, randomToken } from '../../auth/loopback.js';

/**
 * Authorization Code + PKCE для realm master.
 *
 * В отличие от Argo CD, сюда не ходим за настройками сервиса: issuer и клиент
 * известны заранее (public-клиент platform-mcp-cli заводится в bootstrap).
 * В сессию кладётся access_token — им пользуется Admin API / kcadm.
 */

export const CLIENT_ID = 'platform-mcp-cli';
export const CALLBACK_PORT = 8280;
export const CALLBACK_PATH = '/oidc/callback';
export const REALM = 'master';

const BASE_SCOPES = ['openid', 'profile', 'email'];

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
}

interface ProviderMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
}

/** Причина сетевого сбоя лежит во вложенной ошибке undici. */
const causeCode = (error: unknown): string =>
  (error as { cause?: { code?: string } })?.cause?.code ?? '';

const diagnose = (error: unknown): string => {
  const code = causeCode(error);
  if (
    code.includes('CERT') ||
    code.includes('SELF_SIGNED') ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return (
      `сертификат сервера не прошёл проверку (${code}). Если у сервиса самоподписанный ` +
      'сертификат, укажите корневой CA в NODE_EXTRA_CA_CERTS либо, как временную меру, ' +
      'выставьте PLATFORM_MCP_INSECURE=true.'
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'имя не резолвится. Проверьте подключение к VPN — внутренние имена доступны только изнутри сети.';
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'сервер не отвечает. Проверьте подключение к VPN и доступность адреса.';
  }
  return (error as Error).message;
};

const fetchJson = async <T>(url: string, what: string): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(`Не удалось получить ${what} (${url}): ${diagnose(cause)}`, { cause });
  }
  if (!res.ok) {
    throw new Error(`Не удалось получить ${what} (${url}): HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
};

export const discover = async (keycloakUrl: string): Promise<OidcEndpoints> => {
  const issuer = `${keycloakUrl.replace(/\/+$/, '')}/realms/${REALM}`;
  const meta = await fetchJson<ProviderMetadata>(
    `${issuer}/.well-known/openid-configuration`,
    'метаданные OIDC Keycloak'
  );

  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(
      `Метаданные OIDC-провайдера ${issuer} не содержат authorization_endpoint/token_endpoint.`
    );
  }

  let scopes = [...BASE_SCOPES];
  const supported = meta.scopes_supported;
  if (!supported || supported.includes('offline_access')) {
    scopes = [...scopes, 'offline_access'];
  }

  return {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    clientId: CLIENT_ID,
    scopes: [...new Set(scopes)]
  };
};

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; из expires_in, если claim exp в access_token отсутствует. */
  expiresAt: number;
}

const parseTokenResponse = async (res: Response, what: string): Promise<TokenResponse> => {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const desc = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
    throw new Error(`${what} не удался (${err}${desc}).`);
  }
  if (typeof body.access_token !== 'string') {
    throw new Error(`${what}: провайдер не вернул access_token.`);
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000
  };
};

/**
 * Authorization Code + PKCE (S256) через локальный loopback-редирект.
 * Клиент public (без секрета) — PKCE обязателен.
 */
export const loginInteractive = async (
  endpoints: OidcEndpoints,
  opts: { openBrowser: boolean; log: (message: string) => void }
): Promise<TokenResponse> => {
  const verifier = randomToken(32);
  const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url');
  const state = randomToken(16);
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', endpoints.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', endpoints.scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const params = await awaitCallback({
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    authUrl: authUrl.toString(),
    expectedState: state,
    openBrowser: opts.openBrowser,
    log: opts.log,
    portHint:
      'Либо уже идёт другой вход в Keycloak через platform-mcp. Освободите порт и повторите.'
  });

  const res = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') ?? '',
      redirect_uri: redirectUri,
      client_id: endpoints.clientId,
      code_verifier: verifier
    })
  });
  return parseTokenResponse(res, 'Обмен кода на токен');
};

export const refreshTokens = async (
  endpoints: OidcEndpoints,
  refreshToken: string
): Promise<TokenResponse> => {
  const res = await fetch(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: endpoints.clientId
    })
  });
  const tokens = await parseTokenResponse(res, 'Обновление токена');
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshToken,
    expiresAt: tokens.expiresAt
  };
};
