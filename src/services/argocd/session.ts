import type { ServiceConfig } from '../../config.js';
import { clearSession, loadSession, saveSession, type StoredSession } from '../../auth/store.js';
import { expiresAtOf, usernameOf } from '../../auth/jwt.js';
import { AuthRequiredError, type AuthStatus, type LoginOptions } from '../types.js';
import { discover, loginInteractive, refreshTokens, type OidcEndpoints } from './oidc.js';

/** Обновляем заранее: иначе запрос может уйти с токеном, протухшим в полёте. */
const REFRESH_MARGIN_MS = 60_000;

export class ArgoCdSession {
  private endpoints?: OidcEndpoints;
  /** single-flight: параллельные вызовы инструментов не должны гонять refresh наперегонки */
  private refreshing?: Promise<string>;

  constructor(private readonly config: ServiceConfig) {}

  private async getEndpoints(): Promise<OidcEndpoints> {
    this.endpoints ??= await discover(this.config.url);
    return this.endpoints;
  }

  private read(): StoredSession | null {
    const session = loadSession(this.config.sessionPath);
    if (!session) return null;
    // Сессия от другого инстанса бесполезна и опасна: не отправляем токен,
    // выписанный другим issuer'ом, на текущий адрес.
    if (session.url !== this.config.url) return null;
    return session;
  }

  status(): AuthStatus {
    const session = this.read();
    // Причина описывает только факт: призыв «вызовите argocd_login» добавляет
    // тот, кто показывает ошибку, иначе он задваивается в сообщении.
    if (!session) return { authenticated: false, reason: 'Сессии Argo CD нет.' };
    if (session.expiresAt <= Date.now() && !session.refreshToken) {
      return {
        authenticated: false,
        username: session.username,
        reason: 'Токен Argo CD истёк, а refresh-токена нет.'
      };
    }
    return {
      authenticated: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  /**
   * Актуальный id_token. Обновляет его при необходимости и бросает
   * AuthRequiredError, если нужен интерактивный вход — браузер сам не
   * открывает: сервер живёт в фоне, и внезапно всплывшее окно браузера
   * было бы неожиданным поведением.
   */
  async getToken(): Promise<string> {
    const session = this.read();
    if (!session) {
      throw new AuthRequiredError(
        'Нет сохранённой сессии Argo CD. Вызовите инструмент argocd_login (или `platform-mcp login argocd`).'
      );
    }

    if (Date.now() < session.expiresAt - REFRESH_MARGIN_MS) return session.token;

    if (!session.refreshToken) {
      throw new AuthRequiredError(
        'Токен Argo CD истёк, а refresh-токена нет. Вызовите инструмент argocd_login.'
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
      // Протухший или отозванный refresh-токен восстановлению не подлежит:
      // чистим сессию, чтобы не долбить провайдер на каждом вызове.
      clearSession(this.config.sessionPath);
      throw new AuthRequiredError(
        `Не удалось обновить сессию Argo CD (${(cause as Error).message}). Вызовите инструмент argocd_login.`
      );
    }

    const updated: StoredSession = {
      ...session,
      token: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresAt: expiresAtOf(tokens.idToken),
      username: usernameOf(tokens.idToken)
    };
    saveSession(this.config.sessionPath, updated);
    return updated.token;
  }

  async login(opts: LoginOptions): Promise<AuthStatus> {
    const endpoints = await this.getEndpoints();
    const tokens = await loginInteractive(endpoints, opts);

    saveSession(this.config.sessionPath, {
      url: this.config.url,
      token: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresAt: expiresAtOf(tokens.idToken),
      username: usernameOf(tokens.idToken)
    });

    if (!tokens.refreshToken) {
      opts.log(
        'Внимание: провайдер не выдал refresh-токен. Сессия проживёт до истечения id_token, ' +
          'после чего понадобится повторный вход. Проверьте scope offline_access в конфигурации Dex.'
      );
    }
    return this.status();
  }

  logout(): void {
    clearSession(this.config.sessionPath);
  }
}
