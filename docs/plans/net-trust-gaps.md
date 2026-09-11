# 신뢰 경로 · 차단 · 알림의 남은 틈 — E-8 · E-9 · B-11 · B-12

2026-09-11. 16차 배치(`plans/net-social-trust.md`, 구현 후 삭제)가 남긴 네 항목의 설계안이다.
[TODO.md](../TODO.md) 묶음 3 · 4 의 같은 ID 행이 원본이고, 여기 적힌 결정은 전부 **사용자가 고른 것**이다.

작업 방식은 Phase 5 이후와 같다: **리드가 `src/shared` + `data/` 계약을 먼저 커밋** → 폴더별 병렬 에이전트 → `npm run verify:all`.

---

## 0. 결정 요약 (사용자, 2026-09-11)

| 항목 | 결정 |
|---|---|
| E-8 (a) `explode` | **좌표 + 보낸 사람 + 요율**까지. `ExplodeRequest` 에 `kind` 는 더하지 않는다 — 500/20 상한은 그대로 두고 검사만 세 겹 얹는다 |
| E-8 (b) `st` | **상태이상 전용 버킷만**. DoT 예상 총량을 DPS 버킷에서 미리 차감하지 않는다 (사거리 검사가 이미 원격 남발을 막고, 정당한 화염방사기 플레이가 깎일 위험이 없다) |
| E-8 (c) `stratq` 거절 | **거절 시 환불 + 토스트**. 구조선 `deny` 선례 그대로, 쿨타임은 낙관적으로 먼저 돌되 거절이 오면 되돌린다 |
| E-9 반올림 | **`round` → `floor` 통일**. 가치 1 아이템 1개는 0 C 가 되고 **거래대는 0 C 로 표시하고 그대로 판매를 허용한다** |
| E-9 소유 검증 | 하지 않는다 (페이즈 규모). TODO 행에서 내려 `참고 — 의도된 한계` 로 옮긴다 |
| B-11 join | **방향별로 갈라서** — 내가 차단한 사람이 있으면 명시 사유, 상대가 나를 차단했으면 위장(`not_found`). quickmatch 는 그 로비를 건너뛴다 |
| B-12 | hub 쪽 두 줄(합류 · 이탈)을 제거한다 |

---

## 1. E-8 (a) — `explode` 요청

### 확인된 사실

`enemies/parts/Damage.ts:226` `onExplodeRequest` 의 검증은 셋뿐이다: `sys.hosting`, `0 < dmg ≤ MAX_REQUEST_DAMAGE`(500),
`0 < r ≤ MAX_REQUEST_RADIUS`(20) — 둘 다 `enemies/model.ts:49-50` 하드코딩.

없는 것:

- **좌표 검증 없음** — 같은 파일 `:167` 의 `hit` 은 `isVec3Tuple(p)` 를 하는데 `explode` 는 `_c.set(p[0],p[1],p[2])` 로 그냥 쓴다 (`NaN` · `undefined` 가 들어간다)
- **보낸 사람 검증 없음** — 로비 멤버인지 · 살아 있는지 · 폭심에서 얼마나 먼지 전혀 안 본다
- **요율 제한 없음** — `spendHitBudget` 을 타지 않는다 (`data/constants.csv:710` 이 "explode 요청은 세지 않는다" 고 명시).
  즉 **500 피해 × 반경 20 을 프레임마다 무제한** 보낼 수 있고 킬 크레딧은 전부 `from` 에게 간다
  (`Damage.ts:231` → `onEnemyKilled` → `ee kill {killer}` → 모든 리플리카의 `enemy:squadKill`)

보내는 곳은 둘이다 — `Damage.ts:50` `applyExplosion` 의 리플리카 가지(수류탄 `weapons/Grenade.ts:151` · 바주카
`weapons/unique/Bazooka.ts:86` · 함선 호출 낙하 `stratagems/parts/Calls.ts:63` · 가젯 `gadgets/parts/Simulate.ts:240`)와
AT 런처 `implants/parts/Devices.ts:367` (`applyExplosion` 을 거치지 않고 직접 쓴다).

### 변경

`enemies/parts/Damage.ts` 안에서 끝난다 — **와이어 계약은 안 바뀐다**(주석만).
`shared/buffRules.createBuffGuard` 와 같은 순서로 검사한다:

```
① 모양      isVec3Tuple(p) && r · dmg 유한 · 0 < dmg ≤ 500 · 0 < r ≤ 20      (기존 + 좌표)
② 보낸 사람  net.getRemotePlayer(from) 이 있고 isDead 가 아니다               (knockbackInReach 와 같은 어댑터)
③ 거리      수평거리(sender, p) ≤ STRAT_MAX_CALL_RANGE + EXPLODE_REQUEST_RANGE_SLACK
④ 요율      spendHitBudget(sys, from, dmg) — 깎이면 깎인 값으로, 0 이면 버린다
```

③ 의 기준을 **함선 호출 사거리**로 잡는 이유: 폭발원 중 가장 먼 것이 호출 낙하물이다. `strat call` 은 이미
`STRAT_MAX_CALL_RANGE`(150 m) 안에서만 호스트가 승인하지만, 낙하까지 `eta` 만큼 시간이 흐르는 동안 호출자가 더
멀어질 수 있다 — 그 몫이 slack 이다. 수류탄 · 바주카 · AT 는 전부 이보다 훨씬 짧으므로 같은 상한에 덮인다.

④ 는 `hit` 과 **같은 버킷**을 쓴다(별도 버킷을 두면 두 경로를 번갈아 써서 합계가 두 배가 된다).
깎인/버린 것은 기존 `sys.hitGuardStats` 에 센다.

덤으로 같은 자리에서 고칠 한 줄 — `gadgets/parts/Simulate.ts:240` → `Damage.ts:99` `applyAreaDamage` 의 리플리카
강등 경로에서 **`by` 킬 크레딧이 버려진다**(지뢰 킬이 "누가 죽였는지 모르는 것" 이 된다). `explode` 에는 소유자
칸이 없으므로 릴레이의 `from` 이 곧 소유자인 경우에만 맞는데, 실제로 그렇다(자기 지뢰는 자기가 시뮬레이션한다).

### 계약 추가 (리드)

`data/constants.csv`:

```
EXPLODE_REQUEST_RANGE_SLACK,40,"E-8 호스트가 받는 explode 요청: 보낸 사람 스냅샷 위치와 폭심의 수평 거리가
                                STRAT_MAX_CALL_RANGE + 이 값(m) 안이어야 한다. …"
```

`HIT_REQUEST_DPS_MAX`(csv:710) 의 설명 끝 문장을 뒤집는다 — "explode 요청은 세지 않는다" → "explode 요청도
같은 버킷에서 `dmg` 를 한 번 뺀다".

`shared/net.ts` 의 `ExplodeRequest` 주석에 호스트가 무엇을 검사하는지 적는다 (계약 필드 변경 없음).

### 착수 전 실측

- 정당한 플레이에서 ③ 이 거절을 내지 않는가 — **함선 호출 낙하가 가장 위험하다**. 호출 직후 반대로 질주하면서
  낙하를 맞으면 거리 = 150(호출 사거리) + 이동. `eta` 가 가장 긴 호출(궤도 폭격)의 낙하 시간 × 질주 속도가
  slack 40 m 안에 드는지 실제로 재고, 넘으면 slack 을 올린다.
- ④ 가 수류탄 연속 투척 · 바주카 연사를 깎지 않는가 (5000/s · 버스트 2 s 대비 실사용량).

---

## 2. E-8 (b) — `HitRequest.st`

### 확인된 사실

`Damage.ts:163` 의 `const st = msg.st ?? 0` 이 전부다. 상한은 `Status.ts:150` 의 `dur ≤ MAX_STATUS_DURATION`(10 s)
하나뿐이고, 그 결과:

- 어떤 적 id 든 **거리 무관**하게 `INCINERATED` 10 초(이동 · 공격 불가, `Status.ts:77`)를 걸 수 있다. 4 비트를 한꺼번에 걸 수도 있다
- `ENEMY_STATUS_BITS` 밖의 비트를 걸러내지 않는다 (지금은 무해하지만 비트가 늘면 그대로 샌다)
- 화상 DoT 피해는 호스트가 `Enemy.applyDot` 으로 내므로 **DPS 버킷을 우회**하고, 킬 크레딧은 `Status.ts:73` 의
  `e.burnAttacker` 로 요청자에게 간다
- 스로틀 `STATUS_REQUEST_INTERVAL`(0.25 s, `enemies/model.ts:78`)은 **보내는 쪽에만** 있다

### 변경

`enemies/parts/Damage.ts` + `enemies/parts/Status.ts`. 순서:

```
① 비트     st &= 알려진 비트 전부의 합 — 남은 게 0 이면 상태이상 부분은 통째로 건너뛴다
② 거리     수평거리(sender, enemy) ≤ STATUS_SOURCE_REACH + STATUS_REQUEST_RANGE_SLACK
③ 요율     per-sender 토큰 버킷 (STATUS_REQUEST_RATE_MAX / STATUS_REQUEST_BURST_S) — 넘으면 버린다
④ 지속     기존 dur ≤ MAX_STATUS_DURATION 그대로
```

`STATUS_SOURCE_REACH` 는 **csv 수치가 아니라 데이터에서 유도한다** (`buffRules.limits()` 와 같은 방식):
상태이상을 거는 원본은 실제로 둘뿐이고 — `weapons/unique/Flamethrower.ts:113,118` (`FLAME_RANGE` 12 m) ·
`weapons/unique/Shockgun.ts:110` (`SHOCK_RANGE` 14 m) — 그 최대값을 쓴다. 하드코딩 숫자 0 개.

**결정대로 DoT 선차감은 하지 않는다.** ② 가 원격 남발을 막고, ③ 이 근접해서의 남발을 막는다.

### 계약 추가 (리드)

`data/constants.csv`:

```
STATUS_REQUEST_RANGE_SLACK,8,"E-8 호스트가 받는 상태이상 요청(HitRequest.st): 보낸 사람 스냅샷 위치와 적의 수평
                              거리가 max(FLAME_RANGE, SHOCK_RANGE) + 이 값(m) 안. …"
STATUS_REQUEST_RATE_MAX,60,"E-8 상태이상 요청의 보낸 사람별 초당 건수 상한 (토큰 버킷). 화염방사기는 대상마다
                            0.25 s 스로틀(STATUS_REQUEST_INTERVAL)이라 12 대상이면 48/s. …"
STATUS_REQUEST_BURST_S,2,"E-8 상태이상 요청 버킷의 크기 = STATUS_REQUEST_RATE_MAX × 이 초."
```

`shared/net.ts` 의 `HitRequest.kb` 주석 마지막 문장 **"`st` is still trusted (duration-capped only)"** 를
새 검사로 바꿔 적는다.

### 착수 전 실측 (이것을 먼저 확인하지 않으면 정당한 플레이가 깨진다)

`gadgets/parts/Simulate.ts:146` 의 소이 구역이 `applyStatus('burning', …, d.owner)` 를 부른다. 배치물은
**호스트 권한**이므로 이 호출은 호스트에서만 일어나야 하고, 그러면 와이어를 타지 않는다. 그런데 만약
비호스트도 구역을 돌린다면 소유자가 구역에서 멀리 떨어져 있을 수 있어 **② 거리 검사에 걸린다**.
착수 첫 단계에서 이것을 실제로 확인하고, 비호스트 경로가 있으면 그 호출만 `st` 요청에서 빼거나
`GADGET_INCENDIARY_RADIUS` + 투척 거리를 reach 에 더한다.

---

## 3. E-8 (c) — 거절된 분대원 함선 호출

### 확인된 사실

`stratagems/parts/Targeting.ts:294` 의 `startCooldown(def.cooldown)` 이 **호스트에 보내기 전** 무조건 실행된다
(호스트 · 싱글 · 분대원 · 구조선이 전부 이 한 줄을 지난다). 호스트의 거절은 `stratagems/parts/Wire.ts:130` 에서
`sys.lastCallRefusal` 에 **기록만** 되고 — 그 필드를 읽는 곳은 `scripts/smoke-trust.mjs:160` 뿐이다 —
호출자에게 가는 메시지가 없다. `StratagemMessage`(`shared/net.ts:426`)에 `deny` 류가 없고 `stratq` 는 단방향이다.
그리고 **`startCooldown` 을 되돌리는 코드가 없다** (`debugCooldownReset`, `StratagemSystem.ts:172` 뿐).

거절 사유는 `Wire.ts:102` `callRefusal` 이 내는 `'not_host' | 'self' | 'phase' | 'member' | 'point' | 'bounds' |
'caller' | 'range' | 'cooldown'` 과 `onCallRequest` 자체의 `'callId' | 'kind' | 'host_only'` 다.

선례는 이미 있다 — 구조선은 `stratagems/parts/Rescue.ts:171` 의 `deny` / `DENY_KO` / `showDeny` 3 함수로
반쪽 통보를 한다(`cooldown` 사유만 `busy` 로 보낸다, `Rescue.ts:254`).

### 변경

1. **와이어** — `StratagemMessage` 에 한 줄 추가(계약은 추가만):
   `| { t: 'strat'; ev: 'deny'; callId: string; reason: StratagemDenyReason }`
   `StratagemDenyReason` 은 위 사유 문자열의 union 으로 `shared/net.ts` 에 둔다. **한국어 문구는 계약이 아니다** —
   `Rescue.DENY_KO` 와 같이 `stratagems/` 가 갖는다.
2. **호스트** — `Wire.ts:130` 의 지역 `refuse` 가 `lastCallRefusal` 기록과 함께 `deny` 를 **보낸 사람에게만** 보낸다.
   구조선도 같은 자리에서 통일한다(`Rescue.ts:254` 의 `cooldown` 만 알리던 반쪽을 전부로).
3. **호출자** — `StratagemSystem` 에 `refundCooldown()` 신설. `_cooldown` · `_cooldownTotal` · `cooldownEmitAcc`
   셋을 함께 0 으로 내리고 `stratagem:cooldown` 을 방출한다 (`debugCooldownReset` `:172` 이 그대로 본보기).
   `Wire` 의 `deny` 수신 핸들러가 `fromHost` 를 확인하고 **내가 보낸 `callId` 일 때만** 환불 + `ui_deny` +
   `ui:notify` 사유 토스트.
4. **`callId` 소유 확인** — `deny` 를 받은 쪽은 `callId.startsWith(localId)` 로 자기 것인지 본다
   (호스트의 `onCallRequest` 가 이미 같은 규약을 쓴다, `Wire.ts:131`).

**환불은 전액이다.** 거절은 "호출이 아예 서지 않았다" 는 뜻이므로 부분 환불에 근거가 없다.

### 검증에서 확인할 것

거절 → 환불이 **쿨타임 되감기 치트가 되지 않는가**: `deny` 는 호스트만 보내고(`fromHost`), 받는 쪽이 자기
`callId` 만 받아들이므로 남이 내 쿨타임을 되돌릴 수는 없다. 자기가 자기 쿨타임을 되돌리는 것은 범위 밖이다
(E-4 가 정한 "내가 나에게 치트는 범위 밖" 그대로).

---

## 4. E-9 — 판매 반올림

### 확인된 사실

반올림이 `qty` 를 곱한 **뒤** 한 번 일어난다 (`shared/meta.ts:107`, 서버 쌍둥이 `shared/credits.ts:104`):

```
sellPriceOf(v, q) = max(0, round(v × SELL_PRICE_MUL × q))          SELL_PRICE_MUL = 0.5

ammo_light (value 1, stack 80)   묶음 round(40)   = 40 C     낱개 round(0.5)=1 × 80 = 80 C    2.00배
ammo_belt  (value 1, stack 300)  묶음 150 C                  낱개 300 C                       2.00배
ammo_heavy (value 3, stack 25)   묶음 round(37.5)= 38 C      낱개 round(1.5)=2 × 25 = 50 C    1.32배
ammo_medium(value 2, stack 50)   묶음 50 C                   낱개 50 C                        차이 없음
```

원인은 "value 1" 이 아니라 **`value × 0.5` 가 정수가 아닌 모든 홀수 value** 다. 낱개화 수단은 실재한다
(`inventory/ui/parts/ContextMenu.ts:163` Shift/Ctrl 분할). 서버는 막을 수 없다 — `Economy.check` 의 `sell` 분기
(`server/Economy.ts:186`)가 보는 상한 `tableSellPrice(t, 1, 1) = round(0.5) = 1` 과 요청 금액이 **정확히 같아서**
거래 하나하나가 정당하다. 게다가 `Economy.commit`(`:230`)의 switch 에 `sell` case 가 없어 원장에 한 줄도 안 남는다.

판매 tx 는 판매 1건당 정확히 1회다 (`meta/parts/Trade.ts:185`, 청크는 `stackMax` 초과 레거시 스택용).

### 변경

`round` → `floor` 로 통일하고, **두 파일에 복사돼 있는 같은 수식을 하나로 합친다**
(CLAUDE.md 「같은 수식을 두 폴더가 쓰면 `shared` 로 뽑는다」). 방향은 `credits.ts` → `meta.ts` 다:
`shared/credits.ts` 는 csv 로더를 쓰지 않아(서버가 import 한다) 순수 함수를 둘 수 있고,
`shared/meta.ts` 가 `SELL_PRICE_MUL` 을 넘겨 그것을 부른다. 반대 방향은 서버를 깨뜨린다.

```ts
// shared/credits.ts — 순수 수식 (서버 · 클라이언트 공용 원본)
export function sellPriceFrom(value: number, mul: number, qty: number): number    // floor
export function buyPriceFrom(value: number, baseMul, perRep, minMul, repLevel): number

// shared/meta.ts
export const sellPriceOf = (value, qty = 1) => sellPriceFrom(value, SELL_PRICE_MUL, qty);
```

`buyPriceOf` / `tableBuyPrice` 도 같은 중복이므로 같이 합친다 — **다만 구매는 `round` 를 유지한다**
(구매가를 내리면 가격이 조용히 싸진다). 바뀌는 값은 판매뿐이다.

### 영향 — 이것이 이 항목의 진짜 비용이다

| | 지금 | floor 뒤 |
|---|---|---|
| 가치 1 아이템 1개 | 1 C | **0 C** |
| 가치 1 × 80 (묶음) | 40 C | 40 C (불변) |
| 가치 3 아이템 1개 | 2 C | 1 C |
| 가치 3 × 25 (묶음) | 38 C | **37 C** |
| 짝수 value | 불변 | 불변 |

**거래대 UI 는 0 C 를 그대로 보여 주고 판매를 허용한다** (사용자 결정) — 무게를 비우는 수단이고, 묶어 팔면
제값이므로 플레이어가 스스로 배운다. `meta/ui/CorpView.ts` 는 이미 스택 전량으로만 담으므로(`:608`) 정상
경로에서는 0 C 가 거의 나오지 않는다.

`server/economy.gen.json` 은 **다시 굽지 않아도 된다** — 표에는 수식이 아니라 수치만 들어 있고 `sellPriceMul`
은 그대로다. 다만 `scripts/data-check.mjs` 의 경제 검산(`items/Salvage.checkSalvageEconomy`)이 판매가를 쓰는지
확인하고, 쓰면 그 기대값을 같이 갱신한다.

### 소유 검증은 하지 않는다

`Store.writeDocs`(`server/Store.ts:446`)가 `stash` · `loadout` 을 **키 · 크기 · rev 만 보고** 통째로 저장하는
불투명 blob 이라(`Store.ts:5-8` 헤더가 그렇게 선언한다) 서버에 판별 정보가 아예 없다. 막으려면 서버가 인벤토리 ·
루팅 권한을 가져야 하고 그것은 페이즈 규모다. **TODO E-9 행을 지우고 `참고 — 의도된 한계` 절에 한 줄로 남긴다.**

---

## 5. B-11 — 차단의 남은 틈

### (1) `…` 말풍선

`ui/hud/TypingBubbles.ts:56` 은 `PlayerFlags.TYPING` 하나만 보고 차단을 조회할 경로가 없다(import 는 `@/shared` 와
`../dom` 뿐). 필요한 조각은 전부 있다 — `ui/hud/ChatLog.ts:299` 의 `isBlockedPeer` 3 줄이 그대로 쓰인다:

```ts
const code = ctx.net?.getLobbyPlayer(id)?.code;          // RemotePlayerRef 에는 code 가 없다
return !!code && !!socialOf(ctx)?.isBlocked(code);       // ui/menus/social/socialSource.ts:28
```

배선 변경은 하나뿐이다 — `bind(ctx)` 가 ctx 를 보관하지 않으므로 `place()` 에 ctx(또는 미리 뽑은 `SocialRef`)를
넘긴다. 삽입 지점은 `:59` 직전, 기존 제외 조건(`!ref.avatar` · `!ref.connected` · `ref.stale` · `DROPPING|IN_POD`)과
같은 층이다.

**이름표(`Nameplates`) · 핑은 건드리지 않는다** — 분대원의 위치는 게임플레이 정보다. 채팅의 `ping`/`request` 줄을
일부러 남긴 `ChatLog.ts:72` 의 결정과 같은 선이다.

### (2) 로비 코드 직접 참가

`server/RelayServer.ts:888` `lobby:join` 에 차단 검사가 **한 줄도 없다** (`lobby:quickmatch` `:876` 도 같다).
필요한 것은 이미 그 클로저 안에 다 있다 — `store.isBlocked(ownerId, code)`(`server/Store.ts:752`)와
`lobby.players` 조합을 바로 위 `recordMet`(`:593`)이 이미 하고 있다.

`server/Invites.ts` 는 차단을 **검사하지 않는다** — 순수 장부이고 `hidden` 플래그를 릴레이가 주입하는 구조라
(`Invites.ts:25`, `RelayServer.ts:769`), 초대의 해법("숨겨서 `expired` 로")은 즉답이 필요한 join 에 옮길 수 없다.
재사용하는 것은 **`store.isBlocked` 한 함수**와 "거절하면 차단이 드러난다" 는 설계 원칙(`RelayServer.ts:1224` 주석)이다.

**방향별로 가른다** (사용자 결정):

| 상황 | 응답 | 이유 |
|---|---|---|
| 로비 멤버 중 **내가 차단한** 사람이 있다 | `lobby:error {code:'blocked'}` + 한국어 사유 | 내 선택의 결과이므로 정직하게 알린다 |
| 로비 멤버 중 **나를 차단한** 사람이 있다 | `lobby:error {code:'not_found'}` (위장) | 차단 사실이 드러나면 안 된다. 코드 오타와 구별되지 않는 것이 정확히 노림수다 |

검사는 `join` 이 실제로 성사되기 **전**에 한다(`lobbies.join` 호출 앞) — 실패가 로비 상태를 건드리면 안 된다.
`quickmatch` 는 거절 대신 **그 로비를 후보에서 건너뛴다**(공개 로비는 여러 개다).

**범위 밖**: 이미 같은 분대에 있는 사람을 나중에 차단해도 강퇴하지 않는다. 채팅 · 말풍선은 (1)로 숨겨진다.

### 계약 추가 (리드)

`shared/net.ts` 의 `LobbyErrorCode`(`:150`)에 `'blocked'` 를 **추가**한다. 한국어 문구는 서버가 `message` 로 함께
보내므로(`lobby:error {code, message}`) 계약에는 코드만 든다.

---

## 6. B-12 — 합류 알림 두 줄

### 확인된 사실

두 줄이 **같은 `net:peerJoined`** 에 반응하고, hub 쪽은 `ui:notify` 로 **같은 토스트 스택에 다시 들어간다**:

| | `ui/hud/Notifications.ts:83` | `hub/HubSystem.ts:307` |
|---|---|---|
| 게이트 | 없음 (레이드 · 훈련 중에도 뜬다) | `phase === 'hub' \| 'docking'` |
| 문구 | `<b>이름</b> 합류` + `'분대'` 라벨 + 3 초 | `이름 함선 합류` (볼드 불가 — `ui:notify` 가 전체 이스케이프) |

이탈도 대칭으로 두 줄이다 (`HubSystem.ts:308`) — TODO 에는 합류만 적혀 있다.

**연쇄 주의**: `Notifications.ts:158` 이 "`net:peerJoined` 의 합류 줄이 이미 뜬다" 를 근거로 초대 수락 토스트를
지웠다. 즉 `:83` 쪽을 지우면 **초대 수락 시 알림이 완전히 사라진다**.

### 변경

**`HubSystem.ts:307`(합류) · `:308`(이탈) 두 줄을 지운다.** 잃는 것은 `함선` 이라는 낱말 하나이고, 그 문맥은
`'분대'` 라벨과 "지금 함선에 있다" 는 상황이 이미 준다. `Notifications` 가 토스트의 단일 소유자가 된다.

`hub/README.md` 의 해당 줄과 `smoke-social` 의 관련 단언을 같이 갱신한다 (`ui/README.md:716` 이 이 겹침을 기록해
둔 자리이므로 거기도 정정).

---

## 7. 계약 (리드가 먼저 커밋한다)

| 파일 | 변경 |
|---|---|
| `data/constants.csv` | `EXPLODE_REQUEST_RANGE_SLACK` · `STATUS_REQUEST_RANGE_SLACK` · `STATUS_REQUEST_RATE_MAX` · `STATUS_REQUEST_BURST_S` **추가**, `HIT_REQUEST_DPS_MAX` 설명 정정 |
| `src/shared/net.ts` | `StratagemDenyReason` + `strat ev:'deny'` **추가**, `LobbyErrorCode` 에 `'blocked'` **추가**, `ExplodeRequest` · `HitRequest.st` 주석 정정 |
| `src/shared/credits.ts` | `sellPriceFrom`(floor) · `buyPriceFrom`(round) 순수 수식 **추가**, `tableSellPrice` · `tableBuyPrice` 가 그것을 부른다 |
| `src/shared/meta.ts` | `sellPriceOf` · `buyPriceOf` 가 위 순수 수식을 부른다 (값은 판매만 바뀐다) |

**이름 변경 · 삭제는 하나도 없다** — `src/shared` 는 추가만 하는 계약이다.

## 8. 폴더 소유 (병렬 에이전트 5)

| # | 폴더 | 항목 |
|---|---|---|
| ① | `src/enemies` | E-8 (a) explode 가드 · (b) st 가드 · 지뢰 `by` 크레딧 |
| ② | `src/stratagems` | E-8 (c) `deny` 와이어 · `refundCooldown` · 구조선 통일 |
| ③ | `src/meta` · `src/inventory` · `scripts/data-check` | E-9 floor 파급 · 거래대 0 C 표시 |
| ④ | `server` | B-11 (2) `lobby:join` · `quickmatch` 차단 |
| ⑤ | `src/ui` · `src/hub` | B-11 (1) 말풍선 · B-12 알림 한 줄 |

## 9. 검증

- `npm run typecheck` · `typecheck:server` · `npm run data:check` (csv 추가)
- `scripts/smoke-trust.mjs` (409 줄, `explode` · 상태이상 단언 **0 건**) 에 E-8 의 세 갈래를 얹는다:
  좌표 쓰레기 거절 · 먼 곳 폭발 거절 · 요율 초과 깎임 · 알 수 없는 상태 비트 무시 · 먼 곳 상태이상 거절 ·
  거절된 `stratq call` 이 `deny` 를 돌려주고 쿨타임이 환불된다
- `npm run net:selftest` 에 B-11 join 차단 (part 8 계열)
- `scripts/smoke-social.mjs` 에 말풍선 차단 + 합류 토스트 1 줄
- `npm run verify:all` (계약이 `src/shared` 를 여므로 전체)
