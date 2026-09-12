import type { CharBuff, GameContext, GameSystem, KeybindLoadReport, KeyGuideEntry, LobbyState, PeerId, RemotePlayerRef, SocialSnapshot, SquadInvite } from '@/shared';
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
/* 2026-09-12 (캐릭터 버프): 환경 · 식사 · 운동 디버프 배지 셋은 `hud/BuffStrip` 썸네일 줄로 대체됐다 (Vitals · Squad 안) */
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
import { Deployables } from './hud/Deployables';
import { ProgressToasts } from './hud/ProgressToasts';
import { ActionFeedback } from './hud/ActionFeedback';
import { WeaponChargeGauge } from './hud/WeaponChargeGauge';
import { StatusMarkers } from './hud/StatusMarkers';
import { CheatTag } from './hud/CheatTag';
import { KeyGuide } from './hud/KeyGuide';
import { ItemTip } from './hud/ItemTip';
import { ItemFavoriteMenu } from './hud/ItemFavoriteMenu';
import { GameCursor } from './hud/GameCursor';
import { ShipManage } from './hud/ShipManage';
import { CursorHoldGauge } from './hud/CursorHoldGauge';
import { ShipManageHint } from './hud/ShipManageHint';
import { Community } from './hud/Community';
import { setDebugSocial, setDebugSocialRef, debugSocialCalls } from './menus/social/socialSource';
import type { SocialRef, WhisperLine } from '@/shared';
import { RoomLabel } from './hud/RoomLabel';
import { ContractPanel } from './hud/ContractPanel';
import { TrainingPanel } from './hud/TrainingPanel';
import { MetaToasts } from './hud/MetaToasts';
/* 2026-09-11: 드론 조종 HUD · 로든 스캔 경고 · 손에 든 가젯 안내(설치 · 기폭 · 드론 조종) */
import { DroneHud } from './hud/DroneHud';
import { NamedScanWarning } from './hud/NamedScanWarning';
import { GadgetHandHint } from './hud/GadgetHandHint';
/* 2026-09-11 (B-1): 서버 연결 배지 (함선 · 타이틀 우측 상단) */
import { NetBadge } from './hud/NetBadge';
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
 * (edge arrows for squad pings / 로그 강하 — 2026-09-10: 수류탄과 낙하물은 `DangerIndicators` 로 옮겼다).
 * 2026-09-10 (위험 인디케이터): `DangerIndicators` 가 `ShellMarkers` 를 대신해 곡사포탄 · 수류탄 · 함선 호출
 * 낙하물을 하나의 언어로 그리고 (화면 안 = 머리 인디케이터, 화면 밖 = 크로스헤어 둘레의 방향 호), 전술 임플란트
 * 표시는 `ImplantWidget` 하나로 합쳐져 **화면 중앙 하단 · 스태미나 바 아래**로 내려갔다 (`ImplantChip` 삭제).
 * Phase 6: `WeaponChargeGauge` (unique-weapon charge / spin-up / slash arc) and `StatusMarkers` (🔥 전소 / ⚡ world markers)
 * in the gameplay layer; `CheatTag` (`MOVE CHEAT`) and `RoomLabel` (`방 n · 용도`) in the social layer; the `.hud.housing`
 * layer (2026-09-09: `HousingHint` is gone — hub/HousingMode emits `ui:keyGuide` and the `KeyGuide` draws it).
 * 2026-09-09: `KeyGuide` (`.key-guide`, bottom-right one-liner `R 회전 · X 버리기 · Tab 닫기` for the topmost open
 * screen, fed by `ui:keyGuide`) is a direct child of `ctx.uiRoot` like `ItemTip`, so it floats over every window in
 * both hub and gameplay phases; `keyGuide.update()` polls the `'menu'` blocker each frame.
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
 * 2026-09-09 (함선 크로스헤어): `HubDot` (`.hub-dot`, the ship's centre dot) joins the social layer and `HoldGauge`
 * **moves** there from the gameplay layer, so the 발사 포드 탑승 hold fills a ring around that dot in the hub while the
 * gameplay behaviour is unchanged (the social layer is up in every phase the gameplay layer is).
 * Phase 11 (소셜): `Community` joins the social layer — the ship-only 커뮤니티 thumbnail, its panel (which reuses the
 * ESC screen's `menus/social/SocialColumn`) and the 분대 초대 stack with its `Keys.INVITE` hold; the pause menu's own
 * social column is built by `PauseMenu`, and `debugSocial(snapshot, invites)` fakes the mirror for the smoke.
 * 2026-09-12 (캐릭터 버프, 사용자 결정): the **vitals block moved to the social layer** (like `HoldGauge` did) so the PC
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

  private reticle!: Reticle;
  private vitals!: Vitals;
  private weapon!: WeaponPanel;
  private compass!: Compass;
  private markers!: WorldMarkers;
  private pings!: Pings;
  private squad!: Squad;
  private nameplates!: Nameplates;
  /** 2026-09-09: 입력 중 말풍선 — a remote player whose snapshot carries `PlayerFlags.TYPING`. */
  private typing!: TypingBubbles;
  private spectate!: SpectateOverlay;
  private chat!: ChatLog;
  private wheel!: QuickWheel;
  private cook!: CookGauge;
  /* Phase 10: two more crosshair rings — the reload radial moved off the weapon panel, the 회복약 is a 2 s hold */
  private reload!: ReloadGauge;
  private heal!: HealGauge;
  /** 2026-09-09: lives in the **social** layer so the 발사 포드 탑승 hold fills a ring in the ship too (see `init`). */
  private hold!: HoldGauge;
  /** 2026-09-09: 함선 내 점 크로스헤어 — the social layer's centre dot for the hub phases. */
  private hubDot!: HubDot;
  /**
   * 위험 인디케이터 (2026-09-10): 곡사포탄 · 수류탄 · 함선 호출 낙하물을 화면 안이면 머리 인디케이터,
   * 밖이면 크로스헤어 둘레의 방향 호로. 2026-09-09 의 `hud/ShellMarkers` 를 흡수했다.
   */
  private danger!: DangerIndicators;
  private swheel!: StratagemWheel;
  /** 2026-09-09: H 홀드 의사소통 휠 — 이 휠만 입력까지 스스로 본다 (소유 시스템 폴더가 없다). */
  private comms!: CommsWheel;
  /** 2026-09-09: 환경 재해 경고 (배너 · 안전지대 게이지 · 화면 가장자리). */
  private hazard!: HazardHud;
  /** 2026-09-09: 새 랜드마크 발견 · 로그 강하 예고 토스트 (DOM 없음 — `ui:notify` 로만 나간다). */
  private raidAlerts = new RaidAlerts();
  private strat!: StratagemPanel;
  /** 2026-09-09: 구조선 대상 선택 화면 (자기 스스로 `ctx.stratagems` 를 보고 뜬다). */
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
  /* tactical kit — 2026-09-10: the implant readout is one bottom-centre thumbnail (the 임플란트 칩 is gone with it) */
  private implantWidget!: ImplantWidget;
  /* 2026-09-11: 드론 조종 HUD · 로든 스캔 경고 · 손에 든 가젯 안내 */
  private droneHud!: DroneHud;
  private scanWarning!: NamedScanWarning;
  private handHint!: GadgetHandHint;
  /* Phase 9 UI pass: right-hand column above the weapon panel — 빠른 사용 썸네일 strip */
  private quickStrip!: QuickStrip;
  private detection!: Detection;
  private scanReveal!: ScanReveal;
  /** Phase 12: 정찰 reveals shared by the compass ticks and the detection arrows / chevrons. */
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
  /** 2026-09-12: 시설 관리의 가구 꾹 누르기 게이지 (`housing:moveHold`, 커서 중심). */
  private cursorHold!: CursorHoldGauge;
  private shipHint!: ShipManageHint;
  /* Phase 11: ship-only 커뮤니티 icon + 분대 초대 stack (social layer) */
  private community!: Community;
  /* B-1 (2026-09-11): 서버 연결 배지 (#ui-root 직계, 함선 · 타이틀) */
  private netBadge!: NetBadge;
  private itemTip!: ItemTip;
  /* 2026-09-12 (E2): 칩 · 옵트인 타일의 즐겨찾기 우클릭 메뉴 (direct child of `ctx.uiRoot`, like `itemTip`) */
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
    // 2026-09-09: 세 번째 휠. 형제들과 같은 레이어 · 같은 성격 (`pointer-events:none`, blocker 없음).
    this.comms = new CommsWheel(this.hudRoot);
    // 환경 재해: 배너 · 게이지는 게임플레이 레이어, 가장자리 맥동은 비네트와 같은 오버레이 레이어.
    this.hazard = new HazardHud(this.hudRoot, this.overlayRoot);
    // 2026-09-12: the stamina bar is created here (gameplay layer, raid-only, same DOM slot as before); the name · shield · hp
    // block stays detached until the social layer exists and is mounted there below, so it also shows in the ship.
    this.vitals = new Vitals(this.hudRoot, null);
    this.weapon = new WeaponPanel(this.hudRoot);
    // The strip lives **inside** the weapon panel so it stacks on top of the gun box and inherits its
    // right-bottom anchor, its fade and the `.hud.spectating` rule. `prepend` puts it first in the panel.
    // (2026-09-11, C-26: the `.wslots` slot strip it once sat above is gone, and so is `hud/SlotStrip.ts`.)
    // (2026-09-10: the 임플란트 칩 that used to sit above it is gone — `ImplantWidget` is the one implant
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
    // 2026-09-11: 드론 조종 HUD · 로든 스캔 경고 · 손에 든 가젯 안내 — 각자 자기 조건으로 뜬다.
    this.droneHud = new DroneHud(this.hudRoot);
    this.scanWarning = new NamedScanWarning(this.hudRoot);
    this.handHint = new GadgetHandHint(this.hudRoot);
    // 2026-09-10 (2차, 사용자 결정): 함선 호출은 더 이상 우측 하단 무기 열의 텍스트 패널이 아니라
    // **임플란트 바로 왼쪽의 정사각 썸네일**이다 — 그래서 무기 열을 떠나 여기, 같은 하단 중앙 줄에 선다
    // (자리는 `styles/shipCall.css` 가 `implant.css` 의 `:root` 기하 변수로 잡는다).
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
    // 2026-09-12 (캐릭터 버프): PC 체력 블록 — 소셜 레이어라 함선에서도 보인다 (`.hud-bl` 은 base.css 에서 늘 그 위에 앉는다).
    // Raid visibility is unchanged: in gameplay phases this layer follows the gameplay one (menu / solo death), and the
    // `.hud.spectating .vitals` rule applies here too. The drone-view shrink moved to a sibling selector in `styles/drone.css`.
    this.socialRoot.appendChild(this.vitals.root);
    this.prompt = new InteractionPrompt(this.socialRoot);
    // 2026-09-09: the 홀드 링 moved from the gameplay layer to this one — the social layer is the one that stays up in
    // the ship, and the 발사 포드 탑승 (0.4 s hold) had no ring there. One instance serves both phases; the
    // `.hud.spectating .hold` rule still applies because this root carries `.spectating` too.
    this.hold = new HoldGauge(this.socialRoot);
    // 2026-09-09: 함선 내 점 크로스헤어 — the gameplay reticle is hidden in the hub, so the ship gets its own centre dot
    // (self-gated: phase `hub`, no blocker, no docking / warp cutscene). The hold ring above sits around it.
    this.hubDot = new HubDot(this.socialRoot, this.cutscene);
    this.notifs = new Notifications(this.socialRoot);
    this.progressToasts = new ProgressToasts(this.socialRoot);
    this.metaToasts = new MetaToasts(this.progressToasts.root);
    this.cheatTag = new CheatTag(this.socialRoot);
    this.roomLabel = new RoomLabel(this.socialRoot);
    // Phase 12: both corner widgets hide during a docking / warp cutscene; the hint is personal-ship only.
    this.shipHint = new ShipManageHint(this.socialRoot, this.cutscene);
    // Phase 11: the 커뮤니티 thumbnail + 분대 초대 panels — ship only, self-gated on `ctx.isHubPhase()`.
    this.community = new Community(this.socialRoot, this.cutscene);

    // Housing layer: its own `.hud.housing` root (always attached) so the 시설 관리 screen is visible in the ship where
    // the gameplay HUD is hidden. (The housing hint bar that used to live here was replaced by `KeyGuide`, 2026-09-09.)
    this.housingRoot = el('div', { cls: 'hud housing', parent: ctx.uiRoot });
    // Phase 8: the 함선 관리 screen (방 목록 + 가구 카드 바) lives in that layer so it survives the same gating.
    this.shipManage = new ShipManage(this.housingRoot);
    // 2026-09-12: 가구를 꾹 누르면 커서를 중심으로 차오르는 링 — 같은 층이라 시설 관리 화면과 함께 산다.
    this.cursorHold = new CursorHoldGauge(this.housingRoot);

    // 재료 요구 칩 hover card: a direct child of `#ui-root` so it floats over the inventory window, the 함선 관리
    // screen and every menu — it delegates on `.item-chip[data-def-id]` wherever a chip is rendered.
    this.itemTip = new ItemTip(ctx.uiRoot);
    // 2026-09-12 (E2): 칩 즐겨찾기 우클릭 메뉴 — same delegation on `ctx.uiRoot`, and the chip favorite source it registers.
    this.itemFavMenu = new ItemFavoriteMenu(ctx.uiRoot);
    // 키 가이드 (2026-09-09): same placement rationale — the bottom-right one-liner must sit over every open screen.
    this.keyGuide = new KeyGuide(ctx.uiRoot);
    // 구조선 대상 선택 (2026-09-09): a full-screen picker, so it hangs off `#ui-root` like the map / menus.
    this.rescuePick = new RescuePicker(ctx.uiRoot);
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
    // 2026-09-09: 타이틀의 `설정` 은 일시정지 메뉴와 **같은** 설정 오버레이를 연다 — 조작 다이어그램과
    // `키 설정 변경` 이 타이틀을 떠나 그 안(키 설정 구획)으로 들어갔기 때문이다.
    this.title = new TitleMenu(ctx.uiRoot, () => this.settings.open(), () => { this.settings.open(); this.settings.select('keys'); });
    // B-1 (2026-09-11): 서버 연결 배지 — `#ui-root` 직계 (타이틀 위에서 버튼을 받아야 한다). `서버 설정` 은 같은 설정 오버레이.
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
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor]) c.bind(ctx);
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.bind(ctx);
    for (const c of [this.droneHud, this.scanWarning, this.handHint]) c.bind(ctx);
    this.community.bind(ctx);
    this.netBadge.bind(ctx);
    this.rescuePick.bind(ctx);
    // 2026-09-09 (레이드 플레이 개선): 의사소통 휠 · 재해 HUD · 레이드 알림
    for (const c of [this.comms, this.hazard, this.raidAlerts]) c.bind(ctx);
    for (const m of [this.title, this.pause, this.death, this.complete]) m.bind(ctx);

    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', ({ phase }) => {
        this.deploy.setVisible(phase === 'deploying');
        switch (phase) {
          // Training arena (Phase 7): no extraction — the exit console ends it; world/ updates the subText counter.
          // 2026-09-08: 훈련장의 목표 줄은 `world/TrainingArena.announce()` 가 (모드 · 명중 · 격추 카운터까지
          //   담아) 스스로 쓴다. 강하 시퀀스가 없어지면서 'playing' 이 `world:ready` 와 같은 tick 에 오게 되어,
          //   여기서 덮으면 방금 쓴 카운터가 지워진다. 훈련 ref 가 아예 없는 월드(스켈레톤)만 여기서 채운다.
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
    // 2026-09-12: the vitals block lives in the social layer (up in the ship too); its raid-only stamina bar just idles there.
    if (this.hudVisible || this.socialVisible) this.vitals.update(dt, ctx);
    if (this.hudVisible) {
      this.reticle.update(dt, ctx);
      this.reload.update(dt);
      this.strat.update(ctx);
      this.targeting.update(ctx);
      this.compass.update(ctx);
      this.objective.update(ctx);
      this.pings.update(dt, ctx);
      this.spectate.update(dt, ctx);
      this.implantWidget.update(dt, ctx);
      this.quickStrip.update();
      this.droneHud.update(dt, ctx);
      // 2026-09-11 (C-53): `scanWarning` 은 화면 투영을 하므로 `lateUpdate` 로 옮겼다.
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
    // 함선 관리 hint: two compares per frame, and it must survive a hidden social layer state change.
    this.shipHint.update(ctx);
    // 서버 연결 배지: 함선 · 타이틀에서만 스스로 뜬다 (레이드 HUD 에서는 숨김 — 사용자 결정).
    this.netBadge.update(ctx);
    // 함선 내 점 크로스헤어: same self-gating (phase / blockers / cutscene), one compare per frame.
    this.hubDot.update(ctx);
    // 커뮤니티: same self-gating, plus the P-hold on a 분대 초대 (it needs dt).
    this.community.update(dt, ctx);
    // 구조선 대상 선택: self-gating on `ctx.stratagems.armed === 'rescue_drop' && rescueTarget === null`.
    this.rescuePick.update(dt, ctx);
    // 2026-09-09: 의사소통 휠은 자기 키(H)를 스스로 폴링하므로 레이어 가시성과 무관하게 매 프레임 돈다 —
    // 게이트(`isGameplayActive` + 포인터 락)는 스스로 걸고, 못 쓰게 되면 열린 휠을 아무것도 보내지 않고 접는다.
    this.comms.update(dt, ctx);
    // 환경 재해: `ctx.world.hazard` 가 null 이면 즉시 돌아온다 (world/ 가 아직 만들지 않은 동안).
    this.hazard.update(ctx);
    // 키 가이드: hides under the 일시정지 메뉴 (one blocker lookup per frame).
    this.keyGuide.update();
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
    // 타이틀 흐름: 캐릭터 생성창의 3D 미리보기만 돈다 (닫혀 있으면 즉시 돌아온다).
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
      // 2026-09-12: 드론 스캔 결과 월드 라벨 (DroneHud 가 들고 있다)
      this.droneHud.lateUpdate(ctx);
    }
    if (this.socialVisible) { this.nameplates.lateUpdate(ctx); this.typing.lateUpdate(ctx); }
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
  /** 2026-09-09 의사소통 휠 (H 홀드): 떠 있나 · 가리키는 칸 · 칸 수(4 = 서 있을 때, 2 = 전투불능) (debug / smoke). */
  get isCommsWheelOpen(): boolean { return this.comms.isOpen; }
  get commsWheelHover(): number | null { return this.comms.hoverIndex; }
  get commsWheelSlots(): number { return this.comms.slotCount; }
  /** 2026-09-09 지역 핑 홀드 휠: 떠 있나 · 전투불능 배치인가 (debug / smoke). */
  get isPingWheelOpen(): boolean { return this.pings.isHoldWheelOpen; }
  get isPingWheelDowned(): boolean { return this.pings.isHoldWheelDowned; }
  /** 2026-09-09 환경 재해 HUD: 경고 배너 · 위험 구역 안 · 남은 안전지대 0…1 (debug / smoke). */
  get isHazardBannerOn(): boolean { return this.hazard.isBannerOn; }
  get isInHazard(): boolean { return this.hazard.isInside; }
  get hazardSafeShare(): number { return this.hazard.safeShare; }
  /**
   * 2026-09-12 (캐릭터 버프) — debug / smoke. `localBuffs` = the thumbnails under the PC hp bar, in DOM order
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
  /** 위험 인디케이터 (2026-09-10): 화면 안 머리 + 화면 밖 방향 호 / 추적 중인 위험물 (debug / smoke). */
  get dangerIndicatorCount(): number { return this.danger.visibleCount; }
  get dangerTrackedCount(): number { return this.danger.trackedCount; }
  /** 예전 이름 (2026-09-09 의 포탄 마커) — 위험 인디케이터가 흡수했다. */
  get shellMarkerCount(): number { return this.danger.visibleCount; }
  /** 임플란트 썸네일 (2026-09-10, 중앙 하단): 무엇을 · 어떤 유형으로 · 얼마나 차 있나 (debug / smoke). */
  get implantHudId(): string | null { return this.implantWidget.shownId; }
  get implantHudKind(): string { return this.implantWidget.displayKind; }
  get implantHudFill(): number { return this.implantWidget.fillAmount; }
  get isImplantHudDimmed(): boolean { return this.implantWidget.isDimmed; }
  /** 크로스헤어 좌측 갈고리 칩: 'off' | 'dim' | 'ready' (debug / smoke). */
  get grappleChip(): 'off' | 'dim' | 'ready' { return this.reticle.grappleChip; }
  /** Unique-weapon charge gauge kind while showing, else null (debug). */
  get weaponChargeKind(): 'charge' | 'spinup' | 'slash' | null { return this.wcharge.activeKind; }
  /** Live 전소 / 감전 world markers (debug). */
  get statusMarkerCount(): number { return this.statusMarkers.activeCount; }
  /** Whether the weapon panel shows unique fire-mode lines (debug). */
  get hasWeaponModes(): boolean { return this.weapon.hasModes; }
  /** Whether the `MOVE CHEAT` tag is on (debug). */
  get isMoveCheatTagOn(): boolean { return this.cheatTag.isOn; }
  /** Whether the housing hint bar is showing (debug). */
  /** 키 가이드 (2026-09-09): owner on top of the stack / entries as rendered (close entry last) / visibility. */
  get keyGuideOwner(): string | null { return this.keyGuide.owner; }
  get keyGuideOwners(): readonly string[] { return this.keyGuide.owners; }
  get keyGuideEntries(): readonly KeyGuideEntry[] { return this.keyGuide.entries; }
  get isKeyGuideOn(): boolean { return this.keyGuide.isShowing; }
  /** Whether the room label is up (debug). */
  get isRoomLabelOn(): boolean { return this.roomLabel.isShowing; }
  /** Whether the 설정 overlay is open / which of its three sections the right pane shows (debug). */
  get isSettingsOpen(): boolean { return this.settings.isOpen; }
  get settingsSection(): string { return this.settings.activeSection; }
  /** 타이틀 흐름 (2026-09-09): 캐릭터 선택 / 생성 화면이 떠 있는가 (debug / smoke). */
  get isCharacterSelectOpen(): boolean { return this.title.isSelectOpen; }
  get isCharacterCreateOpen(): boolean { return this.title.isCreateOpen; }
  /** 옛 키 설정 알림 (2026-09-11, C-9 · X-8): 부팅 리포트 · 카드 줄 · 카드가 떠 있나 (debug / smoke). */
  get keybindNotice(): { report: KeybindLoadReport | null; lines: readonly string[]; on: boolean } {
    const n = this.title.keybindNotice;
    return { report: n.report, lines: n.lines, on: n.isOn };
  }
  /** Whether the 함선 관리 screen is showing / which room it edits / how many furniture cards it renders (debug). */
  get isShipManageOn(): boolean { return this.shipManage.isShowing; }
  get shipManageRoom(): number | null { return this.shipManage.activeRoom; }
  get shipManageCardCount(): number { return this.shipManage.cardCount; }
  /** Def id the 재료 요구 칩 hover card is describing, null when it is hidden (debug). */
  get itemTipDefId(): string | null { return this.itemTip.shownDefId; }
  /** Whether the 함선 관리(M) hint is showing (debug). */
  get isShipHintOn(): boolean { return this.shipHint.isShowing; }
  /** Phase 12 debug: compass enemy ticks / on-screen enemy chevrons / live 정찰 reveals / the channel ticker text. */
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
  /** 2026-09-12: the cursor-centred 가구 꾹 누르기 ring (`housing:moveHold`) — showing, and its fill (−1 when hidden). */
  get isCursorHoldOn(): boolean { return this.cursorHold.isShowing; }
  get cursorHoldProgress(): number { return this.cursorHold.progress; }
  get shipManageConfirmPurpose(): string | null { return this.shipManage.confirmPurpose; }
  /** Whether the pause menu is in its ship variant (debug). */
  get isPauseHubVariant(): boolean { return this.pause.isHubVariant; }
  /** 2026-09-08: whether the 일시정지 메뉴's 경고 팝업 (파티 떠나기 / 타이틀로 / 게임 종료) is up (debug / smoke). */
  get isPauseAskOpen(): boolean { return this.pause.isAskOpen; }
  /** 2026-09-09: 경고 팝업의 1초 홀드 진행도 0…1 (debug / smoke) — 확정은 클릭이 아니라 홀드다. */
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
  /** 2026-09-08 홀드 링 (상호작용 / 포기) — smoke hooks. */
  get isHoldGaugeOn(): boolean { return this.hold.isShowing; }
  get holdGaugeProgress(): number { return this.hold.progress; }
  get isHoldGaugeGiveUp(): boolean { return this.hold.isGiveUp; }
  /** 2026-09-09 함선 내 점 크로스헤어 — smoke hook. */
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
   * `inMission` flipped by the test) and a synthetic `LobbyState` to the nameplates, the 입력 중 말풍선 and the
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
   * `mySquad` is the member count of *my* lobby, which `playBlockReason` needs to judge 같이 하기.
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

  /** Mutations the synthetic social ref received, newest last (debug; empty in a real session). */
  get debugSocialLog(): readonly { m: string; args: unknown[] }[] { return debugSocialCalls; }
  /** 커뮤니티 widget / panel / invite state (debug, Phase 11). */
  get isCommunityOn(): boolean { return this.community.isShowing; }
  /** B-1 (2026-09-11): 서버 연결 배지 — 떠 있나 · 두 줄 · 타이틀 버튼이 보이나 (debug / smoke). */
  get netBadgeState(): { on: boolean; main: string; sub: string; actions: boolean } {
    return { on: this.netBadge.isShowing, main: this.netBadge.mainText, sub: this.netBadge.subText, actions: this.netBadge.hasActions };
  }
  get isCommunityOpen(): boolean { return this.community.isOpen; }
  /** 2026-09-09: 구조선 대상 선택 화면이 떠 있나 / 고를 수 있는 칸 수 (debug / smoke). */
  get isRescuePickerOpen(): boolean { return this.rescuePick.isOpen; }
  get rescuePickerSelectable(): number { return this.rescuePick.selectableCount; }
  get communityInviteCount(): number { return this.community.inviteCount; }
  get communityHoldProgress(): number { return this.community.holdProgress; }
  /** 귓속말 target of the chat input, null when it is ordinary squad chat (debug, Phase 11). */
  get chatWhisperTarget(): string | null { return this.chat.whisperTarget; }
  /** 입력 중 말풍선 — who has one showing right now (debug / smoke, 2026-09-11 B-11). */
  get typingBubbleIds(): readonly PeerId[] { return this.typing.visibleIds; }

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
    for (const c of [this.reticle, this.cook, this.wheel, this.swheel, this.strat, this.charge, this.targeting, this.offscreen, this.danger, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.typing, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.chat, this.deploy, this.map]) c.dispose();
    for (const c of [this.implantWidget, this.quickStrip, this.detection, this.scanReveal, this.deployables, this.progressToasts, this.actionFx]) c.dispose();
    this.scanTracker.dispose();
    this.cutscene.dispose();
    for (const c of [this.wcharge, this.statusMarkers, this.cheatTag, this.roomLabel, this.shipManage, this.shipHint, this.itemTip, this.itemFavMenu, this.keyGuide]) c.dispose();
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor, this.hubDot]) c.dispose();
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.dispose();
    for (const c of [this.droneHud, this.scanWarning, this.handHint]) c.dispose();
    this.community.dispose();
    this.netBadge.dispose();
    this.rescuePick.dispose();
    for (const c of [this.comms, this.hazard, this.raidAlerts]) c.dispose();
    for (const m of [this.title, this.pause, this.death, this.complete]) m.dispose();
    this.settings.dispose();
    this.keybinds.dispose();
    this.hudRoot.remove(); this.socialRoot.remove(); this.overlayRoot.remove(); this.housingRoot.remove();
  }
}
