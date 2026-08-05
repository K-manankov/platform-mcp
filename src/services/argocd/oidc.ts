import { createHash } from 'node:crypto';

import { awaitCallback, randomToken } from '../../auth/loopback.js';

/**
 * Автообнаружение OIDC-конфигурации Argo CD и вход по Authorization Code +
 * PKCE. Ничего не хардкодим: Argo CD сам отдаёт свои настройки в
 * /api/v1/settings, а провайдер — стандартный
 * /.well-known/openid-configuration.
 */

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
}

interface ArgoSettings {
  dexConfig?: { connectors?: unknown[] };
  oidcConfig?: {
    issuer?: string;
    clientID?: string;
    cliClientID?: string;
    scopes?: string[];
  };
}

interface ProviderMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
}

/**
 * Public-клиент, которого Argo CD автоматически регистрирует в Dex вместе с
 * redirect URI http://localhost:8085/auth/callback. Именно им пользуется
 * `argocd login --sso`, поэтому менять dex.config под нас не требуется.
 */
const DEX_CLI_CLIENT_ID = 'argo-cd-cli';
const BASE_SCOPES = ['openid', 'profile', 'email', 'groups'];

/**
 * Порт локального listener'а. 8085 — то значение, которое Argo CD
 * регистрирует в Dex для argo-cd-cli; менять его можно только вместе с
 * override staticClients в dex.config.
 */
export const CALLBACK_PORT = 8085;
export const CALLBACK_PATH = '/auth/callback';

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

export const discover = async (argocdUrl: string): Promise<OidcEndpoints> => {
  const settings = await fetchJson<ArgoSettings>(
    `${argocdUrl}/api/v1/settings`,
    'настройки Argo CD'
  );

  const dexIssuer = `${argocdUrl}/api/dex`;
  const declaredIssuer = settings.oidcConfig?.issuer?.replace(/\/+$/, '');

  if (!declaredIssuer && !settings.dexConfig) {
    throw new Error(
      'В Argo CD не настроен ни Dex, ни OIDC — войти через SSO невозможно. ' +
        'Проверьте dex.config / oidc.config в argocd-cm.'
    );
  }

  const issuer = declaredIssuer ?? dexIssuer;
  // Argo CD со встроенным Dex может отдавать заполненный oidcConfig, где issuer
  // указывает на его же /api/dex. Клиент для CLI в этом случае — не тот, что в
  // oidcConfig (он для веб-интерфейса), а автоматически зарегистрированный
  // public-клиент Dex.
  const viaDex = issuer === dexIssuer;

  const clientId = viaDex
    ? DEX_CLI_CLIENT_ID
    : settings.oidcConfig?.cliClientID || settings.oidcConfig?.clientID || '';

  if (!clientId) {
    throw new Error(
      'В настройках Argo CD задан oidc.config, но не указан cliClientID. ' +
        'Для входа из CLI нужен отдельный public-клиент — добавьте oidc.config.cliClientID в argocd-cm.'
    );
  }

  let scopes =
    !viaDex && settings.oidcConfig?.scopes?.length
      ? [...settings.oidcConfig.scopes]
      : [...BASE_SCOPES];

  const meta = await fetchJson<ProviderMetadata>(
    `${issuer}/.well-known/openid-configuration`,
    'метаданные OIDC-провайдера'
  );

  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(
      `Метаданные OIDC-провайдера ${issuer} не содержат authorization_endpoint/token_endpoint.`
    );
  }

  // offline_access нужен ради refresh-токена: без него сессия умрёт вместе с
  // id_token и разработчику придётся логиниться заново.
  const supported = meta.scopes_supported;
  if (!supported || supported.includes('offline_access')) {
    scopes = [...scopes, 'offline_access'];
  }

  return {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    clientId,
    scopes: [...new Set(scopes)]
  };
};

export interface TokenResponse {
  idToken: string;
  refreshToken?: string;
}

const parseTokenResponse = async (res: Response, what: string): Promise<TokenResponse> => {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const desc = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
    throw new Error(`${what} не удался (${err}${desc}).`);
  }
  // Argo CD принимает как Bearer именно id_token, а не access_token —
  // access_token у Dex непрозрачный и API-сервером не валидируется.
  if (typeof body.id_token !== 'string') {
    throw new Error(
      `${what}: провайдер не вернул id_token. Проверьте, что в запросе есть scope openid.`
    );
  }
  return {
    idToken: body.id_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined
  };
};

/**
 * Authorization Code + PKCE (S256) через локальный loopback-редирект.
 *
 * Клиент public (без секрета), поэтому PKCE обязателен — иначе перехваченный
 * код можно обменять на токен.
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
    portHint: 'Либо уже идёт другой вход, либо на нём висит `argocd login --sso`. Освободите порт и повторите.'
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
  // Dex ротирует refresh-токен: если новый не пришёл, старый ещё валиден.
  return { idToken: tokens.idToken, refreshToken: tokens.refreshToken ?? refreshToken };
};
