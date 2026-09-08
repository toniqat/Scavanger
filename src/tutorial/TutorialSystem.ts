import './tutorial.css';
import type { GameContext, GameSystem, TutorialGate, TutorialRef, TutorialSave, TutorialStepId } from '@/shared';
import { SHIP_ROOM_COUNT, TUTORIAL_STEPS } from '@/shared';
import {
  TUTORIAL_AMMO_DEF, TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_CRAFT_GRANT,
  TUTORIAL_GUN_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, TUTORIAL_SAVE_VERSION, TUTORIAL_STORAGE_KEY,
} from './model';
import { nextStep, stepDef, stepIndexOf } from './Steps';
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
 * 들어설 때 `TUTORIAL_CRAFT_GRANT` 를 함선 창고에 한 번 넣어 준다 (튜토리얼당 한 번, 저장에 기록).
 * ──────────────────────────────────────────────────────────────────────────── */

interface SaveV1 extends TutorialSave { granted?: boolean; benchUid?: string }

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
      b.on('housing:furniturePlaced', ({ item }) => this.onFurniture(item.defId, item.uid)),

      b.on('craft:completed', ({ recipeId }) => this.onCrafted(recipeId)),
      b.on('loadout:changed', () => this.onLoadout()),
      b.on('inventory:changed', () => this.onInventory()),
      b.on('inventory:bagChanged', () => this.onInventory()),

      b.on('hub:terminalToggled', ({ open }) => { if (open) this.advanceIf('terminal'); }),
      b.on('hub:planetChanged', () => this.advanceIf('planet')),
      b.on('hub:travel', ({ stage }) => { if (stage === 'end') this.advanceIf('travel'); }),
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
    if (!TUTORIAL_STEPS.includes(step)) return false;
    this.save.done = false;
    this.setStep(step);
    return true;
  }

  /* ── step machine ──────────────────────────────────────────────────────── */

  /** 새 프로필이 개인 함선에 처음 들어왔다 → 자동 시작. 이미 진행 중이면 화면만 되살린다. */
  private onHubEntered(ship: string): void {
    if (ship !== 'personal') { this.refreshVisuals(); return; }
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
        if (h.getPlaced().length > 0) return false;
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

  private onFurniture(defId: string, uid: string): void {
    if (defId !== TUTORIAL_BENCH_DEF) return;
    this.save.benchUid = uid;
    this.benchInteractable = `hub_furn_${uid}`;
    this.advanceIf('bench');
  }

  private onCrafted(recipeId: string): void {
    if (recipeId === TUTORIAL_GUN_RECIPE) this.advanceIf('craftGun');
    else if (recipeId === TUTORIAL_AMMO_RECIPE) this.advanceIf('craftAmmo');
  }

  /** 주무기 칸에 소총이 들어왔는가. */
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
    if (step === 'craftGun') this.grantMaterials();
    this.persist();
    this.refreshVisuals();
    this.ctx.bus.emit('tutorial:changed', { active: true, step, index: stepIndexOf(step), count: this.stepCount });
    if (step === 'intro') this.showIntro();
    // 이미 돌고 있는 발전기 앞에서 "가동하세요"를 띄우지 않는다 (dev 콘솔 `tutorial step`, 저장 복구 등)
    if (step === 'generator' && this.generatorReady()) this.advance();
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
   * 제작 단계 진입 시 한 번. 함선 창고로 넣고(가득 찼으면 가방으로) 무엇이 들어갔는지 알려 준다.
   * 저장에 `granted` 를 남기므로 새로고침해도 두 번 주지 않는다.
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
      this.ctx.bus.emit('ui:notify', { text: '보급: 제작 재료가 함선 창고에 들어왔습니다', kind: 'success', duration: 4 });
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
    this.panel.show(def, stepIndexOf(step), this.stepCount);
    // 시작 카드가 떠 있는 동안에는 스포트라이트를 겹치지 않는다
    this.spotlight.set(this.popup.isOpen ? [] : def.spot, def.spotText ?? def.hint);
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
    this.popup.open('튜토리얼을 건너뛸까요?', [
      '남은 안내가 모두 사라지고 제한도 함께 풀립니다.',
      '개발자 콘솔의 `tutorial start` 로 다시 시작할 수 있습니다.',
    ], [
      { label: '계속하기', onClick: () => { this.confirmingSkip = false; this.popup.close(); this.refreshVisuals(); } },
      { label: '건너뛰기', kind: 'danger', onClick: () => { this.confirmingSkip = false; this.skip(); } },
    ]);
    this.refreshVisuals();
  }

  /* ── 저장 ──────────────────────────────────────────────────────────────── */

  private load(): SaveV1 {
    try {
      const raw = window.localStorage.getItem(TUTORIAL_STORAGE_KEY);
      if (!raw) return freshSave();
      const doc = JSON.parse(raw) as Partial<SaveV1>;
      const step = typeof doc.step === 'string' && TUTORIAL_STEPS.includes(doc.step as TutorialStepId)
        ? doc.step as TutorialStepId : null;
      return {
        version: TUTORIAL_SAVE_VERSION,
        step: doc.done ? null : step,
        done: !!doc.done,
        room: typeof doc.room === 'number' ? doc.room : undefined,
        granted: !!doc.granted,
        benchUid: typeof doc.benchUid === 'string' ? doc.benchUid : undefined,
      };
    } catch { return freshSave(); }
  }

  private persist(): void {
    try { window.localStorage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(this.save)); } catch { /* storage off */ }
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
