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
 *    mcpServers. command/args и ключи env обязаны совпадать. Значения env у
 *    Cursor — плейсхолдеры ${VAR} (variables в plugin.json), у Claude —
 *    литеральные дефолты: иначе Claude Code подставил бы пустой ${VAR} и
 *    сломал URL.
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
const cursorPlugin = read(`${PLUGIN}/.cursor-plugin/plugin.json`);
const claudeServers = read(`${PLUGIN}/.mcp.json`);
const cursorFile = read(`${PLUGIN}/mcp.json`);
const cursorServers = cursorFile.mcpServers;

if ('mcpServers' in claudeServers) {
  problems.push(
    `${PLUGIN}/.mcp.json должен быть плоской картой «имя → сервер», без обёртки mcpServers: ` +
      'именно так его читает Claude Code.'
  );
}

const variableDefaults = (() => {
  const props = cursorPlugin.variables?.properties;
  if (!props || typeof props !== 'object') return {};
  const out = {};
  for (const [name, schema] of Object.entries(props)) {
    if (schema && typeof schema === 'object' && 'default' in schema) {
      out[name] = schema.default;
    }
  }
  return out;
})();

/** Cursor ${KEY} + Claude-литерал = default из variables, либо значения равны. */
const envValuesCompatible = (key, cursorVal, claudeVal) => {
  if (cursorVal === claudeVal) return true;
  if (cursorVal === `\${${key}}` && claudeVal === variableDefaults[key]) return true;
  return false;
};

const compareServers = (claudeMap, cursorMap) => {
  if (!cursorMap) {
    problems.push(`${PLUGIN}/mcp.json должен содержать объект mcpServers — так его читает Cursor.`);
    return;
  }

  const claudeNames = Object.keys(claudeMap).sort();
  const cursorNames = Object.keys(cursorMap).sort();
  if (JSON.stringify(claudeNames) !== JSON.stringify(cursorNames)) {
    problems.push(
      `Имена серверов в ${PLUGIN}/.mcp.json и ${PLUGIN}/mcp.json различаются: ` +
        `Claude [${claudeNames.join(', ')}], Cursor [${cursorNames.join(', ')}].`
    );
    return;
  }

  for (const name of claudeNames) {
    const claude = claudeMap[name];
    const cursor = cursorMap[name];
    if (claude.command !== cursor.command || JSON.stringify(claude.args) !== JSON.stringify(cursor.args)) {
      problems.push(
        `Сервер «${name}»: command/args в ${PLUGIN}/.mcp.json и ${PLUGIN}/mcp.json различаются.`
      );
    }

    const claudeEnv = claude.env && typeof claude.env === 'object' ? claude.env : {};
    const cursorEnv = cursor.env && typeof cursor.env === 'object' ? cursor.env : {};
    const claudeKeys = Object.keys(claudeEnv).sort();
    const cursorKeys = Object.keys(cursorEnv).sort();
    if (JSON.stringify(claudeKeys) !== JSON.stringify(cursorKeys)) {
      problems.push(
        `Сервер «${name}»: набор ключей env различается — ` +
          `Claude [${claudeKeys.join(', ')}], Cursor [${cursorKeys.join(', ')}].`
      );
      continue;
    }

    for (const key of claudeKeys) {
      if (!envValuesCompatible(key, cursorEnv[key], claudeEnv[key])) {
        problems.push(
          `Сервер «${name}»: env.${key} не согласован. ` +
            `У Cursor ожидается "\${${key}}" (или тот же литерал), ` +
            `у Claude — default из variables (${JSON.stringify(variableDefaults[key])}) ` +
            `или то же значение. Сейчас Cursor=${JSON.stringify(cursorEnv[key])}, ` +
            `Claude=${JSON.stringify(claudeEnv[key])}.`
        );
      }
    }
  }
};

compareServers(claudeServers, cursorServers);

// Ссылка Cursor должна вести на его же файл, иначе он прочитает не ту форму.
const cursorRef = cursorPlugin.mcpServers;
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
