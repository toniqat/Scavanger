import type { CharBuff, GameContext, GameSystem, KeybindLoadReport, KeyGuideEntry, LobbyState, PeerId, RemotePlayerRef, SocialSnapshot, SquadInvite } from '@/shared';
import { el, toggleClass } from './dom';
import { bindHudViewport } from './hud/viewport';
/* 2026-09-13 (extraction rework): how long the combat HUD takes to fade during the liftoff cinematic */
import { EXTRACTION_HUD_FADE_S } from '@/shared';
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
import { Pings, type PingView } from './hud/Pings';
import { Squad } from './hud/Squad';
import { Nameplates } from './hud/Nameplates';
import { TypingBubbles } from './hud/TypingBubbles';
import { SpectateOverlay } from './hud/SpectateOverlay';
import { ChatLog } from './hud/ChatLog';
import { QuickWheel } from './hud/QuickWheel';
import { CookGauge } from './hud/CookGauge';
import { HealGauge } from './hud/HealGauge';
import { HoldGauge } from './hud/HoldGauge';
import { ReloadGauge } from './hud/ReloadGauge';
import { StratagemWheel } from './hud/StratagemWheel';
import { CommsWheel } from './hud/CommsWheel';
import { HazardHud } from './hud/HazardHud';
/* 2026-09-12 (character buffs): the three env · meal · workout debuff badges became the `hud/BuffStrip` thumbnail row (inside Vitals · Squad) */
import type { BuffCellState } from './hud/BuffStrip';
import { RaidAlerts } from './hud/RaidAlerts';
import { StratagemPanel } from './hud/StratagemPanel';
import { RescuePicker } from './hud/RescuePicker';
import { ChargeGauge } from './hud/ChargeGauge';
import { TargetingHud } from './hud/TargetingHud';
import { OffscreenIndicators } from './hud/OffscreenIndicators';
import { ImplantWidget } from './hud/ImplantWidget';
import { QuickStrip } from './hud/QuickStrip';
import { Detection } from './hud/Detection';
import { ScanReveal } from './hud/ScanReveal';
import { ScanTracker } from './hud/ScanTracker';
import { CutsceneWatch } from './hud/CutsceneWatch';
import { HubDot } from './hud/HubDot';
import { DangerIndicators } from './hud/DangerIndicators';
import { FallVignette } from './hud/FallVignette';
import { Deployables } from './hud/Deployables';
import { ProgressToasts } from './hud/ProgressToasts';
import { ActionFeedback } from './hud/ActionFeedback';
import { WeaponChargeGauge } from './hud/WeaponChargeGauge';
import { StatusMarkers } from './hud/StatusMarkers';
import { CheatTag } from './hud/CheatTag';
import { KeyGuide } from './hud/KeyGuide';
import { ItemTip } from './hud/ItemTip';
import { MusicPlayer } from './hud/MusicPlayer';               // the music player window (2026-09-14)
import { ItemFavoriteMenu } from './hud/ItemFavoriteMenu';
import { GameCursor } from './hud/GameCursor';
import { ShipManage } from './hud/ShipManage';
import { CursorHoldGauge } from './hud/CursorHoldGauge';
import { ShipManageHint } from './hud/ShipManageHint';
import { Community } from './hud/Community';
import { setDebugSocial, setDebugSocialRef, debugSocialCalls } from './menus/social/socialSource';
/* 2026-09-14: the messenger — smoke hooks for the NPC · group-room sources */
import type { NpcQuestRef, RoomsRef } from '@/shared';
import { setDebugNpc, setDebugRooms } from './menus/messenger/sources';
import type { Messenger } from './menus/messenger/Messenger';
import type { SocialRef, WhisperLine } from '@/shared';
import { RoomLabel } from './hud/RoomLabel';
import { ContractPanel } from './hud/ContractPanel';
import { TrainingPanel } from './hud/TrainingPanel';
import { MetaToasts } from './hud/MetaToasts';
/* 2026-09-11: drone-control HUD · Roden scan warning · held-gadget hint (place · detonate · drone control) */
import { DroneHud } from './hud/DroneHud';
import { RoverHud } from './hud/RoverHud';
import { NamedScanWarning } from './hud/NamedScanWarning';
import { GadgetHandHint } from './hud/GadgetHandHint';
/* 2026-09-11 (B-1): the server link badge (top right of the ship · title) */
import { NetBadge } from './hud/NetBadge';
/* 2026-09-15 (raid-entry loading): the bottom-right radial gauge that spins over the black plate */
import { LoadingGauge } from './hud/LoadingGauge';
import { ShipReturn } from './menus/ShipReturn';
/* 2026-09-15 (android squadmates): the one place ui reads `ctx.allies` (a smoke test plugs a fake ref in) */
import type { AlliesRef } from '@/shared';
import { setDebugAllies } from './hud/allySource';
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
 * (edge arrows for squad pings / rogue drops — 2026-09-10: grenades and drops moved to `DangerIndicators`).
 * 2026-09-10 (danger indicators): `DangerIndicators` took over from `ShellMarkers` and draws artillery shells ·
 * grenades · ship-call drops in one language (on screen = a head marker, off screen = a direction arc around the
 * crosshair); the tactical implant readout merged into `ImplantWidget` alone, down at the **bottom centre · under the
 * stamina bar** (`ImplantChip` deleted).
 * Phase 6: `WeaponChargeGauge` (unique-weapon charge / spin-up / slash arc) and `StatusMarkers` (🔥 incinerated / ⚡ world markers)
 * in the gameplay layer; `CheatTag` (`MOVE CHEAT`) and `RoomLabel` (`방 n · 용도`) in the social layer; the `.hud.housing`
 * layer (2026-09-09: `HousingHint` is gone — hub/HousingMode emits `ui:keyGuide` and the `KeyGuide` draws it).
 * 2026-09-09: `KeyGuide` (`.key-guide`, bottom-right one-liner `R 회전 · X 버리기 · Tab 닫기` for the topmost open
 * screen, fed by `ui:keyGuide`) is a direct child of `ctx.uiRoot` like `ItemTip`, so it floats over every window in
 * both hub and gameplay phases; `keyGuide.update()` polls the `'menu'` blocker each frame.
 * Phase 5: `ContractPanel` (active corp contract under the objective) in the gameplay layer; `MetaToasts` (credits chip /
 * reputation level / contract settlement) share the `ProgressToasts` column in the social layer; quest / purchase / sale
 * lines go through `Notifications`; the result screens carry a `RewardsBlock`; the title menu a `Lv. n` chip.
 * Phase 8 (ship UX): `ShipManageHint` (bottom-right `함선 관리` + `Keys.MAP` keycap) in the social layer, `ShipManage`
 * (the room list + furniture card bar) in the `.hud.housing` layer, and the `SettingsMenu` overlay (keys + audio) that
 * the pause menu's `설정` button opens; the pause menu itself gained `타이틀로` and hides `함선으로 귀환` in the ship.
 * Phase 10: two more crosshair rings in the gameplay layer — `ReloadGauge` (the reload radial moved off the bottom-right
 * weapon panel, and closes on the new `weapon:reloadCancelled`) and `HealGauge` (the `회복약`'s 2 s LMB hold); the
 * 2026-09-07 cursor rework replaced that sprite with `GameCursor`, which only injects the procedural `cursor:` art and
 * toggles `body.cursor-ui` (the real OS cursor is back, so there is nothing to draw per frame); the tactical map gets a `setPingPlacer` wired to
 * `Pings.placeAtWorld` so a middle-click on the map drops a squad ping.
 * 2026-09-09 (the ship crosshair): `HubDot` (`.hub-dot`, the ship's centre dot) joins the social layer and `HoldGauge`
 * **moves** there from the gameplay layer, so the `발사 포드 탑승` hold fills a ring around that dot in the hub while the
 * gameplay behaviour is unchanged (the social layer is up in every phase the gameplay layer is).
 * Phase 11 (social): `Community` joins the social layer — the ship-only `커뮤니티` thumbnail, its panel (which reuses
 * the ESC screen's `menus/social/SocialColumn`) and the `분대 초대` stack with its `Keys.INVITE` hold; the pause menu's own
 * social column is built by `PauseMenu`, and `debugSocial(snapshot, invites)` fakes the mirror for the smoke.
 * 2026-09-12 (character buffs, user's decision): the **vitals block moved to the social layer** (like `HoldGauge` did) so the PC
 * name · shield · hp show in the ship too; only its stamina bar stays in the gameplay layer (raid-only). Under the hp bar
 * sits the local `BuffStrip`, and every squadmate row in `Squad` carries a mini one. The three text badges that used to
 * say the same things — `EnvBadge` · `MealBadge` (top-left `.hud-badges` row, raid) and `GymFatigueBadge` (ship) — are gone.
 */
export class HudSystem implements GameSystem {
  readonly name = 'hud';
  private ctx!: GameContext;
  private hudRoot!: HTMLElement;
  private socialRoot!: HTMLElement;
  private overlayRoot!: HTMLElement;
  /** 2026-09-14: the full-screen black fade (`ui:screenFade`) — a presentation-only plate, not a blocker. */
  private screenFade!: HTMLElement;
  private fadeOpacity = 0;
  /** 2026-09-15 (B-14): the red fall vignette (`player:fell`) — a direct child of `#ui-root` at z 25, presentation only. */
  private fallVignette!: FallVignette;
  /** 2026-09-15: the raid-entry loading gauge — a direct child of `#ui-root` at z 87 (it spins over the black fade at 82). */
  private loadingGauge!: LoadingGauge;
  /** 2026-09-16: the result screen → ship return fade to black (`ui:shipReturn`, `menus/ShipReturn`). */
  private shipReturn!: ShipReturn;
  /** 2026-09-14: the opacity painted on the plate now · the transition's start value · elapsed · length — `update` moves it, not a CSS transition. */
  private fadeShown = 0;
  private fadeFrom = 0;
  private fadeT = 0;
  private fadeDur = 0;
  /**
   * 2026-09-15 (`ui:screenFade.hold`): this plate **does not clear itself when the phase changes** — the tutorial raid
   * skip raises it for 「암전된 채로 결과 화면」. The side that raised it clears it with `{opacity: 0}`, and
   * `game:abort` · `hub:entered` clear it unconditionally here (no path leaves the ship black).
   */
  private fadeHold = false;

  private reticle!: Reticle;
  private vitals!: Vitals;
  private weapon!: WeaponPanel;
  private compass!: Compass;
  private markers!: WorldMarkers;
  private pings!: Pings;
  private squad!: Squad;
  private nameplates!: Nameplates;
  /** 2026-09-09: the typing speech bubble — a remote player whose snapshot carries `PlayerFlags.TYPING`. */
  private typing!: TypingBubbles;
  private spectate!: SpectateOverlay;
  private chat!: ChatLog;
  private wheel!: QuickWheel;
  private cook!: CookGauge;
  /* Phase 10: two more crosshair rings — the reload radial moved off the weapon panel, the `회복약` is a 2 s hold */
  private reload!: ReloadGauge;
  private heal!: HealGauge;
  /** 2026-09-09: lives in the **social** layer so the `발사 포드 탑승` hold fills a ring in the ship too (see `init`). */
  private hold!: HoldGauge;
  /** 2026-09-09: the in-ship dot crosshair — the social layer's centre dot for the hub phases. */
  private hubDot!: HubDot;
  /**
   * Danger indicators (2026-09-10): artillery shells · grenades · ship-call drops as a head marker while on screen,
   * as a direction arc around the crosshair while off it. It absorbed 2026-09-09's `hud/ShellMarkers`.
   */
  private danger!: DangerIndicators;
  private swheel!: StratagemWheel;
  /** 2026-09-09: the H-hold communication wheel — the only wheel that reads its own input too (it has no owning system folder). */
  private comms!: CommsWheel;
  /** 2026-09-09: the environmental hazard warning (banner · safe-zone gauge · screen edge). */
  private hazard!: HazardHud;
  /** 2026-09-09: new-landmark and raider-drop (formerly rogue-drop) warning toasts (no DOM — they go out through `ui:notify` only). */
  private raidAlerts = new RaidAlerts();
  private strat!: StratagemPanel;
  /** 2026-09-09: the rescue-drop target picker screen (it reads `ctx.stratagems` and shows itself). */
  private rescuePick!: RescuePicker;
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
  /* tactical kit — 2026-09-10: the implant readout is one bottom-centre thumbnail (the implant chip is gone with it) */
  private implantWidget!: ImplantWidget;
  /* 2026-09-11: drone-control HUD · Roden scan warning · held-gadget hint */
  private droneHud!: DroneHud;
  /** 2026-09-13: the rover riding HUD. */
  private roverHud!: RoverHud;
  private scanWarning!: NamedScanWarning;
  private handHint!: GadgetHandHint;
  /* Phase 9 UI pass: right-hand column above the weapon panel — the quick-use thumbnail strip */
  private quickStrip!: QuickStrip;
  private detection!: Detection;
  private scanReveal!: ScanReveal;
  /** Phase 12: recon reveals shared by the compass ticks and the detection arrows / chevrons. */
  private scanTracker = new ScanTracker();
  /** Phase 12: docking / warp cutscene flag + ship kind for the ship-only corner widgets. */
  private cutscene = new CutsceneWatch();
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
  private keyGuide!: KeyGuide;
  private roomLabel!: RoomLabel;
  /* Phase 8 (ship UX) */
  private shipManage!: ShipManage;
  /** 2026-09-12: the ship management furniture hold gauge (`housing:moveHold`, centred on the cursor). */
  private cursorHold!: CursorHoldGauge;
  private shipHint!: ShipManageHint;
  /* Phase 11: ship-only `커뮤니티` icon + `분대 초대` stack (social layer) */
  private community!: Community;
  /* B-1 (2026-09-11): the server link badge (a direct child of #ui-root, ship · title) */
  private netBadge!: NetBadge;
  private itemTip!: ItemTip;
  /* 2026-09-14: the music player window (a direct child of #ui-root, ship top-left — drawn from `housing:musicChanged` alone) */
  private musicPlayer!: MusicPlayer;
  /* 2026-09-12 (E2): the favorite right-click menu for chips · opted-in tiles (direct child of `ctx.uiRoot`, like `itemTip`) */
  private itemFavMenu!: ItemFavoriteMenu;
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
  /** 2026-09-13: the departure cinematic owns the screen (`ui:cinematic`) — combat HUD faded out (`styles/raidHud.css`). */
  private cinematic = false;
  /**
   * 2026-09-16 (user's decision — the liftoff cinematic hides **all the remaining HUD**): how much is hidden, 0 (all shown) … 1 (all hidden).
   * `update` raises it over `EXTRACTION_HUD_FADE_S` and paints it as `#ui-root`'s `--cine-o` (the `setCinematic` comment).
   */
  private cineHide = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // The screen size every projecting widget reads — measured here and on `resize`, never inside a frame (`hud/viewport.ts`).
    this.unsubs.push(bindHudViewport(ctx.uiRoot));
    // Layer order: full-screen overlays (vignette, scope) → gameplay HUD → social HUD → deploy overlay → map → menus.
    this.overlayRoot = el('div', { cls: 'hud', parent: ctx.uiRoot });
    this.damage = new DamageOverlay(this.overlayRoot);
    this.scope = new ScopeOverlay(this.overlayRoot);
    this.actionFx = new ActionFeedback(this.overlayRoot);

    this.hudRoot = el('div', { cls: 'hud gameplay', parent: ctx.uiRoot });
    this.markers = new WorldMarkers(this.hudRoot);
    this.pings = new Pings(this.hudRoot);
    this.offscreen = new OffscreenIndicators(this.hudRoot);
    this.danger = new DangerIndicators(this.hudRoot);
    this.reticle = new Reticle(this.hudRoot);
    this.cook = new CookGauge(this.hudRoot);
    this.reload = new ReloadGauge(this.hudRoot);
    this.heal = new HealGauge(this.hudRoot);
    this.charge = new ChargeGauge(this.hudRoot);
    this.wcharge = new WeaponChargeGauge(this.hudRoot);
    this.statusMarkers = new StatusMarkers(this.hudRoot);
    this.targeting = new TargetingHud(this.hudRoot, (active) => toggleClass(this.hudRoot, 'targeting', active));
    this.wheel = new QuickWheel(this.hudRoot);
    this.swheel = new StratagemWheel(this.hudRoot);
    // 2026-09-09: the third wheel. Same layer and same nature as its siblings (`pointer-events:none`, no blocker).
    this.comms = new CommsWheel(this.hudRoot);
    // Environmental hazards: banner · gauge in the gameplay layer, the edge pulse in the overlay layer with the vignette.
    this.hazard = new HazardHud(this.hudRoot, this.overlayRoot);
    // 2026-09-12: the stamina bar is created here (gameplay layer, raid-only, same DOM slot as before); the name · shield · hp
    // block stays detached until the social layer exists and is mounted there below, so it also shows in the ship.
    this.vitals = new Vitals(this.hudRoot, null);
    this.weapon = new WeaponPanel(this.hudRoot);
    // The strip lives **inside** the weapon panel so it stacks on top of the gun box and inherits its
    // right-bottom anchor, its fade and the `.hud.spectating` rule. `prepend` puts it first in the panel.
    // (2026-09-11, C-26: the `.wslots` slot strip it once sat above is gone, and so is `hud/SlotStrip.ts`.)
    // (2026-09-10: the implant chip that used to sit above it is gone — `ImplantWidget` is the one implant
    //  readout now, at the bottom centre under the stamina bar.)
    this.quickStrip = new QuickStrip(this.weapon.root);
    this.weapon.root.prepend(this.quickStrip.root);
    this.compass = new Compass(this.hudRoot, this.scanTracker);
    this.objective = new Objective(this.hudRoot);
    this.contractPanel = new ContractPanel(this.hudRoot);
    this.trainingPanel = new TrainingPanel(this.hudRoot);
    this.spectate = new SpectateOverlay(this.hudRoot);
    this.detection = new Detection(this.hudRoot, this.scanTracker);
    this.deployables = new Deployables(this.hudRoot);
    this.implantWidget = new ImplantWidget(this.hudRoot);
    // 2026-09-11: drone-control HUD · Roden scan warning · held-gadget hint — each shows itself on its own condition.
    this.droneHud = new DroneHud(this.hudRoot);
    // 2026-09-13: the rover riding HUD — it shows only while riding and raises `rover-view` on the gameplay layer.
    this.roverHud = new RoverHud(this.hudRoot);
    this.scanWarning = new NamedScanWarning(this.hudRoot);
    this.handHint = new GadgetHandHint(this.hudRoot);
    // 2026-09-10 (2nd pass, user's decision): the ship call is no longer a text panel in the bottom-right weapon column
    // but **a square thumbnail immediately left of the implant** — so it left that column and stands here, on the same
    // bottom-centre row (its position comes from `styles/shipCall.css` via `implant.css`'s `:root` geometry variables).
    this.strat = new StratagemPanel(this.hudRoot);
    this.scanReveal = new ScanReveal();

    this.socialRoot = el('div', { cls: 'hud social', parent: ctx.uiRoot });
    this.nameplates = new Nameplates(this.socialRoot);
    this.typing = new TypingBubbles(this.socialRoot);
    // Phase 9 UI pass: chat log + squad list share one bottom-left column that sits directly on top of the vitals,
    // so the squad health bars read next to the player's own instead of colliding with the contract panel top-left.
    this.bottomLeft = el('div', { cls: 'hud-bl', parent: this.socialRoot });
    this.chat = new ChatLog(this.bottomLeft);
    this.squad = new Squad(this.bottomLeft);
    // 2026-09-12 (character buffs): the PC vitals block — it is in the social layer, so it shows in the ship too (`.hud-bl` always sits on top of it, from base.css).
    // Raid visibility is unchanged: in gameplay phases this layer follows the gameplay one (menu / solo death), and the
    // `.hud.spectating .vitals` rule applies here too. The drone-view shrink moved to a sibling selector in `styles/drone.css`.
    this.socialRoot.appendChild(this.vitals.root);
    this.prompt = new InteractionPrompt(this.socialRoot);
    // 2026-09-09: the hold ring moved from the gameplay layer to this one — the social layer is the one that stays up in
    // the ship, and the `발사 포드 탑승` (0.4 s hold) had no ring there. One instance serves both phases; the
    // `.hud.spectating .hold` rule still applies because this root carries `.spectating` too.
    this.hold = new HoldGauge(this.socialRoot);
    // 2026-09-09: the in-ship dot crosshair — the gameplay reticle is hidden in the hub, so the ship gets its own centre dot
    // (self-gated: phase `hub`, no blocker, no docking / warp cutscene). The hold ring above sits around it.
    this.hubDot = new HubDot(this.socialRoot, this.cutscene);
    this.notifs = new Notifications(this.socialRoot);
    this.progressToasts = new ProgressToasts(this.socialRoot);
    this.metaToasts = new MetaToasts(this.progressToasts.root);
    this.cheatTag = new CheatTag(this.socialRoot);
    this.roomLabel = new RoomLabel(this.socialRoot);
    // Phase 12: both corner widgets hide during a docking / warp cutscene; the hint is personal-ship only.
    this.shipHint = new ShipManageHint(this.socialRoot, this.cutscene);
    // Phase 11: the `커뮤니티` thumbnail + `분대 초대` panels — ship only, self-gated on `ctx.isHubPhase()`.
    // 2026-09-16: it stands over the pause menu too — only while that menu is up by itself (no settings overlay · warning popup above it). Read late.
    this.community = new Community(this.socialRoot, this.cutscene,
      () => !!this.pause?.visible && !this.pause.isAskOpen && !(this.settings?.isOpen ?? false));

    // Housing layer: its own `.hud.housing` root (always attached) so the ship management screen is visible in the ship where
    // the gameplay HUD is hidden. (The housing hint bar that used to live here was replaced by `KeyGuide`, 2026-09-09.)
    this.housingRoot = el('div', { cls: 'hud housing', parent: ctx.uiRoot });
    // Phase 8: the `함선 관리` screen (the room list + furniture card bar) lives in that layer so it survives the same gating.
    this.shipManage = new ShipManage(this.housingRoot);
    // 2026-09-12: the ring that fills around the cursor while furniture is held — same layer, so it lives with the ship management screen.
    this.cursorHold = new CursorHoldGauge(this.housingRoot);

    // The material-requirement chip hover card: a direct child of `#ui-root` so it floats over the inventory window, the
    // `함선 관리` screen and every menu — it delegates on `.item-chip[data-def-id]` wherever a chip is rendered.
    this.itemTip = new ItemTip(ctx.uiRoot);
    // The music player window (2026-09-14): same placement rationale — it has to float over the ship's other screens (inventory · map).
    this.musicPlayer = new MusicPlayer(ctx.uiRoot);
    // 2026-09-12 (E2): the chip favorite right-click menu — same delegation on `ctx.uiRoot`, and the chip favorite source it registers.
    this.itemFavMenu = new ItemFavoriteMenu(ctx.uiRoot);
    // The key guide (2026-09-09): same placement rationale — the bottom-right one-liner must sit over every open screen.
    this.keyGuide = new KeyGuide(ctx.uiRoot);
    // The rescue-drop target picker (2026-09-09): a full-screen picker, so it hangs off `#ui-root` like the map / menus.
    this.rescuePick = new RescuePicker(ctx.uiRoot);
    // The in-game mouse cursor sprite: same placement rationale as the item card — over every window, layer and menu.
    this.gameCursor = new GameCursor();

    /* ── The full-screen black fade (2026-09-14, `ui:screenFade`) ────────────────────────────────────────
     * The tutorial opening (waking up) is its first user. **It is presentation, not a blocker** — it eats no pointer
     * (`pointer-events: none`) and goes on neither `ctx.escape` nor `ctx.uiBlockers`, so input · ESC flow as usual even
     * at a fade of 1.0. Position and the opacity transition belong to `styles/base.css`'s `.screen-fade`. */
    this.screenFade = el('div', { cls: 'screen-fade', parent: ctx.uiRoot });
    /* 2026-09-15 (B-14): the red fall vignette — same nature (presentation, eats no pointer) but z 25, so above the HUD
     * layers and below any open screen (reasoning at the head of `styles/fall.css`). Its strength and fade-out are written inline by `update(dt)`. */
    this.fallVignette = new FallVignette(ctx.uiRoot);
    /* 2026-09-15 (raid-entry loading): a direct child of `#ui-root` for the same reason — it has to spin **over** the
     * black fade (z 82). This too is presentation, not a screen (no blocker · no escape, it eats no pointer). */
    this.loadingGauge = new LoadingGauge(ctx.uiRoot);
    // 2026-09-16: the result screen's `함선으로 귀환` — it uses the same black plate and the same gauge (the plate is painted directly, not through the bus: the `ShipReturn` head comment)
    this.shipReturn = new ShipReturn(ctx, this.loadingGauge, (o, d, h) => this.setScreenFade(o, d, h), () => this.fadeShown);

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
    // 2026-09-09: the title's `설정` opens the **same** settings overlay as the pause menu — because the control diagram
    // and `키 설정 변경` left the title and moved inside it (into the key settings section).
    this.title = new TitleMenu(ctx.uiRoot, () => this.settings.open(), () => { this.settings.open(); this.settings.select('keys'); });
    // B-1 (2026-09-11): the server link badge — a direct child of `#ui-root` (it has to take button clicks over the title). `서버 설정` is that same settings overlay.
    this.netBadge = new NetBadge(ctx.uiRoot, () => { this.settings.open(); this.settings.select('network'); }, this.cutscene);
    this.pause = new PauseMenu(ctx.uiRoot, () => this.settings.open());
    this.death = new DeathScreen(ctx.uiRoot);
    this.complete = new MissionComplete(ctx.uiRoot);

    for (const c of [this.reticle, this.cook, this.wheel, this.swheel, this.strat, this.charge, this.targeting, this.offscreen, this.danger, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.typing, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.chat, this.map]) c.bind(ctx);
    // the shared trackers first: the components they feed read them from their own bind / first update
    this.scanTracker.bind(ctx);
    this.cutscene.bind(ctx);
    for (const c of [this.implantWidget, this.quickStrip, this.detection, this.scanReveal, this.deployables, this.progressToasts, this.actionFx]) c.bind(ctx);
    for (const c of [this.wcharge, this.statusMarkers, this.cheatTag, this.roomLabel, this.shipManage, this.cursorHold, this.shipHint, this.itemTip, this.itemFavMenu, this.keyGuide]) c.bind(ctx);
    this.musicPlayer.bind(ctx);                                // the music player window (2026-09-14)
    this.fallVignette.bind(ctx);                               // the red fall vignette (2026-09-15)
    this.loadingGauge.bind(ctx);                               // the raid-entry loading gauge (2026-09-15)
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor]) c.bind(ctx);
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.bind(ctx);
    for (const c of [this.droneHud, this.scanWarning, this.handHint, this.roverHud]) c.bind(ctx);
    this.community.bind(ctx);
    this.netBadge.bind(ctx);
    this.rescuePick.bind(ctx);
    // 2026-09-09 (raid play improvements): the communication wheel · hazard HUD · raid alerts
    for (const c of [this.comms, this.hazard, this.raidAlerts]) c.bind(ctx);
    for (const m of [this.title, this.pause, this.death, this.complete]) m.bind(ctx);

    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', ({ phase }) => {
        this.deploy.setVisible(phase === 'deploying');
        switch (phase) {
          // Training arena (Phase 7): no extraction — the exit console ends it; world/ updates the subText counter.
          // 2026-09-08: the training range writes its own objective line (mode · hit · kill counters included) in
          //   `world/TrainingArena.announce()`. With the drop sequence gone, 'playing' now lands on the same tick as
          //   `world:ready`, so overwriting here wipes the counter just written. Only a world with no training ref at all (the skeleton) is filled here.
          case 'playing':
            if (ctx.missionMode !== 'training') this.setObjective(OBJECTIVE_TEXT.find);
            else if (!ctx.world?.training) this.setObjective(OBJECTIVE_TEXT.training);
            break;
          case 'extracting': this.setObjective(OBJECTIVE_TEXT.countdown); break;
          case 'shipLanded': this.setObjective(OBJECTIVE_TEXT.board); break;
          case 'liftoff': this.setObjective(OBJECTIVE_TEXT.liftoff); break;
          default: break;
        }
      }),
      b.on('extraction:boarded', () => { if (ctx.phase === 'shipLanded') this.setObjective(OBJECTIVE_TEXT.liftoffSwitch); }),
      // 2026-09-13 (extraction rework): the departure grace · finding it again after being left behind · the liftoff cinematic takes the combat HUD
      b.on('extraction:departureStarted', () => this.setObjective(OBJECTIVE_TEXT.departing)),
      b.on('extraction:reset', () => { if (ctx.missionMode !== 'training') this.setObjective(OBJECTIVE_TEXT.find); }),
      b.on('ui:cinematic', ({ active }) => this.setCinematic(active)),
      b.on('game:abort', () => this.setCinematic(false)),
      b.on('game:newMission', () => this.setCinematic(false)),
      /* 2026-09-17: the cinematic is turned off **inside the very emit** that ends the raid. `applyVisibility`'s phase
       * guard does the same, but a frame later, and `extraction:liftoff` → `complete()`, which ends the liftoff cinematic,
       * comes from the update of a system registered after hud — so on the frame the result screen appears `--cine-o` is
       * still 0 (all hidden), and for that one frame the HUD · key guide · item card behind it stay gone (why
       * `smoke-tutorial-raid`'s 「HUD 페이드 값이 되돌아간다」 went red the more often the lane was slow). The guard stays as the second defence. */
      b.on('game:complete', () => this.setCinematic(false)),
      b.on('game:over', () => this.setCinematic(false)),
      /* 2026-09-14: the full-screen black fade. `game:newMission` is **deliberately not listened to** — `world:ready` is
       * emitted synchronously inside that event (the `hud/Compass` comment), so we would wipe the opening fade the moment
       * the world appears. `game:abort` plus the phase guard in `applyVisibility` below are defence enough. */
      /* 2026-09-16: while the ship-return fade holds the plate (`shipReturn.ownsPlate`), nobody else's request · abort ·
       * arrival clears it — the `hub:enter` that fade emits synchronously emits `game:abort` · `hub:entered`, and the tutorial sends `{0, 0}` there too. */
      b.on('ui:screenFade', ({ opacity, durationS, hold }) => { if (!this.shipReturn.ownsPlate) this.setScreenFade(opacity, durationS, hold ?? false); }),
      b.on('ui:shipReturn', () => this.shipReturn.start()),
      b.on('game:abort', () => { if (!this.shipReturn.ownsPlate) this.setScreenFade(0, 0); }),
      /* 2026-09-15: a plate raised with `hold` is **always** cleared on entering the ship — the ship never stays black
       * because the side that raised it failed to clear it (the same defence, in the same place, as `game:abort`). A
       * plate without `hold` was already cleared by the phase guard (`applyVisibility`), so this line does nothing. */
      b.on('hub:entered', () => { if (!this.shipReturn.ownsPlate) this.setScreenFade(0, 0); }),
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

  /**
   * 2026-09-13: `cinematic` on the overlay, gameplay and social layers. The CSS fades the first two out whole and, in the
   * social layer, only the combat pieces (PC vitals · interaction caption · hold ring · centre dot) — chat, notifications
   * and the squad list stay. The class comes off again on `ui:cinematic false`, an abort / new mission, the raid's end
   * (`game:complete` / `game:over`, same emit) or (`applyVisibility`) as soon as the phase leaves gameplay.
   */
  /*
   * 2026-09-16 (user's decision — 「이륙이 시작되면 남은 HUD 가 전부 사라진다」, tutorial · squad included): this reverses the
   * 「채팅 · 알림 · 분대 목록은 남는다」 above. `.cinematic` now hides **only the crosshair · rings, instantly** (`styles/raidHud.css`
   * — the 「함선이 뜨는데 크로스헤어가 보인다」 report); `#ui-root`'s `.hud-cine` fades the rest in one go: the four `.hud` layers
   * (overlay · gameplay · social · housing) + the key guide · item card · music window · server badge that hang off `#ui-root`.
   * The 3D light pillars (`Detection` · `ScanReveal` · `Deployables`) lower their material opacity by the same value; the tutorial DOM folds itself away on the same event.
   * **What stays**: the black fade · the loading gauge · menus (pause · settings · result screens) · screens like the map — not on the list, so untouched.
   *
   * The fade is **stepped in code** (`stepCinematic`): with reduced motion a CSS transition is clipped to 0.01 ms and dies in one frame (this PC).
   * The value is painted as `filter: opacity(var(--cine-o))` — not `opacity`, so it **multiplies** with `.hud.hidden` and widgets'
   * inline opacity (nothing hidden shows on the cinematic's first frame), and it is in no `.hud` transition list, so a per-frame change never lags.
   * Once all is hidden `.hud-cine-out` adds `visibility: hidden`. Undoing it (`false` · abort · new mission · leaving the phase) is instant.
   */
  private setCinematic(active: boolean): void {
    if (active === this.cinematic) return;
    this.cinematic = active;
    toggleClass(this.overlayRoot, 'cinematic', active);
    toggleClass(this.hudRoot, 'cinematic', active);
    toggleClass(this.socialRoot, 'cinematic', active);
    toggleClass(this.ctx.uiRoot, 'hud-cine', active);
    this.paintCinematic(0);
  }

  /** Steps the liftoff cinematic fade by one frame (one compare when all is hidden or there is no cinematic). */
  private stepCinematic(dt: number): void {
    if (!this.cinematic || this.cineHide >= 1) return;
    const d = Math.max(0, EXTRACTION_HUD_FADE_S);
    this.paintCinematic(d > 0 ? Math.min(1, this.cineHide + Math.max(0, dt) / d) : 1);
  }

  private paintCinematic(v: number): void {
    this.cineHide = v;
    this.ctx.uiRoot.style.setProperty('--cine-o', (1 - v).toFixed(3));
    toggleClass(this.ctx.uiRoot, 'hud-cine-out', this.cinematic && v >= 1);
  }

  /** Smoke hook: the departure cinematic currently hides the combat HUD. */
  get isCinematic(): boolean { return this.cinematic; }
  /** Smoke hook (2026-09-16): how much of the HUD the departure cinematic still shows, 1 = all … 0 = none. */
  get cinematicHudOpacity(): number { return 1 - this.cineHide; }

  /**
   * 2026-09-14 — **the full-screen black fade** (`ui:screenFade {opacity, durationS}`; its first user is the tutorial opening).
   * It goes to that opacity **from the value painted right now** over `durationS`; 0 means immediately, in place.
   *
   * **It does not use a CSS transition** (2026-09-14 fix): when the OS turns animation effects off, the reduced-motion
   * rule in `styles/base.css` clips every `transition-duration` to 0.01 ms, the black then disappears in one frame, and
   * that read as 「페이드가 안 된다」 (this development PC had that setting). So `update` interpolates linearly on the
   * simulation dt and writes an inline opacity — the same clock as the intro wake cutscene, so both stop during a pause · a shader hold.
   *
   * This is **presentation, not a screen**: it is neither a blocker nor an entry on the `ctx.escape` stack, and it eats
   * no pointer. So the caller (player/'s intro wake cutscene) raises its own input lock in its own folder.
   *
   * 2026-09-15 — with `hold` the phase guard in `applyVisibility` below does not clear this plate (the tutorial skip's
   * 「암전된 채로 결과 화면」). **A request that goes transparent always releases hold** — there is no reason to hold a plate heading to 0.
   */
  private setScreenFade(opacity: number, durationS: number, hold = false): void {
    const o = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 0));
    const d = Math.max(0, Number.isFinite(durationS) ? durationS : 0);
    this.fadeHold = hold && o > 0;
    this.fadeOpacity = o;
    this.fadeFrom = this.fadeShown;
    this.fadeT = 0;
    this.fadeDur = d;
    if (d <= 0) this.paintScreenFade(o);
  }

  /** Moves the black plate toward its target by one frame (one compare once it has arrived). */
  private stepScreenFade(dt: number): void {
    if (this.fadeShown === this.fadeOpacity) return;
    this.fadeT += Math.max(0, dt);
    const k = this.fadeDur > 0 ? Math.min(1, this.fadeT / this.fadeDur) : 1;
    this.paintScreenFade(k >= 1 ? this.fadeOpacity : this.fadeFrom + (this.fadeOpacity - this.fadeFrom) * k);
  }

  private paintScreenFade(v: number): void {
    this.fadeShown = v;
    this.screenFade.style.opacity = v.toFixed(3);
  }

  /** Smoke hook: the black plate's target opacity (0 = the screen is open). */
  get screenFadeOpacity(): number { return this.fadeOpacity; }
  /** Smoke hook (2026-09-15, B-14): the fall vignette's current opacity (0 = off). */
  get fallVignetteOpacity(): number { return this.fallVignette.opacity; }
  /** Smoke hook (2026-09-14): the opacity actually painted this frame (moves toward `screenFadeOpacity`). */
  get screenFadeShown(): number { return this.fadeShown; }
  /** Smoke hook (2026-09-15): the plate is held across phase changes (`ui:screenFade.hold`). */
  get screenFadeHeld(): boolean { return this.fadeHold; }

  update(dt: number, ctx: GameContext): void {
    this.applyVisibility();
    // 2026-09-14: the black fade is moved here, not by a CSS transition (the `setScreenFade` comment — reduced motion)
    this.stepScreenFade(dt);
    // 2026-09-16: the liftoff cinematic's HUD fade is stepped in code for the same reason (the `setCinematic` comment)
    this.stepCinematic(dt);
    // Map polls M and draws itself while open (also handles its own blocker token).
    this.map.update(ctx);
    // 2026-09-13: the rover riding HUD — it runs regardless of layer visibility (the key guide · `rover-view` have to come off in time)
    this.roverHud.update(dt, ctx);
    // 2026-09-12: the vitals block lives in the social layer (up in the ship too); its raid-only stamina bar just idles there.
    if (this.hudVisible || this.socialVisible) this.vitals.update(dt, ctx);
    if (this.hudVisible) {
      this.reticle.update(dt, ctx);
      this.reload.update(dt);
      this.strat.update(ctx);
      this.targeting.update(ctx);
      this.compass.update(ctx, dt);   // 2026-09-14: dt = fading in slowly after the intro wake
      this.objective.update(ctx);
      this.pings.update(dt, ctx);
      this.spectate.update(dt, ctx);
      this.implantWidget.update(dt, ctx);
      this.quickStrip.update();
      this.weapon.update(ctx);   // 2026-09-16: the primary slot in hand · dimming · the side thumbnail (`ctx.weapons.activeSlot` / `primaryInHand`)
      this.droneHud.update(dt, ctx);
      // 2026-09-11 (C-53): `scanWarning` projects to the screen, so it moved to `lateUpdate`.
      this.handHint.update(dt, ctx);
    }
    if (this.socialVisible) {
      this.squad.update(dt, ctx);
      this.chat.update(dt);
      this.progressToasts.update(dt);
    }
    // Room label / contract pulse time themselves out on `ctx.time` regardless of layer visibility (one compare per frame);
    // meta toasts keep expiring behind a result screen so a stale chip never greets the hub.
    this.roomLabel.update(ctx);
    // The `함선 관리` hint: two compares per frame, and it must survive a hidden social layer state change.
    this.shipHint.update(ctx);
    // The server link badge: it shows itself in the ship · title only (hidden in the raid HUD — user's decision).
    this.netBadge.update(ctx);
    // The in-ship dot crosshair: same self-gating (phase / blockers / cutscene), one compare per frame.
    this.hubDot.update(ctx);
    // `커뮤니티`: same self-gating, plus the P-hold on a `분대 초대` (it needs dt).
    this.community.update(dt, ctx);
    // The rescue-drop target picker: self-gating on `ctx.stratagems.armed === 'rescue_drop' && rescueTarget === null`.
    this.rescuePick.update(dt, ctx);
    // 2026-09-09: the communication wheel polls its own key (H), so it runs every frame regardless of layer visibility —
    // it raises its own gate (`isGameplayActive` + pointer lock) and, once unusable, folds an open wheel away sending nothing.
    this.comms.update(dt, ctx);
    // Environmental hazards: it returns at once while `ctx.world.hazard` is null (before world/ has built one).
    this.hazard.update(ctx);
    // The key guide: hides under the pause menu (one blocker lookup per frame).
    this.keyGuide.update();
    // 2026-09-16: the toast stack starts below the tutorial control guide panel while that is up (one compare when it is not).
    this.notifs.update();
    // The music player window: two compares when it is off (ship only · hides under a menu blocker — the same rule as the key guide).
    this.musicPlayer.update(ctx);
    this.contractPanel.update(ctx);
    this.trainingPanel.update(ctx);
    this.metaToasts.update(dt);
    // Self-gating components (they hide their own world meshes / markers outside gameplay).
    this.deployables.update(dt, ctx);
    this.actionFx.update(dt, ctx);
    this.scope.update(ctx);
    this.damage.update(dt, ctx);
    // The fall vignette: one compare when it is off (regardless of layer visibility — it still ends on time if a menu opens mid-fade).
    this.fallVignette.update(dt);
    /* 2026-09-15: the loading gauge **takes no dt** — while the load gate holds the engine dt is 0, so on the simulation
     * clock it would not move a single frame (the `hud/LoadingGauge` head comment). One compare when it is off. */
    this.loadingGauge.update();
    // 2026-09-16: the ship-return fade — a real-time clock (dt is 0 during the hold), one compare when it is not running
    this.shipReturn.update();
    this.complete.update(dt);
    this.death.update(dt);
    // The title flow: only the character-creation window's 3D preview runs (it returns at once while closed).
    this.title.update(dt);
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    // 2026-09-11 (C-53 · X-9): `Vector3.project` reads `camera.matrixWorldInverse`, which only `updateMatrixWorld` /
    // `updateWorldMatrix` refresh. `CameraRig` moves the camera in the player's `lateUpdate` (registered before us) without refreshing it, and the renderer
    // only does so inside `render()` — after this. Widgets that never call `getWorldDirection` / `getWorldPosition`
    // first (WorldMarkers · Pings · OffscreenIndicators) were projecting through the previous frame's view.
    ctx.camera.updateMatrixWorld();
    if (this.hudVisible) {
      this.markers.lateUpdate(ctx);
      this.pings.lateUpdate(ctx);
      this.offscreen.lateUpdate(ctx);
      this.danger.lateUpdate(dt, ctx);
      this.statusMarkers.lateUpdate(ctx);
      this.scanWarning.lateUpdate(dt, ctx);
      // 2026-09-12: world labels for drone scan results (DroneHud owns them)
      this.droneHud.lateUpdate(ctx);
    }
    if (this.socialVisible) { this.nameplates.lateUpdate(ctx); this.typing.lateUpdate(ctx); }
    // 2026-09-16: the 3D light pillars · mine radius rings follow the liftoff cinematic's HUD fade too (hidden at 0)
    const cineK = 1 - this.cineHide;
    this.detection.setCinematicFade(cineK);
    this.scanReveal.setCinematicFade(cineK);
    this.deployables.setCinematicFade(cineK);
    this.detection.lateUpdate(dt, ctx);
    this.scanReveal.lateUpdate(dt, ctx);
    this.deployables.lateUpdate(ctx);
  }

  /** Whether the tactical map is currently open (debug / other HUD parts). */
  get isMapOpen(): boolean { return this.map.isOpen; }
  /** 2026-09-13 (smoke): whether the map is in rover destination mode · the chosen stop · the visible legend rows · the riding HUD. */
  get isMapRoverMode(): boolean { return this.map.isRoverMode; }
  get mapRoverSelection(): string | null { return this.map.roverSelection; }
  get mapLegendIds(): string[] { return this.map.legendIds; }
  mapSelectStation(id: string): boolean { return this.map.selectStation(id); }
  get isRoverHudShowing(): boolean { return this.roverHud.isShowing; }
  /** Whether the chat input is open (debug). */
  get isChatOpen(): boolean { return this.chat.isOpen; }
  /** Whether the quick-use wheel is showing (debug). */
  get isWheelOpen(): boolean { return this.wheel.isOpen; }
  /** 2026-09-16: weapon panel state — dimmed (primary not in hand) · empty · shown slot · side thumbnail def + key (debug). */
  get weaponPanelView(): WeaponPanel['view'] { return this.weapon.view; }
  /** Whether the ship-call wheel is showing (debug). */
  get isStratagemWheelOpen(): boolean { return this.swheel.isOpen; }
  /** 2026-09-09 the communication wheel (H hold): whether it is up · the hovered slot · the slot count (4 standing, 2 downed) (debug / smoke). */
  get isCommsWheelOpen(): boolean { return this.comms.isOpen; }
  get commsWheelHover(): number | null { return this.comms.hoverIndex; }
  get commsWheelSlots(): number { return this.comms.slotCount; }
  /** 2026-09-09 the area ping hold wheel: whether it is up · whether it is the downed layout (debug / smoke). */
  get isPingWheelOpen(): boolean { return this.pings.isHoldWheelOpen; }
  get isPingWheelDowned(): boolean { return this.pings.isHoldWheelDowned; }
  /** 2026-09-09 the hazard HUD: the warning banner · inside the danger zone · the safe zone left 0…1 (debug / smoke). */
  get isHazardBannerOn(): boolean { return this.hazard.isBannerOn; }
  get isInHazard(): boolean { return this.hazard.isInside; }
  get hazardSafeShare(): number { return this.hazard.safeShare; }
  /**
   * 2026-09-12 (character buffs) — debug / smoke. `localBuffs` = the thumbnails under the PC hp bar, in DOM order
   * (key · kind · glyph · color · dim = pending · debuff frame · gauge ratio · time label · title);
   * `squadBuffs(id)` = the same for member `id`'s squad row (null when no row shows that member — the local row never has any).
   */
  get localBuffs(): BuffCellState[] { return this.vitals.buffs.state; }
  squadBuffs(id: string): BuffCellState[] | null { return this.squad.buffStateOf(id); }
  /** Smoke hook: draw `list` under the PC hp bar instead of `ctx.player.buffs`; `null` hands it back to the player. */
  debugLocalBuffs(list: readonly CharBuff[] | null): void { this.vitals.setDebugBuffs(list); }
  /** Whether the targeting frame is up (debug). */
  get isTargeting(): boolean { return this.targeting.isActive; }
  /** Whether the key-settings overlay is open (debug). */
  get isKeybindsOpen(): boolean { return this.keybinds.isOpen; }
  /** Edge arrows currently visible (debug). */
  get offscreenCount(): number { return this.offscreen.visibleCount; }
  /** Danger indicators (2026-09-10): on-screen head markers + off-screen direction arcs / hazards being tracked (debug / smoke). */
  get dangerIndicatorCount(): number { return this.danger.visibleCount; }
  get dangerTrackedCount(): number { return this.danger.trackedCount; }
  /** The old name (2026-09-09's shell markers) — the danger indicators absorbed it. */
  get shellMarkerCount(): number { return this.danger.visibleCount; }
  /** The implant thumbnail (2026-09-10, bottom centre): what it shows · in which kind · how full it is (debug / smoke). */
  get implantHudId(): string | null { return this.implantWidget.shownId; }
  get implantHudKind(): string { return this.implantWidget.displayKind; }
  get implantHudFill(): number { return this.implantWidget.fillAmount; }
  get isImplantHudDimmed(): boolean { return this.implantWidget.isDimmed; }
  /** The grapple chip left of the crosshair: 'off' | 'dim' | 'ready' (debug / smoke). */
  get grappleChip(): 'off' | 'dim' | 'ready' { return this.reticle.grappleChip; }
  /** 2026-09-14 the crosshair's bow mode: `{on, draw (0 = the lower step … 1 = the centre), full}` (debug / smoke). */
  get bowReticle(): { on: boolean; draw: number; full: boolean } {
    return { on: this.reticle.bowMode, draw: this.reticle.bowDraw, full: this.reticle.bowFull };
  }
  /** Unique-weapon charge gauge kind while showing, else null (debug). */
  get weaponChargeKind(): 'charge' | 'spinup' | 'slash' | null { return this.wcharge.activeKind; }
  /** Live incinerated / electrocuted world markers (debug). */
  get statusMarkerCount(): number { return this.statusMarkers.activeCount; }
  /** Whether the weapon panel shows unique fire-mode lines (debug). */
  get hasWeaponModes(): boolean { return this.weapon.hasModes; }
  /** Whether the `MOVE CHEAT` tag is on (debug). */
  get isMoveCheatTagOn(): boolean { return this.cheatTag.isOn; }
  /** Whether the housing hint bar is showing (debug). */
  /** The key guide (2026-09-09): owner on top of the stack / entries as rendered (close entry last) / visibility. */
  get keyGuideOwner(): string | null { return this.keyGuide.owner; }
  get keyGuideOwners(): readonly string[] { return this.keyGuide.owners; }
  get keyGuideEntries(): readonly KeyGuideEntry[] { return this.keyGuide.entries; }
  get isKeyGuideOn(): boolean { return this.keyGuide.isShowing; }
  /** Whether the room label is up (debug). */
  get isRoomLabelOn(): boolean { return this.roomLabel.isShowing; }
  /** Whether the 설정 overlay is open / which of its three sections the right pane shows (debug). */
  get isSettingsOpen(): boolean { return this.settings.isOpen; }
  get settingsSection(): string { return this.settings.activeSection; }
  /** The title flow (2026-09-09): whether the character select / create screen is up (debug / smoke). */
  get isCharacterSelectOpen(): boolean { return this.title.isSelectOpen; }
  get isCharacterCreateOpen(): boolean { return this.title.isCreateOpen; }
  /** 2026-09-15 (title `이어하기` · abandoning the raid, debug / smoke): `이어하기` · a warning-coloured `게임 시작` · the abandon popup · hold progress. */
  get titleResume(): { resume: boolean; warn: boolean; ask: boolean; hold: number } { return this.title.resumeView; }
  /** The old-keybind notice (2026-09-11, C-9 · X-8): the boot report · the card's rows · whether the card is up (debug / smoke). */
  get keybindNotice(): { report: KeybindLoadReport | null; lines: readonly string[]; on: boolean } {
    const n = this.title.keybindNotice;
    return { report: n.report, lines: n.lines, on: n.isOn };
  }
  /** Whether the 함선 관리 screen is showing / which room it edits / how many furniture cards it renders (debug). */
  get isShipManageOn(): boolean { return this.shipManage.isShowing; }
  get shipManageRoom(): number | null { return this.shipManage.activeRoom; }
  get shipManageCardCount(): number { return this.shipManage.cardCount; }
  /** Def id the material-requirement chip hover card is describing, null when it is hidden (debug). */
  get itemTipDefId(): string | null { return this.itemTip.shownDefId; }
  /** The music player window (debug, 2026-09-14): whether it is up · the track title · the artist · the volume row. */
  get musicPlayerView(): { on: boolean; title: string; artist: string; volume: string } {
    return { on: this.musicPlayer.isShowing, title: this.musicPlayer.titleText, artist: this.musicPlayer.artistText, volume: this.musicPlayer.volumeText };
  }
  /** Whether the 함선 관리(M) hint is showing (debug). */
  get isShipHintOn(): boolean { return this.shipHint.isShowing; }
  /** Phase 12 debug: compass enemy ticks / on-screen enemy chevrons / live recon reveals / the channel ticker text. */
  get compassEnemyTicks(): number { return this.compass.enemyTickCount; }
  get detectMarkCount(): number { return this.detection.markCount; }
  get scanRevealCount(): number { return this.scanTracker.count; }
  get channelTickerText(): string | null { return this.notifs.channelText; }
  get notifCount(): number { return this.notifs.liveCount; }
  /** Phase 12 debug: the 시설 관리 confirm popup (purpose or 발전기) and the pending purpose. */
  get isShipManageConfirmOn(): boolean { return this.shipManage.isConfirmOpen; }
  /** 2026-09-12: the 시설 제거 confirm's hold fill (0 … 1) and whether that confirm is the red hold one (debug / smoke). */
  get shipManageConfirmHold(): number { return this.shipManage.confirmHoldProgress; }
  get shipManageConfirmDanger(): boolean { return this.shipManage.isConfirmDanger; }
  /** 2026-09-12: the cursor-centred furniture hold ring (`housing:moveHold`) — showing, and its fill (−1 when hidden). */
  get isCursorHoldOn(): boolean { return this.cursorHold.isShowing; }
  get cursorHoldProgress(): number { return this.cursorHold.progress; }
  get shipManageConfirmPurpose(): string | null { return this.shipManage.confirmPurpose; }
  /** Whether the pause menu is in its ship variant (debug). */
  get isPauseHubVariant(): boolean { return this.pause.isHubVariant; }
  /** 2026-09-08: whether the pause menu's warning popup (`파티 떠나기` / `타이틀로` / `게임 종료`) is up (debug / smoke). */
  get isPauseAskOpen(): boolean { return this.pause.isAskOpen; }
  /** 2026-09-09: the warning popup's 1 s hold progress 0…1 (debug / smoke) — a click does not confirm, a hold does. */
  get pauseHoldProgress(): number { return this.pause.askHoldProgress; }
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
  /** 2026-09-08 the hold ring (interaction / giving up) — smoke hooks. */
  get isHoldGaugeOn(): boolean { return this.hold.isShowing; }
  get holdGaugeProgress(): number { return this.hold.progress; }
  get isHoldGaugeGiveUp(): boolean { return this.hold.isGiveUp; }
  /** 2026-09-09 the in-ship dot crosshair — smoke hook. */
  get isHubDotOn(): boolean { return this.hubDot.isShowing; }
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
   * `inMission` flipped by the test) and a synthetic `LobbyState` to the nameplates, the typing speech bubbles and the
   * squad panel without a relay session. `debugRemotes(null)` clears all three.
   * 2026-09-12: a ref may carry `buffs` (+ `buffsRevision`) — the squad row draws them under its hp bar; reassign
   * `ref.buffs` to a new array (and/or emit `net:remoteBuffsChanged`) to change them.
   */
  debugRemotes(refs: readonly RemotePlayerRef[] | null, lobby: LobbyState | null = null): void {
    this.nameplates.setDebugRefs(refs);
    this.typing.setDebugRefs(refs);   // 2026-09-11 (B-11): the `…` bubble is fed the same way the plates are
    this.squad.setDebug(lobby, refs ?? []);
  }

  /**
   * Smoke-test hook (Phase 11): install a synthetic `SocialSnapshot` (+ live squad invites) as `ctx.net.social` for
   * every ui component that reads the social mirror — the community thumbnail / panel and the invite stack. Same
   * shape as `debugRemotes`: `debugSocial(null)` hands the UI back to the real `ctx.net.social`, and
   * `debugSocial('offline')` forces the unavailable state even when a relay is connected.
   * `mySquad` is the member count of *my* lobby, which `playBlockReason` needs to judge `같이 하기`.
   *
   * 2026-09-08: the ESC screen no longer carries a social column (social is the 커뮤니티 panel alone), so the
   * community panel is the only consumer left.
   */
  debugSocial(
    snapshot: SocialSnapshot | 'offline' | null, invites: readonly SquadInvite[] = [], mySquad = 1,
    history: Readonly<Record<string, readonly WhisperLine[]>> = {},
  ): void {
    setDebugSocial(snapshot, invites, mySquad, history);
    this.community.socialColumn.refresh(true);
  }

  /** 2026-09-11 (B-3 · B-4): install any `SocialRef` — a detached `SocialSync` fed server frames by the smoke. */
  debugSocialRef(ref: SocialRef | null): void {
    setDebugSocialRef(ref);
    this.community.socialColumn.refresh(true);
  }

  /** 2026-09-14 (messenger): install any `NpcQuestRef` as `ctx.meta.npc` for the messenger (null hands it back). */
  debugNpc(ref: NpcQuestRef | null): void { setDebugNpc(ref); }
  /** 2026-09-14 (messenger): install any `RoomsRef` as `ctx.net.rooms` for the messenger (null hands it back). */
  debugRooms(ref: RoomsRef | null): void { setDebugRooms(ref); }
  /** 2026-09-14: the messenger body — tabs, 대화 / 퀘스트 tabs, 친구 tab column (debug / smoke). */
  get messenger(): Messenger { return this.community.messenger; }
  /** 2026-09-14: the messenger thumbnail's unread count badge (debug / smoke). */
  get messengerUnreadBadge(): number { return this.community.unreadBadge; }

  /** Mutations the synthetic social ref received, newest last (debug; empty in a real session). */
  get debugSocialLog(): readonly { m: string; args: unknown[] }[] { return debugSocialCalls; }
  /** 커뮤니티 widget / panel / invite state (debug, Phase 11). */
  get isCommunityOn(): boolean { return this.community.isShowing; }
  /** B-1 (2026-09-11): the server link badge — whether it is up · its two rows · whether the title buttons show (debug / smoke). */
  get netBadgeState(): { on: boolean; main: string; sub: string; actions: boolean } {
    return { on: this.netBadge.isShowing, main: this.netBadge.mainText, sub: this.netBadge.subText, actions: this.netBadge.hasActions };
  }
  get isCommunityOpen(): boolean { return this.community.isOpen; }
  /** 2026-09-09: whether the rescue-drop target picker is up / how many slots can be chosen (debug / smoke). */
  get isRescuePickerOpen(): boolean { return this.rescuePick.isOpen; }
  get rescuePickerSelectable(): number { return this.rescuePick.selectableCount; }
  get communityInviteCount(): number { return this.community.inviteCount; }
  get communityHoldProgress(): number { return this.community.holdProgress; }
  /** The private chat target of the chat input, null when it is ordinary squad chat (debug, Phase 11). */
  get chatWhisperTarget(): string | null { return this.chat.whisperTarget; }
  /** The typing speech bubble — who has one showing right now (debug / smoke, 2026-09-11 B-11). */
  get typingBubbleIds(): readonly PeerId[] { return this.typing.visibleIds; }

  /* ── 2026-09-15: android squadmates · raid-entry loading (debug / smoke) ──────────────────────────────── */

  /**
   * Smoke hook: install any `AlliesRef` as `ctx.allies` for every ui reader (the squad list · nameplates · map ·
   * compass · legend). `null` hands the UI back to the real `ctx.allies`. Same shape as `debugSocial` / `debugNpc`.
   */
  debugAllies(ref: AlliesRef | null): void { setDebugAllies(ref); }
  /** The squad list's visible rows (people + androids), in DOM order. */
  get squadRows(): Array<{ id: string; name: string; badge: string; state: string; hp: string; shield: string; android: boolean }> { return this.squad.rowStates; }
  /** Android nameplates — id · name · tag · hp · shield · whether it shows. */
  get allyNameplates(): Array<{ id: string; name: string; tag: string; hp: string; shield: string; shown: boolean }> { return this.nameplates.allyPlateStates; }
  /** The chat log's lines — class · name · body. */
  get chatLines(): Array<{ cls: string; who: string; text: string }> { return this.chat.lineStates; }
  /** The text of the toasts showing right now. */
  get toastTexts(): string[] { return this.notifs.toastTexts; }
  /** The ping list (owner · kind · label) — an android's ping has `owner.android` true. */
  get pingViews(): readonly PingView[] { return this.pings.getPings(); }
  /** The raid-entry loading gauge — whether it shows · fill 0…1 · how many are waiting · opacity · spin angle. */
  get loadingGaugeState(): { on: boolean; fill: number; waiting: number; opacity: number; spin: number } {
    return {
      on: this.loadingGauge.isShowing, fill: this.loadingGauge.fill, waiting: this.loadingGauge.waitingCount,
      opacity: this.loadingGauge.opacity, spin: this.loadingGauge.spinDeg,
    };
  }

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
    // 2026-09-13: a cinematic never outlives the raid (the result screen / ship bring the HUD back on their own terms)
    if (this.cinematic && !ctx.isGameplayPhase()) this.setCinematic(false);
    /* 2026-09-14: the black fade does not outlive the raid either — the same defence in the same place. The test is
     * `inGame` (gameplay + `deploying`) though: the opening fade spans the drop · world preparation stretch, so cutting
     * on `isGameplayPhase()` alone would wipe it the frame after it is raised. It clears at once on the result screen · ship · title · death screen.
     *
     * 2026-09-15 — **a plate raised with `hold` is the exception** (the tutorial raid skip): clearing the black the
     * moment the phase turns to the result screen shows the planet behind the result window again. The side that raised it clears it, or `game:abort` · `hub:entered` do. */
    if (this.fadeOpacity > 0 && !inGame && !this.fadeHold) this.setScreenFade(0, 0);
    // Reticle hidden while inventory / any blocker is open (handled in Reticle.update via opacity).
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const c of [this.reticle, this.cook, this.wheel, this.swheel, this.strat, this.charge, this.targeting, this.offscreen, this.danger, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.typing, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.chat, this.deploy, this.map]) c.dispose();
    for (const c of [this.implantWidget, this.quickStrip, this.detection, this.scanReveal, this.deployables, this.progressToasts, this.actionFx]) c.dispose();
    this.scanTracker.dispose();
    this.cutscene.dispose();
    for (const c of [this.wcharge, this.statusMarkers, this.cheatTag, this.roomLabel, this.shipManage, this.shipHint, this.itemTip, this.itemFavMenu, this.keyGuide]) c.dispose();
    this.musicPlayer.dispose();                                // the music player window (2026-09-14)
    this.fallVignette.dispose();                               // the red fall vignette (2026-09-15)
    this.shipReturn.dispose();
    this.loadingGauge.dispose();                             // the raid-entry loading gauge (2026-09-15)
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor, this.hubDot]) c.dispose();
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.dispose();
    for (const c of [this.droneHud, this.scanWarning, this.handHint, this.roverHud]) c.dispose();
    this.community.dispose();
    this.netBadge.dispose();
    this.rescuePick.dispose();
    for (const c of [this.comms, this.hazard, this.raidAlerts]) c.dispose();
    for (const m of [this.title, this.pause, this.death, this.complete]) m.dispose();
    this.settings.dispose();
    this.keybinds.dispose();
    this.hudRoot.remove(); this.socialRoot.remove(); this.overlayRoot.remove(); this.housingRoot.remove();
    this.screenFade.remove();
  }
}
