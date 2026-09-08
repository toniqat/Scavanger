/**
 * 화면 설정 store (2026-09-08). Owner: `ui/menus/SettingsMenu`, which is the only writer.
 *
 * Four knobs, persisted in localStorage next to the audio + keybind saves, and published on `ui:displayChanged` for
 * `main.ts` to hand to the `Engine` (this folder must not reach into core/). Kept out of the character wipe by using
 * the `scav.` prefix the way `scav.keybinds` / `scav.audio` do — a display preference is not a character.
 *
 * **전체화면 is the one that matters beyond taste**: only a *document* fullscreen lets `Input.syncKeyboardLock` run
 * `navigator.keyboard.lock(['Escape'])`, which routes Escape to the page instead of letting the browser eat it to
 * free the pointer lock. With it on, Escape opens the 일시정지 메뉴 without ever dropping the lock, and closing the
 * menu gives the camera back instantly. Without it the game still works — `game/` treats the unlock itself as the
 * key — the camera just waits for the player's next click or keypress. Requesting fullscreen needs a real user
 * gesture, so it can only ever be turned on from the panel's own click, never restored at startup.
 */

export const DISPLAY_STORAGE_KEY = 'scav.display';

export interface DisplaySettings {
  /** Document fullscreen. Reflects `document.fullscreenElement`, not the stored wish (F11 changes it behind us). */
  fullscreen: boolean;
  /** Bloom / post chain (`Engine.setPostProcessing`). */
  bloom: boolean;
  /** Sun shadow casting (`Engine.setShadows`). */
  shadows: boolean;
  /** Device pixels per CSS pixel, on top of the engine's 1.5 cap (`Engine.setResolutionScale`). */
  scale: number;
}

/** Selectable 해상도 배율 steps. */
export const DISPLAY_SCALES: readonly number[] = [0.75, 1, 1.25];

export const DISPLAY_DEFAULTS: Readonly<DisplaySettings> = { fullscreen: false, bloom: true, shadows: true, scale: 1 };

const clampScale = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DISPLAY_DEFAULTS.scale;
  // snap to the nearest offered step so a hand-edited file cannot produce a value the UI has no button for
  let best = DISPLAY_SCALES[0];
  for (const s of DISPLAY_SCALES) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
};

/** Read the stored settings (defaults on anything missing / corrupt). `fullscreen` always comes from the document. */
export function loadDisplaySettings(): DisplaySettings {
  const out: DisplaySettings = { ...DISPLAY_DEFAULTS };
  try {
    const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<DisplaySettings>;
      if (typeof j.bloom === 'boolean') out.bloom = j.bloom;
      if (typeof j.shadows === 'boolean') out.shadows = j.shadows;
      out.scale = clampScale(j.scale);
    }
  } catch { /* private mode / corrupt file — defaults */ }
  out.fullscreen = isFullscreen();
  return out;
}

export function saveDisplaySettings(s: DisplaySettings): void {
  try {
    // `fullscreen` is deliberately not stored: it cannot be restored without a user gesture anyway.
    localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({ bloom: s.bloom, shadows: s.shadows, scale: s.scale }));
  } catch { /* ignore */ }
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

/**
 * Enter / leave document fullscreen. Must be called from a user gesture (a click on the toggle). Resolves to the
 * state that actually took effect, so a refused request simply leaves the row switched off.
 */
export async function setFullscreen(on: boolean): Promise<boolean> {
  try {
    if (on) await document.documentElement.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen?.();
  } catch { /* denied (permissions policy, no gesture) — fall through and report the real state */ }
  return isFullscreen();
}
