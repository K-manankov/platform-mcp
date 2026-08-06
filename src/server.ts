import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';

import type { AppConfig } from './config.js';
import { ConfirmationStore } from './policy/confirm.js';
import { evaluate, normalizeVaultArgs } from './policy/gate.js';
import { AuthRequiredError, type ServiceModule, type ServiceName } from './services/types.js';

/** Имя аргумента с токеном подтверждения. Двойное подчёркивание — чтобы не пересечься с полями CLI. */
export const CONFIRM_ARG = '__confirm';

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const fail = (value: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: value }]
});

interface PendingLogin {
  promise: Promise<unknown>;
  url?: string;
}

export class PlatformMcpServer {
  private readonly server: Server;
  private readonly confirmations = new ConfirmationStore();
  /** Незавершённые интерактивные входы: они живут дольше одного вызова инструмента. */
  private readonly pendingLogins = new Map<ServiceName, PendingLogin>();

  constructor(
    private readonly config: AppConfig,
    private readonly services: ServiceModule[]
  ) {
    this.server = new Server(
      { name: 'platform-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }

  private service(name: string): ServiceModule | undefined {
    return this.services.find((candidate) => candidate.name === name);
  }

  private tools(): Tool[] {
    return this.services.flatMap((service): Tool[] => [
      {
        name: `${service.name}_exec`,
        description:
          `Выполнить команду ${service.name} (${service.url}) от имени вошедшего пользователя.\n\n` +
          service.execHelp,
        inputSchema: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Аргументы командной строки, по одному на элемент массива.'
            },
            stdin: {
              type: 'string',
              description: 'Данные на стандартный ввод команды, если она их читает.'
            },
            [CONFIRM_ARG]: {
              type: 'string',
              description:
                'Токен подтверждения. Заполняется только при повторном вызове, после явного ' +
                'согласия пользователя на мутирующую операцию.'
            }
          },
          required: ['args']
        }
      },
      {
        name: `${service.name}_login`,
        description:
          `Начать вход в ${service.title} через GitLab SSO. Возвращает ссылку сразу, не дожидаясь ` +
          `завершения входа: результат нужно проверить вызовом ${service.name}_auth_status.`,
        inputSchema: {
          type: 'object',
          properties: {
            noBrowser: {
              type: 'boolean',
              description: 'Не открывать браузер, только вернуть ссылку (SSH, devcontainer).'
            }
          }
        }
      },
      {
        name: `${service.name}_auth_status`,
        description:
          service.name === 'vault'
            ? 'Кто вошёл в Vault: username, role, policies, expiresAt. Начинайте с этого перед KV и sys/*.'
            : `Кто вошёл в ${service.title} и до какого момента действует токен.`,
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: `${service.name}_logout`,
        description: `Удалить сохранённую сессию ${service.title}.`,
        inputSchema: { type: 'object', properties: {} }
      }
    ]);
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools() }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      const match = /^(argocd|vault)_(exec|login|auth_status|logout)$/.exec(name);
      const service = match?.[1] ? this.service(match[1]) : undefined;
      if (!match || !service) return fail(`Неизвестный инструмент ${name}.`);

      try {
        switch (match[2]) {
          case 'auth_status':
            return await this.handleStatus(service);
          case 'logout':
            service.logout();
            this.pendingLogins.delete(service.name);
            return text(`Сессия ${service.title} удалена.`);
          case 'login':
            return await this.startLogin(service, args.noBrowser !== true);
          default:
            return await this.handleExec(service, args);
        }
      } catch (err) {
        if (err instanceof AuthRequiredError) return fail(err.message);
        return fail(`Ошибка при вызове ${name}: ${(err as Error).message}`);
      }
    });
  }

  private async handleStatus(service: ServiceModule): Promise<CallToolResult> {
    const status = await service.status();
    const pending = this.pendingLogins.get(service.name);
    return text(
      JSON.stringify(
        pending && !status.authenticated
          ? { ...status, loginInProgress: true, loginUrl: pending.url }
          : status,
        null,
        2
      )
    );
  }

  /**
   * Запускает вход и возвращает ссылку, НЕ дожидаясь его завершения.
   *
   * Ждать нельзя: человек ходит по SSO минуты, а у MCP-клиентов таймаут
   * запроса обычно 60 секунд — блокирующий вызов отваливался бы ровно тогда,
   * когда пользователь ещё вводит пароль. Результат забирается из
   * <сервис>_auth_status.
   */
  private async startLogin(service: ServiceModule, openBrowser: boolean): Promise<CallToolResult> {
    const running = this.pendingLogins.get(service.name);
    if (running) {
      return text(
        `Вход в ${service.title} уже запущен. Откройте ссылку и завершите вход, затем вызовите ` +
          `${service.name}_auth_status:\n\n${running.url ?? ''}`
      );
    }

    let publishUrl: (url: string) => void = () => undefined;
    const urlReady = new Promise<string>((resolve) => {
      publishUrl = resolve;
    });

    const pending: PendingLogin = {
      promise: Promise.resolve(),
      url: undefined
    };

    pending.promise = service
      .login({
        openBrowser,
        log: (message) => {
          process.stderr.write(`${message}\n`);
          const url = message.match(/https?:\/\/\S+/)?.[0];
          if (url) {
            pending.url = url;
            publishUrl(url);
          }
        }
      })
      .finally(() => {
        this.pendingLogins.delete(service.name);
      });

    this.pendingLogins.set(service.name, pending);
    // Вход может завершиться неудачей уже после ответа этого инструмента —
    // необработанное отклонение не должно ронять сервер.
    pending.promise.catch(() => undefined);

    // Ссылка появляется сразу; гонка со всем входом нужна на случай, когда он
    // падает раньше — например, discovery не достучался до сервиса.
    const url = await Promise.race([urlReady, pending.promise.then(() => pending.url ?? '')]);

    return text(
      `Откройте ссылку в браузере и войдите через GitLab:\n\n${url}\n\n` +
        `Покажите ссылку пользователю. После входа проверьте результат вызовом ` +
        `${service.name}_auth_status — этот инструмент завершения входа не ждёт. ` +
        'Ссылка действительна 5 минут.'
    );
  }

  private async handleExec(
    service: ServiceModule,
    rawArgs: Record<string, unknown>
  ): Promise<CallToolResult> {
    const args = rawArgs.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      return fail('Аргумент args обязателен и должен быть массивом строк.');
    }

    // Авторизация проверяется до политики: «нужно войти» — более полезный
    // ответ, чем «операция запрещена», когда верны обе причины.
    const status = await service.status();
    if (!status.authenticated) {
      return fail(
        `${status.reason ?? `Нет сессии ${service.title}.`} Вызовите инструмент ${service.name}_login.`
      );
    }

    const argv =
      service.name === 'vault' ? normalizeVaultArgs(args as string[]) : (args as string[]);

    const decision = evaluate(service.name, argv, this.config.policy);
    if (decision.kind === 'deny') return fail(decision.reason);

    if (decision.kind === 'confirm') {
      const gate = await this.gate(service, argv, decision.summary, rawArgs[CONFIRM_ARG]);
      if (gate) return gate;
    }

    const stdin = typeof rawArgs.stdin === 'string' ? rawArgs.stdin : undefined;
    return text(await service.exec(argv, stdin));
  }

  /** Возвращает результат, если вызов нужно прервать, и undefined — если можно выполнять. */
  private async gate(
    service: ServiceModule,
    argv: string[],
    summary: string,
    confirmToken: unknown
  ): Promise<CallToolResult | undefined> {
    const toolName = `${service.name}_exec`;
    // Отпечаток берётся от самих аргументов команды: подтверждали именно их.
    const fingerprintArgs = { args: argv };

    if (typeof confirmToken === 'string') {
      return this.confirmations.redeem(confirmToken, toolName, fingerprintArgs)
        ? undefined
        : fail(
            'Токен подтверждения не подошёл: он одноразовый, живёт 5 минут и привязан к ' +
              'конкретным аргументам. Повторите вызов без него, чтобы получить новый.'
          );
    }

    if (await this.askUser(service, summary)) return undefined;

    const token = this.confirmations.issue(toolName, fingerprintArgs);
    return text(
      `Требуется подтверждение пользователя: ${summary}\n\n` +
        'Покажите пользователю, что именно произойдёт, и дождитесь явного согласия. ' +
        `После согласия повторите вызов ${toolName} с теми же аргументами, добавив ` +
        `${CONFIRM_ARG}: "${token}". Токен действует 5 минут.`
    );
  }

  /**
   * Спрашиваем подтверждение через elicitation, если клиент это умеет.
   * Возвращает true только при явном согласии; всё остальное (отказ, отмена,
   * отсутствие поддержки, ошибка) — false, и тогда работает резервная схема
   * с токеном.
   */
  private async askUser(service: ServiceModule, summary: string): Promise<boolean> {
    if (!this.server.getClientCapabilities()?.elicitation) return false;
    try {
      const result = await this.server.elicitInput({
        message: `${service.title}: ${summary}. Выполнить?`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Подтверждаю', description: summary }
          },
          required: ['confirm']
        }
      });
      return result.action === 'accept' && result.content?.confirm === true;
    } catch {
      return false;
    }
  }
}
