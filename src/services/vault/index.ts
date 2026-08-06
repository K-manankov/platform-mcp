import type { AppConfig, ServiceConfig } from '../../config.js';
import { ensureBinary } from '../../bootstrap/ensure-binary.js';
import {
  redactVaultSecretValues,
  redactVaultTokenMaterial,
  type RedactionResult
} from '../../redact/secrets.js';
import { normalizeVaultArgs, touchesVaultSecrets } from '../../policy/gate.js';
import { execCli, type ExecHintContext } from '../exec.js';
import type { AuthStatus, LoginOptions, ServiceModule } from '../types.js';
import { VaultSession } from './session.js';

const EXEC_HELP = `Аргументы командной строки vault, массивом. Адрес и токен подставляются сервером — \
флаги -address, -tls-skip-verify запрещены, вход делается через vault_login.

Порядок работы:
  1) vault_auth_status — username, role, policies (без этого KV не угадывать)
  2) ["token", "lookup"] — детали токена (не lookup-self: это HTTP API, в CLI нет)
  3) ["kv", "list", "kv/..."] / ["kv", "get", "kv/..."] — только если policies дают доступ

Примеры:
  ["token", "lookup"]
  ["kv", "list", "kv/teams"]
  ["kv", "get", "kv/teams/team-a/postgres"]
  ["kv", "put", "kv/teams/team-a/postgres", "password=..."]
  ["policy", "read", "team-a"]

Не используйте ["read", "sys/mounts"] для discovery: у обычных OIDC-пользователей часто 403.
Exit code 2 у list / «No value found» — путь пуст или нет list ACL; не перебирайте -mount=secret и т.п.

Вывод по умолчанию в JSON (VAULT_FORMAT=json). Значения секретов и token id вырезаются.`;

/** Подсказки, которые экономят ходы агента при типичных отказах Vault CLI. */
export const vaultExecHint = (ctx: ExecHintContext): string | undefined => {
  const body = `${ctx.stderr}\n${ctx.stdout}`.trim();
  const lower = body.toLowerCase();

  if (/permission denied|preflight capability|\b403\b/.test(lower)) {
    return (
      'нет ACL на этот путь. Проверьте policies в vault_auth_status. ' +
      'sys/mounts у обычных OIDC-пользователей часто недоступен — не используйте для discovery.'
    );
  }

  if (
    ctx.code === 2 &&
    (/no value found/.test(lower) || body === '' || /^\{\s*\}\s*$/.test(body) || body === '{}')
  ) {
    return (
      'путь пуст или нет list capability. Сверьте policies в vault_auth_status; ' +
      'не перебирайте варианты mount (-mount=secret и т.п.).'
    );
  }

  if (/usage:|unknown command|invalid command|no help topic/.test(lower)) {
    return (
      'канон CLI: ["token","lookup"] (не lookup-self). ' +
      'HTTP-имена вроде lookup-self в Vault CLI не существуют.'
    );
  }

  return undefined;
};

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

  status(): Promise<AuthStatus> {
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

    const argv = normalizeVaultArgs(args);

    // Token material — всегда. Значения KV — только когда команда их отдаёт
    // (там уже чистятся auth/wrap_info, дублировать не нужно).
    const needsSecretRedaction = !this.app.policy.allowSecretValues && touchesVaultSecrets(argv);
    const redact = (value: unknown): RedactionResult =>
      needsSecretRedaction ? redactVaultSecretValues(value) : redactVaultTokenMaterial(value);

    return execCli({
      service: this.name,
      binaryPath,
      env: this.env(token),
      args: argv,
      stdin,
      redact,
      hint: vaultExecHint,
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
