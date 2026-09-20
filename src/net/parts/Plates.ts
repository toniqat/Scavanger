/**
 * src/net/parts/Plates.ts — **the dining-plate wire** (2026-09-16 the plate model, the user's decision — the rules
 * live in `shared/housing.ts`'s plate section, the wire in `shared/net.ts`'s `PlateMessage` section).
 *
 * The shared ship's fixed dining table holds **every squadmate's plate** and anyone may eat from any of them (a plate
 * is not used up; it becomes the eater's pending meal). This file only builds the flow:
 *
 *   my plate changed ── `housing:plateChanged` ──▶ (while `inHubSession`) `plate state {def?, q?, fresh?}` → others
 *   the hub session was entered (`tick`, false → true) ──▶ my `plate state` → others + `plateq sync` → others
 *                   (a late arrival gets everyone's plate too)
 *   `plateq sync` ── a lobby member · while I am in the hub session ──▶ my `plate state` to the requester alone
 *                   (once per `CHAR_BUFF_SYNC_COOLDOWN_S` per requester)
 *   `plate state` ── a lobby member (no bots) · a known meal id (`getMealDef`) · an integer quality ──▶
 *                   `net:squadPlate {id, name, plate, fresh}` (housing puts it on the table)
 *
 * There is no authority check (the old `meal serve` route through the host is gone): a plate is the **sender's own
 * state**, and eating loads only the eater's own profile (`progression.useMeal`) — it is not a message that affects
 * anyone else. Rather than invent a new number the request cooldown reuses the character-buff list's sync cooldown
 * (`CHAR_BUFF_SYNC_COOLDOWN_S`, the same "give me your list" request). Not one line of the server changes.
 */
import type { DiningPlate, PeerId, PlateMessage, PlateRequest, RelayTarget } from '@/shared';
import { CHAR_BUFF_SYNC_COOLDOWN_S, getMealDef, isBotPlayer, normalizeMealQuality } from '@/shared';
import type { NetSystem } from '../NetSystem';

const nowS = (): number => performance.now() / 1000;

export class PlateRelay {
  private sys: NetSystem | null = null;
  private offs: Array<() => void> = [];
  /** Was the last `tick` in the hub session — catches the moment of entering (false → true). */
  private wasInHub = false;
  /** Last answer per requester (`performance.now()` seconds). */
  private readonly answeredAt = new Map<PeerId, number>();

  init(sys: NetSystem): void {
    this.sys = sys;
    this.offs.push(
      sys.ctx.bus.on('housing:plateChanged', ({ reason }) => this.onLocalChanged(reason === 'cooked')),
      sys.onMessage('plate', (m, from) => this.onState(m, from)),
      sys.onMessage('plateq', (m, from) => this.onRequest(m, from)),
      sys.ctx.bus.on('net:lobbyLeft', () => { this.answeredAt.clear(); this.wasInHub = false; }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.answeredAt.clear();
    this.sys = null;
  }

  /** Every `NetSystem.update` — on the frame the hub session is entered, announce my plate and ask for everyone's. */
  tick(): void {
    const sys = this.sys;
    if (!sys) return;
    const now = sys.inHubSession;
    if (now && !this.wasInHub) {
      this.sendState('others', false);
      const req: PlateRequest = { t: 'plateq', ev: 'sync' };
      sys.send(req, 'others');
    }
    this.wasInHub = now;
  }

  /* ── the sending side ──────────────────────────────────────────────── */
  private onLocalChanged(fresh: boolean): void {
    if (!this.sys?.inHubSession) return;          // a plate change outside the shared ship goes out on entry (`tick`)
    this.sendState('others', fresh);
  }

  private sendState(to: RelayTarget, fresh: boolean): void {
    const sys = this.sys;
    if (!sys || !sys.client.connected || !sys.lobby) return;
    let plate: DiningPlate | null = null;
    try { plate = sys.ctx.housing?.getPlate?.() ?? null; } catch { plate = null; }
    const msg: PlateMessage = { t: 'plate', ev: 'state' };
    if (plate && getMealDef(plate.mealDefId)) {
      msg.def = plate.mealDefId;
      const q = normalizeMealQuality(plate.quality);
      if (q > 0) msg.q = q;
      if (fresh) msg.fresh = 1;
    }
    sys.send(msg, to);
  }

  /* ── the receiving side ─────────────────────────────────────────────── */
  /** A connected lobby member? (Never myself · never an android bot — a bot neither cooks nor has a socket.) */
  private isMember(from: PeerId): boolean {
    const sys = this.sys;
    if (!sys || from === sys.localId) return false;
    const p = sys.getLobbyPlayer(from);
    return !!p && p.connected !== false && !isBotPlayer(p);
  }

  private onState(m: PlateMessage, from: PeerId): void {
    const sys = this.sys;
    if (!sys || !m || typeof m !== 'object' || m.ev !== 'state' || !this.isMember(from)) return;
    let plate: DiningPlate | null = null;
    if (m.def !== undefined) {
      if (typeof m.def !== 'string' || m.def.length > 64 || !getMealDef(m.def)) return;   // unknown meal = malformed
      plate = { mealDefId: m.def, quality: normalizeMealQuality(m.q), cookedAt: 0 };
    }
    const name = sys.getLobbyPlayer(from)?.name ?? sys.getRemotePlayer(from)?.name ?? '분대원';
    sys.ctx.bus.emit('net:squadPlate', { id: from, name, plate, fresh: m.fresh === 1 && !!plate });
  }

  private onRequest(m: PlateRequest, from: PeerId): void {
    const sys = this.sys;
    if (!sys || !m || typeof m !== 'object' || m.ev !== 'sync' || !this.isMember(from) || !sys.inHubSession) return;
    const now = nowS();
    const last = this.answeredAt.get(from);
    if (last !== undefined && now - last < CHAR_BUFF_SYNC_COOLDOWN_S) return;
    this.answeredAt.set(from, now);
    this.sendState(from, false);
  }
}
