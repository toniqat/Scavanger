import * as THREE from 'three';
import type {
  GameContext, GameSystem, Interactable, ExtractionPointDef, PeerId, ExtractionMessage, ExtractionRequest, ExtractionSyncState,
  ExtractionRef, ExtractionStage,
} from '@/shared';
import {
  EXTRACTION_AUTO_DEPART_IDLE_S, EXTRACTION_COUNTDOWN, EXTRACTION_DEPART_GRACE_S, EXTRACTION_LIFTOFF_TO_COMPLETE_S, PlayerFlags,
} from '@/shared';
import { ExtractionConsole } from './Console';
import { BAY_HALF_W, BAY_Z_MAX, BAY_Z_MIN, Dropship, LIFTOFF_SPOOL_S } from './Ship';
import { FlareColumn, DustRing } from './Particles';
import { ShipHull } from './Hull';
import { DepartureCinematic } from './Cinematic';

const SHIP_INCOMING_AT = 12;      // seconds remaining when the ship starts its approach
const APPROACH_DURATION = 8;      // approach phase; descent (4.2 s) follows → touchdown ≈ 0 s
/** Host → clients countdown / departure resync interval (seconds). Clients decrement locally in between. */
const NET_TICK_INTERVAL = 0.5;
/** Host → clients auto-departure idle timer resync interval (seconds). */
const NET_WAIT_INTERVAL = 1.0;
/** Client: after the host reports touchdown, force-place the ship if it has not landed locally within this time. */
const NET_LAND_FALLBACK = 1.0;
/** Id used for the local player in the boarded set when there is no network id. */
const LOCAL_ID = 'local';
/**
 * 2026-09-13: seconds after the liftoff when the flow resets for everyone the ship left behind. **Later than the riders'
 * result screen** (`EXTRACTION_LIFTOFF_TO_COMPLETE_S`): an extracted host leaves the mission there, so by the time the
 * remaining squad resets, the host role has already moved to one of them and a console press reaches a host that can act.
 */
const LEFT_BEHIND_RESET_S = EXTRACTION_LIFTOFF_TO_COMPLETE_S + 1;
/** Client: extra wait over the host's reset before resetting on its own (the host may be the one who left). */
const CLIENT_RESET_SLACK_S = 0.5;

const _v = new THREE.Vector3();

interface PadEntry {
  def: ExtractionPointDef;
  console: ExtractionConsole;
  interactableId: string;
}

/**
 * Extraction flow: pad consoles → countdown + flare → ship flight-in / landing → boarding → **departure grace** → liftoff.
 * Emits the `extraction:*` events; GameFlowSystem owns the phase transitions.
 *
 * 2026-09-13 (탈출 개편, 사용자 결정):
 *   - No defense. `EXTRACTION_COUNTDOWN` (20 s) is just the wait for the ship.
 *   - Touchdown → `EXTRACTION_AUTO_DEPART_IDLE_S` (60 s). Any living boarded player holding the interior switch — or that
 *     timer running out — starts an uncancellable `EXTRACTION_DEPART_GRACE_S` (10 s) grace. People may still board.
 *     At 0 the ship leaves with **whoever is aboard and alive** (possibly nobody).
 *   - Riders: controls off, attached to the ship, `DepartureCinematic` takes the camera, `ui:cinematic` fades the HUD.
 *   - Everyone else keeps playing. `LEFT_BEHIND_RESET_S` after the liftoff their flow resets (`extraction:reset`) and any
 *     console can call a new ship. When nobody alive stays behind (`squadDone`) the raid ends for all, as before.
 *   - The landed hull is a set of world colliders (`Hull.ts`) and the bay is closed to enemies only (`ctx.extraction`).
 *   - A corpse lying in the bay rides with the ship and is gone with it (`CorpsesRef.attachCorpse` / `removeCorpse`).
 *
 * Multiplayer (all gated on `ctx.isMultiplayer`, so single-player is untouched):
 *   - Authority (host): runs the flow and mirrors every step with `ExtractionMessage`s ('ex'); accepts `ExtractionRequest`s
 *     ('exq') from clients (activate / board / liftoff = start the departure grace / sync).
 *   - Client: builds the same pads (deterministic world), forwards console / switch interactions as requests, and applies
 *     the host's messages (countdown / grace / idle resync, ship approach, landing, boarding, liftoff, reset).
 */
export class ExtractionSystem implements GameSystem {
  readonly name = 'extraction';
  private ctx!: GameContext;
  private pads: PadEntry[] = [];
  private ship: Dropship | null = null;
  private flare: FlareColumn | null = null;
  private dust: DustRing | null = null;
  private unsubs: Array<() => void> = [];
  private netUnsubs: Array<() => void> = [];
  /** Seed of the world the current pads were built for (guards against event-order races). */
  private padsSeed: number | null = null;

  private activePad: PadEntry | null = null;
  private countdown = 0;
  private counting = false;
  private shipCalled = false;
  private landed = false;
  /** Local player is inside the bay. */
  private boarded = false;
  /** The ship has left (liftoff issued). */
  private lifting = false;
  private doorsClosedEmitted = false;
  private lastBeepSecond = -1;
  private shipLandPos = new THREE.Vector3();
  private shipYaw = 0;
  private dir = new THREE.Vector3();
  /**
   * The bay box handed to `PlayerRef.setShipInterior`. **One object, rewritten every frame while boarded** —
   * `PlayerController` reads the floor and the XZ clamp straight off it, so it has to travel with the ship
   * (2026-09-10: a snapshot taken at boarding left the player standing on thin air the moment the ship climbed).
   */
  private shipBounds = { center: new THREE.Vector3(), halfExtents: new THREE.Vector3() };
  /** Local player is attached to the ship for the climb (`liftoff`). */
  private riding = false;

  /* ── 2026-09-13: departure grace / auto departure / left behind ── */
  /** Seconds until the idle timer starts the grace by itself (-1 = not counting: not landed, departing or gone). */
  private idleRemaining = -1;
  private departing = false;
  private departRemaining = -1;
  private departAuto = false;
  private lastDepartSecond = -1;
  /** Seconds since the liftoff (drives the left-behind reset). */
  private liftoffElapsed = 0;
  /** The liftoff left nobody alive outside — the raid is over for everyone (GameFlow completes all). */
  private squadDone = false;
  /** Peers that left aboard (host's list / the `liftoff` message) — a corpse of theirs made mid-climb belongs on the deck. */
  private riderIds = new Set<string>();
  private readonly hull = new ShipHull();
  private readonly cinematic = new DepartureCinematic();
  /** Corpses lying in the bay (they leave with the ship). */
  private shipCorpses: string[] = [];
  private waitSendAccum = 0;

  /* ── multiplayer state ── */
  /** Host: every peer (incl. local) currently inside the bay. */
  private boardedPeers = new Set<PeerId>();
  private netTickAccum = 0;
  /** Client: latest `boarding` message from the host. */
  private clientBoardedCount = 0;
  private clientRequiredCount = 0;
  /** Client: > 0 while waiting for the local ship to touch down after the host's `shipLanded`. */
  private landFallbackTimer = -1;
  /** Scratch for required-player counting (host). */
  private requiredIds: PeerId[] = [];
  /** Client: `boarded` list from the latest `boarding` / `sync` message — becomes `boardedPeers` on a host takeover (Phase 7). */
  private lastBoarded: PeerId[] = [];

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.ship = new Dropship();
    this.flare = new FlareColumn();
    this.dust = new DustRing();
    ctx.scene.add(this.ship.root, this.flare.group, this.dust.pool.points);
    ctx.extraction = this.createRef();

    this.unsubs.push(
      ctx.bus.on('world:ready', () => { this.buildPads(); this.ensureNetHooks(); }),
      ctx.bus.on('game:abort', () => { this.resetMission(true); this.unhookNet(); }),
      // NOTE: WorldSystem generates synchronously inside its own game:newMission handler, so world:ready
      // (and buildPads) has already run by the time this handler fires → keep pads that match the new seed.
      ctx.bus.on('game:newMission', () => this.resetMission(false)),
      // Single-player: the mission is over → let the flare die out. Multiplayer: the squad continues.
      ctx.bus.on('player:died', () => { if (!this.ctx.isMultiplayer) this.flare?.stop(); }),
      // Host: a peer left → its boarding entry is irrelevant; re-broadcast so clients' n/m updates.
      ctx.bus.on('net:peerLeft', ({ id }) => {
        if (!this.isHost()) return;
        this.boardedPeers.delete(id);
        if (this.landed && !this.lifting) this.broadcastBoarding();
      }),
      // Client: once the hellpod has landed (deploying → playing) ask the host for the current extraction stage.
      // Harmless on a normal start (host answers `idle`); on a rejoin it rebuilds countdown / ship / boarding state.
      ctx.bus.on('game:phaseChanged', ({ phase, prev }) => {
        if (phase === 'playing' && prev === 'deploying' && this.isClient()) this.sendReq({ t: 'exq', ev: 'sync' });
      }),
      /* Phase 7: host migration — promote the mirrored state to authority, or re-sync from the new host. */
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => this.onHostChanged(isLocalHost)),
      // Host: a suspended member's body is a ghost (cannot board / ride); drop its boarding entry and re-broadcast.
      ctx.bus.on('net:peerSuspended', ({ id, suspended }) => {
        if (!this.isHost()) return;
        if (suspended) this.boardedPeers.delete(id);
        if (this.landed && !this.lifting) this.broadcastBoarding();
      }),
      // 2026-09-13: someone died in the bay → the corpse lies on the deck and rides with the ship (every client decides locally)
      ctx.bus.on('corpse:playerSpawned', ({ id, ownerId, position }) => this.onCorpseSpawned(id, ownerId, position)),
    );
  }

  /** `ctx.extraction` — live getters over this system (no copies to keep in sync). */
  private createRef(): ExtractionRef {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sys = this;
    return {
      get stage(): ExtractionStage { return sys.stage; },
      get departRemaining(): number { return sys.departing ? sys.departRemaining : -1; },
      get idleRemaining(): number { return sys.landed && !sys.departing && !sys.lifting ? sys.idleRemaining : -1; },
      get riding(): boolean { return sys.riding; },
      isInShipBay: (p) => !!sys.ship && (sys.landed || sys.lifting) && sys.ship.containsWorldPoint(p),
      keepEnemyOut: (p, r) => !!sys.ship && (sys.landed || sys.lifting) && ShipHull.keepEnemyOut(sys.ship, p, r),
      beginPreLanded: (p, yaw, opts) => sys.beginPreLanded(p, yaw, opts),
      skipToLiftoff: () => sys.skipToLiftoff(),
      holdFire: () => sys.holdFire(),
      skipToComplete: () => sys.skipToComplete(),
    };
  }

  /* ── 2026-09-15 (사용자 결정 — 튜토리얼 건너뛰기 = 암전 → 보상 창 → 함선) ──────────────────────────────
   * `ExtractionRef.skipToComplete`. 걸어가 타기 · 이륙 · 외부 카메라 연출을 **통째로** 건너뛴다 — 함선은 그 자리에 선 채로
   * `extraction:liftoff {aboard: true, squadDone: true}` 를 한 번 내고, `game/` 이 그것을 건너뛰기로 알아봐(`stage !== 'liftoff'`
   * 인데 이륙이 왔다 · 또는 이미 `liftoff` 페이즈인데 한 번 더 왔다) 대기 없이 평소 `complete()` 로 간다. 결과 화면 · 정산 ·
   * 함선 획득(튜토리얼 트랙이 같은 이벤트로 `extract` 를 접는다)은 진짜 탈출과 같은 길이다. 암전은 부르는 쪽(tutorial)이 먼저 건다.
   *
   * 남는 것을 걷는 범위: 이륙 연출(`ui:cinematic` 끄기) · 스위치 · 유예 시계 · 탑승자의 각본 잠금. **몸의 부착 · 화물칸 상자는
   * 그대로 둔다** — 오르던 함선에서 떼면 결과 화면 밑에서 몸이 떨어진다. 결과 화면 뒤 `hub:enter` → `game:abort` → `resetMission(true)`
   * 가 평소처럼 전부 푼다.
   *
   * false: 튜토리얼이 아니다 · 이미 넘겼다 · 페이즈가 탈출 흐름(`extracting` · `shipLanded` · `liftoff`)이 아니다(아직 `playing` 이거나
   * 이미 결과 화면) · `game/` 이 받지 않았다. 몸이 사망 · 전투불능이어도 받는다 — 건너뛰기는 탈출을 대신 해 주는 것이다.
   */
  private skipCompleted = false;

  private skipToComplete(): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.missionMode !== 'tutorial' || this.skipCompleted) return false;
    this.syncPreLandedPhase();
    if (ctx.phase !== 'extracting' && ctx.phase !== 'shipLanded' && ctx.phase !== 'liftoff') return false;
    this.skipCompleted = true;
    this.cinematic.stop(ctx);
    ctx.interactables.unregister('ship_liftoff_switch');
    this.departing = false;
    this.departRemaining = -1;
    this.idleRemaining = -1;
    if (this.riding) ctx.player?.setSceneLock?.(false);
    const position = (this.ship ? this.ship.position : this.shipLandPos).clone();
    ctx.bus.emit('extraction:liftoff', { position, aboard: true, squadDone: true });
    // emit 안에서 game/ 이 페이즈를 바꾼다 — 좁혀진 타입을 넓혀 다시 읽는다
    const phaseAfter: string = ctx.phase;
    if (phaseAfter === 'complete') return true;
    // game/ 이 받지 않았다 (페이즈가 어긋났다) — 다음 시도를 막지 않는다
    this.skipCompleted = false;
    return false;
  }

  /**
   * `ExtractionRef.holdFire` (2026-09-14 3차, 사용자 결정 — 「함선 내부에 PC 가 들어가면 안드로이드는 PC 를
   * **바라보되 사격은 하지 않는다**」). 튜토리얼 함선이 뜨기 시작한 순간부터 참이다: 그때 램프가 닫히고
   * 곧 외피 콜라이더가 걷히므로, 미처 처치하지 못한 안드로이드가 오르는 화물칸을 그대로 쏠 수 있다.
   * `keepEnemyOut` 과 같은 이유로 월드 콜라이더가 아니라 **질의**다 (`enemies/ai` 가 사격 직전에 부른다).
   * 본편에는 문이 없다 — `ctx.missionMode !== 'tutorial'` 이면 늘 false.
   */
  /*
   * 2026-09-15 (사용자 결정 — 「처치하지 않은 안드로이드가 함선 안의 PC 를 **실제로** 쏜다 · 죽지는 않는다」): 사격 보류를 **걷었다.**
   * 계약(추가만)이라 질의는 남고 늘 false 다. 대신 탑승자는 피해를 받는 각본 잠금(`setSceneLock(true, {allowDamage, minHp: 1})`,
   * `liftoff()`)이고, 튜토리얼 이륙은 외피 콜라이더를 곧장 걷어(`update`) 총알이 화물칸에 닿으며, enemies 의 이륙 사격 창
   * (`Tutorial.onTutorialLiftoff`, `TUTORIAL_LIFTOFF_FIRE_S`)이 표적을 잡아 준다.
   */
  private holdFire(): boolean {
    return false;
  }

  /** 튜토리얼의 미리 세워 둔 함선인가 — 스위치가 유예 없이 곧장 이륙으로 가는 유일한 조건 (본편은 늘 false). */
  private tutorialLiftoffNow(): boolean {
    return this.preLanded && this.ctx?.missionMode === 'tutorial';
  }

  /* ── 2026-09-14 (튜토리얼 개편, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」): 이미 착륙해 있는 탈출선 ──────────────────
   * 튜토리얼의 「버려진 함선」은 새 메시가 아니라 **진짜 탈출선**이다. 콘솔 · 20초 호출 · 비행 · 착륙 연출만
   * 건너뛰고 곧장 `landed` 로 들어가므로, 안의 스위치 → 취소 불가 10초 유예 → 이륙 → 결과 · 정산이 **평소
   * 경로 그대로** 흐른다 (이 파일에 새 갈래가 생기지 않는다는 것이 이 설계의 요점이다).
   * 본편 탈출에는 문이 없다: `ctx.missionMode !== 'tutorial'` 이거나 이미 흐름이 시작됐으면 false. */

  /** 착륙 연출을 건너뛰고 세운 함선인가 (`resetMission` 이 지운다). */
  private preLanded = false;
  /** `playing` 이 될 때까지 미뤄 둔 단계 전환 (아래 `syncPreLandedPhase`). */
  private preLandedPhasePending = false;

  private beginPreLanded(position: THREE.Vector3, yaw: number, opts?: { autoDepart?: boolean }): boolean {
    const ctx = this.ctx;
    const ship = this.ship;
    if (!ship || !ctx || ctx.missionMode !== 'tutorial' || this.stage !== 'idle') return false;
    this.shipYaw = yaw;
    this.dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.shipLandPos.copy(position);
    this.counting = false;
    this.countdown = 0;
    this.shipCalled = true;
    if (!ship.forceLand(this.shipLandPos, this.shipYaw)) { this.shipCalled = false; return false; }
    this.preLanded = true;
    this.onShipLanded(true);
    // 둘러볼 시간이 필요하다 — 무응답 자동 출발(60초)을 걸지 않는다. 스위치만이 유예를 시작한다.
    if (opts?.autoDepart === false) { this.idleRemaining = -1; this.waitSendAccum = 0; }
    this.preLandedPhasePending = true;
    this.syncPreLandedPhase();
    return true;
  }

  /**
   * `GameFlowSystem` 은 `extraction:liftoff` 를 **`extracting` · `shipLanded` 단계에서만** 받는다 (평소에는
   * 콘솔의 `activated` → 착륙의 `shipLanded` 가 차례로 그 단계를 만든다). 튜토리얼 함선은 강하보다도 먼저
   * 서 있으므로 `extraction:activated` 를 **`playing` 이 되는 첫 프레임에** 흘려 `extracting` 을 만든다.
   * `duration: 0` = 기다릴 시간이 없다는 뜻이다 (호출이 아니라 이미 와 있는 함선).
   *
   * **2026-09-14 3차 (사용자 결정 — 도착 토스트 없음)**: 그래도 `extraction:shipLanded` 는 **낸다.**
   * 그 이벤트는 토스트만의 것이 아니다 — `ui/hud/WorldMarkers` · `ui/map/MapScreen` 의 함선 마커(`__ship`)와
   * 음악 전환이 같은 이벤트에서 생기므로, 내지 않으면 `extract` 단계에서 게이트가 풀려도 **그릴 마커가 없다**
   * (`shared/tutorial.ts` 의 `shipMarker` = 「`extract` 단계에 들어서면 풀린다」와 어긋난다).
   * 그래서 **토스트만 거른다**: 튜토리얼에서는 `ui/hud/Notifications` 가 「함선 착륙」 줄을 쓰지 않는다
   * (「그 문장이 사실인가」는 문장을 쓰는 쪽이 판단한다 — `idleRemaining < 0` 갈래가 이미 그 자리에 있다).
   */
  private syncPreLandedPhase(): void {
    const ctx = this.ctx;
    if (!this.preLandedPhasePending || !ctx || ctx.phase !== 'playing') return;
    this.preLandedPhasePending = false;
    ctx.bus.emit('extraction:activated', { pointId: 'tutorial_ship', position: this.shipLandPos.clone(), duration: 0 });
    ctx.bus.emit('extraction:shipLanded', { position: this.shipLandPos.clone() });
  }

  /* ── 2026-09-14 2차 (튜토리얼 건너뛰기 = 즉시 탈출, 사용자 결정) ──────────────────────────────────
   * `ExtractionRef.skipToLiftoff`. 걸어가서 타는 것만 건너뛴다 — 몸을 화물칸에 세우고 유예 없이
   * **평소의 `liftoff()`** 를 부르므로 이륙 연출 · 결과 화면 · 정산 · 함선 획득이 전부 그대로 흐른다.
   * 새 갈래를 만들지 않는 것이 `beginPreLanded` 와 같은 요점이고, 「함선 출발은 레이드 종료가 아니다」
   * (2026-09-13)도 그대로다: 솔로라 `squadDone` 이 참이 되어 평소처럼 레이드가 끝날 뿐이다.
   *
   * **false 인 경우** — 본편 탈출 흐름에는 문이 없다:
   *   ① `ctx.missionMode !== 'tutorial'`   ② 함선이 없거나 아직 착륙하지 않았다 · 이미 떠났다
   *   ③ 태울 몸이 없다 (아직 스폰 전 · 사망 · 전투불능) — 시체를 태워 보낼 수는 없다.
   * 유예(`departing`) 중에는 받는다 — 이미 착륙해 있는 함선이고, 건너뛰기는 그 10초를 지우는 것이 맞다.
   */
  private skipToLiftoff(): boolean {
    const ctx = this.ctx;
    const ship = this.ship;
    if (!ship || !ctx || ctx.missionMode !== 'tutorial') return false;
    if (!this.landed || this.lifting) return false;
    const player = ctx.player;
    if (!player || player.isDead || (player.isDowned ?? false)) return false;
    // `extraction:liftoff` 는 `extracting` · `shipLanded` 단계에서만 받아들여진다 — 미뤄 둔 단계 전환이
    // 남아 있으면(강하 직후 같은 프레임) 먼저 흘린다.
    this.syncPreLandedPhase();
    if (ctx.phase !== 'shipLanded' && ctx.phase !== 'extracting') return false;

    // 화물칸 한가운데 데크 위에 세우고 기수 쪽(램프 반대)을 보게 한다.
    const lz = (BAY_Z_MIN + BAY_Z_MAX) / 2;
    ship.bayToWorld(0, lz, ship.position.y, _v);
    _v.y = ship.floorYAt(_v.x, _v.z);
    player.teleport(_v, ship.yaw, false);

    if (!this.boarded) {
      this.boarded = true;
      ctx.bus.emit('extraction:boarded', {});
      this.onLocalBoardingChanged(true);
    }
    this.liftoff();
    return true;
  }

  get stage(): ExtractionStage {
    return this.lifting ? 'liftoff'
      : this.departing ? 'departing'
      : this.landed ? 'landed'
      : this.shipCalled ? 'shipIncoming'
      : this.activePad ? 'countdown'
      : 'idle';
  }

  /**
   * Phase 7 host migration. New host: the client mirror (activePad / countdown / ship / landed / grace / lifting) already
   * holds the last `ex` state, so it simply becomes authoritative — the countdown and the grace keep ticking (now broadcast),
   * the ship continues its flight and `boardedPeers` starts from the last `boarding` list. Demoted / other clients: ask the
   * new host for a fresh `sync` (numbers only when a flow is already active locally).
   * 2026-09-13: a rider (on its way out, or already on the result screen) takes no part.
   */
  private onHostChanged(isLocalHost: boolean): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    if (this.riding) return;
    if (!(ctx.isGameplayPhase() || ctx.phase === 'deploying')) return;
    if (isLocalHost) {
      this.landFallbackTimer = -1;
      this.netTickAccum = 0;
      this.waitSendAccum = 0;
      this.boardedPeers.clear();
      for (const id of this.lastBoarded) this.boardedPeers.add(id);
      if (this.boarded) this.boardedPeers.add(this.localId()); else this.boardedPeers.delete(this.localId());
      // the old host's id may linger in the list; collectRequired filters it, but keep the set honest
      for (const id of Array.from(this.boardedPeers)) {
        if (id === this.localId()) continue;
        const r = ctx.net.getRemotePlayer(id);
        if (!r || !r.connected || r.suspended) this.boardedPeers.delete(id);
      }
      if (this.activePad && !this.lifting) {
        // mirror the current stage once so every client (and the late-joining ones) is on the same numbers
        if (this.counting) this.sendEx({ t: 'ex', ev: 'tick', remaining: this.countdown });
        if (this.landed) this.broadcastBoarding(false);
        if (this.departing) this.sendEx({ t: 'ex', ev: 'depart', remaining: this.departRemaining, auto: this.departAuto });
        else if (this.landed && this.idleRemaining >= 0) this.sendEx({ t: 'ex', ev: 'wait', remaining: this.idleRemaining });
      }
    } else {
      this.lastBoarded = [];
      this.sendReq({ t: 'exq', ev: 'sync' });
    }
  }

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  private isHost(): boolean { return this.ctx.isMultiplayer && this.ctx.isAuthority && !!this.ctx.net; }
  private isClient(): boolean { return this.ctx.isMultiplayer && !this.ctx.isAuthority && !!this.ctx.net; }
  private localId(): PeerId { return this.ctx.net?.localId ?? LOCAL_ID; }

  private sendEx(msg: ExtractionMessage): void {
    if (this.isHost()) this.ctx.net!.send(msg, 'others');
  }
  private sendReq(msg: ExtractionRequest): void {
    if (this.isClient()) this.ctx.net!.send(msg, 'host');
  }

  /** Subscribe to net messages once `ctx.net` exists (NetSystem may publish it after our init). */
  private ensureNetHooks(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsubs.length > 0) return;
    this.netUnsubs.push(
      net.onMessage('exq', (msg, from) => this.onRequest(msg, from)),
      net.onMessage('ex', (msg, from) => this.onHostMessage(msg, from)),
    );
  }
  private unhookNet(): void {
    for (const u of this.netUnsubs) u();
    this.netUnsubs.length = 0;
  }

  /** Host: handle a client request. */
  private onRequest(msg: ExtractionRequest, from: PeerId): void {
    if (!this.isHost()) return;
    switch (msg.ev) {
      case 'activate': {
        if (this.ctx.phase !== 'playing' || this.activePad) return;
        const pad = this.pads.find((p) => p.def.id === msg.padId);
        if (pad) this.activate(pad);
        break;
      }
      case 'board': {
        if (this.lifting) return;
        const had = this.boardedPeers.has(from);
        if (msg.inside === had) return;
        if (msg.inside) this.boardedPeers.add(from); else this.boardedPeers.delete(from);
        this.broadcastBoarding();
        break;
      }
      case 'liftoff': {
        // 2026-09-13: the switch no longer lifts off — it starts the grace, and only from someone who is actually aboard.
        if (!this.ctx.isGameplayPhase() || !this.landed || this.lifting || this.departing) return;
        if (!this.boardedPeers.has(from)) return;
        this.startDeparture(false);
        break;
      }
      case 'sync':
        // (Re)joining client asks for the full state → reply to that peer only.
        this.ctx.net!.send({ t: 'ex', ev: 'sync', state: this.buildSyncState() }, from);
        break;
    }
  }

  /** Host: snapshot of the current flow for a late / rejoining client. */
  private buildSyncState(): ExtractionSyncState {
    const stage: ExtractionSyncState['stage'] = this.lifting ? 'liftoff'
      : this.departing ? 'departing'
      : this.landed ? 'shipLanded'
      : this.shipCalled ? 'shipIncoming'
      : this.activePad ? 'countdown'
      : 'idle';
    const state: ExtractionSyncState = {
      stage,
      padId: this.activePad ? this.activePad.def.id : null,
      remaining: this.countdown,
      boarded: Array.from(this.boardedPeers),
      required: this.collectRequired(this.requiredIds).slice(),
    };
    if (this.landed && !this.departing && !this.lifting) state.idleRemaining = this.idleRemaining;
    if (this.departing) { state.departRemaining = this.departRemaining; state.departAuto = this.departAuto; }
    if (this.lifting) { state.sinceLiftoff = this.liftoffElapsed; state.squadDone = this.squadDone; }
    return state;
  }

  /**
   * Client: apply the host's full state (reply to `exq sync`). Runs each stage's normal entry path in order so
   * GameFlow sees the same `extraction:*` events (activated → shipLanded → departureStarted → liftoff) it would have seen live.
   */
  private applySyncState(state: ExtractionSyncState): void {
    if (state.stage === 'idle') {
      // 2026-09-13: our flow outlived the host's (it already reset after a departure we were left behind by) → follow it.
      if ((this.activePad || this.landed || this.lifting) && !this.riding) this.departedReset();
      return;
    }
    if (this.activePad) {
      // Already following the live stream → refresh the numbers and catch up on a stage we missed.
      if (this.counting) this.countdown = Math.max(0, state.remaining);
      this.applyBoarding(state.boarded, state.required);
      if (state.stage === 'shipLanded' || state.stage === 'departing' || state.stage === 'liftoff') {
        if (!this.landed && !this.lifting) this.forceLandNow();
      }
      if (this.landed && !this.departing && !this.lifting && typeof state.idleRemaining === 'number') {
        this.idleRemaining = Math.max(0, state.idleRemaining);
      }
      if (state.stage === 'departing' && this.landed && !this.lifting) {
        const rem = typeof state.departRemaining === 'number' ? Math.max(0, state.departRemaining) : EXTRACTION_DEPART_GRACE_S;
        if (!this.departing) this.startDeparture(state.departAuto === true, rem);
        else this.departRemaining = rem;
      }
      if (state.stage === 'liftoff' && !this.lifting) {
        this.liftoff(state.squadDone ?? true);
        if (typeof state.sinceLiftoff === 'number') this.liftoffElapsed = Math.max(0, state.sinceLiftoff);
      }
      return;
    }
    const pad = this.pads.find((p) => p.def.id === state.padId);
    if (!pad) return;
    this.beginActivation(pad, EXTRACTION_COUNTDOWN);
    this.countdown = Math.max(0, state.remaining);
    if (state.stage === 'shipIncoming') {
      this.callShip();
    } else if (state.stage === 'shipLanded' || state.stage === 'departing' || state.stage === 'liftoff') {
      this.forceLandNow();
      this.applyBoarding(state.boarded, state.required);
      if (typeof state.idleRemaining === 'number') this.idleRemaining = Math.max(0, state.idleRemaining);
      if (state.stage === 'departing') {
        this.startDeparture(state.departAuto === true,
          typeof state.departRemaining === 'number' ? Math.max(0, state.departRemaining) : EXTRACTION_DEPART_GRACE_S);
      }
      if (state.stage === 'liftoff') {
        // ship already leaving: we watch it go (not boarded → controls kept) and reset with the rest of the squad
        this.liftoff(state.squadDone ?? true);
        if (typeof state.sinceLiftoff === 'number') this.liftoffElapsed = Math.max(0, state.sinceLiftoff);
      }
    }
    this.ctx.bus.emit('ui:notify', { text: '탈출 진행 상황 동기화됨', kind: 'info', duration: 2.5 });
  }

  /** Client: update the n/m boarding mirror (from `boarding` or `sync`). Returns true when the numbers changed. */
  private applyBoarding(boarded: PeerId[], required: PeerId[]): boolean {
    this.lastBoarded = boarded.slice();
    let n = 0;
    for (const id of required) if (boarded.includes(id)) n++;
    const changed = n !== this.clientBoardedCount || required.length !== this.clientRequiredCount;
    this.clientBoardedCount = n;
    this.clientRequiredCount = required.length;
    return changed;
  }

  /** Client: mirror the host's flow. */
  private onHostMessage(msg: ExtractionMessage, from: PeerId): void {
    if (!this.isClient()) return;
    const hostId = this.ctx.net!.lobby?.hostId;
    if (hostId && from !== hostId) return;
    const ship = this.ship;
    if (!ship) return;
    // 2026-09-13: a rider is on its way out — whatever the squad does next (a reset, a new ship) is not its flow any more.
    if (this.riding) return;
    switch (msg.ev) {
      case 'activated': {
        if (this.activePad) return;
        const pad = this.pads.find((p) => p.def.id === msg.padId);
        if (pad) this.beginActivation(pad, msg.duration);
        break;
      }
      case 'tick':
        if (this.counting) this.countdown = Math.max(0, msg.remaining);
        break;
      case 'shipIncoming':
        if (this.activePad && !this.shipCalled) this.callShip();
        break;
      case 'shipLanded':
        if (this.activePad && !this.landed && this.landFallbackTimer < 0) this.landFallbackTimer = NET_LAND_FALLBACK;
        break;
      case 'boarding': {
        const changed = this.applyBoarding(msg.boarded, msg.required);
        if (changed && this.landed && !this.lifting) {
          this.ctx.bus.emit('ui:notify', { text: `탑승 ${this.clientBoardedCount}/${this.clientRequiredCount}`, kind: 'info', duration: 2 });
        }
        break;
      }
      case 'wait':
        if (this.landed && !this.departing && !this.lifting) this.idleRemaining = Math.max(0, msg.remaining);
        break;
      case 'depart': {
        if (!this.activePad || this.lifting) return;
        if (!this.landed) this.forceLandNow();
        if (!this.landed) return;
        if (!this.departing) this.startDeparture(msg.auto === true, Math.max(0, msg.remaining));
        else this.departRemaining = Math.max(0, msg.remaining);
        break;
      }
      case 'sync':
        if (msg.state && typeof msg.state === 'object' && Array.isArray(msg.state.boarded) && Array.isArray(msg.state.required)) {
          this.applySyncState(msg.state);
        }
        break;
      case 'liftoff':
        if (this.activePad && !this.lifting) {
          // The host may have landed the ship before we did (message loss / late join) — never miss the ride visuals.
          if (!this.landed) this.forceLandNow();
          if (Array.isArray(msg.riders)) for (const id of msg.riders) if (typeof id === 'string') this.riderIds.add(id);
          this.liftoff(msg.squadDone ?? true);
        }
        break;
      case 'reset':
        // after a departure that left us behind this is the host's reset; otherwise (abort / new mission) `flow` follows
        if (this.activePad || this.landed || this.lifting) this.departedReset();
        break;
    }
  }

  /** Host: required = local player if alive + every connected, fresh, alive remote player. */
  private collectRequired(out: PeerId[]): PeerId[] {
    out.length = 0;
    const ctx = this.ctx;
    // Downed (전투불능) players cannot board either: they neither block nor count toward the liftoff (Phase 2).
    if (!(ctx.player?.isDead ?? false) && !(ctx.player?.isDowned ?? false)) out.push(this.localId());
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      for (const r of net.getRemotePlayers()) {
        // Peers walking the shared ship (IN_HUB) are not in this mission and never count.
        // Phase 7: a suspended member (socket down, host-simulated ghost) cannot board either → not counted, not extracted.
        if (r.suspended) continue;
        if (r.connected && !r.stale && !r.isDead && (r.flags & (PlayerFlags.IN_HUB | PlayerFlags.DOWNED)) === 0) out.push(r.id);
      }
    }
    return out;
  }

  private broadcastBoarding(notify = true): void {
    const required = this.collectRequired(this.requiredIds).slice();
    let n = 0;
    for (const id of required) if (this.boardedPeers.has(id)) n++;
    this.sendEx({ t: 'ex', ev: 'boarding', boarded: Array.from(this.boardedPeers), required });
    if (notify && this.landed && !this.lifting) {
      this.ctx.bus.emit('ui:notify', { text: `탑승 ${n}/${required.length}`, kind: 'info', duration: 2 });
    }
  }

  /** The interior switch can start the grace: the local player is aboard and alive, the ship waits on the pad. */
  private switchReady(): boolean {
    const p = this.ctx.player;
    if (!this.boarded || !this.landed || this.departing || this.lifting || !this.ctx.isGameplayPhase()) return false;
    return !!p && !p.isDead && !(p.isDowned ?? false);
  }

  /* ── Pads / consoles ─────────────────────────────────────────────────── */
  private buildPads(): void {
    this.clearPads();
    const world = this.ctx.world;
    if (!world) return;
    this.padsSeed = world.seed;
    // 훈련장 (Phase 7): the arena has no pads → no consoles, no countdown, no ship. Nothing else to do.
    const points = world.getExtractionPoints();
    if (!points || points.length === 0) return;
    for (const def of points) {
      const dir = new THREE.Vector3(Math.sin(def.yaw), 0, Math.cos(def.yaw));
      // def.position.y is the top of the (flat) landing platform — use it directly.
      const pos = def.position.clone().addScaledVector(dir, 5);
      const console = new ExtractionConsole(pos, def.yaw);
      this.ctx.scene.add(console.group);
      const id = `extract_${def.id}`;
      const interactable: Interactable = {
        id,
        position: console.interactPoint,
        radius: 2.6,
        holdTime: 1.2,
        // 2026-09-10: 콘솔은 그 자체로 눈에 띄는 장치다 — 감지 빛기둥(`ui/hud/Detection`)을 세우지 않는다.
        hidePillar: true,
        getPrompt: () => (this.ctx.phase === 'playing' ? '탈출 신호 전송 (E 길게)' : null),
        canInteract: () => this.ctx.phase === 'playing' && !this.activePad,
        interact: () => {
          // Client: ask the host; the host's `activated` message drives our visuals.
          if (this.isClient()) this.sendReq({ t: 'exq', ev: 'activate', padId: entry.def.id });
          else this.activate(entry);
        },
      };
      const entry: PadEntry = { def, console, interactableId: id };
      this.ctx.interactables.register(interactable);
      this.pads.push(entry);
    }
  }

  private clearPads(): void {
    for (const p of this.pads) {
      this.ctx.interactables.unregister(p.interactableId);
      p.console.dispose();
    }
    this.pads.length = 0;
    this.padsSeed = null;
  }

  /* ── Activation / countdown ──────────────────────────────────────────── */
  /** Authority path (single-player / host). */
  private activate(pad: PadEntry): void {
    if (this.activePad) return;
    this.beginActivation(pad, EXTRACTION_COUNTDOWN);
    this.sendEx({ t: 'ex', ev: 'activated', padId: pad.def.id, duration: EXTRACTION_COUNTDOWN });
  }

  /** Shared visuals/events for activation — host and client alike. */
  private beginActivation(pad: PadEntry, duration: number): void {
    this.activePad = pad;
    this.counting = true;
    this.countdown = duration;
    this.shipCalled = false;
    this.landed = false;
    this.lastBeepSecond = -1;
    this.netTickAccum = 0;
    pad.console.setState('active');
    for (const other of this.pads) if (other !== pad) other.console.setState('off');

    const center = pad.def.position.clone(); // platform top at pad center
    this.dir.set(Math.sin(pad.def.yaw), 0, Math.cos(pad.def.yaw));
    this.shipYaw = pad.def.yaw;
    // Ship root sits 5 m back from the pad center so the rear ramp opening lands at the center, facing the console.
    this.shipLandPos.copy(center).addScaledVector(this.dir, -5);
    this.shipLandPos.y = center.y;

    // Flare rises from the pad center (between console and ship landing spot).
    this.flare!.start(center.clone().addScaledVector(this.dir, 2.5));

    this.ctx.bus.emit('extraction:activated', { pointId: pad.def.id, position: center, duration });
    this.ctx.bus.emit('audio:play', { id: 'extract_activate', position: pad.console.interactPoint });
  }

  private callShip(): void {
    this.shipCalled = true;
    this.ship!.startApproach(this.shipLandPos, this.shipYaw, APPROACH_DURATION);
    this.ctx.bus.emit('extraction:shipIncoming', { position: this.shipLandPos.clone(), eta: SHIP_INCOMING_AT });
    this.ctx.bus.emit('audio:play', { id: 'ship_approach', position: this.shipLandPos });
    this.sendEx({ t: 'ex', ev: 'shipIncoming', eta: SHIP_INCOMING_AT });
  }

  /** Client fallback: place the ship on the pad and run the touchdown path. */
  private forceLandNow(): void {
    this.landFallbackTimer = -1;
    if (this.landed || !this.ship) return;
    this.shipCalled = true;
    if (this.ship.forceLand(this.shipLandPos, this.shipYaw)) this.onShipLanded();
  }

  /**
   * `silent` (2026-09-14, `beginPreLanded`): 착륙한 **순간**의 연출 · 알림을 건너뛴다 — 튜토리얼의 버려진 함선은
   * 방금 내려앉은 것이 아니라 처음부터 그 자리에 있었다. 외피 콜라이더 · 실내 스위치 · 대기 타이머는 그대로다.
   * `extraction:shipLanded` 는 `syncPreLandedPhase` 가 `playing` 이 되는 프레임에 한 번만 낸다.
   */
  private onShipLanded(silent = false): void {
    this.landed = true;
    this.counting = false;
    this.landFallbackTimer = -1;
    this.idleRemaining = EXTRACTION_AUTO_DEPART_IDLE_S;
    this.waitSendAccum = 0;
    this.flare!.stop();
    const ship = this.ship!;
    // 2026-09-13: the hull is solid from now on — enemies, bullets and grenades stop at it (`Hull.ts`)
    this.hull.register(this.ctx.world, ship);
    const pos = this.shipLandPos.clone();
    if (!silent) {
      this.ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.7 });
      this.ctx.bus.emit('audio:play', { id: 'ship_land', position: pos });
      this.ctx.bus.emit('extraction:shipLanded', { position: pos });
    }
    this.sendEx({ t: 'ex', ev: 'shipLanded' });
    // Seed the clients' n/m display and the idle timer right away (no toast for this one).
    if (this.isHost()) {
      this.broadcastBoarding(false);
      this.sendEx({ t: 'ex', ev: 'wait', remaining: this.idleRemaining });
    }

    const sw: Interactable = {
      id: 'ship_liftoff_switch',
      position: ship.interiorSwitchWorld,
      radius: 2.4,
      holdTime: 1.0,
      hidePillar: true,   // 2026-09-10: 함선 안 출발 버튼에도 감지 빛기둥을 세우지 않는다
      getPrompt: () => {
        if (!this.switchReady()) return null;
        // 2026-09-14 3차: 튜토리얼 함선은 유예 없이 곧장 뜬다 — 캡션이 그 사실을 그대로 말한다
        if (this.tutorialLiftoffNow()) return '출발 시퀀스 시작 (E 길게) · 즉시 이륙';
        return `출발 시퀀스 시작 (E 길게) · ${Math.round(EXTRACTION_DEPART_GRACE_S)}초 뒤 이륙`;
      },
      canInteract: () => this.switchReady(),
      interact: () => {
        /*
         * 2026-09-14 3차 (사용자 결정 — 튜토리얼 함선은 스위치를 누르면 즉시 뜬다): 취소 불가 10초 유예를
         * 건너뛰고 곧장 이륙한다. 새 갈래를 만들지 않고 **`skipToLiftoff()` 를 그대로 재사용**한다 —
         * 그것이 이미 「몸을 화물칸에 세우고 유예 없이 평소 `liftoff()`」 이기 때문이다 (이륙 연출 · 결과
         * 화면 · 정산 · 함선 획득이 평소 경로 그대로). 실패하면(= 문이 닫혀 있으면) 평소 유예로 떨어진다.
         */
        if (this.tutorialLiftoffNow() && this.skipToLiftoff()) return;
        if (this.isClient()) this.sendReq({ t: 'exq', ev: 'liftoff' });
        else this.startDeparture(false);
      },
    };
    this.ctx.interactables.register(sw);
  }

  /**
   * 2026-09-13: the uncancellable departure grace. `auto` = the idle timer ran out (nobody pressed the switch).
   * Authority: also broadcast. Clients only ever enter here from the host's `depart` / `sync`.
   */
  private startDeparture(auto: boolean, remaining: number = EXTRACTION_DEPART_GRACE_S): void {
    if (this.departing || this.lifting || !this.landed) return;
    this.departing = true;
    this.departAuto = auto;
    this.departRemaining = Math.max(0, remaining);
    this.idleRemaining = -1;
    this.lastDepartSecond = -1;
    this.netTickAccum = 0;
    this.ctx.bus.emit('extraction:departureStarted', { duration: EXTRACTION_DEPART_GRACE_S, auto });
    this.ctx.bus.emit('audio:play', { id: 'extract_activate', position: this.ship!.interiorSwitchWorld });
    this.sendEx({ t: 'ex', ev: 'depart', remaining: this.departRemaining, auto });
  }

  /**
   * The ship leaves (end of the grace — or called directly by a smoke). Whoever is aboard and alive right now rides along;
   * everyone else keeps their controls. `squadDoneFromHost` is the host's verdict on a client.
   */
  private liftoff(squadDoneFromHost?: boolean): void {
    if (this.lifting) return;
    const ctx = this.ctx;
    this.lifting = true;
    this.departing = false;
    this.departRemaining = -1;
    this.idleRemaining = -1;
    this.liftoffElapsed = 0;
    this.doorsClosedEmitted = false;
    const ship = this.ship!;
    const player = ctx.player;
    const alive = !!player && !player.isDead && !(player.isDowned ?? false);
    ship.beginLiftoff();
    ctx.interactables.unregister('ship_liftoff_switch');

    let squadDone: boolean;
    const riders: PeerId[] = [];
    if (this.isClient()) {
      squadDone = squadDoneFromHost ?? true;
    } else {
      // Authority: riders = the required (alive, connected, in the mission) who are in the bay right now. The raid is over
      // for everyone only when nobody alive is left outside — and somebody actually left (an empty ship ends nothing).
      const req = this.collectRequired(this.requiredIds);
      const me = this.localId();
      for (const id of req) {
        const aboard = id === me ? this.boarded : this.boardedPeers.has(id);
        if (aboard) riders.push(id);
      }
      squadDone = riders.length > 0 && riders.length === req.length;
    }
    this.squadDone = squadDone;
    for (const id of riders) this.riderIds.add(id);

    this.riding = !!player && this.boarded && alive;
    if (this.riding && player) {
      const net = ctx.net;
      if (net?.localId) this.riderIds.add(net.localId);
      // 2026-09-13: only now does the body switch to the moving bay box — while landed the bay is walked in world mode
      // against the hull colliders, so people can step in and out through the ramp (the box clamp never let them out).
      ship.writeInteriorBounds(this.shipBounds, player.position);
      player.setShipInterior(this.shipBounds);
      player.setControlsEnabled(false);
      player.attachTo(ship.root);
      this.cinematic.start(ctx, ship);
      /*
       * 2026-09-14 3차 (사용자 결정 — 튜토리얼 이륙 동안 함선에서 나갈 수도 죽을 수도 없다): 각본 잠금.
       * `setControlsEnabled(false)` 는 **입력만** 끊는다 — 남은 안드로이드의 총알 · 수류탄 · 재해는 그대로
       * 들어오므로, 이륙 연출 중에 죽어 결과 화면이 「미탈출」이 되는 길이 있었다. 카메라는 건드리지 않는다
       * (바로 위 `cinematic` 이 들고 있다). 푸는 곳은 player/ 의 리셋 경로와 아래 `resetMission` 이다.
       * 튜토리얼에만 건다 — 본편 이륙에서 무적이 되는 것은 이 결정의 범위가 아니다.
       */
      /* 2026-09-15 (사용자 결정 — 「실제 피해 · 죽지 않음」): 입력은 잠그되 **피해는 받는다** — 체력 1 에서 멈추고 전투불능 · 사망이 없다. */
      if (ctx.missionMode === 'tutorial') player.setSceneLock?.(true, { allowDamage: true, minHp: 1 });
    }
    // A body standing in the bay but not riding (dead / downed) was never on the box — it stays on the pad.
    ctx.bus.emit('extraction:liftoff', { position: ship.position.clone(), aboard: this.riding, squadDone });
    ctx.bus.emit('audio:play', { id: 'ship_liftoff', position: ship.position });
    this.sendEx({ t: 'ex', ev: 'liftoff', riders, squadDone });
  }

  /**
   * 2026-09-13: the ship left without us → back to square one while the raid goes on. Corpses that flew off in the bay are
   * gone (their gear with them). The player itself is not touched — it may be dead and spectating.
   */
  private departedReset(): void {
    if (this.riding) return;
    const had = !!(this.activePad || this.landed || this.lifting);
    const corpses = this.ctx.corpses;
    for (const id of this.shipCorpses) corpses?.removeCorpse?.(id);
    this.shipCorpses.length = 0;
    this.resetMission(false, true);
    if (had) this.ctx.bus.emit('extraction:reset', {});
  }

  /** 2026-09-13: a corpse spawned in the bay lies on the deck and rides with the ship. */
  private onCorpseSpawned(id: string, ownerId: string, position: THREE.Vector3): void {
    const ship = this.ship, corpses = this.ctx.corpses;
    if (!ship || !corpses || typeof corpses.attachCorpse !== 'function') return;
    if (!(this.landed || this.lifting)) return;
    const l = ship.bayLocal(position, _v);
    if (ship.nearGround) {
      if (!ShipHull.inBay(ship, position, 0.3)) return;
    } else {
      // Climbing: the corpse's height came from a surface query far below (and a remote wire lags the ship by metres at
      // this speed) — only somebody who left aboard can have died in the bay.
      if (!this.riderIds.has(ownerId)) return;
    }
    const lx = THREE.MathUtils.clamp(l.x, -BAY_HALF_W + 0.35, BAY_HALF_W - 0.35);
    const lz = THREE.MathUtils.clamp(l.z, BAY_Z_MIN + 0.5, BAY_Z_MAX - 0.4);
    if (corpses.attachCorpse(id, ship.root, _v.set(lx, 0, lz)) && !this.shipCorpses.includes(id)) this.shipCorpses.push(id);
  }

  /* ── Frame update ────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (this.preLandedPhasePending) this.syncPreLandedPhase();
    for (const p of this.pads) p.console.update(dt);
    this.flare?.update(dt);
    this.dust?.update(dt);
    const ship = this.ship;
    if (!ship) return;

    if (this.counting && ctx.isGameplayPhase()) {
      this.countdown = Math.max(0, this.countdown - dt);
      ctx.bus.emit('extraction:tick', { remaining: this.countdown, total: EXTRACTION_COUNTDOWN });
      if (this.countdown <= 10 && this.countdown > 0) {
        const sec = Math.ceil(this.countdown);
        if (sec !== this.lastBeepSecond) {
          this.lastBeepSecond = sec;
          ctx.bus.emit('audio:play', { id: 'countdown_beep', volume: sec <= 3 ? 1 : 0.7, pitch: sec <= 3 ? 1.25 : 1 });
        }
      }
      // Only the authority calls the ship; clients wait for `shipIncoming`.
      if (ctx.isAuthority && !this.shipCalled && this.countdown <= SHIP_INCOMING_AT) this.callShip();
      if (this.isHost()) {
        this.netTickAccum += dt;
        if (this.netTickAccum >= NET_TICK_INTERVAL) {
          this.netTickAccum = 0;
          this.sendEx({ t: 'ex', ev: 'tick', remaining: this.countdown });
        }
      }
    }

    // 2026-09-13: waiting on the pad → the idle timer; then the grace → liftoff (authority decides both ends).
    if (this.landed && !this.lifting && ctx.isGameplayPhase()) {
      if (this.departing) {
        this.departRemaining = Math.max(0, this.departRemaining - dt);
        ctx.bus.emit('extraction:departureTick', { stage: 'departing', remaining: this.departRemaining, total: EXTRACTION_DEPART_GRACE_S });
        const sec = Math.ceil(this.departRemaining);
        if (sec > 0 && sec !== this.lastDepartSecond) {
          this.lastDepartSecond = sec;
          ctx.bus.emit('audio:play', { id: 'countdown_beep', volume: sec <= 3 ? 1 : 0.7, pitch: sec <= 3 ? 1.25 : 1 });
        }
        if (this.isHost()) {
          this.netTickAccum += dt;
          if (this.netTickAccum >= NET_TICK_INTERVAL) {
            this.netTickAccum = 0;
            this.sendEx({ t: 'ex', ev: 'depart', remaining: this.departRemaining, auto: this.departAuto });
          }
        }
        if (ctx.isAuthority && this.departRemaining <= 0) this.liftoff();
      } else if (this.idleRemaining >= 0) {
        this.idleRemaining = Math.max(0, this.idleRemaining - dt);
        ctx.bus.emit('extraction:departureTick', { stage: 'waiting', remaining: this.idleRemaining, total: EXTRACTION_AUTO_DEPART_IDLE_S });
        if (this.isHost()) {
          this.waitSendAccum += dt;
          if (this.waitSendAccum >= NET_WAIT_INTERVAL) {
            this.waitSendAccum = 0;
            this.sendEx({ t: 'ex', ev: 'wait', remaining: this.idleRemaining });
          }
        }
        if (ctx.isAuthority && this.idleRemaining <= 0) this.startDeparture(true);
      }
    }

    // Client: the host reported touchdown but our ship is still in the air → snap it down after a grace period.
    if (this.landFallbackTimer >= 0) {
      this.landFallbackTimer -= dt;
      if (this.landFallbackTimer < 0) this.forceLandNow();
    }

    const ev = ship.update(dt);
    // The bay moves — while landed it only bobs, but during liftoff it climbs away. `PlayerSystem` reads the box
    // (floor + XZ clamp) and derives the rider's world position from `ship.root`; both come from the matrix
    // `ship.update` just wrote, so refresh the box here and the two never disagree by more than a frame.
    if (ctx.player && this.riding) {
      ship.writeInteriorBounds(this.shipBounds, ctx.player.position);
    }
    if (ev.touchdown && !this.landed) this.onShipLanded();
    if (ev.rampClosed && this.lifting && !this.doorsClosedEmitted) {
      this.doorsClosedEmitted = true;
      ctx.bus.emit('extraction:doorsClosed', {});
    }

    if (this.lifting) {
      this.liftoffElapsed += dt;
      // The hull colliders stay while the ship sits on the pad closing its ramp, and go the moment it starts to climb
      // (a rising roof slab would shove riders sideways — see `Hull.ts`).
      // 2026-09-15: 튜토리얼 함선은 뜨는 순간 걷는다 — 남은 안드로이드의 총알이 화물칸의 탑승자에게 닿아야 한다 (사용자 결정 「실제 피해」).
      // 탑승자는 이미 화물칸 상자(`setShipInterior`) 위라 벽이 필요 없고, 적의 입구 차단은 콜라이더가 아니라 `keepEnemyOut` 질의다.
      if (this.hull.registered && (ship.liftoffTime >= LIFTOFF_SPOOL_S || this.tutorialLiftoffNow())) this.hull.unregister();
      if (this.riding) {
        // 2026-09-15: 건너뛰기(`skipToComplete`)가 연출을 걷었으면 다시 잡지 않는다
        if (!this.skipCompleted) this.cinematic.update(dt, ctx, ship);
      } else if (!this.squadDone && !this.preLanded && ctx.isGameplayPhase()) {
        // 2026-09-14: 미리 세워 둔 함선(튜토리얼)에는 다시 부를 콘솔이 없다 — 리셋하면 남은 사람이 영영 못 나간다.
        const due = LEFT_BEHIND_RESET_S + (ctx.isAuthority ? 0 : CLIENT_RESET_SLACK_S);
        if (this.liftoffElapsed >= due) this.departedReset();
      }
    }

    // Dust while descending near the ground and during the first seconds of liftoff.
    if (ship.descending) {
      const h = ship.position.y - ship.getGroundY();
      const strength = THREE.MathUtils.clamp(1 - h / 18, 0, 1);
      this.dust!.emit(ship.position, ship.getGroundY(), strength, dt);
      if (h < 6) ctx.bus.emit('camera:shake', { intensity: 0.08 * (1 - h / 6), duration: 0.1 });
    } else if (ship.liftingOff) {
      const t = ship.liftoffTime;
      const h = ship.position.y - ship.getGroundY();
      if (t > 1.0 && h < 20) this.dust!.emit(this.shipLandPos, ship.getGroundY(), THREE.MathUtils.clamp(1 - h / 20, 0, 1), dt);
      if (t > 1.2 && !this.riding) ctx.bus.emit('camera:shake', { intensity: 0.12, duration: 0.1 });
    }

    // Boarding volume (local player) — open during the grace too. 2026-09-13: a plain volume test; the body keeps walking in
    // world mode (hull colliders = walls, belly = floor, ramp open) until it rides off (`liftoff`).
    const player = ctx.player;
    if (player && this.landed && !this.lifting && ctx.isGameplayPhase()) {
      const inside = ship.containsWorldPoint(player.position);
      if (inside && !this.boarded) {
        this.boarded = true;
        ctx.bus.emit('extraction:boarded', {});
        this.onLocalBoardingChanged(true);
      } else if (!inside && this.boarded) {
        this.boarded = false;
        this.onLocalBoardingChanged(false);
      }
    }
  }

  private onLocalBoardingChanged(inside: boolean): void {
    if (this.isHost()) {
      if (inside) this.boardedPeers.add(this.localId()); else this.boardedPeers.delete(this.localId());
      this.broadcastBoarding();
    } else if (this.isClient()) {
      this.sendReq({ t: 'exq', ev: 'board', inside });
    }
  }

  /* ── Reset ───────────────────────────────────────────────────────────── */
  /**
   * `clearPads` — drop the consoles too (abort). `keepPlayer` (2026-09-13, the left-behind reset mid-raid) — do not touch the
   * local body's attachment / controls: it was never attached, and it may be dead with its controls off on purpose.
   */
  private resetMission(clearPads: boolean, keepPlayer = false): void {
    // Tell clients first (no-op outside a hosted session).
    if (this.activePad || this.landed || this.lifting) this.sendEx({ t: 'ex', ev: 'reset' });
    const wasRiding = this.riding;
    const world = this.ctx.world;
    const padsAreCurrent = !!world && world.ready && this.padsSeed === world.seed;
    if (clearPads || !padsAreCurrent) this.clearPads();
    else for (const p of this.pads) p.console.setState('idle');
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.hull.unregister();
    this.cinematic.stop(this.ctx);
    this.ship?.reset();
    this.flare?.reset();
    this.dust?.reset();
    this.activePad = null;
    this.preLanded = false;
    this.preLandedPhasePending = false;
    this.skipCompleted = false;   // 2026-09-15
    this.counting = false;
    this.countdown = 0;
    this.shipCalled = false;
    this.landed = false;
    this.lifting = false;
    this.riding = false;
    this.departing = false;
    this.departRemaining = -1;
    this.departAuto = false;
    this.idleRemaining = -1;
    this.lastDepartSecond = -1;
    this.liftoffElapsed = 0;
    this.squadDone = false;
    this.riderIds.clear();
    this.shipCorpses.length = 0;
    this.waitSendAccum = 0;
    this.doorsClosedEmitted = false;
    this.lastBeepSecond = -1;
    this.boardedPeers.clear();
    this.netTickAccum = 0;
    this.clientBoardedCount = 0;
    this.clientRequiredCount = 0;
    this.lastBoarded = [];
    this.landFallbackTimer = -1;
    // only a rider was ever put on the bay box (2026-09-13)
    if (wasRiding) this.ctx.player?.setShipInterior(null);
    // 2026-09-14 3차: 각본 잠금도 탑승자에게만 걸렸다 — 흐름이 리셋되면 함께 푼다 (끄기는 언제나 안전하다)
    if (wasRiding) this.ctx.player?.setSceneLock?.(false);
    this.boarded = false;
    if (keepPlayer) return;
    // Player detachment / control re-enable is handled by PlayerSystem on respawn; be defensive anyway.
    this.ctx.player?.attachTo(null);
    this.ctx.player?.setControlsEnabled(true);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unhookNet();
    this.clearPads();
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.hull.unregister();
    this.cinematic.stop(this.ctx);
    if (this.ctx.extraction) this.ctx.extraction = null;
    this.ship?.dispose(); this.ship = null;
    this.flare?.dispose(); this.flare = null;
    this.dust?.dispose(); this.dust = null;
  }
}
