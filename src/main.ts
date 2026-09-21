import { Engine } from '@/core/Engine';
import { NetSystem } from '@/net/NetSystem';
import { ProgressionSystem } from '@/progression/ProgressionSystem';
import { WorldSystem } from '@/world/WorldSystem';
import { HubSystem } from '@/hub/HubSystem';
import { PlayerSystem } from '@/player/PlayerSystem';
import { RemotePlayerSystem } from '@/player/RemotePlayerSystem';
import { WeaponSystem } from '@/weapons/WeaponSystem';
import { EnemySystem } from '@/enemies/EnemySystem';
import { InventorySystem } from '@/inventory/InventorySystem';
import { ImplantSystem } from '@/implants/ImplantSystem';
import { GadgetSystem } from '@/gadgets/GadgetSystem';
import { DroneSystem } from '@/gadgets/drones/DroneSystem';
import { PickupSystem } from '@/pickups/PickupSystem';
import { StratagemSystem } from '@/stratagems/StratagemSystem';
import { ExtractionSystem } from '@/extraction/ExtractionSystem';
import { HudSystem } from '@/ui/HudSystem';
import { AudioSystem } from '@/audio/AudioSystem';
import { GameFlowSystem } from '@/game/GameFlowSystem';
import { HousingSystem } from '@/housing/HousingSystem';
import { ConsoleSystem } from '@/console/ConsoleSystem';
import { TutorialSystem } from '@/tutorial/TutorialSystem';
import { MetaSystem } from '@/meta/MetaSystem';
import { AllySystem } from '@/allies/AllySystem';
import { SurveySystem } from '@/survey/SurveySystem';
import { ensureMigrated, loadKeybinds } from '@/shared';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

/*
 * Character save slots (2026-09-09) — **before everything else**. It moves the `scav.*` saves of the days without slots
 * into slot 1 and settles the active slot. Systems read storage once in their constructor, so every `slotKey` call
 * after this line must point at the same slot (`shared/saveSlot`).
 */
ensureMigrated();

// Player key bindings (localStorage) must be in `Keys` before any system caches a label.
loadKeybinds();

const engine = new Engine(canvas, uiRoot);

/*
 * 2026-09-07 (cursor rework): the **single** place the pointer lock is re-acquired.
 *
 * A UI surface that wants the mouse calls `input.setCursorMode(true, token)`, which releases the lock; when the last
 * owner leaves, the camera should have the mouse back immediately. Doing that here (instead of in each of the ~14
 * screens) is what keeps a popup closing over the inventory, or a menu closing over the terminal, from re-locking
 * while another screen is still open. `shared/Input` owns the cursor but has no bus, so this also mirrors the mode
 * onto `input:cursorModeChanged` for `ui/hud/GameCursor`.
 */
engine.ctx.input.cursor.onModeChange((active, owner) => {
  engine.ctx.bus.emit('input:cursorModeChanged', { active, owner });
  if (active) return;
  queueMicrotask(() => {
    const ctx = engine.ctx;
    if (ctx.input.isCursorMode) return;                     // someone opened another screen in the same tick
    // The title / result screens are cursor screens by nature — never steal the mouse back there.
    if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) return;
    if (ctx.player?.isDead ?? false) return;
    ctx.input.requestPointerLock();
  });
});

/*
 * 2026-09-08: the browser eats the Escape that leaves the pointer lock, so the *unlock* is the only evidence the key
 * was pressed. `Input` reports one it did not cause; `game/GameFlowSystem` listens on the bus and puts the
 * pause menu up, exactly as it does for a focus loss. That path is unchanged by the 2026-09-09 ESC-close rule:
 * a locked pointer means no screen owns the cursor, so there is nothing for Escape to close.
 */
engine.ctx.input.onUserUnlock(() => engine.ctx.bus.emit('input:pointerLockLost', {}));

/*
 * `화면 설정` (2026-09-08). `ui/menus/SettingsMenu` owns the panel and the localStorage file; this is the only
 * place that holds the `Engine`, so it is where the choices are applied. `전체화면` is applied by the panel itself (a
 * fullscreen request needs the click's user activation) and only reported here.
 */
engine.ctx.bus.on('ui:displayChanged', ({ bloom, shadows, scale }) => {
  engine.setPostProcessing(bloom);
  engine.setShadows(shadows);
  engine.setResolutionScale(scale);
});

// Registration order == update order (see CLAUDE.md "System lifecycle").
// NetSystem goes first so incoming snapshots are applied before any system reads ctx.net this frame.
engine.addSystem(new NetSystem());
// Progression publishes ctx.progression.derived, which almost every other system reads.
engine.addSystem(new ProgressionSystem());
// Ship housing state (rooms / facilities / furniture / presets) — before the hub builds the personal ship from it,
// and before inventory reads the stash size.
engine.addSystem(new HousingSystem());
engine.addSystem(new WorldSystem());
engine.addSystem(new HubSystem());        // ship interiors; builds before the player reads ctx.hub
// 2026-09-21: the survey camera's zoom keys (interact / reload while zoomed) are consumed before player/ reads interact.
const survey = new SurveySystem();
engine.addSystem(survey.inputGate);
engine.addSystem(new PlayerSystem());
engine.addSystem(new RemotePlayerSystem());
// Implants run before weapons: the same frame's `blocksWeapons` must be current when weapons reads it.
engine.addSystem(new ImplantSystem());
engine.addSystem(new WeaponSystem());
engine.addSystem(new EnemySystem());
engine.addSystem(new InventorySystem());
// Phase 5: corporations / credits / contracts / quests — after inventory so buy / sell / deliveries can use the bag + stash.
engine.addSystem(new MetaSystem());
engine.addSystem(new GadgetSystem());     // deployables; after inventory so `use` can consume items
// 2026-09-11: ground · air drones — gadgets.use hands `deploy` over, so right after gadgets (control input · drone camera · owner-authoritative sync).
engine.addSystem(new DroneSystem());
engine.addSystem(new PickupSystem());     // world pickups (dropped items), after inventory
engine.addSystem(new StratagemSystem());  // ship calls (Phase 3): after weapons/enemies/inventory, before extraction
engine.addSystem(new ExtractionSystem());
// 2026-09-15: android squadmates — they judge after enemies · inventory · pickups · extraction have produced this frame's state, and the HUD draws the result.
engine.addSystem(new AllySystem());
engine.addSystem(new HudSystem());
// 2026-09-21: the survey camera — after the HUD, so its `lateUpdate` projects the camera player/ just placed.
engine.addSystem(survey);
engine.addSystem(new AudioSystem());
engine.addSystem(new GameFlowSystem());
// Developer console last: it reads every other ref and must see the frame's final state (dev clients only).
// The tutorial is registered **after** the systems it watches — and before the console, because it attaches its
// commands to `ctx.console` in init (the console exists on dev hosts only; without it the registration is silently skipped).
engine.addSystem(new TutorialSystem());
engine.addSystem(new ConsoleSystem());

engine.start();

// Debug handle for the browser console.
(window as any).__game = engine;
