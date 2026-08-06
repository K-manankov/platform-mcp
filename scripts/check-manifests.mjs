#!/usr/bin/env node
/**
 * Сверка манифестов плагина между собой.
 *
 * Два повода, по которым они расходятся молча:
 *
 * 1. Версия продублирована в plugin.json обоих клиентов. И Claude Code, и
 *    Cursor решают по ней, обновлять ли установленный плагин: со старой
 *    версией у пользователя останется прежний плагин при свежем пакете.
 *
 * 2. Описание сервера лежит в двух файлах разной формы. Claude Code читает
 *    .mcp.json как плоскую карту «имя → сервер», Cursor — mcp.json с обёрткой
 *    mcpServers (так устроены рабочие плагины обоих клиентов). Содержимое
 *    обязано совпадать, иначе клиенты получат разные адреса или разные
 *    переменные, и разойдутся они незаметно.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'plugins/platform-mcp';

const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

const problems = [];

// --- версии ---
const VERSIONED = [
  'package.json',
  `${PLUGIN}/.claude-plugin/plugin.json`,
  `${PLUGIN}/.cursor-plugin/plugin.json`
];

const versions = VERSIONED.map((file) => ({ file, version: read(file).version }));
const expected = versions[0].version;

if (versions.some((entry) => entry.version !== expected)) {
  problems.push(
    'Версии разъехались:\n' +
      versions.map(({ file, version }) => `  ${file}: ${version ?? '(не задана)'}`).join('\n') +
      `\n  Приведите все три к ${expected} (значение из package.json).`
  );
}

// --- описание сервера ---
const claudeServers = read(`${PLUGIN}/.mcp.json`);
const cursorFile = read(`${PLUGIN}/mcp.json`);
const cursorServers = cursorFile.mcpServers;

if ('mcpServers' in claudeServers) {
  problems.push(
    `${PLUGIN}/.mcp.json должен быть плоской картой «имя → сервер», без обёртки mcpServers: ` +
      'именно так его читает Claude Code.'
  );
}

if (!cursorServers) {
  problems.push(`${PLUGIN}/mcp.json должен содержать объект mcpServers — так его читает Cursor.`);
} else if (JSON.stringify(claudeServers) !== JSON.stringify(cursorServers)) {
  problems.push(
    `Описания сервера в ${PLUGIN}/.mcp.json и ${PLUGIN}/mcp.json различаются. ` +
      'Содержимое обязано совпадать — отличается только форма файла.'
  );
}

// Ссылка Cursor должна вести на его же файл, иначе он прочитает не ту форму.
const cursorRef = read(`${PLUGIN}/.cursor-plugin/plugin.json`).mcpServers;
if (cursorRef !== './mcp.json') {
  problems.push(
    `В ${PLUGIN}/.cursor-plugin/plugin.json поле mcpServers должно указывать на "./mcp.json", ` +
      `сейчас там ${JSON.stringify(cursorRef)}.`
  );
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `Манифесты согласованы: версия ${expected}, описание сервера совпадает в обеих формах.\n`
);
