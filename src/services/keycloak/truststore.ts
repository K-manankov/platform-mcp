import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import { requireJava } from '../../bootstrap/ensure-binary.js';

/**
 * Java (kcadm) не разделяет truststore с Node — Node доверяет внутреннему CA
 * через NODE_EXTRA_CA_CERTS (или системный стор), а JVM своим cacerts, где
 * этого CA нет. Отсюда "PKIX path building failed" даже при валидной сессии.
 *
 * Пароль хранилища — не секрет: это просто формат, которого требует kcadm
 * (--trustpass обязателен), сам файл содержит только публичные сертификаты.
 */
const TRUSTSTORE_PASSWORD = 'platform-mcp';

const keytoolPath = (): string => {
  const java = requireJava();
  return join(dirname(java), process.platform === 'win32' ? 'keytool.exe' : 'keytool');
};

const pemBlocksOf = (pem: string): string[] => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];

/**
 * TOFU: цепочка сертификатов, которую сервер реально отдаёт на хендшейке.
 * Используется только когда пользователь явно включил insecureSkipTlsVerify —
 * это тот же уровень доверия, что уже даёт Node NODE_TLS_REJECT_UNAUTHORIZED=0,
 * просто перенесённый в truststore, которого требует kcadm.
 */
const fetchServerCertChainPem = (serverUrl: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(serverUrl);
    const socket: TLSSocket = tlsConnect(
      {
        host: hostname,
        port: port ? Number(port) : 443,
        servername: hostname,
        rejectUnauthorized: false
      },
      () => {
        const seen = new Set<string>();
        const pems: string[] = [];
        const root = socket.getPeerCertificate(true);
        let cert: import('node:tls').DetailedPeerCertificate | undefined = root;
        while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          const body = cert.raw.toString('base64').replace(/(.{64})/g, '$1\n').trim();
          pems.push(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
          const current: import('node:tls').DetailedPeerCertificate = cert;
          const next: import('node:tls').DetailedPeerCertificate | undefined = current.issuerCertificate;
          cert = next && next.fingerprint256 !== current.fingerprint256 ? next : undefined;
        }
        socket.end();
        pems.length ? resolve(pems.join('')) : reject(new Error(`${serverUrl} не отдал сертификат при TLS-хендшейке.`));
      }
    );
    socket.on('error', reject);
  });

/** PKCS12-truststore из PEM, закэшированный по хешу содержимого — keytool не вызывается повторно. */
const buildTruststore = (pem: string, cacheKey: string, binDir: string): string => {
  const dir = join(binDir, 'kc-truststore');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const hash = createHash('sha256').update(pem).digest('hex').slice(0, 16);
  const path = join(dir, `${cacheKey}-${hash}.p12`);
  if (existsSync(path)) return path;

  const pemPath = `${path}.${process.pid}.pem`;
  writeFileSync(pemPath, pem, { mode: 0o600 });
  try {
    const blocks = pemBlocksOf(pem);
    blocks.forEach((block, i) => {
      const blockPath = `${pemPath}.${i}`;
      writeFileSync(blockPath, block, { mode: 0o600 });
      try {
        execFileSync(
          keytoolPath(),
          [
            '-importcert',
            '-noprompt',
            '-alias',
            `platform-mcp-ca-${i}`,
            '-file',
            blockPath,
            '-keystore',
            path,
            '-storetype',
            'PKCS12',
            '-storepass',
            TRUSTSTORE_PASSWORD
          ],
          { stdio: 'pipe' }
        );
      } finally {
        unlinkSync(blockPath);
      }
    });
  } finally {
    unlinkSync(pemPath);
  }
  return path;
};

export interface Truststore {
  path: string;
  password: string;
}

/**
 * Truststore для kcadm, если он нужен: сначала переиспользуем то, чему уже
 * доверяет Node (NODE_EXTRA_CA_CERTS — тот же канал, которым идут OIDC-запросы
 * при входе), иначе, если явно включён insecureSkipTlsVerify, берём
 * сертификат прямо с сервера (TOFU). Без того и другого — undefined, kcadm
 * идёт с системным cacerts как раньше.
 */
export const resolveTruststore = async (opts: {
  serverUrl: string;
  binDir: string;
  insecure: boolean;
}): Promise<Truststore | undefined> => {
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  if (extraCa && existsSync(extraCa)) {
    const pem = readFileSync(extraCa, 'utf8');
    return { path: buildTruststore(pem, 'extra-ca', opts.binDir), password: TRUSTSTORE_PASSWORD };
  }
  if (opts.insecure) {
    const pem = await fetchServerCertChainPem(opts.serverUrl);
    return { path: buildTruststore(pem, 'tofu', opts.binDir), password: TRUSTSTORE_PASSWORD };
  }
  return undefined;
};
