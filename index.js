/**
 * Elfura — Root Entrypoint for Pterodactyl Node.js Eggs
 * =====================================================
 * Works out-of-the-box whether Pterodactyl's startup file is set to `index.js`,
 * `dist/backend/index.js`, or `npm start` — with zero runtime npm dependencies.
 */

import { startBackendServer } from './dist/backend/index.js';

startBackendServer();
