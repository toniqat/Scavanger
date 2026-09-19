import type { TutorialGate, TutorialHudPart, TutorialStepId } from '@/shared';
import { TUTORIAL_TRACK_STEPS } from '@/shared';
import {
  BUILD_TRACKS, HUD_GEAR_STEP, HUD_STAMINA_STEP, TUTORIAL_STASH_WHITELIST, blockedBy,
  type HudRevealState, type StepDef,
} from '../model';
import { stepDef, trackOf } from '../Steps';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Gates.ts — **gate judgement**. Pure functions, so no state and no ctx.
 *
 * There is only one rule: a gate missing from the current step's `allow` blocks, and when it is there (an array)
 * only those ids are allowed. The reason tells "what has to be done right now" as it is — not knowing why something
 * is blocked is the worst thing in a tutorial.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The detailed reason — the gate is in the allow list but another id was chosen. */
const WRONG_ID: Partial<Record<TutorialGate, string>> = {
  roomPurpose: '튜토리얼에서는 작업실만 증축합니다',
  furniture: '튜토리얼에서는 총기 작업대만 다룹니다',
  craft: '튜토리얼에서 지금 만들 것은 따로 있습니다',
  planet: '튜토리얼에서는 첫 번째 행성으로만 갑니다',
};

/**
 * Hide-only gates — always hidden while the tutorial runs.
 * `matchmaking` = the ship terminal's whole **`매칭` tab** (2026-09-15 — the old top-right `매칭` button · the
 * matchmaking popup became a tab; the meaning is unchanged: 「let them do one lap alone」). `hub/ui/HubMenu` is the
 * only consumer.
 * 2026-09-14: `community` dropped out of here — the ship track's `messenger` had to **use** the messenger (and so did
 * `ravenQuest`, until 2026-09-15). Dropping it changes nothing: a step with no `allow.community` is blocked by
 * `blockReason`, and `hides` reads that as it is.
 * 2026-09-16: `messenger` dropped out of the order too, so **no step in the order opens `community`** — the messenger
 * is hidden the whole time a track runs.
 */
const ALWAYS_HIDDEN: readonly TutorialGate[] = ['matchmaking'];

/* ── the gradual HUD reveal (2026-09-14) ───────────────────────────────────
 * Hide-only, and it lives **inside the raid track only** — in the ship · build tracks not one character of the
 * normal screen changes. There are only three rules:
 *   • `vitals` · `weapon`  — hidden **until past** the step that gets gear off a corpse (`corpseLoot`).
 *   • `stamina`            — hidden until first spent (visible past `sprintJump` at the latest — reload insurance).
 *   • `implant`·`stratagem`— hidden **for the whole** tutorial raid (there is none).
 * ──────────────────────────────────────────────────────────────────────── */

const RAID_STEPS = TUTORIAL_TRACK_STEPS.raid;

function hudHidden(step: TutorialStepId, id: string | undefined, st: HudRevealState): boolean {
  const i = RAID_STEPS.indexOf(step);
  if (i < 0 || id === undefined) return false;   // not the raid track, or a query with no id = hides nothing
  switch (id as TutorialHudPart) {
    case 'implant':
    case 'stratagem': return true;
    case 'vitals':
    case 'weapon': return i <= RAID_STEPS.indexOf(HUD_GEAR_STEP);
    case 'stamina': return !st.staminaUsed && i <= RAID_STEPS.indexOf(HUD_STAMINA_STEP);
    /*
     * 2026-09-14 2nd pass (user's decision) — the extraction ship markers. The screen (compass) marker and the top
     * extraction timer are gone for the whole raid — the tutorial ship arms no auto departure, so 「자동 출발까지」
     * would be a lie.
     *
     * 2026-09-14 4th pass (user's decision) — **the map · world markers are gone for the whole raid too.** They used
     * to be released at the `extract` step (`i < RAID_STEPS.indexOf('extract')`), and the green circle that popped up
     * over the ship at that moment (`.wmarker.ship` — a CSS circle, so it reads as a 3D sphere) became 「what is
     * that」. The tutorial map is a straight corridor: the ship cannot be missed without a marker.
     */
    case 'shipMarker':
    case 'shipScreenMarker':
    case 'extractionTimer': return true;
    default: return false;
  }
}

/** The default state in which `hides('hud', …)` hides nothing (tutorial off · the caller passed none). */
const HUD_NONE: HudRevealState = { staminaUsed: true };

/**
 * `stashItem` (2026-09-09) — one item in the ship stash grid. It is not a different allow list per step but **the
 * same whitelist for the whole build track** (granted materials · the crafted rifle · the crafted ammo), so it is
 * not written into `Steps.ts`'s `allow` and is read directly here. `allow.stashItem === true` (`raid` · `extract`)
 * opens everything. A call with no id asks "is it completely open", and only then is it null.
 */
function stashItemBlock(step: TutorialStepId, allow: true | readonly string[] | undefined, id: string | undefined): string | null {
  if (allow === true) return null;
  if (id === undefined) return null;
  // 2026-09-14: the whitelist is **the build track's** — that is the only track that uses the stash in its guidance.
  //   The ship track must not hide the loot of someone who came back from a raid.
  // 2026-09-18: 「증축 안내」 split in two — 「출격 안내」(`raid2`)'s cockpit step is still inside the ship, so the
  //   same list applies (`BUILD_TRACKS`).
  if (!BUILD_TRACKS.includes(trackOf(step))) return null;
  if (TUTORIAL_STASH_WHITELIST.includes(id)) return null;
  return '튜토리얼 중에는 안내에 쓰는 재료와 만든 것만 보입니다';
}

/**
 * `shipManage` (2026-09-16 2nd pass, user's decision) — entering ship management (`shipManageMode`). Blocked
 * **only while the ship track runs**: going into the manage camera with M in the middle of the guidance that hands
 * out stat points hides the menu · character tab guidance entirely. It is not written into the step table's `allow`
 * because the base rule 「a gate not written down is blocked」 would then block the build track (`manage` is exactly
 * what opens it) and the raid track too.
 */
const shipManageBlocked = (step: TutorialStepId): boolean => trackOf(step) === 'ship';

/**
 * `training` · `launchWarn` (2026-09-17, user's decision) — the two things hidden **for the whole build track**
 * (hide-only, they are not blocked): the terminal's `시뮬레이션 훈련장` button, and the launch-preparation warnings
 * on the ready hold (`기업 계약 없음` · `방탄복 없음` …). A tutorial character is supposed to have neither, so
 * the warning popup was cutting the flow in the middle of the guidance.
 *
 * ⚠ 2026-09-18 (「증축 안내」 · 「출격 안내」 split): the places these two are actually needed (the terminal button ·
 * the ready hold) moved to 「출격 안내」(`raid2`)'s `terminal` step — comparing one track name hides nothing from
 * that day on. `BUILD_TRACKS` looks at both.
 */
const buildOnlyHidden = (step: TutorialStepId): boolean => BUILD_TRACKS.includes(trackOf(step));

/**
 * The allow table used instead of the step's `allow` (2026-09-17 — the gates the visible objective rows opened are
 * merged in as well, `model.mergedAllow`).
 */
export type AllowTable = StepDef['allow'];

/**
 * Whether `gate` (+ `id`) is blocked at `step`. Blocked = the Korean reason, otherwise null.
 * A null `step` (inactive) is filtered out by the caller before this is reached, but null is returned here too,
 * defensively.
  * @param allowTable 2026-09-17: per-objective `allow` tables merged (`TutorialSystem` passes it); with none, the
  * step's `allow`.
 */
export function blockReason(step: TutorialStepId | null, gate: TutorialGate, id?: string, allowTable?: AllowTable): string | null {
  if (!step) return null;
  // `hud` is **hide-only** — it "blocks" nothing (the exception to the hide-what-is-blocked rule, see the section
  //   above)
  if (gate === 'hud' || gate === 'training' || gate === 'launchWarn') return null;
  if (gate === 'shipManage') return shipManageBlocked(step) ? '튜토리얼 중에는 시설 관리를 열 수 없습니다' : null;
  // the inventory tab is always open — equipping · crafting · loading ammo all happen in that window
  if (gate === 'screenTab' && (id === undefined || id === 'inventory')) return null;
  const def = stepDef(step);
  const allow = (allowTable !== undefined ? allowTable : def.allow)?.[gate];
  if (gate === 'stashItem') return stashItemBlock(step, allow, id);
  if (allow === undefined) {
    if (gate === 'community') return '튜토리얼 중에는 사용할 수 없습니다';
    if (gate === 'screenTab') return '튜토리얼 중에는 인벤토리 탭만 쓸 수 있습니다';
    return blockedBy(def.title);
  }
  if (allow === true) return null;
  if (id !== undefined && allow.includes(id)) return null;
  if (id === undefined) return null;               // a call with no id only asks "is this kind open"
  return WRONG_ID[gate] ?? blockedBy(def.title);
}

/**
 * Whether that element **must not be drawn** right now (2026-09-08).
 *
 * User's decision: a locked entry is not left in place with a "not during the tutorial" reason but **hidden
 * outright**. So
 *   • a call with an `id` = one entry — what `blockReason` blocks is exactly what is hidden.
 *   • a call with no `id` = "is this gate **completely** open" — when it is not, the UI itself narrows
 *     (places where "there is only one thing to choose", like the planet pager arrows).
  * Once the tutorial ends or is skipped `step` is null and everything returns false — lock and hiding release
  * together.
 */
export function hides(
  step: TutorialStepId | null, gate: TutorialGate, id?: string, hud: HudRevealState = HUD_NONE, allowTable?: AllowTable,
): boolean {
  if (!step) return false;
  if (gate === 'hud') return hudHidden(step, id, hud);
  if (gate === 'shipManage') return shipManageBlocked(step);
  if (gate === 'training' || gate === 'launchWarn') return buildOnlyHidden(step);
  if (ALWAYS_HIDDEN.includes(gate)) return true;
  if (id !== undefined) return blockReason(step, gate, id, allowTable) !== null;
  return (allowTable !== undefined ? allowTable : stepDef(step).allow)?.[gate] !== true;
}
