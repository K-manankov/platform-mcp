import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildKcadmArgv } from './index.js';

describe('buildKcadmArgv', () => {
  it('кладёт --config сразу после подкоманды, не перед ней', () => {
    // kcadm (picocli) не разбирает глобальные опции, стоящие перед именем
    // подкоманды — "Unknown options: '--config'" ещё до разбора остального.
    deepStrictEqual(buildKcadmArgv(['get', 'realms'], { configPath: '/cfg' }), [
      'get',
      '--config',
      '/cfg',
      'realms'
    ]);
  });

  it('сохраняет пользовательские аргументы после команды как есть', () => {
    deepStrictEqual(
      buildKcadmArgv(['get', 'users', '-r', 'sonar-prod', '-q', 'username=alice'], { configPath: '/cfg' }),
      ['get', '--config', '/cfg', 'users', '-r', 'sonar-prod', '-q', 'username=alice']
    );
  });

  it('добавляет --truststore/--trustpass, когда truststore задан', () => {
    deepStrictEqual(
      buildKcadmArgv(['get', 'realms'], {
        configPath: '/cfg',
        truststore: { path: '/ts.p12', password: 'x' }
      }),
      ['get', '--config', '/cfg', '--truststore', '/ts.p12', '--trustpass', 'x', 'realms']
    );
  });

  it('не роняется на пустом массиве args', () => {
    deepStrictEqual(buildKcadmArgv([], { configPath: '/cfg' }), ['--config', '/cfg']);
  });
});
