/**
 * src/game/parts/Resume.ts — **the title's `이어하기` · `레이드 포기`** (`ctx.raidResume`, 2026-09-15).
 *
 * User's decision (`src/game/README.md` Decisions):
 *  - Starting the game with a raid left over begins **at the title, not straight in the raid**. The first `update()`
 *    used to call `resumeSoloRaid` the moment it saw the solo save — now that decision is one press of `이어하기`.
 *  - Abandon = death in that raid. Solo settles exactly like a death (equipment · bag · implants lost, death XP,
 *    failed contracts), a squad adds **drifting** on top (no rescue drop · no re-entry — the relay's
 *    `LobbyPlayer.drifted`), the tutorial clears the progress only and starts from the beginning.
 *  - The solo grace (`SOLO_RAID_GRACE_MS`) is read **at the moment of the press** — crossing it while sitting on the
 *    title makes `이어하기` disappear and settles the raid as a loss.
 *
 * The save file is **not deleted at boot** (it used to be deleted and written back on resume) — closing the window
 * without choosing anything on the title still leaves the next boot offering the same raid.
 *
 * A squad raid is only visible once connected to the relay. So a `SQUAD_RAID_MARK_KEY` mark is left when a squad raid
 * starts, and the title connects only when the boot found that mark — someone without one (most solo · offline
 * players) waits for nothing on the title.
 */
import type {
  GameContext, ItemInstance, LobbyPlayer, LobbyState, MissionStats, PlayerCorpseWire, RaidResumeMember, RaidResumeOffer,
  RaidResumeRef,
} from '@/shared';
import { GameContext as Ctx, SQUAD_RAID_MARK_KEY, activeSlot, androidNameOf, isBotPlayer, readSlotCard, sanitizeAccent, slotKey } from '@/shared';
import { bumpClockHigh, clearSoloRaid, loadSoloRaid, readClockHigh, soloRaidBootStatus, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { itemsToWire } from '../Corpses';
import type { GameFlowSystem } from '../GameFlowSystem';

const LATE_TEXT = '복귀가 너무 늦었습니다 — 레이드 실패';
/**
 * Poll period (ms) that catches the moment the solo grace runs out while sitting on the title. The judgement reads
 * the clock every time, so this is only how fast it reacts.
 */
const EXPIRY_POLL_MS = 1000;

interface SquadMark { code: string; seed: number }

export class RaidResume implements RaidResumeRef {
  /** The solo · tutorial save that was inside the grace (the file itself stays on disk). */
  private solo: SoloRaidSave | null = null;
  /**
   * Already too late at boot — settled as a loss on the first frame (`save` null = no save, only the kit's raid
   * marker was left behind, E-5 ③).
   */
  private staleAtBoot: { save: SoloRaidSave | null } | null = null;
  private mark: SquadMark | null = null;
  private check: Promise<void> | null = null;
  private _checking = false;
  private nextPollAt = 0;
  /** The shape of the last offer broadcast — an unchanged shape emits no second `raid:resumeChanged`. */
  private lastKey = '';
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly sys: GameFlowSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /** Once from `GameFlowSystem.init`. Inventory was init'd first, so the kit's raid marker can be read. */
  bind(): void {
    const ctx = this.ctx;
    ctx.raidResume = this;
    // 2026-09-11 (E-5): judged against the highest clock this slot has seen and the loadout's solo raid marker, then the
    // boot itself is recorded as a clock reading.
    const solo = loadSoloRaid();
    const now = Date.now();
    const status = soloRaidBootStatus(solo, ctx.inventory?.soloRaidSeed ?? null, now, readClockHigh());
    bumpClockHigh(now);
    if (status === 'fresh') this.solo = solo;
    else if (status === 'stale') this.staleAtBoot = { save: solo };
    this.mark = readMark();

    const b = ctx.bus;
    this.unsubs.push(
      // Entered a squad raid (launch · re-entry · resume) — so the next boot's title can ask after a reload cut it
      // An emit with no lobby (a smoke test · an older path) is no squad raid to get back into
      b.on('net:gameStarting', ({ seed, lobby, mode }) => { if ((mode ?? 'raid') === 'raid' && lobby?.code) this.writeMark({ code: lobby.code, seed }); }),
      // This person's raid ended — extraction · failure · abandon · return (`hub:enter`'s abort) · to the title
      b.on('game:complete', () => this.dropMark()),
      b.on('game:over', () => this.dropMark()),
      b.on('game:abort', () => this.dropMark()),
      b.on('net:lobbyLeft', () => { this.dropMark(); this.emitChanged(); }),
      b.on('net:lobbyUpdated', () => this.emitChanged()),
      b.on('net:resumed', () => this.emitChanged()),
      b.on('game:phaseChanged', () => this.emitChanged()),
    );
    // The title · auto start reads `checking` in the first microtask — so it starts here, not in the first `update()`
    this.startSquadCheck();
    this.emitChanged();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.ctx?.raidResume === this) this.ctx.raidResume = null;
  }

  /** Every frame from `GameFlowSystem.update` (returns at once when there is nothing to do). */
  update(): void {
    const ctx = this.ctx;
    if (this.staleAtBoot) {
      const { save } = this.staleAtBoot;
      this.staleAtBoot = null;
      if (ctx.phase === 'menu') this.failSolo(save, LATE_TEXT);   // already elsewhere (a squad rejoin got in first)
      return;
    }
    const solo = this.solo;
    if (!solo || solo.mode === 'tutorial' || ctx.phase !== 'menu') return;
    const now = performance.now();
    if (now < this.nextPollAt) return;
    this.nextPollAt = now + EXPIRY_POLL_MS;
    if (expired(solo)) this.failSolo(solo, LATE_TEXT);
  }

  /* ── RaidResumeRef ─────────────────────────────────────────────────── */

  get offer(): RaidResumeOffer | null {
    if (this.ctx.phase !== 'menu') return null;
    const solo = this.solo;
    if (solo) {
      const tutorial = solo.mode === 'tutorial';
      return { kind: tutorial ? 'tutorial' : 'solo', planet: tutorial ? null : solo.planet, missionTime: solo.missionTime, members: [this.localMember(null)] };
    }
    const lobby = this.squadLobby();
    if (!lobby) return null;
    return { kind: 'squad', planet: lobby.planet ?? null, missionTime: this.ctx.net?.raidBlob?.missionTime ?? 0, members: this.squadMembers(lobby) };
  }

  get checking(): boolean { return this._checking; }

  settled(): Promise<void> { return this.check ?? Promise.resolve(); }

  resume(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'menu') return false;
    const solo = this.solo;
    if (solo) {
      // 「judged at the moment of the press」 (user's decision) — it may have crossed between two polls
      if (expired(solo)) { this.failSolo(solo, LATE_TEXT); return false; }
      this.solo = null;
      this.sys.resumeSoloRaid(solo);   // the file stays — the resumed raid's first periodic save overwrites it
      this.emitChanged();
      return true;
    }
    const net = ctx.net;
    if (!net || !this.squadLobby()) return false;
    // → net:gameStarting {rejoin} + game:newMission (world · blob · the host's ghost restore)
    net.rejoinMission();
    this.emitChanged();
    return net.inSession;
  }

  abandon(): void {
    if (this.ctx.phase !== 'menu') return;
    const solo = this.solo;
    if (solo) {
      if (solo.mode === 'tutorial') this.restartTutorial();
      else this.failSolo(solo, '레이드를 포기했습니다 — 캐릭터가 사망해 소지품을 모두 잃었습니다');
      return;
    }
    const lobby = this.squadLobby();
    if (lobby) this.abandonSquad(lobby);
  }

  /* ── The squad raid check ───────────────────────────────────────────── */

  private startSquadCheck(): void {
    const net = this.ctx.net;
    if (!this.mark || !net || typeof net.ensureConnected !== 'function') return;
    // A link refused (kicked · lobby full · another window) never reconnects on its own (`shared/net` rule)
    if (net.link?.state === 'refused') return;
    this._checking = true;
    this.check = net.ensureConnected().catch(() => false).then((ok) => {
      this._checking = false;
      this.check = null;
      // Connected but that raid is gone (ended · no lobby · already drifted) — the mark has done its job. A failed
      // connection knows nothing, so the mark is kept.
      if (ok && !this.squadLobby()) this.dropMark();
      this.emitChanged();
    });
  }

  /** Whether the marked raid is still running with me dropped out of it (not yet drifted). */
  private squadLobby(): LobbyState | null {
    const mark = this.mark;
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    if (!mark || !net || !lobby || net.inSession) return null;
    if (!lobby.started || (lobby.mode ?? 'raid') !== 'raid' || lobby.code !== mark.code || lobby.seed !== mark.seed) return null;
    const me = net.localId ? lobby.players.find((p) => p.id === net.localId) : undefined;
    return me && !me.drifted ? lobby : null;
  }

  /* ── Portrait roster (same order · same source as the 매칭 tab) ────── */

  private localMember(lp: LobbyPlayer | null): RaidResumeMember {
    let card: ReturnType<typeof readSlotCard> | null = null;
    try { card = readSlotCard(activeSlot()); } catch { card = null; }
    const lvl = this.ctx.progression?.level;
    return {
      id: lp?.id ?? 'me', name: card?.name || lp?.name || this.ctx.net?.playerName || '나',
      level: typeof lvl === 'number' && lvl > 0 ? lvl : card?.level ?? null,
      // My accent comes from my own character (the save) — the value carried in the lobby is its echo
      accent: sanitizeAccent(card?.accent) ?? sanitizeAccent(lp?.accent) ?? null,
      slot: lp?.slot ?? 0, isHost: !!lp?.isHost, me: true, bot: false, bay: 0, connected: true, drifted: false,
    };
  }

  private squadMembers(lobby: LobbyState): RaidResumeMember[] {
    const me = this.ctx.net?.localId ?? null;
    const mine = lobby.players.find((p) => p.id === me) ?? null;
    const out = [this.localMember(mine)];
    for (const p of lobby.players.filter((q) => q !== mine).sort((a, c) => a.slot - c.slot)) {
      const bot = isBotPlayer(p);
      out.push({
        id: p.id, name: bot ? androidNameOf(p.bay ?? 0) : (p.name || '—'),
        level: !bot && typeof p.level === 'number' && p.level > 0 ? p.level : null,
        accent: sanitizeAccent(p.accent), slot: p.slot, isHost: !bot && p.isHost, me: false, bot, bay: p.bay ?? 0,
        connected: bot || p.connected !== false, drifted: p.drifted === true,
      });
    }
    return out;
  }

  /* ── Abandon · failure ──────────────────────────────────────────────── */

  /**
   * The end of a solo raid = the same loss as **death** (`parts/Death.onLocalDied`'s solo branch, user's decision
   * 「솔로도 완전히 잃는다」): equipped implants with no pair at all, and bag · equipment · quick slots · pouches
   * through `game:abort` → `inventory/parts/Lifecycle.onAbort`'s `loseKit` (which clears the kit's raid marker there
   * too). The grace running out · a save already too late at boot · an abandon all take this path.
   */
  private failSolo(save: SoloRaidSave | null, text: string): void {
    const ctx = this.ctx;
    this.solo = null;
    clearSoloRaid();
    try { ctx.progression?.stripImplantsForCorpse?.(); } catch (e) { console.error('[gameflow] implant strip on a lost solo raid failed', e); }
    if (save) {
      this.settle(save.stats, save.missionTime);
      // The intel broker's fixed gimmicks are consumed only once the raid ends (`meta/parts/Intel`) — if this
      // raid carried them out, they ended here
      if (save.intel?.length) { try { ctx.meta?.intel?.consume(); } catch (e) { console.error('[gameflow] intel consume failed', e); } }
    }
    ctx.bus.emit('game:abort', {});
    ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: 6 });
    this.emitChanged();
  }

  /**
   * Tutorial abandon (user's decision — 「처음부터 다시, 캐릭터 세이브는 남긴다」): clearing the raid track's progress alone
   * makes the next `게임 시작` open the tutorial raid from the beginning. What was picked up in the tutorial
   * belongs to that run, so the kit is emptied too (`game:abort` → `loseKit`) — keeping it would hand the replayed
   * tutorial the same weapon a second time. Level · credits · stash are left alone.
   */
  private restartTutorial(): void {
    const ctx = this.ctx;
    this.solo = null;
    clearSoloRaid();
    try { ctx.tutorial?.restartTrack?.('raid'); } catch (e) { console.error('[gameflow] tutorial restart failed', e); }
    ctx.bus.emit('game:abort', {});
    ctx.bus.emit('ui:notify', { text: '튜토리얼을 포기했습니다 — 다음에 시작하면 처음부터 다시 진행합니다', kind: 'warning', duration: 6 });
    this.emitChanged();
  }

  /**
   * Abandoning a squad raid = death on the spot + **drifting**. The order is the point:
   *  ① restore that raid's belongings from the blob the relay handed back, then strip them the way a death does
   *     (`InventoryRef.stripForCorpse` — equipped implants into broken pairs · the emptied kit saved at once). With
   *     no blob (the link died before the first save) the kit as it stands now is stripped.
   *  ② **I** spawn the corpse with those belongings — exactly the `pcorpse` convention (「the person who died sends
   *     it」), at the spot the body stood on (`RaidSessionBlob.pose`). Already dead (`state` 2) means the corpse
   *     stood back then and nothing was stripped.
   *     The id does not end in a number, so it never collides with a receiver's sequence (`PlayerCorpseManager.add`).
   *  ③ settlement — the same as the squad branch of a voluntary return (`parts/Death.finishReturnToShip`).
   *  ④ `lobby:abandon` — the relay records the drift and broadcasts it. Rescue candidates · re-entry read that.
   */
  private abandonSquad(lobby: LobbyState): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net) return;
    const blob = net.raidBlob;
    const me = net.localId;
    if (blob) { try { ctx.inventory?.applyRaidState(blob.inventory); } catch (e) { console.error('[gameflow] raid blob restore on abandon failed', e); } }
    let items: ItemInstance[] = [];
    try { items = ctx.inventory?.stripForCorpse?.() ?? []; } catch (e) { console.error('[gameflow] strip on abandon failed', e); }
    const pose = blob?.pose;
    if (blob && pose && pose.state !== 2 && me && items.length > 0) {
      const corpse: PlayerCorpseWire = {
        id: `pcorpse:${me}:d${Date.now().toString(36)}`, owner: me,
        name: lobby.players.find((p) => p.id === me)?.name || net.playerName || '분대원',
        p: [pose.x, pose.y, pose.z], yaw: pose.yaw, at: blob.missionTime, items: itemsToWire(items),
      };
      net.send({ t: 'pcorpse', ev: 'spawn', corpse }, 'others');
    }
    this.settle(blob?.stats ?? null, blob?.missionTime ?? 0);
    net.abandonRaid?.();
    this.dropMark();
    ctx.bus.emit('ui:notify', { text: '레이드를 포기했습니다 — 캐릭터가 사망해 표류 처리되었습니다', kind: 'danger', duration: 6 });
    this.emitChanged();
  }

  /**
   * Settlement of a raid that ended in death (`parts/Death.awardMissionXp` — kill XP `killXp` × the death multiplier,
   * contract settlement, the raid count). There is no results screen (this is the title). Preparations are cleared at
   * the end of the raid too (A-13).
   */
  private settle(stats: MissionStats | null | undefined, missionTime: number): void {
    const ctx = this.ctx;
    const seed = typeof stats?.seed === 'number' ? stats.seed : 0;
    ctx.missionMode = 'raid';
    ctx.stats = { ...Ctx.freshStats(seed), ...(stats ?? {}), extracted: false, lootValue: 0, timeSeconds: Math.max(0, missionTime), mode: 'raid' };
    this.sys.rewarded = false;
    this.sys.awardMissionXp();
    ctx.progression?.clearActivePreps();
  }

  /* ── The mark · broadcasting ────────────────────────────────────────── */

  private writeMark(mark: SquadMark): void {
    this.mark = mark;
    try { window.localStorage.setItem(slotKey(SQUAD_RAID_MARK_KEY), JSON.stringify(mark)); } catch { /* storage off */ }
  }

  private dropMark(): void {
    if (!this.mark) return;
    this.mark = null;
    try { window.localStorage.removeItem(slotKey(SQUAD_RAID_MARK_KEY)); } catch { /* storage off */ }
  }

  private emitChanged(): void {
    const offer = this.offer;
    const shape = offer
      ? `${offer.kind}|${offer.members.map((m) => `${m.id}${m.connected ? '' : '~'}${m.drifted ? '!' : ''}${m.isHost ? '*' : ''}`).join(',')}`
      : '-';
    const key = `${shape}|${this._checking ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ctx.bus.emit('raid:resumeChanged', { offer, checking: this._checking });
  }
}

/** Whether the grace has passed — the tutorial has no time limit (`soloRaidStatus`'s first line). */
function expired(save: SoloRaidSave): boolean {
  return save.mode !== 'tutorial' && soloRaidStatus(save, Date.now(), readClockHigh()) === 'stale';
}

function readMark(): SquadMark | null {
  try {
    const raw = window.localStorage.getItem(slotKey(SQUAD_RAID_MARK_KEY));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SquadMark> | null;
    return v && typeof v.code === 'string' && typeof v.seed === 'number' && Number.isFinite(v.seed) ? { code: v.code, seed: v.seed } : null;
  } catch { return null; }
}
