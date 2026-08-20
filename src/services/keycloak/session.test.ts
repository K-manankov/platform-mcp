import { deepStrictEqual, ok } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { writeKcadmConfig } from './session.js';

// Известные kcadm 26.x полям RealmConfigData (org.keycloak.client.cli.config):
// secret, signingToken, initialToken, clientId, expiresAt, clients, token,
// grantTypeForAuthentication, refreshExpiresAt, refreshToken, sigExpiresAt.
// serverUrl/realm сюда не входят — при их наличии kcadm падает с
// UnrecognizedPropertyException ещё до первого запроса.
const KNOWN_REALM_FIELDS = new Set([
  'secret',
  'signingToken',
  'initialToken',
  'clientId',
  'expiresAt',
  'clients',
  'token',
  'grantTypeForAuthentication',
  'refreshExpiresAt',
  'refreshToken',
  'sigExpiresAt'
]);

describe('writeKcadmConfig', () => {
  it('пишет только поля, которые kcadm умеет разбирать', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kcadm-config-test-'));
    const path = join(dir, 'kcadm.config');
    try {
      writeKcadmConfig(path, {
        serverUrl: 'https://auth.infra.sonar-corp.ru',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 123
      });

      const config = JSON.parse(readFileSync(path, 'utf8'));
      const realmData = config.endpoints['https://auth.infra.sonar-corp.ru'].master;

      for (const key of Object.keys(realmData)) {
        ok(KNOWN_REALM_FIELDS.has(key), `неизвестное kcadm поле в конфиге realmData: ${key}`);
      }
      deepStrictEqual(realmData.token, 'access');
      deepStrictEqual(realmData.refreshToken, 'refresh');
      // На верхнем уровне (ConfigData), в отличие от RealmConfigData вложенного
      // объекта, serverUrl/realm как раз обязательны — иначе kcadm не знает,
      // какой endpoint "текущий": "No server specified".
      deepStrictEqual(config.serverUrl, 'https://auth.infra.sonar-corp.ru');
      deepStrictEqual(config.realm, 'master');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
