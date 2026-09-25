import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discover } from './oidc.js';

describe('Keycloak OIDC discovery', () => {
  it('keeps the public issuer while querying metadata on the internal admin host', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        issuer: 'https://auth.sonar-corp.ru/realms/master',
        authorization_endpoint:
          'https://auth.sonar-corp.ru/realms/master/protocol/openid-connect/auth',
        token_endpoint: 'https://auth.sonar-corp.ru/realms/master/protocol/openid-connect/token',
        scopes_supported: ['openid', 'profile', 'email', 'offline_access']
      });
    };

    try {
      const endpoints = await discover('https://auth.infra.sonar-corp.ru/');
      strictEqual(
        requestedUrl,
        'https://auth.infra.sonar-corp.ru/realms/master/.well-known/openid-configuration'
      );
      strictEqual(endpoints.issuer, 'https://auth.sonar-corp.ru/realms/master');
      strictEqual(
        endpoints.authorizationEndpoint,
        'https://auth.sonar-corp.ru/realms/master/protocol/openid-connect/auth'
      );
      strictEqual(
        endpoints.tokenEndpoint,
        'https://auth.sonar-corp.ru/realms/master/protocol/openid-connect/token'
      );
      deepStrictEqual(endpoints.scopes, ['openid', 'profile', 'email', 'offline_access']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
