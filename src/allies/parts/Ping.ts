/**
 * src/allies/parts/Ping.ts — an android's **pings and lines**.
 *
 * The contract for both is 「once on every client」: the authority **emits the event locally** and sends it over the
 * wire as well, and a replica turns the wire it received into the same event (`parts/Sync`). ui draws `ally:ping` and
 * emits `ping:placedV3` again, so an android ignores a ping whose `owner` is an android id — otherwise it would
 * mistake its own ping for an order (`parts/Commands`).
 */
import type * as THREE from 'three';
import { ALLY_CHAT_REPEAT_S } from '@/shared';
import type { PingKind } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';

/** One ping — the local event + the wire. */
export function place(sys: AllySystem, a: Ally, kind: PingKind, position: THREE.Vector3, label?: string, enemyId?: number): void {
  sys.ctx.bus.emit('ally:ping', { id: a.id, name: a.name, slot: a.slot, kind, position, label, enemyId });
  sys.sendPing(a, kind, position, label, enemyId);
}

/**
 * Says one line. The same sentence is not repeated for `ALLY_CHAT_REPEAT_S` (so 「없다」 does not repeat). True when
 * it spoke.
 */
export function say(sys: AllySystem, a: Ally, text: string): boolean {
  const now = sys.ctx.time;
  const last = a.lastSaid.get(text) ?? -Infinity;
  if (now - last < ALLY_CHAT_REPEAT_S) return false;
  a.lastSaid.set(text, now);
  sys.ctx.bus.emit('ally:chat', { id: a.id, name: a.name, slot: a.slot, text });
  sys.sendChat(a, text);
  return true;
}
