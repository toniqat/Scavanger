import { CHARACTER_SLOTS } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * Character save slots (2026-09-09).
 *
 * Until then a save was a **single key with no notion of a slot** — `scav.profile` · `scav.stash` · `scav.meta` ·
 * `scav.ship` · `scav.loadout` · `scav.sessionToken` … That meant exactly one character, and the title's
 * `새 캐릭터로 시작` could do nothing but erase that one. With the character select screen (3 cells) three
 * characters have to live side by side in the same browser, so **keys get a slot prefix**:
 *
 *     scav.profile  →  scav.s1.profile · scav.s2.profile · scav.s3.profile
 *
 * `scav.sessionToken` is per slot too — the relay finds the server profile (credits · stash · loadout ·
 * progression · ship) by the token, so the server-side character only splits when the token does. Without that,
 * connecting on slot 2 downloads slot 1's server profile as it is.
 *
 * **Shared (non-character) saves** take no prefix: keybinds · audio volume · display settings · console history.
 * The list is `SHARED_KEYS`. Every `scav.*` not in that set counts as character data — the reason for a prefix
 * sweep instead of a hand-written list is the same as `ui/menus/newCharacter`'s: forgetting a save added later
 * leaves half a character behind.
 *
 * **Systems read storage once at boot.** So a slot switch always comes with `window.location.reload()`
 * (`markAutoStart` marks it so the reload goes straight into the ship). The active slot never changes while running.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Slot numbers run from 1 to `CHARACTER_SLOTS`. */
export type SlotId = number;

/** Number of slots (data/constants.csv `CHARACTER_SLOTS`). */
export const SLOT_COUNT: number = Math.max(1, Math.round(CHARACTER_SLOTS));

/** Every slot number, 1..SLOT_COUNT. */
export const SLOT_IDS: readonly SlotId[] = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);

/** Which slot to boot with (a shared key, no prefix). */
export const ACTIVE_SLOT_KEY = 'scav.slot';

/** Mark telling the boot right after a reload to skip the title and go straight into the ship (sessionStorage). */
export const AUTOSTART_KEY = 'scav.autostart';

/** Not character data — it takes no slot prefix and survives deleting a slot. */
export const SHARED_KEYS: ReadonlySet<string> = new Set([
  // 2026-09-10: `scav.relay` (= shared/net `RELAY_STORAGE_KEY`) is which server this PC connects to, not character
  // data — it belongs next to the keybinds and the audio settings. Deleting a slot leaves the server address.
  'scav.keybinds', 'scav.audio', 'scav.display', 'scav.console.history', 'scav.relay', ACTIVE_SLOT_KEY,
]);

/** Pattern recognising an already-namespaced key such as `scav.s3.`. */
const SLOTTED_RE = /^scav\.s\d+\./;

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_slot_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function clampSlot(n: unknown): SlotId {
  const v = typeof n === 'number' ? n : Number.parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v)) return 1;
  return Math.min(SLOT_COUNT, Math.max(1, Math.round(v)));
}

/** Every key of one slot (the sweep stays inside that slot). */
function keysOfSlot(s: Storage, id: SlotId): string[] {
  const prefix = `scav.s${id}.`;
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/* ── The active slot ──────────────────────────────────────────────────── */

let cached: SlotId | null = null;

/**
 * The slot this boot uses. 1 when storage cannot be read. The value is read **once at boot** and cached — changing
 * it while running would put it out of step with the systems already in memory.
 */
export function activeSlot(): SlotId {
  if (cached !== null) return cached;
  ensureMigrated();
  const s = storage();
  let id: SlotId = 1;
  if (s) {
    try { id = clampSlot(s.getItem(ACTIVE_SLOT_KEY)); } catch { id = 1; }
  }
  cached = id;
  return id;
}

/**
 * Writes the slot the next boot will use. **It has no effect on the running game** — the caller has to
 * `window.location.reload()` right after.
 */
export function setActiveSlot(id: SlotId): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(ACTIVE_SLOT_KEY, String(clampSlot(id))); } catch { /* quota / private mode */ }
}

/** Leaves the mark to skip the title after a reload (it lives only inside the tab). */
export function markAutoStart(): void {
  try { window.sessionStorage.setItem(AUTOSTART_KEY, '1'); } catch { /* storage off */ }
}

/** Reads that mark **once** and clears it. A second call is false. */
export function takeAutoStart(): boolean {
  try {
    const on = window.sessionStorage.getItem(AUTOSTART_KEY) === '1';
    if (on) window.sessionStorage.removeItem(AUTOSTART_KEY);
    return on;
  } catch {
    return false;
  }
}

/* ── Keys ───────────────────────────────────────────────────────────────── */

/**
 * Moves a save key onto the active slot: `scav.profile` → `scav.s2.profile`.
 * A shared key (`SHARED_KEYS`) and an already-slotted key come back unchanged — wrapping twice is safe.
 */
export function slotKey(base: string): string {
  return slotKeyFor(activeSlot(), base);
}

/** Same as `slotKey` but with the slot given (the character select screen looking into someone else's slot). */
export function slotKeyFor(id: SlotId, base: string): string {
  if (SHARED_KEYS.has(base) || SLOTTED_RE.test(base)) return base;
  const rest = base.startsWith('scav.') ? base.slice('scav.'.length) : base;
  return `scav.s${clampSlot(id)}.${rest}`;
}

/* ── Migrating older saves ─────────────────────────────────────────── */

let migrated = false;

/**
 * Moves the slotless-era `scav.*` saves onto **slot 1** once. Being a prefix sweep, a save added later comes along
 * too. Already-slotted keys and shared keys are left alone, so calling it several times is the same.
 *
 * `slotKey` calls it itself, but calling it once explicitly at the very start of the boot (`main.ts`) reads better.
 */
export function ensureMigrated(): void {
  if (migrated) return;
  migrated = true;
  const s = storage();
  if (!s) return;
  const moves: Array<[string, string]> = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith('scav.')) continue;
      if (SHARED_KEYS.has(k) || SLOTTED_RE.test(k)) continue;
      moves.push([k, `scav.s1.${k.slice('scav.'.length)}`]);
    }
    for (const [from, to] of moves) {
      // A value already on slot 1 is the newer one — the old key is dropped.
      const v = s.getItem(from);
      if (v !== null && s.getItem(to) === null) s.setItem(to, v);
      s.removeItem(from);
    }
  } catch { /* quota / private mode — a failed migration still leaves a new character playable */ }
}

/* ── Slot cards ───────────────────────────────────────────────────────── */

/**
 * The summary one cell of the character select screen draws. There is no separate index file — it is **read
 * straight from that slot's saves**: an index goes out of step with the real thing eventually, and an index out of
 * step reads as "a character that is not there" or "a level on an empty cell".
 */
export interface SlotCard {
  id: SlotId;
  /** null when there is no save — an empty cell. */
  name: string | null;
  level: number;
  /** The five stats. An empty object when the save cannot be read. */
  stats: Record<string, number>;
  /** Accent colour of the soldier model (`PlayerProfile.accent`), null when there is none. */
  accent: string | null;
  implant: string | null;
  credits: number;
  raids: number;
  extractions: number;
  /** epoch ms, 0 when there is none. */
  createdAt: number;
  playedAt: number;
}

function readJson(s: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const numOf = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The summary of one cell. With no save it returns an empty cell with `name: null` (it never throws). */
export function readSlotCard(id: SlotId): SlotCard {
  const slot = clampSlot(id);
  const empty: SlotCard = {
    id: slot, name: null, level: 1, stats: {}, accent: null, implant: null,
    credits: 0, raids: 0, extractions: 0, createdAt: 0, playedAt: 0,
  };
  ensureMigrated();
  const s = storage();
  if (!s) return empty;
  const p = readJson(s, slotKeyFor(slot, 'scav.profile'));
  if (!p) return empty;
  const stats: Record<string, number> = {};
  const rawStats = p.stats;
  if (rawStats && typeof rawStats === 'object') {
    for (const [k, v] of Object.entries(rawStats as Record<string, unknown>)) stats[k] = numOf(v);
  }
  const meta = readJson(s, slotKeyFor(slot, 'scav.meta'));
  return {
    id: slot,
    name: strOf(p.name) ?? '스캐빈저',
    level: Math.max(1, Math.round(numOf(p.level, 1))),
    stats,
    accent: strOf(p.accent),
    implant: strOf(p.implant),
    credits: Math.max(0, Math.round(numOf(meta?.credits))),
    raids: Math.max(0, Math.round(numOf(p.raids))),
    extractions: Math.max(0, Math.round(numOf(p.extractions))),
    createdAt: Math.max(0, numOf(p.createdAt)),
    playedAt: Math.max(0, numOf(p.playedAt)),
  };
}

/** All three cells, starting at 1. */
export function readSlotCards(): SlotCard[] {
  return SLOT_IDS.map(readSlotCard);
}

/** Is there a character in that cell? */
export function slotOccupied(id: SlotId): boolean {
  return readSlotCard(id).name !== null;
}

/**
 * Deletes every save of one slot (`scav.s<id>.*`). Shared settings stay. Returns the list of keys removed.
 * After deleting the active slot the caller has to reload for the systems already in memory to follow.
 */
export function deleteSlot(id: SlotId): string[] {
  ensureMigrated();
  const s = storage();
  if (!s) return [];
  const slot = clampSlot(id);
  const removed: string[] = [];
  try {
    for (const k of keysOfSlot(s, slot)) { s.removeItem(k); removed.push(k); }
  } catch { /* storage unavailable */ }
  return removed;
}

/** Writes one save file of a slot directly (character creation planting a profile **before** the boot). */
export function writeSlotSave(id: SlotId, base: string, value: unknown): boolean {
  ensureMigrated();
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(slotKeyFor(id, base), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
