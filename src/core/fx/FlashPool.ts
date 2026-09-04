import * as THREE from 'three';

/**
 * Pool of short-lived point lights + additive billboard glows (muzzle flashes, explosions).
 * Point lights are cheap when they cast no shadows; we cap concurrent lights to keep shader
 * permutations stable (lights are always in the scene, intensity 0 when idle).
 */
interface Flash {
  light: THREE.PointLight;
  sprite: THREE.Mesh;
  life: number; maxLife: number;
  intensity: number; size: number;
  busy: boolean;
}

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,240,200,0.95)');
  grad.addColorStop(0.45, 'rgba(255,170,60,0.45)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // star spikes
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,230,180,0.55)';
  g.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + Math.PI / 8;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62);
    g.lineTo(64 - Math.cos(a) * 62, 64 - Math.sin(a) * 62);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FlashPool {
  readonly group = new THREE.Group();
  private readonly items: Flash[] = [];
  private readonly texture: THREE.CanvasTexture;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);

  constructor(count = 6) {
    this.group.name = 'FlashPool';
    this.texture = makeGlowTexture();
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffc070, 0, 8, 2);
      light.castShadow = false;
      const mat = new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, opacity: 0,
      });
      const sprite = new THREE.Mesh(this.geometry, mat);
      sprite.visible = false;
      sprite.renderOrder = 30;
      this.group.add(light, sprite);
      this.items.push({ light, sprite, life: 0, maxLife: 0.05, intensity: 0, size: 0.6, busy: false });
    }
  }

  /**
   * @param intensity point light intensity (candela-ish; 6–10 for muzzle, 80+ for explosions)
   * @param size glow quad size (meters)
   */
  flash(position: THREE.Vector3, color: number, intensity: number, size: number, life = 0.05, distance = 8): void {
    let f = this.items.find((x) => !x.busy);
    if (!f) { f = this.items.reduce((a, b) => (a.life < b.life ? a : b)); }
    f.busy = true; f.life = life; f.maxLife = life; f.intensity = intensity; f.size = size;
    f.light.color.setHex(color); f.light.intensity = intensity; f.light.distance = distance;
    f.light.position.copy(position);
    (f.sprite.material as THREE.MeshBasicMaterial).color.setHex(color);
    (f.sprite.material as THREE.MeshBasicMaterial).opacity = 1;
    f.sprite.position.copy(position);
    f.sprite.scale.setScalar(size);
    f.sprite.rotation.z = Math.random() * Math.PI * 2;
    f.sprite.visible = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (const f of this.items) {
      if (!f.busy) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.busy = false; f.light.intensity = 0; f.sprite.visible = false;
        continue;
      }
      const t = f.life / f.maxLife;
      f.light.intensity = f.intensity * t;
      const m = f.sprite.material as THREE.MeshBasicMaterial;
      m.opacity = t;
      f.sprite.scale.setScalar(f.size * (1.3 - 0.3 * t));
      // billboard: face camera, keep random roll
      const roll = f.sprite.rotation.z;
      f.sprite.quaternion.copy(camera.quaternion);
      f.sprite.rotateZ(roll);
    }
  }

  clear(): void {
    for (const f of this.items) { f.busy = false; f.light.intensity = 0; f.sprite.visible = false; }
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    for (const f of this.items) (f.sprite.material as THREE.Material).dispose();
  }
}
