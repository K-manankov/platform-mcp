import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfirmationStore } from './confirm.js';

describe('ConfirmationStore', () => {
  it('пропускает вызов с выданным токеном', () => {
    const store = new ConfirmationStore();
    const args = { args: ['app', 'sync', 'api'] };
    const token = store.issue('argocd_exec', args);
    strictEqual(store.redeem(token, 'argocd_exec', args), true);
  });

  it('токен одноразовый', () => {
    const store = new ConfirmationStore();
    const args = { args: ['app', 'sync', 'api'] };
    const token = store.issue('argocd_exec', args);
    store.redeem(token, 'argocd_exec', args);
    strictEqual(store.redeem(token, 'argocd_exec', args), false);
  });

  it('не пускает «подтвердил одно, выполнил другое»', () => {
    const store = new ConfirmationStore();
    const token = store.issue('argocd_exec', { args: ['app', 'sync', 'api'] });
    strictEqual(store.redeem(token, 'argocd_exec', { args: ['app', 'delete', 'api'] }), false);
  });

  it('не принимает токен от другого инструмента', () => {
    const store = new ConfirmationStore();
    const args = { args: ['kv', 'delete', 'kv/a'] };
    const token = store.issue('vault_exec', args);
    strictEqual(store.redeem(token, 'argocd_exec', args), false);
  });

  it('не принимает выдуманный токен', () => {
    const store = new ConfirmationStore();
    strictEqual(store.redeem('придуманный', 'argocd_exec', { args: ['app', 'sync'] }), false);
  });
});
