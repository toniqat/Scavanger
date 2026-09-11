import type { ConsoleCommand } from '@/shared';

/** What the built-in commands need from `ConsoleSystem` beyond the public `ConsoleRef` (log + cheat flag setters). */
export interface BuiltinHost {
  clearLog(): void;
  setMoveCheat(enabled: boolean): void;
  readonly moveCheat: boolean;
  /** 2026-09-12: 콜라이더 와이어프레임 (`ColliderOverlay`). */
  setColliders(enabled: boolean): void;
  readonly colliders: boolean;
  readonly colliderCount: number;
}

export type CommandFactory = (host: BuiltinHost) => ConsoleCommand;

/** Shared result helpers so every command prints the same shapes. */
export const err = (error: string): { error: string } => ({ error });

/** `±123`, `1e3`, `-0.5` → number; NaN for anything else. */
export function parseNumber(raw: string | undefined): number {
  if (raw === undefined) return NaN;
  const s = raw.trim().replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

export function fmt(n: number, digits = 2): string {
  return (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
}
