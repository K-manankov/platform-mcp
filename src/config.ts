import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Версии CLI, которые сервер скачивает, если бинарника нет в PATH.
 *
 * Совпадают с тем, что развёрнуто в кластере (см. clusters/sonar-prod/apps/
 * в репозитории infra/k8s/platform: чарт argo-cd 10.2.1 → appVersion v3.4.5,
 * чарт vault 0.34.0 → appVersion 2.0.3). При обновлении кластера версии тут
 * нужно поднять руками — разъезд версий CLI и сервера даёт в лучшем случае
 * предупреждение, в худшем непонятные ошибки на новых подкомандах.
 */
export const PINNED_CLI_VERSIONS = {
  argocd: 'v3.4.5',
  vault: '2.0.3',
  /** Совпадает с image.tag в platform/keycloak (infra). */
  kcadm: '26.6.4'
} as const;

export interface ServiceConfig {
  /** Базовый URL сервиса, например https://argocd.infra.sonar-corp.ru */
  url: string;
  sessionPath: string;
}

export interface KeycloakConfig extends ServiceConfig {
  /** Приватный kcadm.config (не ~/.keycloak/). */
  kcadmConfigPath: string;
}

export interface PolicyConfig {
  /**
   * Требовать подтверждения пользователя перед любой немутирующей командой.
   * Выключение оставляет агента наедине с кластером — только для отладки.
   */
  requireConfirmation: boolean;
  /**
   * Приложения Argo CD, которые нельзя менять через агента: инфраструктура
   * едет из Git через merge request, а не из диалога.
   */
  denyApplications: string[];
  /** Пути Vault, недоступные через агента вообще (ни на чтение, ни на запись). */
  denyVaultPaths: string[];
  /**
   * Отдавать ли значения секретов Vault в ответах. По умолчанию нет:
   * содержимое ушло бы в контекст модели и дальше провайдеру.
   */
  allowSecretValues: boolean;
}

export interface VaultOidcConfig {
  /**
   * Точка монтирования метода входа. По умолчанию oidc — общий вход для всех.
   * Owner'ам группы infra/k8s нужен oidc-admin: он читает группы из другого
   * claim'а и только там выдаётся политика admin (platform/vault-config/40-groups.yaml).
   */
  mount: string;
  role: string;
}

export interface AppConfig {
  argocd?: ServiceConfig;
  vault?: ServiceConfig;
  keycloak?: KeycloakConfig;
  vaultOidc: VaultOidcConfig;
  configDir: string;
  binDir: string;
  policy: PolicyConfig;
  /**
   * Не проверять TLS-сертификаты сервисов. Осознанный опт-ин: у ingress'а
   * этого кластера сертификата нет, отдаётся дефолтный самоподписанный.
   */
  insecureSkipTlsVerify: boolean;
}

const DEFAULT_POLICY: PolicyConfig = {
  requireConfirmation: true,
  denyApplications: [
    'root',
    'argocd',
    'vault',
    'vault-config',
    'vault-config-operator',
    'external-secrets',
    'external-secrets-config',
    'cert-manager',
    'ingress-nginx',
    'metallb',
    'metallb-config',
    'local-path-provisioner',
    'projects',
    'keycloak',
    'keycloak-db',
    'keycloak-operator',
    'keycloak-config'
  ],
  denyVaultPaths: [],
  allowSecretValues: false
};

const configDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'platform-mcp');

/** Необязательный ~/.config/platform-mcp/config.json — альтернатива переменным окружения. */
const readConfigFile = (dir: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const truthyEnv = (value: string | undefined): boolean => {
  const normalized = value?.toLowerCase();
  return normalized === 'true' || normalized === '1';
};

const service = (
  dir: string,
  name: 'argocd' | 'vault',
  rawUrl: string | undefined
): ServiceConfig | undefined => {
  if (!rawUrl) return undefined;
  return {
    url: rawUrl.replace(/\/+$/, ''),
    sessionPath: join(dir, `${name}-session.json`)
  };
};

const keycloakService = (dir: string, rawUrl: string | undefined): KeycloakConfig | undefined => {
  if (!rawUrl) return undefined;
  return {
    url: rawUrl.replace(/\/+$/, ''),
    sessionPath: join(dir, 'keycloak-session.json'),
    kcadmConfigPath: join(dir, 'kcadm.config')
  };
};

export const loadConfig = (): AppConfig => {
  const dir = configDir();
  const file = readConfigFile(dir);
  const rawPolicy = isRecord(file.policy) ? file.policy : {};

  const argocdUrl =
    process.env.ARGOCD_BASE_URL ||
    process.env.ARGOCD_URL ||
    (typeof file.argocdUrl === 'string' ? file.argocdUrl : undefined);

  const vaultUrl =
    process.env.VAULT_ADDR ||
    process.env.VAULT_BASE_URL ||
    (typeof file.vaultUrl === 'string' ? file.vaultUrl : undefined);

  const keycloakUrl =
    process.env.KEYCLOAK_BASE_URL ||
    process.env.KEYCLOAK_URL ||
    (typeof file.keycloakUrl === 'string' ? file.keycloakUrl : undefined);

  if (!argocdUrl && !vaultUrl && !keycloakUrl) {
    throw new Error(
      'Не задан адрес ни одного сервиса. Укажите ARGOCD_BASE_URL, VAULT_ADDR и/или KEYCLOAK_BASE_URL ' +
        `(например https://argocd.infra.sonar-corp.ru), либо поля argocdUrl / vaultUrl / keycloakUrl в ${join(dir, 'config.json')}.`
    );
  }

  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value ? value : fallback;

  return {
    argocd: service(dir, 'argocd', argocdUrl),
    vault: service(dir, 'vault', vaultUrl),
    keycloak: keycloakService(dir, keycloakUrl),
    vaultOidc: {
      mount: process.env.VAULT_OIDC_MOUNT || str(file.vaultOidcMount, 'oidc'),
      role: process.env.VAULT_OIDC_ROLE || str(file.vaultOidcRole, 'default')
    },
    configDir: dir,
    binDir: join(dir, 'bin'),
    policy: {
      requireConfirmation: bool(rawPolicy.requireConfirmation, DEFAULT_POLICY.requireConfirmation),
      denyApplications: stringList(rawPolicy.denyApplications, DEFAULT_POLICY.denyApplications),
      denyVaultPaths: stringList(rawPolicy.denyVaultPaths, DEFAULT_POLICY.denyVaultPaths),
      allowSecretValues:
        truthyEnv(process.env.PLATFORM_MCP_ALLOW_SECRET_VALUES) ||
        bool(rawPolicy.allowSecretValues, DEFAULT_POLICY.allowSecretValues)
    },
    insecureSkipTlsVerify:
      truthyEnv(process.env.PLATFORM_MCP_INSECURE) || file.insecureSkipTlsVerify === true
  };
};

/**
 * Отключает проверку сертификата, если это явно разрешено.
 *
 * По этому каналу ходят токены доступа, поэтому предупреждение печатается при
 * каждом запуске: временное решение не должно стать постоянным. Переменная
 * наследуется дочерними argocd/vault, которые ходят в сервисы сами.
 *
 * Если сертификат подписан внутренним CA, эта опция не нужна: достаточно
 * указать корневой сертификат в NODE_EXTRA_CA_CERTS.
 */
export const applyTlsPolicy = (config: AppConfig): void => {
  if (!config.insecureSkipTlsVerify) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.stderr.write(
    'ВНИМАНИЕ: проверка TLS-сертификатов отключена (PLATFORM_MCP_INSECURE). Соединение ' +
      'шифруется, но подлинность сервера не подтверждается — токены доступа уязвимы к ' +
      'перехвату внутри сети. Это временная мера до выпуска настоящих сертификатов.\n'
  );
};
