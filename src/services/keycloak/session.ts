import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ServiceConfig } from '../../config.js';
import { clearSession, loadSession, saveSession, type StoredSession } from '../../auth/store.js';
import { expiresAtOf, usernameOf } from '../../auth/jwt.js';
import { AuthRequiredError, type AuthStatus, type LoginOptions } from '../types.js';
import {
  CLIENT_ID,
  discover,
  loginInteractive,
  REALM,
  refreshTokens,
  type OidcEndpoints
} from './oidc.js';

/** Обновляем заранее: иначе запрос может уйти с токеном, протухшим в полёте. */
const REFRESH_MARGIN_MS = 60_000;

export interface KeycloakServiceConfig extends ServiceConfig {
  /** Приватный kcadm.config — не ~/.keycloak/kcadm.config. */
  kcadmConfigPath: string;
}

/**
 * Формат ConfigData / RealmConfigData из admin-cli Keycloak.
 * endpoints: serverUrl → realm → сессия.
 */
export const writeKcadmConfig = (
  path: string,
  opts: {
    serverUrl: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  }
): void => {
  const realmData = {
    serverUrl: opts.serverUrl,
    realm: REALM,
    clientId: CLIENT_ID,
    token: opts.accessToken,
    refreshToken: opts.refreshToken,
    expiresAt: opts.expiresAt,
    grantTypeForAuthentication: 'authorization_code'
  };

  const config = {
    serverUrl: opts.serverUrl,
    realm: REALM,
    endpoints: {
      [opts.serverUrl]: {
        [REALM]: realmData
      }
    }
  };

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.kcadm.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
};

export class KeycloakSession {
  private endpoints?: OidcEndpoints;
  private refreshing?: Promise<string>;

  constructor(private readonly config: KeycloakServiceConfig) {}

  private async getEndpoints(): Promise<OidcEndpoints> {
    this.endpoints ??= await discover(this.config.url);
    return this.endpoints;
  }

  private read(): StoredSession | null {
    const session = loadSession(this.config.sessionPath);
    if (!session) return null;
    if (session.url !== this.config.url) return null;
    return session;
  }

  private persistKcadm(session: StoredSession): void {
    writeKcadmConfig(this.config.kcadmConfigPath, {
      serverUrl: session.url,
      accessToken: session.token,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt
    });
  }

  status(): AuthStatus {
    const session = this.read();
    if (!session) return { authenticated: false, reason: 'Сессии Keycloak нет.' };
    if (session.expiresAt <= Date.now() && !session.refreshToken) {
      return {
        authenticated: false,
        username: session.username,
        reason: 'Токен Keycloak истёк, а refresh-токена нет.'
      };
    }
    return {
      authenticated: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  /**
   * Актуальный access_token. Браузер сам не открывает — нужен явный
   * keycloak_login, как у остальных сервисов.
   */
  async getToken(): Promise<string> {
    const session = this.read();
    if (!session) {
      throw new AuthRequiredError(
        'Нет сохранённой сессии Keycloak. Вызовите инструмент keycloak_login (или `platform-mcp login keycloak`).'
      );
    }

    if (Date.now() < session.expiresAt - REFRESH_MARGIN_MS) {
      this.persistKcadm(session);
      return session.token;
    }

    if (!session.refreshToken) {
      throw new AuthRequiredError(
        'Токен Keycloak истёк, а refresh-токена нет. Вызовите инструмент keycloak_login.'
      );
    }

    this.refreshing ??= this.doRefresh(session).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(session: StoredSession): Promise<string> {
    const endpoints = await this.getEndpoints();
    let tokens;
    try {
      tokens = await refreshTokens(endpoints, session.refreshToken as string);
    } catch (cause) {
      clearSession(this.config.sessionPath);
      throw new AuthRequiredError(
        `Не удалось обновить сессию Keycloak (${(cause as Error).message}). Вызовите инструмент keycloak_login.`
      );
    }

    const fromJwt = expiresAtOf(tokens.accessToken);
    const updated: StoredSession = {
      ...session,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: fromJwt > 0 ? fromJwt : tokens.expiresAt,
      username: usernameOf(tokens.accessToken) ?? session.username
    };
    saveSession(this.config.sessionPath, updated);
    this.persistKcadm(updated);
    return updated.token;
  }

  async login(opts: LoginOptions): Promise<AuthStatus> {
    const endpoints = await this.getEndpoints();
    const tokens = await loginInteractive(endpoints, opts);

    const fromJwt = expiresAtOf(tokens.accessToken);
    const session: StoredSession = {
      url: this.config.url,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: fromJwt > 0 ? fromJwt : tokens.expiresAt,
      username: usernameOf(tokens.accessToken)
    };
    saveSession(this.config.sessionPath, session);
    this.persistKcadm(session);

    if (!tokens.refreshToken) {
      opts.log(
        'Внимание: Keycloak не выдал refresh-токен. Сессия проживёт до истечения access_token, ' +
          'после чего понадобится повторный вход. Проверьте, что клиенту доступен scope offline_access.'
      );
    }
    return this.status();
  }

  logout(): void {
    clearSession(this.config.sessionPath);
    clearSession(this.config.kcadmConfigPath);
  }
}
