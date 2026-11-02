/**
 * Elfura Player — public entry
 * ============================
 *   import { Elfura } from 'elfura-player';
 *   const { player } = Elfura.mount(document.querySelector('#player'), { src, lang: 'hi' });
 *
 * The embed page (embed.html) is this same entry driven purely by URL params:
 * one input schema, two consumption shapes, zero duplicated logic.
 */

import './ui/styles.css';
import { ElfuraPlayer, type ElfuraPlayerOptions } from './core/player';
import { PlayerUI } from './ui/controls';
import { schemaDocs } from './core/config';
import { DEFAULT_SUB_STYLE } from './subs/style';

export interface Mounted {
  player: ElfuraPlayer;
  ui: PlayerUI;
  destroy(): void;
}

export const Elfura = {
  /** Player with full chrome. */
  mount(host: HTMLElement, options: ElfuraPlayerOptions = {}, search = window.location.search): Mounted {
    const player = new ElfuraPlayer({ ...options, root: host }, search);
    const ui = new PlayerUI(player);
    return { player, ui, destroy: () => { ui.destroy(); player.destroy(); } };
  },

  /** Bare player, no chrome — drive it entirely through the API / postMessage. */
  create(host: HTMLElement, options: ElfuraPlayerOptions = {}, search = ''): ElfuraPlayer {
    return new ElfuraPlayer({ ...options, root: host }, search);
  },

  schemaDocs,
  DEFAULT_SUB_STYLE,
  version: '0.1.0',
};

export { ElfuraPlayer } from './core/player';
export type { ElfuraPlayerOptions, PlayerState, SubtitleTrack, QualityLevel } from './core/player';
export type { AudioTrack } from './core/audio';
export type { SubtitleStyle } from './subs/style';
export type { ElfuraConfig } from './core/config';
export type { EventName, CommandName, Envelope } from './core/events';
export { PARAM_SCHEMA, parseTime, parseColor, parsePairList } from './core/params';
export { createHostClient } from './core/events';
export { PlayerUI } from './ui/controls';

declare global {
  interface Window {
    Elfura?: typeof Elfura;
  }
}
if (typeof window !== 'undefined') window.Elfura = Elfura;

export type { Mounted as ElfuraMounted };
