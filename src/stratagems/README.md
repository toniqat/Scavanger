# src/stratagems — 함선 호출 (ship calls / stratagems, Phase 3)

Owner system: `StratagemSystem` (`name: 'stratagems'`), publishes `ctx.stratagems` (`StratagemsRef`).
Registered in `src/main.ts` after `PickupSystem`, before `ExtractionSystem`.

| File | Role |
|---|---|
| `StratagemSystem.ts` | Input state machine (G tap / wheel, LMB charge → top view, ground ring), calls + shared cooldown, effects (laser / airstrike / supply crate / cover structures), destructible obstacles, net sync, cleanup, debug hooks |
| `model.ts` | 폴더 공용 어휘 — `StratagemSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `StratagemSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Targeting.ts` | **G 휠과 조준**. G 를 탭하면 바로, 홀드하면 4방향 휠에서 고른다. 고른 뒤에는 지면 링으로 조준하거나 좌클릭 3초 충전으로 **상단 시점**에 들어가 지면 커서를 놓는다. 우클릭 / Esc 로 취소. |
| `parts/Calls.ts` | **호출된 함선 지원이 실제로 하는 일**. 궤도 레이저(10초 지속 피해) · 항공 폭탄 · 보급품 상자(티어 5) · 파괴 가능 엄폐 구조물. 시각 효과는 전부 절차 생성이고 조명은 쓰지 않는다. |
| `parts/Wire.ts` | **`strat` / `stratq` 네트워크 경로**. 늦게 합류한 클라이언트는 진행 중인 호출 목록을 받아 재구성한다(`applySync`). 이미 떨어졌어야 할 호출은 조용히 **빨리감기**해서(`fastForward`) 장애물과 보급 상자가 바로 존재하게 한다. 쿨다운은 공유하지 않는다 — 개인 값이다. |
| `Visuals.ts` | Procedural visuals, **no lights, no assets**: `SharedGeo` (one geometry set per system), `TargetRing`, `CallMarker` (beacon + flashing ring), `Burst` (`THREE.Points` dust / sparks), `LaserBeam`, `Fireball`, `SupplyCrateMesh`, `BarricadeMesh`, `makeRubble` |
| `index.ts` | exports `StratagemSystem` |

## Input state machine (gameplay only: `isGameplayActive()`, pointer locked, alive, not downed)
```
idle ──G tap──▶ armed(last / first of STRATAGEM_ORDER) ──G tap · RMB──▶ idle
     ──G hold ≥ STRATAGEM_WHEEL_HOLD──▶ wheel (setLookLocked, 4 cardinal sectors N/E/S/W = STRATAGEM_ORDER,
                                          30 px drag) ──release──▶ armed(hover) | unchanged when no hover
armed(topview def: orbital_laser, airstrike)
     ──LMB held STRATAGEM_CHARGE_TIME (chargeChanged 0..1, −1 on early release)──▶ top view
top view: setControlsEnabled(false) + setLookLocked(true) + setCameraOverride(player + (0, TOPVIEW_HEIGHT, 0.001), lookAt player)
          cursor += mouse × TOPVIEW_CURSOR_SPEED (screen right = +X, screen up = −Z), clamped to TOPVIEW_RANGE and map bounds,
          y = getHeightAt ── fresh LMB press──▶ confirm · RMB / Esc (capture-phase, swallowed)──▶ back to armed
armed(ground def: supply_drop, structure_drop) = `targeting` true, ring on the aim ray (`getAimRay` → `world.raycast` ≤ GROUND_TARGET_RANGE,
          else clamped at range on the terrain) ──LMB──▶ confirm · RMB──▶ idle
confirm → Call {stage 'incoming', landsAt = time + def.delay} + shared cooldown (def.cooldown) + disarm
```
Arming while `cooldown > 0` is refused (`ui_deny`, `ui:notify "함선 호출 재충전 중 (n초)"`). The weapons system does not fire / aim while
`ctx.stratagems.armed` or `targeting` is set (wired by weapons). Targeting is cancelled (camera / controls restored, call kept) when
gameplay stops being active (blockers, pointer lock lost); the call is put away on `player:died`, `player:downed` and any non-gameplay phase.

## Effects (every client simulates from `stratagem:called`; remote calls arrive as `strat call` with `eta` + `seed`)
Enemy damage (`ctx.enemies.applyExplosion`) runs **only on the caller's client** (replicas forward to the host); each client damages
its **own** player (linear falloff) on every impact; `camera:shake` scales with distance (60 m reach).
- **orbital_laser**: at `landsAt` a 300 m additive beam (core + glow shell, rotating scorch ring, spark bursts) for `LASER_DURATION`;
  every 0.25 s `LASER_DPS × 0.25` inside `LASER_RADIUS`. `stage active` → `done`.
- **airstrike**: at `landsAt` `AIRSTRIKE_DAMAGE` in `AIRSTRIKE_RADIUS`, fireball + shockwave ring + dust, `stratagem:ended` after 2 s.
- **supply_drop**: crate (+chute) falls 120 m over `SUPPLY_FALL_TIME` onto the target; touchdown = `SUPPLY_IMPACT_DAMAGE` in
  `SUPPLY_IMPACT_RADIUS`, obstacle r 0.8, `Interactable` `supply:<callId>` (2.4 m, `보급 상자 열기`) → `crate:open {crateId, tier: SUPPLY_CRATE_TIER, position}`
  (the inventory rolls the loot); `crate:looted` → dimmed strips + `stratagem:ended`.
- **structure_drop**: `STRUCTURE_COUNT` barricades placed from the call `seed` (`Random`) within `STRUCTURE_SCATTER`, ≥ 2.4 m apart,
  terrain height each; fall 60 m over `STRUCTURE_FALL_TIME` staggered 0.15 s; each landing = `STRUCTURE_IMPACT_DAMAGE` in
  `STRUCTURE_IMPACT_RADIUS` + `world.addObstacle({radius 1.35, height 1.5, destructible})`. `DestructibleRef.onDamage` (weapons) and
  `grenade:exploded` (250 centre damage, linear falloff) → `structure:damaged` (crack overlay darkens) → hp 0: `structure:destroyed`,
  obstacle remover called, mesh replaced by rubble. `stratagem:ended` when all blocks have landed (destruction is separate).

## Events
Emits `stratagem:wheelChanged`, `stratagem:armed`, `stratagem:chargeChanged`, `stratagem:targeting` (on entry + cursor moves > 0.2 m + exit),
`stratagem:called`, `stratagem:landed`, `stratagem:ended`, `stratagem:cooldown` (start / every 0.5 s / 0), `structure:damaged`,
`structure:destroyed`, `crate:open`, `camera:shake`, `audio:play` (`ui_equip` arm, `ui_open` wheel / top view, `ui_click` hover / confirm,
`ui_deny`, `hellpod_fall` 2.5 s before landing, `explosion` impacts), `ui:notify`.
Listens: `game:abort`, `game:newMission`, `hub:entered`, `world:cleared` (full cleanup), `player:died`, `player:downed`, `game:phaseChanged`,
`crate:looted`, `grenade:exploded`.

## Net (`StratagemMessage`, `src/shared/net.ts`)
- `{t:'strat', ev:'call', callId, kind, p, eta, seed}` → others on confirm; receivers create the call with `landsAt = time + eta`, `local = false`.
- `{t:'strat', ev:'structHp', callId, index, hp}` → others whenever a structure takes damage locally; receivers apply lower hp only.
- **Late-join sync (Phase 9)**: `{t:'stratq', ev:'sync'}` → host on `world:ready` from every non-host client; the **host** answers
  `{t:'strat', ev:'sync', calls: StratagemCallWire[]}` to that peer alone, and does the same for a `flow rejoined`. The host is only the
  *sync authority* — calls stay client-simulated. `syncWire()` lists every live call as
  `{callId, kind, p, seed, eta: landsAt − ctx.time, caller, looted?, st?}` where `st` holds `[index, hp]` for damaged / destroyed structures
  only (a finished laser / airstrike and a fully destroyed structure drop are skipped). `applySync` ignores ids it already knows, creates
  the rest with `createCall(..., local:false)` and, when `eta ≤ 0`, **fast-forwards** the back-dated call through one silent update step
  (`silent` suppresses impact damage, bursts, shake and audio) so its obstacles / supply interactable exist immediately. For such an
  already-landed call the **whole** wire entry — fast-forward, `st` application (a block that is already rubble is destroyed without its
  demolition shake / dust / bang) and the `looted` close — runs inside that same silent window; state events (`stratagem:landed`,
  `structure:damaged / destroyed`, `stratagem:ended`) are still emitted, only the felt FX are dropped. Cooldowns are personal and never synced.
Call ids are `${net.localId ?? 'sp'}-${n}`; structure ids `${callId}:${index}`; supply interactables `supply:${callId}`.

## Tuning
All numbers live in `src/shared/constants.ts` (`STRATAGEM_DEFS`, `STRATAGEM_WHEEL_HOLD`, `STRATAGEM_CHARGE_TIME`, `TOPVIEW_*`,
`GROUND_TARGET_RANGE`, `LASER_*`, `AIRSTRIKE_*`, `SUPPLY_*`, `STRUCTURE_*`). Local: wheel drag 30 px, laser tick 0.25 s, airstrike FX 2 s,
drop heights 120 / 60 m, structure stagger 0.15 s / min gap 2.4 m, grenade-vs-structure 250, shake reach 60 m (top of `StratagemSystem.ts`).

## Debug
`window.__game.getSystem('stratagems')`: `armed`, `targeting`, `cooldown`, `cooldownTotal`, `getCalls()`, `structureCount`,
`debugCall(kind, position)` (no input / cooldown), `debugCooldownReset()`. Smoke: `node scripts/smoke-stratagems.mjs` (needs `npm run dev`;
registers the system at runtime if `main.ts` has not).

## Limitations
- Structure hp is per-client except for the `structHp` sync (no host authority; simultaneous hits can disagree briefly). The Phase 9
  `strat sync` closes the *late-join* gap (a joiner now sees live calls, their obstacles and the damaged structure hp) but a synced call
  that already landed shows no impact FX and dealt no damage here by design.
- Supply crate contents are rolled per client by the inventory (`crate:open` is local); no lifetime / expiry for a landed crate.
- Remote calls take the terrain height on the receiving client; the caller's y is ignored.
- Launch / landing audio reuses existing ids; no dedicated stratagem SFX. Wheel / charge / top-view HUD is drawn by `src/ui` from the events.
- Top-view cursor axes assume the camera override looks straight down with screen up = −Z (verified by the smoke: +X mouse → +X world, +Y mouse → +Z world).

## Pause behaviour (lead fix, 2026-09-06)
`landsAt` / structure `landAt` are `ctx.time` stamps (unscaled clock, so the HUD can compute ETAs). `updateCalls` tracks the wall time between
updates and, whenever it is called with `dt === 0` (single-player pause), pushes every pending stamp forward by that amount — a call never
lands, ticks or ends while the game is frozen. (`ctx.timeScale ≠ 1` is debug-only and not compensated.)


## 2026-09-08 — 상단 시점 취소는 RMB

The top view's capture-phase Escape listener (and `escRequested`) is **removed**. It could never fire in practice:
while the pointer is locked the browser eats Escape to free the cursor, so the key never reached the page. That
unlock is now the 일시정지 메뉴, whose `'menu'` blocker fails `baseActive()` and cancels the targeting through the
existing path. **RMB** is the cancel that works while aiming, and the HUD hints say so (`좌클 확정 · 우클 취소`).

## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`StratagemSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `StratagemSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: StratagemSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `StratagemSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 9** — **late-join sync** — a non-host asks `stratq sync` on `world:ready` and the host answers `strat sync {calls}` (also unprompted on `flow rejoined`) with every live call: relative `eta` (≤ 0 fast-forwards the landing so obstacles / the supply crate exist at once), damaged structures only, `looted`; the cooldown stays personal
