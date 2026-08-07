import type { AppConfig, KeycloakConfig } from '../../config.js';
import { ensureBinary } from '../../bootstrap/ensure-binary.js';
import { execCli } from '../exec.js';
import type { AuthStatus, LoginOptions, ServiceModule } from '../types.js';
import { KeycloakSession } from './session.js';

const EXEC_HELP = `Аргументы командной строки kcadm, массивом. Адрес и токен подставляются сервером — \
флаги --server, --config, --no-config запрещены, вход делается через keycloak_login (FreeIPA в realm master).

Примеры:
  ["get", "realms"]
  ["get", "realms/sonar-prod/clients", "-q", "clientId=demo-frontend"]
  ["get", "users", "-r", "sonar-prod", "-q", "username=alice"]
  ["create", "clients", "-r", "sonar-prod", "-s", "clientId=demo", "-s", "enabled=true"]

Мутации через CLI расходятся с GitOps (keycloak-operator): предпочтительны CR в deploy/ \
или platform/keycloak-config/. Агент получит предупреждение, но команда выполнится.

Для kcadm нужна Java 17+ (скачивается дистрибутив Keycloak, если kcadm нет в PATH).`;

export class KeycloakService implements ServiceModule {
  readonly name = 'keycloak' as const;
  readonly title = 'Keycloak';
  readonly execHelp = EXEC_HELP;
  private readonly session: KeycloakSession;

  constructor(
    private readonly service: KeycloakConfig,
    private readonly app: AppConfig
  ) {
    this.session = new KeycloakSession(service);
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
    await this.session.getToken();
    const binaryPath = await ensureBinary('kcadm', {
      binDir: this.app.binDir,
      log: (message) => process.stderr.write(`${message}\n`)
    });

    // --config первым: сессия MCP, не ~/.keycloak/kcadm.config.
    const argv = ['--config', this.service.kcadmConfigPath, ...args];

    return execCli({
      service: this.name,
      binaryPath,
      env: this.env(),
      args: argv,
      stdin,
      redact: (value) => ({ value, redacted: 0 }),
      sizeHint:
        'сузьте выборку: -r realm, -q фильтр, конкретный путь ресурса вместо полного списка.'
    });
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? ''
    };
    if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
    if (process.env.JAVA) env.JAVA = process.env.JAVA;
    // Java читает SSL_CERT_FILE не всегда; оставляем на случай кастомного truststore.
    if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
    return env;
  }
}
