/**
 * Вырезание секретов из ответов CLI.
 *
 * Две разные задачи:
 *
 * 1. Argo CD отдаёт манифесты как есть, в том числе Secret'ы, а base64 — это не
 *    шифрование. Отдельная сложность: манифесты приезжают СТРОКАМИ с JSON
 *    внутри (поля manifest, liveState, targetState), и без разбора таких строк
 *    редакция пропустила бы ровно те ответы, ради которых она нужна.
 *
 * 2. Vault по своей природе отдаёт секреты в открытом виде. Здесь вырезаются
 *    значения, но СОХРАНЯЮТСЯ ключи: агенту почти всегда нужно знать, какие
 *    поля есть у секрета, а не их содержимое.
 */

const redactedLabel = (value: unknown): string => {
  const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
  return size > 0 ? `<вырезано: ${size} байт>` : '<вырезано>';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface RedactionResult {
  value: unknown;
  redacted: number;
}

const redactValues = (node: Record<string, unknown>, counter: { n: number }): void => {
  for (const key of Object.keys(node)) {
    node[key] = redactedLabel(node[key]);
    counter.n += 1;
  }
};

const redactSecretBody = (node: Record<string, unknown>, counter: { n: number }): void => {
  for (const field of ['data', 'stringData'] as const) {
    const body = node[field];
    if (isRecord(body)) redactValues(body, counter);
  }
};

/** Строка похожа на упакованный JSON-объект — стоит попробовать разобрать. */
const looksLikeJsonObject = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.length > 2;
};

const walk = (value: unknown, counter: { n: number }): unknown => {
  if (typeof value === 'string') {
    if (!looksLikeJsonObject(value)) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    const before = counter.n;
    const cleaned = walk(parsed, counter);
    // Перепаковываем, только если что-то действительно вырезали: иначе исходная
    // строка вернулась бы с переформатированным JSON без всякой пользы.
    return counter.n > before ? JSON.stringify(cleaned) : value;
  }

  if (Array.isArray(value)) return value.map((item) => walk(item, counter));
  if (!isRecord(value)) return value;

  const isSecret = value.kind === 'Secret';
  if (isSecret) redactSecretBody(value, counter);

  for (const key of Object.keys(value)) {
    // data/stringData у Secret уже обработаны — повторно ходить туда незачем.
    if (isSecret && (key === 'data' || key === 'stringData')) continue;
    // Обёртка ResourceDiff в managed-resources сама имеет kind: "Secret",
    // а сам манифест лежит рядом в liveState/targetState — поэтому обход
    // остальных полей обязателен и для Secret'ов.
    value[key] = walk(value[key], counter);
  }
  return value;
};

/**
 * Рекурсивно заменяет значения в Secret.data/stringData, в том числе внутри
 * строк с упакованным JSON. Мутирует переданный объект — он приходит из
 * свежего JSON.parse и больше нигде не используется.
 */
export const redactKubernetesSecrets = (value: unknown): RedactionResult => {
  const counter = { n: 0 };
  const result = walk(value, counter);
  return { value: result, redacted: counter.n };
};

/**
 * Вырезает значения секретов из ответа `vault ... -format=json`.
 *
 * Форма ответа Vault: полезная нагрузка лежит в `data`, а у KV v2 — во
 * вложенном `data.data`. Различать их важно: у KV v2 рядом в `data.metadata`
 * лежат версии и время изменения, которые агенту нужны и секретом не являются.
 *
 * Ответы sys-эндпоинтов (`sys/mounts`, `auth list`, `policy read`) — это
 * конфигурация, а не секреты, поэтому вырезание применяется только к ответам
 * KV-путей; решение принимается вызывающей стороной по самой команде.
 */
export const redactVaultSecretValues = (value: unknown): RedactionResult => {
  const counter = { n: 0 };
  if (!isRecord(value)) return { value, redacted: 0 };

  const data = value.data;
  if (isRecord(data)) {
    const nested = data.data;
    if (isRecord(nested)) {
      // KV v2: секрет во вложенном data, metadata оставляем как есть.
      redactValues(nested, counter);
    } else {
      // KV v1 либо `vault read` по KV-пути: сам data и есть секрет.
      redactValues(data, counter);
    }
  }

  // Токены и обёртки приезжают вне data — их тоже нельзя отдавать в контекст.
  for (const field of ['auth', 'wrap_info'] as const) {
    const node = value[field];
    if (!isRecord(node)) continue;
    for (const key of ['client_token', 'token', 'accessor', 'wrapping_token'] as const) {
      if (typeof node[key] === 'string') {
        node[key] = redactedLabel(node[key]);
        counter.n += 1;
      }
    }
  }

  return { value, redacted: counter.n };
};
