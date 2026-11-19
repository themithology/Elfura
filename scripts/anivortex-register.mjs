#!/usr/bin/env node
/**
 * AniVortex installation provisioning.
 * ====================================
 * Registers a fresh installation with `api.anivortex.in` and prints the three
 * environment variables Elfura needs. Nothing is written to disk (Pterodactyl
 * zero-disk rule, RULES.md §3) — copy the output into `/home/container/.env`.
 *
 *   node scripts/anivortex-register.mjs
 *
 * Run this on a host whose IP can reach the API. If registration fails, the
 * exit code is non-zero and the reason is printed; no partial credentials are
 * ever echoed.
 */

import { registerAnivortexInstallation } from '../dist/backend/anivortex-auth.js';

const result = await registerAnivortexInstallation({}).catch((error) => {
  console.error('AniVortex registration threw:', error?.message ?? error);
  return null;
});

if (!result) {
  console.error('AniVortex registration failed (challenge or register was rejected, or the network is blocked).');
  console.error('No credentials were produced. Nothing was written to disk.');
  process.exit(1);
}

const { installationId, keyId, privateKeyB64 } = result.credentials;
console.log('# AniVortex installation registered. Add these to /home/container/.env');
console.log('# and set ELFURA_ANIVORTEX_ENABLED=1. Treat the private key as a secret:');
console.log('# it authenticates this installation and is never printed again.');
console.log(`ELFURA_ANIVORTEX_INSTALL_ID=${installationId}`);
console.log(`ELFURA_ANIVORTEX_KEY_ID=${keyId}`);
console.log(`ELFURA_ANIVORTEX_PRIVATE_KEY=${privateKeyB64}`);
console.log(`ELFURA_ANIVORTEX_ENABLED=1`);
