import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactKubernetesSecrets, redactVaultSecretValues, redactVaultTokenMaterial } from './secrets.js';

describe('redactKubernetesSecrets', () => {
  it('вырезает data и stringData у Secret', () => {
    const { value, redacted } = redactKubernetesSecrets({
      kind: 'Secret',
      metadata: { name: 'db' },
      data: { password: 'aHVudGVyMg==' },
      stringData: { user: 'admin' }
    });

    strictEqual(redacted, 2);
    const result = value as { data: Record<string, string>; metadata: unknown };
    match(result.data.password ?? '', /вырезано/);
    // Имена ключей и метаданные остаются: без них ответ бесполезен.
    deepStrictEqual(result.metadata, { name: 'db' });
  });

  it('достаёт секреты из манифестов, упакованных в строку', () => {
    // Ровно тот случай, ради которого нужна рекурсия по строкам: Argo CD
    // отдаёт манифест строкой с JSON внутри.
    const { value, redacted } = redactKubernetesSecrets({
      items: [{ liveState: JSON.stringify({ kind: 'Secret', data: { token: 'c2VjcmV0' } }) }]
    });

    strictEqual(redacted, 1);
    const live = (value as { items: Array<{ liveState: string }> }).items[0]?.liveState ?? '';
    match(live, /вырезано/);
    strictEqual(live.includes('c2VjcmV0'), false);
  });

  it('не трогает обычные ресурсы', () => {
    const source = { kind: 'ConfigMap', data: { level: 'debug' } };
    const { value, redacted } = redactKubernetesSecrets(structuredClone(source));
    strictEqual(redacted, 0);
    deepStrictEqual(value, source);
  });
});

describe('redactVaultSecretValues', () => {
  it('вырезает значения KV v2, оставляя ключи и метаданные', () => {
    const { value, redacted } = redactVaultSecretValues({
      data: {
        data: { password: 'hunter2', user: 'admin' },
        metadata: { version: 3, created_time: '2026-08-05T00:00:00Z' }
      }
    });

    strictEqual(redacted, 2);
    const result = value as { data: { data: Record<string, string>; metadata: unknown } };
    deepStrictEqual(Object.keys(result.data.data), ['password', 'user']);
    strictEqual(result.data.data.password?.includes('hunter2'), false);
    deepStrictEqual(result.data.metadata, { version: 3, created_time: '2026-08-05T00:00:00Z' });
  });

  it('вырезает значения KV v1', () => {
    const { value, redacted } = redactVaultSecretValues({ data: { password: 'hunter2' } });
    strictEqual(redacted, 1);
    match((value as { data: Record<string, string> }).data.password ?? '', /вырезано/);
  });

  it('вырезает токены вне data', () => {
    const { value, redacted } = redactVaultSecretValues({
      auth: { client_token: 'hvs.CAESI', accessor: 'abc', lease_duration: 3600 }
    });
    strictEqual(redacted, 2);
    const auth = (value as { auth: Record<string, unknown> }).auth;
    strictEqual(auth.client_token === 'hvs.CAESI', false);
    strictEqual(auth.lease_duration, 3600);
  });
});

describe('redactVaultTokenMaterial', () => {
  it('вырезает data.id и accessor у token lookup, оставляя policies', () => {
    const { value, redacted } = redactVaultTokenMaterial({
      data: {
        id: 'hvs.CAESIIvtaeB2',
        accessor: '2LuUPjXo',
        display_name: 'oidc-kmanankov',
        policies: ['default'],
        identity_policies: ['infra-k8s-ro'],
        meta: { role: 'default' },
        ttl: 2763969
      }
    });

    strictEqual(redacted, 2);
    const data = (value as { data: Record<string, unknown> }).data;
    match(String(data.id), /вырезано/);
    match(String(data.accessor), /вырезано/);
    strictEqual(data.display_name, 'oidc-kmanankov');
    deepStrictEqual(data.policies, ['default']);
    deepStrictEqual(data.identity_policies, ['infra-k8s-ro']);
    strictEqual(data.ttl, 2763969);
  });
});
