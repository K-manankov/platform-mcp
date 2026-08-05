import type { PolicyConfig } from '../config.js';
import type { ServiceName } from '../services/types.js';

/**
 * Классификация команды ДО её запуска.
 *
 * Инструмент один на сервис и принимает произвольные аргументы CLI, поэтому
 * списка «мутирующих инструментов» по именам, как было бы у набора узких
 * инструментов, здесь не существует. Решение принимается по глаголу команды,
 * и правило намеренно замкнуто в безопасную сторону: незнакомая команда
 * считается мутирующей и требует подтверждения.
 *
 * Это защита от ошибок агента, а не граница безопасности: в текущей
 * конфигурации (`g, infra/k8s, role:admin` в Argo CD, политика admin в Vault)
 * разработчик и так администратор и может сделать то же самое руками.
 */

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; summary: string };

const isFlag = (token: string): boolean => token.startsWith('-');

/** Имя флага без ведущих дефисов и без значения: vault принимает и -addr, и --addr. */
const flagName = (token: string): string =>
  token.replace(/^-+/, '').split('=')[0]?.toLowerCase() ?? '';

/**
 * Подкоманды идут до первого флага: и argocd, и vault построены на cobra,
 * где путь команды всегда предшествует её флагам.
 */
export const leadingWords = (args: string[]): string[] => {
  const words: string[] = [];
  for (const token of args) {
    if (isFlag(token)) break;
    words.push(token);
  }
  return words;
};

const READ_VERBS: Record<ServiceName, Set<string>> = {
  argocd: new Set([
    'list',
    'get',
    'diff',
    'history',
    'logs',
    'manifests',
    'resources',
    'describe',
    'version'
  ]),
  vault: new Set([
    'read',
    'list',
    'get',
    'lookup',
    'status',
    'version',
    'capabilities',
    'subkeys',
    'metadata'
  ])
};

const MUTATING_VERBS: Record<ServiceName, Set<string>> = {
  argocd: new Set([
    'create',
    'delete',
    'set',
    'unset',
    'add',
    'rm',
    'remove',
    'sync',
    'rollback',
    'patch',
    'edit',
    'terminate-op',
    'actions',
    'wait',
    'generate-spec',
    'import',
    'export'
  ]),
  vault: new Set([
    'write',
    'put',
    'patch',
    'delete',
    'destroy',
    'undelete',
    'rollback',
    'enable',
    'disable',
    'create',
    'revoke',
    'renew',
    'tune',
    'move',
    'remove',
    'rotate',
    'generate',
    'restore',
    'unwrap',
    'seal',
    'unseal',
    'step-down'
  ])
};

/**
 * Команды, которые не выполняются вообще.
 *
 * Три причины: вход, которым управляет сам сервер (login/logout); команды,
 * которые не завершаются и повесили бы вызов (server, agent, monitor);
 * и операции, отказ которых кладёт хранилище целиком (operator seal, rekey).
 */
const DENIED_COMMANDS: Record<ServiceName, Array<{ path: string[]; reason: string }>> = {
  argocd: [
    { path: ['login'], reason: 'входом управляет сам сервер — вызовите argocd_login.' },
    { path: ['logout'], reason: 'выходом управляет сам сервер — вызовите argocd_logout.' },
    { path: ['relogin'], reason: 'входом управляет сам сервер — вызовите argocd_login.' },
    {
      path: ['admin'],
      reason:
        'группа admin управляет самим Argo CD (экспорт/импорт состояния, доступ к его Redis и настройкам). ' +
        'Такие вещи делаются вручную и осознанно, а не через агента.'
    }
  ],
  vault: [
    { path: ['login'], reason: 'входом управляет сам сервер — вызовите vault_login.' },
    { path: ['server'], reason: 'это запуск самого Vault, а не обращение к нему.' },
    { path: ['agent'], reason: 'команда не завершается и повесила бы вызов.' },
    { path: ['proxy'], reason: 'команда не завершается и повесила бы вызов.' },
    { path: ['monitor'], reason: 'команда не завершается и повесила бы вызов.' },
    {
      path: ['operator', 'seal'],
      reason: 'запечатывание Vault останавливает выдачу секретов всему кластеру.'
    },
    {
      path: ['operator', 'step-down'],
      reason: 'принудительная смена лидера — операция дежурного, а не агента.'
    },
    { path: ['operator', 'init'], reason: 'инициализация выполняется один раз вручную.' },
    {
      path: ['operator', 'rekey'],
      reason: 'перевыпуск ключей Шамира ломает распечатывание, если довести его до конца неверно.'
    },
    {
      path: ['operator', 'generate-root'],
      reason: 'выпуск root-токена делается вручную и с последующим отзывом.'
    },
    { path: ['operator', 'migrate'], reason: 'миграция хранилища выполняется вручную.' }
  ]
};

/**
 * Флаги, переопределяющие адрес сервиса и параметры доверия.
 *
 * Это не про удобство: в окружении дочернего процесса лежит рабочий токен, и
 * `-address=http://чужой-хост` отправил бы его наружу. Единственный адрес
 * задаётся конфигурацией сервера.
 */
const BLOCKED_FLAGS: Record<ServiceName, Record<string, string>> = {
  argocd: {
    server: 'адрес Argo CD задаётся конфигурацией сервера (ARGOCD_BASE_URL).',
    'auth-token': 'токен подставляет сам сервер из вашей SSO-сессии.',
    config: 'путь к конфигурации CLI переопределять нельзя.',
    core: 'режим core ходит в Kubernetes API мимо Argo CD и его прав.'
  },
  vault: {
    address: 'адрес Vault задаётся конфигурацией сервера (VAULT_ADDR).',
    addr: 'адрес Vault задаётся конфигурацией сервера (VAULT_ADDR).',
    'tls-skip-verify': 'проверка TLS настраивается сервером (PLATFORM_MCP_INSECURE).',
    'ca-cert': 'доверенный корневой сертификат задаётся через NODE_EXTRA_CA_CERTS.'
  }
};

const startsWithPath = (words: string[], path: string[]): boolean =>
  path.every((segment, i) => words[i] === segment);

/** Значения вида key=value могут содержать сам секрет — в описание их не пускаем. */
const maskAssignments = (token: string): string => {
  const eq = token.indexOf('=');
  return eq > 0 ? `${token.slice(0, eq)}=<скрыто>` : token;
};

export const describe = (service: ServiceName, args: string[]): string =>
  `${service} ${args.map(maskAssignments).join(' ')}`.trim();

/**
 * Возвращает ли команда ЗНАЧЕНИЯ секретов.
 *
 * Условие намеренно узкое. Вырезание портит ответ, если применить его не туда:
 * у `kv list` в data лежат имена ключей, у `kv metadata get` — версии, у
 * `sys/mounts` и `policy read` — конфигурация. Ни то, ни другое, ни третье
 * секретом не является, а вычищенный ответ агенту бесполезен.
 *
 * Значения отдают ровно три случая: `kv get`, `read` по KV-пути (тот же
 * секрет через сырой API) и `unwrap` (в обёртке может лежать что угодно).
 */
export const touchesVaultSecrets = (args: string[]): boolean => {
  const words = leadingWords(args);
  if (words[0] === 'kv') return words[1] === 'get';
  if (words[0] === 'unwrap') return true;
  if (words[0] === 'read') {
    return args.some(
      (token) => !isFlag(token) && /^kv\//.test(token) && !token.startsWith('kv/metadata/')
    );
  }
  return false;
};

/**
 * Флаги, которыми можно вынести значение секрета мимо вырезания.
 *
 * `-field=password` печатает голое значение вместо JSON, а `-format=table`
 * отдаёт таблицу, из которой значения не вырезать — в обоих случаях секрет
 * ушёл бы в контекст модели, несмотря на включённую редакцию.
 */
const secretOutputLeak = (args: string[], policy: PolicyConfig): string | undefined => {
  if (policy.allowSecretValues || !touchesVaultSecrets(args)) return undefined;

  for (const token of args) {
    if (!isFlag(token)) continue;
    const name = flagName(token);
    const value = token.split('=')[1]?.toLowerCase();

    if (name === 'field') {
      return (
        'Флаг -field печатает значение секрета в сыром виде, в обход вырезания. ' +
        'Запросите секрет без него — вернутся имена ключей и метаданные.'
      );
    }
    if (name === 'format' && value && value !== 'json') {
      return (
        `Формат вывода ${value} не поддерживается для команд с секретами: значения вырезаются ` +
        'только из JSON. Уберите флаг или используйте -format=json.'
      );
    }
  }
  return undefined;
};

export const isReadOnly = (service: ServiceName, args: string[]): boolean => {
  const words = leadingWords(args);
  if (words.some((word) => MUTATING_VERBS[service].has(word))) return false;
  return words.some((word) => READ_VERBS[service].has(word));
};

export const evaluate = (
  service: ServiceName,
  args: string[],
  policy: PolicyConfig
): Decision => {
  if (args.length === 0) {
    return { kind: 'deny', reason: 'Пустой список аргументов: нечего выполнять.' };
  }

  const words = leadingWords(args);

  for (const { path, reason } of DENIED_COMMANDS[service]) {
    if (startsWithPath(words, path)) {
      return { kind: 'deny', reason: `Команда «${service} ${path.join(' ')}» запрещена: ${reason}` };
    }
  }

  for (const token of args) {
    if (!isFlag(token)) continue;
    const blocked = BLOCKED_FLAGS[service][flagName(token)];
    if (blocked) {
      return { kind: 'deny', reason: `Флаг ${token} запрещён: ${blocked}` };
    }
  }

  // Логи в режиме слежения не завершаются сами и висели бы до таймаута.
  if (service === 'argocd' && words.includes('logs')) {
    const follow = args.find((token) => isFlag(token) && ['f', 'follow'].includes(flagName(token)));
    if (follow) {
      return {
        kind: 'deny',
        reason: `Флаг ${follow} (слежение за логами) не поддерживается: команда не завершается. Запросите логи без него.`
      };
    }
  }

  if (service === 'vault') {
    const denied = policy.denyVaultPaths.find((prefix) =>
      args.some((token) => !isFlag(token) && token.startsWith(prefix))
    );
    if (denied) {
      return {
        kind: 'deny',
        reason: `Путь «${denied}» закрыт политикой (denyVaultPaths).`
      };
    }

    const leak = secretOutputLeak(args, policy);
    if (leak) return { kind: 'deny', reason: leak };
  }

  if (isReadOnly(service, args)) return { kind: 'allow' };

  if (service === 'argocd') {
    const application = policy.denyApplications.find((name) => args.includes(name));
    if (application) {
      return {
        kind: 'deny',
        reason:
          `Приложение «${application}» защищено политикой (denyApplications). Это инфраструктурное ` +
          'приложение — меняйте его через Git и merge request, а не через агента.'
      };
    }
  }

  if (!policy.requireConfirmation) return { kind: 'allow' };

  return { kind: 'confirm', summary: describe(service, args) };
};
