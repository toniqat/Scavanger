import * as THREE from 'three';

/**
 * Procedural CanvasTexture text plane (no DOM, no asset files) used for pod name tags and terminal screens.
 * `set()` redraws only when the text actually changed.
 */
export class TextPlane {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D | null;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly geo: THREE.PlaneGeometry;
  private last = '';

  constructor(widthM: number, heightM: number, px = 512, transparent = true) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = Math.max(32, Math.round(px * heightM / widthM));
    this.ctx2d = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent, depthWrite: !transparent, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.geo = new THREE.PlaneGeometry(widthM, heightM);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.renderOrder = 5;
  }

  /**
   * Draw `lines` (top → bottom). `accent` = CSS colour of the first line / underline; `bg` = panel fill (transparent when null).
   */
  set(lines: string[], accent = '#e8e6e1', bg: string | null = null, dim = '#9a9a9a'): void {
    const key = lines.join('\n') + '|' + accent + '|' + (bg ?? '') + '|' + dim;
    if (key === this.last || !this.ctx2d) return;
    this.last = key;
    const c = this.ctx2d, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    if (bg) {
      c.fillStyle = bg;
      c.fillRect(0, 0, W, H);
      c.strokeStyle = accent; c.globalAlpha = 0.5; c.lineWidth = 3;
      c.strokeRect(6, 6, W - 12, H - 12);
      c.globalAlpha = 1;
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const n = Math.max(1, lines.length);
    const rowH = H / (n + 0.4);
    for (let i = 0; i < lines.length; i++) {
      const isFirst = i === 0;
      const size = Math.floor(rowH * (isFirst ? 0.62 : 0.5));
      c.font = `${isFirst ? '700' : '500'} ${size}px "Segoe UI", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif`;
      c.fillStyle = isFirst ? accent : dim;
      c.shadowColor = 'rgba(0,0,0,0.9)'; c.shadowBlur = 6;
      c.fillText(lines[i], W / 2, rowH * (i + 0.9));
    }
    c.shadowBlur = 0;
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mat.dispose();
    this.geo.dispose();
    this.mesh.removeFromParent();
  }
}
