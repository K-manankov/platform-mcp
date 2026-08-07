#!/usr/bin/env node
import { applyTlsPolicy, loadConfig, type AppConfig } from './config.js';
import { PlatformMcpServer } from './server.js';
import { ArgoCdService } from './services/argocd/index.js';
import { KeycloakService } from './services/keycloak/index.js';
import { VaultService } from './services/vault/index.js';
import type { ServiceModule } from './services/types.js';

const USAGE = `platform-mcp — MCP-сервер для Argo CD, Vault и Keycloak с SSO-входом.

  platform-mcp                       MCP-сервер поверх stdio (так его запускает редактор)
  platform-mcp login [сервис]        интерактивный вход, --no-browser для headless
  platform-mcp status [сервис]       кто вошёл и до какого момента действует токен
  platform-mcp logout [сервис]       удалить сохранённую сессию

Сервис — argocd, vault или keycloak; без него команда применяется ко всем настроенным.

Адреса берутся из ARGOCD_BASE_URL, VAULT_ADDR, KEYCLOAK_BASE_URL либо из ~/.config/platform-mcp/config.json.`;

const buildServices = (config: AppConfig): ServiceModule[] => {
  const services: ServiceModule[] = [];
  if (config.argocd) services.push(new ArgoCdService(config.argocd, config));
  if (config.vault) services.push(new VaultService(config.vault, config));
  if (config.keycloak) services.push(new KeycloakService(config.keycloak, config));
  return services;
};

/** Сервисы, к которым применяется команда: явно названный или все настроенные. */
const selected = (services: ServiceModule[], rest: string[]): ServiceModule[] => {
  const name = rest.find((arg) => !arg.startsWith('-'));
  if (!name) return services;

  const match = services.find((service) => service.name === name);
  if (!match) {
    throw new Error(
      `Неизвестный или ненастроенный сервис «${name}». Доступны: ${
        services.map((service) => service.name).join(', ') || 'ни одного'
      }.`
    );
  }
  return [match];
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  // До любого сетевого вызова: переменную должны унаследовать и дочерние процессы.
  applyTlsPolicy(config);
  const services = buildServices(config);

  switch (command) {
    case undefined: {
      await new PlatformMcpServer(config, services).start();
      return;
    }

    case 'login': {
      const openBrowser = !rest.includes('--no-browser');
      for (const service of selected(services, rest)) {
        const status = await service.login({
          openBrowser,
          log: (message) => process.stdout.write(`${message}\n`)
        });
        process.stdout.write(
          `${service.title}: вход выполнен (${status.username ?? 'пользователь'}), ` +
            `токен действует до ${status.expiresAt}\n`
        );
      }
      return;
    }

    case 'status': {
      const targets = selected(services, rest);
      const report = Object.fromEntries(
        await Promise.all(
          targets.map(async (service) => [service.name, await service.status()] as const)
        )
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    case 'logout': {
      for (const service of selected(services, rest)) {
        service.logout();
        process.stdout.write(`${service.title}: сессия удалена.\n`);
      }
      return;
    }

    default:
      process.stderr.write(`Неизвестная команда: ${command}\n\n${USAGE}\n`);
      process.exitCode = 2;
  }
};

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
