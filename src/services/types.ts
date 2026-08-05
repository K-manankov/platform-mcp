export type ServiceName = 'argocd' | 'vault';

/** Сессии нет или её уже не восстановить — нужен интерактивный вход. */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  expiresAt?: string;
  reason?: string;
}

export interface LoginOptions {
  /** false — не открывать браузер, только напечатать ссылку (SSH, devcontainer, WSL). */
  openBrowser: boolean;
  /** Куда печатать инструкции; в stdio-режиме MCP это обязан быть stderr. */
  log: (message: string) => void;
}

/**
 * Единый контракт сервиса. Новый сервис = ещё одна реализация: сервер сам
 * заведёт ему инструменты <name>_login / _auth_status / _logout / _exec.
 */
export interface ServiceModule {
  readonly name: ServiceName;
  /** Человекочитаемое имя для описаний инструментов. */
  readonly title: string;
  /** Адрес, с которым работает сервис. */
  readonly url: string;
  status(): AuthStatus;
  login(options: LoginOptions): Promise<AuthStatus>;
  logout(): void;
  /** Выполняет команду CLI. Авторизацию и политику проверяет вызывающая сторона. */
  exec(args: string[], stdin?: string): Promise<string>;
  /** Подсказка для инструмента <name>_exec: как выглядят типичные вызовы. */
  readonly execHelp: string;
}
