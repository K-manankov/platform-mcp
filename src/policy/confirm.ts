import { createHash, randomBytes } from 'node:crypto';

/**
 * Резервный механизм подтверждения для клиентов без поддержки elicitation.
 *
 * Первый вызов мутирующей команды возвращает описание последствий и
 * одноразовый токен; повторный вызов с тем же набором аргументов и этим
 * токеном выполняется. Токен привязан к аргументам, поэтому «подтвердил одно,
 * выполнил другое» не пройдёт, а придумать его самостоятельно агент не может.
 */
const TTL_MS = 5 * 60_000;

interface Pending {
  fingerprint: string;
  expiresAt: number;
}

export const fingerprint = (tool: string, args: Record<string, unknown>): string => {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return createHash('sha256').update(`${tool} ${stable}`).digest('hex');
};

export class ConfirmationStore {
  private readonly pending = new Map<string, Pending>();

  issue(tool: string, args: Record<string, unknown>): string {
    this.sweep();
    const token = randomBytes(9).toString('base64url');
    this.pending.set(token, {
      fingerprint: fingerprint(tool, args),
      expiresAt: Date.now() + TTL_MS
    });
    return token;
  }

  /** Одноразовая проверка: токен сгорает независимо от результата. */
  redeem(token: string, tool: string, args: Record<string, unknown>): boolean {
    this.sweep();
    const entry = this.pending.get(token);
    this.pending.delete(token);
    return !!entry && entry.expiresAt > Date.now() && entry.fingerprint === fingerprint(tool, args);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}
