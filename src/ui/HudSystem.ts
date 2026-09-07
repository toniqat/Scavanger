import type { GameContext, GameSystem, LobbyState, RemotePlayerRef, SocialSnapshot, SquadInvite } from '@/shared';
import { el, toggleClass } from './dom';
import { Reticle } from './hud/Reticle';
import { Vitals } from './hud/Vitals';
import { WeaponPanel } from './hud/WeaponPanel';
import { Compass } from './hud/Compass';
import { WorldMarkers } from './hud/WorldMarkers';
import { Objective, OBJECTIVE_TEXT } from './hud/Objective';
import { InteractionPrompt } from './hud/InteractionPrompt';
import { Notifications } from './hud/Notifications';
import { DamageOverlay } from './hud/DamageOverlay';
import { DeployOverlay } from './hud/DeployOverlay';
import { ScopeOverlay } from './hud/ScopeOverlay';
import { Pings } from './hud/Pings';
import { Squad } from './hud/Squad';
import { Nameplates } from './hud/Nameplates';
import { SpectateOverlay } from './hud/SpectateOverlay';
import { ChatLog } from './hud/ChatLog';
import { QuickWheel } from './hud/QuickWheel';
import { CookGauge } from './hud/CookGauge';
import { HealGauge } from './hud/HealGauge';
import { HoldGauge } from './hud/HoldGauge';
import { ReloadGauge } from './hud/ReloadGauge';
import { StratagemWheel } from './hud/StratagemWheel';
import { StratagemPanel } from './hud/StratagemPanel';
import { ChargeGauge } from './hud/ChargeGauge';
import { TargetingHud } from './hud/TargetingHud';
import { OffscreenIndicators } from './hud/OffscreenIndicators';
import { ImplantWidget } from './hud/ImplantWidget';
import { ImplantChip } from './hud/ImplantChip';
import { QuickStrip } from './hud/QuickStrip';
import { Detection } from './hud/Detection';
import { ScanReveal } from './hud/ScanReveal';
import { Deployables } from './hud/Deployables';
import { ProgressToasts } from './hud/ProgressToasts';
import { ActionFeedback } from './hud/ActionFeedback';
import { WeaponChargeGauge } from './hud/WeaponChargeGauge';
import { StatusMarkers } from './hud/StatusMarkers';
import { CheatTag } from './hud/CheatTag';
import { HousingHint } from './hud/HousingHint';
import { ItemTip } from './hud/ItemTip';
import { GameCursor } from './hud/GameCursor';
import { ShipManage } from './hud/ShipManage';
import { ShipManageHint } from './hud/ShipManageHint';
import { Community } from './hud/Community';
import { setDebugSocial, debugSocialCalls } from './menus/social/socialSource';
import { RoomLabel } from './hud/RoomLabel';
import { ContractPanel } from './hud/ContractPanel';
import { TrainingPanel } from './hud/TrainingPanel';
import { MetaToasts } from './hud/MetaToasts';
import { MapScreen } from './map/MapScreen';
import { TitleMenu } from './menus/TitleMenu';
import { PauseMenu } from './menus/PauseMenu';
import { KeybindMenu } from './menus/KeybindMenu';
import { SettingsMenu } from './menus/SettingsMenu';
import { DeathScreen } from './menus/DeathScreen';
import { MissionComplete } from './menus/MissionComplete';
import type { RewardsBlock } from './menus/RewardsBlock';

/**
 * Arc Raiders-style HUD + menus. All DOM under `ctx.uiRoot`, in three `.hud` layers:
 *   - overlay (vignette, damage arcs, scope): gameplay + dead
 *   - gameplay HUD (reticle, vitals, weapon, compass, markers, objective (with the mission clock), pings, spectate banner):
 *     gameplay phases + `deploying`, hidden while a `'menu'` blocker is up or the player is dead in single-player
 *     (phase `dead` → `DeathScreen` with the respawn countdown)
 *   - social HUD (chat log, squad list, nameplates, notifications, interaction prompt): additionally visible in the
 *     ship hub (phases `hub` / `docking`). Both HUD layers carry `.hub` while in the hub.
 * Multiplayer: a dead local player keeps the HUD in a `.spectating` state (hides reticle, vitals, weapon, prompt);
 * `SpectateOverlay` carries the respawn countdown there.
 * Phase 2 additions in the gameplay layer: `QuickWheel` (F held) and `CookGauge` (grenade in hand).
 * Phase 3 (ship calls): `StratagemWheel` (G held), `StratagemPanel` (armed call / shared cooldown), `ChargeGauge` (LMB charge
 * ring), `TargetingHud` (toggles `.hud.targeting` on the gameplay root, which hides the reticle) and `OffscreenIndicators`
 * (edge arrows for grenades / squad pings / incoming calls).
 * Phase 6: `WeaponChargeGauge` (unique-weapon charge / spin-up / slash arc) and `StatusMarkers` (🔥 전소 / ⚡ world markers)
 * in the gameplay layer; `CheatTag` (`MOVE CHEAT`) and `RoomLabel` (`방 n · 용도`) in the social layer; `HousingHint` in its
 * own `.hud.housing` layer (placement hints while the ship housing mode is active).
 * Phase 5: `ContractPanel` (active corp contract under the objective) in the gameplay layer; `MetaToasts` (credits chip /
 * reputation level / contract settlement) share the `ProgressToasts` column in the social layer; quest / purchase / sale
 * lines go through `Notifications`; the result screens carry a `RewardsBlock`; the title menu a `Lv. n` chip.
 * Phase 8 (ship UX): `ShipManageHint` (bottom-right `함선 관리` + `Keys.MAP` keycap) in the social layer, `ShipManage`
 * (방 목록 + 가구 카드 바) in the `.hud.housing` layer, and the `SettingsMenu` overlay (키 설정 + 오디오) that the pause
 * menu's `설정` button opens; the pause menu itself gained 타이틀로 and hides 함선으로 귀환 in the ship.
 * Phase 10: two more crosshair rings in the gameplay layer — `ReloadGauge` (the reload radial moved off the bottom-right
 * weapon panel, and closes on the new `weapon:reloadCancelled`) and `HealGauge` (the 회복약's 2 s LMB hold); the
 * 2026-09-07 커서 rework replaced that sprite with `GameCursor`, which only injects the procedural `cursor:` art and
 * toggles `body.cursor-ui` (the real OS cursor is back, so there is nothing to draw per frame); the tactical map gets a `setPingPlacer` wired to
 * `Pings.placeAtWorld` so a middle-click on the map drops a squad ping.
 * Phase 11 (소셜): `Community` joins the social layer — the ship-only 커뮤니티 thumbnail, its panel (which reuses the
 * ESC screen's `menus/social/SocialColumn`) and the 분대 초대 stack with its `Keys.INVITE` hold; the pause menu's own
 * social column is built by `PauseMenu`, and `debugSocial(snapshot, invites)` fakes the mirror for the smoke.
 */
export class HudSystem implements GameSystem {
  readonly name = 'hud';
  private ctx!: GameContext;
  private hudRoot!: HTMLElement;
  private socialRoot!: HTMLElement;
  private overlayRoot!: HTMLElement;

  private reticle!: Reticle;
  private vitals!: Vitals;
  private weapon!: WeaponPanel;
  private compass!: Compass;
  private markers!: WorldMarkers;
  private pings!: Pings;
  private squad!: Squad;
  private nameplates!: Nameplates;
  private spectate!: SpectateOverlay;
  private chat!: ChatLog;
  private wheel!: QuickWheel;
  private cook!: CookGauge;
  /* Phase 10: two more crosshair rings — the reload radial moved off the weapon panel, the 회복약 is a 2 s hold */
  private reload!: ReloadGauge;
  private heal!: HealGauge;
  private hold!: HoldGauge;
  private swheel!: StratagemWheel;
  private strat!: StratagemPanel;
  private charge!: ChargeGauge;
  private targeting!: TargetingHud;
  private offscreen!: OffscreenIndicators;
  private objective!: Objective;
  private prompt!: InteractionPrompt;
  private notifs!: Notifications;
  private damage!: DamageOverlay;
  private scope!: ScopeOverlay;
  private deploy!: DeployOverlay;
  private map!: MapScreen;
  /* tactical kit */
  private implantWidget!: ImplantWidget;
  /* Phase 9 UI pass: right-hand column above the weapon panel — 임플란트 썸네일 over the 빠른 사용 썸네일 strip */
  private implantChip!: ImplantChip;
  private quickStrip!: QuickStrip;
  private detection!: Detection;
  private scanReveal!: ScanReveal;
  private deployables!: Deployables;
  private progressToasts!: ProgressToasts;
  private actionFx!: ActionFeedback;
  /* Phase 6 (dev console · unique weapons · ship housing) */
  private housingRoot!: HTMLElement;
  /** Bottom-left social column (chat log over the squad list), anchored above the vitals. */
  private bottomLeft!: HTMLElement;
  private wcharge!: WeaponChargeGauge;
  private statusMarkers!: StatusMarkers;
  private cheatTag!: CheatTag;
  private housingHint!: HousingHint;
  private roomLabel!: RoomLabel;
  /* Phase 8 (ship UX) */
  private shipManage!: ShipManage;
  private shipHint!: ShipManageHint;
  /* Phase 11: ship-only 커뮤니티 icon + 분대 초대 stack (social layer) */
  private community!: Community;
  private itemTip!: ItemTip;
  /* Phase 10: the software-cursor sprite (a direct child of `ctx.uiRoot`, like `itemTip`) */
  private gameCursor!: GameCursor;
  /* Phase 5 (corporations) */
  private contractPanel!: ContractPanel;
  /* Phase 9 (training modes) */
  private trainingPanel!: TrainingPanel;
  private metaToasts!: MetaToasts;

  private title!: TitleMenu;
  private pause!: PauseMenu;
  private death!: DeathScreen;
  private complete!: MissionComplete;
  private keybinds!: KeybindMenu;
  private settings!: SettingsMenu;

  private unsubs: Array<() => void> = [];
  private hudVisible = true;
  private socialVisible = true;
  private spectating = false;
  private inHub = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Layer order: full-screen overlays (vignette, scope) → gameplay HUD → social HUD → deploy overlay → map → menus.
    this.overlayRoot = el('div', { cls: 'hud', parent: ctx.uiRoot });
    this.damage = new DamageOverlay(this.overlayRoot);
    this.scope = new ScopeOverlay(this.overlayRoot);
    this.actionFx = new ActionFeedback(this.overlayRoot);

    this.hudRoot = el('div', { cls: 'hud gameplay', parent: ctx.uiRoot });
    this.markers = new WorldMarkers(this.hudRoot);
    this.pings = new Pings(this.hudRoot);
    this.offscreen = new OffscreenIndicators(this.hudRoot);
    this.reticle = new Reticle(this.hudRoot);
    this.cook = new CookGauge(this.hudRoot);
    this.reload = new ReloadGauge(this.hudRoot);
    this.heal = new HealGauge(this.hudRoot);
    this.hold = new HoldGauge(this.hudRoot);
    this.charge = new ChargeGauge(this.hudRoot);
    this.wcharge = new WeaponChargeGauge(this.hudRoot);
    this.statusMarkers = new StatusMarkers(this.hudRoot);
    this.targeting = new TargetingHud(this.hudRoot, (active) => toggleClass(this.hudRoot, 'targeting', active));
    this.wheel = new QuickWheel(this.hudRoot);
    this.swheel = new StratagemWheel(this.hudRoot);
    this.vitals = new Vitals(this.hudRoot);
    this.weapon = new WeaponPanel(this.hudRoot);
    // Both strips live **inside** the weapon panel so they stack on top of its slot strip and inherit its
    // right-bottom anchor, its fade and the `.hud.spectating` rule. `prepend` puts them above `.wslots`.
    this.implantChip = new ImplantChip(this.weapon.root);
    this.quickStrip = new QuickStrip(this.weapon.root);
    // The ship-call readout joins the same column (it used to be absolutely positioned at `bottom: 176px`, which the
    // two new strips now occupy) — `.strat-panel.off` is `display:none`, so it costs no height while idle.
    this.strat = new StratagemPanel(this.weapon.root);
    this.weapon.root.prepend(this.strat.root, this.implantChip.root, this.quickStrip.root);
    this.compass = new Compass(this.hudRoot);
    this.objective = new Objective(this.hudRoot);
    this.contractPanel = new ContractPanel(this.hudRoot);
    this.trainingPanel = new TrainingPanel(this.hudRoot);
    this.spectate = new SpectateOverlay(this.hudRoot);
    this.detection = new Detection(this.hudRoot);
    this.deployables = new Deployables(this.hudRoot);
    this.implantWidget = new ImplantWidget(this.hudRoot);
    this.scanReveal = new ScanReveal();

    this.socialRoot = el('div', { cls: 'hud social', parent: ctx.uiRoot });
    this.nameplates = new Nameplates(this.socialRoot);
    // Phase 9 UI pass: chat log + squad list share one bottom-left column that sits directly on top of the vitals,
    // so the squad health bars read next to the player's own instead of colliding with the contract panel top-left.
    this.bottomLeft = el('div', { cls: 'hud-bl', parent: this.socialRoot });
    this.chat = new ChatLog(this.bottomLeft);
    this.squad = new Squad(this.bottomLeft);
    this.prompt = new InteractionPrompt(this.socialRoot);
    this.notifs = new Notifications(this.socialRoot);
    this.progressToasts = new ProgressToasts(this.socialRoot);
    this.metaToasts = new MetaToasts(this.progressToasts.root);
    this.cheatTag = new CheatTag(this.socialRoot);
    this.roomLabel = new RoomLabel(this.socialRoot);
    this.shipHint = new ShipManageHint(this.socialRoot);
    // Phase 11: the 커뮤니티 thumbnail + 분대 초대 panels — ship only, self-gated on `ctx.isHubPhase()`.
    this.community = new Community(this.socialRoot);

    // Housing-mode layer: its own `.hud.housing` root (always attached; the hint bar toggles `.show` itself) so the
    // placement hints are visible in the ship where the gameplay HUD is hidden.
    this.housingRoot = el('div', { cls: 'hud housing', parent: ctx.uiRoot });
    this.housingHint = new HousingHint(this.housingRoot);
    // Phase 8: the 함선 관리 screen (방 목록 + 가구 카드 바) shares that layer so it survives the same gating.
    this.shipManage = new ShipManage(this.housingRoot);

    // 재료 요구 칩 hover card: a direct child of `#ui-root` so it floats over the inventory window, the 함선 관리
    // screen and every menu — it delegates on `.item-chip[data-def-id]` wherever a chip is rendered.
    this.itemTip = new ItemTip(ctx.uiRoot);
    // 인게임 마우스 커서 sprite: same placement rationale as the item card — over every window, layer and menu.
    this.gameCursor = new GameCursor();

    this.deploy = new DeployOverlay(ctx.uiRoot);
    this.map = new MapScreen(ctx.uiRoot);
    this.map.setPingSource(() => this.pings.getPings());
    // Phase 10: middle-click on the tactical map drops a squad ping at that world point.
    this.map.setPingPlacer((position, kind) => this.pings.placeAtWorld(position, kind));

    // Key-settings overlay sits above the title / pause / settings menus, which all open it.
    this.keybinds = new KeybindMenu(ctx.uiRoot);
    this.keybinds.bind(ctx);
    // 설정 (Phase 8): keys + audio, opened from the pause menu; it holds the one KeybindMenu instance.
    this.settings = new SettingsMenu(ctx.uiRoot, this.keybinds);
    this.settings.bind(ctx);
    this.title = new TitleMenu(ctx.uiRoot, () => this.keybinds.open());
    this.pause = new PauseMenu(ctx.uiRoot, () => this.settings.open());
    this.death = new DeathScreen(ctx.uiRoot);
    this.complete = new MissionComplete(ctx.uiRoot);

    for (const c of [this.reticle, this.cook, this.wheel, this.swheel, this.strat, this.charge, this.targeting, this.offscreen, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.chat, this.map]) c.bind(ctx);
    for (const c of [this.implantWidget, this.implantChip, this.quickStrip, this.detection, this.scanReveal, this.deployables, this.progressToasts, this.actionFx]) c.bind(ctx);
    for (const c of [this.wcharge, this.statusMarkers, this.cheatTag, this.housingHint, this.roomLabel, this.shipManage, this.shipHint, this.itemTip]) c.bind(ctx);
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor]) c.bind(ctx);
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.bind(ctx);
    this.community.bind(ctx);
    for (const m of [this.title, this.pause, this.death, this.complete]) m.bind(ctx);

    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', ({ phase }) => {
        this.deploy.setVisible(phase === 'deploying');
        switch (phase) {
          // Training arena (Phase 7): no extraction — the exit console ends it; world/ updates the subText counter.
          case 'playing': this.setObjective(ctx.missionMode === 'training' ? OBJECTIVE_TEXT.training : OBJECTIVE_TEXT.find); break;
          case 'extracting': this.setObjective(OBJECTIVE_TEXT.countdown); break;
          case 'shipLanded': this.setObjective(OBJECTIVE_TEXT.board); break;
          case 'liftoff': this.setObjective(OBJECTIVE_TEXT.liftoff); break;
          default: break;
        }
      }),
      b.on('extraction:boarded', () => { if (ctx.phase === 'shipLanded') this.setObjective(OBJECTIVE_TEXT.liftoffSwitch); }),
      b.on('extraction:tick', ({ remaining }) => {
        if (ctx.phase !== 'extracting') return;
        // Keep the objective in sync with the timer (cheap: text only changes once a second).
        const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60);
        this.objective.set(`함선 도착까지 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`, OBJECTIVE_TEXT.countdown.sub);
      }),
    );
    this.applyVisibility();
  }

  private setObjective(o: { text: string; sub: string }): void {
    this.ctx.bus.emit('ui:objective', { text: o.text, subText: o.sub });
  }

  update(dt: number, ctx: GameContext): void {
    this.applyVisibility();
    // Map polls M and draws itself while open (also handles its own blocker token).
    this.map.update(ctx);
    if (this.hudVisible) {
      this.reticle.update(dt, ctx);
      this.vitals.update(dt, ctx);
      this.reload.update(dt);
      this.strat.update(ctx);
      this.targeting.update(ctx);
      this.compass.update(ctx);
      this.objective.update(ctx);
      this.pings.update(dt, ctx);
      this.spectate.update(dt, ctx);
      this.implantWidget.update(dt, ctx);
      this.quickStrip.update();
    }
    if (this.socialVisible) {
      this.squad.update(dt, ctx);
      this.chat.update(dt);
      this.progressToasts.update(dt);
    }
    // Room label / contract pulse time themselves out on `ctx.time` regardless of layer visibility (one compare per frame);
    // meta toasts keep expiring behind a result screen so a stale chip never greets the hub.
    this.roomLabel.update(ctx);
    // 함선 관리 hint: two compares per frame, and it must survive a hidden social layer state change.
    this.shipHint.update(ctx);
    // 커뮤니티: same self-gating, plus the P-hold on a 분대 초대 (it needs dt).
    this.community.update(dt, ctx);
    this.contractPanel.update(ctx);
    this.trainingPanel.update(ctx);
    this.metaToasts.update(dt);
    // Self-gating components (they hide their own world meshes / markers outside gameplay).
    this.deployables.update(dt, ctx);
    this.actionFx.update(dt, ctx);
    this.scope.update(ctx);
    this.damage.update(dt, ctx);
    this.complete.update(dt);
    this.death.update(dt);
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    if (this.hudVisible) {
      this.markers.lateUpdate(ctx);
      this.pings.lateUpdate(ctx);
      this.offscreen.lateUpdate(ctx);
      this.statusMarkers.lateUpdate(ctx);
    }
    if (this.socialVisible) this.nameplates.lateUpdate(ctx);
    this.detection.lateUpdate(dt, ctx);
    this.scanReveal.lateUpdate(dt, ctx);
    this.deployables.lateUpdate(ctx);
  }

  /** Whether the tactical map is currently open (debug / other HUD parts). */
  get isMapOpen(): boolean { return this.map.isOpen; }
  /** Whether the chat input is open (debug). */
  get isChatOpen(): boolean { return this.chat.isOpen; }
  /** Whether the quick-use wheel is showing (debug). */
  get isWheelOpen(): boolean { return this.wheel.isOpen; }
  /** Whether the weapon panel is in consumable mode (debug). */
  get isConsumableMode(): boolean { return this.weapon.isConsumable; }
  /** Whether the ship-call wheel is showing (debug). */
  get isStratagemWheelOpen(): boolean { return this.swheel.isOpen; }
  /** Whether the targeting frame is up (debug). */
  get isTargeting(): boolean { return this.targeting.isActive; }
  /** Whether the key-settings overlay is open (debug). */
  get isKeybindsOpen(): boolean { return this.keybinds.isOpen; }
  /** Edge arrows currently visible (debug). */
  get offscreenCount(): number { return this.offscreen.visibleCount; }
  /** Unique-weapon charge gauge kind while showing, else null (debug). */
  get weaponChargeKind(): 'charge' | 'spinup' | 'slash' | null { return this.wcharge.activeKind; }
  /** Live 전소 / 감전 world markers (debug). */
  get statusMarkerCount(): number { return this.statusMarkers.activeCount; }
  /** Whether the weapon panel shows unique fire-mode lines (debug). */
  get hasWeaponModes(): boolean { return this.weapon.hasModes; }
  /** Whether the `MOVE CHEAT` tag is on (debug). */
  get isMoveCheatTagOn(): boolean { return this.cheatTag.isOn; }
  /** Whether the housing hint bar is showing (debug). */
  get isHousingHintOn(): boolean { return this.housingHint.isActive; }
  /** Whether the room label is up (debug). */
  get isRoomLabelOn(): boolean { return this.roomLabel.isShowing; }
  /** Whether the 설정 overlay is open / which of its three sections the right pane shows (debug). */
  get isSettingsOpen(): boolean { return this.settings.isOpen; }
  get settingsSection(): string { return this.settings.activeSection; }
  /** Whether the 함선 관리 screen is showing / which room it edits / how many furniture cards it renders (debug). */
  get isShipManageOn(): boolean { return this.shipManage.isShowing; }
  get shipManageRoom(): number | null { return this.shipManage.activeRoom; }
  get shipManageCardCount(): number { return this.shipManage.cardCount; }
  /** Def id the 재료 요구 칩 hover card is describing, null when it is hidden (debug). */
  get itemTipDefId(): string | null { return this.itemTip.shownDefId; }
  /** Whether the 함선 관리(M) hint is showing (debug). */
  get isShipHintOn(): boolean { return this.shipHint.isShowing; }
  /** Whether the pause menu is in its ship variant (debug). */
  get isPauseHubVariant(): boolean { return this.pause.isHubVariant; }
  /** Whether the contract panel is up / pulsing (debug). */
  get isContractPanelOn(): boolean { return this.contractPanel.isShowing; }
  get isContractPulsing(): boolean { return this.contractPanel.isPulsing; }
  /** Whether the 훈련장 panel is up / pulsing, and its shown mode (debug, Phase 9). */
  get isTrainingPanelOn(): boolean { return this.trainingPanel.isShowing; }
  get isTrainingPulsing(): boolean { return this.trainingPanel.isPulsing; }
  get trainingPanelMode(): string { return this.trainingPanel.shownMode; }
  /** Phase 10 crosshair rings + the software-cursor sprite (debug). */
  get isReloadGaugeOn(): boolean { return this.reload.isShowing; }
  get reloadProgress(): number { return this.reload.progress; }
  get isHealGaugeOn(): boolean { return this.heal.isShowing; }
  /** 2026-09-08 홀드 링 (상호작용 / 포기) — smoke hooks. */
  get isHoldGaugeOn(): boolean { return this.hold.isShowing; }
  get holdGaugeProgress(): number { return this.hold.progress; }
  get isHoldGaugeGiveUp(): boolean { return this.hold.isGiveUp; }
  get isGameCursorOn(): boolean { return this.gameCursor.isShowing; }
  /** Whether the vitals' 포기 bar is up (debug, Phase 9). */
  get isGiveUpBarOn(): boolean { return this.vitals.isGiveUpShowing; }
  /** Live meta toasts (debug). */
  get metaToastCount(): number { return this.metaToasts.liveCount; }
  /** Result-screen XP blocks (debug). */
  get completeRewards(): RewardsBlock { return this.complete.rewardsBlock; }
  get deathRewards(): RewardsBlock { return this.death.rewardsBlock; }
  /** Whether the death screen is in 레이드 실패 mode (debug). */
  get isRaidFailed(): boolean { return this.death.isRaidFailed; }
  /**
   * Smoke-test hook (Phase 7): feed synthetic remote refs (e.g. `remotePlayers.debugSpawn`, with `suspended` /
   * `inMission` flipped by the test) and a synthetic `LobbyState` to the nameplates and the squad panel without a
   * relay session. `debugRemotes(null)` clears both.
   */
  debugRemotes(refs: readonly RemotePlayerRef[] | null, lobby: LobbyState | null = null): void {
    this.nameplates.setDebugRefs(refs);
    this.squad.setDebug(lobby, refs ?? []);
  }

  /**
   * Smoke-test hook (Phase 11): install a synthetic `SocialSnapshot` (+ live squad invites) as `ctx.net.social` for
   * every ui component that reads the social mirror — the community thumbnail / panel and the invite stack. Same
   * shape as `debugRemotes`: `debugSocial(null)` hands the UI back to the real `ctx.net.social`, and
   * `debugSocial('offline')` forces the unavailable state even when a relay is connected.
   * `mySquad` is the member count of *my* lobby, which `playBlockReason` needs to judge 같이 하기.
   *
   * 2026-09-08: the ESC screen no longer carries a social column (social is the 커뮤니티 panel alone), so the
   * community panel is the only consumer left.
   */
  debugSocial(snapshot: SocialSnapshot | 'offline' | null, invites: readonly SquadInvite[] = [], mySquad = 1): void {
    setDebugSocial(snapshot, invites, mySquad);
    this.community.socialColumn.refresh(true);
  }

  /** Mutations the synthetic social ref received, newest last (debug; empty in a real session). */
  get debugSocialLog(): readonly { m: string; args: unknown[] }[] { return debugSocialCalls; }
  /** 커뮤니티 widget / panel / invite state (debug, Phase 11). */
  get isCommunityOn(): boolean { return this.community.isShowing; }
  get isCommunityOpen(): boolean { return this.community.isOpen; }
  get communityInviteCount(): number { return this.community.inviteCount; }
  get communityHoldProgress(): number { return this.community.holdProgress; }
  /** 귓속말 target of the chat input, null when it is ordinary squad chat (debug, Phase 11). */
  get chatWhisperTarget(): string | null { return this.chat.whisperTarget; }

  private applyVisibility(): void {
    const ctx = this.ctx;
    const inGame = ctx.isGameplayPhase() || ctx.phase === 'deploying';
    const inHub = ctx.phase === 'hub' || ctx.phase === 'docking';
    const menuOpen = ctx.uiBlockers.has('menu');
    const dead = ctx.player?.isDead ?? false;
    // Multiplayer keeps the HUD up for a dead (spectating) player; solo hides it (death screen follows).
    const spectating = dead && ctx.isMultiplayer;
    const alive = !dead || spectating;
    const visible = inGame && !menuOpen && alive;
    const social = (inGame || inHub) && !menuOpen && (alive || inHub);
    if (visible !== this.hudVisible) {
      this.hudVisible = visible;
      toggleClass(this.hudRoot, 'hidden', !visible);
    }
    if (social !== this.socialVisible) {
      this.socialVisible = social;
      toggleClass(this.socialRoot, 'hidden', !social);
    }
    if (spectating !== this.spectating) {
      this.spectating = spectating;
      toggleClass(this.hudRoot, 'spectating', spectating);
      toggleClass(this.socialRoot, 'spectating', spectating);
    }
    if (inHub !== this.inHub) {
      this.inHub = inHub;
      toggleClass(this.hudRoot, 'hub', inHub);
      toggleClass(this.socialRoot, 'hub', inHub);
    }
    const overlayVisible = inGame || ctx.phase === 'dead';
    toggleClass(this.overlayRoot, 'hidden', !overlayVisible);
    // Reticle hidden while inventory / any blocker is open (handled in Reticle.update via opacity).
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const c of [this.reticle, this.cook, this.wheel, this.swheel, this.strat, this.charge, this.targeting, this.offscreen, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.chat, this.deploy, this.map]) c.dispose();
    for (const c of [this.implantWidget, this.implantChip, this.quickStrip, this.detection, this.scanReveal, this.deployables, this.progressToasts, this.actionFx]) c.dispose();
    for (const c of [this.wcharge, this.statusMarkers, this.cheatTag, this.housingHint, this.roomLabel, this.shipManage, this.shipHint, this.itemTip]) c.dispose();
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor]) c.dispose();
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.dispose();
    this.community.dispose();
    for (const m of [this.title, this.pause, this.death, this.complete]) m.dispose();
    this.settings.dispose();
    this.keybinds.dispose();
    this.hudRoot.remove(); this.socialRoot.remove(); this.overlayRoot.remove(); this.housingRoot.remove();
  }
}
