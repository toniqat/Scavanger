import * as THREE from 'three';

/** Colour/atmosphere palette chosen per mission seed. */
export interface SkyPalette {
  name: string;
  zenith: number;
  horizon: number;
  ground: number;     // below-horizon tint
  sun: number;        // sun disc / directional light colour
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  fog: number;
  fogDensity: number;
  sunElevation: number;  // radians above horizon
  sunAzimuth: number;    // radians around Y
  exposure: number;
}

export const SKY_PALETTES: SkyPalette[] = [
  {
    name: 'amber-dusk', zenith: 0x2a3a6a, horizon: 0xe8a25a, ground: 0x4a3a30, sun: 0xffb877, sunIntensity: 3.2,
    hemiSky: 0x8fa3c8, hemiGround: 0x5a4636, fog: 0xc99a6c, fogDensity: 0.0042, sunElevation: 0.32, sunAzimuth: 2.4, exposure: 1.0,
  },
  {
    name: 'cold-blue', zenith: 0x0f1c3a, horizon: 0x7c9fc4, ground: 0x2a3340, sun: 0xdfe9ff, sunIntensity: 2.8,
    hemiSky: 0x9fb8d8, hemiGround: 0x3b4450, fog: 0x8aa2bd, fogDensity: 0.0048, sunElevation: 0.55, sunAzimuth: 0.9, exposure: 0.95,
  },
  {
    name: 'toxic-green', zenith: 0x14261f, horizon: 0x9ab857, ground: 0x2c3620, sun: 0xe6f2a0, sunIntensity: 2.6,
    hemiSky: 0x8ea56f, hemiGround: 0x3a4028, fog: 0x8d9c5f, fogDensity: 0.0055, sunElevation: 0.45, sunAzimuth: 4.1, exposure: 0.95,
  },
  {
    name: 'rust-storm', zenith: 0x3a2320, horizon: 0xc8734a, ground: 0x3a2a24, sun: 0xffc99a, sunIntensity: 2.4,
    hemiSky: 0xb08a72, hemiGround: 0x4a3028, fog: 0xa86d4d, fogDensity: 0.0060, sunElevation: 0.25, sunAzimuth: 5.3, exposure: 1.05,
  },
  {
    name: 'pale-noon', zenith: 0x3d6fb8, horizon: 0xcfdbe6, ground: 0x6a6a60, sun: 0xfff4e0, sunIntensity: 3.4,
    hemiSky: 0xb8cce4, hemiGround: 0x60584c, fog: 0xbcc8d2, fogDensity: 0.0038, sunElevation: 0.9, sunAzimuth: 1.6, exposure: 0.9,
  },
];

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // push to far plane so nothing is occluded by the dome
    gl_Position.z = gl_Position.w * 0.99999;
  }
`;

const FRAG = /* glsl */`
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uTime;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    // horizon haze band
    float haze = pow(1.0 - clamp(abs(h), 0.0, 1.0), 4.0);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
    vec3 grd = mix(uHorizon, uGround, smoothstep(0.0, -0.25, h));
    vec3 col = h >= 0.0 ? sky : grd;
    col = mix(col, uHorizon, haze * 0.6);

    // sun disc + glow
    float cosA = dot(d, uSunDir);
    float disc = smoothstep(0.9993, 0.9997, cosA);
    float glow = pow(max(cosA, 0.0), 24.0) * 0.55 + pow(max(cosA, 0.0), 6.0) * 0.18;
    col += uSunColor * (disc * 3.0 + glow);

    // faint stars in the upper dome (dim, only where dark)
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    if (h > 0.15 && lum < 0.35) {
      vec2 sp = d.xz / (d.y + 0.2) * 220.0;
      float s = hash(floor(sp));
      float star = step(0.995, s) * (0.5 + 0.5 * sin(uTime * 2.0 + s * 60.0));
      col += star * (0.35 - lum) * 2.0;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Procedural gradient sky dome with a sun disc. Follows the camera every frame. */
export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  readonly sunDir = new THREE.Vector3(0.3, 0.6, 0.4).normalize();

  constructor(radius = 900) {
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir: { value: this.sunDir },
        uTime: { value: 0 },
      },
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.matrixAutoUpdate = true;
    this.applyPalette(SKY_PALETTES[0]);
  }

  applyPalette(p: SkyPalette): void {
    const u = this.material.uniforms;
    (u.uZenith.value as THREE.Color).setHex(p.zenith);
    (u.uHorizon.value as THREE.Color).setHex(p.horizon);
    (u.uGround.value as THREE.Color).setHex(p.ground);
    (u.uSunColor.value as THREE.Color).setHex(p.sun);
    this.sunDir.set(
      Math.cos(p.sunElevation) * Math.sin(p.sunAzimuth),
      Math.sin(p.sunElevation),
      Math.cos(p.sunElevation) * Math.cos(p.sunAzimuth),
    ).normalize();
  }

  update(time: number, camera: THREE.Camera): void {
    this.material.uniforms.uTime.value = time;
    this.mesh.position.copy(camera.position);
  }

  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); }
}
