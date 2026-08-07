import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

/**
 * Локальный listener для OIDC-редиректа, общий для сервисов.
 *
 * Отличается у них только порт и путь: Argo CD — http://localhost:8085/auth/callback,
 * Vault — http://localhost:8250/oidc/callback, Keycloak —
 * http://localhost:8280/oidc/callback.
 */
export interface CallbackOptions {
  port: number;
  /** Путь редиректа, зарегистрированный у провайдера. */
  path: string;
  /** Ссылка, которую нужно открыть в браузере. */
  authUrl: string;
  /** Значение state, которое обязано вернуться обратно. */
  expectedState: string;
  /** false — не открывать браузер, только напечатать ссылку (SSH, devcontainer, WSL). */
  openBrowser: boolean;
  /** Куда печатать инструкции; в stdio-режиме MCP это обязан быть stderr. */
  log: (message: string) => void;
  /** Что подсказать, если порт занят. */
  portHint: string;
  timeoutMs?: number;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const openInBrowser = (url: string): void => {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* нет браузера — пользователь откроет ссылку сам */
  }
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

const constantTimeEquals = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

/**
 * Открывает браузер и ждёт редиректа обратно. Возвращает query-параметры
 * ответа провайдера — что с ними делать дальше, решает конкретный сервис.
 */
export const awaitCallback = async (opts: CallbackOptions): Promise<URLSearchParams> =>
  new Promise<URLSearchParams>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      if (url.pathname !== opts.path) {
        res.writeHead(404).end();
        return;
      }

      const fail = (message: string): void => {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Вход не удался', message));
        finish();
        reject(new Error(message));
      };

      const error = url.searchParams.get('error');
      if (error) {
        fail(`Провайдер вернул ошибку: ${error} ${url.searchParams.get('error_description') ?? ''}`);
        return;
      }
      // Проверка state — защита от подмены ответа (CSRF на редиректе).
      if (!constantTimeEquals(url.searchParams.get('state') ?? '', opts.expectedState)) {
        fail('Не совпал параметр state — ответ авторизации отброшен.');
        return;
      }
      if (!url.searchParams.get('code')) {
        fail('Провайдер не вернул authorization code.');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Готово', 'Вкладку можно закрыть и вернуться в редактор.'));
      finish();
      resolve(url.searchParams);
    });

    const timer = setTimeout(
      () => {
        finish();
        reject(new Error('Истекло время ожидания входа (5 минут).'));
      },
      opts.timeoutMs ?? 5 * 60_000
    );

    const finish = (): void => {
      clearTimeout(timer);
      server.close();
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Порт ${opts.port} занят. ${opts.portHint}`)
          : err
      );
    });

    // Слушаем только loopback: код авторизации не должен быть доступен по сети.
    server.listen(opts.port, '127.0.0.1', () => {
      opts.log(`Откройте ссылку для входа:\n\n${opts.authUrl}\n`);
      if (opts.openBrowser) openInBrowser(opts.authUrl);
    });
  });
