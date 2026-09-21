import '../styles/title.css';
import type { GameContext, RaidResumeOffer, SlotId } from '@/shared';
import { takeAutoStart, takeKeybindLoadReport } from '@/shared';
import { el, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { CharacterCreate } from './CharacterCreate';
import { CharacterSelect } from './CharacterSelect';
import { enterShip } from './enterShip';
import { KeybindNotice } from './keybindNotice';
import { AskPopup } from './askPopup';
import { buildRaidResumeCard } from './raidResumeCard';

/**
 * The title (2026-09-09 rework).
 *
 * The screen holds **the wordmark (top centre) and three buttons** only — `게임 시작` / `설정` / `종료`.
 *
 *  - **There is no callsign field.** The name belongs to the character now (decided in the creation screen, and at
 *    boot it flows from the profile into `ctx.net.setPlayerName` — `progression/ProgressionSystem` is that one place).
 *  - **The controls diagram (`menus/ControlsPanel`) and `키 설정 변경` moved into the settings menu.** The `키 설정`
 *    section of the settings already holds both (`menus/SettingsMenu.buildKeys`), so the title gives one `설정` button.
 *  - **There is no `새 캐릭터로 시작`.** That job belongs to `삭제` on a filled slot of the character select screen.
 *  - `게임 시작` → character select (`menus/CharacterSelect`) → (if the slot is empty) creation (`menus/CharacterCreate`).
 *
 * The two child screens **hold no blocker token of their own.** This menu (`MenuBase`) keeps holding the `'menu'`
 * token and the cursor ownership through phase `menu`, and both are screens laid on top of it (the `SettingsMenu` rule).
 *
 * **이어하기 · 레이드 포기** (2026-09-15, user's decision — `src/game/README.md` Decisions):
 * with a raid remaining (`ctx.raidResume.offer` — a solo save · tutorial · squad lobby) a filled-accent `이어하기` stands
 * **above** `게임 시작`, and `게임 시작` turns the red warning colour. That `게임 시작` opens only the **abandon popup**,
 * not character select — switching to another character also means not playing this raid any more. The popup
 * (`menus/askPopup` + `menus/raidResumeCard`) holds four participant portrait tiles · what is lost · the bottom-right
 * `[닫기] [레이드 포기 (1초 홀드)]`, and abandoning makes `이어하기` disappear and `게임 시작` return to its own colour
 * (`raid:resumeChanged`). A squad raid has to be asked of the server, so it can appear late — if character select or
 * creation is open then, they fold and the title comes back: the raid comes first.
 *
 * **Auto start on boot**: switching slot is always `setActiveSlot` + `markAutoStart` + `location.reload()` (the systems
 * read storage once at boot). After the reload the title and character select must be skipped and the ship entered
 * straight away, so **`bind()` reads `takeAutoStart()` once** — this is the place because (a) what is skipped is this
 * very screen, (b) `bind` is called exactly once per boot, and (c) this class already holds the show/hide of phase
 * `menu`, so reading it elsewhere makes the title flash for one frame. `takeAutoStart()` reads the mark and clears it,
 * so coming back later through the pause menu's `타이틀로` brings the title up normally. 2026-09-15: auto start
 * **stops at the title too when a raid remains**.
 *
 * **The old keybind notice** (2026-09-11, C-9 · X-8): `takeKeybindLoadReport()` is read once in the same place — it is
 * a report that exists once per boot and the first screen is here. If the title comes up, the `menus/keybindNotice`
 * card sits under the wordmark · buttons; on an auto start it is told by toast at the first `hub:entered`.
 */
export class TitleMenu extends MenuBase {
  private readonly select: CharacterSelect;
  private readonly create: CharacterCreate;
  private readonly kbNotice: KeybindNotice;
  /** 2026-09-15: `이어하기`, shown only with a raid to resume · `게임 시작`, red then · the abandon-raid popup. */
  private readonly resumeBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly ask: AskPopup;
  /** Does this boot skip the title (`takeAutoStart`); used once, then off. */
  private autoStart = false;

  /** `onKeySettings` = opens settings at the `키 설정` section (the notice card's `키 설정 열기`); with none, `onSettings`. */
  constructor(parent: HTMLElement, private readonly onSettings: () => void, onKeySettings?: () => void) {
    super(parent, 'title home');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'wordmark', html: 'SCAV<span>A</span>NGER', parent: head });
    el('div', { cls: 'tagline', text: '강하 · 수집 · 탈출', parent: head });

    const actions = el('div', { cls: 'title-actions', parent: this.frame });
    this.resumeBtn = this.button(actions, '이어하기', () => this.resumeRaid(), 'primary title-resume');
    this.resumeBtn.hidden = true;
    this.startBtn = this.button(actions, '게임 시작', () => this.startGame(), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.button(actions, '종료', () => this.quit(), 'quit');

    el('div', { cls: 'version', text: 'SCAVANGER · PROTOTYPE', parent: this.root });
    // Kept inside the title root so it shows and hides with the title (it dims along under `.stacked` — title.css).
    this.kbNotice = new KeybindNotice(this.root, onKeySettings ?? (() => this.onSettings()));

    // The child screens attach to the DOM **after** the title, so they draw over it naturally (title.css pins the z-index).
    this.select = new CharacterSelect(parent, () => this.syncStacked(), (slot: SlotId) => this.openCreate(slot));
    this.create = new CharacterCreate(parent, () => { this.select.open(); this.syncStacked(); });
    // The abandon popup is inside the title root — it hides with the title, and the Escape · Enter rules are `AskPopup`'s
    this.ask = new AskPopup(this.root);
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.select.bind(ctx);
    this.create.bind(ctx);
    this.ask.bind(ctx);
    // Is this the boot right after a slot switch — the mark is consumed here exactly once.
    this.autoStart = takeAutoStart();
    // The old keybind report is read once per boot too — the moment it is told, `saveKeybinds()` erases the retired
    // rows (`menus/keybindNotice`).
    this.kbNotice.take(ctx, takeKeybindLoadReport(), this.autoStart);
    this.unsubs.push(
      ctx.bus.on('game:phaseChanged', () => this.refresh()),
      ctx.bus.on('raid:resumeChanged', ({ offer }) => this.onResumeChanged(offer)),
    );
    if (this.autoStart) {
      // The Engine runs every system's init() in one synchronous pass — the hub may not have subscribed to
      // `hub:enter` yet, so this is deferred by one microtask (the same reason as `ProgressionSystem`'s initial
      // broadcast). `ctx.raidResume` only exists by then too (game/ is registered last).
      queueMicrotask(() => { void this.runAutoStart(ctx); });
    }
    this.refresh();
  }

  /**
   * 2026-09-15: auto start looks at a remaining raid first too — while a squad raid is being asked of the server it
   * waits for that answer (only when the marker exists), and with a raid it shows the title instead of the ship.
   */
  private async runAutoStart(ctx: GameContext): Promise<void> {
    if (!this.autoStart || this.ctx !== ctx) return;
    try { await ctx.raidResume?.settled(); } catch { /* not knowing, go in as before */ }
    if (!this.autoStart || this.ctx !== ctx) return;
    this.autoStart = false;
    if (ctx.phase !== 'menu') return;
    if (ctx.raidResume?.offer) { this.refresh(); return; }
    void enterShip(ctx);
  }

  /** Which of the title body · character select · creation to show. */
  private refresh(): void {
    if (this.ctx.phase !== 'menu' || this.autoStart) {
      this.hide();
      this.select.close();
      this.create.close();
      this.ask.close();
      return;
    }
    // While a child screen is up the title stays behind it (it has to keep holding the blocker).
    this.show();
    this.paintResume();
    this.syncStacked();
  }

  /** `이어하기` only with a raid, and `게임 시작` is the red warning colour then (`.title-resume` · `.title-warn`, `title.css`). */
  private paintResume(): void {
    const offer = this.ctx.raidResume?.offer ?? null;
    this.resumeBtn.hidden = !offer;
    toggleClass(this.startBtn, 'primary', !offer);
    toggleClass(this.startBtn, 'title-warn', !!offer);
  }

  private onResumeChanged(offer: RaidResumeOffer | null): void {
    // A raid confirmed late (a squad raid has to be asked of the server) — character select · creation fold and the
    // title comes back. The raid comes first.
    if (offer && (this.select.isOpen || this.create.isOpen)) { this.select.close(); this.create.close(); }
    // The raid the popup pointed at is gone (grace exceeded · the squad finished it) — nothing to abandon, so close
    if (!offer) this.ask.close();
    this.refresh();
  }

  /** While a child screen is up the title body is removed from sight only (`hide()` would release the blocker too). */
  private syncStacked(): void {
    toggleClass(this.root, 'stacked', this.select.isOpen || this.create.isOpen);
  }

  /** Every frame (HudSystem) — only the creation screen's 3D preview runs. While closed it returns immediately. */
  update(dt: number): void {
    this.create.update(dt);
    this.kbNotice.update(dt, this.visible && !this.select.isOpen && !this.create.isOpen);
  }

  /** The old keybind notice (debug / smoke): the boot report · the human-readable lines · is the card up. */
  get keybindNotice(): KeybindNotice { return this.kbNotice; }

  /** Is the character select screen up (debug / smoke). */
  get isSelectOpen(): boolean { return this.select.isOpen; }
  /** Is the character creation screen up (debug / smoke). */
  get isCreateOpen(): boolean { return this.create.isOpen; }
  /** 2026-09-15 (debug / smoke): is `이어하기` visible · is `게임 시작` the warning colour · is the abandon popup up · its hold progress. */
  get resumeView(): { resume: boolean; warn: boolean; ask: boolean; hold: number } {
    return {
      resume: this.visible && !this.resumeBtn.hidden, warn: this.startBtn.classList.contains('title-warn'),
      ask: this.ask.isOpen, hold: this.ask.holdProgress,
    };
  }

  protected override onHide(): void {
    this.select.close();
    this.create.close();
    this.ask.close();
    this.syncStacked();
  }

  private startGame(): void {
    const offer = this.ctx.raidResume?.offer ?? null;
    if (offer) { this.askAbandon(offer); return; }
    this.select.open();
    this.syncStacked();
  }

  /** `이어하기`. If a solo raid's grace just ran out, game/ settles it as failed and `raid:resumeChanged` drops the button. */
  private resumeRaid(): void {
    const rr = this.ctx.raidResume;
    if (!rr || !rr.resume()) this.refresh();
  }

  /** `게임 시작` pressed with a raid remaining — the participants · what is lost · `[닫기] [레이드 포기]` (abandon is a 1 s hold). */
  private askAbandon(offer: RaidResumeOffer): void {
    this.ask.open({
      title: offer.kind === 'tutorial' ? '진행 중인 튜토리얼' : '진행 중인 레이드',
      body: '',
      content: buildRaidResumeCard(this.ctx, offer),
      cardCls: 'trs-card',
      ok: '레이드 포기',
      cancel: '닫기',
      danger: true,
      run: () => this.ctx.raidResume?.abandon(),
    });
  }

  private openCreate(slot: SlotId): void {
    this.create.open(slot);
    this.syncStacked();
  }

  /**
   * 게임 종료. **The same body as `menus/PauseMenu.quit()`, duplicated on purpose** — importing the pause
   * menu into the title would tie the two screens together, and this is not enough code to be worth sharing.
   * `window.close()` ends the Electron shell (`electron/main.ts` owns the only BrowserWindow), and a browser will not
   * close a tab it did not open itself, so if it is still alive a tick later the player is told so. This is already
   * the title, so there is no screen to go back to (that is the one line the pause menu's copy adds).
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
    this.ask.dispose();
    this.create.dispose();
    this.select.dispose();
    super.dispose();
  }
}
