/**
 * src/game/parts/Leader.ts — **분대장 기기** (2026-09-09).
 *
 * 이 파일이 답하는 질문: *호스트가 죽으면 분대장 자리는 어떻게 넘어가는가.*
 *
 * 멀티에서 호스트가 **완전히 사망**하면 시체 옆에 절차 생성 오브젝트(아이템이 아니다)가 떨어진다.
 * 죽은 호스트 본인이 `ctx.net.reportHostDown(true)` 로 서버에 표시를 남기고 — 서버는 그 표시가 있을 때만
 * 남의 `transferHost({claim:true})` 를 받아 준다 — 아무나 `LEADER_DEVICE_HOLD_S` 동안 꾹 눌러 회수하면
 * `transferHost(me, true)` 로 분대장이 넘어간다. 오브젝트 자체는 `lead taken` 이 치운다.
 *
 * 토스트(`분대장이 되었습니다`)의 주인은 여기다 — 커뮤니티 우클릭 이관이든 함선 안 상호작용이든
 * **모든 경로**가 `net:hostChanged` 로 모이므로 그 이벤트 하나만 구독한다.
 */
import * as THREE from 'three';
import { LEADER_DEVICE_HOLD_S, LEADER_DEVICE_RANGE, type Interactable, type LeaderMessage, type PeerId } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

const DEVICE_ID = 'leader_device';

/** 바닥에 떨어진 분대장 기기 — 각진 신호기 하나. 아이템이 아니라 오브젝트다 (인벤토리에 들어가지 않는다). */
export class LeaderDeviceObject implements Interactable {
  readonly id = DEVICE_ID;
  readonly radius = LEADER_DEVICE_RANGE;
  readonly holdTime = LEADER_DEVICE_HOLD_S;
  readonly position = new THREE.Vector3();
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly beacon: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private t = 0;

  constructor(private readonly sys: GameFlowSystem, readonly hostId: string, position: THREE.Vector3) {
    this.position.copy(position);
    this.group.name = 'LeaderDevice';
    this.group.position.copy(position);

    const shell = this.mat(new THREE.MeshStandardMaterial({ color: 0x232a36, metalness: 0.8, roughness: 0.4 }));
    const trim = this.mat(new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 0.5, roughness: 0.4 }));
    const glow = this.mat(new THREE.MeshStandardMaterial({ color: 0x0a1420, emissive: 0xffc23a, emissiveIntensity: 3, roughness: 0.3 }));

    const body = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.42, 0.16, 0.3)), shell);
    body.position.y = 0.08;
    this.group.add(body);
    const lid = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.44, 0.03, 0.32)), trim);
    lid.position.y = 0.175;
    this.group.add(lid);
    const mast = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.022, 0.03, 0.36, 8)), shell);
    mast.position.y = 0.37;
    this.group.add(mast);
    this.beacon = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.075, 12, 8)), glow);
    this.beacon.position.y = 0.58;
    this.group.add(this.beacon);
    const ring = new THREE.Mesh(this.geo(new THREE.TorusGeometry(0.19, 0.014, 6, 20)), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.21;
    this.group.add(ring);
    this.light = new THREE.PointLight(0xffc23a, 8, 9, 2);
    this.light.position.y = 0.6;
    this.group.add(this.light);
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  private mat<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }

  /** 느린 맥동 — 멀리서도 눈에 띄어야 한다. 프레임마다 도는 유일한 부분이다. */
  update(dt: number): void {
    this.t += dt;
    const k = 0.55 + Math.sin(this.t * 3.4) * 0.45;
    this.light.intensity = 4 + k * 10;
    this.beacon.scale.setScalar(0.9 + k * 0.25);
    this.group.rotation.y += dt * 0.6;
  }

  getPrompt(): string | null { return '분대장 기기 회수'; }

  canInteract(): boolean {
    const ctx = this.sys.ctx;
    if (!ctx.isGameplayActive() || !ctx.isMultiplayer) return false;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return false;
    return !!ctx.net?.localId && !ctx.net.isHost;
  }

  interact(): void { takeDevice(this.sys); }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}

/* ─────────────────────────── net ─────────────────────────── */

export function hookLeaderNet(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.leaderUnsubs.length > 0) return;
  sys.leaderUnsubs.push(
    net.onMessage('lead', (msg) => onLeaderMessage(sys, msg)),
    net.onMessage('leadq', (msg, from) => { if (msg.ev === 'sync' && net.isHost) sendLeaderSync(sys, from); }),
    net.onMessage('flow', (msg, from) => { if (msg.ev === 'rejoined' && net.isHost) sendLeaderSync(sys, from); }),
  );
}

export function unhookLeaderNet(sys: GameFlowSystem): void {
  for (const u of sys.leaderUnsubs) u();
  sys.leaderUnsubs.length = 0;
}

export function onLeaderMessage(sys: GameFlowSystem, msg: LeaderMessage): void {
  if (msg.ev === 'drop') {
    placeDevice(sys, new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]), msg.host, false);
  } else if (msg.ev === 'taken') {
    clearDevice(sys);
  } else if (msg.ev === 'sync') {
    if (!msg.p || !msg.host) { clearDevice(sys); return; }
    placeDevice(sys, new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]), msg.host, false);
  }
}

/** 클라이언트: 지금 바닥에 기기가 있나 (`world:ready` 이후 · 재합류 · 호스트 이관). */
export function requestLeaderSync(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer || net.isHost) return;
  net.send({ t: 'leadq', ev: 'sync' }, 'host');
}

export function sendLeaderSync(sys: GameFlowSystem, to: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  const d = sys.leaderDevice;
  net.send({
    t: 'lead', ev: 'sync',
    p: d ? [d.position.x, d.position.y, d.position.z] : null,
    host: d ? d.hostId : null,
  }, to);
}

/* ─────────────────────────── flow ─────────────────────────── */

/**
 * 로컬 플레이어가 완전히 사망했다. 그가 **호스트였다면** 시체 옆에 기기를 떨어뜨리고
 * 서버에 `hostDown` 표시를 남긴다 (그 표시가 있어야 남의 claim 이 통과한다).
 */
export function onHostDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net || !net.isHost || !net.localId) return;
  const p = ctx.player?.position;
  const pos = new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
  // 시체 바로 옆 — 시체와 기기를 한 화면에서 같이 보게
  pos.x += 1.1;
  if (ctx.world?.ready) pos.y = ctx.world.getHeightAt(pos.x, pos.z);
  placeDevice(sys, pos, net.localId, true);
  try { net.reportHostDown?.(true); } catch (e) { console.error('[gameflow] reportHostDown failed', e); }
}

/** 호스트가 되살아났다 (구조선) → 표시를 내리고 기기를 치운다. */
export function onHostRevived(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net) return;
  if (net.isHost) { try { net.reportHostDown?.(false); } catch { /* 서버가 옛 버전 */ } }
  if (sys.leaderDevice && net.isHost) {
    clearDevice(sys);
    net.send({ t: 'lead', ev: 'taken', by: net.localId ?? '' }, 'others');
  }
}

export function placeDevice(sys: GameFlowSystem, position: THREE.Vector3, hostId: string, announce: boolean): void {
  const ctx = sys.ctx;
  if (sys.leaderDevice) {
    if (sys.leaderDevice.hostId === hostId) return;
    clearDevice(sys);
  }
  const d = new LeaderDeviceObject(sys, hostId, position);
  sys.leaderDevice = d;
  ctx.scene.add(d.group);
  ctx.interactables.register(d);
  ctx.bus.emit('leader:deviceDropped', { position: d.position.clone(), hostId });
  if (announce && ctx.isMultiplayer) {
    ctx.net?.send({ t: 'lead', ev: 'drop', p: [position.x, position.y, position.z], host: hostId }, 'others');
  }
}

export function clearDevice(sys: GameFlowSystem): void {
  const d = sys.leaderDevice;
  if (!d) return;
  sys.leaderDevice = null;
  sys.ctx.interactables.unregister(d.id);
  d.dispose();
}

/** 3초 홀드 완료: 서버에 분대장을 청구하고 오브젝트를 치운다 (`lead taken`). */
export function takeDevice(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const me = net?.localId;
  if (!net || !me || !sys.leaderDevice) return;
  try { net.transferHost?.(me, true); } catch (e) { console.error('[gameflow] transferHost failed', e); }
  net.send({ t: 'lead', ev: 'taken', by: me }, 'others');
  ctx.bus.emit('leader:deviceTaken', { by: me, byName: net.getLobbyPlayer?.(me)?.name ?? net.playerName });
  clearDevice(sys);
}

/**
 * **분대장이 바뀌었다** — 어떤 경로로든. 오른쪽 토스트는 이 한 곳에서만 뜬다
 * (커뮤니티 우클릭 이관 · 함선 안 상호작용 이관도 전부 `net:hostChanged` 로 들어온다).
 */
export function onHostChangedToast(sys: GameFlowSystem, hostId: string, isLocalHost: boolean): void {
  const ctx = sys.ctx;
  // 함선(로비만 있고 미션은 없음)에서의 이관도 알려야 하므로 `isMultiplayer`(= inSession) 가 아니라 로비 유무로 본다
  if (!ctx.net?.lobby) return;
  if (isLocalHost) {
    ctx.bus.emit('ui:notify', { text: '분대장이 되었습니다', kind: 'success', duration: 3.5 });
  } else {
    const name = ctx.net?.getLobbyPlayer?.(hostId)?.name ?? '분대원';
    ctx.bus.emit('ui:notify', { text: `${name} 님이 분대장이 되었습니다`, kind: 'info', duration: 3.5 });
  }
  // 새 분대장이 살아 있다면 기기는 의미를 잃는다
  clearDevice(sys);
}

export function updateLeader(sys: GameFlowSystem, dt: number): void {
  sys.leaderDevice?.update(dt);
}
