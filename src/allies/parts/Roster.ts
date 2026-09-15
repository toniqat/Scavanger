/**
 * src/allies/parts/Roster.ts — **명단**. 「내 분대의 안드로이드는 누구인가」 한 곳.
 *
 * 규약 (계약 `shared/allies.ts`):
 *  - 도킹된 로비의 공용 함선 · 그 레이드 안에서는 **릴레이 봇 멤버**가 명단이다 (`androidPlayersOf(lobby)`).
 *  - 그 밖(개인 함선 · 서버 없음)에서는 치트 `/android` 가 만든 **로컬 명단**뿐이다.
 * 두 경우 모두 모든 클라이언트가 **같은 로비 상태에서 스스로 계산한다** — 명단에는 와이어가 없다.
 */
import * as THREE from 'three';
import {
  ALLY_LOCAL_PEER, ANDROID_BAY_COUNT, androidIdOf, androidNameOf, androidPlayersOf, isAndroidId,
  markRaidFound, raidFoundSeed,
} from '@/shared';
import type { AllyId, AllyLoadoutView, AllyRosterEntry, ItemInstance, LobbyState } from '@/shared';
import type { AllySystem } from '../AllySystem';
import { Ally } from './Body';
import * as Bag from './Bag';

/** 지금 들어가 있는 로비 — 공용 함선 세션이거나 그 레이드 안일 때만. 아니면 null (= 치트 명단). */
function lobbyOf(sys: AllySystem): LobbyState | null {
  const net = sys.ctx.net;
  if (!net) return null;
  const lobby = net.lobby;
  if (!lobby) return null;
  // 「도킹된 분대인가」 — 초대만 받고 아직 도킹하지 않은 로비는 공용 함선이 아니다 (CLAUDE.md §4.3).
  if (lobby.docked === false) return null;
  if (!net.inHubSession && !net.inSession) return null;
  return lobby;
}

/**
 * 명단을 지금 상태에서 다시 계산하고, 바뀌었으면 몸을 맞추고 `ally:rosterChanged` 를 낸다.
 * 매 프레임 부르면 배열 두 개가 계속 생기므로, 프레임 루프는 `rosterDirty` 가 설 때만 부른다
 * (`net:lobbyUpdated` · `net:lobbyLeft` · `net:androidReturned` · 함선 출입 · 치트가 세운다).
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

/** 명단에 맞춰 몸을 만들고 지운다. 공용 함선에서는 **비어 있는 슬롯의 잠든 몸**도 만든다 (`parts/Hub`). */
export function syncBodies(sys: AllySystem): void {
  const wanted = new Map<AllyId, AllyRosterEntry>();
  for (const e of sys.roster) wanted.set(e.id, e);

  // 공용 함선에서는 모집되지 않은 슬롯에도 잠든 몸이 서 있다 (사용자 결정 — 슬롯 안의 안드로이드가 보인다).
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
  }
  sys.bodies.sort((x, y) => x.bay - y.bay);
}

/** 공용 함선의 `bay` 슬롯에 서 있는 잠든 몸의 id. 공용 함선이 아니면 null. */
function dormantIdOf(sys: AllySystem, bay: number): AllyId | null {
  const net = sys.ctx.net;
  const code = net?.lobby?.code;
  if (!code || sys.ctx.hub?.ship !== 'shared') return null;
  if (bay < 0 || bay >= ANDROID_BAY_COUNT) return null;
  return androidIdOf(code, bay);
}

/** 명단에 든(= 분대원인) 안드로이드인가 — 잠든 슬롯 몸과 가른다. */
export function isRecruited(sys: AllySystem, id: AllyId): boolean {
  return sys.roster.some((e) => e.id === id);
}

/** 릴레이가 한 기를 슬롯으로 돌려보냈다 (`human_joined` = 사람이 이겼다 · `full` = 자리 없음). */
export function onReturned(sys: AllySystem, bay: number, reason: 'human_joined' | 'full'): void {
  if (reason !== 'human_joined') return;
  const code = sys.ctx.net?.lobby?.code;
  if (code) sys.evictedPending.push(androidIdOf(code, bay));
  refresh(sys);
}

/* ── 치트 명단 (서버 없음) ─────────────────────────────────────────────────── */

/** 로컬 플레이어가 쓰지 않는 첫 로비 슬롯 — 색 · 발사 포드가 겹치지 않게. */
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

/* ── 소지품 보기 ───────────────────────────────────────────────────────────── */

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

/** 스모크용 지급 — 레이드에서 주운 것으로 표시해 건네기 · 창고 이관 경로를 그대로 타게 한다. */
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

/** 안드로이드 id 인가 (계약의 `isAndroidId` 를 한 번 더 감싸 파트에서 짧게 쓴다). */
export function isAlly(id: unknown): boolean { return isAndroidId(id); }

/** 로컬 플레이어의 PeerId — 서버가 없으면 `ALLY_LOCAL_PEER`. */
export function myPeer(sys: AllySystem): string {
  return sys.ctx.net?.localId ?? ALLY_LOCAL_PEER;
}

/** 스크래치 없이 한 번 쓰고 버리는 위치 복사 (요청 보관용 — 재사용 벡터를 보관하면 안 된다). */
export function copyOf(v: THREE.Vector3): THREE.Vector3 { return v.clone(); }

/** 가방 아이템 목록을 얕게 복사한다 (시체 · 창고 이관은 원본을 넘겨서는 안 된다). */
export function snapshotItems(items: readonly ItemInstance[]): ItemInstance[] { return items.slice(); }
