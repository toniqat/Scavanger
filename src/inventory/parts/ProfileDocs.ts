/**
 * src/inventory/parts/ProfileDocs.ts — **server profile documents · the raid session state**.
 *
 * The path that uploads the stash (`stash`) and the loadout (`loadout`) to the relay's profile store and downloads them
 * again, plus the `captureRaidState` / `applyRaidState` a player who dropped mid-raid returns through.
 * The rule that keeps an offline edit from being wiped by the server's empty document (the `fresh` save) is this file's too.
 */
import type {
  ProfileRecord,
} from '@/shared';
import { starterGrantState } from '../Stash';
import { isEmptyLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem } from '../Serialize';
import {
  sameProfileDoc, type RaidInventoryState,
} from '../model';
import type { InventorySystem } from '../InventorySystem';
import * as RaidMarks from './RaidFound';
import { returnForbiddenAttachments } from './SocketRules';   // 2026-09-14 (the gun socket rules)

/** Bag + 5 slots + quick slots with every instance field incl. `searched` (raid session blob / training freeze). */
export function captureRaidState(sys: InventorySystem): unknown {
  // 2026-09-12 (E1): favourites are not the kit — they never ride in the raid blob · the training range snapshot (a restore must not undo a toggle)
  const { fav: _fav, ...save } = sys.captureLoadoutSave();
  const placements = sys.bag.items();
  const bag = save.bag.map((sv, i) => {
    const flag = placements[i]?.item.searched;
    return flag === undefined ? sv : { ...sv, searched: flag };
  });
  const state: RaidInventoryState = { ...save, bag, raid: 1 };
  // 2026-09-12 (item recovery contracts): the raid-found marks ride in the blob only (`rf`, revived by `Serialize.reviveItem`)
  RaidMarks.annotateRaidState(sys, state);
  // 2026-09-11 (C-61): the once-per-raid bag wear travels with the session (stamped with this raid's seed)
  if (sys.bagWornThisRaid) state.bagWorn = sys.missionSeed;
  return state;
}

/**
 * Replace the bag / slots / quick slots with a `captureRaidState()` result and re-announce everything.
 *
 * 2026-09-11 (C-61): also restores `bagWornThisRaid` — true only when the state's `bagWorn` is **this** raid's seed
 * (`missionSeed`, set at `world:ready`, which runs before game/ applies a rejoin blob). Omitted / another seed = false:
 * an old blob, and the training range snapshot restored on exit, can never carry a wear mark across raids.
 */
export function applyRaidState(sys: InventorySystem, state: unknown): boolean {
  const save = sanitizeLoadoutSave(state);
  if (!save) return false;
  sys.cancelCraft();
  const revived = sys.applyLoadoutSave(save);
  // 2026-09-14 (the gun socket rules): mid-raid a detached attachment goes to the bag only (never the stash); no room → stays on the weapon, inert
  returnForbiddenAttachments(sys, 'bag');
  save.bag.forEach((sv, i) => {
    const item = revived[i];
    const flag = (sv as { searched?: boolean }).searched;
    if (item && typeof flag === 'boolean') item.searched = flag;
  });
  const worn = (state as { bagWorn?: unknown }).bagWorn;
  const wornSeed = typeof worn === 'number' && Number.isFinite(worn) ? worn : null;
  sys.bagWornRestoreSeed = wornSeed;
  sys.bagWornThisRaid = wornSeed !== null && wornSeed === sys.missionSeed;
  sys.announcePending = false;
  sys.announceLoaded();
  return true;
}

/**
 * Mirror a local save to the server profile. Phase 9: always handed to `profile.set` — offline included (`ProfileSync`
 * stamps it with `serverNow()` and keeps the newest doc per key until the next connection); inside `withFreshSave`
 * the document is sent as a default (`{fresh:true}`, accepted only while the server has none for that key).
 */
export function uploadProfileDoc(sys: InventorySystem, key: 'stash' | 'loadout', doc: unknown): void {
  // 2026-09-11 (E-6): inside `flushSaves` the documents are collected and go up together once both are written
  if (sys.uploadBatch) { sys.uploadBatch[key] = { doc, fresh: sys.freshSave }; return; }
  const profile = sys.ctx.net?.profile;
  if (!profile || typeof profile.set !== 'function') return;
  try { profile.set(key, doc, sys.freshSave ? { fresh: true } : undefined); } catch { /* net not ready */ }
}

/**
 * 2026-09-11 (E-6): the **one** debounce of the stash and the loadout (`Stash.schedule` / `LoadoutStore.schedule` point
 * here) — a move between the two used to be two unrelated `profile:set`s 350 ms apart on separate timers, so a crash or
 * a refused write in between duplicated or lost the item on the server.
 */
export function scheduleSaves(sys: InventorySystem): void {
  if (sys.saveTimer !== null) clearTimeout(sys.saveTimer);
  sys.saveTimer = window.setTimeout(() => { sys.saveTimer = null; flushSaves(sys); }, SAVE_BATCH_DELAY_MS);
}

/** Debounce of the merged save — the same 350 ms both stores used on their own. */
export const SAVE_BATCH_DELAY_MS = 350;

/**
 * Write the pending stash / loadout saves now. Both written → one `ProfileRef.setMany({stash, loadout})` (all or nothing on
 * the server); one → an ordinary `set`. A `fresh` (default) save keeps its own `set {fresh}` — a transaction has no
 * default semantics. Also `InventoryRef.flushSaves` (meta/ quest completion) and the page-hide path.
 */
export function flushSaves(sys: InventorySystem): void {
  if (sys.saveTimer !== null) { clearTimeout(sys.saveTimer); sys.saveTimer = null; }
  if (sys.uploadBatch) return;   // re-entrant call from inside a flush
  const batch: NonNullable<InventorySystem['uploadBatch']> = {};
  sys.uploadBatch = batch;
  try {
    sys.stash?.flush();
    sys.loadoutStore?.flush();
  } finally {
    sys.uploadBatch = null;
  }
  const entries = Object.entries(batch) as ['stash' | 'loadout', { doc: unknown; fresh: boolean }][];
  if (entries.length === 0) return;
  const profile = sys.ctx.net?.profile;
  if (!profile || typeof profile.set !== 'function') return;
  try {
    if (entries.length > 1 && entries.every(([, e]) => !e.fresh) && typeof profile.setMany === 'function') {
      profile.setMany({ stash: batch.stash?.doc, loadout: batch.loadout?.doc });
      return;
    }
    for (const [key, e] of entries) profile.set(key, e.doc, e.fresh ? { fresh: true } : undefined);
  } catch { /* net not ready */ }
}

/**
 * 2026-09-11 (E-6): join the documents `keys` that are queued right now into **one** profile transaction. The owners have
 * already queued them (`set`); `ProfileRef.get` hands back exactly those documents and `setMany` merges their queued
 * writes (a key whose document is unchanged and not queued is skipped). Used by the corpse strip (loadout + the
 * progression document the implant strip just saved).
 */
export function joinProfileTx(sys: InventorySystem, keys: readonly ('meta' | 'stash' | 'loadout' | 'progression' | 'ship')[]): void {
  const profile = sys.ctx.net?.profile;
  if (!profile || typeof profile.setMany !== 'function' || typeof profile.get !== 'function') return;
  try {
    const docs: Partial<Record<(typeof keys)[number], unknown>> = {};
    for (const k of keys) { const d = profile.get(k); if (d !== undefined) docs[k] = d; }
    if (Object.keys(docs).length > 1) profile.setMany(docs);
  } catch { /* net not ready */ }
}

/** Run `fn` with every save it triggers uploaded as a `fresh` (default) document. */
export function withFreshSave(sys: InventorySystem, fn: () => void): void {
  const prev = sys.freshSave;
  sys.freshSave = true;
  try { fn(); } finally { sys.freshSave = prev; }
}

/**
 * `net:profileLoaded`: the record is already merged newest-wins (Phase 9: `ProfileSync` weighed its pending offline
 * edits against the server's `docsAt` before emitting), so a server document simply replaces the local state — the
 * loadout only outside a raid (mid-mission the raid blob is the truth). A document that is **identical to the current
 * local state** is our own upload coming back through the merge: nothing is applied, nothing is re-saved (Phase 9 —
 * otherwise the starter kit would be re-announced and re-written with reason `profile` on every welcome). A key the
 * server has never seen gets the current local state (stamped, so it becomes the profile); an empty local loadout is
 * not worth uploading (the starter kit follows as a `fresh` document). Grids are rebuilt and announced.
 */
export function onProfileLoaded(sys: InventorySystem, profile: ProfileRecord): void {
  sys.applyProfileDocs(profile);
  // 2026-09-07: a first-run grant goes up as a `fresh` document, so an (empty) server stash has just replaced it —
  // re-check exactly once, now that the server's stash is known. A profile that really owns something skips it.
  if (starterGrantState() === 'pending') sys.tryStarterGrant();
}

export function applyProfileDocs(sys: InventorySystem, profile: ProfileRecord): void {
  const docs = profile?.docs ?? {};
  if (docs.stash === undefined) sys.uploadProfileDoc('stash', sys.stash.saveFile());
  else if (sameProfileDoc(docs.stash, sys.stash.saveFile())) { /* our own document: already applied */ }
  else if (sys.stash.loadFrom(docs.stash)) {
    sys.lastStashVersion = sys.stash.grid.version;
    sys.ctx.bus.emit('inventory:stashChanged', { count: sys.stash.count });
    if (sys._open) sys.ui?.refresh();
  }
  if (docs.loadout === undefined) {
    const local = sys.captureLoadoutSave();
    if (!isEmptyLoadoutSave(local)) sys.uploadProfileDoc('loadout', local);
    return;
  }
  const save = sanitizeLoadoutSave(docs.loadout);
  // 2026-09-12 (E1): favourites are not the kit — the server list is taken even mid-raid (an unsent local toggle wins over it)
  if (save) sys.applySavedFavorites(save.fav);
  if (sys.ctx.isRaidActive()) return;
  if (!save) return;
  // …and a document that differs from ours **only** in `fav` must not rebuild the kit (nor re-save as `profile`, which
  // would drop a pending favourite save): the kits are compared without it
  const kitOf = (s: LoadoutSave | null): unknown => { if (!s) return s; const { fav: _f, ...kit } = s; return kit; };
  if (sameProfileDoc(kitOf(save), kitOf(sanitizeLoadoutSave(sys.captureLoadoutSave())))) return; // our own document
  if (isEmptyLoadoutSave(save)) {
    // 2026-09-07: an empty server document must never wipe a kit the player is standing in — it only means the
    // profile has no loadout yet. The local kit stays (and is uploaded); only a player with nothing anywhere is
    // handed the minimum kit.
    if (sys.ctx.isHubPhase() && sys.isDestitute()) sys.applyStarter();
    return;
  }
  sys.cancelCraft();
  sys.applyLoadoutSave(save);
  const returned = returnForbiddenAttachments(sys, 'stash');   // 2026-09-14 (the gun socket rules)
  sys.announcePending = false;
  sys.announceLoaded();
  sys.loadoutStore.saveNow('profile'); // mirror to localStorage without echoing the document back
  // 2026-09-14: …but a kit whose attachments just moved into the stash must go up **with** the stash (one `setMany`) — marked after
  // `saveNow`, which would cancel the pending loadout save
  if (returned > 0) sys.loadoutStore.markDirty('sockets');
}
