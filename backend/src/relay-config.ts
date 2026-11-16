/**
 * Where the Worker relay URL lives
 * ================================
 * An operator should not have to open `.env` and invent a variable name to try a
 * relay, so the URL can also be saved from the Roxy panel. Precedence is the same
 * as the rest of the app — environment first, then `.env`, then whatever the panel
 * saved — so an install that pins the value with an environment variable cannot be
 * silently changed from the browser.
 *
 * The file lives in the data directory (mode 0600) alongside the proxy list and is
 * outside the deployment archive, so redeploying never clobbers it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readDotEnvOverlay } from './config.js';

const FILE_NAME = 'relay.json';

function dataDir(): string {
  const configured = (process.env.ROXY_DATA_DIR || '').trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), 'data');
}

export function relayConfigPath(): string {
  return path.join(dataDir(), FILE_NAME);
}

/** What the panel saved, or '' when nothing has been saved. */
export function readSavedRelayUrl(): string {
  try {
    const raw = fs.readFileSync(relayConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === 'string' ? parsed.url.trim() : '';
  } catch {
    return '';
  }
}

/** `environment`, `dotenv`, `panel` or '' — the panel shows which one won. */
export function relaySource(): 'environment' | 'dotenv' | 'panel' | '' {
  if ((process.env.ELFURA_UPSTREAM_RELAY ?? '').trim()) return 'environment';
  if ((readDotEnvOverlay().ELFURA_UPSTREAM_RELAY ?? '').trim()) return 'dotenv';
  if (readSavedRelayUrl()) return 'panel';
  return '';
}

/**
 * The relay URL in force. Read on every request rather than cached at boot, so a
 * URL saved in the panel takes effect immediately instead of after a restart.
 * A filesystem read per request is cheap next to the outbound request itself, and
 * this keeps "save" and "works" the same moment for an operator watching the panel.
 */
export function currentRelayUrl(): string {
  const fromEnv = (process.env.ELFURA_UPSTREAM_RELAY ?? '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const fromDotEnv = (readDotEnvOverlay().ELFURA_UPSTREAM_RELAY ?? '').trim();
  if (fromDotEnv) return fromDotEnv.replace(/\/+$/, '');
  return readSavedRelayUrl().replace(/\/+$/, '');
}

/** The Worker's shared secret, kept beside the URL. Only ever compared, never logged. */
export function readRelayToken(): string {
  const fromEnv = (process.env.ELFURA_RELAY_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromDotEnv = (readDotEnvOverlay().ELFURA_RELAY_TOKEN ?? '').trim();
  if (fromDotEnv) return fromDotEnv;
  try {
    const parsed = JSON.parse(fs.readFileSync(relayConfigPath(), 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token.trim() : '';
  } catch {
    return '';
  }
}

export function saveRelayUrl(url: string, token = ''): boolean {
  const directory = dataDir();
  const file = relayConfigPath();
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Keep an existing token when the operator re-saves only the URL, so a typo
    // fix in the URL does not silently wipe the credential.
    const existing = readRelayToken();
    fs.writeFileSync(file, JSON.stringify({ url: url.trim(), token: token.trim() || existing }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function clearRelayUrl(): boolean {
  try {
    fs.rmSync(relayConfigPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
