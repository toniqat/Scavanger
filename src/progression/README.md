# progression/ — character growth: level, stats, skills, derived numbers, profile

`ProgressionSystem` publishes `ctx.progression` (`ProgressionRef`, contract in `src/shared/progression.ts`) in `init`.
It owns the persistent character profile (per save slot): level / XP, 5 stats, 16 skills, stat XP, gym training,
equipped implant items, prep and meal lifetimes, and **every gameplay number derived from them** (`derived`). Meal
buffs, library effects, gym training and implant items all fold into `derived`, so consumers read one place. It also
owns the character sheet (standalone overlay + embedded tab). Registered in `main.ts` right after `NetSystem`, before
the systems that read `derived` (housing, player, implants, inventory, weapons, ui).

Other folders never re-implement a formula: read `ctx.progression?.derived` with optional chaining and a neutral
default (multiplier 1, bonus 0).

## Files

| File | Responsibility |
|---|---|
| `ProgressionSystem.ts` | `GameSystem` + `ProgressionRef`. Profile ownership, skill-training bus subscriptions, `recompute` of `derived` (`deriveFor`), autosave + `pagehide` flush, `progression` server document, implant items, preps, meals, gym training, starter implant, sheet refresh (`views`). |
| `defs.ts` | `STAT_DEFS` / `SKILL_DEFS` (from `data/stats.csv` / `data/skills.csv`), `DERIVED_PANEL_KEYS` (derived rows on the sheet), `derivedKeysOfStat` / `derivedKeysOfSkill`, `WEAPON_CLASS_SKILL`, per-action skill XP (`GUN_HIT_XP`, `CRAFT_XP`, … from `data/tables.csv`). |
| `derive.ts` | `computeDerived(profile, specialBackpack, implants?)`, `applyMealBuff`, `applyLibraryDerived`, `mealEffectsOf`, `trainedBonusOf`, `xpForLevel`, `throwRangeMetres`, `DEFAULT_DERIVED`. Stat / skill effect sizes are code constants at the top (`SKILL_GAIN_PER_INT`, `SKILL_STAT_FACTOR`, `*_AT_MAX`); base values come from `data/constants.csv`. |
| `Profile.ts` | localStorage load / save / clear (`slotKey(PROFILE_STORAGE_KEY)`, every access in try/catch), `freshProfile`, `migrate`, `sanitizeGym` / `sanitizePreps` / `sanitizeMeal` / `sanitizeImplants`, `DEFAULT_IMPLANT`. |
| `index.ts` | Barrel. |
| `ui/SheetBody.ts` | The single sheet renderer shared by both shells: header (character name + interactive buff / debuff thumbnails borrowed through `shared/charBuffView`), XP bar, stats (pending allocation `＋`/`－`, `되돌리기`, `포인트 투자 확정` 1 s hold), skills (+ `시설 ×n` badge), implant thumbnails (`.pg-imps`), derived grid (preview + `fitDerived`), reset (warning + 1 s hold), leave warning (`requestLeave`). Exports `el`, `CharacterSheetHost`. Knows nothing about blockers / pointer lock / tabs. |
| `ui/SheetTip.ts` | Name tooltips (`.pg-tip`) for stats, skills, facility badge; highlight of linked rows (`.pg-linked`). |
| `ui/CharacterSheet.ts` | Standalone overlay (`.menu.char-sheet`): `.scr-tabs` + frame + `SheetBody`. Blocker `'stats'`, cursor mode, `ctx.escape` entry, capture-phase Tab close, key-guide owner `character`. |
| `ui/SheetView.ts` | Embedded character tab of the inventory window (`EmbeddedView`): `.cs-embed` + `SheetBody`; no blocker / lock / Escape. |
| `ui/character.css` | Sheet styles (`.cs-*`, `.pg-*`); the `포인트 투자 확정` hold keycap paints its mouse glyph white (`--c-accent` / `color` overridden on `.kcm-glyph` only, chevron keeps the accent). |

## Public API

`ProgressionRef` (see `src/shared/progression.ts` for signatures):

- **Read**: `profile`, `derived`, `level`, `xp`, `xpToNext`, `statPoints`, `getStat` (base), `getStatWithImplants`
  (base + implant + gym training), `getImplantBonus`, `getSkill`, `getSkillProgress`, `getStatProgress`,
  `statXpToNext`, `getStatDef` / `getSkillDef` / `getAllStatDefs` / `getAllSkillDefs`, `skillForWeaponClass`,
  `getSkillGainMul(id)` (= `ctx.housing?.getSkillGainMul(id) ?? 1`).
- **Progress**: `addXp`, `addSkillXp(id, amount)`, `addSkillXpRaw` (cheat / debuff, no scaling), `addStatXp(id, amount, source?)` (`'action'` default · `'minigame'`),
  `spendStatPoint`, `spendStatPoints(alloc)` (all-or-nothing), `previewDerived(alloc)` (sheet host only), `resetProfile`,
  `save()` (forced write).
- **Implant items**: `implantSlots`, `implantSlotsUsed`, `getEquippedImplants`, `equipImplant(uid)`,
  `unequipImplant(uid)`, `stripImplantsForCorpse()` (death only).
- **Preps**: `getPreps`, `getActivePreps`, `usePrep(defId)`, `hasEnvPrep(env)`, `armPreps()`, `clearActivePreps()`.
- **Meals**: `getMeal`, `getActiveMeal`, `getMealQuality`, `getActiveMealQuality`, `useMeal(defId, quality)`,
  `serveMeal(defId, quality)` (contract only — no caller since 2026-09-16). Meal defs come from `shared/meals`
  (`getMealDef`), not `ctx.loot` — meals are not items.
- **Gym training**: `applyGymSession(stat, score)`, `getTrainedBonus`, `getTrainedProgress` / `trainedXpToNext` (= the stat-XP bar since 2026-09-17),
  `getGymFatigueUntil`, `gymNow`; console-only `addTrainedXp`, `clearGymFatigue`.
- **UI**: `createSheetView(host)` → `EmbeddedView` (with `requestLeave`); the overlay opens on `ui:statsToggled`.

**Events emitted**: `progress:loaded`, `progress:xpGained`, `progress:levelUp`, `progress:statChanged`,
`progress:statXp`, `progress:skillProgress`, `progress:skillUp`, `progress:implantsChanged`, `progress:prepChanged`,
`progress:mealChanged`, `progress:trainedChanged`, `progress:gymFatigue`; `ui:statsToggled`, `ui:keyGuide`,
`ui:notify`, `audio:play`.

**Events consumed** (skill training and lifecycle):

| Event | Effect |
|---|---|
| `weapon:equipped` / `weapon:fired` / `weapon:hit` (`enemyId` ≠ null) | `gun_<class>` XP, once per shot (shotgun pellets); legendary uniques (`def.unique`) give none |
| `player:gritSaved` | `grit` |
| `gather:collected` | `gardening` (`kind === 'salvage'` → `crafting`) |
| `craft:completed` | recipe `skill` (`crafting` / `medicine`); none for lab benches and the cooking bench (`LAB_BENCHES`) |
| `repair:completed` | `equipment` |
| `implant:activated` | `implant`; `implant:equipped` writes `profile.implant` |
| `extraction:activated` | `cryptography` |
| `crate:open` (once per container id per raid) · `container:itemRevealed` | `appraisal` |
| `inventory:weightChanged` + growth of `ctx.player.selfMovedMeters` in `update` (self-propelled metres only — no ship / vehicle / carried / grapple / dash / impulse movement) | `carry` |
| housing (direct `addSkillXp`) | `cooking` (cook result), `research` (analysis collect); inventory gives `research` for lab-bench crafts |
| `equip:changed`, `loadout:changed`, `housing:libraryChanged`, `game:phaseChanged` | `recompute` |
| `game:newMission`, `world:ready`, `player:died`, `game:abort` | reset per-raid trackers / drop pending sheet points / flush |
| `hub:entered` | `grantStarterImplant` |
| `net:profileLoaded` | replace profile with server document |
| `progress:loaded` | `ctx.net.setPlayerName(profile.name)` |

## Rules

- **Skill gain**: `amount × derived.skillGainMul × getSkillGainMul(skill) × statFactor / (1 + level × SKILL_COST_SLOPE)`.
  `addSkillXp` applies the housing multiplier itself — callers never multiply it again. In the simulation arena
  (`ctx.isTraining()`) only `gun_*` train, × `TRAINING_SKILL_GAIN_MUL`. — `ProgressionSystem.ts` (`addSkillXp`)
- **Stats are measured from `STAT_BASE`** (a fresh character sits at neutral multipliers). `getStat` stays the base;
  implant and gym bonuses are added only inside `derive.stat()` and are not clamped to `STAT_MAX`.
  — `derive.ts` (`stat`, `trainedBonusOf`)
- **Stat points only in the ship**: `spendStatPoint(s)` refuse during a raid. The sheet only *pends* points; they apply
  on the hold confirm through `spendStatPoints` (one recompute, one save). Pending points survive `refresh()`, are
  asked about on a player's leave (`requestLeave`), and are dropped silently on forced exits (phase change, new
  mission, death, `net:profileLoaded`, reset). — `ui/SheetBody.ts`
- **Fold, don't add concepts**: meal buffs (`MealBuff` = `DerivedStats` field names) and library `derived` effects are
  added at the end of `deriveFor` (additive, floored at 0; meal lines × `1 + mealQualityBonus(quality)`). The sheet
  preview uses the same `deriveFor`. Credits / sell-price multipliers must not be added (server validates credits).
  — `derive.ts` (`applyMealBuff`, `applyLibraryDerived`)
- **Anything that must survive a reload goes through `Profile.migrate`**: `migrate`'s result is the next save, so a
  field not copied there is lost on the first write (preps, meals + quality, gym fields, implants, `accent` /
  `createdAt` / `playedAt`). A profile newer than `PROFILE_VERSION` starts fresh keeping the name. — `Profile.ts` (`migrate`)
- **Prep and meal lifetime**: used in the ship → pending (`prep`, `meal`); `armPreps()` at launch moves pending to
  active (`prepActive`, `mealActive`) **only if pending is non-empty** (reconnect / solo resume also pass
  `game:newMission`); `clearActivePreps()` at raid end clears both; death does not clear. `game/` calls these two.
  — `ProgressionSystem.ts` (`armPreps`, `clearActivePreps`)
- `usePrep` refuses a second prep of the same env; `useMeal` replaces the current meal except the same def at the same
  quality (refused, so the caller does not consume an item). Callers ask first and consume the item only on success.
  2026-09-16: meals are eaten from housing dining plates (`eatPlate`), which are never consumed; `serveMeal` has no
  caller left.
- **Gym training** is separate from stat points: `applyGymSession` is ship-only. Since 2026-09-17 there is no separate
  단련 bar — session XP goes into the stat's **stat-XP bar** through `addStatXp(id, xp, 'minigame')`: a minigame addition
  that crosses the need pays 단련 +1 (`profile.trained`, cap `GYM_TRAINED_MAX`; base stat and `statPoints` untouched), an
  action addition pays a base point; at the cap minigame XP is held at 0.999999 and the next action XP tips it over; a
  `STAT_MAX` bar pinned at 1 counts as empty for minigame XP. `addTrainedXp` (console) = minigame XP when positive, whole
  단련 steps down when negative (bar untouched). Old `trainedProgress` is dropped by `migrate`. Fatigue (`GYM_FATIGUE_HOURS`) set only on a stat without active fatigue; a session during
  fatigue gives XP × `GYM_FATIGUE_GAIN_MUL` and does not extend it. `GYM_STATS` covers video-game stats too.
  Clock = `gymNow()` (relay time). Saves immediately. — `ProgressionSystem.ts` (`applyGymSession`)
- **Implant items**: slots = `min(IMPLANT_SLOTS_MAX, IMPLANT_SLOTS_BASE + ⌊level / IMPLANT_SLOTS_PER_LEVELS⌋)`. The item
  instance leaves the grids while equipped and lives in `profile.implants`. Equip / unequip only in phase `hub` and not
  in a raid; unequip refuses when stash and bag are full. `stripImplantsForCorpse` has no ship gate: every entry
  becomes its broken pair (`brokenImplantIdOf`) for the corpse, then `recompute` + **immediate save**.
  The equip UI lives in `inventory/ui/ImplantPanel.ts`; the sheet only shows bonuses and thumbnails.
- **Starter tactical implant**: new profiles have `implant: null`; `grantStarterImplant` on `hub:entered` equips
  `DEFAULT_IMPLANT` through `ctx.implants.setEquipped` (idempotent — does nothing if any implant is set, or outside the
  hub / in a raid). The tutorial raid relies on having no implant. — `ProgressionSystem.ts` (`grantStarterImplant`)
- **Legendary uniques are outside marksmanship**: `weaponClassOf` returns null for `def.unique` (no XP); weapons skip
  the recoil / reload bonus for them.
- **Sheet link data comes from csv**: `data/stats.csv` / `data/skills.csv` column `derived` (keys must be in
  `DERIVED_PANEL_KEYS`; `npm run data:check` validates). Change it together with `derive.ts`, or tooltips lie.
- **Persistence**: every flush writes localStorage and queues `profile.set('progression', …)` (offline too). On
  `net:profileLoaded` a server document is `migrate`d and **replaces** the local profile, then `progress:loaded`,
  `progress:xpGained {0}`, all `statChanged`, all `skillProgress`, prep / meal / gym events are re-emitted (no
  `levelUp`); no document → upload local. Autosave every `AUTOSAVE_INTERVAL` s when dirty; immediate saves on level-up,
  stat spend, skill level-up, implant / prep / meal / gym changes. Boot events are emitted one microtask after `init`
  so later-registered systems receive them.
- **Sheet header** (2026-09-17): the character name replaces the `캐릭터` title (no 레이드 / 탈출 counts); `(+n)` 단련 after
  the stat value without the word; no 단련 / debuff line under the stats — debuffs are the name row's thumbnails
  (`createCharBuffStrip(…, {interactive: true})`, fed by `ctx.player.buffs` + `player:buffsChanged`, hover card = `ui/hud/ItemTip`
  text card). No ui registration → no thumbnails. — `ui/SheetBody.ts`
- **Sheet overlay keys**: closes on Tab (capture phase; ignored under `MENU_BLOCKER` or in a text field) and via
  `ctx.escape`; it never handles Escape directly. The tooltip card must not use the `.item-tip` class (smokes locate the
  HUD item card by it).

## Recent changes

Last 5 only — older: `git log -- src/progression`.
- 2026-09-18 — Code comments translated to English (project-wide rule change, `CLAUDE.md` §4.1); Korean on-screen labels and csv skill names kept verbatim in backticks, no string literal touched.
- 2026-09-17 — 단련 shares the stat-XP bar (`addStatXp` `source: 'minigame'` → crossing pays 단련 +1, cap holds the bar at 0.999999; `trainedProgress` dropped by `migrate`, `stepTrained` / `trainedXpFor` removed; `data/constants.csv` `GYM_SESSION_XP` 100 → 560 stat-XP units); sheet header = character name + buff thumbnails (hover card), `(+n)` without `단련`, 단련 / debuff lines under stats and 레이드 / 탈출 counts removed.
- 2026-09-16 — `SheetBody` emits `progress:statPending {total}` when the pending ＋ total changes.
- 2026-09-16 — The crafting skill no longer speeds up crafting: `craftSpeedMul` is pinned at 1 (field kept — `DerivedStats` is add-only) and dropped from `DERIVED_PANEL_KEYS` / the sheet, so the always-×1.0 `제작 속도` row is gone; `data/skills.csv` crafting has no `derived` key and describes the material refund instead.
- 2026-09-16 — Character-sheet XP readouts are compact (`shared/numberFormat` `formatCompactNumber`): the level bar `x / y XP` and every stat row's `x / y XP` format both sides; stat values, 단련 bonuses, percentages and timers stay exact.