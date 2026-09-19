/**
 * src/housing/parts/Music.ts — **the music player state** (2026-09-14 user's decision).
 *
 * **No sound is produced.** Turning a gramophone · jukebox · turntable (`FurnitureInteraction 'record_player'`) on with E makes the
 * records shelved in that ship's record racks the playlist, and the player window in the screen corner (`ui/hud/MusicPlayer`) shows title · artist · volume.
 * There is not a single audio node, so the state is **pure data** and 「the track ended」 is only the result of comparing
 * `startedAt + lengthS × 1000` against the clock — which is why `tickMusic` reads **the clock only** in `update()`.
 *
 * Rules:
 *  - **Exactly one player is playing.** With several turned on, the **last** record player in `ShipState.toggled` wins
 *    (that list is pushed in the order they were switched on, so it is 「the one turned on last」). Turning it off falls back to the one before it.
 *  - The playlist is **every record rack on the ship** (one list however many there are), in holder placement order → cell number. The same def once only.
 *  - `mode`: `'playlist'` runs to the end and back to the first, `'repeat'` loops one track forever. The player window changes it through
 *    `HousingRef`'s control contract (`musicNext` · `musicPrev` · `setMusicMode` · `musicStop`, appended 2026-09-14).
 *  - **Ship only.** In a raid · the training range · the title it is `MUSIC_PLAYER_OFF` and `tick` turns around on the spot.
 *  - `housing:musicChanged` fires only when the state **really** changed (the `sameState` signature comparison) — never once per frame.
 *
 * This file does not touch `parts/Library.ts` — the shelved list is read only through the public queries that already exist (`getPlaced` ·
 * `getShelfMedium` · `shelfItemsOf` · `toggledUids`).
 */
import type { MusicMode, MusicPlayerState, MusicTrack } from '@/shared';
import { LIBRARY_SERIES_MAP, MUSIC_MODES, MUSIC_PLAYER_OFF, musicArtistOf, musicLengthOf, resolveItemAlias } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/** The record item id prefix (`record_<seriesId>` — the shape `items/ItemDefs.libraryItemIdFor` makes). */
const RECORD_PREFIX = 'record_';

/** The system field's initial value (a function because a class field calls it — which does not mean the constant object is not shared). */
export function initialMusicState(): MusicPlayerState { return MUSIC_PLAYER_OFF; }

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The state playing right now (`MUSIC_PLAYER_OFF` while off). */
export function musicState(sys: HousingSystem): MusicPlayerState { return sys.musicState; }

/** Of the record players that are on, the one **turned on last**. null with none. */
function activePlayerUid(sys: HousingSystem): string | null {
  const list = sys.toggledUids();
  for (let i = list.length - 1; i >= 0; i--) {
    const uid = list[i];
    const item = sys.getPlacedByUid(uid);
    const def = item ? sys.getFurnitureDef(item.defId) : undefined;
    if (def && def.interaction === 'record_player') return uid;
  }
  return null;
}

/** A record item id → one track. null when it is not a record (an old id is resolved with `resolveItemAlias`). */
function trackOf(defId: string): MusicTrack | null {
  const id = resolveItemAlias(defId);
  if (!id.startsWith(RECORD_PREFIX)) return null;
  const series = LIBRARY_SERIES_MAP.get(id.slice(RECORD_PREFIX.length));
  if (!series || series.medium !== 'record') return null;
  return { defId: id, title: series.name, artist: musicArtistOf(series.id), lengthS: musicLengthOf(series.id) };
}

/** Every record shelved in the ship's record racks — in holder placement order → cell number, the same def once only. */
function buildPlaylist(sys: HousingSystem): MusicTrack[] {
  const out: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const item of sys.getPlaced()) {
    if (sys.getShelfMedium(item.uid) !== 'record') continue;
    const entries = sys.shelfItemsOf(item.uid).slice().sort((a, b) => a.slot - b.slot);
    for (const e of entries) {
      const t = trackOf(e.defId);
      if (!t || seen.has(t.defId)) continue;
      seen.add(t.defId);
      out.push(t);
    }
  }
  return out;
}

/* ── State ───────────────────────────────────────────────────────────────── */

function sameTrack(a: MusicTrack | null, b: MusicTrack | null): boolean {
  return a === b || (!!a && !!b && a.defId === b.defId);
}

function sameState(a: MusicPlayerState, b: MusicPlayerState): boolean {
  if (a === b) return true;
  if (a.furnitureUid !== b.furnitureUid || a.index !== b.index || a.mode !== b.mode || a.startedAt !== b.startedAt) return false;
  if (!sameTrack(a.track, b.track)) return false;
  if (a.playlist.length !== b.playlist.length) return false;
  for (let i = 0; i < a.playlist.length; i++) if (a.playlist[i].defId !== b.playlist[i].defId) return false;
  return true;
}

/**
 * Seats the new state, and emits `housing:musicChanged` only when it really differs.
 * `force` keeps **a press by a person** from being buried by the signature comparison (pressing `다음 ▶` on a one-track
 * playlist so the same track starts over — within the same millisecond even the signature matches).
 */
function setState(sys: HousingSystem, next: MusicPlayerState, force = false): void {
  if (!force && sameState(sys.musicState, next)) return;
  sys.musicState = next;
  sys.ctx?.bus.emit('housing:musicChanged', { state: next });
}

/** Can music run in this situation — the personal · shared ship (not a raid · the training range · the title). */
function inShip(sys: HousingSystem): boolean {
  const ctx = sys.ctx;
  return !!ctx && ctx.isHubPhase() && !ctx.isRaidActive();
}

/**
 * Stands the active player · the playlist up again. While the same player keeps running and the current track is still in the list,
 * **`startedAt` is kept** (shelving one more record must not send the track being listened to back to its start).
 */
export function refreshMusic(sys: HousingSystem): void {
  const uid = inShip(sys) ? activePlayerUid(sys) : null;
  if (!uid) { setState(sys, MUSIC_PLAYER_OFF); return; }
  const prev = sys.musicState;
  const playlist = buildPlaylist(sys);
  const same = prev.furnitureUid === uid;
  let index = same && prev.track ? playlist.findIndex((t) => t.defId === prev.track?.defId) : -1;
  const keep = index >= 0;
  if (!keep) index = playlist.length > 0 ? 0 : -1;
  const track = index >= 0 ? playlist[index] : null;
  setState(sys, {
    furnitureUid: uid,
    track,
    playlist,
    index,
    mode: same ? prev.mode : 'playlist',
    startedAt: keep ? prev.startedAt : (track ? sys.nowMs() : 0),
  });
}

/** On to the next track (on repeat, the same track from the start). Nothing happens on an empty list. */
function advance(sys: HousingSystem): void {
  const s = sys.musicState;
  if (!s.track || s.playlist.length === 0) return;
  if (s.mode === 'repeat') { setState(sys, { ...s, startedAt: sys.nowMs() }); return; }
  const next = (s.index + 1) % s.playlist.length;
  setState(sys, { ...s, index: next, track: s.playlist[next], startedAt: sys.nowMs() });
}

/**
 * Every frame from `HousingSystem.update()` — while off it turns around after one comparison. Even on a large clock jump
 * (returning to the tab · a server clock sync) `advance` resets `startedAt` to now, so only one track passes per frame.
 */
export function tickMusic(sys: HousingSystem): void {
  const s = sys.musicState;
  if (!s.furnitureUid) return;
  if (!inShip(sys)) { setState(sys, MUSIC_PLAYER_OFF); return; }
  if (!s.track || s.track.lengthS <= 0) return;
  if (sys.nowMs() - s.startedAt < s.track.lengthS * 1000) return;
  advance(sys);
}

/** Turns playing off (mission start · abort · leaving the ship · `dispose`). It only turns the state off and does not touch `toggled`. */
export function stopMusic(sys: HousingSystem): void { setState(sys, MUSIC_PLAYER_OFF); }

/* ── Controls (`HousingRef` appended contract, 2026-09-14) ─────────────────
 * The player window's four buttons come in here. All four emit `housing:musicChanged` **at once** on success
 * (`musicStop` goes through the `housing:furnitureToggled` the furniture toggle emits → `refreshMusic`). */

/** Moves the track by `dir` — even on `'repeat'` **a press by a person moves on** (only the automatic advance repeats). */
function step(sys: HousingSystem, dir: 1 | -1): boolean {
  const s = sys.musicState;
  const n = s.playlist.length;
  if (!s.furnitureUid || !s.track || n === 0) return false;
  const next = (((s.index + dir) % n) + n) % n;
  setState(sys, { ...s, index: next, track: s.playlist[next], startedAt: sys.nowMs() }, true);
  return true;
}

export function musicNext(sys: HousingSystem): boolean { return step(sys, 1); }

export function musicPrev(sys: HousingSystem): boolean { return step(sys, -1); }

/** Switches the play mode. false while nothing is playing, or for the same value. */
export function setMusicMode(sys: HousingSystem, mode: MusicMode): boolean {
  const s = sys.musicState;
  if (!s.furnitureUid) return false;
  if (!MUSIC_MODES.includes(mode) || s.mode === mode) return false;
  setState(sys, { ...s, mode });
  return true;
}

/**
 * Stops playing — ⚠ **the furniture's `toggled` comes down with it** (turning the state off alone leaves the piece looking on).
 * No new save path is made: it rides **the same path as the furniture's E toggle** (`Library.toggleFurniture`) as it is —
 * `ShipState.toggled` · `changed('toggle')` · `housing:furnitureToggled` · down to the `record_off` sound.
 * `bindMusic` receives that event and calls `refreshMusic`, so the state is never turned off directly here.
 */
export function musicStop(sys: HousingSystem): boolean {
  const uid = sys.musicState.furnitureUid;
  if (!uid) return false;
  const on = sys.toggleFurniture(uid);
  if (on === null) { stopMusic(sys); return true; }   // the piece is gone (recovered · the server copy) — only the state is cleaned up
  if (on) sys.toggleFurniture(uid);                   // the impossible case (it was already off) — undo having turned it on
  // Another player left on takes over — 「this piece was turned off」 still succeeded.
  refreshMusic(sys);
  return true;
}

export function bindMusic(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const refresh = (): void => refreshMusic(sys);
  const stop = (): void => stopMusic(sys);
  return [
    // On / off — the one fact `parts/Library.toggleFurniture` emits is playing's only trigger.
    b.on('housing:furnitureToggled', refresh),
    // The record racks' contents · the holders owned changed (shelving · taking out · recovery · removing the facility · the server copy).
    b.on('housing:libraryChanged', refresh),
    b.on('housing:shelfChanged', refresh),
    b.on('housing:furnitureRecovered', refresh),
    b.on('housing:loaded', refresh),
    b.on('hub:entered', refresh),
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase === 'hub') refresh(); else stop(); }),
  ];
}
