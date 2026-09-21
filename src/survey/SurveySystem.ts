/**
 * src/survey/SurveySystem.ts — the survey camera (2026-09-21, user's decisions; contract `shared/survey.ts`).
 *
 * Publishes `ctx.survey` (`SurveyRef`). The camera is a durable quick-slot tool: weapons/ takes it into the hand and
 * reports its input on `ctx.weapons.surveyHand`; this system turns that into progress per subject **kind**, draws the
 * frame HUD (`ui/SurveyHud`) and owns the zoom level.
 *
 * Two registrations (`src/main.ts`):
 *   - `inputGate` **before** player/ — while the camera is zoomed, interact zooms out and reload zooms in, and both
 *     keys are consumed there so the interaction prompt / nothing else reads the press;
 *   - the system itself **after** the HUD — `lateUpdate` sees the camera player/ just placed, so the frame, the
 *     projected tags and the gain all use the image on screen.
 *
 * Progress: account-wide (per character slot, `parts/Store` — localStorage plus the relay profile document `survey`), ≤ `raidCap` per raid, ×`SURVEY_REPEAT_PLANET_MUL` on a
 * planet the subject was recorded on in an earlier raid (the planet is stamped at raid end), raids only (not the
 * training range, not the tutorial). `raidGains()` lives until the next `game:newMission` so the settlement can read it.
 */
import {
  Keys, SURVEY_LABEL_MAX, SURVEY_RECT_ASPECT, SURVEY_RECT_H_FRAC, SURVEY_SAVE_INTERVAL_S, SURVEY_SUBJECTS, SURVEY_SUBJECT_MAP,
  SURVEY_ZOOM_MAX, SURVEY_ZOOM_MIN, SURVEY_ZOOM_RECT_MUL, SURVEY_ZOOM_STEP,
  type EventBus, type GameContext, type GameSystem, type SurveyRaidGain, type SurveyRef, type SurveySubjectDef,
  type SurveySubjectKind,
} from '@/shared';
import { type SurveySave, type TagState, type ViewEntry, _camPos } from './model';
import { flushOnHide } from './parts/Lifecycle';
import * as Scan from './parts/Scan';
import { adoptServer, isEmptySave, loadSave, recordOf, uploadSave, writeSave } from './parts/Store';
import { SurveyHud } from './ui/SurveyHud';

export * from './model';

const byDist = (a: ViewEntry, b: ViewEntry): number => a.dist - b.dist;

export class SurveySystem implements GameSystem, SurveyRef {
  readonly name = 'survey';
  ctx!: GameContext;
  save: SurveySave = { v: 0, s: {} };
  zoom = SURVEY_ZOOM_MIN;

  /** Per-kind view of the current frame (`Scan.consider` writes, `stamp` marks this frame's). */
  readonly views = new Map<string, ViewEntry>();
  private readonly viewList: ViewEntry[] = [];
  private readonly shownList: ViewEntry[] = [];
  stamp = 0;
  /** Enemy type → subject · structure kind → subject · the single-row kinds. */
  readonly enemySubject = new Map<string, SurveySubjectDef>();
  readonly structureSubject = new Map<string, SurveySubjectDef>();
  readonly kindSubject: Partial<Record<SurveySubjectKind, SurveySubjectDef>> = {};

  /** This raid: progress added per subject, the planet it runs on, the subjects to stamp with it at raid end. */
  readonly raidGained = new Map<string, number>();
  raidPlanet: string | null = null;
  readonly pendingPlanet = new Set<string>();
  readonly capNotified = new Set<string>();
  private gainsList: SurveyRaidGain[] = [];
  gainsDirty = false;
  /** Last whole percent announced per subject (`survey:progress`). */
  private readonly lastPercent = new Map<string, number>();

  wearAcc = 0;
  notifyAt = -Infinity;
  dirty = false;
  private saveT = 0;
  private isActive = false;
  private cinematic = false;
  private hud: SurveyHud | null = null;
  private readonly frame: Scan.FrameShape = { halfW: 0, halfH: 0, zoomed: false };
  private readonly unsubs: Array<() => void> = [];

  /** Registered before player/ — the zoom keys are consumed there (see the header). */
  readonly inputGate: GameSystem = {
    name: 'survey-input',
    init: () => { /* the system's own init runs later; the gate only reads refs */ },
    update: (_dt, ctx) => this.gateKeys(ctx),
  };

  get bus(): EventBus { return this.ctx.bus; }

  /* ── SurveyRef ── */
  get active(): boolean { return this.isActive; }
  progressOf(subjectId: string): number { return this.save.s[subjectId]?.p ?? 0; }
  raidGains(): readonly SurveyRaidGain[] {
    if (this.gainsDirty) {
      this.gainsDirty = false;
      const out: SurveyRaidGain[] = [];
      for (const s of SURVEY_SUBJECTS) {
        const g = this.raidGained.get(s.id) ?? 0;
        if (g > 0) out.push({ subjectId: s.id, name: s.name, gained: g, progress: this.progressOf(s.id) });
      }
      this.gainsList = out;
    }
    return this.gainsList;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.save = loadSave();
    for (const s of SURVEY_SUBJECTS) {
      const entry: ViewEntry = { subject: s, stamp: -1, status: 0, dist: 0, lx: 0, ly: 0 };
      this.views.set(s.id, entry);
      this.viewList.push(entry);
      this.lastPercent.set(s.id, Math.floor(this.progressOf(s.id) * 100 + 1e-6));
      if (s.kind === 'enemy' || s.kind === 'nest') for (const t of s.match) this.enemySubject.set(t, s);
      if (s.kind === 'structure') for (const k of s.match) this.structureSubject.set(k, s);
      if (s.kind !== 'enemy' && s.kind !== 'structure' && !this.kindSubject[s.kind]) this.kindSubject[s.kind] = s;
    }
    this.hud = new SurveyHud(ctx.uiRoot);
    ctx.survey = this;
    const b = ctx.bus;
    const endRaid = (): void => { this.commitPlanets(); this.flush(); };
    this.unsubs.push(
      b.on('game:newMission', () => {
        this.commitPlanets();
        this.raidGained.clear();
        this.capNotified.clear();
        this.gainsList = [];
        this.gainsDirty = false;
        this.wearAcc = 0;
        this.raidPlanet = ctx.missionPlanet;
      }),
      b.on('game:complete', endRaid),
      b.on('game:over', endRaid),
      b.on('game:abort', endRaid),
      b.on('hub:entered', endRaid),
      b.on('ui:cinematic', ({ active }) => { this.cinematic = active; }),
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
      flushOnHide(() => this.flush()),
    );
    // A profile that arrived before this init (the welcome is async, so normally it has not) is adopted now.
    if (ctx.net?.profile?.available) this.onProfileLoaded();
  }

  /**
   * `net:profileLoaded`: the server `survey` document replaces the local save (server wins, like meta/). Gains not yet
   * flushed are handed to `ProfileRef.set` first, so the mirror `get` reads is our pending edit and it is uploaded, not
   * replaced. No document on the server (a profile from before 2026-09-21) → the local save is uploaded, unless empty.
   * Subjects whose whole percent moved re-announce `survey:progress` (meta/'s survey objectives re-read it).
   */
  private onProfileLoaded(): void {
    const profile = this.ctx.net?.profile;
    if (!profile?.available) return;
    this.flush();
    const next = adoptServer(profile);
    if (!next) {
      if (!isEmptySave(this.save)) uploadSave(profile, this.save);
      return;
    }
    this.save = next;
    for (const s of SURVEY_SUBJECTS) this.emitPercent(s.id, this.progressOf(s.id));
    this.gainsDirty = true;
  }

  update(dt: number): void {
    if (!this.dirty) return;
    this.saveT += dt;
    if (this.saveT >= SURVEY_SAVE_INTERVAL_S) this.flush();
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const hud = this.hud;
    const h = ctx.weapons?.surveyHand;
    const p = ctx.player;
    const show = !!h?.active && ctx.isGameplayActive() && !this.cinematic && !!p && !p.isDead && !p.isDowned;
    this.isActive = show;
    hud?.setVisible(show);
    if (!show || !h || !p || !hud) { hud?.setRecording(false); return; }

    const zoomed = h.aimed && p.isAiming;
    hud.setZoom(zoomed, this.zoom);
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    const f = this.frame;
    f.zoomed = zoomed;
    f.halfH = SURVEY_RECT_H_FRAC * (zoomed ? SURVEY_ZOOM_RECT_MUL : 1);
    f.halfW = f.halfH * SURVEY_RECT_ASPECT / Math.max(0.01, cam.aspect);
    this.stamp++;
    Scan.scanBodies(this, f);

    // recording — a real raid only, a camera with durability left
    const held = Scan.heldCamera(this);
    const raid = ctx.missionMode === 'raid' && ctx.isRaidActive();
    if (h.trigger && held?.broken) Scan.warn(this, '조사 카메라 내구도 소진 — 함선에서 수리');
    const recording = h.trigger && raid && !!held && !held.broken;
    let gained = false;
    if (recording && dt > 0) {
      const mul = held!.speedMul * Scan.zoomSpeedMul(zoomed, this.zoom);
      for (const e of this.viewList) if (e.stamp === this.stamp && e.status === 2 && Scan.gain(this, e, dt, mul)) gained = true;
      if (gained) Scan.wear(this, held!.uid, dt);
    }
    hud.setRecording(recording);
    this.drawTags(hud, recording, raid);
  }

  /** One tag per kind in the frame, nearest first. */
  private drawTags(hud: SurveyHud, recording: boolean, raid: boolean): void {
    const list = this.shownList;
    list.length = 0;
    for (const e of this.viewList) if (e.stamp === this.stamp && e.status > 0) list.push(e);
    list.sort(byDist);
    let n = 0;
    for (const e of list) {
      if (n >= SURVEY_LABEL_MAX) break;
      const s = e.subject;
      const prog = this.progressOf(s.id);
      const capped = raid && (this.raidGained.get(s.id) ?? 0) >= s.raidCap - 1e-9;
      const state: TagState = prog >= 1 ? 'done' : e.status === 1 ? 'cut' : capped ? 'cap' : recording ? 'rec' : 'idle';
      hud.setTag(n++, s.name, prog, state, e.lx, e.ly);
    }
    hud.hideTagsFrom(n);
  }

  /** The zoom keys while the camera is zoomed — read and consumed before player/ sees them. */
  private gateKeys(ctx: GameContext): void {
    const h = ctx.weapons?.surveyHand;
    if (!h?.active || !h.aimed || !ctx.player?.isAiming || !ctx.isGameplayActive()) return;
    const input = ctx.input;
    if (input.wasPressed(Keys.RELOAD)) { input.consume(Keys.RELOAD); this.stepZoom(1); }
    if (input.wasPressed(Keys.INTERACT)) { input.consume(Keys.INTERACT); this.stepZoom(-1); }
  }

  private stepZoom(dir: 1 | -1): void {
    const next = Math.max(SURVEY_ZOOM_MIN, Math.min(SURVEY_ZOOM_MAX, this.zoom + dir * SURVEY_ZOOM_STEP));
    if (next === this.zoom) { this.bus.emit('audio:play', { id: 'ui_deny', volume: 0.3 }); return; }
    this.zoom = next;
    this.bus.emit('audio:play', { id: 'ui_click', volume: 0.35 });
  }

  /** `survey:progress` whenever a subject crosses a whole percent. */
  emitPercent(subjectId: string, progress: number): void {
    const percent = Math.floor(progress * 100 + 1e-6);
    if (this.lastPercent.get(subjectId) === percent) return;
    this.lastPercent.set(subjectId, percent);
    this.bus.emit('survey:progress', { subjectId, progress, percent });
  }

  /** Raid over: every subject recorded this raid remembers this planet (the ×1/4 rule reads it next time). */
  private commitPlanets(): void {
    const planet = this.raidPlanet;
    if (planet) {
      for (const id of this.pendingPlanet) {
        if (!SURVEY_SUBJECT_MAP.has(id)) continue;
        const rec = recordOf(this.save, id);
        if (!rec.pl.includes(planet)) { rec.pl.push(planet); this.dirty = true; }
      }
    }
    this.pendingPlanet.clear();
  }

  flush(): void {
    this.saveT = 0;
    if (!this.dirty) return;
    this.dirty = false;
    writeSave(this.save);
    uploadSave(this.ctx?.net?.profile, this.save);
  }

  dispose(): void {
    this.flush();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.hud?.dispose();
    this.hud = null;
    if (this.ctx?.survey === this) this.ctx.survey = null;
  }
}
