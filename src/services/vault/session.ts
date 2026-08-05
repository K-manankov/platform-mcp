import type { ServiceConfig } from '../../config.js';
import { clearSession, loadSession, saveSession, type StoredSession } from '../../auth/store.js';
import { AuthRequiredError, type AuthStatus, type LoginOptions } from '../types.js';
import { login, renew, type VaultOidcConfig } from './oidc.js';

/** Продлеваем заранее: иначе запрос может уйти с токеном, протухшим в полёте. */
const RENEW_MARGIN_MS = 60_000;

export class VaultSession {
  /** single-flight: параллельные вызовы инструментов не должны продлевать токен наперегонки */
  private renewing?: Promise<string>;

  constructor(
    private readonly config: ServiceConfig,
    private readonly oidc: Omit<VaultOidcConfig, 'url'>
  ) {}

  private read(): StoredSession | null {
    const session = loadSession(this.config.sessionPath);
    if (!session) return null;
    // Токен, выданный другим инстансом Vault, отправлять на текущий адрес нельзя.
    if (session.url !== this.config.url) return null;
    return session;
  }

  status(): AuthStatus {
    const session = this.read();
    // Причина описывает только факт: призыв «вызовите vault_login» добавляет
    // тот, кто показывает ошибку, иначе он задваивается в сообщении.
    if (!session) return { authenticated: false, reason: 'Сессии Vault нет.' };
    if (session.expiresAt <= Date.now()) {
      return {
        authenticated: false,
        username: session.username,
        reason: 'Токен Vault истёк.'
      };
    }
    return {
      authenticated: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  async getToken(): Promise<string> {
    const session = this.read();
    if (!session) {
      throw new AuthRequiredError(
        'Нет сохранённой сессии Vault. Вызовите инструмент vault_login (или `platform-mcp login vault`).'
      );
    }

    if (Date.now() < session.expiresAt - RENEW_MARGIN_MS) return session.token;

    if (!session.renewable) {
      clearSession(this.config.sessionPath);
      throw new AuthRequiredError(
        'Токен Vault истёк и не продлевается. Вызовите инструмент vault_login.'
      );
    }

    this.renewing ??= this.doRenew(session).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async doRenew(session: StoredSession): Promise<string> {
    let renewed;
    try {
      renewed = await renew({ url: this.config.url }, session.token);
    } catch (cause) {
      // Отозванный токен или исчерпанный max_ttl восстановлению не подлежат.
      clearSession(this.config.sessionPath);
      throw new AuthRequiredError(
        `Не удалось продлить сессию Vault (${(cause as Error).message}). Вызовите инструмент vault_login.`
      );
    }

    const updated: StoredSession = {
      ...session,
      token: renewed.token,
      expiresAt: renewed.expiresAt,
      renewable: renewed.renewable
    };
    saveSession(this.config.sessionPath, updated);
    return updated.token;
  }

  async login(opts: LoginOptions): Promise<AuthStatus> {
    const auth = await login({ url: this.config.url, ...this.oidc }, opts);

    saveSession(this.config.sessionPath, {
      url: this.config.url,
      token: auth.token,
      expiresAt: auth.expiresAt,
      renewable: auth.renewable,
      username: auth.username
    });

    if (!auth.renewable) {
      opts.log(
        'Внимание: выданный токен не продлевается — по истечении срока понадобится повторный вход.'
      );
    }
    return this.status();
  }

  logout(): void {
    clearSession(this.config.sessionPath);
  }
}
