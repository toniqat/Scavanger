/**
 * src/allies/parts/Console.ts — 개발 치트 `/android 1|0` (사용자 결정 — **서버 없이** 안드로이드를 한 기 넣고 뺀다).
 *
 * 도킹된 로비 안에서는 진짜 경로를 탄다 (`NetRef.setAndroidBay` → 릴레이 봇 멤버). 로비가 없으면 **로컬 명단**에
 * 한 기를 넣는다 — 개인 함선에서도 보이고 솔로 레이드에 같이 간다. 로컬 명단은 세션 동안만 살고 저장되지 않는다.
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

/** `AlliesRef.devSetAndroid` — 결과 한 줄(한국어). */
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
