import * as THREE from 'three';
import type { HubAndroidBay } from '@/shared';
import { ANDROID_BAY_COUNT, androidNameOf } from '@/shared';
import type { GeoBatch } from './GeoBatch';
import { HUB_MATS as M, yawFromForward } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';
import { TextPlane } from '../Labels';

/**
 * src/hub/interiors/AndroidBays.ts — **조종실 안드로이드 슬롯 세 칸** (2026-09-15, 사용자 결정
 * 「매칭 후, 공용 함선 조종실 내부 한켠에 안드로이드 슬롯이 3칸」 — docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원」).
 *
 * 공용 함선 **좌현 조종실**의 한켠, 조타 콘솔(x ≈ −12.4)과 후방 병기고(z ≈ 6.3) 사이의 빈 구석에 캡슐 세 개가
 * Z 축을 따라 한 줄로 서서 **+X (갑판 쪽)** 을 본다. 자리를 여기로 고른 이유:
 *  - 조종실 반쪽이면서 터미널(−9.8, 0) · 조종석 의자(±2.2) · 함선 컴퓨터(−11, −6.65) · 발사 포드(−Z) ·
 *    격납고 문(+Z 가운데) 어느 콜라이더와도 겹치지 않고, 에어락(+X) → 갑판 → 포드의 통로도 비켜 간다.
 *  - **좌현 x ≈ −8 은 비워 둔다** — `smoke-hangar` 가 「출입구 옆에서는 후벽에 막힌다」를 확인하려고 걸어 보는
 *    줄이라, 병기고 총기 랙을 옮겨 자리를 넓히는 대신 그 앞의 빈 구석을 쓴다.
 *
 * 광원은 **하나도 만들지 않는다** (CLAUDE.md §4.5): 상태 표시는 자체 발광(`emissive`) 재질 띠 하나뿐이고,
 * 그 띠와 이름표만 자기 메시를 갖는다 (나머지 껍데기는 함선의 `GeoBatch` 에 합쳐져 드로콜이 늘지 않는다).
 * 지오메트리는 모든 클라이언트에서 같다 — 함선의 위치 스냅샷과 allies/ 의 잠든 몸 위치가 여기에 기댄다.
 */

/** 캡슐 한 칸의 바깥 크기 (m): X = 깊이, Y = 높이, Z = 폭. */
const CAP_D = 0.9;
const CAP_H = 2.25;
const CAP_W = 0.95;
/** 캡슐 발판(몸이 서는 곳)의 x 와, 칸 사이 간격 · 첫 칸의 z. */
const BAY_X = -11.45;
const BAY_Z0 = 3.2;
const BAY_PITCH = 1.05;
/** 캡슐 밖 한 걸음 (m) — 나오는 연출의 끝 · 상호작용 지점의 거리. */
const EXIT_STEP = 1.1;

/** 상태 띠 색: 잠들어 있다(안드로이드가 안에 있다) · 나가 있다(분대원) · 요청 대기. */
export type AndroidBayState = 'dormant' | 'out' | 'pending';
const STATE_COLOR: Readonly<Record<AndroidBayState, number>> = {
  dormant: 0x3ac8ff,
  out: 0x3a4550,
  pending: 0xffa640,
};
const STATE_KO: Readonly<Record<AndroidBayState, string>> = {
  dormant: '대기',
  out: '분대원',
  pending: '처리 중',
};

/**
 * 세 칸짜리 캡슐 랙. 껍데기는 넘겨받은 `GeoBatch` 에 합치고, **상태 띠와 이름표만** 자기 메시로 들고 있다
 * (칸마다 색이 달라져야 하므로 합칠 수 없다). `bays` 는 재사용 배열 — 좌표는 지어진 뒤 바뀌지 않는다.
 */
export class AndroidBayRack {
  readonly bays: HubAndroidBay[] = [];
  private readonly strips: THREE.Mesh[] = [];
  private readonly stripMats: THREE.MeshStandardMaterial[] = [];
  private readonly tags: TextPlane[] = [];
  private readonly states: AndroidBayState[] = [];
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor(b: GeoBatch, col: BoxInteriorCollider, parent: THREE.Object3D) {
    // 갑판 쪽(+X)을 보는 한 방향 — 몸 앞 = (−sin yaw, 0, −cos yaw) 규약 (`yawFromForward`)
    const yaw = yawFromForward(1, 0);
    // 랙 전체를 받치는 바닥판 (세 칸을 하나로 읽히게 한다)
    const zSpan = (ANDROID_BAY_COUNT - 1) * BAY_PITCH + CAP_W + 0.2;
    const zMid = BAY_Z0 + ((ANDROID_BAY_COUNT - 1) * BAY_PITCH) / 2;
    b.box(CAP_D + 0.2, 0.06, zSpan, BAY_X, 0.03, zMid, M.hullDark);
    b.box(0.06, 0.03, zSpan, BAY_X + CAP_D / 2 + 0.06, 0.07, zMid, M.stripAmber);

    for (let i = 0; i < ANDROID_BAY_COUNT; i++) {
      const cz = BAY_Z0 + i * BAY_PITCH;
      // 뒷판 · 옆판 · 위판 · 받침 — 앞(+X)만 열려 있고 그 앞을 유리가 막는다
      b.boxB(0.18, CAP_H, CAP_W, BAY_X - CAP_D / 2 + 0.09, 0, cz, M.hullLight);
      for (const s of [-1, 1]) b.boxB(CAP_D, CAP_H, 0.1, BAY_X, 0, cz + s * (CAP_W / 2 - 0.05), M.hullDark);
      b.box(CAP_D + 0.12, 0.14, CAP_W + 0.12, BAY_X, CAP_H + 0.07, cz, M.trimDark);
      b.boxB(CAP_D + 0.1, 0.12, CAP_W + 0.1, BAY_X, 0, cz, M.hullDark);
      // 전면 유리 (갑판에서 안이 보인다)
      b.box(0.05, CAP_H - 0.35, CAP_W - 0.22, BAY_X + CAP_D / 2 - 0.03, 0.18 + (CAP_H - 0.35) / 2, cz, M.glassDark);

      /*
       * 콜라이더는 캡슐 실루엣 한 덩어리다 (CLAUDE.md §4.4 「콜라이더는 보이는 실루엣을 따른다」). 안에 서는 것은
       * allies/ 가 그리는 몸일 뿐 물리 대상이 아니므로, 앞을 열어 두면 플레이어가 캡슐 안으로 걸어 들어가 몸과
       * 겹친다 — 통째로 막는다.
       */
      col.addBox(BAY_X, 0, cz, CAP_D + 0.1, CAP_H, CAP_W + 0.1);

      // 상태 띠 (자체 발광만 — 광원은 만들지 않는다)
      const mat = new THREE.MeshStandardMaterial({ color: 0x1a2028, emissive: STATE_COLOR.dormant, emissiveIntensity: 1.6, roughness: 0.5 });
      this.stripMats.push(mat);
      this.disposables.push(mat);
      const geo = new THREE.BoxGeometry(0.08, 0.06, CAP_W - 0.26);
      this.disposables.push(geo);
      const strip = new THREE.Mesh(geo, mat);
      strip.position.set(BAY_X + CAP_D / 2 + 0.02, CAP_H - 0.12, cz);
      parent.add(strip);
      this.strips.push(strip);

      // 이름표 — 갑판(+X)에서 읽는다 (PlaneGeometry 는 +Z 를 보므로 y 를 +π/2 돌린다)
      const tag = new TextPlane(1.0, 0.3, 256);
      tag.mesh.position.set(BAY_X + CAP_D / 2 + 0.03, CAP_H + 0.34, cz);
      tag.mesh.rotation.y = Math.PI / 2;
      parent.add(tag.mesh);
      this.tags.push(tag);

      this.states.push('dormant');
      this.bays.push({
        bay: i,
        position: new THREE.Vector3(BAY_X, 0, cz),
        yaw,
        exit: new THREE.Vector3(BAY_X + EXIT_STEP, 0, cz),
      });
      this.paint(i);
    }
  }

  /** 슬롯 상태를 바꾼다 (같은 값이면 아무것도 하지 않는다). */
  setState(bay: number, state: AndroidBayState): void {
    if (bay < 0 || bay >= this.states.length || this.states[bay] === state) return;
    this.states[bay] = state;
    this.paint(bay);
  }

  stateOf(bay: number): AndroidBayState { return this.states[bay] ?? 'dormant'; }

  private paint(bay: number): void {
    const state = this.states[bay];
    const color = STATE_COLOR[state];
    const mat = this.stripMats[bay];
    mat.emissive.setHex(color);
    mat.emissiveIntensity = state === 'out' ? 0.4 : 1.8;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    this.tags[bay].set([androidNameOf(bay), STATE_KO[state]], hex, 'rgba(6,8,10,0.85)');
  }

  /** 요청을 기다리는 칸만 맥동한다 (재질 하나의 `emissiveIntensity` — 광원도, 할당도 없다). */
  update(_dt: number, time: number): void {
    for (let i = 0; i < this.states.length; i++) {
      if (this.states[i] !== 'pending') continue;
      this.stripMats[i].emissiveIntensity = 1.0 + 1.2 * (0.5 + 0.5 * Math.sin(time * 5.0));
    }
  }

  dispose(): void {
    for (const s of this.strips) s.removeFromParent();
    this.strips.length = 0;
    for (const t of this.tags) t.dispose();
    this.tags.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.bays.length = 0;
  }
}
