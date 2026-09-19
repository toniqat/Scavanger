/**
 * src/allies/parts/Roster.ts — **the roster**. The one place that answers 「who are my squad's androids」.
 *
 * The contract (`shared/allies.ts`):
 *  - A docked lobby's shared ship · its raid: the **relay bot members** are the roster (`androidPlayersOf(lobby)`).
 *  - Outside that (personal ship · no server) there is only the **local roster** the `/android` cheat built.
 * In both cases every client **computes it from the same lobby state** — the roster has no wire.
 */
import {
  ANDROID_BAY_COUNT, androidIdOf, androidNameOf, androidPlayersOf, markRaidFound, raidFoundSeed,
} from '@/shared';
import type { AllyId, AllyLoadoutView, AllyRosterEntry, LobbyState } from '@/shared';
import type { AllySystem } from '../AllySystem';
import { Ally } from './Body';
import * as Bag from './Bag';

/** The current lobby — only in a shared-ship session or inside its raid. Otherwise null (= the cheat roster). */
function lobbyOf(sys: AllySystem): LobbyState | null {
  const net = sys.ctx.net;
  if (!net) return null;
  const lobby = net.lobby;
  if (!lobby) return null;
  // 「Docked?」 — a lobby that only got an invite and has not docked yet is not the shared ship (CLAUDE.md §4.3).
  if (lobby.docked === false) return null;
  if (!net.inHubSession && !net.inSession) return null;
  return lobby;
}

/**
 * Recomputes the roster from the current state; if it changed, matches the bodies and emits `ally:rosterChanged`.
 * Calling it every frame keeps minting two arrays, so the frame loop calls it only while `rosterDirty` is raised —
 * `net:lobbyUpdated` · `net:lobbyLeft` · **entering** the ship (`hub:entered`; `hub:left` does not touch the roster).
 * `net:androidReturned` (`onReturned`) and the `/android` cheat (`addLocal` · `removeLocal`) do not wait for the
 * flag — they call this directly.
 */
export function refresh(sys: AllySystem): void {
  sys.rosterDirty = false;
  const lobby = lobbyOf(sys);
  const next: AllyRosterEntry[] = [];
  if (lobby) {
    for (const p of androidPlayersOf(lobby)) {
      const bay = p.bay ?? 0;
      next.push({
        id: p.id, bay, slot: p.slot ?? bay, name: p.name || androidNameOf(bay),
        recruitedAt: p.recruitedAt ?? 0, local: false,
      });
    }
  } else {
    for (const e of sys.localRoster) next.push(e);
  }

  if (sameRoster(sys.roster, next)) return;
  const prev = sys.roster;
  sys.roster = next;

  const added: AllyId[] = [];
  const removed: AllyId[] = [];
  for (const e of next) if (!prev.some((p) => p.id === e.id)) added.push(e.id);
  for (const e of prev) if (!next.some((p) => p.id === e.id)) removed.push(e.id);

  syncBodies(sys);
  const evicted = sys.evictedPending.filter((id) => removed.includes(id));
  sys.evictedPending.length = 0;
  sys.ctx.bus.emit('ally:rosterChanged', { roster: next, added, removed, evicted });
}

function sameRoster(a: readonly AllyRosterEntry[], b: readonly AllyRosterEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].slot !== b[i].slot || a[i].bay !== b[i].bay) return false;
  }
  return true;
}

/**
 * Creates and removes bodies to match the roster. In the shared ship the **dormant body of an empty bay** is created
 * too (`parts/Hub`).
 */
export function syncBodies(sys: AllySystem): void {
  const wanted = new Map<AllyId, AllyRosterEntry>();
  for (const e of sys.roster) wanted.set(e.id, e);

  // In the shared ship a dormant body stands in a bay that was not recruited from too (user's decision — the
  // android inside the bay is visible).
  const bays = sys.ctx.hub?.getAndroidBays?.() ?? [];
  for (const b of bays) {
    const id = dormantIdOf(sys, b.bay);
    if (!id || wanted.has(id)) continue;
    wanted.set(id, { id, bay: b.bay, slot: b.bay, name: androidNameOf(b.bay), recruitedAt: 0, local: false });
  }

  for (let i = sys.bodies.length - 1; i >= 0; i--) {
    const a = sys.bodies[i];
    if (wanted.has(a.id)) continue;
    sys.bodies.splice(i, 1);
    sys.byId.delete(a.id);
  }
  for (const e of wanted.values()) {
    let a = sys.byId.get(e.id);
    if (!a) {
      a = new Ally(e.id, e.name, e.bay, e.slot, e.local);
      sys.bodies.push(a);
      sys.byId.set(e.id, a);
    }
    a.name = e.name;
    a.bay = e.bay;
    a.slot = e.slot;
    a.local = e.local;
    /*
     * 2026-09-16 (user's decision 「호출되는 순간 기본 킷을 장착한 채로 선다」): the moment it enters the roster = the
     * moment its body is created is also the moment it puts the kit on.
     * **Lobby recruiting · the `/android` cheat · a late-joining client** all pass through here (`refresh` ·
     * `Hub.onHubEntered` · `Hub.update` when a bay appears late), and `ensureKit` is idempotent, so a repeated
     * call is cheap.
     * **It is not called during a raid**: the raid's kit is built by `parts/Spawn` and a replica must learn it
     * from the `ally bag` wire only (coming through here on a mid-raid `net:lobbyUpdated` mints an empty bag
     * on the replica, and host migration then loses the android's loot).
     */
    if (!sys.raidActive) Bag.ensureKit(sys, a);
  }
  sys.bodies.sort((x, y) => x.bay - y.bay);
}

/** The id of the dormant body standing in bay `bay` of the shared ship. null when this is not the shared ship. */
function dormantIdOf(sys: AllySystem, bay: number): AllyId | null {
  const net = sys.ctx.net;
  const code = net?.lobby?.code;
  if (!code || sys.ctx.hub?.ship !== 'shared') return null;
  if (bay < 0 || bay >= ANDROID_BAY_COUNT) return null;
  return androidIdOf(code, bay);
}

/** Is this android on the roster (= a squadmate) — tells it apart from a dormant bay body. */
export function isRecruited(sys: AllySystem, id: AllyId): boolean {
  return sys.roster.some((e) => e.id === id);
}

/** The relay sent one unit back to its bay (`human_joined` = the person won · `full` = no room). */
export function onReturned(sys: AllySystem, bay: number, reason: 'human_joined' | 'full'): void {
  if (reason !== 'human_joined') return;
  const code = sys.ctx.net?.lobby?.code;
  if (code) sys.evictedPending.push(androidIdOf(code, bay));
  refresh(sys);
}

/* ── The cheat roster (no server) ──────────────────────────────────── */

/** The first lobby slot the local player is not using — so the colour · the launch pod do not collide. */
export function freeLocalSlot(sys: AllySystem): number {
  const mine = sys.ctx.net?.localSlot ?? 0;
  const used = new Set<number>([mine]);
  for (const e of sys.localRoster) used.add(e.slot);
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

export function addLocal(sys: AllySystem): AllyRosterEntry | null {
  if (sys.localRoster.length >= ANDROID_BAY_COUNT) return null;
  const bay = sys.localRoster.length;
  const entry: AllyRosterEntry = {
    id: androidIdOf('local', bay), bay, slot: freeLocalSlot(sys), name: androidNameOf(bay),
    recruitedAt: Date.now(), local: true,
  };
  sys.localRoster.push(entry);
  refresh(sys);
  return entry;
}

export function removeLocal(sys: AllySystem): AllyRosterEntry | null {
  const gone = sys.localRoster.pop() ?? null;
  refresh(sys);
  return gone;
}

/* ── What it carries ──────────────────────────────────────────────────── */

/**
 * `AlliesRef.getLoadout` — what the body holds now. Since 2026-09-16 the base kit is filled **in the ship too**
 * (`syncBodies` → `Bag.ensureKit`), so the launch slot card never draws empty gear. A replica's mid-raid loadout
 * is the last `ally bag` (`wireItems`), because it has no bag grid.
 */
export function loadoutOf(sys: AllySystem, id: AllyId): AllyLoadoutView | null {
  const a = sys.byId.get(id);
  if (!a) return null;
  const items = a.bag ? a.bag.items() : a.wireItems;
  const info = Bag.weightOf(sys, a);
  return {
    equip: a.equip,
    items,
    cols: a.bag?.cols ?? 0,
    rows: a.bag?.rows ?? 0,
    weight: info.weight,
    capacity: info.capacity,
  };
}

/** A give for the smokes — marked as raid loot so the hand-over · stash deposit paths run unchanged. */
export function debugGive(sys: AllySystem, id: AllyId, defId: string, qty: number): boolean {
  const a = sys.byId.get(id);
  if (!a || !a.bag) return false;
  const item = sys.ctx.loot?.createItem(defId, qty) ?? null;
  if (!item) return false;
  markRaidFound(item, raidFoundSeed(sys.ctx));
  if (!a.bag.autoPlace(item)) return false;
  a.bagDirty = true;
  return true;
}
