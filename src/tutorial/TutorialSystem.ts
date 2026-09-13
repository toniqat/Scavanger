import './tutorial.css';
import type { GameContext, GameSystem, TutorialGate, TutorialRef, TutorialSave, TutorialStepId } from '@/shared';
import { COCKPIT_DECOR_FURNITURE, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, SHIP_ROOM_COUNT, TUTORIAL_STEPS, slotKey } from '@/shared';
import {
  SKIP_HOLD_TIME, TUTORIAL_AMMO_DEF, TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_CRAFT_GRANT,
  TUTORIAL_GUN_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, TUTORIAL_SAVE_VERSION, TUTORIAL_STORAGE_KEY,
} from './model';
import { nextStep, normalizeStep, stepDef, stepIndexOf } from './Steps';
import * as Gates from './parts/Gates';
import { Guide } from './parts/Guide';
import { Spotlight } from './parts/Spotlight';
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

interface SaveV1 extends TutorialSave {
  /** `TUTORIAL_CRAFT_GRANT`(바닥)를 넣었다 — 한 번만. */
  granted?: boolean;
  benchUid?: string;
  /** `ensureMaterials` 가 돌았던 단계들 (2026-09-09). 기록일 뿐 — top-up 은 멱등이라 다시 들어오면 모자란 만큼만 또 준다. */
  topped?: TutorialStepId[];
}

const freshSave = (): SaveV1 => ({ version: TUTORIAL_SAVE_VERSION, step: null, done: false });

export class TutorialSystem implements GameSystem, TutorialRef {
  readonly name = 'tutorial';
  private ctx!: GameContext;
  private save: SaveV1 = freshSave();
  private unsubs: Array<() => void> = [];

  private panel!: TutorialPanel;
  private popup!: TutorialPopup;
  private spotlight!: Spotlight;
  private guide!: Guide;

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

    this.panel = new TutorialPanel(ctx.uiRoot, () => this.askSkip());
    this.popup = new TutorialPopup(ctx, () => { /* nothing to restore — the ship keeps running behind it */ });
    this.spotlight = new Spotlight(ctx.uiRoot);
    this.guide = new Guide(ctx);

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
      b.on('game:newMission', () => this.advanceIf('board')),
      b.on('world:ready', () => this.onRaid()),
    );
    this.registerConsole();
    this.refreshVisuals();
  }

  update(dt: number): void {
    if (!this.active) return;
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
    if (this.ctx) this.ctx.tutorial = null;
  }

  /* ── TutorialRef ───────────────────────────────────────────────────────── */

  get active(): boolean { return this.save.step !== null; }
  get step(): TutorialStepId | null { return this.save.step; }
  get stepIndex(): number { return stepIndexOf(this.save.step); }
  get stepCount(): number { return TUTORIAL_STEPS.length; }

  blockReason(gate: TutorialGate, id?: string): string | null {
    return Gates.blockReason(this.save.step, gate, id);
  }

  hides(gate: TutorialGate, id?: string): boolean { return Gates.hides(this.save.step, gate, id); }

  start(): boolean {
    if (this.active) return false;
    this.save = freshSave();
    this.setStep('intro');
    return true;
  }

  skip(): void {
    if (!this.active) return;
    this.finish(true);
  }

  goto(step: TutorialStepId): boolean {
    const target = normalizeStep(step);   // 순서에서 빠진 `openCraft` 는 `craftAmmo` 로
    if (!target) return false;
    this.save.done = false;
    this.setStep(target);
    return true;
  }

  /* ── step machine ──────────────────────────────────────────────────────── */

  /** 새 프로필이 개인 함선에 처음 들어왔다 → 자동 시작. 이미 진행 중이면 화면만 되살린다. */
  private onHubEntered(ship: string): void {
    if (ship !== 'personal') { this.refreshVisuals(); return; }
    if (this.save.step === 'bench' && this.benchStored()) { this.advance(); return; }   // 이미 만들어 둔 함선
    if (!this.save.done && this.save.step === null) {
      // 저장이 없다는 것만으로는 "새 캐릭터"가 아니다 — 튜토리얼이 없던 시절부터 하던 프로필도 같은 모양이다.
      // 이미 함선을 꾸며 놓았거나 레벨이 올라 있으면 조용히 끝난 것으로 표시하고 다시는 켜지 않는다.
      if (!this.looksFresh()) { this.save.done = true; this.persist(); this.refreshVisuals(); return; }
      this.setStep('intro');
    } else this.refreshVisuals();
  }

  /**
   * 손대지 않은 함선인가. 방 용도가 하나도 없고 · 놓인 가구가 없고 · 레벨이 1 이면 새 캐릭터로 본다
   * (기본 지급품만 있는 상태). 하나라도 어긋나면 이미 하던 프로필이다.
   */
  private looksFresh(): boolean {
    const h = this.ctx.housing;
    if (h) {
      try {
        // 2026-09-12: 조종석의 기본 공용 가구(시술대 · 컴퓨터)는 모든 함선에 늘 놓여 있다 — 그것만으로는 「꾸민 함선」이 아니다
        // 2026-09-13: 조종석 꾸밈 가구(침상 · 사물함 · 서랍장 — `COCKPIT_DECOR_FURNITURE`)도 새 함선에 처음부터 놓여 있다
        if (h.getPlaced().some((f) => !COCKPIT_DEFAULT_FURNITURE.some((d) => d.defId === f.defId)
          && !(f.room === COCKPIT_ROOM_INDEX && COCKPIT_DECOR_FURNITURE.some((d) => d.defId === f.defId)))) return false;
        for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (h.getRoom(i).purpose !== 'empty') return false;
      } catch { /* housing not ready — fall through to the level check */ }
    }
    const level = this.ctx.progression?.level ?? 1;
    return level <= 1;
  }

  private onManage(active: boolean): void {
    if (active) this.advanceIf('manage');
    else this.advanceIf('manageDone');
  }

  private onPurpose(room: number, purpose: string): void {
    if (purpose !== TUTORIAL_ROOM_PURPOSE) return;
    this.save.room = room;
    // 발전기 단계에서 곧바로 작업실이 세워졌다면(발전기가 이미 돌고 있던 함선) 그 단계는 지나간 것이다
    if (this.save.step === 'generator') this.setStep('workshop');
    this.advanceIf('workshop');
  }

  /** 발전기가 이미 Lv.1 이상인가 — `generator` 단계에 할 일이 남아 있는지의 판단. */
  private generatorReady(): boolean {
    try { return (this.ctx.housing?.getFacility('generator').level ?? 0) >= 1; } catch { return false; }
  }

  /** 가구 창고에 총기 작업대가 들어왔는가 — `bench`(제작) 는 여기서 끝나고 배치 단계로 넘어간다. */
  private onFurnitureCrafted(): void {
    if (this.save.step !== 'bench' || !this.benchStored()) return;
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
    if (this.save.step === 'benchPlace') this.refreshVisuals();
  }

  private onFurniture(defId: string, uid: string): void {
    if (defId !== TUTORIAL_BENCH_DEF) return;
    this.save.benchUid = uid;
    this.benchInteractable = `hub_furn_${uid}`;
    this.benchArmed = false;
    // 제작 이벤트를 놓쳤거나(저장 복구 · 콘솔) 곧바로 놓았다면 두 단계를 한 번에 지나간다
    if (this.save.step === 'bench') this.setStep('benchPlace');
    this.advanceIf('benchPlace');
  }

  /**
   * 가방 창이 열렸다. `openBag` 단계에서 **제작 열이 없는 채로** 열렸다면 그것으로 단계는 끝난 것이다
   * (저장 복구 · 창을 통째로 닫았다가 Tab 으로 다시 연 경우). 한 프레임 미루는 이유: `openBenchCraft` 는
   * `inventory:opened` 를 먼저 emit 하고 **그 다음에** `ui:craftToggled {open:true}` 를 보내므로,
   * 지금 자리에서 읽으면 작업대를 여는 순간마다 이 단계가 잘못 넘어간다.
   */
  private onInventoryOpened(): void {
    if (this.save.step !== 'openBag') return;
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

  /** 주무기 칸에 소총이 들어왔는가 — 주무기 I · II 어느 쪽이든 된다. */
  private onLoadout(): void {
    if (this.save.step !== 'equipGun') return;
    const l = this.ctx.inventory?.getLoadout();
    if (!l) return;
    if (l.primary?.defId === TUTORIAL_GUN_DEF || l.primary2?.defId === TUTORIAL_GUN_DEF) this.advance();
  }

  /** 가방에 준중량탄이 들어왔는가. */
  private onInventory(): void {
    if (this.save.step !== 'stowAmmo') return;
    const inv = this.ctx.inventory;
    if (!inv) return;
    let rounds = 0;
    try { rounds = inv.countWhere((d) => d.id === TUTORIAL_AMMO_DEF); } catch { rounds = 0; }
    if (rounds > 0) this.advance();
  }

  /** 레이드가 시작됐다 — 탈출 지점을 한 번 짚어 주고 끝낸다. */
  private onRaid(): void {
    if (!this.active) return;
    if (this.save.step !== 'raid') this.setStep('raid');
    this.ctx.bus.emit('ui:notify', { text: '나침반의 탈출 마커를 따라가세요 — 튜토리얼 종료', kind: 'info', duration: 6 });
    window.setTimeout(() => { if (this.save.step === 'raid') this.finish(false); }, 6000);
  }

  private advanceIf(step: TutorialStepId): void {
    if (this.save.step === step) this.advance();
  }

  private advance(): void {
    const cur = this.save.step;
    if (!cur) return;
    const next = nextStep(cur);
    if (!next) { this.finish(false); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.setStep(next);
  }

  private setStep(step: TutorialStepId): void {
    this.save.step = step;
    this.save.done = false;
    // 재료: 바닥(한 번) + 그 단계 레시피의 부족분 top-up (멱등). 탄약 재료는 소총이 완성되어 `craftAmmo` 에 들어서는
    //   바로 그 순간 채운다 — 소총이 먹은 폐금속을 그때 본다 (같은 작업대 창이 열린 채라 목록이 곧바로 만들 수 있는 상태가 된다).
    if (step === 'craftGun') { this.grantMaterials(); this.ensureMaterials(TUTORIAL_GUN_RECIPE, step); }
    else if (step === 'craftAmmo') this.ensureMaterials(TUTORIAL_AMMO_RECIPE, step);
    this.persist();
    this.refreshVisuals();
    this.ctx.bus.emit('tutorial:changed', { active: true, step, index: stepIndexOf(step), count: this.stepCount });
    if (step === 'intro') this.showIntro();
    // 이미 돌고 있는 발전기 · 이미 만들어 둔 작업대 앞에서 "만드세요"를 띄우지 않는다 (콘솔 `tutorial step`, 저장 복구)
    if (step === 'generator' && this.generatorReady()) this.advance();
    else if (step === 'bench' && this.benchStored()) this.advance();
  }

  private finish(skipped: boolean): void {
    this.save.step = null;
    this.save.done = true;
    this.persist();
    this.popup.close();
    this.refreshVisuals();
    this.ctx.bus.emit('tutorial:changed', { active: false, step: null, index: 0, count: this.stepCount });
    this.ctx.bus.emit('tutorial:finished', { skipped });
    this.ctx.bus.emit('ui:notify', {
      text: skipped ? '튜토리얼을 건너뛰었습니다' : '튜토리얼 완료 — 좋은 사냥 되세요',
      kind: skipped ? 'warning' : 'success', duration: 4,
    });
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
      return;
    }
    this.panel.setLifted(false);        // 다음 update 가 스포트라이트 상태를 보고 다시 정한다
    const step = this.save.step!;
    const def = stepDef(step);
    const showable = this.ctx.isHubPhase() || this.ctx.isGameplayPhase();
    if (!showable) {
      this.panel.hide();
      this.spotlight.set([], '');
      this.guide.setTarget(null);
      return;
    }
    // 가구를 집은 뒤에는 밝힐 UI 가 없다 — 남은 일은 3D 바닥을 클릭하는 것뿐이다
    const placing = step === 'benchPlace' && this.benchArmed;
    this.panel.show(placing ? { ...def, hint: '작업실 바닥을 클릭해 작업대를 내려놓습니다 (R 로 회전).' } : def,
      stepIndexOf(step), this.stepCount);
    // 시작 카드가 떠 있는 동안에는 스포트라이트를 겹치지 않는다
    this.spotlight.set(this.popup.isOpen || placing ? [] : def.spot, def.spotText ?? def.hint, !!def.spotUnion);
    this.guide.setTarget(this.guideTarget(def.guide));
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

  /** 건너뛰기 확인 — 모달리스 카드. 취소하면 하던 자리로 돌아간다. */
  private askSkip(): void {
    if (!this.active || this.confirmingSkip) return;
    this.confirmingSkip = true;
    // 2026-09-09: 본문 없음 — 제목과 버튼만. 건너뛰기는 빨간 **홀드 버튼**(`SKIP_HOLD_TIME`)이라 짧게 눌러서는 끝나지 않는다.
    this.popup.open('튜토리얼을 건너뛸까요?', [], [
      { label: '계속하기', onClick: () => { this.confirmingSkip = false; this.popup.close(); this.refreshVisuals(); } },
      { label: '건너뛰기', kind: 'danger', hold: SKIP_HOLD_TIME, onClick: () => { this.confirmingSkip = false; this.skip(); } },
    ]);
    this.refreshVisuals();
  }

  /* ── 저장 ──────────────────────────────────────────────────────────────── */

  private load(): SaveV1 {
    try {
      const raw = window.localStorage.getItem(slotKey(TUTORIAL_STORAGE_KEY));
      if (!raw) return freshSave();
      const doc = JSON.parse(raw) as Partial<SaveV1>;
      // 순서에서 빠진 단계(`openCraft`)로 저장된 진행은 그 자리를 이어받은 단계로 옮긴다 — 저장이 새 순서에서 막히지 않게
      const step = normalizeStep(doc.step);
      return {
        version: TUTORIAL_SAVE_VERSION,
        step: doc.done ? null : step,
        done: !!doc.done,
        room: typeof doc.room === 'number' ? doc.room : undefined,
        granted: !!doc.granted,
        benchUid: typeof doc.benchUid === 'string' ? doc.benchUid : undefined,
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
        usage: 'tutorial [start|skip|step <id>|status]',
        description: '튜토리얼 시작 / 건너뛰기 / 특정 단계로 이동',
        run: (args, _ctx, print) => {
          const sub = args[0] ?? 'status';
          if (sub === 'start') { print(this.start() ? '튜토리얼 시작' : '이미 진행 중입니다', 'info'); return; }
          if (sub === 'skip') { this.skip(); print('튜토리얼 종료', 'info'); return; }
          if (sub === 'step') {
            const id = args[1] as TutorialStepId | undefined;
            if (!id || !this.goto(id)) { print(`단계: ${TUTORIAL_STEPS.join(' ')}`, 'error'); return; }
            print(`→ ${id}`, 'success');
            return;
          }
          print(this.active ? `${this.save.step} (${this.stepIndex}/${this.stepCount})` : '비활성', 'info');
        },
      });
    } catch { /* console shape differs — the tutorial works without it */ }
  }
}
