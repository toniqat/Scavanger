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
import { ensureMigrated, loadKeybinds } from '@/shared';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

/*
 * 캐릭터 세이브 슬롯 (2026-09-09) — **모든 것보다 먼저**. 슬롯이 없던 시절의 `scav.*` 세이브를 슬롯 1 로
 * 옮기고 활성 슬롯을 확정한다. 시스템은 저장소를 생성자에서 한 번 읽으므로, 이 줄 뒤에 오는 `slotKey`
 * 호출은 전부 같은 슬롯을 가리켜야 한다 (`shared/saveSlot`).
 */
ensureMigrated();

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

/*
 * 2026-09-08: the browser eats the Escape that leaves the pointer lock, so the *unlock* is the only evidence the key
 * was pressed. `Input` reports one it did not cause; `game/GameFlowSystem` listens on the bus and puts the
 * 일시정지 메뉴 up, exactly as it does for a focus loss. That path is unchanged by the 2026-09-09 ESC 닫기 rule:
 * a locked pointer means no screen owns the cursor, so there is nothing for Escape to close.
 */
engine.ctx.input.onUserUnlock(() => engine.ctx.bus.emit('input:pointerLockLost', {}));

/*
 * 화면 설정 (2026-09-08). `ui/menus/SettingsMenu` owns the panel and the localStorage file; this is the only place
 * that holds the `Engine`, so it is where the choices are applied. 전체화면 is applied by the panel itself (a
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
// 2026-09-11: 지상 · 공중 드론 — gadgets.use 가 deploy 를 넘기므로 가젯 바로 뒤 (조종 입력 · 드론 카메라 · 소유자 권한 동기화).
engine.addSystem(new DroneSystem());
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
