#!/usr/bin/env node
/**
 * Версия пакета продублирована в манифестах плагина, и разъехаться они могут
 * молча: Claude Code и Cursor берут версию из своего plugin.json и по ней
 * решают, обновлять ли установленный плагин. Если там останется старая, у
 * пользователя будет свежий сервер и «неизменившийся» плагин.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'package.json',
  'plugins/platform-mcp/.claude-plugin/plugin.json',
  'plugins/platform-mcp/.cursor-plugin/plugin.json'
];

const versions = FILES.map((file) => {
  const { version } = JSON.parse(readFileSync(join(root, file), 'utf8'));
  return { file, version };
});

const expected = versions[0].version;
const mismatched = versions.filter((entry) => entry.version !== expected);

if (mismatched.length > 0) {
  process.stderr.write('Версии разъехались:\n');
  for (const { file, version } of versions) {
    process.stderr.write(`  ${file}: ${version ?? '(не задана)'}\n`);
  }
  process.stderr.write(`\nПриведите все три к ${expected} (значение из package.json).\n`);
  process.exit(1);
}

process.stdout.write(`Версия ${expected} совпадает во всех манифестах.\n`);
