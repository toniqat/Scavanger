import type { FurniturePoseKind, PeerId, RemotePlayerRef } from '@/shared';
import type { FurnitureRig } from './FurnitureLeisure';
import { RUN_STRIDE_LENGTH, UNRACK_S, poseBelt, poseBenchBar, poseCrank, poseRock, restRig, type StagedPiece } from './GymStaging';

/* ────────────────────────────────────────────────────────────────────────────
 * 원격 가구 연출 (2026-09-12, 캐릭터 버프 · 가구 자세 동기화 — docs/plans/char-buffs.md §6-C).
 *
 * 분대원이 가구 자세를 취하면 net 이 스냅샷 `fp` · `fu` 를 보간해 `RemotePlayerRef.furniturePose` 로 준다. 여기서는 그 사람이
 * **같은 함선**(`hubSite`)에 있고 `furnitureUid` 가 지금 그려진 함선의 조각을 가리키면, 그 조각의 움직이는 부분을 그 사람의
 * 보간된 누적 위상으로 돌린다 — 로컬 `GymStaging` 과 **같은 함수**(`poseBenchBar` · `poseBelt` · `poseCrank` · `poseRock`)라
 * 방문자 화면의 바벨 높이 · 벨트 · 크랭크가 주인 화면과 같다.
 *
 *   bench / smith  원반 표시 · 바는 거치대 → 누르기 경로(`UNRACK_S` 동안) · 위상 0 … 1 을 그대로
 *   run            벨트 = 누적 걸음 수의 **차이** × `RUN_STRIDE_LENGTH` (뒤로 가거나 한 프레임에 `RUN_PHASE_JUMP` 넘게 뛰면
 *                  그 프레임은 벨트를 안 민다 — 자세가 다시 시작돼 위상이 0 으로 돌아가도 벨트가 거꾸로 감기지 않는다)
 *   cycle          크랭크 · 페달 · 플라이휠 = 누적 바퀴 수 (절대 위치라 되감겨도 순간 이동일 뿐 헛돌지 않는다)
 *   sit            흔들의자 흔들림 (위상은 늘 0 — 시각으로 흔든다)
 *
 * 자세가 끝나면(ref 의 `furniturePose` null · 목록에서 사라짐 · 끊김 · stale · 다른 함선) 그 조각을 쉬는 모습으로 되돌린다
 * (`restRig` — 원반 숨김 · 바는 거치대 · 의자 멈춤). **로컬 연출 중인 조각**(`GymStaging.uid` · 앉아 있는 흔들의자)은 절대 건드리지
 * 않는다. 조각은 매 프레임 uid 로 다시 찾는다 — 방이 다시 지어지면 rig 가 새 것으로 바뀌기 때문이다(`GymStaging.find` 와 같다).
 *
 * 핫 패스: 프레임당 할당이 없다 — 항목 배열은 인덱스로 돌고 제거는 swap-remove, 끝난 항목은 `spare` 로 돌려 재사용한다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 한 프레임에 이만큼(걸음)을 넘게 뛴 run 위상은 이음이 아니라 점프로 본다 — 벨트를 밀지 않는다. */
const RUN_PHASE_JUMP = 1.5;

interface Entry {
  peer: PeerId;
  uid: string;
  kind: FurniturePoseKind;
  /** 벤치: 거치대 → 누르기 경로 진행 (0 … 1). */
  unrack: number;
  /** 지난 프레임의 누적 위상 (run 의 차이 계산). */
  phase: number;
  /** 트레드밀 벨트 오프셋 (m, 감긴 값). */
  belt: number;
  /** 마지막으로 이 항목을 돌린 프레임 번호. */
  seen: number;
}

export interface RemoteStagingHost {
  /** uid 로 지금의 조각 (방이 다시 지어지면 바뀐다). */
  find(uid: string): StagedPiece | null;
  /** 로컬 플레이어가 이 조각을 쓰고 있다 (운동 세션 · 앉은 흔들의자) — 원격 연출은 손대지 않는다. */
  isLocal(uid: string): boolean;
}

export class RemoteFurnitureStaging {
  private readonly entries: Entry[] = [];
  private readonly spare: Entry[] = [];
  private frame = 0;

  constructor(private readonly host: RemoteStagingHost) {}

  /** 원격 분대원이 이 조각을 쓰고 있다 (방 재빌드가 원반을 낀 채로 짓는 데 쓴다). */
  drives(uid: string): boolean {
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i].uid === uid) return true;
    return false;
  }

  /** 디버그 · 스모크: 지금 연출 중인 원격 자세들. */
  get staged(): Array<{ peer: PeerId; uid: string; kind: FurniturePoseKind; phase: number }> {
    return this.entries.map((e) => ({ peer: e.peer, uid: e.uid, kind: e.kind, phase: e.phase }));
  }

  /**
   * 매 프레임 (`FurnitureLayer.update`, 로컬 `GymStaging` 다음). `refs` = 원격 분대원, `site` = 우리가 서 있는 함선
   * (`HubRef.hubSite` — 공유 함선 · 우리 함선이면 null 일 수 있고, ref 의 `hubSite` 와 **같을 때만** 받는다).
   */
  update(dt: number, time: number, refs: readonly RemotePlayerRef[], site: PeerId | null): void {
    const f = ++this.frame;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const pose = ref.furniturePose;
      if (!pose || !pose.furnitureUid) continue;
      if (ref.connected === false || ref.stale === true || ref.suspended === true) continue;
      if ((ref.hubSite ?? null) !== site) continue;
      const uid = pose.furnitureUid;
      if (this.host.isLocal(uid) || this.heldByOther(uid, ref.id, f)) continue;
      const rig = this.host.find(uid)?.model.rig;
      if (!rig || rig.pose !== pose.kind) continue;
      const phase = Number.isFinite(pose.phase) ? pose.phase : 0;
      let e = this.entryOf(ref.id);
      if (e && (e.uid !== uid || e.kind !== pose.kind)) {
        // 같은 사람이 다른 기구로 옮겼다 — 옛 조각부터 쉬게 한다
        this.release(e, f);
        reset(e, ref.id, uid, pose.kind, phase);
      }
      if (!e) {
        e = this.spare.pop() ?? { peer: ref.id, uid, kind: pose.kind, unrack: 0, phase, belt: 0, seen: f };
        reset(e, ref.id, uid, pose.kind, phase);
        this.entries.push(e);
      }
      e.seen = f;
      drive(rig, e, phase, dt, time);
    }
    // 이번 프레임에 아무도 가리키지 않은 항목 = 자세가 끝났다 (뒤에서부터 swap-remove — 뒤쪽은 이미 본 항목이다)
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.seen === f) continue;
      this.release(e, f);
      const last = this.entries.length - 1;
      this.entries[i] = this.entries[last];
      this.entries.length = last;
      this.spare.push(e);
    }
  }

  /** 전부 쉬는 모습으로 되돌리고 비운다 (layer dispose). */
  dispose(): void {
    const f = ++this.frame;
    for (let i = 0; i < this.entries.length; i++) this.release(this.entries[i], f);
    this.entries.length = 0;
    this.spare.length = 0;
  }

  private entryOf(peer: PeerId): Entry | null {
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i].peer === peer) return this.entries[i];
    return null;
  }

  /**
   * 다른 분대원이 이미(지난 프레임부터) 이 조각을 쓰고 있다 — 먼저 쓴 사람이 이긴다. 한 조각에 두 몸이 올라갈 수는 없지만, 스냅샷이
   * 엇갈린 한순간에 둘이 같은 uid 를 가리켜도 연출이 번갈아 깜빡이지 않게 한다.
   */
  private heldByOther(uid: string, peer: PeerId, f: number): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.uid === uid && e.peer !== peer && e.seen >= f - 1) return true;
    }
    return false;
  }

  /** 항목의 조각을 쉬게 한다 — 로컬이 쓰고 있거나 이번 프레임에 다른 항목이 돌렸으면 그대로 둔다. */
  private release(e: Entry, f: number): void {
    if (this.host.isLocal(e.uid)) return;
    for (let i = 0; i < this.entries.length; i++) {
      const o = this.entries[i];
      if (o !== e && o.uid === e.uid && o.seen === f) return;
    }
    const rig = this.host.find(e.uid)?.model.rig;
    if (rig) restRig(rig);
  }
}

function reset(e: Entry, peer: PeerId, uid: string, kind: FurniturePoseKind, phase: number): void {
  e.peer = peer; e.uid = uid; e.kind = kind; e.unrack = 0; e.phase = phase; e.belt = 0;
}

function drive(rig: FurnitureRig, e: Entry, phase: number, dt: number, time: number): void {
  switch (e.kind) {
    case 'bench':
      if (rig.plates) rig.plates.visible = true;
      e.unrack = Math.min(1, e.unrack + dt / UNRACK_S);
      poseBenchBar(rig, e.unrack, Math.min(1, Math.max(0, phase)));
      break;
    case 'run': {
      const d = phase - e.phase;
      // 새로 지은 벨트(방 재빌드)도 같은 오프셋으로 — 움직임이 없는 프레임에도 자리를 다시 넣는다
      e.belt = poseBelt(rig, e.belt + (d > 0 && d <= RUN_PHASE_JUMP ? d * RUN_STRIDE_LENGTH : 0));
      break;
    }
    case 'cycle':
      poseCrank(rig, phase);
      break;
    case 'sit':
      poseRock(rig, time);
      break;
  }
  e.phase = phase;
}
