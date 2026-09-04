import { Engine } from '@/core/Engine';
import { WorldSystem } from '@/world/WorldSystem';
import { PlayerSystem } from '@/player/PlayerSystem';
import { WeaponSystem } from '@/weapons/WeaponSystem';
import { EnemySystem } from '@/enemies/EnemySystem';
import { InventorySystem } from '@/inventory/InventorySystem';
import { ExtractionSystem } from '@/extraction/ExtractionSystem';
import { HudSystem } from '@/ui/HudSystem';
import { AudioSystem } from '@/audio/AudioSystem';
import { GameFlowSystem } from '@/game/GameFlowSystem';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

const engine = new Engine(canvas, uiRoot);

// Registration order == update order (see CLAUDE.md "System lifecycle").
engine.addSystem(new WorldSystem());
engine.addSystem(new PlayerSystem());
engine.addSystem(new WeaponSystem());
engine.addSystem(new EnemySystem());
engine.addSystem(new InventorySystem());
engine.addSystem(new ExtractionSystem());
engine.addSystem(new HudSystem());
engine.addSystem(new AudioSystem());
engine.addSystem(new GameFlowSystem());

engine.start();

// Debug handle for the browser console.
(window as any).__game = engine;
