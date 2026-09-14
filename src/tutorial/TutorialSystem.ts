import './tutorial.css';
import type {
  GameContext, GameSystem, TutorialGate, TutorialRef, TutorialSave, TutorialStepId, TutorialTrack, TutorialTrackSave,
} from '@/shared';
import {
  COCKPIT_DECOR_FURNITURE, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, SHIP_ROOM_COUNT,
  TUTORIAL_STEPS, TUTORIAL_TRACKS, TUTORIAL_TRACK_STEPS, slotKey,
} from '@/shared';
import {
  CHECKPOINT_STEP, GRENADE_KILL_WINDOW_S, RAID_KILLS_PER_STEP, SKIP_HOLD_TIME, TRACK_LABEL_KO, TUTORIAL_AMMO_DEF,
  TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_CONTROL_HINTS, TUTORIAL_CRAFT_GRANT, TUTORIAL_GUN_DEF,
  TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, TUTORIAL_SAVE_VERSION, TUTORIAL_STORAGE_KEY, objectivesOf,
  type ControlHint, type HudRevealState, type StepDef, type TutorialObjective,
} from './model';
import { nextStep, normalizeStep, stepCountOf, stepDef, stepIndexOf, trackOf } from './Steps';
import * as Gates from './parts/Gates';
import { Guide } from './parts/Guide';
import { Spotlight } from './parts/Spotlight';
import { TutorialControls } from './ui/Controls';
import { TutorialPanel } from './ui/Panel';
import { TutorialPopup } from './ui/Popup';

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
  /** 우측 조작 가이드 — 배운 키가 한 줄씩 쌓인다 (레이드 트랙). */
  private controls!: TutorialControls;
  /** `hides('hud', …)` 가 보는 관찰 상태 (표로는 못 정하는 것). */
  private readonly hudState: HudRevealState = { staminaUsed: false };
  /** `shoot` 단계에서 처치한 적 수 (레이드 트랙 안에서만 센다). */
  private kills = 0;
  /** 지금 단계에서 달성한 목표 id (`save.objectives` 의 살아 있는 사본). */
  private done = new Set<string>();
  /** 마지막으로 수류탄이 터진 시각 (ms) — `grenade` 단계의 선택 목표 「수류탄으로 처치」를 가르는 창. */
  private grenadeAt = -Infinity;
  /** 인벤토리 화면이 열려 있다 — 그 동안 우측 조작 가이드를 접는다 (2026-09-14 2차). */
  private invOpen = false;

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
    this.controls = new TutorialControls(ctx.uiRoot);
    this.restoreControls();

    const b = ctx.bus;
    this.unsubs.push(
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
      b.on('player:stanceChanged', ({ stance }) => { if (stance !== 'stand') this.advanceIf('crouch'); }),
      // 스태미나 HUD 는 **처음 소모될 때** 나타난다 (`hides('hud','stamina')`)
      b.on('player:sprintChanged', ({ sprinting }) => { if (sprinting) this.markStaminaUsed(); }),
      b.on('player:staminaDepleted', () => this.markStaminaUsed()),
      b.on('player:fell', ({ damage }) => { if (damage > 0) this.advanceIf('drop'); }),
      b.on('enemy:killed', (e) => this.onKill(e.weaponClass)),
      b.on('player:stimUsed', () => this.advanceIf('heal')),
      // 수류탄 단계의 **선택** 목표는 「수류탄으로 처치」다 — 터진 시각을 적어 두고 그 창 안의 비총기 처치를 센다
      b.on('grenade:exploded', () => { this.grenadeAt = performance.now(); }),
      // 탈출은 스위치를 누른 그 순간에 끝난다 — 이륙 연출을 기다리면 결과 화면이 안내를 덮는다
      b.on('extraction:departureStarted', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),
      b.on('extraction:liftoff', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),

      /* ── ② ship 트랙 (2026-09-14) ── */
      b.on('inventory:opened', () => this.advanceIf('levelUp')),
      b.on('progress:statChanged', () => this.advanceIf('stats')),
      b.on('ui:messengerToggled', ({ open }) => { if (open) this.advanceIf('messenger'); }),
      b.on('npc:questChanged', ({ state }) => { if (state === 'active') this.advanceIf('ravenQuest'); }),

      // 리바인드하면 조작 가이드의 키캡 글자를 다시 읽는다 (키는 사용 시점에 읽는다 — `docs/CONTROLS.md`)
      b.on('input:bindingsChanged', () => this.controls.relabel()),
    );
    this.registerConsole();
    this.refreshVisuals();
  }

  update(dt: number): void {
    if (!this.active) return;
    // 스태미나 HUD 는 **처음 줄어들 때** 나타난다. 달리기 말고 점프 · 사다리도 깎으므로 이벤트만 보지 않고
    //   레이드 트랙 동안 한 번 폴링한다 (`staminaUsed` 가 서면 다시는 안 본다).
    if (!this.hudState.staminaUsed && this.track === 'raid') {
      const p = this.ctx.player;
      const max = p?.maxStamina ?? 0;
      if (max > 0 && (p?.stamina ?? max) < max - 0.5) this.markStaminaUsed();
    }
    this.guide.update(dt);
    this.spotlight.update(dt);
    // 포커싱이 켜져 있는 동안 목표 패널은 어두운 판 위로 — 딤 제외 + 건너뛰기 버튼은 언제나 눌린다
    this.panel.setLifted(this.spotlight.visible);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.panel?.dispose();
    this.popup?.dispose();
    this.spotlight?.dispose();
    this.guide?.dispose();
    this.controls?.dispose();
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

  /* ── 3트랙 (2026-09-14, `docs/plans/tutorial-raid.md` C) ─────────────────
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
    if (this.track === track) { this.finish(true); this.leaveTutorialRaid(track); return; }
    this.save.tracks[track] = { step: null, done: true };
    this.persist();
  }

  /**
   * **레이드 트랙 건너뛰기 = 즉시 탈출** (2026-09-14 2차, 사용자 결정). 안내만 끄면 플레이어는 조작을 배우려고
   * 들어온 행성에 그대로 남는다 — 건너뛴 사람이 원하는 것은 **함선**이다. 그래서 걸어가서 타는 것만 건너뛰고
   * `ExtractionRef.skipToLiftoff` 로 평소 탈출 경로(이륙 연출 · 결과 화면 · 정산 · 함선 획득)를 그대로 태운다.
   *
   * 함선을 못 태우는 상태(사망 · 전투불능 중이라 `skipToLiftoff` 가 false)에서는 `game:returnToShip` 으로
   * 내려간다 — 그 자리에서의 사망이라 잃는 것이 있지만, **안내도 목적지도 없는 행성에 갇히는 것보다 낫다.**
   * 건너뛰기는 어차피 「여기서 그만두겠다」이므로 전리품보다 빠져나가는 길이 먼저다.
   */
  private leaveTutorialRaid(track: TutorialTrack): void {
    if (track !== 'raid') return;
    const ctx = this.ctx;
    // 함선 · 증축 트랙과 달리 이 트랙은 레이드 안에서만 산다. 이미 함선이면 할 일이 없다.
    if (!ctx || ctx.missionMode !== 'tutorial' || !ctx.isRaidActive()) return;
    if (ctx.extraction?.skipToLiftoff?.()) return;
    ctx.bus.emit('game:returnToShip', {});
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
    this.grenadeAt = -Infinity;
    this.startTrack('raid');
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
   * 2026-09-14 2차 — `grenade` 단계에서는 **선택 목표**를 센다: 수류탄이 터진 뒤 `GRENADE_KILL_WINDOW_S`
   * 안에 들어온 **총기가 아닌** 처치(`weaponClass == null`)면 「수류탄으로 처치」로 본다. 계열을 모르는
   * 옛 경로(`weaponClass === undefined`)도 같은 창 안이면 받아들인다 — 그 자리에 다른 비총기 수단이 없다.
   */
  private onKill(weaponClass?: string | null): void {
    const step = this.step;
    if (this.track !== 'raid') return;
    if (step === 'grenade') {
      if (weaponClass == null && performance.now() - this.grenadeAt <= GRENADE_KILL_WINDOW_S * 1000) {
        this.markObjective('grenadeKill');
      }
      return;
    }
    if (step !== 'shoot' && step !== 'crouchAim') return;
    this.kills++;
    if (this.kills >= RAID_KILLS_PER_STEP) this.advance();
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
    if (this.step === 'benchPlace') this.refreshVisuals();
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

  /** 제작 열이 열리거나 닫혔다 (작업대 경로 · 가방 버튼 경로 모두). 닫힘이 `openBag` 의 신호다. */
  private onCraftPanel(open: boolean): void {
    this.craftOpen = open;
    if (!open) this.advanceIf('openBag');
  }

  private onCrafted(recipeId: string): void {
    if (recipeId === TUTORIAL_GUN_RECIPE) this.advanceIf('craftGun');
    else if (recipeId === TUTORIAL_AMMO_RECIPE) this.advanceIf('craftAmmo');
  }

  /**
   * 장착이 바뀌었다.
   *   • `equipGun`(증축 트랙) — 만든 소총이 주무기 I · II 어느 쪽이든 들어오면 끝.
   *   • `corpseLoot`(레이드 트랙, 2026-09-14 2차) — **아무 주무기나** 들면 끝이다 (튜토리얼 레이드는 빈손으로
   *     시작하므로 그 총은 시체에서 꺼낸 것뿐이다 — def id 는 `world/tutorial` 이 정하므로 여기서 모른다).
   *     가방은 같은 단계의 **선택** 목표라 체크만 한다.
   */
  private onLoadout(): void {
    const l = this.ctx.inventory?.getLoadout();
    if (!l) return;
    if (this.step === 'corpseLoot') {
      if (l.bag) this.markObjective('corpseBag');
      if (l.primary || l.primary2) this.advance();
      return;
    }
    if (this.step !== 'equipGun') return;
    if (l.primary?.defId === TUTORIAL_GUN_DEF || l.primary2?.defId === TUTORIAL_GUN_DEF) this.advance();
  }

  /** 가방에 준중량탄이 들어왔는가 (+ `corpseLoot` 의 선택 목표 둘 — 탄약 · 회복). */
  private onInventory(): void {
    const inv = this.ctx.inventory;
    if (!inv) return;
    if (this.step === 'corpseLoot') {
      try {
        if (inv.countWhere((d) => d.category === 'ammo') > 0) this.markObjective('corpseAmmo');
        if (inv.countWhere((d) => d.category === 'stim') > 0) this.markObjective('corpseStim');
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
    if (this.ctx.missionMode === 'tutorial') { this.startRaidTrack(); this.refreshVisuals(); return; }
    if (!this.active || this.track !== 'build') return;
    if (this.step !== 'raid') this.setStep('raid');
    this.ctx.bus.emit('ui:notify', { text: '나침반의 탈출 마커를 따라가세요 — 튜토리얼 종료', kind: 'info', duration: 6 });
    window.setTimeout(() => { if (this.step === 'raid') this.finish(false); }, 6000);
  }

  /* ── 목표 줄 (2026-09-14 2차) ───────────────────────────────────────────
   * 목표 패널이 체크박스 목록이 됐다. **필수 목표는 단계가 넘어가는 순간 전부 달성**이고 (그 단계가 끝났다는
   * 것이 곧 그 뜻이다), **선택 목표는 여기 `markObjective` 로 하나씩** 켠다. 달성 애니메이션이 보이도록
   * 패널이 다음 단계의 목표 줄을 반 박자(`TUTORIAL_STEP_DELAY_S`) 붙잡는다 — 단계 기계는 안 기다린다. */

  /** 목표 하나를 달성 표시한다 (멱등). 지금 단계의 목표가 아니어도 기록은 해 둔다 — 그려질 때 켜진다. */
  markObjective(id: string): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    this.save.objectives = [...this.done];
    this.persist();
    this.refreshVisuals();
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
    const track = trackOf(step);
    const entry = this.save.tracks[track] ?? (this.save.tracks[track] = { step: null, done: false });
    const changed = entry.step !== step;
    entry.step = step;
    entry.done = false;
    // 처치 수 · 달성한 목표는 단계마다 따로 센다 (`shoot` → `crouchAim`)
    this.kills = 0;
    if (changed) { this.done.clear(); this.save.objectives = []; }
    // 배운 조작을 우측 가이드에 쌓는다 — **이 단계까지 전부**라, 체크포인트로 두세 단계를 건너뛰어도 빠지지 않는다
    this.learnControls(step);
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
    // 2026-09-14 2차 (사용자 결정): 체력이 이미 가득이면 회복 단계에 할 일이 없다 — `generator` 와 같은 요령이다
    else if (step === 'heal' && this.healthFull()) this.advance(true);
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

  /** 이 단계**까지**의 조작을 전부 가이드에 올린다 (멱등). `save.learned` 가 새로고침을 견딘다. */
  private learnControls(step: TutorialStepId): void {
    const order = TUTORIAL_TRACK_STEPS[trackOf(step)];
    const upto = order.indexOf(step);
    if (upto < 0) return;
    const learned = this.save.learned ?? (this.save.learned = []);
    for (let i = 0; i <= upto; i++) {
      for (const hint of TUTORIAL_CONTROL_HINTS[order[i]] ?? []) {
        if (!learned.includes(hint.id)) learned.push(hint.id);
        this.controls.add(hint);
      }
    }
  }

  /** 새로고침 복구 — 저장된 줄을 강조 없이 다시 세운다 (`init`). */
  private restoreControls(): void {
    const ids = this.save.learned;
    if (!ids || ids.length === 0) return;
    const hints: ControlHint[] = [];
    for (const list of Object.values(TUTORIAL_CONTROL_HINTS)) {
      for (const h of list ?? []) if (ids.includes(h.id)) hints.push(h);
    }
    this.controls.restore(hints);
  }

  private resetControls(): void {
    this.save.learned = [];
    this.controls.clear();
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
    const showable = this.ctx.isHubPhase() || this.ctx.isGameplayPhase();
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
    this.panel.show({
      track: TRACK_LABEL_KO[track],
      objectives: placing
        ? [{ id: step, text: '작업실 바닥을 클릭해 작업대를 내려놓습니다 (R 로 회전).' }]
        : this.objectivesFor(def),
      done: this.done,
      index: stepIndexOf(step), count: this.stepCount,
    });
    // 시작 카드가 떠 있는 동안에는 스포트라이트를 겹치지 않는다
    this.spotlight.set(this.popup.isOpen || placing ? [] : def.spot, def.spotText ?? def.hint,
      !!def.spotUnion, !!def.spotNoDim);
    this.guide.setTarget(this.guideTarget(def.guide));
  }

  /** 인벤토리 화면이 열리고 닫힌다 — 우측 조작 가이드가 그 뒤로 숨는다. */
  private setInventoryOpen(open: boolean): void {
    if (open === this.invOpen) return;
    this.invOpen = open;
    if (this.active) this.controls.show(!open);
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
      '언제든 좌측 상단의 건너뛰기로 그만둘 수 있습니다.',
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
