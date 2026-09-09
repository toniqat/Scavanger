import * as THREE from 'three';

export type ConsoleState = 'idle' | 'active' | 'off';

/** Yellow/black hazard stripe texture generated on a canvas (no asset files). */
function hazardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e6b31e';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#14120f';
  for (let i = -128; i < 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 + 128, 128); g.lineTo(i + 128, 128);
    g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sharedHazard: THREE.CanvasTexture | null = null;

/**
 * Extraction switch console: pedestal + slanted panel + big hazard-striped lever + status lamp
 * + holographic beacon light shaft.
 *
 * **2026-09-09 — the idle beacon is gone.** The 40 m shaft used to advertise every 신호소 from anywhere on the map,
 * which is exactly what the 전장의 안개 is there to take away: you now have to walk into a pad's reveal radius to
 * find it. The shaft comes **back on** in `active` (amber blink) — by then the whole squad knows where the console
 * is and the 120 s countdown wants a landmark to run toward. The pedestal light / screen / lamp stay lit in every
 * state so the console still reads from close up (which is what makes it 발견 in the first place).
 */
export class ExtractionConsole {
  readonly group = new THREE.Group();
  readonly interactPoint = new THREE.Vector3();
  private lampMat: THREE.MeshStandardMaterial;
  private beaconMat: THREE.MeshBasicMaterial;
  private screenMat: THREE.MeshStandardMaterial;
  private lever: THREE.Group;
  private beacon: THREE.Mesh;
  private light: THREE.PointLight;
  private state: ConsoleState = 'idle';
  private time = 0;
  private leverTarget = -0.5;
  private disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor(position: THREE.Vector3, yaw: number) {
    this.group.position.copy(position);
    this.group.rotation.y = yaw;
    if (!sharedHazard) sharedHazard = hazardTexture();

    const metal = this.mat(new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.55, metalness: 0.7 }));
    const darkMetal = this.mat(new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.7, metalness: 0.6 }));
    const hazard = this.mat(new THREE.MeshStandardMaterial({ map: sharedHazard, roughness: 0.6, metalness: 0.2 }));

    // Base plate + pedestal
    const base = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.9, 1.0, 0.12, 24)), darkMetal);
    base.position.y = 0.06;
    const pedestal = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.7, 0.95, 0.5)), metal);
    pedestal.position.y = 0.6;
    const stripe = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.72, 0.16, 0.52)), hazard);
    stripe.position.y = 0.3;

    // Slanted panel (front faces local +Z)
    const panel = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.9, 0.5, 0.08)), metal);
    panel.position.set(0, 1.2, 0.18);
    panel.rotation.x = -0.55;
    this.screenMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x0a0e12, emissive: 0x2a6fa8, emissiveIntensity: 0.9, roughness: 0.3 }));
    const screen = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(0.62, 0.2)), this.screenMat);
    screen.position.set(0, 1.31, 0.245);
    screen.rotation.x = -0.55;

    // Big lever on the panel (pivot at panel surface)
    this.lever = new THREE.Group();
    this.lever.position.set(0, 1.08, 0.26);
    this.lever.rotation.x = this.leverTarget;
    const arm = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.03, 0.035, 0.34, 10)), darkMetal);
    arm.position.y = 0.17;
    const knob = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.22, 0.12, 0.12)), hazard);
    knob.position.y = 0.36;
    const hinge = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.06, 0.06, 0.26, 12)), metal);
    hinge.rotation.z = Math.PI / 2;
    this.lever.add(arm, knob, hinge);

    // Status lamp + mast
    const mast = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8)), darkMetal);
    mast.position.set(-0.3, 1.5, -0.1);
    this.lampMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x6fb8ff, emissiveIntensity: 1.6, roughness: 0.3 }));
    const lamp = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.09, 12, 10)), this.lampMat);
    lamp.position.set(-0.3, 1.9, -0.1);

    // Holographic beacon shaft (tall, additive, fades toward top)
    this.beaconMat = this.mat(new THREE.MeshBasicMaterial({
      color: 0x6fb8ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.beacon = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.35, 0.9, 40, 16, 1, true)), this.beaconMat);
    this.beacon.position.set(0, 20.5, 0);
    this.beacon.renderOrder = 4;
    this.beacon.visible = false;      // idle: no 빛기둥 (2026-09-09) — `setState('active')` turns it on

    this.light = new THREE.PointLight(0x6fb8ff, 6, 10, 1.8);
    this.light.position.set(0, 1.9, 0.2);

    this.group.add(base, pedestal, stripe, panel, screen, this.lever, mast, lamp, this.beacon, this.light);
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.beacon.castShadow = false;
    this.interactPoint.copy(position).add(new THREE.Vector3(0, 1, 0));
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T { this.disposables.push(g); return g; }
  private mat<T extends THREE.Material>(m: T): T { this.disposables.push(m); return m; }

  setState(s: ConsoleState): void {
    this.state = s;
    if (s === 'active') {
      this.leverTarget = 0.55;
      this.lampMat.color.set(0xffc46b); this.lampMat.emissive.set(0xffb347);
      this.beaconMat.color.set(0xffb347);
      this.screenMat.emissive.set(0xff8a2a);
      this.light.color.set(0xffb347);
      this.beacon.visible = true;     // 탈출 활성화 = 분대 전원이 향할 랜드마크
    } else if (s === 'idle') {
      this.leverTarget = -0.5;
      this.lampMat.color.set(0x9fd8ff); this.lampMat.emissive.set(0x6fb8ff);
      this.beaconMat.color.set(0x6fb8ff);
      this.screenMat.emissive.set(0x2a6fa8);
      this.light.color.set(0x6fb8ff);
      this.beacon.visible = false;    // 평상시에는 빛기둥 없음
    } else {
      this.leverTarget = 0.55;
      this.lampMat.emissive.set(0x222222);
      this.beacon.visible = false;
      this.light.intensity = 0;
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.lever.rotation.x += (this.leverTarget - this.lever.rotation.x) * Math.min(1, dt * 10);
    if (this.state === 'idle') {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 1.6);
      this.lampMat.emissiveIntensity = 1.2 + pulse * 0.8;
      this.beaconMat.opacity = 0.12 + pulse * 0.08;
      this.light.intensity = 4 + pulse * 3;
      this.beacon.rotation.y += dt * 0.3;
    } else if (this.state === 'active') {
      const blink = Math.sin(this.time * 9) > 0 ? 1 : 0.15;
      this.lampMat.emissiveIntensity = 0.6 + blink * 2.2;
      this.beaconMat.opacity = 0.16 + blink * 0.14;
      this.light.intensity = 3 + blink * 9;
      this.beacon.rotation.y += dt * 1.2;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
