/**
 * src/net/parts/Plates.ts — **식탁 접시 와이어** (2026-09-16 접시 모델, 사용자 결정 — 규칙은 `shared/housing.ts` 의 접시 절, 와이어는
 * `shared/net.ts` 의 `PlateMessage` 절).
 *
 * 공유 함선의 고정 식탁에는 **분대원 전원의 접시**가 놓이고 누구든 어느 접시든 먹을 수 있다 (접시는 줄지 않고, 먹은 사람의 대기 식사가 된다).
 * 이 파일은 흐름만 만든다:
 *
 *   내 접시 변경 ── `housing:plateChanged` ──▶ (`inHubSession` 이면) `plate state {def?, q?, fresh?}` → others
 *   허브 세션에 들어섰다 (`tick`, false → true) ──▶ 내 `plate state` → others + `plateq sync` → others (늦게 들어온 사람도 모두의 접시를 받는다)
 *   `plateq sync` ── 로비 멤버 · 내가 허브 세션에 있을 때 ──▶ 요청자에게만 내 `plate state` (요청자별 `CHAR_BUFF_SYNC_COOLDOWN_S` 에 한 번)
 *   `plate state` ── 로비 멤버(봇 제외) · 요리 id(`getMealDef`) · 품질 정수 ──▶ `net:squadPlate {id, name, plate, fresh}` (housing 이 식탁에 올린다)
 *
 * 권위 검사가 없다 (옛 `meal serve` 의 호스트 경유는 없어졌다): 접시는 **보낸 사람 자신의 상태**이고, 먹는 효과는 먹는 사람 자기 프로필에만
 * 실린다(`progression.useMeal`) — 남에게 영향을 주는 메시지가 아니다. 요청 쿨다운은 새 수치를 만들지 않으려고 캐릭터 버프 목록의
 * 동기화 쿨다운(`CHAR_BUFF_SYNC_COOLDOWN_S`, 같은 「목록을 달라」 요청)을 그대로 쓴다. 서버는 한 줄도 바뀌지 않는다.
 */
import type { DiningPlate, PeerId, PlateMessage, PlateRequest, RelayTarget } from '@/shared';
import { CHAR_BUFF_SYNC_COOLDOWN_S, getMealDef, isBotPlayer, normalizeMealQuality } from '@/shared';
import type { NetSystem } from '../NetSystem';

const nowS = (): number => performance.now() / 1000;

export class PlateRelay {
  private sys: NetSystem | null = null;
  private offs: Array<() => void> = [];
  /** 지난 `tick` 에 허브 세션이었나 — 들어서는 순간(false → true)을 잡는다. */
  private wasInHub = false;
  /** 요청자별 마지막 답 (`performance.now()` 초). */
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

  /** `NetSystem.update` 마다 — 허브 세션에 들어선 프레임에 내 접시를 알리고 모두의 접시를 묻는다. */
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

  /* ── 보내는 쪽 ─────────────────────────────────────────────────────────── */
  private onLocalChanged(fresh: boolean): void {
    if (!this.sys?.inHubSession) return;          // 공유 함선 밖의 접시 변경은 들어설 때(`tick`) 한 번에 간다
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

  /* ── 받는 쪽 ───────────────────────────────────────────────────────────── */
  /** 연결된 로비 멤버인가 (나 자신 · 안드로이드 봇 멤버는 아니다 — 봇은 요리하지 않고 소켓도 없다). */
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
      if (typeof m.def !== 'string' || m.def.length > 64 || !getMealDef(m.def)) return;   // 모르는 요리 = 모양이 틀린 메시지
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
