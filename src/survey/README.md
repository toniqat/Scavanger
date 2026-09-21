# src/survey/ — the survey camera: subjects, progress, the frame HUD

`SurveySystem` (`name: 'survey'`) publishes `ctx.survey` (`SurveyRef`, contract in `src/shared/survey.ts`). The survey
camera is a **durable quick-slot tool** (`data/items.csv` `cam_survey_1…5`, grade speeds in `data/survey_cameras.csv`).
weapons/ takes it into the hand and reports its input on `ctx.weapons.surveyHand`; this folder turns that input into
progress per **subject kind** (`data/survey_subjects.csv`), draws the camera's frame HUD and owns the zoom level.
Everything a person reads is Korean; every number is csv (`SURVEY_*` in `data/constants.csv`).

## Files

| File | Responsibility |
|---|---|
| `SurveySystem.ts` | `GameSystem` + `SurveyRef`: subject lookups (enemy type · structure kind · single-row kinds), raid bookkeeping (`raidGained`, `raidPlanet`, `pendingPlanet`), `lateUpdate` (frame shape → `Scan` → recording → tags), `inputGate` (the zoom keys), `survey:progress`, save throttle. Re-exports `model.ts` |
| `model.ts` | Vocabulary: save shape (`SurveySave`, `SubjectSave`, `SURVEY_STORAGE_KEY`), `ViewEntry` (one kind's view this frame), `TagState`, scratch vectors |
| `parts/Scan.ts` | `scanBodies` (every enemy / nest hole / structure / platform / tram / rover → `consider`), `gain` (one frame of one kind: caps, ×1/4 planet rule, toasts), `wear`, `heldCamera`, `zoomSpeedMul`, `warn` |
| `parts/Store.ts` | localStorage document under `slotKey('scav.survey')` (offline / solo store + cache) and the relay profile document `survey`: `loadSave`, `writeSave`, `sanitizeSave`, `recordOf`, `uploadSave`, `adoptServer`, `isEmptySave` |
| `parts/Lifecycle.ts` | `flushOnHide` — save on `pagehide` / `beforeunload` |
| `ui/SurveyHud.ts` | The HUD DOM (`.sv-`): frame (×`SURVEY_ZOOM_RECT_MUL` zoomed), REC mark, zoom readout, one tag per kind in the frame |
| `survey.css` | HUD styles (prefix `.sv-`) |
| `index.ts` | Barrel |

## Public API

- **`ctx.survey`**: `progressOf(id)` (account 0 … 1), `raidGains()` (subjects that gained this raid — kept until the next
  `game:newMission`, read by the raid-end settlement for its XP cards), `active` (the camera is the held item and the HUD
  is up), `zoom` (the camera's magnification, handed to the rig by weapons/).
- **Emits**: `survey:progress {subjectId, progress, percent}` on every whole-percent step (meta/'s `survey` NPC objective
  reads it), `ui:notify` (100 % reached · raid cap reached · camera worn out), `audio:play`.
- **Consumes**: `game:newMission` (reset the raid, remember `ctx.missionPlanet`), `game:complete` / `over` / `abort` /
  `hub:entered` (stamp the planet, save), `ui:cinematic`, `net:profileLoaded` (adopt the server `survey` document).
- **Reads**: `ctx.weapons.surveyHand`, `ctx.player` (`isAiming`, dead / downed), `ctx.enemies.getEnemies()`,
  `ctx.world` (`getNestPositions`, `getStructures`, `getRailLines`, `getTrams`, `rover`, `raycast`), `ctx.inventory`
  (`findItem`, `damageDurability`), `ctx.loot.getItemDef`.
- **Registration** (`src/main.ts`): `survey.inputGate` right **before** `PlayerSystem`, the system itself right **after**
  `HudSystem`.

## Rules

- **One tick per subject kind per frame** — five scavengers in the frame record exactly as fast as one. — `SurveySystem.lateUpdate`
- **In the frame** = the body's centre projects inside the rectangle, in range (`SURVEY_MAX_RANGE_M` + its radius), and a
  world ray from the camera reaches it (a hit short of `distance − radius` hides it). **Zoomed**, its whole bounding box must
  project inside too; a body that crosses the border shows `프레임 밖` and gains nothing. — `parts/Scan.consider`
- Progress only in a **real raid** (`missionMode === 'raid'` and `isRaidActive()`); the frame and tags still show elsewhere.
- Per raid a subject gains at most its `raidCap`; progress never exceeds 1 and never goes down. A subject recorded on this
  planet in an **earlier** raid gains at ×`SURVEY_REPEAT_PLANET_MUL` — the planet is stamped at raid end
  (`commitPlanets`), so the current raid is never penalised by itself.
- Speed = camera grade `speedMul` × zoom (`zoomSpeedMul`: 1 at `SURVEY_ZOOM_MIN` → `SURVEY_ZOOM_SPEED_MAX_MUL` at
  `SURVEY_ZOOM_MAX`) ÷ the subject's `seconds`.
- The camera wears `SURVEY_CAMERA_WEAR_PER_S` per second **of actual gain** (not of a held trigger on an empty frame),
  applied in whole units through `InventoryRef.damageDurability`. At 0 it records nothing until repaired.
- The zoom keys (interact = out, reload = in) are read **only while zoomed** and consumed in `inputGate`, which runs before
  player/, so a zoom step never opens a door or starts a hold interaction's press.
- The HUD never reads layout: the frame is sized in `vh` from csv, tags are placed in percent from NDC. — `ui/SurveyHud`
- Projection happens in `lateUpdate` after `camera.updateMatrixWorld()` (CLAUDE.md §4.2).
- `parts/*` import only types from `SurveySystem.ts`.

## Known limits

- **Server copy = the profile document `survey`**, same rules as meta/: every flush writes localStorage and
  `ctx.net.profile.set('survey', copy)` (offline too — ProfileSync queues it); `net:profileLoaded` flushes unsaved gains
  first, then the server copy replaces the local save (server wins; a queued local edit is what `get` returns, so it is
  uploaded, not lost). No server document (a profile from before 2026-09-21) → the local save is uploaded, **unless it is
  empty** — an empty upload would become rev 1 and beat a machine that has progress. A revision conflict drops the local
  gain in the server's favour, like every document (progress is monotonic, but no max-merge is done).
- Remote players see only the held item (`remoteState.heldItemId`) — survey is personal, nothing goes on the wire.

## Decisions

- **Camera = a durable quick-slot tool, not a weapon slot** (2026-09-21, user's decision). Lost to the corpse like every
  quick-slot stack; repaired and salvaged from its `recipes.csv` inputs.
- **Wear only while it actually records.** Rejected: wear per second of a held trigger (an empty frame would cost durability).

## Recent changes

Last 5 only — older: `git log -- src/survey`.
- 2026-09-21 — Progress stored on the account: profile document `survey` (`parts/Store` `uploadSave` / `adoptServer`,
  `SurveySystem.onProfileLoaded`); localStorage stays as the offline store and cache.
- 2026-09-21 — Folder created: survey camera (frame, zoom 2×–8× on interact / reload, per-kind progress with raid cap and the
  ×1/4 planet rule, localStorage persistence, `survey:progress`), `ctx.survey`.
