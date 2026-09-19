/**
 * src/allies/parts/Console.ts — the dev cheat `/android 1|0` (user's decision — puts one android in and takes it
 * out again **with no server**).
 *
 * Inside a docked lobby it takes the real road (`NetRef.setAndroidBay` → a relay bot member). With no lobby it puts
 * one unit on the **local roster** — it shows in the personal ship too and comes along on a solo raid. The local
 * roster lives for the session only and is never saved.
 */
import { ANDROID_BAY_COUNT, androidOnBay, isDockedLobby } from '@/shared';
import type { AllySystem } from '../AllySystem';
import * as Roster from './Roster';

export function register(sys: AllySystem): void {
  const unreg = sys.ctx.console?.register({
    name: 'android',
    usage: 'android <0|1>',
    description: '안드로이드 분대원을 한 기 들이거나(1) 돌려보낸다(0).',
    run: (args) => {
      const raw = (args[0] ?? '').trim();
      if (raw !== '0' && raw !== '1') return { error: '사용법: android <0|1>' };
      return devSetAndroid(sys, raw === '1');
    },
    complete: (args) => (args.length <= 1 ? ['0', '1'] : []),
  });
  if (unreg) sys.unsubs.push(unreg);
}

/** `AlliesRef.devSetAndroid` — one line of result (Korean). */
export function devSetAndroid(sys: AllySystem, on: boolean): string {
  const net = sys.ctx.net;
  const lobby = net?.lobby ?? null;
  if (lobby && isDockedLobby(lobby)) {
    if (!net?.isHost) return '분대장만 안드로이드 슬롯을 다룰 수 있다.';
    if (typeof net.setAndroidBay !== 'function') return '이 서버는 안드로이드 슬롯을 모른다.';
    if (on) {
      for (let bay = 0; bay < ANDROID_BAY_COUNT; bay++) {
        if (androidOnBay(lobby, bay)) continue;
        net.setAndroidBay(bay, true);
        return `안드로이드 슬롯 ${bay + 1} — 분대에 들였다.`;
      }
      return '빈 안드로이드 슬롯이 없다.';
    }
    for (let bay = ANDROID_BAY_COUNT - 1; bay >= 0; bay--) {
      if (!androidOnBay(lobby, bay)) continue;
      net.setAndroidBay(bay, false);
      return `안드로이드 슬롯 ${bay + 1} — 돌려보냈다.`;
    }
    return '분대에 안드로이드가 없다.';
  }

  if (on) {
    const added = Roster.addLocal(sys);
    return added ? `${added.name} 을(를) 분대에 넣었다 (로컬 명단).` : '더 넣을 수 없다.';
  }
  const gone = Roster.removeLocal(sys);
  return gone ? `${gone.name} 을(를) 뺐다.` : '분대에 안드로이드가 없다.';
}
