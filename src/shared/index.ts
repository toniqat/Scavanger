/* appended (2026-09-09): the source of the numbers is data/*.csv — the csv loaders / lookups are published as contract */
export * from './data/tables';
export * from './constants';
export * from './types';
export * from './events';
export * from './net';
export * from './gear';
export * from './implants';
export * from './gadgets';
export * from './progression';
export { EventBus } from './EventBus';
export { Input } from './Input';
export { GameContext } from './GameContext';
export { Random } from './Random';
/* appended: key rebinding (2026-09-06) */
export * from './Keybinds';
/* appended (2026-09-06): dev console + ship housing contracts */
export * from './console';
export * from './housing';
/* appended (2026-09-06): Phase 5 meta progression contract */
export * from './meta';
/* appended (2026-09-06): Phase 7 — server profile / raid session, item labels */
export * from './profile';
export * from './labels';
/* appended (2026-09-06): Phase 8 — the shared material-requirement chip renderer */
export * from './itemChip';
/* appended (2026-09-07): Phase 10 — the in-game mouse cursor */
export * from './cursor';
/* appended (2026-09-07): Phase 11 — planet selection · social */
export * from './planets';
/* appended (2026-09-09): the planet table reads csv, so it is split from the planets.ts the server runs */
export * from './planetDefs';
export * from './social';
/* appended (2026-09-08): the tutorial contract */
export * from './tutorial';
/* appended (2026-09-14): tutorial world queries — `ctx.world.tutorial` (checkpoints · the fall rules) */
export * from './tutorialWorld';
/* appended (2026-09-09): character save slots · character creation · currency (reward) chips */
export * from './saveSlot';
export * from './character';
export * from './currency';
/* appended (2026-09-09): the Escape close stack — ESC closes the topmost of the open screens */
export * from './escape';
/* appended (2026-09-13): the shared warning · 1 s hold-confirm popup (`openHoldAsk`) — first used by the character sheet */
export * from './holdAsk';
/* appended (2026-09-09): raid play improvements — the communication wheel contract */
export * from './comms';
/* appended (2026-09-10): the closed form of the shell arc — enemies and ui draw the same spot */
export * from './ballistics';
/* appended (2026-09-10): shader pre-compilation · the point-light budget — `ctx.shaders` */
export * from './render';
// 2026-09-20: the camera-zoom correction for anything sized in screen space (enemies' animation LOD, the sniper glint)
export * from './viewZoom';
/* appended (2026-09-11): the point-light pool — the ship (hub) and planet structures (world) light only the nearest spots by the same rule */
export * from './lightPool';
/* appended (2026-09-11): the one line that lets a throwable break window glass and pass — shared by weapons · gadgets · enemies */
export * from './fragile';
/* appended (2026-09-11): ground · air drones (`ctx.drones`) · named rogues */
export * from './drones';
export * from './named';
/* appended (2026-09-11, C-18): the ride coordinate transform — the player · enemies · corpses board the tram by the same formula */
export * from './ride';
/* appended (2026-09-11): social · trust · the link — the receiver-side buff cap · the server credit-reason grammar / economy table */
export * from './buffRules';
export * from './credits';
/* appended (2026-09-12): character buffs — meals · preparations · the workout debuff · environment exposure · resting / working out in one list (docs/DECISIONS.md 「2026-09-12 — 캐릭터 버프」) */
export * from './charBuffs';
/* appended (2026-09-12): the loot roll seed formula — the opening code and the previews (world · the drone scan) use the same one */
export * from './lootRolls';
/* appended (2026-09-12): the 「found in this raid」 mark — the count for recovery contracts · splitting stacks · the diagonal band (docs/DECISIONS.md 「2026-09-12 — 전투 소모품」) */
export * from './raidFound';
/* appended (2026-09-13): the extraction rework — `ctx.extraction` (the enemy no-entry zone · the departure grace state) */
export * from './extraction';
/* appended (2026-09-13): the cooking minigame · cooking quality — the cook-bench step table · auto-cooking furniture · quality stars (docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」) */
export * from './cooking';
/* appended (2026-09-13): crypto mining · the exchange — the coin table (csv) · the pure quote formula (shared with the relay) */
export * from './crypto';
export * from './cryptoMarket';
/* appended (2026-09-13): library series · media effects · video games (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
export * from './library';
/* appended (2026-09-14): messenger NPCs · NPC quests (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) */
export * from './npc';
/* appended (2026-09-14): the local gun damage source — the NPC quest 「그 계열 총기로 처치」 (weapons wraps it, enemies reads it) */
export * from './damageSource';
/* appended (2026-09-14): the intel broker — the fixed gimmick pick · the reading · the cost formula (shared with the relay, docs/DECISIONS.md 「2026-09-14 — 정보상」) */
export * from './intel';
export * from './intelDefs';
/* appended (2026-09-15): the shared keycap — the mouse-button drawing · the hold chevron · keycap tokens inside a sentence (`{FIRE:hold}`) */
export * from './keycap';
/* appended (2026-09-15): the two-step-stair explosion falloff — every explosive uses the same formula (weapons · enemies · gadgets · stratagems) */
export * from './explosion';
/* appended (2026-09-15): face portrait framing — the character-creation confirm popup and the terminal's matching tab draw the same face */
export * from './faceFraming';
/* appended (2026-09-15): android squadmates (`ctx.allies`) · picking a cover spot — humanoid enemies and androids use the same formula */
export * from './allies';
export * from './cover';
/* appended (2026-09-15): the title's `이어하기` · `레이드 포기` (`ctx.raidResume`) */
export * from './raidResume';
/* appended (2026-09-16): the meal def table — a meal is not an item but the plate on the dining table (`getMealDef`, `data/meals.csv`) */
export * from './meals';
/* appended (2026-09-16): the short form for large numbers — credits · value · currencies · XP all use this one formatter (`10.0k` · `1.00m`) */
export * from './numberFormat';
/* appended (2026-09-16): the shared dropdown — it stands in for every `<select>` in the game (a native list is drawn by the OS and does not fit in) */
export * from './dropdown';
/* appended (2026-09-16): the craft material refund — this is now the only thing the crafting skill does (no gate, no craft speed) */
export * from './craftRefund';
/* appended (2026-09-16): one body for the weapon card — the grid card (`inventory/ui/Tooltip`) and the chip card (`ui/hud/ItemTip`) read the same numbers and the same sentences */
export * from './weaponTip';
/* appended (2026-09-16): who is looking into a corpse — an empty corpse sinks only after the last person closed the window (game · enemies · world/tutorial) */
export * from './corpseViewers';
/* appended (2026-09-17): where the buff thumbnail strip's factory registers, so it can be borrowed outside ui (the character sheet) — ui/hud/BuffStrip registers it */
export * from './charBuffView';
/* appended (2026-09-17, B-17): hiding during a cutscene — a popup whose state would break if it closed hides for the cutscene and comes back unchanged */
export * from './cutsceneHide';
/* appended (2026-09-20, B-63): the shot sound id table — weapons/ and player/ (android squadmates) read the one table */
export * from './shotSounds';
