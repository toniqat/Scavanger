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
import { MetaSystem } from '@/meta/MetaSystem';
import { loadKeybinds } from '@/shared';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

// Player key bindings (localStorage) must be in `Keys` before any system caches a label.
loadKeybinds();

const engine = new Engine(canvas, uiRoot);

// Phase 10: bridge the software cursor's mode changes onto the bus. `shared/Input` owns the cursor but has no bus, and
// `ui/hud/SoftCursor` (the sprite) listens for `input:cursorModeChanged` — this is the only place that can join them.
engine.ctx.input.cursor.onModeChange((active, owner) => {
  engine.ctx.bus.emit('input:cursorModeChanged', { active, owner });
  // Chrome drops the pointer lock on *every* Escape, and a cursor-mode screen never releases it itself — so a screen
  // closed with Escape would leave the player unlocked. Re-request it once the last cursor owner is gone and no blocker
  // is left; `requestPointerLock()` returns early when the lock survived, so this is idempotent. One place for every
  // folder: the per-screen relock microtasks the Phase 10 lanes removed all funnel through here.
  if (active) return;
  queueMicrotask(() => {
    // Only the 일시정지 메뉴 wants the real OS cursor; every other blocker keeps the lock (Phase 10).
    if (!engine.ctx.input.isCursorMode && !engine.ctx.uiBlockers.has('menu')) engine.ctx.input.requestPointerLock();
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
engine.addSystem(new ConsoleSystem());

engine.start();

// Debug handle for the browser console.
(window as any).__game = engine;
