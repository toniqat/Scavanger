/**
 * src/meta/parts/NpcObjectives.ts — the **raid objectives** of NPC quests
 * (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * Only the raid objectives (recover · interact · kill · discover · search) of an `active` quest count, only in a
 * real raid (not the training range), and only when the planet requirement matches. **Confirmed the moment it
 * fills** (user's decision): once this raid's progress (`NpcQuests.raidProgress`) reaches the target it moves into
 * the saved confirmed progress (`NpcQuestSave.p`) and stays there through a later death. Progress that was never
 * confirmed is 0 once the raid ends.
 *   - Objectives with the same `chain` must all be reached within one raid to be confirmed **together**.
 *   - `recover` is confirmed only at extraction settlement (`settleRaid`) — during the raid it merely shows how
 *     many are carried on the body.
 *   - Only discovery is squad-shared (the fog of war is squad-shared) — kills · interactions · searches arrive
 *     only as this client's own events.
 */
import type { MissionStats, NpcInteractKind, NpcObjectiveDef, NpcObjectiveKind, NpcQuestDef, NpcQuestSave, WeaponClass } from '@/shared';
import { NPC_QUEST_MAP, NPC_RAID_OBJECTIVE_KINDS, raidFoundSeed } from '@/shared';
import { enemyMatches } from '../NpcRules';
import type { NpcQuests } from './NpcQuests';

const STRUCTURE_SITES: readonly string[] = ['outpost', 'lab', 'wreck'];

function actives(nq: NpcQuests): [NpcQuestDef, NpcQuestSave][] {
  const out: [NpcQuestDef, NpcQuestSave][] = [];
  for (const [id, s] of Object.entries(nq.save.quests)) {
    if (s.s !== 'active') continue;
    const def = NPC_QUEST_MAP.get(id);
    if (def) out.push([def, s]);
  }
  return out;
}

function raidOf(nq: NpcQuests, def: NpcQuestDef): number[] {
  let rp = nq.raidProgress.get(def.id);
  if (!rp || rp.length !== def.objectives.length) {
    rp = def.objectives.map((_, i) => rp?.[i] ?? 0);
    nq.raidProgress.set(def.id, rp);
  }
  return rp;
}

const confirmed = (s: NpcQuestSave, o: NpcObjectiveDef, i: number): boolean => (s.p[i] ?? 0) >= o.target;

/** Raises this raid's progress and tries to confirm. */
export function advance(nq: NpcQuests, kind: NpcObjectiveKind, match: (o: NpcObjectiveDef) => boolean, amount = 1): void {
  if (!nq.counting()) return;
  for (const [def, s] of actives(nq)) {
    def.objectives.forEach((o, i) => {
      if (o.kind !== kind || confirmed(s, o, i) || !nq.planetOk(o) || !match(o)) return;
      const rp = raidOf(nq, def);
      const before = rp[i];
      rp[i] = Math.min(o.target, before + amount);
      if (rp[i] === before) return;
      nq.ctx.bus.emit('npc:objectiveProgress', { questId: def.id, index: i, progress: rp[i], target: o.target, done: false, delta: rp[i] - before, raid: true });
      tryConfirm(nq, def, s, i, false);
    });
  }
}

/**
 * Confirms objective `i` (and its chain) once they are all full. `atExtraction` = extraction settlement, the only
 * time a `recover` objective can be confirmed.
 */
export function tryConfirm(nq: NpcQuests, def: NpcQuestDef, s: NpcQuestSave, i: number, atExtraction: boolean): void {
  const o = def.objectives[i];
  if (!o || !NPC_RAID_OBJECTIVE_KINDS.has(o.kind)) return;
  const rp = raidOf(nq, def);
  const filled = (j: number): boolean => {
    const x = def.objectives[j];
    return confirmed(s, x, j) || ((rp[j] ?? 0) >= x.target && (x.kind !== 'recover' || atExtraction));
  };
  const group = o.chain ? def.objectives.flatMap((x, j) => (x.chain === o.chain ? [j] : [])) : [i];
  if (!group.every(filled)) return;
  let any = false;
  for (const j of group) {
    const x = def.objectives[j];
    if (confirmed(s, x, j)) continue;
    const shown = Math.min(x.target, rp[j] ?? 0);
    s.p[j] = x.target;
    any = true;
    nq.ctx.bus.emit('npc:objectiveProgress', { questId: def.id, index: j, progress: x.target, target: x.target, done: true, delta: x.target - shown, raid: true });
  }
  if (!any) return;
  nq.sys.store.markDirty();
  nq.checkReady(def, s);
}

/* ── Events ─────────────────────────────────────────────────────────────── */

export function onKill(nq: NpcQuests, type: string, weaponClass: WeaponClass | null | undefined): void {
  advance(nq, 'kill', (o) => enemyMatches(o.enemy, type) && (!o.weapon || o.weapon === weaponClass));
}

/**
 * Structure discovery (`fog:discovered kind 'structure'` — the fog is squad-shared, so it arrives when a squadmate
 * uncovers it too). Once per structure per raid.
 */
export function onDiscover(nq: NpcQuests, structureId: string): void {
  if (!nq.counting() || nq.discovered.has(structureId)) return;
  const kind = nq.ctx.world?.getStructures?.().find((st) => st.id === structureId)?.kind;
  if (!kind) return;
  nq.discovered.add(structureId);
  advance(nq, 'discover', (o) => o.site === kind);
}

/** A structure's container searched (this client's `crate:open` — once per container, E pressed again or not). */
export function onSearch(nq: NpcQuests, crateId: string, zoneKind: string | undefined): void {
  if (!zoneKind || !STRUCTURE_SITES.includes(zoneKind) || !nq.counting() || nq.searched.has(crateId)) return;
  nq.searched.add(crateId);
  advance(nq, 'search', (o) => o.site === zoneKind);
}

export function onInteract(nq: NpcQuests, kind: NpcInteractKind): void {
  advance(nq, 'interact', (o) => o.interact === kind);
}

/**
 * A `recover` objective's shown progress = how many of this raid's finds are carried on the body right now
 * (confirmed at extraction settlement).
 */
export function trackRecover(nq: NpcQuests): void {
  if (!nq.counting()) return;
  const seed = raidFoundSeed(nq.ctx);
  for (const [def, s] of actives(nq)) {
    def.objectives.forEach((o, i) => {
      if (o.kind !== 'recover' || confirmed(s, o, i) || !nq.planetOk(o)) return;
      const rp = raidOf(nq, def);
      const v = Math.min(o.target, nq.carried(o.item, seed));
      if (v === rp[i]) return;
      const delta = v - rp[i];
      rp[i] = v;
      nq.ctx.bus.emit('npc:objectiveProgress', { questId: def.id, index: i, progress: v, target: o.target, done: false, delta, raid: true });
    });
  }
}

/**
 * Raid settlement (`MetaRef.settleMission` calls it **before** the contract settles — the bag is still exactly what
 * came back from the raid).
 * On extraction the `recover` objectives are counted off the body and every raid objective is tried for
 * confirmation once more (a chain holding a `recover` included). The training range · a failure do nothing.
 */
export function settleRaid(nq: NpcQuests, stats: MissionStats | null | undefined): void {
  if (!stats || stats.mode === 'training' || !stats.extracted) return;
  const seed = raidFoundSeed(nq.ctx) ?? (typeof stats.seed === 'number' ? stats.seed : null);
  for (const [def, s] of actives(nq)) {
    const rp = raidOf(nq, def);
    def.objectives.forEach((o, i) => {
      if (o.kind === 'recover' && !confirmed(s, o, i) && nq.planetOk(o)) rp[i] = Math.min(o.target, nq.carried(o.item, seed));
    });
    def.objectives.forEach((o, i) => { if (NPC_RAID_OBJECTIVE_KINDS.has(o.kind) && !confirmed(s, o, i)) tryConfirm(nq, def, s, i, true); });
  }
}

/**
 * The raid is over — unconfirmed progress goes to 0 (`npc:objectiveProgress` with a negative delta) and the
 * duplicate-guard sets are emptied.
 */
export function resetRaid(nq: NpcQuests): void {
  for (const [id, rp] of nq.raidProgress) {
    const def = NPC_QUEST_MAP.get(id);
    const s = nq.save.quests[id];
    if (!def) continue;
    rp.forEach((v, i) => {
      const o = def.objectives[i];
      if (!o || v <= 0 || (s && confirmed(s, o, i))) return;
      nq.ctx.bus.emit('npc:objectiveProgress', { questId: id, index: i, progress: 0, target: o.target, done: false, delta: -v, raid: true });
    });
  }
  nq.raidProgress.clear();
  nq.searched.clear();
  nq.discovered.clear();
}
