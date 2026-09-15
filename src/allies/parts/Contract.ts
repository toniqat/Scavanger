/**
 * src/allies/parts/Contract.ts — **계약 목표 찾기**. 「내 계약」 한 마디를 들으면 하네스 안에서 목표에 해당하는 것을
 * 하나 찾아 핑을 찍는다 (사용자 결정 「계약에 따라 다르나, 하네스 범위 내에서 계약 목표를 찾으면 핑」).
 *
 * ⚠ **한계**: 호스트가 확실히 아는 계약은 **자기 것**뿐이다 (`ctx.meta.activeContract` · `ctx.meta.npc.getRaidTracks()`).
 * 원격 분대원의 계약은 와이어에 없고 `comms:sent.text` 한 줄만 오므로, 그 문장에 든 목표어를 훑어 가장 그럴듯한
 * 종류로 맞춰 본다 — 맞는 것이 없으면 호스트 자신의 목표로 대신한다.
 */
import { ALLY_SENSE_RADIUS_M } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v2, dist2D } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Commands from './Commands';

/** 목표의 큰 갈래 — 무엇을 찾아 핑을 찍을지만 가른다. */
type Want = 'enemy' | 'container' | 'item' | 'structure';

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  return a.taskKind === 'contract' ? { state: 'contract', prio: PRIO.orderLoot } : null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  Nav.halt(a);
  void dt;
  if (a.oneShot) return;      // 탈출구 탐색과 같은 이유 (`Ally.oneShot`)
  a.oneShot = true;
  for (const want of wants(sys)) {
    if (find(sys, a, want)) { Commands.finishTask(sys, a); return; }
  }
  Ping.say(sys, a, CHAT_KO.noContract);
  Commands.finishTask(sys, a);
}

/** 지금 찾아야 하는 것들 (우선순위 순). */
function wants(sys: AllySystem): Want[] {
  const out: Want[] = [];
  const text = sys.requestText;
  // 원격 요청자의 문장에서 읽어 본다 (한국어 목표 문구 — `CONTRACT_GOAL_LABEL_KO` · NPC 목표 문구와 같은 말들).
  if (text) {
    if (/처치|사살/.test(text)) out.push('enemy');
    if (/상자|개봉|보관함/.test(text)) out.push('container');
    if (/회수|전리품|가치|납품/.test(text)) out.push('item');
    if (/구조물|전진기지|연구소|잔해|발견|수색/.test(text)) out.push('structure');
  }
  const goal = sys.ctx.meta?.activeContract?.def.goal;
  if (goal === 'kill_bugs' || goal === 'kill_rogues') out.push('enemy');
  if (goal === 'open_crates' || goal === 'loot_corpses') out.push('container');
  if (goal === 'extract_with_value' || goal === 'extract_with_items') out.push('item');
  for (const q of sys.ctx.meta?.npc?.getRaidTracks() ?? []) {
    for (const o of q.objectives) {
      if (o.done || !o.countsHere) continue;
      if (o.def.kind === 'kill') out.push('enemy');
      else if (o.def.kind === 'recover') out.push('item');
      else if (o.def.kind === 'discover' || o.def.kind === 'search' || o.def.kind === 'interact') out.push('structure');
    }
  }
  if (out.length === 0) out.push('container', 'enemy');
  return out;
}

/** 하네스 안에서 그 갈래의 첫 대상을 찾아 핑을 찍는다. 찍었으면 true. */
function find(sys: AllySystem, a: Ally, want: Want): boolean {
  const ctx = sys.ctx;
  const center = sys.leaderKnown ? sys.leaderPos : a.position;
  const fog = ctx.world?.fog ?? null;
  switch (want) {
    case 'enemy': {
      const list = ctx.enemies?.queryNear(center, Math.min(sys.harness, ALLY_SENSE_RADIUS_M)) ?? [];
      const e = list.find((x) => !x.isDead);
      if (!e) return false;
      Ping.place(sys, a, 'enemy', e.position, undefined, e.id);
      return true;
    }
    case 'container': {
      for (const c of ctx.world?.getLootContainers?.() ?? []) {
        if (c.opened || dist2D(c.position, center) > sys.harness) continue;
        if (fog && !fog.isDiscovered(c.position)) continue;
        Ping.place(sys, a, 'crate', c.position);
        return true;
      }
      return false;
    }
    case 'item': {
      const p = ctx.pickups?.findNear(center, sys.harness) ?? null;
      if (p) { Ping.place(sys, a, 'item', p.position); return true; }
      // 바닥에 없으면 상자를 가리킨다 — 회수 목표는 결국 상자에서 나온다.
      return find(sys, a, 'container');
    }
    case 'structure': {
      for (const s of ctx.world?.getStructures() ?? []) {
        _v2.copy(s.position);
        if (dist2D(_v2, center) > sys.harness) continue;
        if (fog && !fog.isDiscovered(_v2)) continue;
        Ping.place(sys, a, 'structure', _v2);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}
