import { spawn } from 'node:child_process';

/**
 * Запуск CLI-бинарника.
 *
 * Аргументы всегда передаются массивом и НИКОГДА не склеиваются в строку:
 * shell здесь не участвует вообще (`shell: false` — умолчание spawn). Иначе
 * любой аргумент, пришедший от модели, был бы инъекцией команд — `;`, `$(...)`
 * и обратные кавычки исполнил бы шелл.
 *
 * Токены доступа передаются только через окружение. В argv их класть нельзя:
 * argv виден в `ps` любому процессу пользователя.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  env: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Предохранитель от команды, заливающей гигабайты в память. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export const run = async (
  binary: string,
  args: string[],
  opts: RunOptions
): Promise<RunResult> => {
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      // Наследовать окружение целиком нельзя: там лежат посторонние секреты
      // (в том числе токены других сервисов), а CLI они не нужны.
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let timedOut = false;

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (sizes[stream] >= limit) return;
      sizes[stream] += chunk.length;
      chunks[stream].push(chunk);
      if (sizes[stream] >= limit) child.kill('SIGKILL');
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error(`Не найден исполняемый файл ${binary}.`)
          : err
      );
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut
      });
    });

    // stdin закрываем всегда: без этого CLI, ожидающий ввод (например
    // `vault policy write name -`), повис бы до таймаута.
    child.stdin.on('error', () => undefined);
    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
};
