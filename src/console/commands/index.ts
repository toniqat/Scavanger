import type { ConsoleCommand } from '@/shared';
import type { BuiltinHost } from './types';
import { help } from './help';
import { clear } from './clear';
import { seed } from './seed';
import { move } from './move';
import { movecheat } from './movecheat';
import { items } from './items';
import { stat } from './stat';
import { skill } from './skill';
import { pos } from './pos';

export type { BuiltinHost } from './types';
export { parseSeedArg } from './seed';

/** Every built-in command, in `help` order. */
export function builtinCommands(host: BuiltinHost): ConsoleCommand[] {
  return [help, clear, seed, move, movecheat, items, stat, skill, pos].map((f) => f(host));
}
