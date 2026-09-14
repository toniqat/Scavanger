/**
 * src/meta/parts/NpcObjectives.ts — NPC 퀘스트의 **레이드 목표** (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 진행 중(`active`) 퀘스트의 레이드 목표(recover · interact · kill · discover · search)만, 진짜 레이드(훈련장 아님)에서만,
 * 행성 조건이 맞을 때만 센다. **채우는 순간 확정**(사용자 결정): 이번 레이드 진행(`NpcQuests.raidProgress`)이 목표치에
 * 닿으면 저장된 확정 진행(`NpcQuestSave.p`)으로 옮겨지고 그 뒤 사망해도 남는다. 확정되지 않은 진행은 레이드가 끝나면 0.
 *   - `chain` 이 같은 목표들은 한 레이드 안에서 모두 닿아야 **함께** 확정된다.
 *   - `recover` 는 탈출 정산(`settleRaid`)에서만 확정된다 — 레이드 중에는 몸에 지닌 수를 보여 줄 뿐이다.
 *   - 분대 공유는 발견뿐이다(전장의 안개가 분대 공유) — 처치 · 상호작용 · 조사는 이 클라이언트의 사건만 들어온다.
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

/** 이번 레이드 진행을 올리고 확정을 시도한다. */
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

/** `i` 번 목표(와 그 chain)가 다 찼으면 확정한다. `atExtraction` = 탈출 정산 (회수 목표가 확정될 수 있는 유일한 때). */
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

/* ── 사건 ─────────────────────────────────────────────────────────────────── */

export function onKill(nq: NpcQuests, type: string, weaponClass: WeaponClass | null | undefined): void {
  advance(nq, 'kill', (o) => enemyMatches(o.enemy, type) && (!o.weapon || o.weapon === weaponClass));
}

/** 구조물 발견 (`fog:discovered kind 'structure'` — 안개는 분대 공유라 분대원이 밝혀도 온다). 레이드당 구조물마다 한 번. */
export function onDiscover(nq: NpcQuests, structureId: string): void {
  if (!nq.counting() || nq.discovered.has(structureId)) return;
  const kind = nq.ctx.world?.getStructures?.().find((st) => st.id === structureId)?.kind;
  if (!kind) return;
  nq.discovered.add(structureId);
  advance(nq, 'discover', (o) => o.site === kind);
}

/** 구조물 컨테이너 조사 (이 클라이언트의 `crate:open` — E 를 다시 눌러도 컨테이너당 한 번). */
export function onSearch(nq: NpcQuests, crateId: string, zoneKind: string | undefined): void {
  if (!zoneKind || !STRUCTURE_SITES.includes(zoneKind) || !nq.counting() || nq.searched.has(crateId)) return;
  nq.searched.add(crateId);
  advance(nq, 'search', (o) => o.site === zoneKind);
}

export function onInteract(nq: NpcQuests, kind: NpcInteractKind): void {
  advance(nq, 'interact', (o) => o.interact === kind);
}

/** 회수 목표의 표시 진행 = 지금 몸에 지닌, 이 레이드에서 얻은 수 (확정은 탈출 정산에서). */
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
 * 레이드 정산 (`MetaRef.settleMission` 이 계약 정산 **전에** 부른다 — 가방이 아직 레이드에서 가져온 그대로다).
 * 탈출했으면 회수 목표를 몸에서 세고, 모든 레이드 목표의 확정을 한 번 더 시도한다(회수가 낀 chain 포함). 훈련장 · 실패는 아무것도.
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

/** 레이드가 끝났다 — 확정되지 않은 진행을 0 으로 (`npc:objectiveProgress` 음수 delta) + 중복 방지 표를 비운다. */
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
