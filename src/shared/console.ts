import type { GameContext } from './GameContext';

/* ────────────────────────────────────────────────────────────────────────────
 * Developer console (2026-09-06). Owner: console/ConsoleSystem publishes `ctx.console`.
 *
 * Unreal-style console: the ` key (Keys.CONSOLE) opens a one-line input bar at the very bottom of the screen with
 * the recent output above it. Available only on a **dev client** — a page whose hostname is in DEV_HOSTS (the machine
 * running the vite/relay server). Other clients never see it (`enabled === false`, the key does nothing).
 * Any folder may register commands through `ctx.console.register(...)` (e.g. weapons could add `give`), but the
 * built-in cheats live in console/.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ConsoleLineKind = 'input' | 'info' | 'success' | 'error';

export type ConsolePrint = (text: string, kind?: ConsoleLineKind) => void;

export interface ConsoleCommand {
  /** Command word without the leading slash (`move`). Case-insensitive; the input accepts `/move` and `move`. */
  name: string;
  /** Shown in the suggestion list and `help`: `move <x>,<y>,<z>`. */
  usage: string;
  /** 한국어 one-liner. */
  description: string;
  /**
   * Execute. `args` = whitespace-split tokens after the command word (the raw line is `args.join(' ')`).
   * Return a string to print it as a success line; throw / return `{ error }` for a red line.
   */
  run(args: string[], ctx: GameContext, print: ConsolePrint): void | string | { error: string } | Promise<void | string | { error: string }>;
  /** Completions for the argument currently being typed (e.g. stat ids). */
  complete?(args: string[], ctx: GameContext): string[];
}

export interface ConsoleRef {
  /** true only on a dev client (see `isDevHost`). Everything else is inert when false. */
  readonly enabled: boolean;
  readonly isOpen: boolean;
  /** `/movecheat 1`: Home moves the player quickly along the camera forward (MOVE_CHEAT_SPEED). */
  readonly moveCheat: boolean;
  /** Register a command (replaces one with the same name). Returns the unregister function. */
  register(cmd: ConsoleCommand): () => void;
  getCommands(): readonly ConsoleCommand[];
  /** Execute a line exactly as if typed (`/move 0,0,0` or `move 0,0,0`). Also records it in the history. */
  run(line: string): void;
  print(text: string, kind?: ConsoleLineKind): void;
  open(): void;
  close(): void;
}

/** Page hosts that count as "the server machine" — the console is enabled only there. */
export const DEV_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** true when `hostname` (default `location.hostname`) is a dev host. */
export function isDevHost(hostname?: string): boolean {
  const h = (hostname ?? (typeof location !== 'undefined' ? location.hostname : '')).toLowerCase();
  return DEV_HOSTS.includes(h);
}
