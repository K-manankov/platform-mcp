import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { PINNED_CLI_VERSIONS } from '../config.js';
import { extractFromZip } from './unzip.js';

/**
 * Получение CLI-бинарников, которыми сервер ходит в сервисы.
 *
 * Скачивание живёт здесь, а не в postinstall-скрипте пакета, сознательно:
 * postinstall — известный канал доставки в атаках на цепочку поставки, и его
 * повсеместно отключают (`npm ci --ignore-scripts`), из-за чего установка
 * молча оставалась бы неполной. Поэтому бинарник докачивается лениво, при
 * первом реальном использовании, и всегда с проверкой контрольной суммы.
 */

export type BinaryName = 'argocd' | 'vault';

interface Platform {
  os: string;
  arch: string;
}

const platform = (): Platform => {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[
    process.platform as 'darwin' | 'linux' | 'win32'
  ];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as 'x64' | 'arm64'];
  if (!os || !arch) {
    throw new Error(
      `Платформа ${process.platform}/${process.arch} не поддерживается автоустановкой. ` +
        'Поставьте argocd и vault вручную — если они есть в PATH, сервер возьмёт их оттуда.'
    );
  }
  return { os, arch };
};

interface Asset {
  /** Имя файла в релизе — оно же ключ в файле контрольных сумм. */
  name: string;
  url: string;
  checksumUrl: string;
  /** Достать из скачанного исполняемый файл (для vault это распаковка ZIP). */
  unpack: (payload: Buffer) => Buffer;
}

const assetOf = (binary: BinaryName): Asset => {
  const { os, arch } = platform();
  const exe = os === 'windows' ? '.exe' : '';

  if (binary === 'argocd') {
    const version = PINNED_CLI_VERSIONS.argocd;
    const name = `argocd-${os}-${arch}${exe}`;
    return {
      name,
      url: `https://github.com/argoproj/argo-cd/releases/download/${version}/${name}`,
      checksumUrl: `https://github.com/argoproj/argo-cd/releases/download/${version}/cli_checksums.txt`,
      unpack: (payload) => payload
    };
  }

  const version = PINNED_CLI_VERSIONS.vault;
  const name = `vault_${version}_${os}_${arch}.zip`;
  return {
    name,
    url: `https://releases.hashicorp.com/vault/${version}/${name}`,
    checksumUrl: `https://releases.hashicorp.com/vault/${version}/vault_${version}_SHA256SUMS`,
    unpack: (payload) => extractFromZip(payload, `vault${exe}`)
  };
};

/** Ищем бинарник в PATH сами: `which` есть не везде, а спавнить ради этого шелл незачем. */
export const findInPath = (binary: BinaryName): string | undefined => {
  const exe = process.platform === 'win32' ? `${binary}.exe` : binary;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* нет здесь — идём дальше */
    }
  }
  return undefined;
};

const fetchBuffer = async (url: string, what: string): Promise<Buffer> => {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (cause) {
    throw new Error(
      `Не удалось скачать ${what} (${url}): ${(cause as Error).message}. ` +
        'Проверьте доступ в интернет либо поставьте бинарник вручную в PATH.',
      { cause }
    );
  }
  if (!res.ok) {
    throw new Error(`Не удалось скачать ${what} (${url}): HTTP ${res.status} ${res.statusText}.`);
  }
  return Buffer.from(await res.arrayBuffer());
};

/** Строки вида "<sha256>  <имя файла>" — формат общий у GitHub-релизов и HashiCorp. */
const checksumFor = (checksums: string, assetName: string): string => {
  for (const line of checksums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name === assetName) return hash.toLowerCase();
  }
  throw new Error(`В файле контрольных сумм нет записи для ${assetName}.`);
};

const download = async (binary: BinaryName, target: string, log: (m: string) => void): Promise<void> => {
  const asset = assetOf(binary);
  const version = PINNED_CLI_VERSIONS[binary];

  log(`platform-mcp: ${binary} ${version} не найден, скачиваю ${asset.url}`);

  const [payload, checksums] = await Promise.all([
    fetchBuffer(asset.url, `${binary} ${version}`),
    fetchBuffer(asset.checksumUrl, `контрольные суммы ${binary} ${version}`).then((buf) =>
      buf.toString('utf8')
    )
  ]);

  // Проверка ДО распаковки и до chmod +x: иначе это было бы «скачать из
  // интернета и выполнить» без каких-либо гарантий подлинности.
  const expected = checksumFor(checksums, asset.name);
  const actual = createHash('sha256').update(payload).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Контрольная сумма ${asset.name} не совпала: ожидалась ${expected}, получена ${actual}. ` +
        'Файл повреждён или подменён — установка прервана.'
    );
  }

  const executable = asset.unpack(payload);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // Пишем во временный файл и переименовываем: если два процесса докачивают
  // бинарник одновременно, никто не получит наполовину записанный файл.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, executable, { mode: 0o700 });
  chmodSync(tmp, 0o700);
  renameSync(tmp, target);

  log(`platform-mcp: ${binary} ${version} установлен в ${target} (SHA256 сверен)`);
};

/** Параллельные вызовы инструментов не должны качать один и тот же файл дважды. */
const inFlight = new Map<BinaryName, Promise<string>>();

export interface EnsureOptions {
  binDir: string;
  /** Куда писать сообщения о скачивании; в stdio-режиме MCP это обязан быть stderr. */
  log: (message: string) => void;
}

/**
 * Путь к исполняемому файлу CLI. Сначала PATH — то, что разработчик поставил
 * сам, менять не нужно; иначе закреплённая версия из кэша или скачивание.
 */
export const ensureBinary = async (binary: BinaryName, opts: EnsureOptions): Promise<string> => {
  const fromPath = findInPath(binary);
  if (fromPath) return fromPath;

  const exe = process.platform === 'win32' ? '.exe' : '';
  const target = join(opts.binDir, `${binary}-${PINNED_CLI_VERSIONS[binary]}${exe}`);
  if (existsSync(target)) return target;

  let pending = inFlight.get(binary);
  if (!pending) {
    pending = download(binary, target, opts.log)
      .then(() => target)
      .finally(() => inFlight.delete(binary));
    inFlight.set(binary, pending);
  }
  return pending;
};
