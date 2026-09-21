import type { KeyBindings, Stance, TutorialGate, TutorialStepId, TutorialTrack } from '@/shared';
import { formatCredits } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/model.ts — the folder's shared vocabulary (constants · types · text). No state.
 * ──────────────────────────────────────────────────────────────────────────── */

/** localStorage key of the tutorial save (`TutorialSave`). */
export const TUTORIAL_STORAGE_KEY = 'scav.tutorial';
/**
 * **v2 (2026-09-14)** — saved per track (`TutorialSave.tracks`). v1 (`step` · `done` at the top level) is moved onto
  * `tracks.build` when read, and `raid` · `ship` count as **already finished** (a player mid-game gets no new
  * guidance).
 */
export const TUTORIAL_SAVE_VERSION = 2;

/** Track names — the objective panel's label · the skip-confirm card's text. */
export const TRACK_LABEL_KO: Readonly<Record<TutorialTrack, string>> = {
  raid: '조작 안내',
  ship: '함선 안내',
  build: '증축 안내',
  // 2026-09-18 (user's decision): the last two steps of the old 증축 안내 (cockpit → launch → first raid) became their
  //   own track
  raid2: '출격 안내',
};

/**
 * **The two tracks that start inside the ship**, craft and launch (2026-09-18). Before the split there was only
 * `build`, so a rule written as 「throughout the build track」 holds for both — the stash whitelist (`stashItem`), the
 * training button and the hidden launch-readiness warnings (`parts/Gates`). Anywhere one track name was compared,
 * this list takes its place.
 */
export const BUILD_TRACKS: readonly TutorialTrack[] = ['build', 'raid2'];

/** UI blocker token the intro / skip popup holds (the spotlight holds none — it never takes the cursor itself). */
export const TUTORIAL_BLOCKER = 'tutorial';

/** What the tutorial has the player build. */
export const TUTORIAL_ROOM_PURPOSE = 'workshop' as const;
export const TUTORIAL_BENCH_DEF = 'furn_bench_gun';
export const TUTORIAL_GUN_RECIPE = 'make_wpn_ar';
export const TUTORIAL_GUN_DEF = 'wpn_ar';
/**
 * The crafted rifle's **weapon family** (`WeaponDef.family ?? id`, grade-independent — `ar` · `ar_g3` …). 2026-09-17
 * (user's decision): if a weapon of this family already sits in a primary slot the moment the equip step (`equipGun`)
 * is entered, that step has nothing to do (`TutorialSystem.equipGunMoot`).
 */
export const TUTORIAL_GUN_FAMILY = 'ar';
// (2026-09-15) `TUTORIAL_RAVEN_NPC` is gone — with the `ravenQuest` step dropped from the order this folder knows
//   no NPC at all.
/*
  * 2026-09-10 (the crafting rework) — `bulk_ammo_medium` (bulk craft, gunpowder 16 · scrap 5 → 90 rounds) vanished
  * from
  * `data/recipes.csv` and this step **never finished again**. What takes its place is `make_ammo_medium` (gunpowder
  * 6 ·
 * scrap 2 → 30 rounds). It is `station: 'field'` with no `bench`, so it works in the field, and a workbench window
 * lists every recipe that has no `bench` (`inventory/parts/Crafting.getRecipes`), so **it still shows in the gun
 * workbench window** — the tutorial's "in the same window" flow is unchanged. The yield fell 90 → 30, but the step
 * after it (`stowAmmo`) only asks "is there medium ammo in the bag", so the count does not matter.
 */
export const TUTORIAL_AMMO_RECIPE = 'make_ammo_medium';
export const TUTORIAL_AMMO_DEF = 'ammo_medium';

/**
 * The **floor** of the materials granted once at the craft step (into the ship stash on entering `craftGun`).
 * The starter grant is tuned so that generator Lv.1 + building out the workshop + crafting the bench spend scrap 20 ·
 * cable 3 · alloy 2, which leaves nothing to make anything with once the bench stands. This is the rifle
 * (`scrap 8`) + medium ammo (`gunpowder 6 · scrap 2`) plus room to spare (the 2026-09-10 crafting rework changed both
 * recipes' materials — this table is not grown, the top-up below looks at them).
 *
 * 2026-09-09: this table is only the floor and **the real requirement is read from the recipe** —
 * `TutorialSystem.ensureMaterials(recipeId)` tops up `needed − held` per material every time a craft step
 * (`craftGun` · `craftAmmo`) is entered. That is why the rifle eating scrap 6 no longer leaves medium ammo five scrap
 * short. No more numbers are written here.
 */
export const TUTORIAL_CRAFT_GRANT: readonly { defId: string; qty: number }[] = [
  { defId: 'mat_scrap', qty: 16 },
  { defId: 'mat_alloy', qty: 2 },
  { defId: 'mat_gunpowder', qty: 20 },
];

/**
 * The items **drawn in the ship stash** during the tutorial (`hides('stashItem', defId)`, 2026-09-09). Only the
 * granted materials · the crafted rifle · the crafted ammo — the rest of the starter grant (seeds · books · other
 * consumables) is gone from the stash until the guidance ends. It is not removed but simply **not drawn**
 * (`inventory/ui` judges it), so skipping or finishing brings every item back in its place.
 */
export const TUTORIAL_STASH_WHITELIST: readonly string[] = [
  ...TUTORIAL_CRAFT_GRANT.map((g) => g.defId),
  TUTORIAL_GUN_DEF,
  TUTORIAL_AMMO_DEF,
];

/**
 * The skip-confirm card's **hold time** (s, 2026-09-09). The same value as the craft button's 1 s hold
 * (`inventory/model.CRAFT_HOLD_TIME`), written again here because another feature folder's internals are never
 * imported — UI timing, not a csv number.
 */
export const SKIP_HOLD_TIME = 1.0;

/** How often the floor guide · spotlight re-find their target (s) — the DOM is not searched every frame. */
export const RETARGET_INTERVAL = 0.25;

/** The floor guide. */
export const GUIDE_COLOR = 0x7ad7ff;
/** One dash's length · gap (m) and the flow speed (m/s). */
export const GUIDE_DASH = 0.34;
export const GUIDE_GAP = 0.26;
export const GUIDE_FLOW = 2.2;
/** The strip's width (m) and how far it is lifted off the ground (z-fighting). */
export const GUIDE_WIDTH = 0.16;
export const GUIDE_LIFT = 0.03;
/** The target pillar's radius · height. */
export const PILLAR_RADIUS = 0.55;
export const PILLAR_HEIGHT = 3.0;
/** Come this close to the target and the floor guide is taken down (m). */
export const GUIDE_ARRIVE = 2.2;

/* ── The target marker (2026-09-14 3rd pass) — points at 「that corpse」 in 3D ──
 * A vertical line + one chevron pointing down. Procedural geometry, and it **creates no light**
 * (`CLAUDE.md`: never change the point-light count at runtime — this is a basic material with no emissive).
 * ────────────────────────────────────────────────────────────────────────── */

/** The marker's colour — the same orange as the UI accent (`--c-accent` #ffb347). */
export const MARKER_COLOR = 0xffb347;
/** The vertical line's bottom · top height (from the target's feet, m) and its width. */
export const MARKER_BASE_Y = 0.45;
export const MARKER_TOP_Y = 3.2;
export const MARKER_WIDTH = 0.07;
/** One chevron wing's length · thickness · spread angle (rad) — it points down. */
export const MARKER_CHEVRON_LEN = 0.52;
export const MARKER_CHEVRON_W = 0.1;
export const MARKER_CHEVRON_ANGLE = 0.72;
/** How far it bobs up and down (m) and the period (s). */
export const MARKER_BOB = 0.28;
export const MARKER_BOB_PERIOD = 2.6;
/** How often the marker re-finds its target (frames) — `ctx.interactables` is not swept every frame. */
export const MARKER_RETARGET_FRAMES = 15;
/**
 * The steps the target marker stands on — **the two first-corpse steps** (2026-09-15 2nd pass: 「open it」
 * (`corpseOpen`) and 「loot it」 (`corpseLoot`) split, but they point at one and the same corpse, so the marker has to
 * stand from the moment it says to open it).
 */
export const CORPSE_MARKER_STEPS: readonly TutorialStepId[] = ['corpseOpen', 'corpseLoot'];

/* ── Between the intro wake and the first guidance (2026-09-14 4th pass, user's decision) ──
 * While waking, neither the objective panel nor the control guide is drawn — with the screen still black and the body
 * not yet the player's, 「walk forward」 standing there first makes them read guidance instead of a cutscene. Nor is it
  * shown the instant the cutscene ends: it waits **a beat**, and for someone who moved on their own within that
  * beat it
 * appears at that moment (there is no reason left to wait).
 * Presentation numbers, not csv numbers, so they live here beside `MARKER_*` · `GUIDE_*`.
 * ────────────────────────────────────────────────────────────────────────── */

/** From the end of the intro wake until the objective panel · control guide appear (s). */
export const WAKE_REVEAL_DELAY_S = 2.0;
/** The distance that cuts that wait short (m) — move this far and they appear at once. */
export const WAKE_REVEAL_MOVE_M = 1.0;

/* ════════════════════════════════════════════════════════════════════════════
 * Objective rows (2026-09-14 2nd pass, user's decision)
 *
  * The objective panel is no longer **a title + subtitle, two lines**, but **a list of objective rows with a
  * checkbox**.
 * One step can hold several objectives, and some of them are **optional** — the step moves on without them (the label
 * is prefixed `(선택)`). On completion the check is drawn left→right and a strike-through is drawn left→right across
 * the label (`tutorial.css`).
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * One objective row. `id` is the name that survives in the done marks (`TutorialSystem.markObjective`) and the save.
 *
 * 2026-09-15 (user's decision) — **a short noun phrase, not a sentence** (`길게 눌러 붕대 사용` · `벌레 2마리 처치`).
  * A row that names a key uses a **keycap token** (`shared/keycap.renderKeyText` — `{QUICK:hold}` · `{FIRE}` ·
  * `{br}`).
 * Tokens resolve from `Keys` when drawn and `ui/Panel.relabel` redraws them on a rebind, so 「never write a key letter
  * into the text」 (a rebind makes it a lie), the rule up to 2026-09-14, is no longer in the way — write a token,
  * not a letter.
 */
export interface TutorialObjective {
  id: string;
  /** A noun phrase + keycap tokens (`{ACTION}` · `{ACTION:hold}` · `{br}`). */
  text: string;
  /** The step moves on without it — the label is prefixed `(선택)`, and it is checked **only when actually done**. */
  optional?: boolean;
  /**
    * **The target count of a counted objective** (2026-09-15 2nd pass, user's decision). When present the panel
    * appends
   * ` (current/target)` after the text and swaps **only that number node** whenever progress changes
   * (`ui/Panel.setCounts` — rebuilding the row restarts the check · strike-through animation from the beginning).
   * So **no number is written into the text**: `벌레 처치` + `count: 2` → `벌레 처치 (0/2)`.
   * The progress count's source is `TutorialSystem` (today only the kill count `kills`), and the target count is
   * derived from the constant that step counts against.
   */
  count?: number;
  /**
   * **Sequential reveal** (2026-09-14 3rd pass, user's decision) — **visible only once the row before it is done**.
   * On a step that holds three things to do, laying all three out at once buries 「what am I doing right now」. The
   * panel **does not draw** a row that has not opened yet (`visibleObjectives`). The done marks (`markObjective`) and
   * the save are unchanged.
   */
  reveal?: true;
  /**
   * A row opened by an **outside event** rather than by the row before it — visible once this id is marked done. Used
   * on a first row, where `reveal` has no preceding row to look at (`heal`'s 「the bandage went into a quick slot」).
   * The id need not be in the list — `done` remembers done marks independently of the objective list.
   */
  revealOn?: string;
  /**
   * A counted objective's **unit** (2026-09-17) — when present the tag reads ` (n / m unit)` and the numbers carry
   * grouping commas (`(420 / 1,000 C)`). With none it stays ` (n/m)`.
   */
  countUnit?: string;

  /* ── Per-objective display · allowance (2026-09-17, user's decision — 증축 안내's 「one step = several objectives」) ──
   * Grouping several steps into one means what the step used to hold now has to follow the **current objective** =
   * the **first visible, not-yet-done required row** (`currentObjective`). What that row states wins over the step's
   * value — a field the row leaves out keeps the step's. */
  /** The spotlight selectors while this row is the current objective (`[]` = light nothing). */
  spot?: readonly string[];
  spotText?: string;
  spotUnion?: boolean;
  spotNoDim?: boolean;
  /** The floor guide's target while this row is the current objective. `null` = no floor guide. */
  guide?: 'bench' | 'terminal' | 'pod' | null;
  /**
   * A 「walk to …」 row — done on entering that guide target's interaction range (the per-row form of
   * `StepDef.arriveObjective`).
   */
  arrive?: true;
  /**
   * Gates this row opens on top of the step's `allow`, **from the moment it becomes visible**. It keeps the order
   * within a single step — the pod cannot be boarded before the 「발사 슬롯 탑승」 row has opened.
   */
  allow?: Partial<Record<TutorialGate, true | readonly string[]>>;
}

/**
 * **The current objective** (2026-09-17) — the first visible, not-yet-done required row. Null once every one is done.
 * Optional rows are skipped (a row the step moves on without must not hold the focus).
 */
export function currentObjective(
  list: readonly TutorialObjective[], done: ReadonlySet<string>,
): TutorialObjective | null {
  for (const o of visibleObjectives(list, done)) if (!o.optional && !done.has(o.id)) return o;
  return null;
}

/**
 * Merges the gates the visible rows open on top of the step's `allow` (2026-09-17). With no row opening anything, the
 * step's own is returned unchanged. Array against array is a union; either side `true` makes it `true`.
 */
export function mergedAllow(
  base: StepDef['allow'], list: readonly TutorialObjective[], done: ReadonlySet<string>,
): StepDef['allow'] {
  let out: Partial<Record<TutorialGate, true | readonly string[]>> | null = null;
  for (const o of visibleObjectives(list, done)) {
    if (!o.allow) continue;
    out ??= { ...(base ?? {}) };
    for (const [g, v] of Object.entries(o.allow) as [TutorialGate, true | readonly string[]][]) {
      const have = out[g];
      out[g] = have === true || v === true ? true : [...(have ?? []), ...v];
    }
  }
  return out ?? base;
}

/** The label prefix of an optional objective. */
export const OPTIONAL_PREFIX_KO = '(선택) ';

/**
 * That step's objective rows. On a step that states no `objectives`, **the subtitle line** is the one required
 * objective (of the old `title + subtitle` pair, the subtitle already was the objective sentence).
 */
export const objectivesOf = (def: StepDef): readonly TutorialObjective[] =>
  def.objectives ?? [{ id: def.id, text: def.hint }];

/**
 * **The objective rows to draw right now** (2026-09-14 3rd pass) — the sequential reveal already resolved. If one row
 * has not opened, **everything after it** is closed too (the list's order is its turn order). A pure function, so the
 * panel and the system see the same answer.
 */
export function visibleObjectives(
  list: readonly TutorialObjective[], done: ReadonlySet<string>,
): readonly TutorialObjective[] {
  const out: TutorialObjective[] = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.revealOn && !done.has(o.revealOn)) break;
    if (o.reveal) {
      const prev = list[i - 1];
      if (!prev || !done.has(prev.id)) break;
    }
    out.push(o);
  }
  return out;
}

/**
 * `id` plus **the whole sequential-reveal chain before it**. It stops a player who did a later row first (opening the
 * item with the key instead of the wheel) from leaving the earlier row unlit forever, which would hide everything
 * after it — the chain walks back only as far as `reveal` links it.
 */
export function objectiveChain(list: readonly TutorialObjective[], id: string): readonly string[] {
  const at = list.findIndex((o) => o.id === id);
  if (at < 0) return [id];
  const out = [id];
  for (let i = at; i > 0 && list[i].reveal; i--) out.unshift(list[i - 1].id);
  return out;
}

/*
 * 2026-09-14 4th pass (user's decision) — `grenade`'s optional objective became **「draw it and throw it」**, not
 * 「a kill」. Missing with the throw does not unlearn what was learnt. So `GRENADE_KILL_WINDOW_S`, which noted the
  * moment of the blast and counted non-gun kills inside that window, is gone — the judgement is one
  * `grenade:exploded`.
 */

/**
 * One step's definition. The progress conditions live in `TutorialSystem`'s event switch — this is display and
 * gates only.
 */
export interface StepDef {
  id: TutorialStepId;
  /**
   * The step's name (console · the gate reason text `blockedBy`). **The objective panel has not drawn it since
   * 2026-09-14 2nd pass.**
   */
  title: string;
  /** The **one required objective sentence** of a step with no `objectives`. */
  hint: string;
  /**
   * The objective rows (2026-09-14 2nd pass). Left out, it is the single `[{ id, text: hint }]`.
   * Every required objective is marked done **the moment the step moves on**; an optional one is checked only when
   * it was actually done.
   */
  objectives?: readonly TutorialObjective[];
  /**
   * The gates this step **allows**. Every gate not listed here is blocked.
   * A string-array value allows those ids only (`roomPurpose: ['workshop']`).
   */
  allow?: Partial<Record<TutorialGate, true | readonly string[]>>;
  // `stashItem` is not written here — its allow list is the one step-independent `TUTORIAL_STASH_WHITELIST`, so
  //   `parts/Gates` treats it specially (only `raid` opens everything with `stashItem: true`).
  /** CSS selectors of the on-screen element this step lights (the first one found, front to back). */
  spot?: readonly string[];
  /**
   * Lights `spot` as **the union of them all** rather than "the first one found" (2026-09-08).
   * Used to guide a drag that spans two panels — lighting only one leaves the start or the end under a dim plate,
   * which ties the hand. The hole is a single rectangle, so **elements that touch each other** have to be passed for
   * it to read as one connected shape.
   */
  spotUnion?: boolean;
  /**
   * **No-dim focus** (2026-09-14 2nd pass, user's decision — `corpseLoot`). The hole · ring · callout stay, but the
    * four plates turn transparent and **pass clicks through** too. With no dim plate visible, blocked clicks alone
    * read
   * as "why won't this press".
   */
  spotNoDim?: boolean;
  /** The spotlight callout's text (`hint` with none). */
  spotText?: string;
  /** A target to walk to — the `Interactable.id` the floor guide points at (`bench` is decided at runtime). */
  guide?: 'bench' | 'terminal' | 'pod';
  /**
   * **The id of the 「walk to …」 objective row** (2026-09-14 3rd pass). It is marked done on entering the interaction
   * range of whatever `guide` points at — to keep coordinates out of this file, only the spot and radius
   * `ctx.interactables` gives are read.
   */
  arriveObjective?: string;
}

/* ── Spotlights a step swaps by situation (2026-09-14 3rd pass) ────────────
 * `Spotlight.set` compares selector arrays **by reference** to judge 「the target changed」 (on a change it folds what
 * is lit and counts half a beat again). So a swapped list is built **once, as a module constant** — handing it a new
 * array on every call turns the focus off every time `refreshVisuals` runs, and it never lights at all.
 * ────────────────────────────────────────────────────────────────────────── */

/** `equipGun` with the craft window open — the equipment slots are hidden, so the close button is lit first. */
export const SPOT_CRAFT_CLOSE: readonly string[] = ['.inv-craft-close', '.inv-panel-craft'];
/*
 * 2026-09-14 4th pass — `SPOT_HEAL_STOCK` (the corpse grid + the quick-use wheel) is gone. A bandage · grenade is
 * **registered automatically** into an empty wheel slot when picked up, so 「put it in a quick slot」 stopped being a
 * thing to do at all, and what is left (pick it from the wheel, hold it, press and hold to use) is the fingers, not
 * the screen — there is no UI to light. The control guide draws the keys that are live.
 */
/** Nothing to light (a thing done with the fingers, not on screen). */
export const SPOT_NONE: readonly string[] = [];

/*
  * The ship track `stats` step's per-objective focus (2026-09-16 2nd pass, user's decision) — **the focus moves
  * on** as
  * the objectives open one by one. It is picked in `TutorialSystem.stepView`. The first objective (`statsMenu`) has
  * the
 * menu closed, so there is no screen to light and it is `SPOT_NONE`; that guidance is one row of the right-side
 * control guide instead (`TUTORIAL_CONTROL_HINTS.stats`).
 * ⚠ The tab buttons carry no per-tab mark — the second of `SCREEN_TABS` (inventory/ui/model) is the character tab, so
 *   it is taken with `:nth-child(2)`, widening to the whole tab row when that is not found. (The ship track shows two
 *   tabs only, inventory and character.)
 */
/** ② Move to the character tab. */
export const SPOT_STATS_TAB: readonly string[] = ['.inv-root .scr-tabs .scr-tab:nth-child(2)', '.inv-root .scr-tabs'];
export const STATS_TAB_TEXT = '캐릭터 탭으로 이동';
/** ③ ＋ on one stat — the whole stat column (every ＋ row is inside it). */
export const SPOT_STATS_RAISE: readonly string[] = ['.cs-col', '.inv-root .scr-tabs'];
/**
 * The spotlight callout draws `{+}` in the shape of the character sheet's ＋ button
 * (`parts/Spotlight.renderSpotText`).
 */
export const STATS_RAISE_TEXT = '원하는 능력치 하나 {+} 를 눌러 상승';
/** ④ Confirm the investment — the `되돌리기 · 포인트 투자 확정` row. */
export const SPOT_STATS_CONFIRM: readonly string[] = ['.pg-alloc .pg-confirm', '.pg-alloc', '.cs-col'];
export const STATS_CONFIRM_TEXT = '버튼을 길게 눌러 확정';

/** The default text used when a gate blocks — the step's title is spliced in. */
export const blockedBy = (title: string): string => `튜토리얼 진행 중 — 먼저 '${title}'`;

/* ════════════════════════════════════════════════════════════════════════════
 * The right-side control guide (2026-09-14)
 *
 * A control that was learnt **stacks up one row at a time and never disappears.** The bottom-right key guide
 * (`ui/hud/KeyGuide`, `.key-guide`) is "the keys of the screen open right now" and changes every time; this one
 * accumulates, so its place is different entirely — **vertically centred on the right** of the screen (see the CSS).
 *
 * The table holds **key action names** only (and, since 2026-09-15, keycap tokens `{ACTION}`) — the keycap is painted
 * when drawn, with `shared/keycap.paintKeycap(Keys[action])` (`docs/CONTROLS.md`: keys are read at use time. On a
 * rebind they are redrawn on `input:bindingsChanged`).
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * A control **section** (2026-09-14 2nd pass, user's decision). Rows stack in this section order, not in the order
 * they were learnt, and a thin divider goes only between one section and the next. An empty section is not drawn at
 * all, so no divider appears for it either.
 */
/*
 * 2026-09-17: `meta` — the row that handles the control guide itself (`] 조작 가이드 숨김`) stands below the bottom
 * divider.
 */
export type ControlSection = 'move' | 'stance' | 'screen' | 'combat' | 'gear' | 'meta';

/**
  * The order the sections are drawn in. 2026-09-16 (user's decision): `stance` (crouch · prone) split off from
  * `move` —
 * on the crawl stretch the panel is three groups, `WASD 이동` ─ divider ─ `C 앉기 · Z 포복` ─ divider ─ `발사 · 정조준`.
 */
export const CONTROL_SECTIONS: readonly ControlSection[] = ['move', 'stance', 'screen', 'combat', 'gear', 'meta'];

/** A **pair** inside one row — one keycap group + its one label (`LMB 사격 / RMB 정조준`). */
export interface ControlHintPair {
  /** The key actions this pair shows (field names of `Keys`). Several are drawn side by side. */
  keys: readonly (keyof KeyBindings)[];
  label: string;
  /** A held key — the keycap gets a chevron (`.keycap.kc-hold`). */
  hold?: boolean;
}

/**
 * One control row. `id` is a stable name that survives in the save, so editing the text never duplicates a row.
 *
 * `keys` · `label` · `hold` are the **first pair** (the 2026-09-14 shape exactly — it was not broken), and `more` are
 * the pairs appended to the same row (added on 2026-09-14 2nd pass to fit `LMB 사격 / RMB 정조준` into one row).
 *
 * **2026-09-15 (user's decision) — the token-text row `text`.** Some controls do not fit the 「key pair」 shape
 * (`{QUICK:hold}를 꾹 눌러 수류탄 장착 후,{br}{FIRE:hold} 수류탄 던지기`). With `text` present the row draws no pairs and
  * `shared/keycap.renderKeyText` splices the keycaps into the sentence instead (`keys` · `label` · `more` are
  * ignored).
 */
export interface ControlHint {
  id: string;
  /** The first pair's key actions (left out on a `text` row). */
  keys?: readonly (keyof KeyBindings)[];
  /** The first pair's label (left out on a `text` row). */
  label?: string;
  /** The first pair is a held key. */
  hold?: boolean;
  /** The rest of the pairs on the same row (2026-09-14 2nd pass). Drawn on with a thin separator before each. */
  more?: readonly ControlHintPair[];
  /**
   * A token-text row (2026-09-15) — `{ACTION}` · `{ACTION:hold}` · `{br}`. When present it is drawn instead of the
   * pairs.
   */
  text?: string;
  /** The section this row belongs to (left out = `gear`). */
  section?: ControlSection;
}

/** Every pair a row holds (the first pair + `more`). A token-text row (`text`) has no pairs. */
export const hintPairs = (h: ControlHint): readonly ControlHintPair[] =>
  h.text !== undefined ? [] : [{ keys: h.keys ?? [], label: h.label ?? '', hold: h.hold }, ...(h.more ?? [])];

/**
  * Move · sprint · jump — `move` and the three 「walk forward」 stretches **share the same array** (2026-09-14 4th
  * pass).
  * (On 2026-09-15 `ControlHint`'s `keys` · `label` became optional fields — a token-text row `text` can stand for
  * them.)
 * When the row list is the same by reference too, `applyControls`'s id comparison passes straight through and the DOM
 * is never touched.
 */
const MOVE_HINT: ControlHint = { id: 'move', keys: ['FORWARD', 'LEFT', 'BACK', 'RIGHT'], label: '이동', section: 'move' };
const SPRINT_HINT: ControlHint = { id: 'sprint', keys: ['SPRINT'], label: '달리기', hold: true, section: 'move' };
const MOVE_HINTS: readonly ControlHint[] = [
  MOVE_HINT,
  SPRINT_HINT,
  { id: 'jump', keys: ['JUMP'], label: '점프', section: 'move' },
];

/**
 * **Every row to show on that step** (2026-09-14 3rd pass, user's decision — from 「accumulate」 to 「replace」).
 *
  * A learnt row used to stack up one at a time and stay until the track ended. By the end of the raid eight rows
  * filled
 * the right side while **one or two of them were in use**, and the key actually being learnt was buried in the list.
 * Now the table is 「the rows that **should** be on screen on that step」, and a step change **swaps them in**.
 *
 * ⚠ **A step missing from the table keeps the previous step's rows** (`wake` · `sprintJump` · `drop` and the like,
 * which teach no new key). Writing an empty array means 「empty the control guide」, which is a different thing.
 *
 * The `crouch` · `crouchAim` steps **relabel with the stance**, so they are built by `controlHintsFor(step, stance)`
 * and not by the table — what is here is the standing (default) shape, used to find ids when restoring from the save
 * (2026-09-15: `crouchAim` joined the table).
 */
/**
 * The two looting rows — the first corpse (`corpseLoot`) and the supply corpse (`supplyLoot`, 2026-09-15) use **the
 * same array** (the `MOVE_HINTS` reason: same reference means `applyControls`'s id comparison never touches the DOM).
 */
const BAG_HINT: ControlHint = { id: 'bag', keys: ['INVENTORY'], label: '가방 · 장비', section: 'screen' };

const LOOT_HINTS: readonly ControlHint[] = [
  { id: 'interact', keys: ['INTERACT'], label: '상호작용 · 루팅', hold: true, section: 'screen' },
  BAG_HINT,
];

/**
 * The equip step's one row (2026-09-16) — **the workbench window's `닫기` closes the whole window**
 * (`inventory/parts/Crafting.closeCraftWindow`, from the user's report 「I closed the workbench window and the bag
 * opened」). So the moment `equipGun` is entered neither the equipment slots nor the bag are on screen, and with no
 * DOM to light the spotlight cannot come up either (`parts/Spotlight` folds itself with no target).
 * The only guidance left is 「open the window again」, and the place to write it is the right-side control guide —
 * the guide folds itself once the window opens (`TutorialSystem.setInventoryOpen`), so the row stands only while it
 * is needed.
 */
const EQUIP_HINTS: readonly ControlHint[] = [BAG_HINT];

/*
 * The two fire · aim rows (2026-09-16, user's decision) — the old single `LMB 사격 / RMB 정조준` row was split, and aim
  * is a **hold** keycap. `shoot` · `advance2` and the back of the crawl stretch (`crouch` · `crouchAim`) use these
  * same
 * two objects. Their section differs from the movement group, so a divider stands between them.
 */
const FIRE_HINT: ControlHint = { id: 'fire', keys: ['FIRE'], label: '발사', section: 'combat' };
const AIM_HINT: ControlHint = { id: 'aim', keys: ['AIM'], label: '정조준', hold: true, section: 'combat' };
/**
 * The reload row (2026-09-17, user's decision — 「after killing the two bugs, reload below fire and aim」). Not on
 * `shoot`; it stands right under fire · aim from the moment the bugs are down (`advance2`) — and it joins the fire ·
 * aim group at the back of the crawl stretch (`crawlHalf`) as well.
 */
const RELOAD_HINT: ControlHint = { id: 'reload', keys: ['RELOAD'], label: '재장전', section: 'combat' };
/** The combat section's movement group — `WASD 이동` · `Shift 달리기` (jump is left out). */
const COMBAT_MOVE_HINTS: readonly ControlHint[] = [MOVE_HINT, SPRINT_HINT];
const SHOOT_HINTS: readonly ControlHint[] = [...COMBAT_MOVE_HINTS, FIRE_HINT, AIM_HINT];
/**
  * The stretch walked after the bugs are killed (2026-09-16, user's decision) — fire · aim are left as they are and
  * one
 * `E 시체 상호작용` row is appended below them, to say the bug corpses can be searched (same section, so it follows on
 * with no divider).
 */
const ADVANCE_AFTER_BUGS_HINTS: readonly ControlHint[] = [
  ...SHOOT_HINTS,
  RELOAD_HINT,
  // 2026-09-17: an enemy corpse is a hold (`holdTime` in `enemies/Corpses`) — the keycap gets a chevron (`hold`)
  { id: 'bugCorpse', keys: ['INTERACT'], label: '시체 상호작용', hold: true, section: 'combat' },
];

/*
 * The two quick-use rows (2026-09-15, user's decision) — `T 빠른 사용 꺼내기 · T 휠 열기` used to be **two pairs on one
 * row**, and at the guide panel's width (`.tut-controls` in `tutorial.css`) the row wrapped between the pairs,
 * scattering keycaps and labels onto different lines. So it is split into two rows.
 */
const QUICK_HINT: ControlHint = { id: 'quick', keys: ['QUICK'], label: '빠른 사용 꺼내기', section: 'gear' };
const QUICK_WHEEL_HINT: ControlHint = { id: 'quickWheel', keys: ['QUICK'], label: '휠 열기', hold: true, section: 'gear' };
/**
 * The row for using the held bandage — on `heal` it stands **only while the bandage is in hand** (2026-09-16,
 * `controlHintsFor`).
 */
const QUICK_USE_HINT: ControlHint = { id: 'quickUse', keys: ['FIRE'], label: '길게 눌러 사용', hold: true, section: 'gear' };

/**
 * The control guide of 출격 안내's raid (2026-09-17, user's decision; the step moved into `raid2` on 2026-09-18) —
 * `M 지도 / Q 전술 임플란트 / G (꾹) 함선 지원 / V 구르기 / X 시점 변경` ─ divider ─ `] 조작 가이드 숨김`. It shows in this raid
 * only. Folded with `]`, one row is left in its place, `] 조작 가이드 표시` (`ui/Controls.setFolded`, text
 * `CONTROLS_FOLDED_TEXT`). Key letters are read from `Keys` when drawn.
 */
const RAID_GUIDE_HINTS: readonly ControlHint[] = [
  { id: 'rgMap', keys: ['MAP'], label: '지도', section: 'gear' },
  { id: 'rgImplant', keys: ['IMPLANT'], label: '전술 임플란트', section: 'gear' },
  { id: 'rgShipCall', keys: ['SHIP_CALL'], label: '함선 지원', hold: true, section: 'gear' },
  { id: 'rgRoll', keys: ['DIVE'], label: '구르기', section: 'gear' },
  { id: 'rgCamera', keys: ['SHOULDER'], label: '시점 변경', section: 'gear' },
  { id: 'rgFold', keys: ['GUIDE_TOGGLE'], label: '조작 가이드 숨김', section: 'meta' },
];
/** The folded control guide's one row (a keycap token) — this row alone is left. */
export const CONTROLS_FOLDED_TEXT = '{GUIDE_TOGGLE} 조작 가이드 표시';
/** The steps whose control guide can be folded (`Keys.GUIDE_TOGGLE` is read on those steps only). */
export const FOLDABLE_CONTROL_STEPS: readonly TutorialStepId[] = ['raid'];
/** How often the carried loot value is recounted in 출격 안내's raid (frames) — the bag is not swept every frame. */
export const RAID_VALUE_POLL_FRAMES = 20;

/**
 * **The progress bar's number label** (2026-09-18, user's decision) — on 출격 안내's raid step the bar measures **the
 * loot value**, not 「which step of how many」. The bar's fill is clipped at 1, but **the text prints the real value**:
  * writing `1,000 C / 1,000 C` to someone carrying 1,400 C makes the extra look lost. Grouping commas and the unit
  * come
 * from one shared place (`formatCredits`).
 */
export const creditGaugeLabel = (at: number, total: number): string => `${formatCredits(at)} / ${formatCredits(total)}`;

export const TUTORIAL_CONTROL_HINTS: Readonly<Partial<Record<TutorialStepId, readonly ControlHint[]>>> = {
  // Straight after waking, move · sprint · jump **all at once** (2026-09-14 3rd pass, user's decision)
  move: MOVE_HINTS,
  // The three 「walk forward」 stretches (2026-09-14 4th pass) — movement is the only key being learnt, so they come
  //   back to `move`'s three rows. Keeping the previous step's rows (looting · fire · aim) would fill the right side
  //   with keys that go unused during the walk.
  advance1: MOVE_HINTS,
  // 2026-09-16 (user's decision): after the bugs are killed, fire · aim stay and `E 시체 상호작용` goes below them
  advance2: ADVANCE_AFTER_BUGS_HINTS,
  advance3: MOVE_HINTS,
  // 2026-09-15 2nd pass: the step that opens the corpse and the one that searches it use **the same array** (same
  // reference means `applyControls`'s id comparison passes straight through and never touches the DOM — no
  //   flicker).
  corpseOpen: LOOT_HINTS,
  corpseLoot: LOOT_HINTS,
  // 2026-09-16 (user's decision): `WASD 이동 · Shift 달리기` ─ divider ─ `좌클 발사 · 우클(꾹) 정조준` (the reload row was left out)
  shoot: SHOOT_HINTS,
  // The two below are **the standing shape, at the back of the passage** — the rows actually drawn are built by
  //   `controlHintsFor` from the current stance and progress through the passage. They sit in the table for one
  //   reason only: finding ids when restoring the rows from the save (`restoreControls`).
  crouch: [MOVE_HINT, ...crouchHints('stand'), FIRE_HINT, AIM_HINT, RELOAD_HINT],
  crouchAim: [MOVE_HINT, ...crouchHints('stand'), FIRE_HINT, AIM_HINT, RELOAD_HINT],
  // The only step in the build track with a row — after the whole workbench window closed, 「open the bag again」
  //   (`EQUIP_HINTS` above)
  equipGun: EQUIP_HINTS,
  // 2026-09-17: once equipping is done the `Tab 가방 · 장비` row is taken down (missing from the table before, it
  //   stayed until launch)
  terminal: [],
  // 2026-09-17 (user's decision): 출격 안내's **raid** — the five keys first used in a raid + folding the guide
  //   (`RAID_GUIDE_HINTS` above)
  raid: RAID_GUIDE_HINTS,
  supplyLoot: LOOT_HINTS,
  // 2026-09-16 (user's decision): `T 꾹 누르기 (휠 열기)` on top. `길게 눌러 사용` only while the bandage is in hand
  //   (`controlHintsFor`)
  heal: [QUICK_WHEEL_HINT, QUICK_HINT, QUICK_USE_HINT],
  grenade: [
    QUICK_HINT,
    QUICK_WHEEL_HINT,
    // 2026-09-15 (user's decision) — how to use a grenade does not fit one 「key pair」: a token-text row
    //   (`ControlHint.text`)
    { id: 'grenadeThrow', text: '{QUICK:hold}를 꾹 눌러 수류탄 장착 후,{br}{FIRE:hold} 수류탄 던지기', section: 'combat' },
    // Pulling the pin = R while the left button is held (`weapons/parts/Throwing` reads `Keys.RELOAD`)
    { id: 'grenadePin', text: '{FIRE:hold} 누른 상태에서 {RELOAD} : 핀 뽑기', section: 'combat' },
  ],
  extract: [{ id: 'map', keys: ['MAP'], label: '지도', section: 'screen' }],
  /*
   * The ship track (2026-09-16 2nd pass, user's decision) — the key that opens 「open the menu and invest a stat」.
   * The guide folds itself once the menu opens (`TutorialSystem.setInventoryOpen`), so it stands only while the
   * window is closed.
   * ⚠ ESC is not written here: what ESC opens is the pause menu, and there is no way to the character tab from it
   *   (`ui/menus/PauseMenu`).
   */
  stats: [{ id: 'statsMenu', keys: ['INVENTORY'], label: '메뉴 열기', section: 'screen' }],
};

/**
 * The two crouch · prone rows — **the label follows the current stance** (2026-09-14 3rd pass, user's decision).
 * The same key is 「앉기」 and then 「일어서기」, so someone standing is never told 「일어서기」.
 *   standing → `C 앉기` · `Z 포복` / crouched → `C 일어서기` · `Z 포복` / prone → `C 앉기` · `Z 일어서기`.
 * Key letters are still read from `Keys` when drawn (`ui/Controls`) — what is here is the text alone.
 */
export function crouchHints(stance: Stance): readonly ControlHint[] {
  return [
    { id: 'crouch', keys: ['CROUCH'], label: stance === 'crouch' ? '일어서기' : '앉기', section: 'stance' },
    { id: 'prone', keys: ['PRONE'], label: stance === 'prone' ? '일어서기' : '포복', section: 'stance' },
  ];
}

/**
 * The **observed state** of control guide rows the table alone cannot decide (2026-09-16) — `TutorialSystem` fills
 * it.
 */
export interface ControlHintState {
  /** The current stance (the crouch · prone labels). */
  stance: Stance;
  /**
   * `TUTORIAL_CRAWL_AIM_HINT_FRAC` of the collapsed passage is behind — the fire · aim rows join the crawl stretch.
   */
  crawlHalf: boolean;
  /** The held quick-use item is a healing item (a bandage) — `heal`'s `길게 눌러 사용` row. */
  handStim: boolean;
}

/**
 * The rows to show on that step (a step that rides the stance splits here). `undefined` = **keep the previous rows**.
 *
 * 2026-09-15 — `crouchAim` rides the stance too. This was the root of the 2026-09-14 3rd pass user report 「the label
  * does not change」: the `crouch` step **ends the instant the player crouches** (`player:stanceChanged` →
  * `crouchAim`),
  * and `crouchAim` had no rows in the table, so it carried the previous rows **frozen with the standing labels**
  * across
 * the whole crawl stretch. Now both steps are built from the current stance.
 */
/*
 * 2026-09-16 (user's decision) — the crawl stretch (`crouch` · `crouchAim`) is `WASD 이동` (no sprint) ─
 * `C 앉기 · Z 포복`, and about halfway through the passage (`crawlHalf`) `발사 · 정조준` joins below them. `heal`'s
 * `길게 눌러 사용` stands only while the bandage is in hand — switching to the gun · a grenade drops it, and coming
 * back to the bandage raises it again.
 */
export function controlHintsFor(step: TutorialStepId, state: ControlHintState): readonly ControlHint[] | undefined {
  if (step === 'crouch' || step === 'crouchAim') {
    const base = [MOVE_HINT, ...crouchHints(state.stance)];
    return state.crawlHalf ? [...base, FIRE_HINT, AIM_HINT, RELOAD_HINT] : base;
  }
  if (step === 'heal') return state.handStim ? TUTORIAL_CONTROL_HINTS.heal : HEAL_NO_STIM_HINTS;
  return TUTORIAL_CONTROL_HINTS[step];
}

/**
 * `heal` with no bandage in hand — the two wheel rows only (the reference has to be the same for `applyControls` to
 * leave the DOM alone).
 */
const HEAL_NO_STIM_HINTS: readonly ControlHint[] = [QUICK_WHEEL_HINT, QUICK_HINT];

/**
 * The ids of the rows that follow the stance — while one of them is up, the rows are redrawn on every stance
 * change.
 */
export const STANCE_HINT_IDS: readonly string[] = ['crouch', 'prone'];

/* ── The crouch-aim TIP (2026-09-15, user's decision) ──────────────────────
 * Aiming **for the first time** while crouched or prone on the crawl · crouch-aim stretch brings up a small TIP panel
  * once, toast-like, right below the right-side control guide. Its appearance · disappearance is driven by
  * `update(dt)`
 * on inline opacity (some PCs report reduced motion, which clips CSS transitions to 0.01 ms — a fade that carries
 * meaning is never built in CSS).
 * ────────────────────────────────────────────────────────────────────────── */

/** The steps the TIP comes up on. */
export const CROUCH_TIP_STEPS: readonly TutorialStepId[] = ['crouch', 'crouchAim'];
/** The TIP's header label and its body. */
export const TIP_LABEL_KO = 'TIP';
export const CROUCH_AIM_TIP_KO = '앉거나 포복해서 조준 시, 명중률이 높아집니다.';
/** How long it stays fully visible (s) · how long it takes to appear and to go (s). */
export const TIP_HOLD_S = 6;
export const TIP_FADE_S = 0.35;
/** Between the control guide's bottom and the TIP (px). */
export const TIP_GAP_PX = 8;

/* ── Skipping the raid track = fade to black → the results screen (2026-09-15, user's decision) ──
 * The ESC menu's 「튜토리얼 건너뛰기」 covers the screen in black and calls `ExtractionRef.skipToComplete` **the moment
 * it is fully black** — the usual extraction results screen comes up, with no ship-departure cutscene. `ui/HudSystem`
  * takes the black plate down itself the moment the phase changes to the results screen (`applyVisibility`'s phase
  * guard).
 * ────────────────────────────────────────────────────────────────────────── */

/** How long the skip's fade to black takes (s). */
export const SKIP_FADE_OUT_S = 0.6;
/**
 * How long the fade back in takes when it fell through to the liftoff cutscene instead of the results screen (the
 * fallback) (s).
 */
export const SKIP_FADE_IN_S = 0.4;

/**
 * The right-side control guide's header label — since 2026-09-14 3rd pass it is **the current stretch's controls,
 * not an accumulation**, so it is not `배운 조작`.
 */
export const CONTROLS_TITLE_KO = '조작';

/* ════════════════════════════════════════════════════════════════════════════
 * Progress through the raid track (2026-09-14)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * A checkpoint (`tutorial:checkpoint`, owner: `world/tutorial`) → **the step that starts there**.
 * A checkpoint is a stretch's **entrance**, so passing it means the previous stretch's step is over. That makes this
 * one table enough for the guidance to recover how far the player has come — walking past an optional step
 * (`grenade`) without using it, or missing one checkpoint, never blocks it.
 * There is one reason string keys are used rather than `TutorialCheckpointId` itself: this folder only **reads** the
 * world's contract.
 */
export const CHECKPOINT_STEP: Readonly<Record<string, TutorialStepId>> = {
  wake: 'wake',
  cliff: 'sprintJump',
  /*
   * 2026-09-15 2nd pass (user's decision) — `corpse` opens **`corpseOpen`**, not `corpseLoot`. Showing 「equip the SMG
   * in a primary slot」 first to someone who has just crossed the cliff tells them to move an item out of a bag they
   * have not even opened. `corpseLoot` comes once the corpse's bag actually opens (`corpse:…` on
   * `inventory:containerOpened`).
   */
  corpse: 'corpseOpen',
  /*
   * 2026-09-14 4th pass (user's decision: 「it starts when **a bug erupts** during the walk」) — `bugs` folds to
   * **`advance1`**, not `shoot`. This checkpoint is at z 60 and the bugs at (−2.5, 34) · (2.5, 28) detect at 12 m, so
   * the first one erupts around z ≈ 45.7 — opening `shoot` at the checkpoint means walking another 14 m with
   * 「벌레를 처치하세요」 on screen. The checkpoint cannot be moved (the world's contract: a respawn spot must be
   * **outside** the detection radius). So the spot is left alone and only its meaning changes to 「the entrance of the
   * walk-forward stretch」, and `shoot` is opened by the actual spawn (`TutorialSystem`'s `enemy:spawned`
   * subscription). If the step is already `advance1` when it is passed, `foldRaid` goes quietly by.
   */
  bugs: 'advance1',
  crawl: 'crouch',
  android: 'crouchAim',
  drop: 'drop',
  /*
   * 2026-09-15 (user's decision) — `supply` opens **`supplyLoot`**, not `heal`. 「use the bandage」 used to appear the
    * moment the player came down cliff 2, before there was a bandage to pick up. Now `heal` comes only once the
    * bandage
   * is taken from the supply corpse and the window closed. Walking on to `wall` without taking it makes
   * `foldRaid('grenade')` skip `heal` along with the rest.
   */
  supply: 'supplyLoot',
  wall: 'grenade',
  ship: 'extract',
};

/**
 * The kills a combat step (`shoot` · `crouchAim`) needs to move on — the same as the number of enemies placed on
 * that stretch.
 */
export const RAID_KILLS_PER_STEP = 2;

/* ════════════════════════════════════════════════════════════════════════════
 * The gradual HUD reveal (2026-09-14) — `hides('hud', part)`.
 *
 * **It lives inside the raid track only.** The ship track · build track show the usual screen (which is why the
 * judgement looks at the track first).
 * ════════════════════════════════════════════════════════════════════════════ */

/** The **observed state** `hides('hud', …)` consults — only what the table alone cannot decide. */
export interface HudRevealState {
  /** Stamina has dropped at least once (sprinting · jumping). */
  staminaUsed: boolean;
}

/**
 * The step the hp · shield · weapon panels appear on — visible **once past** the step that takes gear off the
 * corpse.
 */
export const HUD_GEAR_STEP: TutorialStepId = 'corpseLoot';
/** The stamina bar is visible past this step at the latest (or the moment it was actually spent, if earlier). */
export const HUD_STAMINA_STEP: TutorialStepId = 'sprintJump';
