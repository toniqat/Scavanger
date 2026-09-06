import type { CommandFactory } from './types';

/** `clear` — wipe the output log. */
export const clear: CommandFactory = (host) => ({
  name: 'clear',
  usage: 'clear',
  description: '출력 로그를 지웁니다',
  run() { host.clearLog(); },
});
