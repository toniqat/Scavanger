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
import { loadKeybinds } from '@/shared';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

// Player key bindings (localStorage) must be in `Keys` before any system caches a label.
loadKeybinds();

const engine = new Engine(canvas, uiRoot);

/*
 * 2026-09-07 (커서 rework): the **single** place the pointer lock is re-acquired.
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
engine.addSystem(new PickupSystem());     // world pickups (dropped items), after inventory
engine.addSystem(new StratagemSystem());  // ship calls (Phase 3): after weapons/enemies/inventory, before extraction
engine.addSystem(new ExtractionSystem());
engine.addSystem(new HudSystem());
engine.addSystem(new AudioSystem());
engine.addSystem(new GameFlowSystem());
// Developer console last: it reads every other ref and must see the frame's final state (dev clients only).
// 튜토리얼은 자기가 지켜보는 시스템들 **뒤에** 등록한다 — init 에서 `ctx.console` 에 명령을 붙이므로
// 콘솔보다는 앞이다 (콘솔은 dev 호스트에서만 존재하고, 없으면 명령 등록만 조용히 건너뛴다).
engine.addSystem(new TutorialSystem());
engine.addSystem(new ConsoleSystem());

engine.start();

// Debug handle for the browser console.
(window as any).__game = engine;
