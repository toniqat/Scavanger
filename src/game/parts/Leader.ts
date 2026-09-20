/**
 * src/game/parts/Leader.ts — **the squad-leader device** (2026-09-09).
 *
 * The question this file answers: *when the host dies, how does the squad-leader seat pass on.*
 *
 * In multiplayer a **full death** of the host drops a procedurally generated object (not an item) beside the corpse.
 * The dead host itself leaves a mark on the server with `ctx.net.reportHostDown(true)` — the server accepts someone
 * else's `transferHost({claim:true})` only while that mark is there — and once a squadmate holds for
 * `LEADER_DEVICE_HOLD_S` to collect it, `transferHost(me, true)` passes the squad leader over. **Not anyone**:
 * `canInteract` wants a live gameplay phase in a session and refuses the current host and a dead or downed body,
 * so the seat only ever moves to someone standing who does not hold it already. The object itself is
 * cleared by `lead taken`.
 *
 * The toast (`분대장이 되었습니다`) is owned here — a community right-click transfer or an interaction inside the
 * ship, **every path** gathers at `net:hostChanged`, so that one event is the only subscription.
 */
import * as THREE from 'three';
import { LEADER_DEVICE_HOLD_S, LEADER_DEVICE_RANGE, type Interactable, type LeaderMessage, type PeerId } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

const DEVICE_ID = 'leader_device';

/**
 * The device's point light **does not live inside the device** (2026-09-10). three.js does not count a light that is
 * invisible or not in the scene, so adding the device to the scene and taking it out alone makes `numPointLights`
 * rise and fall, and **every material in the scene recompiles its shader** each time — twice, at exactly the moment
 * the host died and the squad is most pressed. So one light is planted in the scene at `init`
 * (`installLeaderLight`) and the device gives it **only a position and an intensity**. The same rule as
 * `core/fx/FlashPool` and `extraction/Ship`.
 */
let deviceLight: THREE.PointLight | null = null;

/** Once, from `GameFlowSystem.init`. The light stays in the scene all raid; with no device `intensity` is 0. */
export function installLeaderLight(sys: GameFlowSystem): void {
  if (deviceLight) return;
  deviceLight = new THREE.PointLight(0xffc23a, 0, 9, 2);
  deviceLight.name = 'LeaderDeviceLight';
  sys.ctx.scene.add(deviceLight);
}

/** The squad-leader device on the ground — one angular beacon. An object, not an item (never in the inventory). */
export class LeaderDeviceObject implements Interactable {
  readonly id = DEVICE_ID;
  readonly radius = LEADER_DEVICE_RANGE;
  readonly holdTime = LEADER_DEVICE_HOLD_S;
  readonly position = new THREE.Vector3();
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly beacon: THREE.Mesh;
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
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  private mat<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }

  /** A slow pulse — it has to stand out from far away. The only part that runs every frame. */
  update(dt: number): void {
    this.t += dt;
    const k = 0.55 + Math.sin(this.t * 3.4) * 0.45;
    if (deviceLight) {
      deviceLight.position.set(this.position.x, this.position.y + 0.6, this.position.z);
      deviceLight.intensity = 4 + k * 10;
    }
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
    if (deviceLight) deviceLight.intensity = 0;   // the light stays in the scene — only the intensity is turned off
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

/** Client: is there a device on the ground right now (after `world:ready` · a rejoin · a host transfer). */
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
 * The local player died fully. **If it was the host**, the device is dropped beside the corpse and a `hostDown` mark
 * is left on the server (only with that mark does someone else's claim pass).
 */
export function onHostDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net || !net.isHost || !net.localId) return;
  const p = ctx.player?.position;
  const pos = new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
  // right beside the corpse — so the corpse and the device are seen together on one screen
  pos.x += 1.1;
  if (ctx.world?.ready) pos.y = ctx.world.getHeightAt(pos.x, pos.z);
  placeDevice(sys, pos, net.localId, true);
  try { net.reportHostDown?.(true); } catch (e) { console.error('[gameflow] reportHostDown failed', e); }
}

/** The host came back alive (a rescue drop) → drops the mark and clears the device. */
export function onHostRevived(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net) return;
  if (net.isHost) { try { net.reportHostDown?.(false); } catch { /* an older server build */ } }
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

/** The `LEADER_DEVICE_HOLD_S` hold completed: claims the squad leader from the server and clears the object (`lead taken`). */
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
 * **The squad leader changed** — by whatever path. The right-side toast is raised in this one place only
 * (a community right-click transfer · a transfer by interaction inside the ship all arrive as `net:hostChanged`).
 */
export function onHostChangedToast(sys: GameFlowSystem, hostId: string, isLocalHost: boolean): void {
  const ctx = sys.ctx;
  // a transfer in the ship (a lobby but no mission) has to be announced too, so it looks at whether there is a
  // lobby, not at `isMultiplayer` (= inSession)
  if (!ctx.net?.lobby) return;
  if (isLocalHost) {
    ctx.bus.emit('ui:notify', { text: '분대장이 되었습니다', kind: 'success', duration: 3.5 });
  } else {
    const name = ctx.net?.getLobbyPlayer?.(hostId)?.name ?? '분대원';
    ctx.bus.emit('ui:notify', { text: `${name} 님이 분대장이 되었습니다`, kind: 'info', duration: 3.5 });
  }
  // with a new squad leader alive the device has lost its meaning
  clearDevice(sys);
}

export function updateLeader(sys: GameFlowSystem, dt: number): void {
  sys.leaderDevice?.update(dt);
}
