import type { ServiceConfig } from '../../config.js';
import { clearSession, loadSession, saveSession, type StoredSession } from '../../auth/store.js';
import { AuthRequiredError, type AuthStatus, type LoginOptions } from '../types.js';
import { login, lookupSelf, renew, type VaultOidcConfig } from './oidc.js';

/** Продлеваем заранее: иначе запрос может уйти с токеном, протухшим в полёте. */
const RENEW_MARGIN_MS = 60_000;

export class VaultSession {
  /** single-flight: параллельные вызовы инструментов не должны продлевать токен наперегонки */
  private renewing?: Promise<string>;
  /** Не дёргать lookup-self повторно, если уже пробовали и не вышло. */
  private enrichFailed = false;

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

  private toStatus(session: StoredSession, authenticated: boolean, reason?: string): AuthStatus {
    return {
      authenticated,
      username: session.username,
      role: session.role,
      policies: session.policies,
      expiresAt: authenticated ? new Date(session.expiresAt).toISOString() : undefined,
      reason
    };
  }

  async status(): Promise<AuthStatus> {
    const session = this.read();
    // Причина описывает только факт: призыв «вызовите vault_login» добавляет
    // тот, кто показывает ошибку, иначе он задваивается в сообщении.
    if (!session) return { authenticated: false, reason: 'Сессии Vault нет.' };
    if (session.expiresAt <= Date.now()) {
      return this.toStatus(session, false, 'Токен Vault истёк.');
    }

    if (!session.policies && !this.enrichFailed) {
      try {
        const identity = await lookupSelf({ url: this.config.url }, session.token);
        const updated: StoredSession = {
          ...session,
          username: identity.username ?? session.username,
          role: identity.role ?? session.role,
          policies: identity.policies
        };
        saveSession(this.config.sessionPath, updated);
        return this.toStatus(updated, true);
      } catch {
        this.enrichFailed = true;
      }
    }

    return this.toStatus(session, true);
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
      renewable: renewed.renewable,
      username: renewed.username ?? session.username,
      role: renewed.role ?? session.role,
      policies: renewed.policies ?? session.policies
    };
    saveSession(this.config.sessionPath, updated);
    return updated.token;
  }

  async login(opts: LoginOptions): Promise<AuthStatus> {
    const auth = await login({ url: this.config.url, ...this.oidc }, opts);
    this.enrichFailed = false;

    saveSession(this.config.sessionPath, {
      url: this.config.url,
      token: auth.token,
      expiresAt: auth.expiresAt,
      renewable: auth.renewable,
      username: auth.username,
      role: auth.role,
      policies: auth.policies
    });

    if (!auth.renewable) {
      opts.log(
        'Внимание: выданный токен не продлевается — по истечении срока понадобится повторный вход.'
      );
    }
    return this.status();
  }

  logout(): void {
    this.enrichFailed = false;
    clearSession(this.config.sessionPath);
  }
}
