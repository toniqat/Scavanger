import type { ConsoleCommand } from '@/shared';
import type { CommandFactory } from './types';
import { err } from './types';

/** `help [name]` — list every registered command or describe one. */
export const help: CommandFactory = () => ({
  name: 'help',
  usage: 'help [커맨드]',
  description: '커맨드 목록 또는 설명을 표시합니다',
  run(args, ctx, print) {
    const cmds = (ctx.console?.getCommands() ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (args.length > 0) {
      const name = args[0].replace(/^\//, '').toLowerCase();
      const c = cmds.find((x) => x.name.toLowerCase() === name);
      if (!c) return err(`알 수 없는 커맨드: ${name}`);
      print(`/${c.usage}`, 'info');
      return c.description;
    }
    print(`커맨드 ${cmds.length}개 — 입력은 /move … 와 move … 모두 허용, 대소문자 무시`, 'info');
    for (const c of cmds) print(`/${c.usage.padEnd(28)} ${c.description}`, 'info');
    return undefined;
  },
  complete(args, ctx) {
    const prefix = (args[0] ?? '').toLowerCase();
    return (ctx.console?.getCommands() ?? []).map((c) => c.name).filter((n) => n.startsWith(prefix)).sort();
  },
}) satisfies ConsoleCommand;
