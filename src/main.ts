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

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

const engine = new Engine(canvas, uiRoot);

// Registration order == update order (see CLAUDE.md "System lifecycle").
// NetSystem goes first so incoming snapshots are applied before any system reads ctx.net this frame.
engine.addSystem(new NetSystem());
// Progression publishes ctx.progression.derived, which almost every other system reads.
engine.addSystem(new ProgressionSystem());
engine.addSystem(new WorldSystem());
engine.addSystem(new HubSystem());        // ship interiors; builds before the player reads ctx.hub
engine.addSystem(new PlayerSystem());
engine.addSystem(new RemotePlayerSystem());
// Implants run before weapons: the same frame's `blocksWeapons` must be current when weapons reads it.
engine.addSystem(new ImplantSystem());
engine.addSystem(new WeaponSystem());
engine.addSystem(new EnemySystem());
engine.addSystem(new InventorySystem());
engine.addSystem(new GadgetSystem());     // deployables; after inventory so `use` can consume items
engine.addSystem(new PickupSystem());     // world pickups (dropped items), after inventory
engine.addSystem(new StratagemSystem());  // ship calls (Phase 3): after weapons/enemies/inventory, before extraction
engine.addSystem(new ExtractionSystem());
engine.addSystem(new HudSystem());
engine.addSystem(new AudioSystem());
engine.addSystem(new GameFlowSystem());

engine.start();

// Debug handle for the browser console.
(window as any).__game = engine;
