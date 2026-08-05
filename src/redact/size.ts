/**
 * Ограничение размера ответа. `argocd app list` в большой инсталляции и
 * `argocd app manifests` на толстом приложении легко отдают сотни килобайт —
 * это съедает окно контекста целиком и обрывает диалог.
 */
export const DEFAULT_LIMIT_BYTES = 100_000;

export const capText = (text: string, hint: string, limit = DEFAULT_LIMIT_BYTES): string => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= limit) return text;

  // Режем по байтам, а не по символам: в кириллице символ занимает два байта,
  // и посимвольная обрезка вдвое превысила бы лимит.
  return (
    buf.subarray(0, limit).toString('utf8') +
    `\n\n[Ответ обрезан: ${buf.byteLength} байт из максимальных ${limit}. ${hint}]`
  );
};
