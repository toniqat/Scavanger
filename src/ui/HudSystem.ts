import type { CharBuff, GameContext, GameSystem, KeybindLoadReport, KeyGuideEntry, LobbyState, PeerId, RemotePlayerRef, SocialSnapshot, SquadInvite } from '@/shared';
import { el, toggleClass } from './dom';
/* 2026-09-13 (탈출 개편): 이륙 연출 동안 전투 HUD 페이드 시간 */
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
import { FallVignette } from './hud/FallVignette';
import { Deployables } from './hud/Deployables';
import { ProgressToasts } from './hud/ProgressToasts';
import { ActionFeedback } from './hud/ActionFeedback';
import { WeaponChargeGauge } from './hud/WeaponChargeGauge';
import { StatusMarkers } from './hud/StatusMarkers';
import { CheatTag } from './hud/CheatTag';
import { KeyGuide } from './hud/KeyGuide';
import { ItemTip } from './hud/ItemTip';
import { MusicPlayer } from './hud/MusicPlayer';               // 음악 재생 창 (2026-09-14)
import { ItemFavoriteMenu } from './hud/ItemFavoriteMenu';
import { GameCursor } from './hud/GameCursor';
import { ShipManage } from './hud/ShipManage';
import { CursorHoldGauge } from './hud/CursorHoldGauge';
import { ShipManageHint } from './hud/ShipManageHint';
import { Community } from './hud/Community';
import { setDebugSocial, setDebugSocialRef, debugSocialCalls } from './menus/social/socialSource';
/* 2026-09-14: 메신저 — NPC · 단체방 창구 스모크 훅 */
import type { NpcQuestRef, RoomsRef } from '@/shared';
import { setDebugNpc, setDebugRooms } from './menus/messenger/sources';
import type { Messenger } from './menus/messenger/Messenger';
import type { SocialRef, WhisperLine } from '@/shared';
import { RoomLabel } from './hud/RoomLabel';
import { ContractPanel } from './hud/ContractPanel';
import { TrainingPanel } from './hud/TrainingPanel';
import { MetaToasts } from './hud/MetaToasts';
/* 2026-09-11: 드론 조종 HUD · 로든 스캔 경고 · 손에 든 가젯 안내(설치 · 기폭 · 드론 조종) */
import { DroneHud } from './hud/DroneHud';
import { RoverHud } from './hud/RoverHud';
import { NamedScanWarning } from './hud/NamedScanWarning';
import { GadgetHandHint } from './hud/GadgetHandHint';
/* 2026-09-11 (B-1): 서버 연결 배지 (함선 · 타이틀 우측 상단) */
import { NetBadge } from './hud/NetBadge';
/* 2026-09-15 (레이드 진입 로딩): 암전 위에서 도는 우측 하단 원형 게이지 */
import { LoadingGauge } from './hud/LoadingGauge';
import { ShipReturn } from './menus/ShipReturn';
/* 2026-09-15 (안드로이드 분대원): ui 가 `ctx.allies` 를 읽는 유일한 창구 (스모크가 가짜 ref 를 꽂는다) */
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
  /** 2026-09-14: 화면 전체 검은 페이드 (`ui:screenFade`) — 연출 전용 판, blocker 가 아니다. */
  private screenFade!: HTMLElement;
  private fadeOpacity = 0;
  /** 2026-09-15 (B-14): 낙하 붉은 비네트 (`player:fell`) — `#ui-root` 직계 z 25, 연출 전용 판. */
  private fallVignette!: FallVignette;
  /** 2026-09-15: 레이드 진입 로딩 게이지 — `#ui-root` 직계 z 87 (검은 페이드 82 위에서 돈다). */
  private loadingGauge!: LoadingGauge;
  /** 2026-09-16: 결과 화면 → 함선 귀환 암전 (`ui:shipReturn`, `menus/ShipReturn`). */
  private shipReturn!: ShipReturn;
  /** 2026-09-14: 지금 판에 칠해진 불투명도 · 전이의 시작값 · 경과 · 길이 — CSS 전이 대신 `update` 가 옮긴다. */
  private fadeShown = 0;
  private fadeFrom = 0;
  private fadeT = 0;
  private fadeDur = 0;
  /**
   * 2026-09-15 (`ui:screenFade.hold`): 이 판은 **페이즈가 바뀌어도 스스로 걷히지 않는다** — 튜토리얼 레이드
   * 건너뛰기가 「암전된 채로 결과 화면」을 위해 건다. 건 쪽이 `{opacity: 0}` 으로 걷고, `game:abort` ·
   * `hub:entered` 는 여기서 무조건 걷는다 (함선이 검게 남는 길이 없다).
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
  /** 2026-09-09: 새 랜드마크 발견 · 레이더 강하(옛 로그 강하) 예고 토스트 (DOM 없음 — `ui:notify` 로만 나간다). */
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
  /** 2026-09-13: 탐사 차량 탑승 HUD. */
  private roverHud!: RoverHud;
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
  /* 2026-09-14: 음악 재생 창 (#ui-root 직계, 함선 좌측 상단 — `housing:musicChanged` 만 보고 그린다) */
  private musicPlayer!: MusicPlayer;
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
  /** 2026-09-13: the departure cinematic owns the screen (`ui:cinematic`) — combat HUD faded out (`styles/raidHud.css`). */
  private cinematic = false;
  /**
   * 2026-09-16 (사용자 결정 — 이륙 연출에서 **남은 HUD 전부** 사라진다): 가린 정도 0 (다 보임) … 1 (다 숨음).
   * `update` 가 `EXTRACTION_HUD_FADE_S` 에 걸쳐 올리고 `#ui-root` 의 `--cine-o` 로 칠한다 (`setCinematic` 주석).
   */
  private cineHide = 0;

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
    // 2026-09-13: 탐사 차량 탑승 HUD — 탄 동안만 뜨고 게임플레이 레이어에 `rover-view` 를 건다.
    this.roverHud = new RoverHud(this.hudRoot);
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
    // 2026-09-16: 일시정지 메뉴 위에도 선다 — 메뉴가 그 자체로 떠 있을 때만 (설정 오버레이 · 경고 팝업이 위에 없을 때). 늦게 읽는다.
    this.community = new Community(this.socialRoot, this.cutscene,
      () => !!this.pause?.visible && !this.pause.isAskOpen && !(this.settings?.isOpen ?? false));

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
    // 음악 재생 창 (2026-09-14): same placement rationale — 함선의 다른 화면(인벤토리 · 지도) 위에 떠 있어야 한다.
    this.musicPlayer = new MusicPlayer(ctx.uiRoot);
    // 2026-09-12 (E2): 칩 즐겨찾기 우클릭 메뉴 — same delegation on `ctx.uiRoot`, and the chip favorite source it registers.
    this.itemFavMenu = new ItemFavoriteMenu(ctx.uiRoot);
    // 키 가이드 (2026-09-09): same placement rationale — the bottom-right one-liner must sit over every open screen.
    this.keyGuide = new KeyGuide(ctx.uiRoot);
    // 구조선 대상 선택 (2026-09-09): a full-screen picker, so it hangs off `#ui-root` like the map / menus.
    this.rescuePick = new RescuePicker(ctx.uiRoot);
    // 인게임 마우스 커서 sprite: same placement rationale as the item card — over every window, layer and menu.
    this.gameCursor = new GameCursor();

    /* ── 화면 전체 검은 페이드 (2026-09-14, `ui:screenFade`) ──────────────────────────────────────────────
     * 튜토리얼 오프닝(눈을 뜬다)이 첫 사용자다. **연출이지 blocker 가 아니다** — 포인터를 먹지 않고
     * (`pointer-events: none`) `ctx.escape` · `ctx.uiBlockers` 에 올라가지 않는다. 그래서 페이드가 1.0 이어도
     * 입력 · ESC 는 평소 그대로 흐른다. 자리 · 불투명도 전이는 `styles/base.css` 의 `.screen-fade` 가 갖는다. */
    this.screenFade = el('div', { cls: 'screen-fade', parent: ctx.uiRoot });
    /* 2026-09-15 (B-14): 낙하 붉은 비네트 — 같은 성격(연출 · 포인터 안 먹음)이지만 z 25 라 HUD 레이어 위 · 열린 화면 아래다
     * (근거는 `styles/fall.css` 머리). 세기와 사라짐은 `update(dt)` 가 인라인으로 쓴다. */
    this.fallVignette = new FallVignette(ctx.uiRoot);
    /* 2026-09-15 (레이드 진입 로딩): 같은 이유로 `#ui-root` 직계다 — 검은 페이드(z 82) **위**에서 돌아야 한다.
     * 이것도 연출이지 화면이 아니다 (blocker · escape 없음, 포인터를 먹지 않는다). */
    this.loadingGauge = new LoadingGauge(ctx.uiRoot);
    // 2026-09-16: 결과 화면의 `함선으로 귀환` — 같은 검은 판과 같은 게이지를 쓴다 (판은 버스가 아니라 직접 칠한다: `ShipReturn` 머리 주석)
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
    this.musicPlayer.bind(ctx);                                // 음악 재생 창 (2026-09-14)
    this.fallVignette.bind(ctx);                               // 낙하 붉은 비네트 (2026-09-15)
    this.loadingGauge.bind(ctx);                               // 레이드 진입 로딩 게이지 (2026-09-15)
    for (const c of [this.reload, this.heal, this.hold, this.gameCursor]) c.bind(ctx);
    for (const c of [this.contractPanel, this.trainingPanel, this.metaToasts]) c.bind(ctx);
    for (const c of [this.droneHud, this.scanWarning, this.handHint, this.roverHud]) c.bind(ctx);
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
      // 2026-09-13 (탈출 개편): 출발 유예 · 남겨진 뒤 다시 찾기 · 이륙 연출이 전투 HUD 를 가져간다
      b.on('extraction:departureStarted', () => this.setObjective(OBJECTIVE_TEXT.departing)),
      b.on('extraction:reset', () => { if (ctx.missionMode !== 'training') this.setObjective(OBJECTIVE_TEXT.find); }),
      b.on('ui:cinematic', ({ active }) => this.setCinematic(active)),
      b.on('game:abort', () => this.setCinematic(false)),
      b.on('game:newMission', () => this.setCinematic(false)),
      /* 2026-09-17: 레이드가 끝나는 **그 emit 안에서** 연출을 끈다. `applyVisibility` 의 페이즈 가드도 같은 일을 하지만
       * 그것은 다음 프레임이고, 이륙 연출을 끝내는 `extraction:liftoff` → `complete()` 는 hud 뒤에 등록된 시스템의
       * update 에서 나므로 결과 화면이 뜬 프레임에는 아직 `--cine-o` 가 0(다 숨김)이다 — 그 한 프레임 동안 결과 화면
       * 뒤의 HUD · 키 가이드 · 아이템 카드가 사라진 채로 남는다 (`smoke-tutorial-raid` 의 「HUD 페이드 값이
       * 되돌아간다」가 레인이 느릴수록 자주 빨강이던 이유). 가드는 그대로 두 번째 방어로 남는다. */
      b.on('game:complete', () => this.setCinematic(false)),
      b.on('game:over', () => this.setCinematic(false)),
      /* 2026-09-14: 화면 전체 검은 페이드. `game:newMission` 은 **일부러 듣지 않는다** — `world:ready` 가 그
       * 이벤트 안에서 동기로 발행되므로(`hud/Compass` 주석), 월드가 뜨자마자 켜는 오프닝 페이드를 우리가 도로
       * 지워 버린다. 방어는 `game:abort` 와 아래 `applyVisibility` 의 페이즈 가드 둘이면 충분하다. */
      /* 2026-09-16: 함선 귀환 암전이 판을 쥔 동안(`shipReturn.ownsPlate`)은 남의 요청 · 중단 · 도착이 판을 걷지 않는다 —
       * 그 암전이 낸 `hub:enter` 가 동기로 `game:abort` · `hub:entered` 를 내고, 튜토리얼도 거기서 `{0, 0}` 을 보낸다. */
      b.on('ui:screenFade', ({ opacity, durationS, hold }) => { if (!this.shipReturn.ownsPlate) this.setScreenFade(opacity, durationS, hold ?? false); }),
      b.on('ui:shipReturn', () => this.shipReturn.start()),
      b.on('game:abort', () => { if (!this.shipReturn.ownsPlate) this.setScreenFade(0, 0); }),
      /* 2026-09-15: `hold` 로 걸어 둔 판도 **함선에 들어서면 반드시** 걷는다 — 걸어 둔 쪽이 어떤 이유로 못 걷어도
       * 함선이 검게 남지 않는다 (`game:abort` 와 같은 자리의 같은 방어). `hold` 가 아닌 판은 이미 페이즈
       * 가드(`applyVisibility`)가 걷은 뒤라 이 줄은 아무 일도 하지 않는다. */
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
   * 2026-09-16 (사용자 결정 — 「이륙이 시작되면 남은 HUD 가 전부 사라진다」, 튜토리얼 · 분대 포함): 위의 「채팅 · 알림 · 분대
   * 목록은 남는다」를 뒤집었다. 이제 `.cinematic` 은 **크로스헤어 · 링만 즉시** 숨기고(`styles/raidHud.css` — 「함선이 뜨는데
   * 크로스헤어가 보인다」 신고), 나머지는 `#ui-root` 의 `.hud-cine` 가 한꺼번에 페이드한다: 네 `.hud` 레이어(오버레이 · 게임플레이 ·
   * 소셜 · 하우징) + `#ui-root` 직계의 키 가이드 · 아이템 카드 · 음악 창 · 서버 배지. 3D 빛기둥(`Detection` · `ScanReveal` ·
   * `Deployables`)은 같은 값으로 재질 불투명도를 줄인다. 튜토리얼 DOM 은 tutorial/ 이 같은 이벤트를 듣고 스스로 접는다.
   * **남는 것**: 검은 페이드 · 로딩 게이지 · 메뉴(일시정지 · 설정 · 결과 화면) · 지도 같은 화면 — 목록에 없으므로 그대로다.
   *
   * 페이드는 **코드가 민다** (`stepCinematic`): reduced motion 이면 CSS 전이가 0.01 ms 로 잘려 한 프레임에 꺼진다(이 PC).
   * 값은 `filter: opacity(var(--cine-o))` 로 칠한다 — `opacity` 가 아니라서 `.hud.hidden` · 위젯의 인라인 opacity 와 **곱해지고**
   * (숨은 것이 연출 첫 프레임에 보이는 일이 없다), 어느 `.hud` 전이 목록에도 없어 프레임마다 바뀌어도 늦게 따라가지 않는다.
   * 다 숨으면 `.hud-cine-out` 이 `visibility: hidden` 까지 건다. 되돌림(`false` · 중단 · 새 미션 · 페이즈 이탈)은 즉시다.
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

  /** 이륙 연출 페이드를 한 프레임만큼 민다 (다 숨었거나 연출이 아니면 비교 하나). */
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
   * 2026-09-14 — **화면 전체 검은 페이드** (`ui:screenFade {opacity, durationS}`, 첫 사용자는 튜토리얼 오프닝).
   * `durationS` 에 걸쳐 **지금 칠해진 값에서** 그 불투명도로 간다; 0 이면 그 자리에서 즉시다.
   *
   * **CSS 전이를 쓰지 않는다** (2026-09-14 수정): OS 가 애니메이션 효과를 끄면 `styles/base.css` 의 reduced-motion
   * 규칙이 모든 `transition-duration` 을 0.01 ms 로 자르고, 그러면 검정이 한 프레임에 사라져 「페이드가 안 된다」가
   * 됐다 (이 개발 PC 가 그 설정이었다). 그래서 `update` 가 시뮬레이션 dt 로 선형 보간해 인라인 opacity 를 쓴다 —
   * 일어나는 연출과 같은 시계라 일시정지 · 셰이더 hold 동안 둘이 함께 멈춘다.
   *
   * 이것은 **연출이지 화면이 아니다**: blocker 도, `ctx.escape` 스택의 항목도 아니고 포인터를 먹지도 않는다.
   * 그래서 부르는 쪽(player/ 의 기상 연출)은 입력 잠금을 자기 폴더에서 따로 건다.
   *
   * 2026-09-15 — `hold` 면 아래 `applyVisibility` 의 페이즈 가드가 이 판을 걷지 않는다 (튜토리얼 건너뛰기의
   * 「암전된 채로 결과 화면」). **투명해지는 요청은 언제나 hold 를 푼다** — 0 으로 가는 판을 붙잡을 이유가 없다.
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

  /** 한 프레임만큼 검은 판을 목표로 옮긴다 (이미 닿았으면 비교 하나로 끝). */
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

  /** Smoke hook: the black plate's target opacity (0 = 화면이 열려 있다). */
  get screenFadeOpacity(): number { return this.fadeOpacity; }
  /** Smoke hook (2026-09-15, B-14): the fall vignette's current opacity (0 = off). */
  get fallVignetteOpacity(): number { return this.fallVignette.opacity; }
  /** Smoke hook (2026-09-14): the opacity actually painted this frame (moves toward `screenFadeOpacity`). */
  get screenFadeShown(): number { return this.fadeShown; }
  /** Smoke hook (2026-09-15): the plate is held across phase changes (`ui:screenFade.hold`). */
  get screenFadeHeld(): boolean { return this.fadeHold; }

  update(dt: number, ctx: GameContext): void {
    this.applyVisibility();
    // 2026-09-14: 검은 페이드는 CSS 전이가 아니라 여기서 옮긴다 (`setScreenFade` 주석 — reduced motion)
    this.stepScreenFade(dt);
    // 2026-09-16: 이륙 연출의 HUD 페이드도 같은 이유로 코드가 민다 (`setCinematic` 주석)
    this.stepCinematic(dt);
    // Map polls M and draws itself while open (also handles its own blocker token).
    this.map.update(ctx);
    // 2026-09-13: 탐사 차량 탑승 HUD — 레이어 가시성과 무관하게 돈다 (키 가이드 · `rover-view` 를 제때 걷어야 한다)
    this.roverHud.update(dt, ctx);
    // 2026-09-12: the vitals block lives in the social layer (up in the ship too); its raid-only stamina bar just idles there.
    if (this.hudVisible || this.socialVisible) this.vitals.update(dt, ctx);
    if (this.hudVisible) {
      this.reticle.update(dt, ctx);
      this.reload.update(dt);
      this.strat.update(ctx);
      this.targeting.update(ctx);
      this.compass.update(ctx, dt);   // 2026-09-14: dt = 기상 연출 뒤 서서히 나타나기
      this.objective.update(ctx);
      this.pings.update(dt, ctx);
      this.spectate.update(dt, ctx);
      this.implantWidget.update(dt, ctx);
      this.quickStrip.update();
      this.weapon.update(ctx);   // 2026-09-16: 들고 있는 주무기 슬롯 · 흐림 · 옆 썸네일 (`ctx.weapons.activeSlot` / `primaryInHand`)
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
    // 2026-09-16: 토스트 스택은 튜토리얼 조작 가이드 패널이 떠 있으면 그 아래에서 시작한다 (없으면 비교 하나).
    this.notifs.update();
    // 음악 재생 창: 꺼져 있으면 비교 둘로 끝난다 (함선 전용 · 메뉴 blocker 아래에서 숨는다 — 키 가이드와 같은 규칙).
    this.musicPlayer.update(ctx);
    this.contractPanel.update(ctx);
    this.trainingPanel.update(ctx);
    this.metaToasts.update(dt);
    // Self-gating components (they hide their own world meshes / markers outside gameplay).
    this.deployables.update(dt, ctx);
    this.actionFx.update(dt, ctx);
    this.scope.update(ctx);
    this.damage.update(dt, ctx);
    // 낙하 비네트: 꺼져 있으면 비교 하나로 끝난다 (레이어 가시성과 무관 — 사라지는 도중 메뉴가 떠도 제 시간에 꺼진다).
    this.fallVignette.update(dt);
    /* 2026-09-15: 로딩 게이지는 **dt 를 받지 않는다** — 로딩 게이트가 엔진을 잡고 있는 동안 dt 가 0 이라
     * 시뮬레이션 시계로는 한 프레임도 움직이지 않는다 (`hud/LoadingGauge` 머리 주석). 꺼져 있으면 비교 하나. */
    this.loadingGauge.update();
    // 2026-09-16: 함선 귀환 암전 — 실시간 시계 (hold 동안 dt 0), 도는 중이 아니면 비교 하나
    this.shipReturn.update();
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
    // 2026-09-16: 3D 빛기둥 · 지뢰 반경 링도 이륙 연출의 HUD 페이드를 따라간다 (0 이면 숨는다)
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
  /** 2026-09-13 (smoke): 지도가 탐사 차량 목적지 선택 모드인가 · 고른 정류장 · 보이는 범례 줄 · 탑승 HUD. */
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
  /** 2026-09-14 크로스헤어 활 모드: `{on, draw (0 = 아래 단 … 1 = 중앙), full}` (debug / smoke). */
  get bowReticle(): { on: boolean; draw: number; full: boolean } {
    return { on: this.reticle.bowMode, draw: this.reticle.bowDraw, full: this.reticle.bowFull };
  }
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
  /** 2026-09-15 (타이틀 이어하기 · 레이드 포기, debug / smoke): `이어하기` · 경고색 `게임 시작` · 포기 팝업 · 홀드 진행도. */
  get titleResume(): { resume: boolean; warn: boolean; ask: boolean; hold: number } { return this.title.resumeView; }
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
  /** 음악 재생 창 (debug, 2026-09-14): 떠 있는가 · 곡 제목 · 아티스트 · 음량 줄. */
  get musicPlayerView(): { on: boolean; title: string; artist: string; volume: string } {
    return { on: this.musicPlayer.isShowing, title: this.musicPlayer.titleText, artist: this.musicPlayer.artistText, volume: this.musicPlayer.volumeText };
  }
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

  /** 2026-09-14 (메신저): install any `NpcQuestRef` as `ctx.meta.npc` for the messenger (null hands it back). */
  debugNpc(ref: NpcQuestRef | null): void { setDebugNpc(ref); }
  /** 2026-09-14 (메신저): install any `RoomsRef` as `ctx.net.rooms` for the messenger (null hands it back). */
  debugRooms(ref: RoomsRef | null): void { setDebugRooms(ref); }
  /** 2026-09-14: the messenger body — tabs, 대화 / 퀘스트 tabs, 친구 tab column (debug / smoke). */
  get messenger(): Messenger { return this.community.messenger; }
  /** 2026-09-14: the messenger thumbnail's unread count badge (debug / smoke). */
  get messengerUnreadBadge(): number { return this.community.unreadBadge; }

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
  /** 개인 대화 target of the chat input, null when it is ordinary squad chat (debug, Phase 11). */
  get chatWhisperTarget(): string | null { return this.chat.whisperTarget; }
  /** 입력 중 말풍선 — who has one showing right now (debug / smoke, 2026-09-11 B-11). */
  get typingBubbleIds(): readonly PeerId[] { return this.typing.visibleIds; }

  /* ── 2026-09-15: 안드로이드 분대원 · 레이드 진입 로딩 (debug / smoke) ────────────────────────────────── */

  /**
   * Smoke hook: install any `AlliesRef` as `ctx.allies` for every ui reader (분대 목록 · 이름표 · 지도 · 나침반 ·
   * 범례). `null` hands the UI back to the real `ctx.allies`. Same shape as `debugSocial` / `debugNpc`.
   */
  debugAllies(ref: AlliesRef | null): void { setDebugAllies(ref); }
  /** 분대 목록의 보이는 행들 (사람 + 안드로이드), DOM 순서. */
  get squadRows(): Array<{ id: string; name: string; badge: string; state: string; hp: string; shield: string; android: boolean }> { return this.squad.rowStates; }
  /** 안드로이드 이름표 — id · 이름 · 꼬리표 · 체력 · 실드 · 보이는가. */
  get allyNameplates(): Array<{ id: string; name: string; tag: string; hp: string; shield: string; shown: boolean }> { return this.nameplates.allyPlateStates; }
  /** 채팅 로그의 줄들 — 클래스 · 이름 · 본문. */
  get chatLines(): Array<{ cls: string; who: string; text: string }> { return this.chat.lineStates; }
  /** 지금 떠 있는 토스트의 글자. */
  get toastTexts(): string[] { return this.notifs.toastTexts; }
  /** 핑 목록 (주인 · 종류 · 라벨) — 안드로이드 핑은 `owner.android` 가 true. */
  get pingViews(): readonly PingView[] { return this.pings.getPings(); }
  /** 레이드 진입 로딩 게이지 — 보이는가 · 채움 0…1 · 대기 인원 · 불투명도 · 도는 각도. */
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
    /* 2026-09-14: 검은 페이드도 레이드보다 오래 살지 않는다 — 같은 자리의 같은 방어다. 다만 기준은 `inGame`
     * (게임플레이 + `deploying`)이다: 오프닝 페이드는 강하 · 월드 준비 구간에 걸쳐 있어, `isGameplayPhase()`
     * 하나로 자르면 켜자마자 다음 프레임에 지워진다. 결과 화면 · 함선 · 타이틀 · 사망 화면에서는 즉시 걷힌다.
     *
     * 2026-09-15 — **`hold` 로 건 판은 예외다** (튜토리얼 레이드 건너뛰기): 결과 화면으로 페이즈가 바뀌는 순간
     * 검정을 걷으면 결과 창 뒤로 행성이 다시 보인다. 건 쪽이 걷거나, `game:abort` · `hub:entered` 가 걷는다. */
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
    this.musicPlayer.dispose();                                // 음악 재생 창 (2026-09-14)
    this.fallVignette.dispose();                               // 낙하 붉은 비네트 (2026-09-15)
    this.shipReturn.dispose();
    this.loadingGauge.dispose();                             // 레이드 진입 로딩 게이지 (2026-09-15)
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
