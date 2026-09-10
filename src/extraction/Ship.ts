import * as THREE from 'three';

export type ShipState = 'hidden' | 'approach' | 'descend' | 'landed' | 'liftoff';

/** Bay floor rectangle in ship-local space (player walks in from local +Z through the ramp). */
export const BAY_HALF_W = 1.5;
export const BAY_Z_MIN = -5.2;
export const BAY_Z_MAX = 0.2;
export const BAY_HEIGHT = 2.6;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Interior lamp intensity while the bay is lit (0 = ship hidden; see the light note on `body`). */
const INTERIOR_LIGHT = 8;

/**
 * Procedural "Pelican"-style dropship (~14 m). Local -Z is the nose; the rear ramp opens toward +Z.
 * The bay floor sits at local y = 0 so that, once landed, the player walks straight in from the ground.
 */
export class Dropship {
  readonly root = new THREE.Group();
  /**
   * Every mesh of the ship. **The visibility toggle lives here, not on `root`** (2026-09-10): three.js skips
   * invisible subtrees in `projectObject`, so lights parked under a hidden root are not counted — and the frame
   * the ship appears `numPointLights` jumps by 3 and **every material in the scene recompiles its shader**.
   * That was the freeze when the dropship arrived. `root` therefore stays visible forever and carries the three
   * point lights (intensity 0 while hidden) — the rule `core/fx/FlashPool` already states.
   */
  readonly body = new THREE.Group();
  readonly interiorSwitchWorld = new THREE.Vector3();
  state: ShipState = 'hidden';

  private ramp: THREE.Group;
  private rampAngle = Math.PI / 2;     // 0 = open flat, PI/2 = closed
  private rampTarget = Math.PI / 2;
  private thrustMats: THREE.MeshBasicMaterial[] = [];
  private thrustCones: THREE.Mesh[] = [];
  private engineLights: THREE.PointLight[] = [];
  private landingLights: THREE.Mesh[] = [];
  private landingLightMat: THREE.MeshStandardMaterial;
  private interiorLight: THREE.PointLight;
  private interiorLampMat: THREE.MeshStandardMaterial;
  private switchMat: THREE.MeshStandardMaterial;
  private gear: THREE.Group;
  /** Bay lining — only ever seen from inside, so it is kept out of the sun's shadow pass. */
  private interiorParts: THREE.Mesh[] = [];
  private disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  // Flight
  private start = new THREE.Vector3();
  private hover = new THREE.Vector3();
  private landPos = new THREE.Vector3();
  private landYaw = 0;
  private t = 0;
  private duration = 1;
  private time = 0;
  thrust = 0;               // 0..1 visual engine intensity
  private bank = 0;
  private liftoffOrigin = new THREE.Vector3();
  private liftoffDir = new THREE.Vector3();

  constructor() {
    const hull = this.mat(new THREE.MeshStandardMaterial({ color: 0x5c6168, roughness: 0.6, metalness: 0.55 }));
    const hullDark = this.mat(new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.7, metalness: 0.5 }));
    const accent = this.mat(new THREE.MeshStandardMaterial({ color: 0xc9a03a, roughness: 0.6, metalness: 0.3 }));
    const glass = this.mat(new THREE.MeshStandardMaterial({ color: 0x0f1a24, roughness: 0.1, metalness: 0.9, emissive: 0x1a3550, emissiveIntensity: 0.6 }));
    const interior = this.mat(new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.85, metalness: 0.3, side: THREE.DoubleSide }));
    const floorMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9, metalness: 0.2 }));

    const r = this.body;   // meshes only — the lights go straight on `root` (see the `body` note)
    // ── Bay (interior) ── floor at y 0, walls x ±1.6, z from -5.2 .. 0.2, ceiling 2.6
    const floor = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.2, 0.12, 5.4)), floorMat);
    floor.position.set(0, -0.06, -2.5);
    const wallL = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.12, BAY_HEIGHT, 5.4)), interior);
    wallL.position.set(-1.66, BAY_HEIGHT / 2, -2.5);
    const wallR = wallL.clone(); wallR.position.x = 1.66;
    const ceiling = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.4, 0.12, 5.4)), interior);
    ceiling.position.set(0, BAY_HEIGHT + 0.06, -2.5);
    const frontWall = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.4, BAY_HEIGHT + 0.2, 0.12)), interior);
    frontWall.position.set(0, BAY_HEIGHT / 2, -5.26);
    // Wall panels / ribs
    for (let i = 0; i < 5; i++) {
      const z = -4.6 + i * 1.05;
      const ribL = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.08, BAY_HEIGHT - 0.2, 0.16)), hullDark);
      ribL.position.set(-1.56, BAY_HEIGHT / 2, z);
      const ribR = ribL.clone(); ribR.position.x = 1.56;
      this.interiorParts.push(ribL, ribR);
      r.add(ribL, ribR);
    }
    // Seats (benches) along the walls
    for (const sx of [-1, 1]) {
      const bench = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.4, 0.1, 4.2)), hullDark);
      bench.position.set(sx * 1.35, 0.5, -2.7);
      const back = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.08, 0.6, 4.2)), hullDark);
      back.position.set(sx * 1.55, 0.85, -2.7);
      this.interiorParts.push(bench, back);
      r.add(bench, back);
    }
    // Ceiling light strip
    this.interiorLampMat = this.mat(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 2.2 }));
    const lamp = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.3, 0.04, 4.6)), this.interiorLampMat);
    lamp.position.set(0, BAY_HEIGHT - 0.03, -2.6);
    this.interiorLight = new THREE.PointLight(0xfff2dc, 8, 9, 1.6);
    this.interiorLight.position.set(0, BAY_HEIGHT - 0.4, -2.6);
    // Red interior switch console on the far (front) wall
    const swBox = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.6, 0.5, 0.18)), hullDark);
    swBox.position.set(0, 1.25, -5.1);
    this.switchMat = this.mat(new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2a2a, emissiveIntensity: 1.4, roughness: 0.4 }));
    const swBtn = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.11, 0.12, 0.08, 16)), this.switchMat);
    swBtn.rotation.x = Math.PI / 2;
    swBtn.position.set(0, 1.3, -5.0);
    const swGuard = new THREE.Mesh(this.geo(new THREE.TorusGeometry(0.17, 0.02, 8, 20)), accent);
    swGuard.position.set(0, 1.3, -5.0);
    const swLabel = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(0.5, 0.08)), this.mat(new THREE.MeshStandardMaterial({ color: 0xe6b31e, emissive: 0xe6b31e, emissiveIntensity: 0.5 })));
    swLabel.position.set(0, 1.0, -5.005);
    r.add(floor, wallL, wallR, ceiling, frontWall, lamp, swBox, swBtn, swGuard, swLabel);
    this.interiorLight.intensity = 0;          // lit by `showBody()`; the light itself never leaves the scene
    this.root.add(this.interiorLight);
    this.interiorParts.push(wallL, wallR, ceiling, frontWall, lamp, swBox, swBtn, swGuard, swLabel);

    // ── Outer hull ──
    // 2026-09-10: this used to be **one solid box** (4.2 × 3.3 × 7.2 at y 1.35, z −3.0), so its rear face sat
    // right behind the bay opening — the ramp came down and revealed a grey wall instead of the lit interior.
    // It is a shell now: four slabs around the bay (left / right / roof / belly) plus a front cap, leaving a real
    // hole at the rear. The only thing that closes that hole is the ramp itself (upright at z = 0.25 when closed,
    // 3.2 wide × 3.0 tall — it covers the whole opening), which is exactly what a rear door should do.
    // Hull outline x ±2.1, y −0.3..3.0, z −6.6..0.6; the opening is x ±1.6, y 0..2.6 (the bay lining sits inside it).
    const sideW = 2.1 - 1.6;
    const sideGeo = this.geo(new THREE.BoxGeometry(sideW, 3.3, 7.2));
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(sideGeo, hull);
      side.position.set(sx * (2.1 - sideW / 2), 1.35, -3.0);
      r.add(side);
    }
    const hullRoof = new THREE.Mesh(this.geo(new THREE.BoxGeometry(4.2, 0.4, 7.2)), hull);
    hullRoof.position.set(0, 2.8, -3.0);
    const hullBelly = new THREE.Mesh(this.geo(new THREE.BoxGeometry(4.2, 0.3, 7.2)), hull);
    hullBelly.position.set(0, -0.15, -3.0);
    // Front cap: the forward section (between the bay's front wall and the nose) has to stay closed now that the
    // shell is open-ended — the 4-sided nose cone leaves corner gaps you would otherwise see straight through.
    const hullFront = new THREE.Mesh(this.geo(new THREE.BoxGeometry(4.2, 3.3, 0.2)), hullDark);
    hullFront.position.set(0, 1.35, -6.5);
    r.add(hullRoof, hullBelly, hullFront);
    const hullTop = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.0, 0.6, 6.4)), hullDark);
    hullTop.position.set(0, 3.25, -3.2);
    const spine = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.8, 0.5, 9.4)), accent);
    spine.position.set(0, 3.6, -3.6);
    // Nose / cockpit (wedge via cylinder segment)
    const nose = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(1.5, 2.05, 3.2, 4, 1)), hull);
    nose.rotation.x = Math.PI / 2; nose.rotation.y = Math.PI / 4;
    nose.position.set(0, 1.45, -8.1);
    const cockpit = new THREE.Mesh(this.geo(new THREE.BoxGeometry(2.1, 0.9, 1.6)), glass);
    cockpit.position.set(0, 2.55, -7.2);
    cockpit.rotation.x = 0.25;
    const chin = new THREE.Mesh(this.geo(new THREE.BoxGeometry(2.6, 0.7, 2.4)), hullDark);
    chin.position.set(0, 0.35, -7.4);
    // Tail fins
    const finGeo = this.geo(new THREE.BoxGeometry(0.1, 1.6, 1.8));
    for (const sx of [-1, 1]) {
      const fin = new THREE.Mesh(finGeo, hull);
      fin.position.set(sx * 1.4, 4.1, 0.2);
      fin.rotation.z = -sx * 0.45;
      r.add(fin);
    }
    const tailPlane = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.4, 0.12, 1.4)), hull);
    tailPlane.position.set(0, 3.9, 0.3);
    r.add(hullTop, spine, nose, cockpit, chin, tailPlane);

    // ── Wings + nacelles + thrust cones ──
    const thrustGeo = this.geo(new THREE.ConeGeometry(0.85, 2.2, 18, 1, true));
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(this.geo(new THREE.BoxGeometry(2.6, 0.22, 2.6)), hull);
      wing.position.set(sx * 3.0, 2.3, -3.2);
      const nacelle = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.95, 1.05, 3.6, 18)), hullDark);
      nacelle.position.set(sx * 4.2, 1.9, -3.2);
      const ring = new THREE.Mesh(this.geo(new THREE.TorusGeometry(1.0, 0.1, 10, 24)), accent);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(sx * 4.2, 0.15, -3.2);
      const tm = this.mat(new THREE.MeshBasicMaterial({ color: 0x66c4ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      this.thrustMats.push(tm);
      const cone = new THREE.Mesh(thrustGeo, tm);
      cone.rotation.x = Math.PI;
      cone.position.set(sx * 4.2, -0.9, -3.2);
      this.thrustCones.push(cone);
      const el = new THREE.PointLight(0x66c4ff, 0, 18, 1.5);
      el.position.set(sx * 4.2, -0.4, -3.2);
      this.engineLights.push(el);
      this.root.add(el);   // stays in the scene with the other lights (see the `body` note)
      r.add(wing, nacelle, ring, cone);
    }

    // ── Landing gear (3 legs, retract by scale) ──
    this.gear = new THREE.Group();
    const legGeo = this.geo(new THREE.CylinderGeometry(0.1, 0.12, 1.1, 8));
    const padGeo = this.geo(new THREE.CylinderGeometry(0.35, 0.4, 0.12, 12));
    for (const [x, z] of [[-1.8, -1.0], [1.8, -1.0], [0, -7.0]]) {
      const leg = new THREE.Mesh(legGeo, hullDark);
      leg.position.set(x, -0.45, z);
      const pad = new THREE.Mesh(padGeo, hullDark);
      pad.position.set(x, -1.0, z);
      this.gear.add(leg, pad);
    }
    r.add(this.gear);

    // ── Landing lights (amber strips at rear edges) ──
    this.landingLightMat = this.mat(new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xffb347, emissiveIntensity: 0 }));
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.15, 0.15, 0.6)), this.landingLightMat);
      l.position.set(sx * 2.0, 0.4, 0.1);
      this.landingLights.push(l);
      r.add(l);
    }

    // ── Rear ramp (hinged at bay floor rear edge, local z = 0.2) ──
    this.ramp = new THREE.Group();
    this.ramp.position.set(0, 0.0, 0.25);
    const rampPlate = new THREE.Mesh(this.geo(new THREE.BoxGeometry(3.2, 0.14, 3.0)), floorMat);
    rampPlate.position.set(0, 0, 1.5);
    const rampEdgeL = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.12, 0.2, 3.0)), accent);
    rampEdgeL.position.set(-1.6, 0.05, 1.5);
    const rampEdgeR = rampEdgeL.clone(); rampEdgeR.position.x = 1.6;
    this.ramp.add(rampPlate, rampEdgeL, rampEdgeR);
    this.ramp.rotation.x = -this.rampAngle;  // closed = rotated up
    r.add(this.ramp);

    r.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    for (const c of this.thrustCones) c.castShadow = false;
    // The bay lining is invisible from outside; keeping it out of the shadow pass halves the ship's caster count.
    for (const m of this.interiorParts) m.castShadow = false;
    r.visible = false;
    this.root.add(r);
  }

  /** Reveal the hull and light the bay. The lights never leave the scene — only their intensity moves. */
  private showBody(): void {
    this.body.visible = true;
    this.interiorLampMat.emissive.set(0xfff2dc); this.interiorLampMat.emissiveIntensity = 2.2;
    this.interiorLight.color.set(0xfff2dc); this.interiorLight.intensity = INTERIOR_LIGHT;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T { this.disposables.push(g); return g; }
  private mat<T extends THREE.Material>(m: T): T { this.disposables.push(m); return m; }

  /** Begin the flight-in. `landPos` is where the ship root will sit; `yaw` orients the ramp toward +dir(yaw). */
  startApproach(landPos: THREE.Vector3, yaw: number, approachDuration: number): void {
    this.landPos.copy(landPos);
    this.landYaw = yaw;
    // dir(yaw) = local +Z (rear) direction in world.
    const dir = _v1.set(Math.sin(yaw), 0, Math.cos(yaw));
    // Fly in from the rear side (over the console/player) toward −dir, so the ramp faces the console.
    this.start.copy(landPos).addScaledVector(dir, 300).add(_v2.set(0, 130, 0));
    this.hover.copy(landPos).add(_v2.set(0, 24, 0));
    this.root.position.copy(this.start);
    this.root.rotation.set(0, yaw, 0);
    this.showBody();
    this.state = 'approach';
    this.t = 0;
    this.duration = Math.max(2, approachDuration);
    this.rampTarget = Math.PI / 2;
    this.gear.scale.y = 0.05;
    this.gear.visible = true;
    this.thrust = 1;
  }

  /** Returns true on the frame the ship touches down. */
  update(dt: number): { touchdown: boolean; rampOpened: boolean; rampClosed: boolean } {
    const ev = { touchdown: false, rampOpened: false, rampClosed: false };
    if (this.state === 'hidden') return ev;
    this.time += dt;

    switch (this.state) {
      case 'approach': {
        this.t = Math.min(1, this.t + dt / this.duration);
        const e = 1 - Math.pow(1 - this.t, 3); // ease-out: decelerate into hover
        // Curved path: lerp start→hover with an upward bow and lateral swing.
        _v1.lerpVectors(this.start, this.hover, e);
        _v1.y += Math.sin(e * Math.PI) * 30;
        const sway = Math.sin(e * Math.PI) * 18;
        _v2.set(Math.cos(this.landYaw), 0, -Math.sin(this.landYaw)); // right vector
        _v1.addScaledVector(_v2, sway);
        this.root.position.copy(_v1);
        // Nose-down pitch while diving, level out; bank into the swing.
        const pitch = (1 - e) * 0.45;
        this.bank += ((Math.cos(e * Math.PI) * 0.35) - this.bank) * Math.min(1, dt * 3);
        this.root.rotation.set(pitch, this.landYaw, this.bank);
        this.thrust = 1;
        if (this.t >= 1) { this.state = 'descend'; this.t = 0; this.duration = 4.2; }
        break;
      }
      case 'descend': {
        this.t = Math.min(1, this.t + dt / this.duration);
        const e = this.t < 0.5 ? 2 * this.t * this.t : 1 - Math.pow(-2 * this.t + 2, 2) / 2; // ease-in-out
        this.root.position.lerpVectors(this.hover, this.landPos, e);
        this.root.position.y += (1 - e) * Math.sin(this.time * 2.1) * 0.35; // hover wobble
        this.bank += (0 - this.bank) * Math.min(1, dt * 4);
        this.root.rotation.set(0.04 * (1 - e), this.landYaw, this.bank + Math.sin(this.time * 1.7) * 0.02 * (1 - e));
        this.gear.scale.y = Math.min(1, 0.05 + e * 1.4);
        this.thrust = 1 - e * 0.35;
        if (this.t >= 1) {
          this.state = 'landed';
          this.root.position.copy(this.landPos);
          this.root.rotation.set(0, this.landYaw, 0);
          this.rampTarget = 0;
          this.landingLightMat.emissiveIntensity = 3;
          this.gear.scale.y = 1;
          ev.touchdown = true;
        }
        break;
      }
      case 'landed': {
        this.thrust += (0.18 - this.thrust) * Math.min(1, dt * 2);
        this.root.position.y = this.landPos.y + Math.sin(this.time * 1.3) * 0.01;
        break;
      }
      case 'liftoff': {
        this.t += dt;
        const tt = this.t;
        if (tt < 1.6) {
          // Ramp closing; engines spooling up.
          this.thrust += (0.6 - this.thrust) * Math.min(1, dt * 2);
          this.root.position.copy(this.liftoffOrigin);
          this.root.position.y += Math.sin(this.time * 30) * 0.01 * tt;
        } else {
          const a = tt - 1.6;
          this.thrust = 1;
          const rise = 6 * a * a + 2 * a;            // accelerating climb
          const fwd = Math.max(0, a - 0.8);
          const fwdDist = 12 * fwd * fwd;
          this.root.position.copy(this.liftoffOrigin);
          this.root.position.y += rise;
          this.root.position.addScaledVector(this.liftoffDir, fwdDist);
          const pitch = -Math.min(0.35, fwd * 0.25);
          this.root.rotation.set(pitch, this.landYaw, Math.sin(a * 1.3) * 0.05);
          this.gear.scale.y = Math.max(0.05, 1 - a * 0.8);
          this.landingLightMat.emissiveIntensity = Math.max(0, 3 - a * 2);
        }
        break;
      }
    }

    // Ramp animation
    const prev = this.rampAngle;
    const speed = (Math.PI / 2) / 1.5;
    if (this.rampAngle < this.rampTarget) this.rampAngle = Math.min(this.rampTarget, this.rampAngle + speed * dt);
    else if (this.rampAngle > this.rampTarget) this.rampAngle = Math.max(this.rampTarget, this.rampAngle - speed * dt);
    if (prev !== this.rampAngle) {
      this.ramp.rotation.x = -this.rampAngle;
      if (this.rampAngle === 0) ev.rampOpened = true;
      if (this.rampAngle === Math.PI / 2) ev.rampClosed = true;
    }

    // Engine visuals: flicker + scale with thrust
    const flick = 0.85 + 0.15 * Math.sin(this.time * 41) * Math.sin(this.time * 17.3);
    const th = this.thrust * flick;
    for (let i = 0; i < this.thrustMats.length; i++) {
      this.thrustMats[i].opacity = 0.15 + th * 0.7;
      this.thrustCones[i].scale.set(0.6 + th * 0.5, 0.5 + th * 1.1, 0.6 + th * 0.5);
      this.engineLights[i].intensity = th * 40;
    }
    // Interior lamp: steady when landed, flicker during liftoff
    if (this.state === 'liftoff') {
      const f = Math.sin(this.time * 25) > 0.4 ? 1 : 0.45;
      this.interiorLampMat.emissiveIntensity = 1.2 * f;
      this.interiorLampMat.emissive.set(0xff8866);
      this.interiorLight.intensity = 5 * f;
      this.interiorLight.color.set(0xff8866);
    }
    // Switch pulse
    this.switchMat.emissiveIntensity = this.state === 'landed' ? 1.0 + 0.8 * Math.max(0, Math.sin(this.time * 4)) : 0.6;

    this.root.updateMatrixWorld(true);
    this.interiorSwitchWorld.set(0, 1.0, -4.6).applyMatrix4(this.root.matrixWorld);
    return ev;
  }

  /**
   * Snap straight to the landed state (multiplayer client fallback when the host reports touchdown but the
   * local flight-in never happened / has not finished). Returns false if the ship is already landed or lifting.
   * The ramp still opens over its normal 1.5 s.
   */
  forceLand(landPos: THREE.Vector3, yaw: number): boolean {
    if (this.state === 'landed' || this.state === 'liftoff') return false;
    this.landPos.copy(landPos);
    this.landYaw = yaw;
    this.hover.copy(landPos).add(_v2.set(0, 24, 0));
    this.root.position.copy(landPos);
    this.root.rotation.set(0, yaw, 0);
    this.showBody();
    this.state = 'landed';
    this.t = 0;
    this.bank = 0;
    this.rampTarget = 0;
    this.landingLightMat.emissiveIntensity = 3;
    this.gear.scale.y = 1;
    this.gear.visible = true;
    this.thrust = 0.65;
    this.root.updateMatrixWorld(true);
    this.interiorSwitchWorld.set(0, 1.0, -4.6).applyMatrix4(this.root.matrixWorld);
    return true;
  }

  beginLiftoff(): void {
    if (this.state !== 'landed') return;
    this.state = 'liftoff';
    this.t = 0;
    this.rampTarget = Math.PI / 2;
    this.liftoffOrigin.copy(this.root.position);
    // Depart toward the nose (−dir).
    this.liftoffDir.set(-Math.sin(this.landYaw), 0, -Math.cos(this.landYaw));
  }

  /** Is a world position inside the bay footprint (XZ) and below the ceiling? */
  containsWorldPoint(p: THREE.Vector3): boolean {
    if (this.state !== 'landed' && this.state !== 'liftoff') return false;
    _v1.copy(p);
    this.root.worldToLocal(_v1);
    return Math.abs(_v1.x) <= BAY_HALF_W + 0.1 && _v1.z >= BAY_Z_MIN && _v1.z <= BAY_Z_MAX && _v1.y > -1 && _v1.y < BAY_HEIGHT;
  }

  /**
   * World y of the bay deck (local y = 0) directly under `(x, z)`. The deck **tilts** — the liftoff climb pitches
   * the nose up by 0.35 rad — so a single flat height for the whole box would sink a rider ~0.9 m through the
   * floor at the far end of the bay. Solving the deck plane instead is exact for any attitude.
   * `root` is a direct child of the scene, so its local transform is its world transform.
   */
  floorYAt(x: number, z: number): number {
    const o = this.root.position;                 // the root origin sits on the deck
    const up = _v2.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    if (Math.abs(up.y) < 1e-3) return o.y;
    return o.y - (up.x * (x - o.x) + up.z * (z - o.z)) / up.y;
  }

  /**
   * Rewrite `out` with the world-space AABB of the rotated bay (lenient bounds for player clamping); `at` is the
   * world position the deck height is solved for (the rider — see `floorYAt`), defaulting to the bay centre.
   * **The caller keeps one object and refreshes it every frame** — `PlayerRef.setShipInterior` stores the
   * reference, and the box has to travel with the ship or a boarded player is left walking on a floor that is no
   * longer there (2026-09-10: that was the "함선은 올라가는데 플레이어만 떨어진다" bug during liftoff).
   */
  writeInteriorBounds(out: { center: THREE.Vector3; halfExtents: THREE.Vector3 }, at?: THREE.Vector3): void {
    out.center.set(0, BAY_HEIGHT / 2, (BAY_Z_MIN + BAY_Z_MAX) / 2).applyMatrix4(this.root.matrixWorld);
    out.center.y = this.floorYAt(at ? at.x : out.center.x, at ? at.z : out.center.z) + BAY_HEIGHT / 2;
    const hw = BAY_HALF_W, hd = (BAY_Z_MAX - BAY_Z_MIN) / 2;
    const c = Math.abs(Math.cos(this.landYaw)), s = Math.abs(Math.sin(this.landYaw));
    out.halfExtents.set(hw * c + hd * s, BAY_HEIGHT / 2, hw * s + hd * c);
  }

  /** Fresh world-space AABB of the bay. Prefer `writeInteriorBounds` when the box is held across frames. */
  getInteriorBounds(): { center: THREE.Vector3; halfExtents: THREE.Vector3 } {
    const out = { center: new THREE.Vector3(), halfExtents: new THREE.Vector3() };
    this.writeInteriorBounds(out);
    return out;
  }

  getGroundY(): number { return this.landPos.y; }
  get position(): THREE.Vector3 { return this.root.position; }
  get descending(): boolean { return this.state === 'descend'; }
  get liftingOff(): boolean { return this.state === 'liftoff'; }
  get liftoffTime(): number { return this.state === 'liftoff' ? this.t : 0; }

  reset(): void {
    this.state = 'hidden';
    this.body.visible = false;
    this.rampAngle = this.rampTarget = Math.PI / 2;
    this.ramp.rotation.x = -this.rampAngle;
    this.thrust = 0;
    this.landingLightMat.emissiveIntensity = 0;
    this.interiorLampMat.emissive.set(0xfff2dc); this.interiorLampMat.emissiveIntensity = 2.2;
    // `update` early-returns while hidden, so the lights are darkened here — they stay in the scene either way.
    this.interiorLight.color.set(0xfff2dc); this.interiorLight.intensity = 0;
    for (const el of this.engineLights) el.intensity = 0;
    this.root.rotation.set(0, 0, 0);
    _q.identity();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.root.removeFromParent();
  }
}
