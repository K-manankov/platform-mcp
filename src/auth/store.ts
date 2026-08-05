import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Сессии хранятся в собственных файлах, а НЕ в ~/.config/argocd/config и не в
 * ~/.vault-token.
 *
 * Причина у обоих сервисов одна: провайдер ротирует токен при обновлении, и
 * общий с обычным CLI файл приводил бы к тому, что `argocd`/`vault` в терминале
 * и этот сервер инвалидировали бы сессии друг другу.
 */
export interface StoredSession {
  /** Адрес сервиса, которому принадлежит токен. */
  url: string;
  /** Токен для похода в сервис: id_token у Argo CD, client_token у Vault. */
  token: string;
  /** epoch ms; для Argo CD из claim exp, для Vault из lease_duration. */
  expiresAt: number;
  /** Только Argo CD: refresh-токен OIDC. У Vault обновление идёт через renew-self. */
  refreshToken?: string;
  /** Только Vault: можно ли продлевать токен через auth/token/renew-self. */
  renewable?: boolean;
  /** Кто вошёл — для *_auth_status. */
  username?: string;
}

export const loadSession = (path: string): StoredSession | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredSession;
  } catch {
    return null;
  }
};

export const saveSession = (path: string, session: StoredSession): void => {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Пишем через временный файл: иначе одновременное обновление из двух
  // процессов может оставить на диске половину JSON.
  const tmp = join(dir, `.session.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
};

export const clearSession = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    /* уже нет — и хорошо */
  }
};
