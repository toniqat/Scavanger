/**
 * src/survey/model.ts — the survey folder's vocabulary (no state, no class).
 *
 * Save shape, the per-frame view entry of one subject, scratch vectors. `parts/*` read these; `SurveySystem.ts`
 * re-exports the file.
 */
import * as THREE from 'three';
import type { SurveySubjectDef } from '@/shared';

/** localStorage base key (wrapped by `slotKey` — one document per character slot). */
export const SURVEY_STORAGE_KEY = 'scav.survey';
/** Save format version (bumped only by a migration). */
export const SURVEY_SAVE_VERSION = 1;

/** One subject's account record: progress 0 … 1 and the planets it was recorded on in **earlier** raids. */
export interface SubjectSave {
  p: number;
  pl: string[];
}

export interface SurveySave {
  v: number;
  s: Record<string, SubjectSave>;
}

/**
 * What the frame saw of one subject **kind** this frame (reused; `stamp` says whether it is this frame's).
 * `status`: 0 = not in the frame · 1 = crossing the frame's border while zoomed (gains nothing) · 2 = in the frame.
 */
export interface ViewEntry {
  subject: SurveySubjectDef;
  stamp: number;
  status: 0 | 1 | 2;
  /** Camera distance of the body the label hangs on (the nearest one of the best status). */
  dist: number;
  /** Label anchor in NDC (the top of that body). */
  lx: number;
  ly: number;
}

/** Label states the HUD draws. */
export type TagState = 'rec' | 'idle' | 'cut' | 'cap' | 'done';

export const _v = new THREE.Vector3();
export const _center = new THREE.Vector3();
export const _dir = new THREE.Vector3();
export const _camPos = new THREE.Vector3();
