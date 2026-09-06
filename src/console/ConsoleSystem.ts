import type { ConsoleCommand, ConsoleLineKind, ConsoleRef, GameContext, GameSystem } from '@/shared';
import { isDevHost } from '@/shared';

/**
 * Developer console (skeleton — TODO(agent console): implement per docs/PHASE6-PLAN.md).
 * Publishes `ctx.console`. Inert unless the page host is a dev host (`isDevHost`).
 */
export class ConsoleSystem implements GameSystem, ConsoleRef {
  readonly name = 'console';
  readonly enabled = isDevHost();
  isOpen = false;
  moveCheat = false;
  private commands = new Map<string, ConsoleCommand>();

  init(ctx: GameContext): void {
    ctx.console = this;
  }
  update(_dt: number, _ctx: GameContext): void { /* TODO(agent console) */ }

  register(cmd: ConsoleCommand): () => void {
    const key = cmd.name.toLowerCase();
    this.commands.set(key, cmd);
    return () => { if (this.commands.get(key) === cmd) this.commands.delete(key); };
  }
  getCommands(): readonly ConsoleCommand[] { return Array.from(this.commands.values()); }
  run(_line: string): void { /* TODO(agent console) */ }
  print(_text: string, _kind?: ConsoleLineKind): void { /* TODO(agent console) */ }
  open(): void { /* TODO(agent console) */ }
  close(): void { /* TODO(agent console) */ }
}
