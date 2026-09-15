import './tutorial.css';
import type * as THREE from 'three';
import type {
  GameContext, GameSystem, ItemInstance, Stance, TutorialGate, TutorialRef, TutorialSave, TutorialStepId,
  TutorialTrack, TutorialTrackSave,
} from '@/shared';
import {
  COCKPIT_DECOR_FURNITURE, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, SHIP_ROOM_COUNT,
  TUTORIAL_INTRO_WAKE_S, TUTORIAL_STEPS, TUTORIAL_TRACKS, TUTORIAL_TRACK_STEPS, slotKey,
} from '@/shared';
import {
  CHECKPOINT_STEP, CROUCH_AIM_TIP_KO, CROUCH_TIP_STEPS, GUIDE_ARRIVE, MARKER_RETARGET_FRAMES, RAID_KILLS_PER_STEP,
  SKIP_FADE_IN_S, SKIP_FADE_OUT_S, SKIP_HOLD_TIME, STANCE_HINT_IDS, TRACK_LABEL_KO,
  TUTORIAL_AMMO_DEF, TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_CONTROL_HINTS, TUTORIAL_CRAFT_GRANT,
  TUTORIAL_GUN_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_RAVEN_NPC, TUTORIAL_ROOM_PURPOSE, TUTORIAL_SAVE_VERSION, TUTORIAL_STORAGE_KEY,
  SPOT_CRAFT_CLOSE, SPOT_NONE, WAKE_REVEAL_DELAY_S, WAKE_REVEAL_MOVE_M,
  controlHintsFor, objectiveChain, objectivesOf, visibleObjectives,
  type ControlHint, type HudRevealState, type StepDef, type TutorialObjective,
} from './model';
import { nextStep, normalizeStep, stepCountOf, stepDef, stepIndexOf, trackOf } from './Steps';
import * as Gates from './parts/Gates';
import { Guide } from './parts/Guide';
import { ObjectiveMarker } from './parts/Marker';
import { Spotlight } from './parts/Spotlight';
import { TutorialControls } from './ui/Controls';
import { TutorialPanel } from './ui/Panel';
import { TutorialPopup } from './ui/Popup';
import { TutorialTip } from './ui/Tip';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/TutorialSystem.ts — 새 프로필 안내 (2026-09-08). Publishes `ctx.tutorial`.
 *
 * **관찰이 기본, 강제는 계약으로.** 진행은 전부 버스 이벤트를 보고 판단한다 (방 용도 변경 · 가구 배치 ·
 * 제작 완료 · 장착 · 터미널 · 행성 · 탑승 · 미션 시작). 남의 폴더 안을 들여다보지 않는다.
 * 강제(순서 밖 행동 차단)는 각 폴더가 자기 거절 사유 함수에서 `ctx.tutorial.blockReason()` 을 한 번 부르는
 * 것으로 이뤄진다 — 튜토리얼이 꺼져 있으면 그 호출은 언제나 null 이라 평소 동작이 바뀌지 않는다.
 *
 * **시작 조건**: 저장이 없고(= 새 프로필) 개인 함선에 처음 들어올 때. 진행 단계는 localStorage 에 남아
 * 새로고침을 견디고, 끝나면(완주 또는 건너뛰기) 다시 시작하지 않는다. dev 콘솔의 `tutorial` 로 다시 켤 수 있다.
 *
 * **재료**: 기본 지급품은 발전기 · 작업실 · 작업대까지 쓰고 나면 아무것도 만들 수 없어서, `craftGun` 단계에
 * 들어설 때 `TUTORIAL_CRAFT_GRANT` 를 한 번 넣어 준다 (바닥, 튜토리얼당 한 번, 저장에 기록). 그 위에
 * **top-up** (2026-09-09): 제작 단계(`craftGun` · `craftAmmo`)에 들어설 때마다 `ensureMaterials(recipeId)`
 * 가 그 레시피의 재료를 하나씩 보고 `필요 − 보유` 만큼만 더 준다 — 소총이 폐금속 6 을 먹어 준중량탄의 폐금속 5 가
 * 모자라던 문제가 그래서 없다. 필요량은 레시피에서 읽으므로 코드에 숫자가 없고, 멱등이라 새로고침으로 다시 들어와도
 * 모자란 만큼만 다시 채운다 (`topped` 는 어느 단계가 채웠는지의 기록).
 *
 * **표시 타이밍** (2026-09-09): 단계가 넘어가면 목표 패널의 글은 바로 바뀌지만 스포트라이트와 바닥 안내선은
 * `TUTORIAL_STEP_DELAY_S` 뒤에 나타난다 — 그 박자는 `parts/Spotlight` · `parts/Guide` 가 각자 센다 (대상이 뒤늦게
 * 나타나는 경우까지 한 곳에서 다루려면 대상을 찾는 쪽이 세는 것이 맞다). 여기서는 아무것도 기다리지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 저장 모양 **v2** (2026-09-14, 3트랙). 계약(`TutorialSave`)에서 `tracks` 는 선택 필드지만 이 폴더 안에서는
 * 언제나 채워져 있으므로 여기서 필수로 좁힌다. v1(`step` · `done` 최상위)은 `load()` 가 옮겨 붙인다.
 */
interface SaveV2 extends TutorialSave {
  version: number;
  tracks: Partial<Record<TutorialTrack, TutorialTrackSave>>;
  /** `TUTORIAL_CRAFT_GRANT`(바닥)를 넣었다 — 한 번만. */
  granted?: boolean;
  benchUid?: string;
  /** `ensureMaterials` 가 돌았던 단계들 (2026-09-09). 기록일 뿐 — top-up 은 멱등이라 다시 들어오면 모자란 만큼만 또 준다. */
  topped?: TutorialStepId[];
  /**
   * 레이드 트랙을 **완주**했다 — 다음 개인 함선 진입에서 함선 트랙이 이어진다 (2026-09-14).
   * 건너뛴 사람에게는 켜지지 않는다: 「조작은 아는데 증축은 처음」인 사람이 함선 트랙까지 떠안지 않게.
   */
  pendingShip?: boolean;
  /** 우측 조작 가이드에 쌓인 줄 (`ControlHint.id`) — 새로고침을 견딘다. */
  learned?: string[];
  /**
   * **지금 단계에서** 달성한 목표 id (2026-09-14 2차). 선택 목표를 해 놓고 새로고침했을 때 체크가
   * 사라지지 않게 하는 것이 전부다 — 단계가 넘어가면 비워진다.
   */
  objectives?: string[];
}

const freshSave = (): SaveV2 => ({ version: TUTORIAL_SAVE_VERSION, tracks: {} });

/*
 * 2026-09-14 2차 (사용자 결정) — **튜토리얼은 풀피로 시작하고 풀피로 부활한다.** 2026-09-14 1차의
 * 「딸피로 깨어난다」(`TUTORIAL_START_HP` 4 를 스폰 · 부활 · 기상마다 다시 걸던 `applyLowHp`)는 걷어냈다.
 * 긴장을 만드는 일은 이제 **낙하 피해**가 한다 — `drop` 단계에서 실제로 깎인 체력을 `heal` 단계의 붕대로
 * 되돌리는 것이 「낙뎀 인지 → 회복」의 한 줄이고, 이미 가득이면 `heal` 은 조용히 지나간다.
 */

export class TutorialSystem implements GameSystem, TutorialRef {
  readonly name = 'tutorial';
  private ctx!: GameContext;
  private save: SaveV2 = freshSave();
  private unsubs: Array<() => void> = [];

  private panel!: TutorialPanel;
  private popup!: TutorialPopup;
  private spotlight!: Spotlight;
  private guide!: Guide;
  /** 3D 목표 마커 — `corpseLoot` 의 목표 시체 위에 선다 (2026-09-14 3차). */
  private marker!: ObjectiveMarker;
  /** 우측 조작 가이드 — 지금 구간에서 쓰는 조작 (레이드 트랙). */
  private controls!: TutorialControls;
  /** 조작 가이드 바로 아래의 TIP 토스트 (2026-09-15). */
  private tip!: TutorialTip;
  /** 앉아 조준 TIP 을 이번 레이드 트랙에서 이미 띄웠다 (한 번만). */
  private crouchTipShown = false;
  /**
   * `corpseLoot` 에서 **총을 들지 않고 창을 닫았다** (2026-09-15, 사용자 결정) — 포커싱을 푼다. 시체를 다시 열면 되살아나고,
   * 그대로 걸어가면 `bugs` 체크포인트 · 벌레 스폰이 다음 단계로 접는다 (필수 목표가 막지 않는다).
   */
  private corpseFocusOff = false;
  /** 레이드 트랙 건너뛰기 암전의 남은 시간 (s). 0 = 암전 중이 아니다 (2026-09-15). */
  private skipFadeT = 0;
  /** 검은 판을 이 시스템이 걸었다 — 치울 책임도 여기 있다. */
  private skipFadeOwned = false;
  /** `hides('hud', …)` 가 보는 관찰 상태 (표로는 못 정하는 것). */
  private readonly hudState: HudRevealState = { staminaUsed: false };
  /** `shoot` 단계에서 처치한 적 수 (레이드 트랙 안에서만 센다). */
  private kills = 0;
  /** 지금 단계에서 달성한 목표 id (`save.objectives` 의 살아 있는 사본). */
  private done = new Set<string>();
  /*
   * ── 오프닝 기상 (2026-09-14 4차) ─────────────────────────────────────────
   * `PlayerRef.playIntroWake` 를 **`update()` 의 다음 프레임에** 부른다. ⚠ `game:newMission` 을 처리하는 중에
   * 부르면 안 된다 — 그 emit 의 뒤쪽 핸들러인 `PlayerSystem` 이 `cancelIntroWake` 로 조용히 지운다
   * (`world:ready` 안도 같은 이유로 안 된다: 그 안에서 동기 발행된다). `TutorialWorld.placeShip` 이 이미
   * 같은 이유로 한 프레임 미루고 있고, 여기서는 한 칸짜리 예약이 그 역할을 한다.
   */
  /** 다음 프레임에 기상 연출을 시작한다 (`step === 'wake'` 일 때만 — 이어하기로 돌아온 사람에게 걸면 안 된다). */
  private pendingWake = false;
  /** 연출이 끝난 뒤 안내를 띄우기까지 남은 시간 (s). 0 = 유예 없음. */
  private wakeHoldT = 0;
  /** 그 유예를 앞당길 이동 거리를 재는 기준점 (연출이 끝난 자리). */
  private wakeFromX = 0;
  private wakeFromZ = 0;
  /** 인벤토리 화면이 열려 있다 — 그 동안 우측 조작 가이드를 접는다 (2026-09-14 2차). */
  private invOpen = false;
  /**
   * 지금 자세 (2026-09-14 3차) — `crouch` 단계의 조작 가이드 라벨이 이것을 따라간다
   * (서 있으면 `앉기`/`포복`, 앉아 있으면 C = `일어서기`, 엎드려 있으면 Z = `일어서기`).
   */
  private stance: Stance = 'stand';
  /** 지금 조작 가이드에 올라가 있는 줄의 id (표가 없는 단계는 이 목록을 그대로 유지한다). */
  private controlIds: string[] = [];
  /** 목표 마커가 대상을 다시 찾기까지 남은 프레임 (매 프레임 `interactables` 를 훑지 않는다). */
  private retarget = 0;

  /** Interactable id of the bench the player placed (guide target for the craft steps). */
  private benchInteractable: string | null = null;
  /** true while the 건너뛰기 확인 카드 is up (the intro card uses the same popup). */
  private confirmingSkip = false;
  /** 총기 작업대가 배치 대기 상태로 커서에 들려 있다 (`benchPlace` 단계에서 스포트라이트를 접는 조건). */
  private benchArmed = false;
  /** 제작 열이 열려 있다 (`ui:craftToggled`) — `openBag` 단계가 "닫혔다"를 판단하는 유일한 상태. */
  private craftOpen = false;

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.tutorial = this;
    this.save = this.load();
    if (this.save.benchUid) this.benchInteractable = `hub_furn_${this.save.benchUid}`;

    this.done = new Set(this.save.objectives ?? []);

    // 2026-09-14 2차: 건너뛰기 버튼이 패널에서 빠졌다 — ESC 메뉴가 `skipTrack(track)` 을 부른다.
    this.panel = new TutorialPanel(ctx.uiRoot);
    this.popup = new TutorialPopup(ctx, () => { /* nothing to restore — the ship keeps running behind it */ });
    this.spotlight = new Spotlight(ctx.uiRoot);
    this.guide = new Guide(ctx);
    this.marker = new ObjectiveMarker(ctx);
    this.controls = new TutorialControls(ctx.uiRoot);
    this.tip = new TutorialTip(ctx.uiRoot);
    this.restoreControls();

    const b = ctx.bus;
    this.unsubs.push(
      // 2026-09-15: 건너뛰기 암전은 함선에 들어서면 반드시 걷힌다 (결과 화면에서 이미 `ui/HudSystem` 이 걷었어도 한 번 더)
      b.on('hub:entered', () => this.clearSkipFade(0)),
      b.on('game:abort', () => { this.skipFadeT = 0; this.skipFadeOwned = false; this.tip.clear(); }),
      // 결과 화면으로 페이즈가 바뀌면 `ui/HudSystem.applyVisibility` 가 검은 판을 스스로 걷는다 — 여기서 0 을 또 쏘면
      //   페이즈가 바뀌기 전 프레임에 월드가 한 번 비친다. 책임만 내려놓는다.
      b.on('game:complete', () => { this.skipFadeT = 0; this.skipFadeOwned = false; }),
      b.on('hub:entered', ({ ship }) => this.onHubEntered(ship)),
      b.on('hub:left', () => this.refreshVisuals()),
      b.on('game:phaseChanged', () => this.refreshVisuals()),

      b.on('housing:shipManageChanged', ({ active }) => this.onManage(active)),
      b.on('housing:modeChanged', ({ active }) => { if (active) this.advanceIf('manage'); }),
      b.on('housing:facilityUpgraded', ({ id, level }) => { if (id === 'generator' && level >= 1) this.advanceIf('generator'); }),
      b.on('housing:roomPurposeChanged', ({ room, purpose }) => this.onPurpose(room, purpose)),
      // 가구 제작에는 전용 이벤트가 없다 — `housing:changed {reason:'craft'}` 뒤에 창고를 한 번 들여다본다
      b.on('housing:changed', ({ reason }) => { if (reason === 'craft') this.onFurnitureCrafted(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.onSelection(defId)),
      b.on('housing:furniturePlaced', ({ item }) => this.onFurniture(item.defId, item.uid)),

      b.on('craft:completed', ({ recipeId }) => this.onCrafted(recipeId)),
      // 2026-09-08: 제작 창을 닫아야 장착 장비 칸이 돌아온다 — 그 한 번의 닫기가 `openBag` 단계다.
      //   창을 통째로 닫아 버린 사람을 위해 `inventory:opened`(= Tab 으로 가방을 다시 연 것)도 같은 신호로 본다.
      // 2026-09-09: `ui:craftToggled` 는 **작업대 경로**(openBenchCraft / closeBench)만 내고, 가방의 `제작` 버튼(plain 제작 열)은
      //   내지 않는다 — 그 경로는 제작 열이 키 가이드에 자기 줄을 올리는 `ui:keyGuide {owner:'inventory.craft'}`
      //   (keys ≠ null = 열림, null = 닫힘) 로 본다. 둘 다 같은 함수로 모아 `craftOpen` 하나를 유지한다.
      //   (열림을 신호로 쓰던 `openCraft` 단계는 같은 날 순서에서 빠졌다 — 소총 · 탄약을 작업대에서 한 번에 만든다.)
      b.on('ui:craftToggled', ({ open }) => this.onCraftPanel(open)),
      b.on('ui:keyGuide', ({ owner, keys }) => { if (owner === 'inventory.craft') this.onCraftPanel(keys !== null); }),
      b.on('inventory:opened', () => this.onInventoryOpened()),
      // 2026-09-14 3차 (사용자 결정): `corpseLoot` 는 **가방을 닫아야** 벌레 구간으로 넘어간다
      //   2026-09-15: `supplyLoot` 도 — 붕대를 얻은 뒤 창을 닫으면 `heal`
      b.on('inventory:closed', () => this.onInventoryClosed()),
      // 2026-09-15: 총을 안 들고 닫아 풀린 `corpseLoot` 포커싱은 시체를 다시 열면 되살아난다
      b.on('inventory:containerOpened', ({ containerId }) => this.onContainerOpened(containerId)),
      b.on('loadout:changed', () => this.onLoadout()),
      b.on('inventory:changed', () => this.onInventory()),
      b.on('inventory:bagChanged', () => this.onInventory()),
      // 2026-09-14 2차: 인벤토리 화면이 열려 있는 동안에는 우측 조작 가이드를 접는다 (화면 우측을 가린다)
      b.on('inventory:opened', () => this.setInventoryOpen(true)),
      b.on('inventory:closed', () => this.setInventoryOpen(false)),

      b.on('hub:terminalToggled', ({ open }) => { if (open) this.advanceIf('terminal'); }),
      /*
       * 2026-09-09 — `planet` 단계는 **워프가 시작될 때** 넘어간다.
       *
       * 원래는 `hub:planetChanged` 로 넘겼는데, 그 이벤트는 `hub/parts/Planet.finishTravel` 이 **도착해서**
       * `hub:travel {end}` 를 낸 **바로 다음에** 낸다. 그래서 순서가 이렇게 엇갈렸다:
       *   워프 시작 → (안내는 아직 `planet`) → 도착 → `travel {end}` (아직 `planet` 이라 무시) →
       *   `planetChanged` → 이제서야 `travel` 로 넘어감 → **기다리던 `travel {end}` 는 이미 지나갔다.**
       * 행성 이동을 다 마쳤는데 `planet` 단계(지금 14/17)에서 멈춰 있던 것이 이것이다. 시작에서 넘기면 두 단계가 워프의
       * 앞뒤를 하나씩 맡는다. `planetChanged` 는 그대로 두되 (도착만 보고 들어오는 경로의 보험) 이미
       * 넘어간 뒤면 `advanceIf` 가 알아서 아무것도 하지 않는다.
       */
      b.on('hub:planetChanged', () => this.advanceIf('planet')),
      b.on('hub:travel', ({ stage }) => { this.advanceIf(stage === 'start' ? 'planet' : 'travel'); }),
      b.on('hub:slotChanged', ({ local, peerId }) => { if (local && peerId) this.advanceIf('board'); }),
      b.on('game:newMission', ({ mode }) => { if (mode === 'tutorial') this.startRaidTrack(); else this.advanceIf('board'); }),
      b.on('world:ready', () => this.onRaid()),
      // 2026-09-14: 딸피로 깨어나고, 체크포인트로 돌아와도 다시 딸피다 (`player:respawn` 은 가득 채워 준다)
      /* ── ① raid 트랙 (2026-09-14) — 전부 **이미 있는 이벤트의 관찰**이다 ──────────────────────────────
       * 뼈대는 `tutorial:checkpoint` 다 (owner: world/tutorial): 구간을 지나면 그 구간의 단계가 끝난다.
       * 행동으로 끝나는 단계(장비 장착 · 처치 · 앉기 · 낙하 · 회복 · 수류탄 · 이륙)는 자기 이벤트를 본다 —
       * 체크포인트보다 **먼저** 오는 것이 정상이고, 뒤늦게 체크포인트가 와도 `advanceIf` 가 조용히 무시한다. */
      b.on('tutorial:checkpoint', ({ id }) => this.onCheckpoint(id)),
      b.on('player:introWakeDone', () => this.advanceIf('wake')),
      b.on('player:stanceChanged', ({ stance }) => this.onStance(stance)),
      // 2026-09-15: 포복 · 앉아 조준 구간에서 처음으로 앉거나 엎드린 채 정조준하면 TIP 한 번
      b.on('player:aimChanged', ({ aiming }) => { if (aiming) this.maybeCrouchTip(true); }),
      // 스태미나 HUD 는 **처음 소모될 때** 나타난다 (`hides('hud','stamina')`)
      b.on('player:sprintChanged', ({ sprinting }) => { if (sprinting) this.markStaminaUsed(); }),
      b.on('player:staminaDepleted', () => this.markStaminaUsed()),
      b.on('player:fell', ({ damage }) => { if (damage > 0) this.advanceIf('drop'); }),
      /*
       * 2026-09-14 4차 (사용자 결정) — **벌레가 솟는 그 순간**이 `shoot` 의 시작이다. 튜토리얼 벌레는
       * `world:ready` 에 서 있지 않고 플레이어가 자기 감지 반경에 들어서면 굴착 스폰으로 올라오는데
       * (`enemies/Tutorial.updateTutorialAmbush` → `parts/Pool.spawn` → 이 이벤트), 그 자리는 `bugs`
       * 체크포인트보다 14 m 앞이다. 그래서 체크포인트는 `advance1` 만 열고 안내는 여기서 넘어간다.
       * ⚠ 이 이벤트를 못 받아 `advance1` 에 머물러도 **막다른 길이 아니다** — 다음 체크포인트(`crawl`)가
       *   `crouch` 로 접는다 (`shoot` 을 건너뛸 뿐 안내가 멈추지 않는다).
       * 2026-09-15: 총을 안 들고 시체를 지나친 사람(`corpseLoot` 에 머문 채)도 벌레가 솟으면 곧장 `shoot` 이다.
       */
      b.on('enemy:spawned', () => this.onEnemySpawned()),
      b.on('enemy:killed', () => this.onKill()),
      b.on('player:stimUsed', () => { this.markIf('heal', 'healUse'); this.advanceIf('heal'); }),
      /* ── heal 은 두 줄이다 (2026-09-14 4차) — 휠에서 골라 **손에 들고** · 길게 눌러 **쓴다**.
       *    「빠른 사용 칸에 올린다」는 자동 등록이 대신하므로 목표에서 빠졌고, 그것을 보던 구독도 함께 갔다.
       *    2026-09-15: 두 줄은 순차 공개다 (`healUse` 는 `reveal`) — 탭으로 곧장 꺼내 쓴 사람은 `objectiveChain` 이 앞줄도 적는다. */
      b.on('quick:equipped', ({ item }) => { if (this.isStim(item)) this.markIf('heal', 'healHold'); }),
      // 수류탄 단계의 **선택** 목표는 「꺼내 던진다」다 — 터지기만 하면 달성이고 처치 여부를 보지 않는다
      b.on('grenade:exploded', () => this.markIf('grenade', 'grenadeThrow')),
      // 탈출은 스위치를 누른 그 순간에 끝난다 — 이륙 연출을 기다리면 결과 화면이 안내를 덮는다
      b.on('extraction:departureStarted', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),
      b.on('extraction:liftoff', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),

      /* ── ② ship 트랙 (2026-09-14) ── */
      b.on('inventory:opened', () => this.advanceIf('levelUp')),
      b.on('progress:statChanged', () => this.advanceIf('stats')),
      b.on('ui:messengerToggled', ({ open }) => { if (open) this.advanceIf('messenger'); }),
      /* 2026-09-15 (E-12): 「레이븐의 연락에 대답한다」는 **대답한 순간** 체크된다 — 전에는 이 줄을 적는 곳이 없어
       * 수락할 때(`completeRequired`) 두 줄이 한꺼번에 그어졌다. 대답은 `ravenQuest` 단계에서만 할 수 있다
       * (그 전 단계들은 메신저 버튼을 감춘다). */
      b.on('npc:message', ({ npc, entry }) => { if (npc === TUTORIAL_RAVEN_NPC && entry.e === 'choice') this.markIf('ravenQuest', 'ravenTalk'); }),
      b.on('npc:questChanged', ({ state }) => { if (state === 'active') this.advanceIf('ravenQuest'); }),

      // 리바인드하면 조작 가이드 · 목표 줄의 키캡을 다시 읽는다 (키는 사용 시점에 읽는다 — `docs/CONTROLS.md`)
      b.on('input:bindingsChanged', () => { this.controls.relabel(); this.panel.relabel(); }),
    );
    this.registerConsole();
    this.refreshVisuals();
  }

  update(dt: number): void {
    // 건너뛰기 암전은 트랙이 끝난 **뒤에** 흐른다 (`skipTrack` 이 먼저 `finish`) — 활성 검사보다 앞이어야 한다
    this.updateSkipFade(dt);
    if (!this.active) return;
    this.tip.update(dt, this.controls.visible ? this.controls.root : null);
    this.consumePendingWake();
    this.updateWakeHold(dt);
    this.poll();
    // 스태미나 HUD 는 **처음 줄어들 때** 나타난다. 달리기 말고 점프 · 사다리도 깎으므로 이벤트만 보지 않고
    //   레이드 트랙 동안 한 번 폴링한다 (`staminaUsed` 가 서면 다시는 안 본다).
    if (!this.hudState.staminaUsed && this.track === 'raid') {
      const p = this.ctx.player;
      const max = p?.maxStamina ?? 0;
      if (max > 0 && (p?.stamina ?? max) < max - 0.5) this.markStaminaUsed();
    }
    this.guide.update(dt);
    this.marker.update(dt);
    this.spotlight.update(dt);
    // 포커싱이 켜져 있는 동안 목표 패널은 어두운 판 위로 — 딤 제외 + 건너뛰기 버튼은 언제나 눌린다
    this.panel.setLifted(this.spotlight.visible);
  }

  /**
   * 이벤트가 없는 것들을 프레임마다 한 번씩 본다 (2026-09-14 3차). 전부 **아직 안 된 것만** 묻고, 되면 다시
   * 안 본다 — 새 이벤트를 만들지 않으려고 여기 모아 뒀다.
   *   ① 「…으로 이동」 목표 — 안내선이 가리키는 물건의 상호작용 범위 안에 들어섰나 (`StepDef.arriveObjective`).
   *   ② `levelUp` — **인벤토리가 이미 열린 채** 캐릭터 탭을 누르면 `inventory:opened` 가 안 온다 (버그).
   *      그래서 화면 탭 자체를 본다: 인벤토리 말고 다른 탭이 떠 있으면 화면은 열려 있는 것이다.
   */
  private poll(): void {
    const step = this.step;
    if (!step) return;
    // 목표 마커 — 시체는 `world/tutorial` 이 만드는 것이라 안내가 먼저 설 수도 있다. 안내선과 같은 주기로 다시 찾는다.
    if (step === 'corpseLoot') {
      this.retarget -= 1;
      if (this.retarget <= 0) { this.retarget = MARKER_RETARGET_FRAMES; this.marker.setTarget(this.nearestCorpse()); }
    }
    if (step === 'levelUp' && (this.ctx.inventory?.screenTab ?? 'inventory') !== 'inventory') {
      this.advance();
      return;
    }
    const def = stepDef(step);
    const arrive = def.arriveObjective;
    if (arrive && !this.done.has(arrive) && this.arrivedAtGuide(def)) this.markObjective(arrive);
  }

  /* ── 오프닝 기상 (2026-09-14 4차) ─────────────────────────────────────────
   * 도입 커밋부터 `PlayerRef.playIntroWake` 를 **`src/` 어디서도 부르지 않아** 2초 페이드도, 쓰러진 채
   * 일어나는 애니메이션도 한 번도 나오지 않았다. `player:introWakeDone` 이 영영 안 와도 `cliff` 체크포인트가
   * `sprintJump` 까지 접어 주므로 진행이 막히지 않아 눈에 띄지 않았을 뿐이다.
   * ────────────────────────────────────────────────────────────────────── */

  /** 예약해 둔 기상 연출을 **다음 프레임에** 시작한다 (위 `pendingWake` 의 ⚠ 참고). */
  private consumePendingWake(): void {
    if (!this.pendingWake) return;
    this.pendingWake = false;
    // 이어하기(`gotoCheckpoint`)로 중간 체크포인트에서 돌아온 사람에게 연출이 걸리면 안 된다
    if (this.step !== 'wake') return;
    this.ctx.player?.playIntroWake?.(TUTORIAL_INTRO_WAKE_S);
  }

  /**
   * 연출이 끝난 뒤의 한 박자. `WAKE_REVEAL_DELAY_S` 가 다 가거나 **스스로 `WAKE_REVEAL_MOVE_M` 만큼 움직이면**
   * (둘 중 먼저) 목표 패널과 조작 가이드가 함께 나타난다.
   */
  private updateWakeHold(dt: number): void {
    if (this.wakeHoldT <= 0) return;
    this.wakeHoldT -= dt;
    const p = this.ctx.player;
    const moved = p ? Math.hypot(p.position.x - this.wakeFromX, p.position.z - this.wakeFromZ) : 0;
    if (this.wakeHoldT > 0 && moved < WAKE_REVEAL_MOVE_M) return;
    this.wakeHoldT = 0;
    this.refreshVisuals();
  }

  /** `wake` 를 막 빠져나왔다 — 안내를 띄우기 전의 한 박자를 센다. */
  private beginWakeReveal(): void {
    const p = this.ctx.player;
    this.wakeFromX = p?.position.x ?? 0;
    this.wakeFromZ = p?.position.z ?? 0;
    this.wakeHoldT = WAKE_REVEAL_DELAY_S;
  }

  /**
   * 지금은 **아무것도 그리지 않는다** — 기상 연출 중이거나(화면이 검다) 그 직후의 한 박자다.
   * 목표 패널 · 조작 가이드 · 스포트라이트 · 안내선이 전부 이 한 줄을 본다.
   */
  private get quiet(): boolean { return this.step === 'wake' || this.wakeHoldT > 0; }

  /** 안내선이 가리키는 물건의 **상호작용 범위** 안에 들어섰는가 (좌표는 `ctx.interactables` 가 준다). */
  private arrivedAtGuide(def: StepDef): boolean {
    const id = this.guideTarget(def.guide);
    const p = this.ctx.player;
    if (!id || !p) return false;
    const it = this.ctx.interactables.all().find((i) => i.id === id);
    if (!it) return false;
    return it.position.distanceTo(p.position) <= Math.max(GUIDE_ARRIVE, it.radius);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.panel?.dispose();
    this.popup?.dispose();
    this.spotlight?.dispose();
    this.guide?.dispose();
    this.marker?.dispose();
    this.controls?.dispose();
    this.tip?.dispose();
    if (this.ctx) this.ctx.tutorial = null;
  }

  /* ── TutorialRef ───────────────────────────────────────────────────────── */

  /** 지금 돌고 있는 트랙 (단계를 들고 있는 트랙은 언제나 **하나뿐**이다). */
  get track(): TutorialTrack | null {
    for (const t of TUTORIAL_TRACKS) if (this.save.tracks[t]?.step) return t;
    return null;
  }

  get active(): boolean { return this.track !== null; }
  get step(): TutorialStepId | null { const t = this.track; return t ? this.save.tracks[t]!.step : null; }
  get stepIndex(): number { return stepIndexOf(this.step); }
  /** 진행률의 분모는 **지금 트랙의 길이**다. 비활성일 때는 옛 호출부를 위해 build 길이를 답한다. */
  get stepCount(): number { return stepCountOf(this.step) || TUTORIAL_STEPS.length; }

  blockReason(gate: TutorialGate, id?: string): string | null {
    return Gates.blockReason(this.step, gate, id);
  }

  hides(gate: TutorialGate, id?: string): boolean { return Gates.hides(this.step, gate, id, this.hudState); }

  /** 증축 트랙을 처음부터 (콘솔 `tutorial start` · 옛 호출부). 다른 트랙의 상태는 건드리지 않는다. */
  start(): boolean {
    if (this.active) return false;
    const tracks = { ...this.save.tracks, build: { step: null, done: false } as TutorialTrackSave };
    this.save = freshSave();
    this.save.tracks = tracks;
    this.resetControls();
    this.setStep('intro');
    return true;
  }

  skip(): void {
    const t = this.track;
    if (!t) return;
    this.skipTrack(t);
  }

  goto(step: TutorialStepId): boolean {
    const target = normalizeStep(step);   // 순서에서 빠진 `openCraft` 는 `craftAmmo` 로
    if (!target) return false;
    const track = trackOf(target);
    // 다른 트랙이 돌고 있으면 그 자리에서 접는다 — 끝난 것으로 표시하지는 않는다 (다시 시작할 수 있다)
    for (const t of TUTORIAL_TRACKS) { const e = this.save.tracks[t]; if (t !== track && e?.step) e.step = null; }
    const cur = this.save.tracks[track];
    this.save.tracks[track] = { step: cur?.step ?? null, done: false };
    this.setStep(target);
    return true;
  }

  /* ── 3트랙 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ─────────────────
   * 트랙마다 자기 목표 패널 · 자기 건너뛰기를 갖고, **건너뛴 트랙만 풀린다** — 조작은 아는데 함선 증축은
   * 처음인 사람이 있기 때문이다 (사용자 결정). 상태는 `save.tracks` 하나이고 돌고 있는 트랙은 늘 하나다. */

  /**
   * 그 트랙이 끝났는가 (완주 · 건너뛰기 둘 다 true).
   *
   * ⚠ **저장에 그 트랙이 아예 없을 때**가 요점이다 — 새 캐릭터도, 튜토리얼이 없던 시절부터 하던 프로필도
   * 모양이 같다(`scav.tutorial` 이 없다). 그래서 「손대지 않은 함선인가」(`looksFresh`)로 가른다:
   * 이미 하던 사람에게는 전부 `true` 라 진입 흐름(`ui/menus/enterShip`)이 지금까지처럼 함선으로 간다.
   */
  isTrackDone(track: TutorialTrack): boolean {
    const t = this.save.tracks[track];
    if (t) return t.done;
    return !this.looksFresh();
  }

  startTrack(track: TutorialTrack): boolean {
    if (this.active) return false;
    if (this.save.tracks[track]?.done) return false;
    this.save.tracks[track] = { step: null, done: false };
    this.resetControls();
    this.setStep(TUTORIAL_TRACK_STEPS[track][0]);
    return true;
  }

  skipTrack(track: TutorialTrack): void {
    if (this.save.tracks[track]?.done) return;
    if (this.track === track) {
      // 함선 · 증축 트랙과 달리 레이드 트랙은 레이드 안에서만 산다. 이미 함선이면 안내만 끈다.
      const leaveRaid = track === 'raid' && this.inTutorialRaid();
      this.finish(true);
      if (leaveRaid) this.beginSkipFade();
      return;
    }
    this.save.tracks[track] = { step: null, done: true };
    this.persist();
  }

  /** 지금 튜토리얼 레이드 안에 있는가. */
  private inTutorialRaid(): boolean {
    const ctx = this.ctx;
    return !!ctx && ctx.missionMode === 'tutorial' && ctx.isRaidActive();
  }

  /*
   * ── 레이드 트랙 건너뛰기 = 암전 → 결과 화면 (2026-09-15, 사용자 결정) ─────────────────────────────
   * 2026-09-14 2차에는 건너뛰기가 `skipToLiftoff`(몸을 화물칸에 세우고 곧장 이륙)였다. 이제는 **화면을 검게 덮고**
   * (`ui:screenFade {1, SKIP_FADE_OUT_S}` — 그리는 것은 `ui/HudSystem`, 코드 보간이라 reduced motion 에도 페이드다)
   * **완전히 검어진 순간** `ExtractionRef.skipToComplete` 를 부른다: 함선이 떠나는 연출 없이 평소 탈출과 같은 결과 화면 ·
   * 정산 · 함선 획득이 흐른다. 검은 판은 결과 화면으로 페이즈가 바뀌는 순간 `HudSystem.applyVisibility` 가 걷고
   * (`inGame` 이 아니면 즉시 0), 함선에 들어설 때(`hub:entered`) 이 시스템이 한 번 더 확인한다 — 함선이 검게 남는 길이 없다.
   *
   * 암전 동안은 **각본 잠금**(`PlayerRef.setSceneLock`)을 건다 — 0.6 초 사이에 맞아 죽으면 결과 화면이 「미탈출」이 된다.
   * 푸는 것은 player/ 의 리셋 경로(부활 · 함선 복귀 · `game:abort`)이고, 사망 폴백으로 내려갈 때만 여기서 푼다.
   *
   * 폴백 사다리: `skipToComplete` → (없거나 false) `skipToLiftoff` + 다시 밝게(이륙 연출이 보여야 한다) →
   * (그것도 false — 사망 · 전투불능) `game:returnToShip`(그 자리에서의 사망). 건너뛰기는 「여기서 그만두겠다」이므로
   * 안내도 목적지도 없는 행성에 갇히는 것보다 빠져나가는 길이 먼저다 (2026-09-14 2차의 근거 그대로).
   */

  /** 암전을 건다. 이미 함선에 실려 떠나는 중이면 할 일이 없다 (그 연출이 곧 결과 화면이다). */
  private beginSkipFade(): void {
    const ctx = this.ctx;
    if (this.skipFadeT > 0 || ctx.extraction?.riding) return;
    this.skipFadeT = Math.max(0.001, SKIP_FADE_OUT_S);
    this.skipFadeOwned = true;
    this.tip.clear();
    ctx.player?.setSceneLock?.(true);
    ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: SKIP_FADE_OUT_S });
  }

  /** 암전 시계 — 다 검어진 프레임에 한 번 탈출을 건다. 시뮬레이션 dt 라 검은 판(`HudSystem`)과 같은 시계다. */
  private updateSkipFade(dt: number): void {
    if (this.skipFadeT <= 0) return;
    this.skipFadeT = Math.max(0, this.skipFadeT - Math.max(0, dt));
    if (this.skipFadeT > 0) return;
    this.leaveTutorialRaid();
  }

  /** 다 검어졌다 — 폴백 사다리를 따라 레이드를 빠져나간다 (위 절). */
  private leaveTutorialRaid(): void {
    const ctx = this.ctx;
    if (!this.inTutorialRaid()) { this.clearSkipFade(0); return; }
    const ext = ctx.extraction;
    if (ext?.skipToComplete?.()) return;                                  // 결과 화면 — 검은 판은 페이즈가 걷는다
    if (ext?.skipToLiftoff?.()) { this.clearSkipFade(SKIP_FADE_IN_S); return; }   // 이륙 연출은 보여야 한다
    ctx.player?.setSceneLock?.(false);                                    // 잠금이 남으면 사망조차 안 된다
    this.clearSkipFade(0);
    ctx.bus.emit('game:returnToShip', {});
  }

  /** 이 시스템이 건 검은 판을 치운다 (걸지 않았으면 아무 일도 없다 — 오프닝 페이드를 건드리지 않는다). */
  private clearSkipFade(durationS: number): void {
    this.skipFadeT = 0;
    if (!this.skipFadeOwned) return;
    this.skipFadeOwned = false;
    this.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS });
  }

  /* ── step machine ──────────────────────────────────────────────────────── */

  /** 새 프로필이 개인 함선에 처음 들어왔다 → 자동 시작. 이미 진행 중이면 화면만 되살린다. */
  private onHubEntered(ship: string): void {
    if (ship !== 'personal') { this.refreshVisuals(); return; }
    if (this.step === 'bench' && this.benchStored()) { this.advance(); return; }   // 이미 만들어 둔 함선
    if (this.active) { this.refreshVisuals(); return; }
    // 저장이 없다는 것만으로는 "새 캐릭터"가 아니다 — 튜토리얼이 없던 시절부터 하던 프로필도 같은 모양이다.
    // 이미 함선을 꾸며 놓았거나 레벨이 올라 있으면 조용히 **세 트랙 전부** 끝난 것으로 표시하고 다시는 켜지 않는다.
    if (!this.startedAny() && !this.looksFresh()) { this.markAllDone(); this.refreshVisuals(); return; }
    this.autoStart();
    this.refreshVisuals();
  }

  /** 저장에 시작 기록이 하나라도 있는가 (= 이 프로필이 튜토리얼을 겪어 봤다). */
  private startedAny(): boolean { return TUTORIAL_TRACKS.some((t) => this.save.tracks[t] !== undefined); }

  private markDone(track: TutorialTrack): void {
    this.save.tracks[track] = { step: null, done: true };
  }

  private markAllDone(): void {
    for (const t of TUTORIAL_TRACKS) this.markDone(t);
    this.save.pendingShip = false;
    this.persist();
  }

  /**
   * 개인 함선에서의 **트랙 이어 가기** — 레이드 → 함선 → 증축 순. 이미 돌고 있으면 아무 일도 없다.
   *
   * 세 줄이 전부이고 각 줄의 근거가 다르다.
   *   ① 레이드 — **함선 안에 있다는 것 자체가** 그 트랙이 뒤에 있다는 뜻이다 (완주했든 건너뛰었든, 진입 흐름이
   *      아직 레이드로 안 보내는 옛 경로든). 그러니 조용히 끝난 것으로 적는다.
   *   ② 함선 — 레이드를 **완주하고 막 돌아온 그 한 번**만 (`pendingShip`). 안 그러면 레이드를 건너뛴 사람 ·
   *      레벨 1 인 사람에게 「레벨이 올랐습니다」가 뜬다.
   *   ③ 증축 — 2026-09-08 부터의 규칙 그대로 **손대지 않은 함선**일 때만 (`shipUntouched`).
   */
  private autoStart(): void {
    if (this.active) return;
    if (!this.save.tracks.raid?.done) this.markDone('raid');
    if (!this.save.tracks.ship?.done) {
      if (this.save.pendingShip) {
        this.save.pendingShip = false;
        if (this.startTrack('ship')) return;
      }
      this.markDone('ship');
    }
    if (!this.save.tracks.build?.done && !this.save.tracks.build?.step) {
      // 레벨이 아니라 **함선**을 본다 — 레이드를 마치고 돌아온 사람은 레벨 2 지만 함선은 여전히 비어 있다
      if (this.shipUntouched()) { this.startTrack('build'); return; }
      this.markDone('build');
    }
    this.persist();
  }

  /** 튜토리얼 레이드가 시작됐다 (`game:newMission {mode:'tutorial'}` · `world:ready`). */
  private startRaidTrack(): void {
    if (this.track === 'raid') return;
    if (this.save.tracks.raid?.done) return;
    // 다른 트랙이 열려 있으면 접는다 — 레이드로 나가는 순간 함선 안내는 의미가 없다 (끝난 것으로는 안 적는다)
    for (const t of TUTORIAL_TRACKS) { const e = this.save.tracks[t]; if (e?.step) e.step = null; }
    this.hudState.staminaUsed = false;
    this.kills = 0;
    this.wakeHoldT = 0;
    this.crouchTipShown = false;
    this.corpseFocusOff = false;
    this.tip.clear();
    this.startTrack('raid');
    // 연출은 **다음 프레임**에 시작한다 (`consumePendingWake` — 지금 부르면 이 emit 의 뒤쪽 핸들러가 지운다)
    this.pendingWake = true;
  }

  /** 스태미나가 한 번이라도 줄었다 — 그 순간 스태미나 바가 나타난다. */
  private markStaminaUsed(): void {
    if (this.hudState.staminaUsed) return;
    this.hudState.staminaUsed = true;
    if (this.track === 'raid') this.emitChanged();   // HUD 위젯이 게이트를 다시 묻게 한다
  }

  /**
   * 체크포인트를 지났다 (owner: `world/tutorial`). **구간의 끝 = 그 구간 단계의 끝**이라, 지금 단계가 그
   * 체크포인트 이전의 것이면 거기까지 한 번에 접는다 — 선택 단계(`grenade`)를 쓰지 않고 지나가도 막히지 않는다.
   */
  private onCheckpoint(id: string): void {
    const target = CHECKPOINT_STEP[id];
    if (target) this.foldRaid(target);
  }

  /**
   * 레이드 트랙을 그 단계까지 **앞으로만** 접는다 (체크포인트 · 탈출 스위치가 함께 쓴다).
   * 2026-09-14 2차 — `grenade` 가 선택 단계라 자기 신호로 끝나지 않게 됐으므로(필수 목표는 「벽 너머로
   * 나아간다」다) 탈출 스위치도 이 길로 접는다. 체크포인트 하나를 놓쳐도 안내가 막히지 않는다.
   */
  private foldRaid(target: TutorialStepId): void {
    if (this.track !== 'raid') return;
    const order = TUTORIAL_TRACK_STEPS.raid;
    const cur = this.step;
    if (!cur) return;
    const i = order.indexOf(cur), want = order.indexOf(target);
    if (i < 0 || want < 0 || want <= i) return;
    this.setStep(target);
  }

  /**
   * 적을 처치했다 — `shoot` 은 둘, `crouchAim` 은 둘이면 넘어간다 (체크포인트가 보험이다).
   *
   * 2026-09-14 4차 — `grenade` 의 선택 목표가 「처치」에서 「꺼내 던진다」로 바뀌면서 여기서 보던
   * **막타 계열 판정이 없어졌다** (`grenade:exploded` 한 줄이 그 목표를 적는다).
   */
  private onKill(): void {
    const step = this.step;
    if (this.track !== 'raid') return;
    if (step !== 'shoot' && step !== 'crouchAim') return;
    this.kills++;
    if (this.kills >= RAID_KILLS_PER_STEP) this.advance();
  }

  /**
   * 적이 솟았다 (튜토리얼 벌레의 굴착 스폰). `advance1` 이면 그대로 `shoot` 으로 넘기고, **총을 안 들고 시체를 지나친 채**
   * (`corpseLoot` 에 머문 채) 벌레를 만났으면 `shoot` 까지 앞으로 접는다 (2026-09-15, 사용자 결정 — 시체 구간도 건너뛸 수 있다).
   * 두 단계로만 좁힌 이유: 튜토리얼의 다른 적(안드로이드)은 월드가 설 때 이미 서 있으므로 이 두 단계에서 오는
   * `enemy:spawned` 는 매복 벌레뿐이다. 뒤 단계의 스폰은 아무것도 접지 않는다.
   */
  private onEnemySpawned(): void {
    if (this.track !== 'raid') return;
    if (this.step === 'advance1') { this.advance(); return; }
    if (this.step === 'corpseLoot') this.foldRaid('shoot');
  }

  /**
   * 앉아 조준 TIP (2026-09-15, 사용자 결정) — 포복 · 앉아 조준 구간(`CROUCH_TIP_STEPS`)에서 **처음으로** 앉거나 엎드린 채
   * 정조준하면 조작 가이드 아래에 한 번 띄운다. 조준 이벤트와 자세 이벤트가 둘 다 부른다 (어느 쪽이 나중이든 잡는다).
   * @param aiming `player:aimChanged` 가 부를 때는 그 값을 믿는다 (ref 의 `isAiming` 이 같은 프레임에 아직 안 바뀌었을 수 있다).
   */
  private maybeCrouchTip(aiming?: boolean): void {
    if (this.crouchTipShown || this.track !== 'raid') return;
    const step = this.step;
    if (!step || !CROUCH_TIP_STEPS.includes(step)) return;
    const p = this.ctx.player;
    if (!p || p.stance === 'stand' || !(aiming ?? p.isAiming)) return;
    this.crouchTipShown = true;
    this.tip.show(CROUCH_AIM_TIP_KO);
  }

  /**
   * 손대지 않은 함선인가. 방 용도가 하나도 없고 · 놓인 가구가 없고 · 레벨이 1 이면 새 캐릭터로 본다
   * (기본 지급품만 있는 상태). 하나라도 어긋나면 이미 하던 프로필이다.
   *
   * ⚠ **레벨 조건은 「저장이 아예 없는 프로필」을 가르는 데만 쓴다** (2026-09-14). 증축 트랙의 시작 조건은
   * `shipUntouched()` 다 — 튜토리얼 레이드를 마치고 돌아온 사람은 이미 레벨 2 이지만 함선은 여전히 빈 함선이고,
   * 그 사람이야말로 증축 안내를 받아야 할 사람이기 때문이다.
   */
  private looksFresh(): boolean {
    return this.shipUntouched() && (this.ctx.progression?.level ?? 1) <= 1;
  }

  /** 아무것도 놓지 않고 아무 방도 증축하지 않은 함선인가 (= 증축 트랙이 할 일이 남아 있다). */
  private shipUntouched(): boolean {
    const h = this.ctx.housing;
    if (h) {
      try {
        // 2026-09-12: 조종석의 기본 공용 가구(시술대 · 컴퓨터)는 모든 함선에 늘 놓여 있다 — 그것만으로는 「꾸민 함선」이 아니다
        // 2026-09-13: 조종석 꾸밈 가구(침상 · 사물함 · 서랍장 — `COCKPIT_DECOR_FURNITURE`)도 새 함선에 처음부터 놓여 있다
        if (h.getPlaced().some((f) => !COCKPIT_DEFAULT_FURNITURE.some((d) => d.defId === f.defId)
          && !(f.room === COCKPIT_ROOM_INDEX && COCKPIT_DECOR_FURNITURE.some((d) => d.defId === f.defId)))) return false;
        for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (h.getRoom(i).purpose !== 'empty') return false;
      } catch { /* housing not ready — 아직 모른다: 손대지 않은 것으로 본다 (레벨 조건이 옛 프로필을 거른다) */ }
    }
    return true;
  }

  private onManage(active: boolean): void {
    if (active) this.advanceIf('manage');
    else this.advanceIf('manageDone');
  }

  private onPurpose(room: number, purpose: string): void {
    if (purpose !== TUTORIAL_ROOM_PURPOSE) return;
    this.save.room = room;
    // 발전기 단계에서 곧바로 작업실이 세워졌다면(발전기가 이미 돌고 있던 함선) 그 단계는 지나간 것이다
    if (this.step === 'generator') this.setStep('workshop');
    this.advanceIf('workshop');
  }

  /** 발전기가 이미 Lv.1 이상인가 — `generator` 단계에 할 일이 남아 있는지의 판단. */
  private generatorReady(): boolean {
    try { return (this.ctx.housing?.getFacility('generator').level ?? 0) >= 1; } catch { return false; }
  }

  /** 가구 창고에 총기 작업대가 들어왔는가 — `bench`(제작) 는 여기서 끝나고 배치 단계로 넘어간다. */
  private onFurnitureCrafted(): void {
    if (this.step !== 'bench' || !this.benchStored()) return;
    this.advance();
  }

  private benchStored(): boolean {
    try {
      for (const s of this.ctx.housing?.getStored() ?? []) if (s.defId === TUTORIAL_BENCH_DEF && s.qty > 0) return true;
    } catch { /* housing not ready */ }
    return false;
  }

  /**
   * 배치할 가구를 집었다(= 커서에 들려 있다). 그 동안에는 **스포트라이트를 접는다** — 어두운 판이 화면 전체를
   * 덮고 있으면 정작 내려놓을 바닥을 클릭할 수 없다 (2026-09-08 진행 불가 버그).
   */
  private onSelection(defId: string | null): void {
    const armed = defId === TUTORIAL_BENCH_DEF;
    if (armed === this.benchArmed) return;
    this.benchArmed = armed;
    if (this.step !== 'benchPlace') return;
    if (armed) this.markObjective('benchPick');   // 「집는다 → 내려놓는다」 두 줄 중 앞줄
    this.refreshVisuals();
  }

  /**
   * 자세가 바뀌었다. 앉기 · 포복 줄은 **지금 자세에 따라 라벨이 바뀐다** (2026-09-14 3차, 사용자 결정) —
   * 앉아 있는 사람에게 「앉기」라고 적지 않는다. 단계를 넘기는 조건은 예전 그대로다.
   *
   * 2026-09-15 — 「라벨이 안 바뀐다」 수정. 옛 코드는 `step === 'crouch'` 에서만 다시 그렸는데 `crouch` 는 **앉는 그 순간**
   * `crouchAim` 으로 넘어가므로, 포복 구간을 지나는 내내 두 줄이 첫 자세의 라벨로 얼어 있었다. 이제 조건은 단계가 아니라
   * **「지금 떠 있는 줄에 앉기 · 포복 줄이 있는가」**(`STANCE_HINT_IDS`)이고, 같은 자세로 두 번 온 이벤트도 버리지 않는다
   * (부활 · 이어하기로 자세가 이벤트 없이 선 자세로 돌아가면 `this.stance` 가 틀린 채로 남아 다음 이벤트를 삼켰다).
   */
  private onStance(stance: Stance): void {
    const changed = stance !== this.stance;
    this.stance = stance;
    const step = this.step;
    if (step && this.controlIds.some((id) => STANCE_HINT_IDS.includes(id))) this.applyControls(step, true);
    if (changed && stance !== 'stand') this.advanceIf('crouch');
    if (stance !== 'stand') this.maybeCrouchTip();
  }

  private onFurniture(defId: string, uid: string): void {
    if (defId !== TUTORIAL_BENCH_DEF) return;
    this.save.benchUid = uid;
    this.benchInteractable = `hub_furn_${uid}`;
    this.benchArmed = false;
    // 제작 이벤트를 놓쳤거나(저장 복구 · 콘솔) 곧바로 놓았다면 두 단계를 한 번에 지나간다
    if (this.step === 'bench') this.setStep('benchPlace');
    this.advanceIf('benchPlace');
  }

  /**
   * 가방 창이 열렸다. `openBag` 단계에서 **제작 열이 없는 채로** 열렸다면 그것으로 단계는 끝난 것이다
   * (저장 복구 · 창을 통째로 닫았다가 Tab 으로 다시 연 경우). 한 프레임 미루는 이유: `openBenchCraft` 는
   * `inventory:opened` 를 먼저 emit 하고 **그 다음에** `ui:craftToggled {open:true}` 를 보내므로,
   * 지금 자리에서 읽으면 작업대를 여는 순간마다 이 단계가 잘못 넘어간다.
   */
  private onInventoryOpened(): void {
    if (this.step !== 'openBag') return;
    window.setTimeout(() => { if (!this.craftOpen) this.advanceIf('openBag'); }, 0);
  }

  /**
   * 가방 창이 닫혔다. **`corpseLoot` 는 여기서 끝난다** (2026-09-14 3차, 사용자 결정) — 총을 장착한 뒤
   * 창을 닫는 그 순간이다. 총을 안 들고 닫으면 그대로 그 단계에 머문다 (필수 목표가 아직 비어 있다).
   * 그래서 HUD 노출(`HUD_GEAR_STEP`)의 뜻은 그대로다: 이 단계를 **지나면** 체력 · 무기 HUD 가 보인다.
   */
  private onInventoryClosed(): void {
    const step = this.step;
    if (step === 'corpseLoot') {
      if (this.done.has('corpseGun')) { this.advance(); return; }
      /*
       * 2026-09-15 (사용자 결정) — 총을 안 들고 **곧바로 닫았다**: 포커싱을 푼다. 그대로 두면 다음에 인벤토리를 열 때마다
       * 장비 칸에 링이 따라온다. 필수 목표가 비어 있어도 막다른 길이 아니다 — 걸어가면 `bugs` 체크포인트 · 벌레 스폰이
       * 앞으로 접는다 (`foldRaid`). 시체를 다시 열면 포커싱이 되살아난다 (`onContainerOpened`).
       */
      if (!this.corpseFocusOff) { this.corpseFocusOff = true; this.refreshVisuals(); }
      return;
    }
    // 2026-09-15: 보급품 시체 — 붕대를 얻은 뒤 창을 닫으면 회복 단계다
    if (step === 'supplyLoot' && this.done.has('supplyBandage')) this.advance();
  }

  /** 컨테이너 창이 열렸다 — `corpseLoot` 에서 풀어 둔 포커싱을 시체를 다시 열면 되살린다 (2026-09-15). */
  private onContainerOpened(containerId: string): void {
    if (this.step !== 'corpseLoot' || !this.corpseFocusOff || !containerId.startsWith('corpse:')) return;
    this.corpseFocusOff = false;
    this.refreshVisuals();
  }

  /**
   * 제작 열이 열리거나 닫혔다 (작업대 경로 · 가방 버튼 경로 모두). 닫힘이 `openBag` 의 신호다.
   *
   * 2026-09-14 3차 — 두 목표 줄이 여기 걸린다: `craftGun` 의 「총기 작업대 작동」(열림)과 `equipGun` 의
   * 「제작 창을 닫는다」(닫힘 — 그래야 장비 칸이 돌아온다). 스포트라이트도 이 상태를 보고 갈린다.
   */
  private onCraftPanel(open: boolean): void {
    if (open === this.craftOpen) { if (!open) this.advanceIf('openBag'); return; }
    this.craftOpen = open;
    if (open) this.markIf('craftGun', 'craftGunOpen');
    else this.markIf('equipGun', 'equipClose');
    if (this.step === 'equipGun') this.refreshVisuals();   // 포커싱이 닫기 버튼 ↔ 장비칸+가방으로 갈린다
    if (!open) this.advanceIf('openBag');
  }

  private onCrafted(recipeId: string): void {
    if (recipeId === TUTORIAL_GUN_RECIPE) this.advanceIf('craftGun');
    else if (recipeId === TUTORIAL_AMMO_RECIPE) this.advanceIf('craftAmmo');
  }

  /**
   * 장착이 바뀌었다.
   *   • `equipGun`(증축 트랙) — 만든 소총이 주무기 I · II 어느 쪽이든 들어오면 끝.
   *   • `corpseLoot`(레이드 트랙, 2026-09-14 2차) — **아무 주무기나** 들면 그 목표가 달성이다 (튜토리얼 레이드는
   *     빈손으로 시작하므로 그 총은 시체에서 꺼낸 것뿐이다 — def id 는 `world/tutorial` 이 정하므로 여기서 모른다).
   *     ⚠ 2026-09-14 3차 (사용자 결정): 그 자리에서 **넘어가지 않는다** — 아직 인벤토리 화면을 보고 있는 사람의
   *     등 뒤에서 목표가 바뀌기 때문이다. 다음 단계는 **가방을 닫을 때**다 (`onInventoryClosed`).
   *     가방은 같은 단계의 **선택** 목표라 체크만 한다.
   */
  private onLoadout(): void {
    const l = this.ctx.inventory?.getLoadout();
    if (!l) return;
    if (this.step === 'corpseLoot') {
      if (l.bag) this.markObjective('corpseBag');
      if (l.primary || l.primary2) this.markObjective('corpseGun');
      return;
    }
    if (this.step !== 'equipGun') return;
    if (l.primary?.defId === TUTORIAL_GUN_DEF || l.primary2?.defId === TUTORIAL_GUN_DEF) this.advance();
  }

  /** 가방에 준중량탄이 들어왔는가 (+ 레이드 트랙의 「챙긴다 · 획득」 목표 — 탄약 · 붕대 · 수류탄). */
  private onInventory(): void {
    const inv = this.ctx.inventory;
    if (!inv) return;
    if (this.step === 'corpseLoot') {
      // 2026-09-14 4차: 회복(`corpseStim`)은 목표에서 빠졌다 — 그 시체에는 회복 아이템이 없다
      try { if (inv.countWhere((d) => d.category === 'ammo') > 0) this.markObjective('corpseAmmo'); }
      catch { /* inventory not ready */ }
      return;
    }
    if (this.step === 'supplyLoot') {
      /*
       * 2026-09-15 — 「시체에서 붕대 획득」 · 「(선택) 시체에서 수류탄 획득」. 튜토리얼 레이드는 빈손으로 시작하고 첫 시체에는
       * 회복 아이템도 수류탄도 없으므로 「지니고 있다」가 곧 「그 시체에서 얻었다」다. `countWhere` 는 빠른 사용 칸도
       * 함께 보므로 줍자마자 휠에 자동 등록된 것도 그대로 세어진다. (옛 `heal` 의 `healGrenade` 가 여기로 옮겨 왔다.)
       */
      try {
        if (inv.countWhere((d) => d.category === 'stim') > 0) this.markObjective('supplyBandage');
        if (inv.countWhere((d) => d.category === 'grenade') > 0) this.markObjective('supplyGrenade');
      } catch { /* inventory not ready */ }
      return;
    }
    if (this.step !== 'stowAmmo') return;
    let rounds = 0;
    try { rounds = inv.countWhere((d) => d.id === TUTORIAL_AMMO_DEF); } catch { rounds = 0; }
    if (rounds > 0) this.advance();
  }

  /**
   * 월드가 섰다. **튜토리얼 레이드면** 레이드 트랙을 켠다 (새로고침으로 돌아온 경우도 여기를 지난다).
   * 그 밖의 레이드에서는 예전 그대로 — 증축 트랙의 마지막 단계(`raid`)가 탈출 지점을 한 번 짚어 주고 끝난다.
   */
  private onRaid(): void {
    if (this.ctx.missionMode === 'tutorial') {
      this.startRaidTrack();
      // 새로고침으로 `wake` 에서 그대로 돌아온 경우 — `startRaidTrack` 은 이미 돌고 있는 트랙에서 곧장 되돌아가므로
      //   예약을 여기서 한 번 더 세운다. 연출이 없으면 검은 화면만 걷히고 안내도 안 뜬 채 서 있게 된다.
      if (this.step === 'wake') this.pendingWake = true;
      this.refreshVisuals();
      return;
    }
    if (!this.active || this.track !== 'build') return;
    if (this.step !== 'raid') this.setStep('raid');
    this.ctx.bus.emit('ui:notify', { text: '나침반의 탈출 마커를 따라가세요 — 튜토리얼 종료', kind: 'info', duration: 6 });
    window.setTimeout(() => { if (this.step === 'raid') this.finish(false); }, 6000);
  }

  /* ── 목표 줄 (2026-09-14 2차) ───────────────────────────────────────────
   * 목표 패널이 체크박스 목록이 됐다. **필수 목표는 단계가 넘어가는 순간 전부 달성**이고 (그 단계가 끝났다는
   * 것이 곧 그 뜻이다), **선택 목표는 여기 `markObjective` 로 하나씩** 켠다. 달성 애니메이션이 보이도록
   * 패널이 다음 단계의 목표 줄을 반 박자(`TUTORIAL_STEP_DELAY_S`) 붙잡는다 — 단계 기계는 안 기다린다. */

  /**
   * 목표 하나를 달성 표시한다 (멱등). 지금 단계의 목표가 아니어도 기록은 해 둔다 — 그려질 때 켜진다.
   *
   * 2026-09-14 3차 — **앞의 순차 공개 사슬까지 함께** 적는다 (`objectiveChain`). 뒤 줄을 먼저 해낸 사람
   * (휠을 안 열고 탭으로 붕대를 꺼낸 사람)의 앞 줄이 영영 안 켜지면 그 뒤가 통째로 숨기 때문이다.
   * 체크 애니메이션이 보이도록 패널에 먼저 알리고(`markDone`), 새로 열린 줄은 그 반 박자 뒤에 그려진다.
   */
  markObjective(id: string): void {
    const step = this.step;
    const ids = step ? objectiveChain(this.objectivesFor(stepDef(step)), id) : [id];
    const fresh = ids.filter((x) => !this.done.has(x));
    if (fresh.length === 0) return;
    for (const x of fresh) this.done.add(x);
    this.save.objectives = [...this.done];
    this.persist();
    this.panel.markDone(fresh);
    this.refreshVisuals();
  }

  /** 그 단계에서만 목표를 적는다 — 이벤트는 단계를 가리지 않고 오므로 (`quick:*` 는 언제든 온다). */
  private markIf(step: TutorialStepId, id: string): void {
    if (this.step === step) this.markObjective(id);
  }

  /** 회복 아이템인가 (`heal` 단계의 목표 판정). def 를 모르면 false. */
  private isStim(item: ItemInstance | null | undefined): boolean {
    if (!item) return false;
    try { return this.ctx.inventory?.getDef(item.defId)?.category === 'stim'; } catch { return false; }
  }

  /** 지금 단계의 목표 줄 (`benchPlace` 처럼 문구를 갈아 끼우는 자리는 `refreshVisuals` 가 넘긴다). */
  private objectivesFor(def: StepDef): readonly TutorialObjective[] { return objectivesOf(def); }

  /** 이 단계의 **필수** 목표를 전부 달성으로 적고, 패널이 그 애니메이션을 보여 줄 시간을 잡게 한다. */
  private completeRequired(step: TutorialStepId): void {
    const ids: string[] = [];
    for (const o of this.objectivesFor(stepDef(step))) {
      if (o.optional) { if (this.done.has(o.id)) ids.push(o.id); continue; }
      this.done.add(o.id);
      ids.push(o.id);
    }
    this.panel.markDone(ids);
  }

  private advanceIf(step: TutorialStepId): void {
    if (this.step === step) this.advance();
  }

  /**
   * @param silent 조용히 지나치는 단계(이미 돌고 있는 발전기 · 이미 만든 작업대 · 체력이 가득인 `heal`)는
   *               달성 표시를 하지 않는다 — 하지도 않은 일에 체크가 그어지고 반 박자 멈추면 이상하다.
   */
  private advance(silent = false): void {
    const cur = this.step;
    if (!cur) return;
    if (!silent) this.completeRequired(cur);
    const next = nextStep(cur);
    if (!next) { this.finish(false); return; }
    if (!silent) this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.setStep(next);
  }

  private setStep(step: TutorialStepId): void {
    const prev = this.step;                       // 반드시 바꾸기 **전에** 읽는다 (`quiet` 의 기준)
    const track = trackOf(step);
    const entry = this.save.tracks[track] ?? (this.save.tracks[track] = { step: null, done: false });
    const changed = entry.step !== step;
    entry.step = step;
    entry.done = false;
    // 기상 연출을 막 빠져나왔다 — 목표 패널 · 조작 가이드는 한 박자 뒤에 (또는 1 m 움직인 그 순간에) 나타난다
    if (prev === 'wake' && step !== 'wake') this.beginWakeReveal();
    // 처치 수 · 달성한 목표는 단계마다 따로 센다 (`shoot` → `crouchAim`)
    this.kills = 0;
    if (changed) { this.done.clear(); this.save.objectives = []; this.corpseFocusOff = false; }
    // 우측 조작 가이드를 **이 단계의 줄**로 갈아 끼운다 (2026-09-14 3차 — 표에 없는 단계는 직전 줄 유지)
    this.applyControls(step);
    // 재료: 바닥(한 번) + 그 단계 레시피의 부족분 top-up (멱등). 탄약 재료는 소총이 완성되어 `craftAmmo` 에 들어서는
    //   바로 그 순간 채운다 — 소총이 먹은 폐금속을 그때 본다 (같은 작업대 창이 열린 채라 목록이 곧바로 만들 수 있는 상태가 된다).
    if (step === 'craftGun') { this.grantMaterials(); this.ensureMaterials(TUTORIAL_GUN_RECIPE, step); }
    else if (step === 'craftAmmo') this.ensureMaterials(TUTORIAL_AMMO_RECIPE, step);
    this.persist();
    this.refreshVisuals();
    this.emitChanged();
    if (step === 'intro') this.showIntro();
    // 이미 돌고 있는 발전기 · 이미 만들어 둔 작업대 앞에서 "만드세요"를 띄우지 않는다 (콘솔 `tutorial step`, 저장 복구)
    if (step === 'generator' && this.generatorReady()) this.advance(true);
    else if (step === 'bench' && this.benchStored()) this.advance(true);
    /*
     * 2026-09-14 3차 (사용자 결정): `manageDone`(함선 관리 닫기)은 **순서에서 빠졌다** — 「닫으세요」만 하는
     * 단계를 세워 둘 이유가 없고, 다음 단계는 어차피 작업실로 걸어가는 일이다. `TUTORIAL_STEPS` 에서 id 를
     * 뺐고(`openCraft` 와 같은 처리 — 타입 · 표에는 남는다) 진행 바의 분모도 그만큼 줄었다. 이 가지는
     * 콘솔 `tutorial step manageDone` 처럼 밖에서 그 단계를 세우는 길을 위한 안전망이다.
     */
    else if (step === 'manageDone') this.advance(true);
    // 2026-09-14 2차 (사용자 결정): 체력이 이미 가득이면 회복 단계에 할 일이 없다 — `generator` 와 같은 요령이다
    else if (step === 'heal' && this.healthFull()) this.advance(true);
    else this.onStepEntered(step);
  }

  /**
   * 단계에 **실제로 들어섰다** (조용히 지나친 단계는 여기 안 온다). 이미 되어 있는 목표를 그 자리에서 적어
   * 다음 줄이 바로 열리게 한다 — 이벤트는 지나간 뒤라 다시 오지 않기 때문이다.
   */
  private onStepEntered(step: TutorialStepId): void {
    // 보급품을 먼저 주워 놓고 단계에 들어선 사람 (2026-09-15) — 붕대 · 수류탄은 이미 한 일이고, 창이 닫혀 있으면 곧장 회복 단계다
    if (step === 'supplyLoot') {
      this.onInventory();
      if (this.done.has('supplyBandage') && !this.invOpen) this.advance();
      return;
    }
    // 제작 창이 이미 닫혀 있으면 (`openBag` 을 지나온 평소 경로) 「제작 창을 닫는다」는 이미 한 일이다
    if (step === 'equipGun' && !this.craftOpen) this.markObjective('equipClose');
  }

  /** 체력이 가득인가 — `heal` 단계를 조용히 지나칠지의 판단. 모르면(플레이어가 아직 없으면) false. */
  private healthFull(): boolean {
    const p = this.ctx.player;
    const max = p?.maxHp ?? 0;
    return max > 0 && (p?.hp ?? 0) >= max - 0.01;
  }

  /** 지금 상태를 알린다 — HUD 게이트(`hides('hud', …)`)를 묻는 위젯들이 이것으로 다시 그린다. */
  private emitChanged(): void {
    const step = this.step, track = this.track;
    this.ctx.bus.emit('tutorial:changed', {
      active: step !== null, step, index: stepIndexOf(step), count: this.stepCount,
      ...(track ? { track } : {}),
    });
  }

  /** **그 트랙만** 끝낸다. 다른 트랙은 그대로 남아 제 때 시작한다 (사용자 결정). */
  private finish(skipped: boolean): void {
    const track = this.track;
    if (!track) return;
    const count = this.stepCount;
    this.save.tracks[track] = { step: null, done: true };
    // 레이드 트랙을 **완주**했을 때만 함선 트랙이 이어진다 — 건너뛴 사람에게 「레벨이 올랐습니다」가 뜨면 안 된다
    if (track === 'raid') this.save.pendingShip = !skipped;
    this.resetControls();
    this.persist();
    this.popup.close();
    this.refreshVisuals();
    this.ctx.bus.emit('tutorial:changed', { active: false, step: null, index: 0, count });
    this.ctx.bus.emit('tutorial:finished', { skipped, track });
    const label = TRACK_LABEL_KO[track];
    this.ctx.bus.emit('ui:notify', {
      text: skipped ? `${label}를 건너뛰었습니다` : (track === 'build' ? '튜토리얼 완료 — 좋은 사냥 되세요' : `${label} 완료`),
      kind: skipped ? 'warning' : 'success', duration: 4,
    });
    // 함선 안에서 끝난 트랙은 곧바로 다음 트랙으로 이어진다 (함선 → 증축)
    if (this.ctx.isHubPhase()) this.autoStart();
  }

  /* ── 우측 조작 가이드 ──────────────────────────────────────────────────── */

  /**
   * 우측 조작 가이드를 **이 단계의 줄**로 갈아 끼운다 (2026-09-14 3차, 사용자 결정 — 예전의 「누적」을 뒤집었다).
   *
   * ⚠ **표에 없는 단계는 아무것도 하지 않는다** — 직전 단계의 줄이 그대로 남는다 (`wake` · `sprintJump` ·
   * `crouchAim` · `drop` 처럼 새 키가 없는 단계에서 안내가 깜빡이지 않게). 빈 배열과 `undefined` 의 뜻이 다르다.
   *
   * @param force 줄 목록은 같은데 **문구만** 바뀌었을 때 (`crouch` 의 자세별 `앉기` ↔ `일어서기`).
   */
  private applyControls(step: TutorialStepId, force = false): void {
    // 자세는 **지금 읽는다** (2026-09-15) — 부활 · 이어하기가 이벤트 없이 자세를 되돌릴 수 있다
    const hints = controlHintsFor(step, this.ctx.player?.stance ?? this.stance);
    if (!hints) return;
    const ids = hints.map((h) => h.id);
    if (!force && ids.length === this.controlIds.length && ids.every((x, i) => this.controlIds[i] === x)) return;
    this.controlIds = ids;
    this.save.learned = ids;
    this.controls.set(hints);
  }

  /**
   * 새로고침 복구 — 저장된 줄을 강조 없이 다시 세운다 (`init`). 표를 통째로 훑어 id 로 찾으므로 옛 저장에
   * 쌓여 있던 누적 목록도 그대로 뜨고(그 다음 단계 전환이 지금 줄로 갈아 끼운다), 사라진 id 는 조용히 빠진다.
   */
  private restoreControls(): void {
    const ids = this.save.learned;
    if (!ids || ids.length === 0) return;
    const hints: ControlHint[] = [];
    for (const list of Object.values(TUTORIAL_CONTROL_HINTS)) {
      for (const h of list ?? []) if (ids.includes(h.id) && !hints.some((x) => x.id === h.id)) hints.push(h);
    }
    if (hints.length === 0) return;
    this.controlIds = hints.map((h) => h.id);
    this.controls.restore(hints);
  }

  private resetControls(): void {
    // 트랙이 갈리면 기상 유예도 끝난 것이다 — 남겨 두면 다음 트랙의 첫 안내가 그만큼 늦게 뜬다
    this.wakeHoldT = 0;
    this.save.learned = [];
    this.controlIds = [];
    this.controls.clear();
    this.tip.clear();
    this.done.clear();
    this.save.objectives = [];
  }

  /* ── 재료 지급 ─────────────────────────────────────────────────────────── */

  /**
   * 바닥 지급 — `craftGun` 진입 시 한 번. 가방으로 넣고(가득 찼으면 함선 창고로) 무엇이 들어갔는지 알려 준다.
   * 저장에 `granted` 를 남기므로 새로고침해도 두 번 주지 않는다. 실제 부족분은 `ensureMaterials` 가 본다.
   */
  private grantMaterials(): void {
    if (this.save.granted) return;
    const inv = this.ctx.inventory, loot = this.ctx.loot;
    if (!inv || !loot) return;
    let given = 0;
    for (const { defId, qty } of TUTORIAL_CRAFT_GRANT) {
      try {
        const item = loot.createItem(defId, qty);
        if (inv.tryAddItemAnywhere(item)) given++;
      } catch { /* def missing / no room — the step still runs, the player just has to find materials */ }
    }
    this.save.granted = true;
    if (given > 0) {
      this.ctx.bus.emit('ui:notify', { text: '보급: 제작 재료가 들어왔습니다', kind: 'success', duration: 4 });
    }
  }

  /**
   * **Top-up** (2026-09-09) — `recipeId` 의 재료 하나하나에 대해 `필요 − 보유` 만큼만 더 준다. 필요량은 레시피(`ctx.loot`)
   * 에서, 보유는 `canCraft` 와 같은 자리(가방, `countWhere`)에서 읽는다 — 제작은 가방의 재료만 쓰기 때문이다.
   * 가방부터 넣고 자리가 없으면 함선 창고로 (`tryAddItemAnywhere`). 멱등: 모자란 것이 없으면 아무 일도 없고 토스트도 없다.
   */
  private ensureMaterials(recipeId: string, step: TutorialStepId): void {
    const inv = this.ctx.inventory, loot = this.ctx.loot;
    if (!inv || !loot) return;
    let recipe: { inputs: readonly { defId: string; qty: number }[] } | undefined;
    try { recipe = loot.getAllRecipes().find((r) => r.id === recipeId); } catch { recipe = undefined; }
    if (!recipe) return;
    const given: string[] = [];
    let toStash = false;
    for (const { defId, qty } of recipe.inputs) {
      let have = 0;
      try { have = inv.countWhere((d) => d.id === defId); } catch { have = 0; }
      let short = qty - have;
      if (short <= 0) continue;
      const def = inv.getDef(defId);
      const max = Math.max(1, def?.stackMax ?? 1);
      let added = 0;
      while (short > 0) {
        const q = Math.min(max, short);
        let where: 'bag' | 'stash' | null = null;
        try { where = inv.tryAddItemAnywhere(loot.createItem(defId, q)); } catch { where = null; }
        if (!where) break;
        if (where === 'stash') toStash = true;
        short -= q; added += q;
      }
      if (added > 0) given.push(`${def?.name ?? defId} ${added}`);
    }
    const topped = this.save.topped ?? (this.save.topped = []);
    if (!topped.includes(step)) topped.push(step);
    if (given.length > 0) {
      this.ctx.bus.emit('ui:notify', {
        text: `보급: ${given.join(' · ')} — ${toStash ? '가방이 차서 일부는 함선 창고에' : '가방에'} 채웠습니다`,
        kind: 'success', duration: 4,
      });
    }
  }

  /* ── 화면 ──────────────────────────────────────────────────────────────── */

  /** 패널 · 스포트라이트 · 안내선을 현재 단계에 맞춘다. 안 보여야 할 곳(메뉴 · 컷씬)에서는 전부 접는다. */
  private refreshVisuals(): void {
    if (!this.active) {
      this.panel.hide();
      this.spotlight.set([], '');
      this.guide.setTarget(null);
      this.controls.show(false);
      return;
    }
    this.panel.setLifted(false);        // 다음 update 가 스포트라이트 상태를 보고 다시 정한다
    const step = this.step!;
    const track = this.track!;
    const def = stepDef(step);
    // 2026-09-14 4차: 기상 연출 중 · 그 직후의 한 박자 동안에는 아무것도 그리지 않는다 (`quiet`)
    const showable = (this.ctx.isHubPhase() || this.ctx.isGameplayPhase()) && !this.quiet;
    if (!showable) {
      this.panel.hide();
      this.spotlight.set([], '');
      this.guide.setTarget(null);
      this.controls.show(false);
      return;
    }
    // 2026-09-14 2차: 인벤토리 화면은 화면 우측을 통째로 쓴다 — 그 동안 조작 가이드는 접는다
    this.controls.show(!this.invOpen);
    // 가구를 집은 뒤에는 밝힐 UI 가 없다 — 남은 일은 3D 바닥을 클릭하는 것뿐이다
    const placing = step === 'benchPlace' && this.benchArmed;
    const view = this.stepView(step, def);
    this.panel.show({
      track: TRACK_LABEL_KO[track],
      // 2026-09-14 3차: **아직 안 열린 줄은 그리지 않는다** (순차 공개, `visibleObjectives`)
      objectives: visibleObjectives(view.objectives, this.done),
      done: this.done,
      index: stepIndexOf(step), count: this.stepCount,
    });
    // 시작 카드가 떠 있는 동안에는 스포트라이트를 겹치지 않는다
    this.spotlight.set(this.popup.isOpen || placing ? SPOT_NONE : view.spot, view.spotText, view.union, view.noDim);
    this.guide.setTarget(this.guideTarget(def.guide));
    // 3D 목표 마커 — 지금은 `corpseLoot` 의 목표 시체 하나뿐이다
    this.marker.setTarget(step === 'corpseLoot' ? this.nearestCorpse() : null);
  }

  /**
   * 그 단계가 **지금** 보여 줄 것 (2026-09-14 3차). 대부분은 표(`Steps.ts`) 그대로이고, 화면 상태에 따라
   * 갈리는 두 자리만 여기서 고른다 — 표에 조건을 적기 시작하면 표가 코드가 된다.
   *   • `equipGun` + 제작 창이 열려 있음 → 장비 칸이 숨었으므로 **닫기 버튼**부터 (목표 줄도 앞줄이 그것이다).
   *   • `corpseLoot` + 총을 이미 들었음 → **포커싱을 끈다** (2026-09-14 4차, 사용자 결정). 그 단계에서 배울 것은
   *     끝났고 남은 것은 선택 목표와 창을 닫는 일이라, 링이 계속 장비 칸을 두르고 있으면 아직 뭔가 덜 한 것처럼 보인다.
   *     2026-09-15: 총을 안 들고 **창을 곧바로 닫았을 때**도 끈다 (`corpseFocusOff` — 시체를 다시 열면 되살아난다).
   *   • `heal` 은 이제 밝힐 UI 가 **처음부터** 없다 (자동 등록 + 휠은 화면이 아니라 손가락이다) — 표 그대로 간다.
   */
  private stepView(step: TutorialStepId, def: StepDef): {
    objectives: readonly TutorialObjective[]; spot: readonly string[] | undefined;
    spotText: string; union: boolean; noDim: boolean;
  } {
    const objectives = this.objectivesFor(def);
    if (step === 'equipGun' && this.craftOpen) {
      return { objectives, spot: SPOT_CRAFT_CLOSE, spotText: '제작 창 닫기', union: false, noDim: false };
    }
    if (step === 'corpseLoot' && (this.done.has('corpseGun') || this.corpseFocusOff)) {
      return { objectives, spot: SPOT_NONE, spotText: '', union: false, noDim: false };
    }
    return {
      objectives, spot: def.spot, spotText: def.spotText ?? def.hint,
      union: !!def.spotUnion, noDim: !!def.spotNoDim,
    };
  }

  /**
   * 지금 **가장 가까운 루팅 가능한 시체**의 자리 (`Interactable.kind === 'corpse'`).
   * 좌표를 이 폴더에 적지 않으려는 것이다 — `world/tutorial` 이 시체를 옮겨도 마커가 따라간다.
   */
  private nearestCorpse(): THREE.Vector3 | null {
    const p = this.ctx.player;
    if (!p) return null;
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const it of this.ctx.interactables.all()) {
      if (it.kind !== 'corpse') continue;
      let ok = false;
      try { ok = it.canInteract(); } catch { ok = false; }
      if (!ok) continue;
      const d = it.position.distanceToSquared(p.position);
      if (d < bestD) { bestD = d; best = it.position; }
    }
    return best;
  }

  /** 인벤토리 화면이 열리고 닫힌다 — 우측 조작 가이드가 그 뒤로 숨는다. */
  private setInventoryOpen(open: boolean): void {
    if (open === this.invOpen) return;
    this.invOpen = open;
    // 기상 연출 · 그 직후의 한 박자 동안에는 무슨 일이 있어도 뜨지 않는다 (`quiet`)
    if (this.active) this.controls.show(!open && !this.quiet);
  }

  private guideTarget(kind: 'bench' | 'terminal' | 'pod' | undefined): string | null {
    if (!kind) return null;
    if (kind === 'bench') return this.benchInteractable;
    if (kind === 'terminal') return 'hub_terminal';
    return 'hub_pod_0';
  }

  private showIntro(): void {
    this.popup.open('튜토리얼', [
      '함선을 한 바퀴 돌며 기본 조작을 익힙니다.',
      '작업실을 짓고 · 총과 탄약을 만들고 · 행성을 정해 출격하는 데까지 안내합니다.',
      '언제든 ESC 메뉴의 튜토리얼 건너뛰기로 그만둘 수 있습니다.',
    ], [
      { label: '건너뛰기', onClick: () => { this.popup.close(); this.askSkip(); } },
      { label: '시작', kind: 'primary', onClick: () => { this.popup.close(); this.advance(); } },
    ]);
    this.refreshVisuals();
  }

  /**
   * 건너뛰기 확인 — 모달리스 카드. 취소하면 하던 자리로 돌아간다.
   * 2026-09-14: **지금 트랙만** 건너뛴다 — 다른 트랙은 제 때 다시 시작한다 (카드 본문 한 줄이 그것을 말한다).
   */
  private askSkip(): void {
    if (!this.active || this.confirmingSkip) return;
    this.confirmingSkip = true;
    // 2026-09-09: 본문 없음 — 제목과 버튼만. 건너뛰기는 빨간 **홀드 버튼**(`SKIP_HOLD_TIME`)이라 짧게 눌러서는 끝나지 않는다.
    this.popup.open(`${TRACK_LABEL_KO[this.track!]}를 건너뛸까요?`, [], [
      { label: '계속하기', onClick: () => { this.confirmingSkip = false; this.popup.close(); this.refreshVisuals(); } },
      { label: '건너뛰기', kind: 'danger', hold: SKIP_HOLD_TIME, onClick: () => { this.confirmingSkip = false; this.skip(); } },
    ]);
    this.refreshVisuals();
  }

  /* ── 저장 ──────────────────────────────────────────────────────────────── */

  /**
   * 저장 읽기. **v1 → v2 마이그레이션이 요점이다** (2026-09-14): v1 의 `step` · `done` 은 전부 지금의 `build`
   * 트랙 것이었으므로 그 자리로 옮겨 붙이고, 그 프로필은 **레이드 · 함선 트랙을 이미 끝낸 것으로 본다** —
   * 안 그러면 하던 사람이 다음 접속에서 튜토리얼 레이드로 끌려간다 (`isTrackDone('raid')` 가 진입 흐름을 정한다).
   */
  private load(): SaveV2 {
    try {
      const raw = window.localStorage.getItem(slotKey(TUTORIAL_STORAGE_KEY));
      if (!raw) return freshSave();
      const doc = JSON.parse(raw) as Partial<SaveV2>;
      const tracks: Partial<Record<TutorialTrack, TutorialTrackSave>> = {};
      const src = doc.tracks;
      if (src && typeof src === 'object') {
        for (const t of TUTORIAL_TRACKS) {
          const e = src[t];
          if (!e || typeof e !== 'object') continue;
          const done = !!e.done;
          // 순서에서 빠진 단계(`openCraft`)는 그 자리를 이어받은 단계로 · 남의 트랙 단계는 버린다
          const step = normalizeStep(e.step);
          tracks[t] = { step: done || !step || trackOf(step) !== t ? null : step, done };
        }
      } else {
        tracks.build = { step: doc.done ? null : normalizeStep(doc.step), done: !!doc.done };
        tracks.raid = { step: null, done: true };
        tracks.ship = { step: null, done: true };
      }
      return {
        version: TUTORIAL_SAVE_VERSION,
        tracks,
        room: typeof doc.room === 'number' ? doc.room : undefined,
        granted: !!doc.granted,
        benchUid: typeof doc.benchUid === 'string' ? doc.benchUid : undefined,
        pendingShip: !!doc.pendingShip,
        learned: Array.isArray(doc.learned) ? doc.learned.filter((s): s is string => typeof s === 'string') : undefined,
        objectives: Array.isArray(doc.objectives) ? doc.objectives.filter((s): s is string => typeof s === 'string') : undefined,
        topped: Array.isArray(doc.topped)
          ? doc.topped.map((s) => normalizeStep(s as string)).filter((s): s is TutorialStepId => s !== null)
          : undefined,
      };
    } catch { return freshSave(); }
  }

  private persist(): void {
    try { window.localStorage.setItem(slotKey(TUTORIAL_STORAGE_KEY), JSON.stringify(this.save)); } catch { /* storage off */ }
  }

  /* ── dev 콘솔 ──────────────────────────────────────────────────────────── */

  private registerConsole(): void {
    const c = this.ctx.console;
    if (!c || typeof c.register !== 'function') return;
    try {
      c.register({
        name: 'tutorial',
        usage: 'tutorial [start|skip|step <id>|track <raid|ship|build>|status]',
        description: '튜토리얼 시작 / 건너뛰기 / 특정 단계 · 트랙으로 이동',
        run: (args, _ctx, print) => {
          const sub = args[0] ?? 'status';
          if (sub === 'start') { print(this.start() ? '튜토리얼 시작' : '이미 진행 중입니다', 'info'); return; }
          if (sub === 'skip') { this.skip(); print('트랙 종료', 'info'); return; }
          if (sub === 'track') {
            const t = args[1] as TutorialTrack | undefined;
            if (!t || !TUTORIAL_TRACKS.includes(t)) { print(`트랙: ${TUTORIAL_TRACKS.join(' ')}`, 'error'); return; }
            // 이미 끝난 트랙도 콘솔로는 다시 켠다 (`startTrack` 은 거절한다 — 여기서 표식만 지운다)
            this.save.tracks[t] = { step: null, done: false };
            print(this.startTrack(t) ? `→ ${t}` : '이미 다른 트랙이 돌고 있습니다', 'info');
            return;
          }
          if (sub === 'step') {
            const id = args[1] as TutorialStepId | undefined;
            if (!id || !this.goto(id)) {
              for (const t of TUTORIAL_TRACKS) print(`${t}: ${TUTORIAL_TRACK_STEPS[t].join(' ')}`, 'error');
              return;
            }
            print(`→ ${id}`, 'success');
            return;
          }
          print(this.active ? `${this.track} · ${this.step} (${this.stepIndex}/${this.stepCount})` : '비활성', 'info');
        },
      });
    } catch { /* console shape differs — the tutorial works without it */ }
  }
}
