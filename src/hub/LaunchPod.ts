import * as THREE from 'three';
import type { GameContext, Interactable } from '@/shared';
import { HUB_MATS as M } from './interiors/GeoBatch';
import type { BoxInteriorCollider } from './interiors/InteriorCollider';
import type { PodSlotDef } from './interiors/types';
import { TextPlane } from './Labels';

/** Door opening angle (radians) — the sliding door covers this arc when closed. */
const GAP = 1.75;
const POD_R = 0.8;
const POD_H = 2.7;
const DOOR_SPEED = 2.6;      // 1/s

export interface PodInteraction {
  getPrompt(): string | null;
  canInteract(): boolean;
  interact(): void;
}

export interface PodDisplay {
  /** Peer occupying the pod (null = empty). */
  occupant: string | null;
  /** Name shown on the tag ('빈 슬롯' when empty). */
  name: string;
  /** Second tag line (준비 / 대기 중 / 연결 끊김 / 임무 진행 중 …). */
  state: string;
  local: boolean;
  /** Door closed (occupied by anyone). */
  closed: boolean;
}

const _cam = new THREE.Vector3();

/**
 * Launch pod: open cylinder body with a sliding door, slot-coloured floor ring + interior strip, a CanvasTexture
 * name tag above, and an `Interactable` in front of the door. Geometry is identical on every client.
 */
export class LaunchPod {
  readonly slot: number;
  readonly def: PodSlotDef;
  readonly root = new THREE.Group();
  readonly interactable: Interactable;
  private door: THREE.Mesh;
  private doorOpen = 1;           // 0 closed … 1 open
  private doorTarget = 1;
  private ringMat: THREE.MeshBasicMaterial;
  private stripMat: THREE.MeshStandardMaterial;
  private bodyMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshStandardMaterial;
  private tag: TextPlane;
  private display: PodDisplay = { occupant: null, name: '빈 슬롯', state: '대기', local: false, closed: false };
  private pulse = 0;
  private disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly colorHex: string;

  constructor(private readonly ctx: GameContext, def: PodSlotDef, color: number, private readonly collider: BoxInteriorCollider, interaction: PodInteraction) {
    this.slot = def.slot;
    this.def = def;
    this.colorHex = `#${color.toString(16).padStart(6, '0')}`;
    const g = this.root;
    g.name = `LaunchPod${def.slot}`;
    g.position.copy(def.position);
    g.rotation.y = Math.atan2(def.door.x, def.door.z);   // local +Z = door direction

    const keep = <T extends THREE.BufferGeometry | THREE.Material>(d: T): T => { this.disposables.push(d); return d; };

    // body (open toward +Z)
    this.bodyMat = keep(M.hullLight.clone()); this.bodyMat.side = THREE.DoubleSide;
    const body = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R, POD_R, POD_H, 28, 1, true, GAP / 2, Math.PI * 2 - GAP)), this.bodyMat);
    body.position.y = POD_H / 2; body.castShadow = true; body.receiveShadow = true;
    // door
    const doorMat = keep(M.hullDark.clone()); doorMat.side = THREE.DoubleSide;
    this.door = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R + 0.03, POD_R + 0.03, POD_H - 0.1, 10, 1, true, -GAP / 2, GAP)), doorMat);
    this.door.position.y = POD_H / 2; this.door.castShadow = true;
    // door window
    const win = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R + 0.04, POD_R + 0.04, 0.7, 8, 1, true, -GAP / 4, GAP / 2)), M.glassDark);
    win.position.y = 1.55;
    this.door.add(win);
    // caps + rails
    const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R + 0.12, POD_R + 0.12, 0.14, 28)), M.trimDark);
    cap.position.y = POD_H + 0.07;
    const base = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R + 0.14, POD_R + 0.2, 0.12, 28)), M.hullDark);
    base.position.y = 0.06;
    const rail = new THREE.Mesh(keep(new THREE.CylinderGeometry(POD_R + 0.05, POD_R + 0.05, 0.08, 28, 1, true)), M.trim);
    rail.position.y = 1.0;
    // top lamp
    this.lampMat = keep(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.4 }));
    const lamp = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 0.08, 0.16)), this.lampMat);
    lamp.position.set(0, POD_H + 0.18, POD_R * 0.55);
    // inner rear strip
    this.stripMat = keep(new THREE.MeshStandardMaterial({ color: 0x223, emissive: color, emissiveIntensity: 0.9, roughness: 0.5 }));
    const strip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.16, 2.0, 0.06)), this.stripMat);
    strip.position.set(0, 1.4, -POD_R + 0.05);
    // floor ring
    this.ringMat = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(POD_R + 0.25, POD_R + 0.42, 40)), this.ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.015;
    const pad = new THREE.Mesh(keep(new THREE.CircleGeometry(POD_R + 0.2, 32)), keep(new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.9, metalness: 0.3 })));
    pad.rotation.x = -Math.PI / 2; pad.position.y = 0.012; pad.receiveShadow = true;
    // name tag above
    this.tag = new TextPlane(1.7, 0.5, 512);
    this.tag.mesh.position.set(0, POD_H + 0.62, 0);

    g.add(body, this.door, cap, base, rail, lamp, strip, ring, pad, this.tag.mesh);
    ctx.scene.add(g);

    const front = def.position.clone().addScaledVector(def.door, 1.0);
    this.interactable = {
      id: `hub_pod_${def.slot}`,
      position: front,
      radius: 2.2,
      holdTime: 0.4,
      getPrompt: () => interaction.getPrompt(),
      canInteract: () => interaction.canInteract(),
      interact: () => interaction.interact(),
    };
    ctx.interactables.register(this.interactable);
    this.applyDisplay();
  }

  get occupant(): string | null { return this.display.occupant; }

  /** Update occupancy / tag. Returns true when the occupant changed. */
  setDisplay(d: PodDisplay): boolean {
    const changed = d.occupant !== this.display.occupant;
    this.display = d;
    this.applyDisplay();
    return changed;
  }

  private applyDisplay(): void {
    const d = this.display;
    this.doorTarget = d.closed ? 0 : 1;
    this.collider.setBlockerEnabled(this.def.doorBlocker, d.closed && !d.local);
    const accent = d.occupant ? this.colorHex : '#9a9a9a';
    this.tag.set([d.name, d.state], accent, 'rgba(6,8,10,0.78)', d.occupant ? '#e8e6e1' : '#8a8a8a');
    this.stripMat.emissiveIntensity = d.occupant ? 2.2 : 0.6;
    this.lampMat.emissiveIntensity = d.occupant ? 2.0 : 0.7;
  }

  /** Camera framing for the boarded local player (in front of the door, over-shoulder). */
  getCameraShot(pos: THREE.Vector3, lookAt: THREE.Vector3): void {
    const d = this.def.door;
    pos.copy(this.def.position).addScaledVector(d, 3.1);
    pos.x += -d.z * 0.9; pos.z += d.x * 0.9;
    pos.y += 1.95;
    lookAt.copy(this.def.position);
    lookAt.y += 1.25;
  }

  update(dt: number, time: number): void {
    if (this.doorOpen !== this.doorTarget) {
      const dir = Math.sign(this.doorTarget - this.doorOpen);
      this.doorOpen = THREE.MathUtils.clamp(this.doorOpen + dir * dt * DOOR_SPEED, 0, 1);
      if (Math.abs(this.doorOpen - this.doorTarget) < 1e-3) this.doorOpen = this.doorTarget;
      const e = this.doorOpen < 0.5 ? 2 * this.doorOpen * this.doorOpen : 1 - Math.pow(-2 * this.doorOpen + 2, 2) / 2;
      this.door.rotation.y = e * (GAP + 0.15);
    }
    this.pulse = this.display.occupant ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(time * 3.2)) : 0.22 + 0.1 * Math.sin(time * 1.4);
    this.ringMat.opacity = this.pulse;
    // billboard the tag (yaw only)
    _cam.copy(this.ctx.camera.position);
    this.root.worldToLocal(_cam);
    this.tag.mesh.rotation.y = Math.atan2(_cam.x, _cam.z);
  }

  dispose(): void {
    this.ctx.interactables.unregister(this.interactable.id);
    this.collider.setBlockerEnabled(this.def.doorBlocker, false);
    this.tag.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.root.removeFromParent();
  }
}
