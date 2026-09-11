import '../styles/title.css';
import type { GameContext, SlotId } from '@/shared';
import { takeAutoStart, takeKeybindLoadReport } from '@/shared';
import { el, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { CharacterCreate } from './CharacterCreate';
import { CharacterSelect } from './CharacterSelect';
import { enterShip } from './enterShip';
import { KeybindNotice } from './keybindNotice';

/**
 * 타이틀 (2026-09-09 개편).
 *
 * 화면에는 **워드마크(위쪽 가운데)와 버튼 셋**뿐이다 — `게임 시작` / `설정` / `종료`.
 *
 *  - **콜사인 입력칸이 없다.** 이름은 이제 캐릭터가 갖는다 (생성창에서 정하고, 부팅 때 프로필에서
 *    `ctx.net.setPlayerName` 으로 흘러간다 — `progression/ProgressionSystem` 이 그 한 곳이다).
 *  - **조작 다이어그램(`menus/ControlsPanel`)과 `키 설정 변경` 이 설정 메뉴로 옮겨 갔다.** 설정의 `키 설정`
 *    구획이 이미 둘을 다 갖고 있으므로 (`menus/SettingsMenu.buildKeys`), 타이틀은 `설정` 버튼 하나만 준다.
 *  - **`새 캐릭터로 시작` 이 없다.** 그 일은 캐릭터 선택창에서 채워진 칸의 `삭제` 가 한다.
 *  - `게임 시작` → 캐릭터 선택(`menus/CharacterSelect`) → (빈 칸이면) 생성(`menus/CharacterCreate`).
 *
 * 두 하위 화면은 **자기 blocker 토큰을 갖지 않는다.** 이 메뉴(`MenuBase`)가 phase `menu` 동안 `'menu'` 토큰과
 * 커서 소유권을 계속 쥐고 있고, 둘은 그 위에 얹히는 화면이다 (`SettingsMenu` 와 같은 규칙).
 *
 * **부팅 자동 시작**: 슬롯을 바꾸면 언제나 `setActiveSlot` + `markAutoStart` + `location.reload()` 다 (시스템은
 * 부팅 때 한 번 저장소를 읽는다). 새로고침 뒤 타이틀과 캐릭터 선택을 건너뛰고 곧장 함선으로 들어가야 하므로
 * **`bind()` 에서 `takeAutoStart()` 를 한 번 읽는다** — 여기가 자리인 이유는 (a) 건너뛸 대상이 바로 이 화면이고,
 * (b) `bind` 는 부팅에 정확히 한 번 불리며, (c) phase `menu` 의 show/hide 를 이미 이 클래스가 쥐고 있어서 다른
 * 곳에서 읽으면 타이틀이 한 프레임 번쩍인다. `takeAutoStart()` 는 표시를 읽고 지우므로 나중에 일시정지 메뉴의
 * `타이틀로` 로 돌아오면 타이틀이 정상으로 뜬다.
 *
 * **옛 키 설정 알림** (2026-09-11, C-9 · X-8): 같은 자리에서 `takeKeybindLoadReport()` 도 한 번 읽는다 — 부팅에
 * 한 번뿐인 리포트이고 첫 화면이 여기라서다. 타이틀이 뜨면 `menus/keybindNotice` 카드가 워드마크 · 버튼 아래에,
 * 자동 시작이면 첫 `hub:entered` 에 토스트로 알린다.
 */
export class TitleMenu extends MenuBase {
  private readonly select: CharacterSelect;
  private readonly create: CharacterCreate;
  private readonly kbNotice: KeybindNotice;
  /** 이번 부팅이 타이틀을 건너뛰는가 (`takeAutoStart`); 한 번 쓰고 꺼진다. */
  private autoStart = false;

  /** `onKeySettings` = 설정을 `키 설정` 구획으로 연다 (알림 카드의 `키 설정 열기`); 없으면 `onSettings`. */
  constructor(parent: HTMLElement, private readonly onSettings: () => void, onKeySettings?: () => void) {
    super(parent, 'title home');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'wordmark', html: 'SCAV<span>A</span>NGER', parent: head });
    el('div', { cls: 'tagline', text: '강하 · 수집 · 탈출', parent: head });

    const actions = el('div', { cls: 'title-actions', parent: this.frame });
    this.button(actions, '게임 시작', () => this.startGame(), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.button(actions, '종료', () => this.quit(), 'quit');

    el('div', { cls: 'version', text: 'SCAVANGER · PROTOTYPE', parent: this.root });
    // 타이틀 root 안에 두어 타이틀과 함께 보이고 숨는다 (`.stacked` 에서도 같이 흐려진다 — title.css).
    this.kbNotice = new KeybindNotice(this.root, onKeySettings ?? (() => this.onSettings()));

    // 하위 화면은 타이틀 **다음에** DOM 에 붙으므로 자연히 그 위에 그려진다 (z-index 는 title.css 가 못 박는다).
    this.select = new CharacterSelect(parent, () => this.syncStacked(), (slot: SlotId) => this.openCreate(slot));
    this.create = new CharacterCreate(parent, () => { this.select.open(); this.syncStacked(); });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.select.bind(ctx);
    this.create.bind(ctx);
    // 슬롯 전환 직후의 부팅인가 — 표시는 여기서 정확히 한 번 소비된다.
    this.autoStart = takeAutoStart();
    // 옛 키 설정 리포트도 부팅에 한 번 — 알린 순간 `saveKeybinds()` 로 은퇴 줄을 지운다 (`menus/keybindNotice`).
    this.kbNotice.take(ctx, takeKeybindLoadReport(), this.autoStart);
    this.unsubs.push(
      ctx.bus.on('game:phaseChanged', () => this.refresh()),
    );
    if (this.autoStart) {
      // Engine 은 모든 시스템의 init() 을 한 번의 동기 패스로 돌린다 — 허브가 아직 `hub:enter` 를 구독하지
      // 않았을 수 있으므로 한 마이크로태스크 뒤로 미룬다 (`ProgressionSystem` 의 초기 방송과 같은 이유).
      queueMicrotask(() => {
        if (!this.autoStart || this.ctx !== ctx) return;
        this.autoStart = false;
        void enterShip(ctx);
      });
    }
    this.refresh();
  }

  /** 타이틀 본체 · 캐릭터 선택 · 생성 중 무엇을 보일지. */
  private refresh(): void {
    if (this.ctx.phase !== 'menu' || this.autoStart) {
      this.hide();
      this.select.close();
      this.create.close();
      return;
    }
    // 하위 화면이 떠 있으면 타이틀은 그 뒤에 그대로 남는다 (blocker 를 쥐고 있어야 한다).
    this.show();
    this.syncStacked();
  }

  /** 하위 화면이 떠 있는 동안 타이틀 본체는 눈에서만 지운다 (`hide()` 는 blocker 까지 놓아 버린다). */
  private syncStacked(): void {
    toggleClass(this.root, 'stacked', this.select.isOpen || this.create.isOpen);
  }

  /** 프레임마다 (HudSystem) — 생성창의 3D 미리보기만 돈다. 닫혀 있으면 즉시 돌아온다. */
  update(dt: number): void {
    this.create.update(dt);
    this.kbNotice.update(dt, this.visible && !this.select.isOpen && !this.create.isOpen);
  }

  /** 옛 키 설정 알림 (디버그 / 스모크): 부팅 리포트 · 사람이 읽는 줄 · 카드가 떠 있나. */
  get keybindNotice(): KeybindNotice { return this.kbNotice; }

  /** 캐릭터 선택창이 떠 있는가 (디버그 / 스모크). */
  get isSelectOpen(): boolean { return this.select.isOpen; }
  /** 캐릭터 생성창이 떠 있는가 (디버그 / 스모크). */
  get isCreateOpen(): boolean { return this.create.isOpen; }

  protected override onHide(): void {
    this.select.close();
    this.create.close();
    this.syncStacked();
  }

  private startGame(): void {
    this.select.open();
    this.syncStacked();
  }

  private openCreate(slot: SlotId): void {
    this.create.open(slot);
    this.syncStacked();
  }

  /**
   * 게임 종료. `menus/PauseMenu.quit()` 과 **같은 다섯 줄을 일부러 복제한다** — 타이틀이 일시정지 메뉴를
   * import 하면 두 화면이 서로 묶이고, 공유할 만큼 큰 코드도 아니다. `window.close()` 는 Electron 셸을 끝내고
   * (`electron/main.ts` 가 유일한 BrowserWindow 를 갖는다), 브라우저는 스스로 열지 않은 탭을 닫아 주지 않으므로
   * 한 틱 뒤에도 살아 있으면 그렇게 알린다. 여기는 이미 타이틀이라 돌아갈 화면은 없다.
   */
  private quit(): void {
    const ctx = this.ctx;
    try { window.close(); } catch (e) { console.error('[ui] window.close failed', e); }
    window.setTimeout(() => {
      if (window.closed) return;
      ctx.bus.emit('ui:notify', { text: '브라우저에서는 탭을 직접 닫아주세요', kind: 'warning', duration: 3.5 });
    }, 250);
  }

  override dispose(): void {
    this.kbNotice.dispose();
    this.create.dispose();
    this.select.dispose();
    super.dispose();
  }
}
