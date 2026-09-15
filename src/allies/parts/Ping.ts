/**
 * src/allies/parts/Ping.ts — 안드로이드의 **핑과 말**.
 *
 * 둘 다 「모든 클라이언트에서 한 번씩」이 규약이다: 권위는 **로컬로 이벤트를 내고** 와이어로도 보내며, 리플리카는
 * 받은 와이어를 같은 이벤트로 푼다 (`parts/Sync`). ui 가 `ally:ping` 을 그리고 `ping:placedV3` 를 다시 내므로,
 * 안드로이드는 자기 핑을 명령으로 오해하지 않도록 `owner` 가 안드로이드 id 인 핑을 무시한다 (`parts/Commands`).
 */
import type * as THREE from 'three';
import { ALLY_CHAT_REPEAT_S } from '@/shared';
import type { PingKind } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';

/** 핑 하나 — 로컬 이벤트 + 와이어. */
export function place(sys: AllySystem, a: Ally, kind: PingKind, position: THREE.Vector3, label?: string, enemyId?: number): void {
  sys.ctx.bus.emit('ally:ping', { id: a.id, name: a.name, slot: a.slot, kind, position, label, enemyId });
  sys.sendPing(a, kind, position, label, enemyId);
}

/** 한 줄 말한다. 같은 문장은 `ALLY_CHAT_REPEAT_S` 동안 다시 하지 않는다 (「없다」의 반복 방지). 말했으면 true. */
export function say(sys: AllySystem, a: Ally, text: string): boolean {
  const now = sys.ctx.time;
  const last = a.lastSaid.get(text) ?? -Infinity;
  if (now - last < ALLY_CHAT_REPEAT_S) return false;
  a.lastSaid.set(text, now);
  sys.ctx.bus.emit('ally:chat', { id: a.id, name: a.name, slot: a.slot, text });
  sys.sendChat(a, text);
  return true;
}
