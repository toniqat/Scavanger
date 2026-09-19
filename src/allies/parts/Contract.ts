/**
 * src/allies/parts/Contract.ts — **finding a contract objective**. One 「내 계약」 line and it looks inside the harness
 * for one thing that answers the objective and pings it (user's decision 「계약에 따라 다르나, 하네스 범위 내에서
 * 계약 목표를 찾으면 핑」).
 *
 * ⚠ **A limit**: the only contract the host knows for sure is **its own** (`ctx.meta.activeContract` ·
 * `ctx.meta.npc.getRaidTracks()`). A remote squadmate's contract is not on the wire — only the one line of
 * `comms:sent.text` arrives — so it scans that sentence for objective words and matches the most likely kind; with
 * no match it stands in the host's own objective instead.
 */
import { ALLY_SENSE_RADIUS_M } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v2, dist2D } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Commands from './Commands';

/** The broad kind of objective — it only decides what to look for and ping. */
type Want = 'enemy' | 'container' | 'item' | 'structure';

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  return a.taskKind === 'contract' ? { state: 'contract', prio: PRIO.orderLoot } : null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  Nav.halt(a);
  void dt;
  if (a.oneShot) return;      // the same reason as the search for the way out (`Ally.oneShot`)
  a.oneShot = true;
  for (const want of wants(sys)) {
    if (find(sys, a, want)) { Commands.finishTask(sys, a); return; }
  }
  Ping.say(sys, a, CHAT_KO.noContract);
  Commands.finishTask(sys, a);
}

/** What it has to look for right now (in priority order). */
function wants(sys: AllySystem): Want[] {
  const out: Want[] = [];
  const text = sys.requestText;
  // Reads what it can from a remote requester's sentence (the Korean objective words — the same ones as
  // `CONTRACT_GOAL_LABEL_KO` and the NPC objective text).
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

/** Finds the first target of that kind inside the harness and pings it. True when it pinged. */
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
      // With nothing on the ground it points at a crate — a recovery objective comes out of a crate in the end.
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
