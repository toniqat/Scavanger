import * as THREE from 'three';
import { Layers, type DeployableKind } from '@/shared';

/**
 * Pooled procedural meshes for every deployable kind, plus a small ring-pulse FX pool.
 *
 * Rules honoured here (see CLAUDE.md):
 *  - no external assets: everything is Three.js geometry built in code;
 *  - **no lights ever** — glow is emissive / additive material only, so the scene light count never changes;
 *  - geometry is shared per kind, materials are per visual (they pulse independently) and are recoloured on reuse,
 *    so steady-state usage allocates nothing.
 */
export interface GadgetVisual {
  kind: DeployableKind;
  root: THREE.Group;
  /** Animated sub-group (bob / spin / unfold). */
  body: THREE.Group;
  /** Turret head (yaws toward the target), else null. */
  head: THREE.Object3D | null;
  /** Turret muzzle flash mesh (emissive pulse), else null. */
  muzzle: THREE.Mesh | null;
  /** Ground radius ring. */
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  /** Dome shell / smoke puffs / flame material (transparent), else null. */
  shellMat: THREE.MeshBasicMaterial | null;
  /** Materials that breathe with the pulse (LEDs, stripes). */
  glowMats: THREE.MeshBasicMaterial[];
  /** Loose parts animated per kind (smoke puffs, flames). */
  parts: THREE.Object3D[];
  phase: number;
  /** Set by the system every frame; drives the animation. */
  radius: number;
}

interface Pulse {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  life: number;
  from: number;
  to: number;
  active: boolean;
}

const _c = new THREE.Color();

function parseCss(css: string, out: THREE.Color): THREE.Color {
  try { out.setStyle(css); } catch { out.setHex(0xffffff); }
  return out;
}

const PULSE_COUNT = 12;

export class GadgetVisualPool {
  readonly group = new THREE.Group();
  private readonly free = new Map<DeployableKind, GadgetVisual[]>();
  private readonly all: GadgetVisual[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly pulses: Pulse[] = [];

  /* shared geometry */
  private readonly ringGeo = new THREE.RingGeometry(0.9, 1, 40);
  private readonly domeGeo = new THREE.SphereGeometry(1, 26, 13, 0, Math.PI * 2, 0, Math.PI / 2);
  private readonly domeRibGeo = new THREE.TorusGeometry(1, 0.02, 6, 40);
  private readonly wallGeo = new THREE.BoxGeometry(4.2, 1.9, 0.34);
  private readonly wallLegGeo = new THREE.BoxGeometry(0.26, 0.3, 1.1);
  private readonly wallStripeGeo = new THREE.BoxGeometry(4.24, 0.16, 0.36);
  private readonly mineBodyGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.11, 14);
  private readonly mineDomeGeo = new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  private readonly mineSpikeGeo = new THREE.CylinderGeometry(0.012, 0.02, 0.2, 6);
  private readonly ledGeo = new THREE.SphereGeometry(0.035, 8, 6);
  private readonly turretBaseGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.16, 14);
  private readonly turretLegGeo = new THREE.BoxGeometry(0.11, 0.09, 0.66);
  private readonly turretMastGeo = new THREE.CylinderGeometry(0.11, 0.14, 0.52, 10);
  private readonly turretHeadGeo = new THREE.BoxGeometry(0.42, 0.3, 0.5);
  private readonly turretBarrelGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.7, 8);
  private readonly turretEyeGeo = new THREE.SphereGeometry(0.07, 10, 8);
  private readonly padGeo = new THREE.CylinderGeometry(1.5, 1.6, 0.13, 24);
  private readonly padInnerGeo = new THREE.CylinderGeometry(1.15, 1.15, 0.05, 24);
  private readonly chevronGeo = new THREE.BoxGeometry(0.7, 0.05, 0.2);
  private readonly puffGeo = new THREE.SphereGeometry(1, 9, 7);
  private readonly flameGeo = new THREE.ConeGeometry(0.42, 1.3, 7, 1, true);
  private readonly lurePoleGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.7, 8);
  private readonly lureHornGeo = new THREE.ConeGeometry(0.24, 0.34, 10, 1, true);
  private readonly lureRingGeo = new THREE.TorusGeometry(0.42, 0.025, 6, 22);
  private readonly pulseGeo = new THREE.RingGeometry(0.86, 1, 36);

  /* shared opaque materials (never pulse) */
  private readonly steelMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.75, roughness: 0.45 });
  private readonly darkMat = new THREE.MeshStandardMaterial({ color: 0x23272c, metalness: 0.5, roughness: 0.7 });

  constructor() {
    this.group.name = 'Gadgets';
    this.ringGeo.rotateX(-Math.PI / 2);
    this.pulseGeo.rotateX(-Math.PI / 2);
    this.domeRibGeo.rotateX(Math.PI / 2);
    this.lureRingGeo.rotateX(Math.PI / 2);
    this.geos.push(
      this.ringGeo, this.domeGeo, this.domeRibGeo, this.wallGeo, this.wallLegGeo, this.wallStripeGeo,
      this.mineBodyGeo, this.mineDomeGeo, this.mineSpikeGeo, this.ledGeo,
      this.turretBaseGeo, this.turretLegGeo, this.turretMastGeo, this.turretHeadGeo, this.turretBarrelGeo, this.turretEyeGeo,
      this.padGeo, this.padInnerGeo, this.chevronGeo, this.puffGeo, this.flameGeo,
      this.lurePoleGeo, this.lureHornGeo, this.lureRingGeo, this.pulseGeo,
    );
    for (let i = 0; i < PULSE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(this.pulseGeo, mat);
      mesh.visible = false; mesh.renderOrder = 24; mesh.frustumCulled = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      this.group.add(mesh);
      this.pulses.push({ mesh, mat, t: 0, life: 1, from: 0.5, to: 4, active: false });
    }
  }

  /* ───────────────────────── pool ───────────────────────── */
  acquire(kind: DeployableKind, colorCss: string, radius: number): GadgetVisual {
    const list = this.free.get(kind);
    const v = list && list.length > 0 ? list.pop()! : this.create(kind);
    v.radius = radius;
    this.tint(v, colorCss);
    v.root.visible = true;
    v.root.scale.setScalar(1);
    v.body.rotation.set(0, 0, 0);
    v.body.scale.setScalar(1);
    v.phase = Math.random() * Math.PI * 2;
    this.layout(v, radius);
    return v;
  }

  release(v: GadgetVisual): void {
    v.root.visible = false;
    let list = this.free.get(v.kind);
    if (!list) { list = []; this.free.set(v.kind, list); }
    list.push(v);
  }

  /** Pre-build one visual of every kind so the first deployment allocates nothing. */
  warm(): void {
    const kinds: DeployableKind[] = ['domeShield', 'barricade', 'mine', 'turret', 'jumpPad', 'smoke', 'fire', 'lure'];
    for (const k of kinds) {
      if ((this.free.get(k)?.length ?? 0) > 0) continue;
      this.release(this.create(k));
    }
  }

  /* ───────────────────────── animation ───────────────────────── */
  /**
   * @param armed    false while a mine arms / a dome unfolds (drawn dimmer, faster blink)
   * @param hpRatio  0..1 (shield / barricade damage state)
   * @param lifeRatio 1 → fresh, 0 → about to expire (fades smoke / fire out)
   */
  animate(v: GadgetVisual, t: number, dt: number, armed: boolean, hpRatio: number, lifeRatio: number): void {
    const s = 0.5 + 0.5 * Math.sin(t * 3 + v.phase);
    switch (v.kind) {
      case 'domeShield': {
        const shell = v.shellMat;
        if (shell) shell.opacity = (0.1 + 0.12 * s) * (0.35 + 0.65 * hpRatio);
        for (const g of v.glowMats) g.opacity = (0.35 + 0.35 * s) * (0.3 + 0.7 * hpRatio);
        v.ringMat.opacity = 0.3 + 0.25 * s;
        // unfold: scale up over the first moments after spawn
        const grow = THREE.MathUtils.clamp(v.body.scale.x + dt * 2.6, 0.15, 1);
        v.body.scale.setScalar(armed ? 1 : grow);
        break;
      }
      case 'barricade': {
        for (const g of v.glowMats) g.opacity = 0.25 + 0.3 * hpRatio;
        v.ringMat.opacity = 0.12;
        break;
      }
      case 'mine': {
        const rate = armed ? 1.6 : 6;
        const blink = Math.sin(t * rate * Math.PI * 2 + v.phase) > 0.3 ? 1 : 0.05;
        for (const g of v.glowMats) g.opacity = blink;
        v.ringMat.opacity = armed ? 0.16 + 0.12 * s : 0.06;
        break;
      }
      case 'turret': {
        for (const g of v.glowMats) g.opacity = 0.4 + 0.4 * s;
        v.ringMat.opacity = 0.08 + 0.05 * s;
        if (v.muzzle) {
          const m = v.muzzle.material as THREE.MeshBasicMaterial;
          m.opacity = Math.max(0, m.opacity - dt * 9);
          v.muzzle.visible = m.opacity > 0.02;
        }
        break;
      }
      case 'jumpPad': {
        for (let i = 0; i < v.glowMats.length; i++) {
          const w = 0.5 + 0.5 * Math.sin(t * 5 - i * 1.1 + v.phase);
          v.glowMats[i].opacity = 0.2 + 0.7 * w;
        }
        v.ringMat.opacity = 0.25 + 0.2 * s;
        break;
      }
      case 'smoke': {
        const fade = THREE.MathUtils.clamp(lifeRatio * 3, 0, 1) * THREE.MathUtils.clamp((1 - lifeRatio) * 6, 0, 1);
        if (v.shellMat) v.shellMat.opacity = 0.16 + 0.2 * fade;
        v.ringMat.opacity = 0.06 * fade;
        for (let i = 0; i < v.parts.length; i++) {
          const p = v.parts[i];
          p.rotation.y += dt * (0.1 + (i % 3) * 0.05);
          p.position.y += dt * 0.12 * ((i % 4) - 1.2);
        }
        break;
      }
      case 'fire': {
        if (v.shellMat) v.shellMat.opacity = (0.45 + 0.35 * s) * THREE.MathUtils.clamp(lifeRatio * 4, 0, 1);
        v.ringMat.opacity = 0.3 + 0.25 * s;
        for (let i = 0; i < v.parts.length; i++) {
          const p = v.parts[i];
          const w = 0.6 + 0.4 * Math.sin(t * 7 + i * 1.7 + v.phase);
          p.scale.set(0.8 + 0.3 * w, w, 0.8 + 0.3 * w);
          p.rotation.y += dt * 1.4;
        }
        break;
      }
      case 'lure': {
        for (const g of v.glowMats) g.opacity = 0.3 + 0.6 * s;
        v.ringMat.opacity = 0.12 + 0.14 * s;
        v.body.rotation.y += dt * 1.2;
        for (let i = 0; i < v.parts.length; i++) {
          const p = v.parts[i];
          const k = ((t * 0.9 + i * 0.5) % 1);
          p.scale.setScalar(0.4 + k * 2.6);
          p.position.y = 0.25 + k * 0.5;
          const mat = (p as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - k) * 0.7;
        }
        break;
      }
    }
  }

  /** One-shot expanding ring (mine blast, cloak veil, defib zap, jump pad launch). */
  pulse(position: THREE.Vector3, colorCss: string, from: number, to: number, life = 0.5): void {
    const p = this.pulses.find((x) => !x.active) ?? this.pulses[0];
    p.active = true; p.t = 0; p.life = life; p.from = from; p.to = to;
    p.mesh.position.copy(position);
    p.mesh.position.y += 0.08;
    p.mesh.visible = true;
    parseCss(colorCss, _c);
    p.mat.color.copy(_c);
    p.mat.opacity = 0.8;
    p.mesh.scale.setScalar(from);
  }

  updatePulses(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.pulses) {
      if (!p.active) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) { p.active = false; p.mesh.visible = false; p.mat.opacity = 0; continue; }
      p.mesh.scale.setScalar(p.from + (p.to - p.from) * k);
      p.mat.opacity = 0.8 * (1 - k) * (1 - k);
    }
  }

  /** Turret muzzle flash (pooled material opacity, no light). */
  flash(v: GadgetVisual): void {
    if (!v.muzzle) return;
    (v.muzzle.material as THREE.MeshBasicMaterial).opacity = 1;
    v.muzzle.visible = true;
  }

  dispose(): void {
    for (const v of this.all) {
      v.ringMat.dispose();
      v.shellMat?.dispose();
      for (const m of v.glowMats) m.dispose();
      if (v.muzzle) (v.muzzle.material as THREE.Material).dispose();
    }
    for (const p of this.pulses) p.mat.dispose();
    for (const g of this.geos) g.dispose();
    this.steelMat.dispose(); this.darkMat.dispose();
    this.all.length = 0; this.free.clear(); this.pulses.length = 0;
    this.group.removeFromParent();
  }

  /* ───────────────────────── construction ───────────────────────── */
  private tint(v: GadgetVisual, colorCss: string): void {
    parseCss(colorCss, _c);
    v.ringMat.color.copy(_c);
    if (v.shellMat) v.shellMat.color.copy(_c);
    for (const m of v.glowMats) m.color.copy(_c);
  }

  /** Scale the parts whose size follows the gameplay radius. */
  private layout(v: GadgetVisual, radius: number): void {
    switch (v.kind) {
      case 'domeShield':
        v.body.scale.setScalar(0.15);
        v.root.scale.setScalar(1);
        v.body.children.forEach((c) => c.scale.setScalar(radius));
        v.ring.scale.setScalar(radius);
        break;
      case 'smoke':
        v.ring.scale.setScalar(radius);
        for (let i = 0; i < v.parts.length; i++) {
          const a = (i / v.parts.length) * Math.PI * 2 + Math.random() * 0.5;
          const r = radius * (0.15 + 0.62 * Math.random());
          v.parts[i].position.set(Math.cos(a) * r, radius * (0.22 + 0.5 * Math.random()), Math.sin(a) * r);
          v.parts[i].scale.setScalar(radius * (0.34 + 0.22 * Math.random()));
        }
        break;
      case 'fire':
        v.ring.scale.setScalar(radius);
        for (let i = 0; i < v.parts.length; i++) {
          const a = (i / v.parts.length) * Math.PI * 2;
          const r = radius * (0.15 + 0.75 * ((i * 37) % 11) / 11);
          v.parts[i].position.set(Math.cos(a) * r, 0.6, Math.sin(a) * r);
        }
        break;
      case 'mine':
      case 'turret':
      case 'lure':
        v.ring.scale.setScalar(Math.min(radius, 8));
        break;
      default:
        v.ring.scale.setScalar(radius);
        break;
    }
  }

  private glow(color = 0xffffff, opacity = 0.6, additive = true): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, toneMapped: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    });
  }

  private create(kind: DeployableKind): GadgetVisual {
    const root = new THREE.Group();
    const body = new THREE.Group();
    const ringMat = this.glow(0xffffff, 0.2);
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.y = 0.03; ring.renderOrder = 22; ring.frustumCulled = false;
    const glowMats: THREE.MeshBasicMaterial[] = [];
    const parts: THREE.Object3D[] = [];
    let shellMat: THREE.MeshBasicMaterial | null = null;
    let head: THREE.Object3D | null = null;
    let muzzle: THREE.Mesh | null = null;

    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = body): THREE.Mesh => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    switch (kind) {
      case 'domeShield': {
        shellMat = this.glow(0x6fe0ff, 0.18);
        const shell = new THREE.Mesh(this.domeGeo, shellMat);
        shell.renderOrder = 20; shell.frustumCulled = false;
        const ribMat = this.glow(0x6fe0ff, 0.5);
        glowMats.push(ribMat);
        const rib1 = new THREE.Mesh(this.domeRibGeo, ribMat);
        const rib2 = new THREE.Mesh(this.domeRibGeo, ribMat); rib2.position.y = 0.55; rib2.scale.setScalar(0.83);
        body.add(shell, rib1, rib2);
        break;
      }
      case 'barricade': {
        const wall = add(this.wallGeo, this.steelMat, 0, 0.95, 0); wall.castShadow = true;
        const legA = add(this.wallLegGeo, this.darkMat, -1.8, 0.15, 0.42); legA.rotation.x = 0.5;
        const legB = add(this.wallLegGeo, this.darkMat, 1.8, 0.15, 0.42); legB.rotation.x = 0.5;
        const stripeMat = this.glow(0xc9a227, 0.4, false);
        glowMats.push(stripeMat);
        add(this.wallStripeGeo, stripeMat, 0, 1.62, 0);
        add(this.wallStripeGeo, stripeMat, 0, 0.32, 0);
        void wall;
        break;
      }
      case 'mine': {
        add(this.mineBodyGeo, this.darkMat, 0, 0.055, 0).castShadow = true;
        add(this.mineDomeGeo, this.steelMat, 0, 0.11, 0);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const sp = add(this.mineSpikeGeo, this.steelMat, Math.cos(a) * 0.26, 0.14, Math.sin(a) * 0.26);
          sp.rotation.z = Math.cos(a) * 0.5; sp.rotation.x = -Math.sin(a) * 0.5;
        }
        const ledMat = this.glow(0xff5a3c, 1);
        glowMats.push(ledMat);
        add(this.ledGeo, ledMat, 0, 0.29, 0);
        break;
      }
      case 'turret': {
        add(this.turretBaseGeo, this.darkMat, 0, 0.08, 0).castShadow = true;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.5;
          const leg = add(this.turretLegGeo, this.steelMat, Math.cos(a) * 0.34, 0.06, Math.sin(a) * 0.34);
          leg.rotation.y = -a; leg.rotation.x = 0.45;
        }
        add(this.turretMastGeo, this.steelMat, 0, 0.4, 0);
        head = new THREE.Group();
        head.position.y = 0.72;
        body.add(head);
        add(this.turretHeadGeo, this.steelMat, 0, 0, 0, head).castShadow = true;
        const bl = add(this.turretBarrelGeo, this.darkMat, -0.11, 0.02, -0.42, head); bl.rotation.x = Math.PI / 2;
        const br = add(this.turretBarrelGeo, this.darkMat, 0.11, 0.02, -0.42, head); br.rotation.x = Math.PI / 2;
        const eyeMat = this.glow(0x7cf07a, 0.7);
        glowMats.push(eyeMat);
        add(this.turretEyeGeo, eyeMat, 0, 0.13, -0.2, head);
        const flashMat = this.glow(0xffe0a0, 0);
        muzzle = add(this.turretEyeGeo, flashMat, 0, 0.02, -0.78, head);
        muzzle.scale.setScalar(1.5);
        muzzle.visible = false;
        break;
      }
      case 'jumpPad': {
        add(this.padGeo, this.darkMat, 0, 0.065, 0).receiveShadow = true;
        const inner = this.glow(0x5fd7ff, 0.4);
        glowMats.push(inner);
        add(this.padInnerGeo, inner, 0, 0.12, 0);
        for (let i = 0; i < 3; i++) {
          const m = this.glow(0x5fd7ff, 0.5);
          glowMats.push(m);
          const c = add(this.chevronGeo, m, 0, 0.16, -0.45 + i * 0.45);
          c.rotation.y = 0;
          const c2 = new THREE.Mesh(this.chevronGeo, m);
          c2.position.set(0, 0.16, -0.45 + i * 0.45);
          c2.rotation.y = Math.PI / 2;
          body.add(c2);
          void c;
        }
        break;
      }
      case 'smoke': {
        shellMat = this.glow(0xb9c3cc, 0.3, false);
        for (let i = 0; i < 14; i++) {
          const puff = new THREE.Mesh(this.puffGeo, shellMat);
          puff.renderOrder = 18; puff.frustumCulled = false;
          body.add(puff);
          parts.push(puff);
        }
        break;
      }
      case 'fire': {
        shellMat = this.glow(0xff7a1a, 0.7);
        for (let i = 0; i < 12; i++) {
          const fl = new THREE.Mesh(this.flameGeo, shellMat);
          fl.renderOrder = 19; fl.frustumCulled = false;
          body.add(fl);
          parts.push(fl);
        }
        break;
      }
      case 'lure': {
        add(this.lurePoleGeo, this.darkMat, 0, 0.35, 0);
        const hornMat = this.glow(0xffd166, 0.5);
        glowMats.push(hornMat);
        const horn = add(this.lureHornGeo, hornMat, 0, 0.78, 0);
        horn.rotation.x = Math.PI;
        for (let i = 0; i < 3; i++) {
          const m = this.glow(0xffd166, 0.5);
          glowMats.push(m);   // also keeps them in the dispose list; the `parts` loop drives their opacity
          const r = new THREE.Mesh(this.lureRingGeo, m);
          r.renderOrder = 20; r.frustumCulled = false;
          body.add(r);
          parts.push(r);
        }
        break;
      }
    }

    root.add(body, ring);
    root.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
    root.visible = false;
    this.group.add(root);
    const v: GadgetVisual = { kind, root, body, head, muzzle, ring, ringMat, shellMat, glowMats, parts, phase: 0, radius: 1 };
    this.all.push(v);
    return v;
  }
}
