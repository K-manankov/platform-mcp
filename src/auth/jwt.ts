/**
 * Разбор JWT без проверки подписи. Подпись проверяет сам сервис — нам полезны
 * только claim'ы exp (когда обновлять) и имя пользователя (для *_auth_status).
 */
export interface JwtClaims {
  exp?: number;
  sub?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  groups?: string[];
}

export const decodeJwt = (token: string): JwtClaims => {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as JwtClaims;
  } catch {
    return {};
  }
};

/** Момент истечения токена в миллисекундах epoch; 0, если claim exp отсутствует. */
export const expiresAtOf = (token: string): number => {
  const { exp } = decodeJwt(token);
  return typeof exp === 'number' ? exp * 1000 : 0;
};

export const usernameOf = (token: string): string | undefined => {
  const claims = decodeJwt(token);
  // useLoginAsID: true в dex.config кладёт логин GitLab в sub.
  return claims.preferred_username || claims.name || claims.email || claims.sub;
};
