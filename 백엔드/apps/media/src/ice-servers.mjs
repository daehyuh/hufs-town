import { createHmac, randomUUID } from 'node:crypto';

const MAX_SERVERS = 8;
const MAX_URLS_PER_SERVER = 8;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 21_600;
const MIN_SHARED_SECRET_LENGTH = 32;
const MAX_CREDENTIAL_TTL_SECONDS = 604_800;

export function parseIceServers(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MEDIA_ICE_SERVERS_JSON must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SERVERS) {
    throw new Error(`MEDIA_ICE_SERVERS_JSON must contain at most ${MAX_SERVERS} servers`);
  }

  return parsed.map((server, index) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`Invalid ICE server at index ${index}`);
    }
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (
      !urls.length ||
      urls.length > MAX_URLS_PER_SERVER ||
      urls.some(
        url =>
          typeof url !== 'string' ||
          !/^(stun|turn|turns):/i.test(url) ||
          url.length > 512,
      )
    ) {
      throw new Error(`Invalid ICE server URLs at index ${index}`);
    }

    const value = { urls };
    for (const key of ['username', 'credential']) {
      if (server[key] !== undefined) {
        if (typeof server[key] !== 'string' || server[key].length > 512) {
          throw new Error(`Invalid ICE server ${key} at index ${index}`);
        }
        value[key] = server[key];
      }
    }
    if ((value.username === undefined) !== (value.credential === undefined)) {
      throw new Error(`ICE server username and credential must be configured together at index ${index}`);
    }
    return value;
  });
}

export function createIceServersProvider(
  raw,
  {
    sharedSecret = '',
    credentialTtlSeconds = DEFAULT_CREDENTIAL_TTL_SECONDS,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    nonce = randomUUID,
  } = {},
) {
  const servers = parseIceServers(raw);
  if (typeof sharedSecret !== 'string') {
    throw new Error('MEDIA_TURN_SHARED_SECRET must be a string');
  }
  if (sharedSecret && sharedSecret.length < MIN_SHARED_SECRET_LENGTH) {
    throw new Error(
      `MEDIA_TURN_SHARED_SECRET must contain at least ${MIN_SHARED_SECRET_LENGTH} characters`,
    );
  }
  const ttl = Number(credentialTtlSeconds);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 60 ||
    ttl > MAX_CREDENTIAL_TTL_SECONDS
  ) {
    throw new Error(
      `MEDIA_TURN_CREDENTIAL_TTL_SECONDS must be between 60 and ${MAX_CREDENTIAL_TTL_SECONDS}`,
    );
  }

  const hasTurn = server => server.urls.some(url => /^turns?:/i.test(url));
  for (const [index, server] of servers.entries()) {
    if (hasTurn(server) && !sharedSecret && !server.username) {
      throw new Error(
        `TURN ICE server at index ${index} requires MEDIA_TURN_SHARED_SECRET or static credentials`,
      );
    }
    if (hasTurn(server) && sharedSecret && server.username) {
      throw new Error(
        `TURN ICE server at index ${index} cannot combine static credentials with MEDIA_TURN_SHARED_SECRET`,
      );
    }
  }

  return () =>
    servers.map(server => {
      if (!hasTurn(server) || !sharedSecret) {
        return { ...server, urls: [...server.urls] };
      }
      const issuedAt = nowSeconds();
      const expiresAt = issuedAt + ttl;
      if (
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < 0 ||
        !Number.isSafeInteger(expiresAt)
      ) {
        throw new Error('TURN credential expiry is invalid');
      }
      const username = `${expiresAt}:${nonce()}`;
      const credential = createHmac('sha1', sharedSecret)
        .update(username)
        .digest('base64');
      return { ...server, urls: [...server.urls], username, credential };
    });
}
