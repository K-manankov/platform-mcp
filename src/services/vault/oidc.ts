import { awaitCallback, randomToken } from '../../auth/loopback.js';

/**
 * Вход в Vault через OIDC — тот же поток, что делает `vault login -method=oidc`.
 *
 * Проще, чем у Argo CD: PKCE здесь не нужен, потому что код на токен меняет сам
 * Vault на своей стороне (client_secret приложения GitLab хранится в нём, а не
 * у клиента). От нас требуется только поднять локальный listener и передать
 * обратно code, state и client_nonce.
 *
 * Порт и путь фиксированы: http://localhost:8250/oidc/callback заранее прописан
 * в allowedRedirectURIs роли (platform/vault-config/30-oidc.yaml), и другой
 * адрес Vault просто отвергнет.
 */
export const CALLBACK_PORT = 8250;
export const CALLBACK_PATH = '/oidc/callback';

export interface VaultAuth {
  token: string;
  /** epoch ms, посчитанный из lease_duration. */
  expiresAt: number;
  renewable: boolean;
  username?: string;
}

interface VaultResponse {
  data?: { auth_url?: string };
  auth?: {
    client_token?: string;
    lease_duration?: number;
    renewable?: boolean;
    metadata?: Record<string, string>;
  };
  errors?: string[];
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
      `сертификат сервера не прошёл проверку (${code}). Если у Vault самоподписанный сертификат, ` +
      'укажите корневой CA в NODE_EXTRA_CA_CERTS либо, как временную меру, выставьте PLATFORM_MCP_INSECURE=true.'
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

const request = async (
  url: string,
  what: string,
  init?: RequestInit
): Promise<VaultResponse> => {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new Error(`Не удалось выполнить ${what} (${url}): ${diagnose(cause)}`, { cause });
  }

  const body = (await res.json().catch(() => ({}))) as VaultResponse;
  if (!res.ok) {
    const detail = body.errors?.length ? `: ${body.errors.join('; ')}` : '';
    throw new Error(`${what} не удался (HTTP ${res.status}${detail}).`);
  }
  return body;
};

export interface VaultOidcConfig {
  url: string;
  /** Точка монтирования метода: oidc для всех, oidc-admin для Owner'ов infra/k8s. */
  mount: string;
  role: string;
}

export const login = async (
  config: VaultOidcConfig,
  opts: { openBrowser: boolean; log: (message: string) => void }
): Promise<VaultAuth> => {
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  // client_nonce придумывает клиент: Vault свяжет им запрос auth_url и
  // последующий callback, чтобы чужой перехваченный code не сработал.
  const clientNonce = randomToken(16);

  const started = await request(
    `${config.url}/v1/auth/${config.mount}/oidc/auth_url`,
    'запрос ссылки для входа',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: config.role,
        redirect_uri: redirectUri,
        client_nonce: clientNonce
      })
    }
  );

  const authUrl = started.data?.auth_url;
  if (!authUrl) {
    throw new Error(
      `Vault не вернул ссылку для входа. Проверьте, что метод «${config.mount}» существует ` +
        `и в нём есть роль «${config.role}» (platform/vault-config/30-oidc.yaml).`
    );
  }

  // state генерирует сам Vault и кладёт внутрь ссылки — заранее мы его не
  // знаем, поэтому берём оттуда, чтобы затем сверить с тем, что вернёт браузер.
  const expectedState = new URL(authUrl).searchParams.get('state');
  if (!expectedState) {
    throw new Error('В ссылке для входа, выданной Vault, нет параметра state.');
  }

  const params = await awaitCallback({
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    authUrl,
    expectedState,
    openBrowser: opts.openBrowser,
    log: opts.log,
    portHint: 'Либо уже идёт другой вход, либо на нём висит `vault login -method=oidc`. Освободите порт и повторите.'
  });

  const callbackUrl = new URL(`${config.url}/v1/auth/${config.mount}/oidc/callback`);
  callbackUrl.searchParams.set('code', params.get('code') ?? '');
  callbackUrl.searchParams.set('state', params.get('state') ?? '');
  callbackUrl.searchParams.set('client_nonce', clientNonce);

  const completed = await request(callbackUrl.toString(), 'завершение входа');
  const auth = completed.auth;
  if (!auth?.client_token) {
    throw new Error('Vault не вернул токен по итогам входа.');
  }

  return {
    token: auth.client_token,
    // lease_duration — в секундах от «сейчас»; абсолютного времени Vault не даёт.
    expiresAt: Date.now() + (auth.lease_duration ?? 0) * 1000,
    renewable: auth.renewable === true,
    username: auth.metadata?.username ?? auth.metadata?.role
  };
};

/**
 * Продление собственного токена. В отличие от Argo CD, refresh-токена здесь
 * нет: Vault продлевает уже выданный токен, пока тот renewable и не вышел
 * его максимальный срок жизни.
 */
export const renew = async (config: { url: string }, token: string): Promise<VaultAuth> => {
  const body = await request(`${config.url}/v1/auth/token/renew-self`, 'продление токена', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vault-token': token }
  });

  const auth = body.auth;
  if (!auth?.client_token) {
    throw new Error('Vault не вернул токен при продлении.');
  }
  return {
    token: auth.client_token,
    expiresAt: Date.now() + (auth.lease_duration ?? 0) * 1000,
    renewable: auth.renewable === true,
    username: auth.metadata?.username
  };
};
