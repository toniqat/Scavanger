/**
 * Window bounds / maximized / fullscreen persistence (`<userData>/window-state.json`).
 * Bounds are re-validated against the current displays so a window saved on an unplugged monitor still opens.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  fullscreen: boolean;
}

const DEFAULT: WindowState = { width: 1600, height: 900, maximized: false, fullscreen: false };
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;

function file(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** True when the rectangle's top-left is inside some display's work area (the monitor may have been unplugged). */
function onSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return bounds.x >= a.x - 32 && bounds.y >= a.y - 32
      && bounds.x < a.x + a.width - 64 && bounds.y < a.y + a.height - 64;
  });
}

export function loadWindowState(): WindowState {
  let raw: Partial<WindowState> = {};
  try { raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<WindowState>; } catch { /* first run */ }
  const state: WindowState = {
    width: Number.isFinite(raw.width) ? Math.max(MIN_WIDTH, Math.round(raw.width as number)) : DEFAULT.width,
    height: Number.isFinite(raw.height) ? Math.max(MIN_HEIGHT, Math.round(raw.height as number)) : DEFAULT.height,
    maximized: raw.maximized === true,
    fullscreen: raw.fullscreen === true,
  };
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    const bounds = { x: Math.round(raw.x as number), y: Math.round(raw.y as number), width: state.width, height: state.height };
    if (onSomeDisplay(bounds)) { state.x = bounds.x; state.y = bounds.y; }
  }
  return state;
}

/** Persist on every settle (resize/move/maximize/fullscreen) — cheap, and survives a crash or a taskbar close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = (): void => {
    if (win.isDestroyed()) return;
    // While maximized / fullscreen the OS bounds are the screen: keep the last *restored* size instead.
    const normal = win.getNormalBounds();
    const state: WindowState = {
      width: Math.max(MIN_WIDTH, normal.width),
      height: Math.max(MIN_HEIGHT, normal.height),
      x: normal.x,
      y: normal.y,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    };
    try { writeFileSync(file(), JSON.stringify(state, null, 2), 'utf8'); } catch { /* read-only profile */ }
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);
  win.on('close', () => { if (timer) clearTimeout(timer); save(); });
}
