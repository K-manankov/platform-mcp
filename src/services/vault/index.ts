import type { AppConfig, ServiceConfig } from '../../config.js';
import { ensureBinary } from '../../bootstrap/ensure-binary.js';
import { redactVaultSecretValues, type RedactionResult } from '../../redact/secrets.js';
import { touchesVaultSecrets } from '../../policy/gate.js';
import { execCli } from '../exec.js';
import type { AuthStatus, LoginOptions, ServiceModule } from '../types.js';
import { VaultSession } from './session.js';

const EXEC_HELP = `Аргументы командной строки vault, массивом. Адрес и токен подставляются сервером — \
флаги -address, -tls-skip-verify запрещены, вход делается через vault_login.

Примеры:
  ["kv", "list", "kv/teams"]
  ["kv", "get", "kv/teams/team-a/postgres"]
  ["kv", "put", "kv/teams/team-a/postgres", "password=..."]
  ["policy", "read", "team-a"]
  ["read", "sys/mounts"]

Вывод по умолчанию в JSON (VAULT_FORMAT=json). Значения секретов вырезаются: возвращаются \
имена ключей и метаданные, но не содержимое — оно не должно попадать в контекст модели.`;

export class VaultService implements ServiceModule {
  readonly name = 'vault' as const;
  readonly title = 'Vault';
  readonly execHelp = EXEC_HELP;
  private readonly session: VaultSession;

  constructor(
    private readonly service: ServiceConfig,
    private readonly app: AppConfig
  ) {
    this.session = new VaultSession(service, app.vaultOidc);
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
    const binaryPath = await ensureBinary('vault', {
      binDir: this.app.binDir,
      log: (message) => process.stderr.write(`${message}\n`)
    });

    // Конфигурацию (sys/mounts, policy read, auth list) чистить не нужно и
    // вредно: там нет секретов, а вырезание сделало бы ответ бесполезным.
    const needsRedaction = !this.app.policy.allowSecretValues && touchesVaultSecrets(args);
    const redact = (value: unknown): RedactionResult =>
      needsRedaction ? redactVaultSecretValues(value) : { value, redacted: 0 };

    return execCli({
      service: this.name,
      binaryPath,
      env: this.env(token),
      args,
      stdin,
      redact,
      sizeHint: 'запросите конкретный путь вместо списка целиком.'
    });
  }

  private env(token: string): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      VAULT_ADDR: this.service.url,
      VAULT_TOKEN: token,
      // JSON по умолчанию: табличный вывод разбирать сложнее, а главное —
      // из него нельзя надёжно вырезать значения секретов.
      VAULT_FORMAT: 'json'
    };

    if (this.app.insecureSkipTlsVerify) env.VAULT_SKIP_VERIFY = 'true';
    if (process.env.SSL_CERT_FILE) env.VAULT_CACERT = process.env.SSL_CERT_FILE;
    return env;
  }
}
