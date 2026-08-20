import type { AppConfig, KeycloakConfig } from '../../config.js';
import { ensureBinary } from '../../bootstrap/ensure-binary.js';
import { execCli } from '../exec.js';
import type { AuthStatus, LoginOptions, ServiceModule } from '../types.js';
import { KeycloakSession } from './session.js';
import { resolveTruststore, type Truststore } from './truststore.js';

/**
 * kcadm — picocli: глобальные опции (--config, --truststore, ...) обязаны
 * идти после имени подкоманды (get/create/...), иначе "Unknown options" ещё
 * до попытки их разобрать. Кладём их сразу после команды, а не в конец —
 * пользовательские args могут заканчиваться значением, которое ждёт данные
 * (например -s KEY=VALUE), и туда наши флаги лучше не втискивать.
 */
export const buildKcadmArgv = (
  args: string[],
  opts: { configPath: string; truststore?: Truststore }
): string[] => {
  const [command, ...rest] = args;
  const flags = [
    '--config',
    opts.configPath,
    ...(opts.truststore ? ['--truststore', opts.truststore.path, '--trustpass', opts.truststore.password] : [])
  ];
  return command ? [command, ...flags, ...rest] : [...flags, ...rest];
};

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

    const truststore = await resolveTruststore({
      serverUrl: this.service.url,
      binDir: this.app.binDir,
      insecure: this.app.insecureSkipTlsVerify
    });

    // --config — сессия MCP, не ~/.keycloak/kcadm.config.
    const argv = buildKcadmArgv(args, { configPath: this.service.kcadmConfigPath, truststore });

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
