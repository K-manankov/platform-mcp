import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PolicyConfig } from '../config.js';
import { describe as describeCommand, evaluate, isReadOnly, leadingWords, normalizeVaultArgs, touchesVaultSecrets } from './gate.js';

const policy = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  requireConfirmation: true,
  denyApplications: ['argocd', 'vault'],
  denyVaultPaths: [],
  allowSecretValues: false,
  ...overrides
});

describe('leadingWords', () => {
  it('берёт подкоманды до первого флага', () => {
    deepStrictEqual(leadingWords(['app', 'get', 'api', '-o', 'json']), ['app', 'get', 'api']);
  });

  it('возвращает пустой список, если команда начинается с флага', () => {
    deepStrictEqual(leadingWords(['--help']), []);
  });
});

describe('isReadOnly', () => {
  it('распознаёт читающие команды argocd', () => {
    strictEqual(isReadOnly('argocd', ['app', 'list', '-o', 'json']), true);
    strictEqual(isReadOnly('argocd', ['app', 'logs', 'api']), true);
    strictEqual(isReadOnly('argocd', ['version']), true);
  });

  it('распознаёт читающие команды vault', () => {
    strictEqual(isReadOnly('vault', ['kv', 'get', 'kv/teams/team-a/db']), true);
    strictEqual(isReadOnly('vault', ['read', 'sys/mounts']), true);
    strictEqual(isReadOnly('vault', ['status']), true);
    strictEqual(isReadOnly('vault', ['token', 'lookup']), true);
    strictEqual(isReadOnly('vault', ['token', 'lookup-self']), true);
  });

  it('мутирующий глагол перевешивает читающий', () => {
    strictEqual(isReadOnly('argocd', ['app', 'sync', 'api']), false);
    strictEqual(isReadOnly('vault', ['kv', 'put', 'kv/teams/team-a/db', 'p=1']), false);
    // "actions" помечен мутирующим: agent actions list читается редко, а
    // actions run меняет ресурс — замыкаем в безопасную сторону.
    strictEqual(isReadOnly('argocd', ['app', 'actions', 'list', 'api']), false);
  });

  it('незнакомая команда не считается читающей', () => {
    strictEqual(isReadOnly('argocd', ['gpg', 'add']), false);
    strictEqual(isReadOnly('vault', ['plugin', 'reload']), false);
  });
});

describe('normalizeVaultArgs', () => {
  it('меняет token lookup-self на token lookup', () => {
    deepStrictEqual(normalizeVaultArgs(['token', 'lookup-self']), ['token', 'lookup']);
  });

  it('не трогает остальные команды', () => {
    deepStrictEqual(normalizeVaultArgs(['kv', 'list', 'kv/teams']), ['kv', 'list', 'kv/teams']);
  });
});

describe('evaluate', () => {
  it('пропускает token lookup-self без подтверждения', () => {
    deepStrictEqual(evaluate('vault', ['token', 'lookup-self'], policy()), { kind: 'allow' });
  });

  it('пропускает чтение без подтверждения', () => {
    deepStrictEqual(evaluate('argocd', ['app', 'list'], policy()), { kind: 'allow' });
  });

  it('требует подтверждения на мутацию', () => {
    const decision = evaluate('argocd', ['app', 'sync', 'team-a-api'], policy());
    strictEqual(decision.kind, 'confirm');
  });

  it('незнакомую команду замыкает на подтверждение, а не на выполнение', () => {
    strictEqual(evaluate('vault', ['plugin', 'reload'], policy()).kind, 'confirm');
  });

  it('запрещает менять инфраструктурные приложения', () => {
    const decision = evaluate('argocd', ['app', 'delete', 'argocd'], policy());
    strictEqual(decision.kind, 'deny');
  });

  it('не мешает читать инфраструктурные приложения', () => {
    deepStrictEqual(evaluate('argocd', ['app', 'get', 'argocd'], policy()), { kind: 'allow' });
  });

  it('запрещает подмену адреса сервиса', () => {
    // Главный смысл проверки: в окружении дочернего процесса лежит рабочий
    // токен, и чужой адрес отправил бы его наружу.
    strictEqual(evaluate('argocd', ['app', 'list', '--server', 'evil.example'], policy()).kind, 'deny');
    strictEqual(evaluate('vault', ['kv', 'get', '-address=http://evil', 'kv/a'], policy()).kind, 'deny');
  });

  it('запрещает вход и команды, которые не завершаются', () => {
    strictEqual(evaluate('vault', ['login', '-method=oidc'], policy()).kind, 'deny');
    strictEqual(evaluate('vault', ['agent'], policy()).kind, 'deny');
    strictEqual(evaluate('argocd', ['admin', 'export'], policy()).kind, 'deny');
    strictEqual(evaluate('argocd', ['app', 'logs', 'api', '--follow'], policy()).kind, 'deny');
  });

  it('запрещает катастрофические операции Vault', () => {
    strictEqual(evaluate('vault', ['operator', 'seal'], policy()).kind, 'deny');
    // Соседняя команда из той же группы под запрет не попадает.
    strictEqual(evaluate('vault', ['operator', 'raft', 'list-peers'], policy()).kind, 'confirm');
  });

  it('закрывает пути Vault из denyVaultPaths', () => {
    const decision = evaluate(
      'vault',
      ['kv', 'get', 'kv/infra/root'],
      policy({ denyVaultPaths: ['kv/infra/'] })
    );
    strictEqual(decision.kind, 'deny');
  });

  it('не даёт вынести значение секрета мимо вырезания', () => {
    strictEqual(evaluate('vault', ['kv', 'get', '-field=password', 'kv/a'], policy()).kind, 'deny');
    strictEqual(evaluate('vault', ['kv', 'get', '-format=table', 'kv/a'], policy()).kind, 'deny');
    // Разрешили значения явно — ограничение снимается.
    strictEqual(
      evaluate('vault', ['kv', 'get', '-field=password', 'kv/a'], policy({ allowSecretValues: true }))
        .kind,
      'allow'
    );
    // К конфигурации, где секретов нет, ограничение не относится.
    strictEqual(evaluate('vault', ['read', '-format=table', 'sys/mounts'], policy()).kind, 'allow');
  });

  it('отклоняет пустой вызов', () => {
    strictEqual(evaluate('argocd', [], policy()).kind, 'deny');
  });
});

describe('touchesVaultSecrets', () => {
  it('находит команды, отдающие значения секретов', () => {
    strictEqual(touchesVaultSecrets(['kv', 'get', 'kv/teams/team-a/db']), true);
    strictEqual(touchesVaultSecrets(['read', 'kv/data/teams/team-a/db']), true);
    strictEqual(touchesVaultSecrets(['unwrap', 'hvs.token']), true);
  });

  it('не относит к секретам то, что вырезание только испортило бы', () => {
    // В ответе этих команд лежат имена, версии и конфигурация — вычистив их,
    // мы отдали бы агенту бесполезную пустышку.
    strictEqual(touchesVaultSecrets(['kv', 'list', 'kv/teams']), false);
    strictEqual(touchesVaultSecrets(['kv', 'metadata', 'get', 'kv/teams/team-a/db']), false);
    strictEqual(touchesVaultSecrets(['list', 'kv/metadata/teams']), false);
    strictEqual(touchesVaultSecrets(['read', 'sys/mounts']), false);
    strictEqual(touchesVaultSecrets(['policy', 'read', 'team-a']), false);
  });
});

describe('describe', () => {
  it('прячет значения key=value, чтобы секрет не попал в текст подтверждения', () => {
    strictEqual(
      describeCommand('vault', ['kv', 'put', 'kv/teams/a/db', 'password=hunter2']),
      'vault kv put kv/teams/a/db password=<скрыто>'
    );
  });
});
