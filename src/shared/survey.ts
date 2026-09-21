/**
 * Survey camera (2026-09-21, user's decisions):
 *
 * - A **durable quick-slot tool** in 5+ grades (csv speed multiplier per grade); it loses durability while surveying and
 *   is repaired like other durable gear. Dies with the player like every quick-slot stack.
 * - While it is the held quick item the crosshair becomes a **rectangle**; holding fire surveys **every subject inside
 *   the rectangle at once** (one tick per subject kind, not per body).
 * - Right-click = scope zoom (`E` out / `R` in, 2×–8×); zoomed, the rectangle is twice as large, a subject that crosses
 *   its border gains nothing, and progress speeds up with zoom (up to ×2).
 * - Progress is **per account (character) per subject**, 0 … 1. One raid can add at most a csv cap per subject; a subject
 *   already surveyed on this planet in an earlier raid gains at ×1/4.
 * - Subjects are **per kind** (`data/survey_subjects.csv`): every enemy type, the rover, the tram, the four structure
 *   kinds, a nest …
 * - Raid end: one XP card per subject that gained progress (`raidRewards` kind `survey`).
 * - Unlock line: Raven `q_rv_1` → a new survey NPC contacts, mails a common camera (`MailRef.send`) and offers a quest
 *   (any subject to 100 %) → completing it opens the survey corporation, which sells higher-grade cameras by rep.
 *
 * Owner: `src/survey/` (`SurveySystem`, `ctx.survey`).
 */

export interface SurveyRaidGain {
  subjectId: string;
  /** Korean subject name. */
  name: string;
  /** Progress added this raid, 0 … 1. */
  gained: number;
  /** Account progress after this raid, 0 … 1. */
  progress: number;
}

export interface SurveyRef {
  /** Account progress of that subject, 0 … 1 (0 for unknown ids). */
  progressOf(subjectId: string): number;
  /** Subjects that gained progress in the current / just-ended raid. Cleared on `game:newMission`. */
  raidGains(): readonly SurveyRaidGain[];
  /** True while the camera is the held item (other folders hide their reticle / ignore fire). */
  readonly active: boolean;
}

/* ══ appended 2026-09-21 (owner: survey/ — agent SURVEY): the tables, the camera ↔ weapons hand-off ══ */
import { addDataIssue, csvRows } from './data/tables';
import type { CorpId } from './meta';

/**
 * What a subject row counts. `enemy` = `EnemyRef.type` in `match` · `rover` = `WorldRef.rover` · `tram` =
 * `WorldRef.getTrams()` · `platform` = the rail platforms · `structure` = `StructureDef.kind` in `match` ·
 * `nest` = `WorldRef.getNestPositions()` (its `match` may list enemy types that count as the nest too — the eggs).
 */
export const SURVEY_SUBJECT_KINDS = ['enemy', 'rover', 'tram', 'platform', 'structure', 'nest'] as const;
export type SurveySubjectKind = typeof SURVEY_SUBJECT_KINDS[number];

export interface SurveySubjectDef {
  id: string;
  /** Korean display name. */
  name: string;
  kind: SurveySubjectKind;
  /** `enemy` / `nest`: enemy type ids · `structure`: structure kinds. Empty for the others. */
  match: readonly string[];
  /** Seconds of framing to go from 0 to 100 % with a ×1 camera, unzoomed, on a fresh planet. */
  seconds: number;
  /** Most progress (0 … 1) one raid can add to this subject. */
  raidCap: number;
  /** Bounding radius / height (m) for bodies the world gives no size for (tram · nest; structure height). */
  radius: number;
  height: number;
  /** File row order. */
  order: number;
}

const SUBJECT_FILE = 'survey_subjects.csv';
const STRUCTURE_MATCH: readonly string[] = ['outpost', 'lab', 'wreck'];
const ENEMY_TYPE_IDS: ReadonlySet<string> = new Set(csvRows('enemies.csv').map((r) => r.raw('type')));

export const SURVEY_SUBJECTS: readonly SurveySubjectDef[] = csvRows(SUBJECT_FILE).map((r, order) => {
  const kind = r.enum('kind', SURVEY_SUBJECT_KINDS);
  const match = r.list('match');
  for (const m of match) {
    const ok = kind === 'structure' ? STRUCTURE_MATCH.includes(m) : (kind === 'enemy' || kind === 'nest') ? ENEMY_TYPE_IDS.has(m) : false;
    if (!ok) r.report('match', `'${m}' — ${kind} 대상에 맞지 않는 값 (적 타입 id · 구조물 종류)`);
  }
  if ((kind === 'enemy' || kind === 'structure') && match.length === 0) r.report('match', `${kind} 대상에는 match 가 필요하다`);
  return {
    id: r.str('id'), name: r.str('name'), kind, match,
    seconds: r.num('seconds', { min: 1 }),
    raidCap: r.num('raidCap', { min: 0.01, max: 1 }),
    radius: r.num('radius', { min: 0, fallback: 0 }),
    height: r.num('height', { min: 0, fallback: 0 }),
    order,
  };
});
export const SURVEY_SUBJECT_MAP: ReadonlyMap<string, SurveySubjectDef> = new Map(SURVEY_SUBJECTS.map((s) => [s.id, s]));
{
  const seen = new Set<string>();
  const enemyOwner = new Map<string, string>();
  for (const s of SURVEY_SUBJECTS) {
    if (seen.has(s.id)) addDataIssue({ file: SUBJECT_FILE, line: 0, column: 'id', message: `중복 id '${s.id}'` });
    seen.add(s.id);
    if (s.kind !== 'enemy' && s.kind !== 'nest') continue;
    for (const t of s.match) {
      const prev = enemyOwner.get(t);
      if (prev) addDataIssue({ file: SUBJECT_FILE, line: 0, column: 'match', message: `적 타입 '${t}' 이 두 대상(${prev} · ${s.id})에 걸렸다` });
      enemyOwner.set(t, s.id);
    }
  }
}

/** One survey camera grade (`data/survey_cameras.csv`) — the item itself is an `items.csv` row with `durabilityMax`. */
export interface SurveyCameraDef {
  defId: string;
  /** Survey speed multiplier of this grade. */
  speedMul: number;
}

export const SURVEY_CAMERAS: ReadonlyMap<string, SurveyCameraDef> = new Map(
  csvRows('survey_cameras.csv').map((r) => [r.str('defId'), { defId: r.str('defId'), speedMul: r.num('speedMul', { min: 0.01 }) }] as const),
);

/** The camera numbers when `defId` is a survey camera, undefined otherwise. */
export function surveyCameraOf(defId: string | null | undefined): SurveyCameraDef | undefined {
  return defId ? SURVEY_CAMERAS.get(defId) : undefined;
}

/**
 * The survey corporation (the 5th corp, `data/corps.csv`). Hidden from the corp rail until `SURVEY_UNLOCK_QUEST`
 * is complete — that quest's `rewardRep` is also what lifts it to `CORP_ACCESS_REP_LEVEL`. Only this corp's shelf
 * holds survey cameras, and no other corp's `gadget` rule may (`meta/Rules.corpSells`).
 */
export const SURVEY_CORP_ID: CorpId = 'atlas';
/** The survey NPC's first quest (any subject to 100 %) — completing it opens `SURVEY_CORP_ID`. */
export const SURVEY_UNLOCK_QUEST = 'q_at_1';

/**
 * The camera as weapons/ sees it (owner: weapons, read by survey/): `ctx.weapons.surveyHand`, mutated in place
 * every frame. `trigger` = fire held with the weapon input free · `aimed` = aim held (the player is zoomed).
 */
export interface SurveyHandState {
  active: boolean;
  uid: string | null;
  defId: string | null;
  trigger: boolean;
  aimed: boolean;
}

export interface SurveyRef {
  /** The scope zoom the camera uses while aimed (`SURVEY_ZOOM_MIN` … `SURVEY_ZOOM_MAX`). weapons/ hands it to the rig. */
  readonly zoom: number;
}
/* ══ end SURVEY ══ */
