/**
 * Authentication module for FilmShell CLI
 * Extracted from src/index.ts
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { XboxAuthenticationClient } from '@dendotdev/conch';
import {
  HaloAuthenticationClient,
  HaloInfiniteClient,
  isSuccess,
} from '@dendotdev/grunt';
import type { Config, StoredTokens } from './types.js';
import { dim, green, red, yellow, bold } from './ui.js';

// Re-export color helpers for backward compatibility
export { dim, green, red, yellow, bold } from './ui.js';

const CONFIG_PATH = './config.json';
const TOKENS_PATH = './tokens.bin';

// Binary layout: [magic 2B "FS"][version 1B][salt 16B][iv 12B][authTag 16B][ciphertext ...]
const MAGIC = Buffer.from('FS');
const VERSION = 0x01;
const MAGIC_LEN = 2;
const VERSION_LEN = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC_LEN + VERSION_LEN + SALT_LEN + IV_LEN + TAG_LEN;
const AAD = Buffer.from('filmshell-tokens-v1');

function deriveKey(salt: Buffer): Buffer {
  const passphrase = hostname() + userInfo().username;
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    console.error('Error: config.json not found.');
    console.error('Copy config.example.json to config.json and set your client ID.');
    process.exit(1);
  }
  const data = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(data);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  if (!existsSync(TOKENS_PATH)) {
    return null;
  }
  try {
    const buf = await readFile(TOKENS_PATH);
    if (buf.length < HEADER_LEN) throw new Error('File too short');
    if (!buf.subarray(0, MAGIC_LEN).equals(MAGIC)) throw new Error('Bad magic');
    const version = buf[MAGIC_LEN];
    if (version !== VERSION) throw new Error(`Unsupported version: ${version}`);
    let off = MAGIC_LEN + VERSION_LEN;
    const salt = buf.subarray(off, off += SALT_LEN);
    const iv = buf.subarray(off, off += IV_LEN);
    const authTag = buf.subarray(off, off += TAG_LEN);
    const ciphertext = buf.subarray(off);
    const key = deriveKey(salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8')) as StoredTokens;
  } catch {
    console.warn(
      yellow('Warning: Failed to decrypt tokens. Deleting and re-authenticating.')
    );
    await unlink(TOKENS_PATH);
    return null;
  }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  const plaintext = JSON.stringify(tokens);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const versionBuf = Buffer.of(VERSION);
  await writeFile(TOKENS_PATH, Buffer.concat([MAGIC, versionBuf, salt, iv, authTag, ciphertext]));
}

export async function waitForAuthCode(redirectUri: string): Promise<string> {
  const url = new URL(redirectUri);
  const port = parseInt(url.port) || 3000;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = reqUrl.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
      }
    });

    server.listen(port, () => {
      // Silent - URL is already shown
    });

    server.on('error', reject);
  });
}

async function authenticate(config: Config): Promise<{ spartanToken: string; xuid: string; refreshToken: string; xblToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  const authUrl = xboxClient.generateAuthUrl(config.clientId, config.redirectUri);
  console.log(dim('Open this URL to sign in:'));
  console.log(authUrl);
  console.log('');

  const code = await waitForAuthCode(config.redirectUri);
  console.log(dim('Authenticating...'));

  const oauthToken = await xboxClient.requestOAuthToken(config.clientId, code, config.redirectUri);
  if (!oauthToken?.access_token) {
    throw new Error('Failed to get OAuth access token');
  }

  const userToken = await xboxClient.requestUserToken(oauthToken.access_token);
  if (!userToken?.Token) {
    throw new Error('Failed to get user token');
  }

  const xboxXstsToken = await xboxClient.requestXstsToken(userToken.Token);
  if (!xboxXstsToken?.Token) {
    throw new Error('Failed to get Xbox XSTS token');
  }

  const xuid = xboxXstsToken.DisplayClaims?.xui?.[0]?.xid;
  const userHash = xboxXstsToken.DisplayClaims?.xui?.[0]?.uhs;
  if (!xuid || !userHash) {
    throw new Error('Failed to get XUID/userHash from Xbox XSTS token');
  }

  const xblToken = `XBL3.0 x=${userHash};${xboxXstsToken.Token}`;

  const relyingParty = HaloAuthenticationClient.getRelyingParty();
  const haloXstsToken = await xboxClient.requestXstsToken(userToken.Token, relyingParty as "http://xboxlive.com");
  if (!haloXstsToken?.Token) {
    throw new Error('Failed to get Halo XSTS token');
  }

  const haloAuthClient = new HaloAuthenticationClient();
  const spartanTokenResponse = await haloAuthClient.getSpartanToken(haloXstsToken.Token);
  if (!spartanTokenResponse?.token) {
    throw new Error('Failed to get Spartan token');
  }

  return {
    spartanToken: spartanTokenResponse.token,
    xuid,
    refreshToken: oauthToken.refresh_token ?? '',
    xblToken,
  };
}

async function refreshAuthentication(config: Config, refreshToken: string): Promise<{ spartanToken: string; xuid: string; refreshToken: string; xblToken: string }> {
  const xboxClient = new XboxAuthenticationClient();

  console.log('Refreshing authentication...');
  const oauthToken = await xboxClient.refreshOAuthToken(config.clientId, refreshToken, config.redirectUri);

  if (!oauthToken?.access_token) {
    throw new Error('Failed to refresh OAuth token');
  }

  const userToken = await xboxClient.requestUserToken(oauthToken.access_token);
  if (!userToken?.Token) {
    throw new Error('Failed to get user token');
  }

  const xboxXstsToken = await xboxClient.requestXstsToken(userToken.Token);
  if (!xboxXstsToken?.Token) {
    throw new Error('Failed to get Xbox XSTS token');
  }

  const xuid = xboxXstsToken.DisplayClaims?.xui?.[0]?.xid;
  const userHash = xboxXstsToken.DisplayClaims?.xui?.[0]?.uhs;
  if (!xuid || !userHash) {
    throw new Error('Failed to get XUID/userHash from Xbox XSTS token');
  }

  const xblToken = `XBL3.0 x=${userHash};${xboxXstsToken.Token}`;

  const relyingParty = HaloAuthenticationClient.getRelyingParty();
  const haloXstsToken = await xboxClient.requestXstsToken(userToken.Token, relyingParty as "http://xboxlive.com");
  if (!haloXstsToken?.Token) {
    throw new Error('Failed to get Halo XSTS token');
  }

  const haloAuthClient = new HaloAuthenticationClient();
  const spartanTokenResponse = await haloAuthClient.getSpartanToken(haloXstsToken.Token);
  if (!spartanTokenResponse?.token) {
    throw new Error('Failed to get Spartan token');
  }

  return {
    spartanToken: spartanTokenResponse.token,
    xuid,
    refreshToken: oauthToken.refresh_token ?? refreshToken,
    xblToken,
  };
}

export interface AuthenticatedClient {
  client: HaloInfiniteClient;
  xuid: string;
}

export async function getAuthenticatedClient(
  onStatus?: (msg: string) => void
): Promise<AuthenticatedClient> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));

  const config = await loadConfig();
  let tokens = await loadTokens();
  let needsAuth = true;

  if (tokens && tokens.spartanToken && tokens.refreshToken) {
    if (tokens.spartanTokenExpiry && Date.now() < tokens.spartanTokenExpiry - 300000) {
      needsAuth = false;
    } else {
      try {
        log('Refreshing authentication...');
        const refreshed = await refreshAuthentication(config, tokens.refreshToken);
        tokens = {
          refreshToken: refreshed.refreshToken,
          spartanToken: refreshed.spartanToken,
          spartanTokenExpiry: Date.now() + 3600000,
          xuid: refreshed.xuid,
          xblToken: refreshed.xblToken,
        };
        await saveTokens(tokens);
        needsAuth = false;
      } catch {
        log('Session expired, re-authenticating...');
      }
    }
  }

  if (needsAuth) {
    log('Waiting for browser sign-in...');
    const authResult = await authenticate(config);
    tokens = {
      refreshToken: authResult.refreshToken,
      spartanToken: authResult.spartanToken,
      spartanTokenExpiry: Date.now() + 3600000,
      xuid: authResult.xuid,
      xblToken: authResult.xblToken,
    };
    await saveTokens(tokens);
  }

  if (!tokens) {
    throw new Error('Authentication failed.');
  }

  // Create initial client to fetch clearance token
  let client = new HaloInfiniteClient({
    spartanToken: tokens.spartanToken,
    xuid: tokens.xuid,
  });

  // Fetch clearance/flight token for UGC access
  log('Fetching clearance token...');
  const clearanceResult = await client.settings.getClearanceLevel();

  if (isSuccess(clearanceResult) && clearanceResult.result.flightId) {
    const flightId = clearanceResult.result.flightId;
    log(`Flight ID: ${flightId}`);

    // Recreate client with clearance token
    client = new HaloInfiniteClient({
      spartanToken: tokens.spartanToken,
      xuid: tokens.xuid,
      clearanceToken: flightId,
    });
  } else {
    log('Could not fetch clearance token, some UGC features may not work.');
  }

  return { client, xuid: tokens.xuid };
}
