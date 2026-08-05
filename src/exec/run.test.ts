import { match, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from './run.js';

const node = process.execPath;

describe('run', () => {
  it('передаёт аргументы как есть, не отдавая их шеллу', async () => {
    // Ключевая проверка: аргументы приходят от модели, и если бы между нами и
    // бинарником был шелл, эта строка выполнила бы постороннюю команду.
    const injection = '$(touch /tmp/pwned); echo hi | cat';
    const result = await run(node, ['-e', 'process.stdout.write(process.argv[1] ?? "")', injection], {
      env: { PATH: process.env.PATH ?? '' }
    });

    strictEqual(result.code, 0);
    strictEqual(result.stdout, injection);
  });

  it('отдаёт дочернему процессу только заданное окружение', async () => {
    process.env.PLATFORM_MCP_TEST_LEAK = 'секрет-соседнего-сервиса';
    try {
      const result = await run(node, ['-e', 'process.stdout.write(String(process.env.PLATFORM_MCP_TEST_LEAK))'], {
        env: { PATH: process.env.PATH ?? '', VAULT_TOKEN: 'x' }
      });
      strictEqual(result.stdout, 'undefined');
    } finally {
      delete process.env.PLATFORM_MCP_TEST_LEAK;
    }
  });

  it('возвращает код и stderr неуспешной команды', async () => {
    const result = await run(node, ['-e', 'process.stderr.write("нет доступа"); process.exit(2)'], {
      env: { PATH: process.env.PATH ?? '' }
    });
    strictEqual(result.code, 2);
    match(result.stderr, /нет доступа/);
  });

  it('передаёт stdin и закрывает его', async () => {
    const result = await run(
      node,
      ['-e', 'process.stdin.on("data", (c) => process.stdout.write(c))'],
      { env: { PATH: process.env.PATH ?? '' }, stdin: 'полезная нагрузка' }
    );
    strictEqual(result.stdout, 'полезная нагрузка');
  });

  it('не ждёт вечно команду, которая не завершается', async () => {
    const result = await run(node, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200
    });
    strictEqual(result.timedOut, true);
  });

  it('закрывает stdin, даже если данных нет — иначе команда повисла бы', async () => {
    const result = await run(
      node,
      ['-e', 'const c=[];process.stdin.on("data",(d)=>c.push(d));process.stdin.on("end",()=>process.stdout.write("ввод закрыт:"+c.length))'],
      { env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5000 }
    );
    strictEqual(result.timedOut, false);
    strictEqual(result.stdout, 'ввод закрыт:0');
  });
});
