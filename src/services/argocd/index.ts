import type { AppConfig, ServiceConfig } from '../../config.js';
import { ensureBinary } from '../../bootstrap/ensure-binary.js';
import { redactKubernetesSecrets } from '../../redact/secrets.js';
import { execCli } from '../exec.js';
import type { AuthStatus, LoginOptions, ServiceModule } from '../types.js';
import { ArgoCdSession } from './session.js';

const EXEC_HELP = `Аргументы командной строки argocd, массивом. Адрес и токен подставляются сервером — \
флаги --server, --auth-token, --config, --core запрещены.

Примеры:
  ["app", "list", "-o", "json"]
  ["app", "get", "team-a-api", "-o", "json"]
  ["app", "sync", "team-a-api"]
  ["app", "logs", "team-a-api", "--tail", "100"]
  ["proj", "list", "-o", "json"]

Флаг вывода в JSON (-o json) стоит добавлять всегда, когда команда его поддерживает: \
табличный вывод разбирать сложнее и в нём теряются поля.`;

export class ArgoCdService implements ServiceModule {
  readonly name = 'argocd' as const;
  readonly title = 'Argo CD';
  readonly execHelp = EXEC_HELP;
  private readonly session: ArgoCdSession;

  constructor(
    private readonly service: ServiceConfig,
    private readonly app: AppConfig
  ) {
    this.session = new ArgoCdSession(service);
  }

  get url(): string {
    return this.service.url;
  }

  status(): AuthStatus {
    return this.session.status();
  }

  login(options: LoginOptions): Promise<AuthStatus> {
    return this.session.login(options);
  }

  logout(): void {
    this.session.logout();
  }

  async exec(args: string[], stdin?: string): Promise<string> {
    const token = await this.session.getToken();
    const binaryPath = await ensureBinary('argocd', {
      binDir: this.app.binDir,
      log: (message) => process.stderr.write(`${message}\n`)
    });

    return execCli({
      service: this.name,
      binaryPath,
      env: this.env(token),
      args,
      stdin,
      redact: redactKubernetesSecrets,
      sizeHint: 'сузьте выборку: конкретное приложение вместо списка, --tail у логов, фильтры по namespace/kind.'
    });
  }

  /**
   * Окружение дочернего argocd.
   *
   * ARGOCD_SERVER — хост без схемы, так его ждёт CLI. Токен передаётся только
   * окружением: в argv он был бы виден в `ps` любому процессу пользователя.
   */
  private env(token: string): Record<string, string> {
    const opts = ['--grpc-web'];
    if (this.app.insecureSkipTlsVerify) opts.push('--insecure');

    const env: Record<string, string> = {
      // PATH нужен самому бинарнику, HOME — чтобы CLI не спотыкался о поиск
      // своего конфига (мы его не используем, но отсутствие HOME ломает путь).
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ARGOCD_SERVER: this.service.url.replace(/^https?:\/\//, ''),
      ARGOCD_AUTH_TOKEN: token,
      // --grpc-web обязателен: ingress-nginx проксирует в argocd-server обычный
      // HTTP/1.1 (configs.params.server.insecure: true), и чистый gRPC до него
      // не доходит.
      ARGOCD_OPTS: opts.join(' ')
    };

    // Go-бинарник читает корневые сертификаты не оттуда, откуда Node.
    if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    return env;
  }
}
