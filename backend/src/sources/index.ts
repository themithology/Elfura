/**
 * The source manifest — the only door into the registry
 * =====================================================
 *
 * A source exists in two places and nowhere else:
 *
 *   1. a module under ./sources/ that exports a `SourceAdapter` factory
 *   2. one entry in APPROVED_SOURCES below
 *
 * Nothing else may import a source module. The registry builds its adapter list
 * from this array and from nothing else, so an entry that is not here cannot
 * serve traffic — and an entry that is here is exercised by
 * `backend/test/source-contract.mjs`, which resolves real titles, fetches a real
 * manifest and pulls real segment bytes. If a source cannot do that, the suite
 * fails and the entry does not belong here.
 *
 * That is the whole lesson of the previous board: thirty adapters, most of which
 * answered nothing, and a console that reported coverage instead of streams.
 * Fewer lanes, each one proven. An empty array is a valid, honest state — the
 * service boots, the proxy works, and /api/v1/playback says plainly that no
 * source is configured rather than pretending otherwise.
 *
 * Adding one, in order:
 *
 *   1. Write the adapter module. It reads its own settings from the environment
 *      (see `sourceEnv` below) so config.ts stays free of per-source keys.
 *   2. Add the entry here with the titles the contract test must resolve.
 *   3. `npm run build && node backend/test/source-contract.mjs` — it must print
 *      the manifest and the segment byte count for your source, not a timeout.
 *   4. Only then commit.
 *
 * If the lane needs different behaviour from the player, set a `SourceTrait` on
 * the adapter (`aggregator`, `animeEpisode`, `hardSubtitle`, `slowManifest`,
 * `hevcFirst`) instead of adding a provider id to a list in `src/`. The traits
 * travel to the client with each option, and `backend/test/standing-rules.mjs`
 * fails the build if a concrete adapter import or a second source table comes
 * back into the registry or config.
 */
import { createCitadelAdapter } from './citadel.js';
import { createGreyboxAdapter } from './greybox.js';
import { createNxshaAdapter } from './nxsha.js';
import { createVidlyAdapter } from './vidly.js';
/**
 * What a source may read: `process.env`, already carrying the `.env` overlay.
 * `hydrateProcessEnvFromDotEnv()` runs before any adapter is constructed
 * (backend/src/index.ts), and it never overwrites a real environment variable,
 * so this is the same precedence the rest of the app uses. Sources read their
 * own settings from here instead of growing a key per lane in BackendConfig.
 */
export function sourceEnv() {
    return process.env;
}
/**
 * Approved sources. Empty on purpose: the board starts at zero and every entry
 * has to earn its place through source-contract.mjs.
 */
export const APPROVED_SOURCES = [
    {
        id: 'source-1',
        envFlag: 'ELFURA_CITADEL_ENABLED',
        create: () => createCitadelAdapter(),
        website: { name: 'RiveStream', url: 'https://www.rivestream.app' },
        // Probed on GitHub runners on 2026-11-24: both titles resolved and both
        // returned real segment bytes, twice, with no browser involved. They are the
        // titles the contract test must keep reproducing.
        probes: [
            { type: 'movie', tmdbId: '550' },
            { type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
        ],
    },
    {
        id: 'source-2',
        envFlag: 'ELFURA_GREYBOX_ENABLED',
        create: () => createGreyboxAdapter(),
        website: { name: 'Greybox', url: 'https://greyboxtv.duckdns.org' },
        // The research harness only ever fetched the payload's first (relay) URL;
        // the provider's own /api/media rows were never tried. These titles are the
        // ones its API answered 200 for, plus the TV title it throttled, so the
        // contract proves the throttle path too.
        probes: [
            { type: 'movie', tmdbId: '550' },
            { type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
        ],
    },
    {
        id: 'source-3',
        envFlag: 'ELFURA_NXSHA_ENABLED',
        create: () => createNxshaAdapter(),
        website: { name: 'Nxsha', url: 'https://nxsha.space' },
        // Measured on a runner 2026-11-25 across four titles: zero media objects
        // shared with source-1 or source-2, and anime rows where the other two had
        // none. Its four rive-* lanes are excluded by construction because they ARE
        // source-1, and of its 30 own scrapers only 6 were observed serving media —
        // those 6 are the whole allowlist.
        //
        probes: [
            { type: 'movie', tmdbId: '550' },
            { type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
        ],
    },
    {
        id: 'source-4',
        envFlag: 'ELFURA_VIDLY_ENABLED',
        create: () => createVidlyAdapter(),
        website: { name: 'Vidly', url: 'https://vidly.pro' },
        // Measured on a runner 2026-11-25: the manifest URL is in the watch page
        // markup, with no token and no decryption, on img./gzip.rousav.tech — hosts
        // that appear in no other source. Both titles were followed master → variant
        // → segment (206, 128 KiB each), and the TV master declares five TYPE=AUDIO
        // renditions including Hindi, Telugu, Tamil and Kannada.
        //
        // Its `/api/sources` answers 403 to a runner; that gate is real and this lane
        // does not use it. The page carries the stream.
        //
        // The third host these pages sometimes embed, dash-hls-bridge.john1mc
        // .workers.dev, is a refused third-party bridge (502) and is excluded by the
        // adapter's host allowlist, not by a preference rule.
        probes: [
            { type: 'movie', tmdbId: '550' },
            { type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
        ],
    },
];
/** Ids of the approved sources, for logs and for the contract test. */
export function approvedSourceIds() {
    return APPROVED_SOURCES.map((source) => source.id);
}
