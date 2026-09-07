# Phase 10 계획서 — UI 개선 (2026-09-07)

사용자가 요청한 13개 UI/게임플레이 개선 항목을 구현하는 페이즈. Phase 7 · 9 와 같은 방식:
`src/shared` 계약은 **이미 작성·커밋되어 있다** (`constants / types / net / events / implants / meta / labels /
Keybinds / Input` 의 `appended (Phase 10)` 구역 + 새 파일 `cursor.ts` + `src/shared/README.md` 마지막 절).
각 에이전트는 **자기 폴더만 소유**하고 계약은 읽기만 한다 (append 가 꼭 필요하면 리드에게 보고).
`/* Phase 10 skeleton */` 표시는 typecheck 를 통과시키기 위한 자리이며 **구현으로 교체**한다.

`CLAUDE.md` 를 먼저 읽고, 자기 폴더의 `README.md` 를 읽은 뒤 작업한다. 끝나면 둘 다 갱신한다.
**다른 폴더의 파일은 절대 편집하지 않는다.** 병렬 실행 중에는 vite full-reload 가 스모크를 죽이므로
`npx vite --port 5299` 같은 개인 인스턴스를 쓰거나 조용한 창에서 돌린다.

## 0. 사용자 결정 (AskUserQuestion, 2026-09-07)

| 항목 | 결정 |
|---|---|
| 레퍼런스 이미지 | `helldivers.jpg` 는 세션에 없다 → 설명대로 구현하고 나중에 조정 |
| 인게임 커서 | **포인터 락 유지 + 가상 커서**. 락을 풀지 않고 `movementX/Y` 로 가상 좌표를 움직인 뒤 그 지점에 합성 `PointerEvent` 를 디스패치한다 (`shared/cursor.ts`). Esc 일시정지 메뉴만 예외 |
| 캐릭터 모델 | **전면 교체**. 스플래툰식 3등신, 갑옷 플레이트 · 헬멧 · 망토 제거, 포즈 · 소켓 · 무기 부착 위치 전부 재조정 |
| F 키 | **E 홀드 구조는 그대로**. F 짧은 탭만 들쳐메기로 (`KEY_ALIASES.CARRY = 'MELEE'`, 사거리 안에 전투불능 아군이 있을 때만 근접공격을 선점) |
| 시체 루팅 확률 | **티어별 차등**: 잡버그(scavenger / toxic / hunter) 10 % · 상위 버그(spewer / warrior / artillery / charger) 35 % · behemoth · rogue · rogue_boss 100 % |
| 회복약 | **기존 아이템 이름만 변경**. `stim` def id / `ItemCategory 'stim'` / `applyStim` 유지, 표시 라벨만 회복약, 좌클릭 2초 홀드로 사용 |
| 배리어 | **`mode: 'wielded'` 방패**. 들면 총이 홀스터되고(`blocksWeapons`) Q 로 집어넣는다 — 대전차포와 같은 흐름 |
| 진행 방식 | shared 계약 선작성 → 폴더별 병렬 에이전트 → `npm run verify:all` |

## 1. 계약 요약 (읽기 전용)

전체는 `src/shared/README.md` 의 **Phase 10 UI 개선 pass** 절. 요점:

- **`cursor.ts` (신규)**: `SoftCursor`, `SOFT_CURSOR_FLAG`, `isSoftCursorEvent`.
  `Input` 에 `cursor` / `isCursorMode` / `cursorX·Y` / `setCursorMode(active, owner)` (블로커 토큰 기준 **ref-count**) /
  `setCursorPosition` / `uiX·uiY` / `elementUnderCursor()`.
- **`constants.ts`**: `IMPLANT_BARRIER_CARRY_*` · `IMPLANT_BARRIER_BLOCK_DAMAGE` · `DEATH_FALL_TIME` ·
  `CORPSE_FALL_MAX_SPEED` · `CORPSE_LAND_TIMEOUT` · `CONTAINER_TAKE_*` · `INTERACT_PILLAR_*` · `SCAN_PILLAR_HEIGHT` ·
  `PICKUP_PILLAR_*` · `PLAYER_CARRY_*` · `HEAL_HOLD_S` · `HUB_READY_*` · `CREW_*` · `SOFT_CURSOR_*` ·
  `KeyBindings.CARRY` / `DEFAULT_KEYS.CARRY`.
- **`types.ts`**: `EnemyDeathDir` / `ENEMY_DEATH_DIRS` / `CORPSE_LOOT_CHANCE` · `EnemyRef.deathDir? / lootable?` ·
  `CarryEndReason` · `PlayerRef.carrying / isCarried / carry / dropCarried / setCarriedBy / createPortraits` ·
  `PlayerWeaponHost.getShoulderSocket?` · `PortraitRef` · `CrewLoadoutViewOptions` ·
  `InventoryRef.captureCrewLoadout / createCrewLoadoutView`.
- **`net.ts`**: `PlayerFlags.CARRYING` (1 << 26) / `CARRIED` (1 << 27) · `PlayerSnapshot.cr? / bhp?` ·
  `RemoteAvatarRef.shoulderSocket?` · `RemotePlayerRef.carrying? / isCarried? / carriedBy? / isBarrierUp? /
  barrierHp? / crewLevel? / equippedImplant?` · `CarryMessage` · `CrewCardWire` / `CrewMessage` / `CrewRequest` ·
  `NetRef.getCrewCard / requestCrewLoadout` · `imp shield` · `cont taken.rem? / seq?` · `ee kill.dd?` ·
  `ee corpse.dd? / lt?`.
- **`events.ts`**: `weapon:reloadCancelled` · `heal:holdChanged` · `ping:requestAt` · `input:cursorModeChanged` ·
  `container:itemTaken` · `player:carryStarted / carryEnded` · `net:remoteCarryChanged` · `net:crewCard /
  crewLoadout` · `hub:readyPanelToggled / crewLoadoutToggled` · `implant:barrierCarried` ·
  `enemy:killed.deathDir?` · `corpse:spawned.lootable? / deathDir?`.
- **`meta.ts`**: `CREDIT_SUFFIX` · `formatCredits` · `formatCreditAmount` · `itemCreditValue`.
- **`implants.ts`**: `ImplantsRef.barrierCarried` / `getBarrierPose`.
- **`labels.ts`**: `stim` 카테고리 라벨 = 회복약. **`Keybinds.ts`**: `STIM` 액션 삭제, `CARRY: 'MELEE'` 별칭,
  `MELEE` / `QUICK` 라벨 갱신.

## 2. 전 폴더 공통 규칙 — 인게임 커서 이관

**이것이 이번 페이즈에서 가장 넓게 퍼지는 변경이다.** 커서를 쓰는 화면은 지금 전부 이렇게 되어 있다:

```ts
ctx.uiBlockers.add(TOKEN);
ctx.input.exitPointerLock();
...
ctx.uiBlockers.delete(TOKEN);
queueMicrotask(() => { if (ctx.uiBlockers.size === 0) ctx.input.requestPointerLock(); });
```

이를 다음으로 바꾼다:

```ts
ctx.uiBlockers.add(TOKEN);
ctx.input.setCursorMode(true, TOKEN);     // 락은 유지한다 — exitPointerLock 을 호출하지 않는다
...
ctx.uiBlockers.delete(TOKEN);
ctx.input.setCursorMode(false, TOKEN);    // relock microtask 는 삭제
```

- `setCursorMode` 는 **토큰 기준 ref-count** 다. 인벤토리 위에 팝업이 겹쳐도 팝업이 닫힐 때 커서를 빼앗기지 않는다.
- **`ui/menus/MenuBase` (`'menu'` 토큰) 는 지금 코드 그대로 둔다.** Esc 일시정지 메뉴는 락이 이미 없는 상태
  (alt-tab, Chrome 이 거부한 재락)에서도 반드시 동작해야 하는 유일한 화면이다.
- Chrome 은 **Esc 에서 항상 락을 해제**하고 헤드리스 스모크는 `requestPointerLock` 을 스텁으로 막아 둔다.
  그래서 `SoftCursor` 는 락이 없으면 합성하지 않고 실제 커서를 **미러링**만 한다 (`mirror`). 즉 커서 모드는
  락이 있으나 없으나 동작하며, 락이 없을 때는 예전과 똑같이 네이티브 이벤트가 UI 를 움직인다. 이 폴백에 의존해서
  스모크는 수정 없이 통과해야 한다.
- `input.mouseX / mouseY` 를 **직접 폴링**하는 코드는 `input.uiX / uiY` 로 바꾼다 (`hub/HousingMode.pointerOverUI`,
  `raycastCursor`, 그리고 `document.elementFromPoint` 를 쓰는 곳은 `input.elementUnderCursor()` 로).
- DOM 핸들러(`click` / `pointerdown` / `contextmenu` / `wheel` / hover)는 **하나도 바꾸지 않는다** — 합성 이벤트가
  실제 버블링 이벤트라서 그대로 도달한다.

## 3. 폴더별 작업

### 3-1. `src/player/` — 캐릭터 모델 전면 교체 · 들쳐메기 · 초상화 (가장 큰 레인)

**(A) 스플래툰식 3등신 모델** — `SoldierModel.ts` 재작성.
- **전체 키는 그대로 1.8 m 로 둔다** (`PLAYER_HEIGHT` / `PLAYER_RADIUS` 는 shared 이고 enemies · weapons · gadgets ·
  world 가 다 읽는다). 3등신은 *키 ÷ 머리 = 3* 이라는 뜻이므로 **머리를 크게** 만들어서 달성한다: 머리 지름
  ≈ 0.6 m, 몸통·팔·다리를 그만큼 짧게. 히트박스 · 카메라 아이 높이(`EYE_STAND 1.55` 등) · `enemies/Targets.ts` 의
  아이 높이 복제본은 **건드리지 않는다**.
- 제거: 헬멧(`:177-182`) · 어깨 패드 · 등짐 · 캐니스터 · 흉부 강판 · 액센트 스트라이프(`:152-171`) · 망토 4 세그먼트
  (`:196-214`) 와 `SoldierPose` 의 망토 구동(`:683-692`), `poseDead` 의 망토 항. 평범한 옷: 큰 머리(눈 두 개 정도의
  단순한 얼굴), 짧은 소매 상의, 반바지/바지, 신발. 절차적 지오메트리만 (외부 애셋 금지).
- `plateMats` 는 **비우지 않는다** — `setGlow`(오버차지 림) 이 그 배열을 구동한다. 옷 재질 중 하나를 넣어 둘 것.
- 실루엣 패스(`:216-241`)는 생성자에서 한 번 훑으므로 파트를 자유롭게 바꿔도 된다. 단 **생성자 이후에 추가되는
  메시는 실루엣이 없다** (`setArmor` 의 방탄복 플레이트가 그 경우). 새 `shoulderSocket` 의 자식도 마찬가지라
  `syncSocketRenderOrder()` 를 두 소켓 모두 훑도록 확장한다.
- 재조정 필수 목록: `weaponSocket.position (0, -0.3, -0.02)` (팔뚝 길이가 바뀌면 같은 양만큼 이동; 장갑이 y −0.29
  에 있다), `weaponSocket.rotation (-PI/2, 0, 0)` **유지** (무기 −Z = 총구 전방 규약, `shared/net.ts` ·
  `shared/types.ts` · `weapons/README.md` 가 명시), `resetPose()` 의 소켓 회전 재설정, ADS 팔 목표
  (`aimRUx = PI/2 + pitchArm`, `aimLUx/aimLUz/aimLL`) 와 `hi` / `th` / `ck` 목표 — 짧은 팔로는 같은 라디안으로
  "총이 눈 앞" 자세가 안 나온다. 몸 높이 리터럴 `hipsBaseY 0.98` · `lieHipY 0.27` · `ROLL_PIVOT_Y 0.55` ·
  구르기 골반 0.5 · 사망 골반 0.55.
- `RemoteAvatar.ts` 의 `HEAD_STAND 1.7 / HEAD_CROUCH 1.3 / HEAD_PRONE 0.5` (네임플레이트 앵커) 와
  `DOWN_MARKER_Y 0.95` 를 새 머리 위치에 맞춘다.
- `GearLook.buildArmorPlate` 의 torso-local 리터럴(흉부 0.44 × 0.5 × 0.28, 어깨 y 0.52 기준)을 새 몸통에 맞게
  재스케일한다. **방탄복은 계속 표시한다** — 그건 장착 아이템이고, 제거 대상은 병사에 내장돼 있던 장식 강판이다.
- `buildHeldItem` 의 절대 크기(스팀 r 0.028 / 수류탄 r 0.055 / 가젯 0.08 × 0.05 × 0.13)는 큰 손에 맞게 키운다.

**(B) 부상자 들쳐메기.**
- `SoldierModel`: 새 `readonly shoulderSocket` (오른 어깨) + `SoldierPose.carry?: number` (오른팔을 어깨 위로,
  왼팔 자유, 상체 약간 전방 기울임, ADS 없음). `PlayerSystem` 과 `RemoteAvatar` 의 포즈 리터럴 양쪽에 필드 추가
  (`SoldierPose` 필수 멤버는 둘 다 채워야 한다).
- `PlayerSystem`: `carry(id)` / `dropCarried(reason?)` / `carrying` / `isCarried` / `setCarriedBy(socket)` 구현.
  - `carry`: `PLAYER_CARRY_RANGE` 안, 대상이 `isDowned && !isDead`, 자신은 정상, 이미 안 들고 있을 때만.
    `PLAYER_CARRY_PICKUP_S` 동안 컨트롤 잠금 → `player:carryStarted` + `carry pick` 전송 + 총 홀스터
    (`ctx.weapons` 는 스냅샷 `HAS_WEAPON` 이 꺼지는 것으로 따라온다; `Snapshotter` 는 net 레인이 담당).
  - 이동만 허용: `PLAYER_CARRY_SPEED_MUL`. **달리기 외의 모든 행동**(사격 · 근접 · 무기 교체 · 임플란트 · 투척 ·
    빠른 사용 · 자세 변경 · 구르기 · 상호작용 · 채집)은 먼저 `dropCarried('action')` 을 호출하고 **다음 프레임에
    자기 동작을 재시도**한다. 이 게이트는 `PlayerRef.carrying !== null` 을 보고 각 폴더가 자기 입력 경로에서
    호출한다 (weapons · implants · gadgets 레인 참고).
  - 들고 있는 쪽(`isCarried`)은 `attachTo` 선례를 그대로 쓴다: `ExtractionSystem` 의 `player.attachTo(ship.root)`
    (`PlayerSystem.attachTo` + `update` 의 `attachedParent` 라이드 루프)가 정확히 같은 모양이다.
  - 종료 조건: 수동 F 탭 · 행동 · 피해 아님(`HEAL_HOLD_CANCEL_ON_DAMAGE` 와 무관, 피해로는 안 떨어뜨린다) ·
    소생 완료 · 사망 · 리셋 → `player:carryEnded` + `carry drop {p}`.
- `RemotePlayerSystem` / `RemoteAvatar`: `ref.isCarried` 인 동안 `root.position.copy(ref.position)` (`:162`) 와
  `root.quaternion` (`:319`) 쓰기를 **건너뛰고** 운반자의 `shoulderSocket` 에 부모로 붙인다. `syncRevive` 의
  `Interactable.position` 은 `ref.position` 을 가리키므로 **소켓 월드 좌표를 따라가게** 고친다 (안 그러면 들쳐멘
  아군을 E 로 소생할 수 없다).
- **F 탭 선점**: `PLAYER_CARRY_RANGE` 안에 들쳐멜 수 있는 전투불능 아군이 있으면 `PlayerSystem` 이 F 탭을 처리하고
  `ctx.input.consume(Keys.MELEE)` 로 소비한다 → `weapons` 는 근접공격을 보지 못한다. 프롬프트도 표시
  (`interact:promptChanged` 는 E 전용이므로 별도 힌트는 ui 레인).

**(C) 준비 패널 초상화** — `createPortraits(host, cells)`.
- 새 파일 `player/Portraits.ts`: 자체 `THREE.WebGLRenderer` + 작은 `Scene` + `PerspectiveCamera` +
  `DirectionalLight` 2개 + `HemisphereLight`, `SoldierModel` 인스턴스 `cells` 개, 셀당
  `setViewport` / `setScissor` + `setScissorTest(true)` 로 한 번씩 그린다. **컨텍스트는 하나만** 만든다.
  지오메트리 · 재질을 메인 렌더러의 아바타와 **공유하지 않는다** (두 번째 GL 컨텍스트가 재업로드하고 dispose 가
  엉킨다). `visible` 이 false 면 `render` 는 즉시 반환. WebGL 을 못 얻으면 `null`.
- 몸 방향은 `root.rotation.y = HUB_READY_PORTRAIT_YAW` (모델 정면이 −Z 이므로 카메라 우측 사선).
- 실루엣 패스는 끈 상태로 둔다.

**(D) 회복약**: `applyStim` 은 그대로. `player:stimUsed` 도 그대로.

**검증**: `npm run verify --folders player` (smoke-phase2 · phase4 · tactical · controls-hub · console · uniques ·
ghost · raidflow). 모델 비율이 바뀌면 `--shots` 로 PNG 를 남겨 눈으로 확인한다.

### 3-2. `src/implants/` — 배리어 = 들고 다니는 방패

- `ImplantDefs.ts`: `barrier` 의 `mode` 를 `'wielded'` 로, 설명문을 방패로 (`'앞을 막는 에너지 방패를 든다.
  적의 발사체만 막고, 들지 않은 동안 내구도가 회복된다. 파괴되면 10초간 재충전한다.'`), `icon` 유지.
- `ImplantSystem.activate()`: `case 'barrier'` 를 `this.wieldedFlag ? this.stow() : this.wield()` 로 (대전차포와
  동일 분기). `toggleBarrier` / `dropBarrier` / `BARRIER_OFFSET` 의 지면 스냅 로직은 삭제하고, `wield()` /
  `stow()` 에서 `barrier.raise()` / `barrier.lower()` 를 호출한다. 재충전 잠금(`barrierLocked`,
  `IMPLANT_BARRIER_BREAK_LOCKOUT`)과 `tickCooldown` 의 해제 경로는 유지 — 잠긴 동안에는 `wield()` 를 거부하고
  `배리어 재충전 중` 을 띄운다.
- `effects/Barrier.ts`: `BarrierField` 를 **추종형**으로. `deploy(position, yaw)` 1회 언폴드 대신
  `raise()` / `lower()` + 매 프레임 `follow(feetPos, yaw)`. 패널 크기는 `IMPLANT_BARRIER_CARRY_WIDTH/HEIGHT`,
  월드 위치는 `feet + forward * IMPLANT_BARRIER_CARRY_OFFSET`, 패널 밑단은 `feet.y + IMPLANT_BARRIER_CARRY_BASE_Y`
  (`intersect` 가 `position.y` 부터 dy 를 재므로 `position.y` 에 그 값을 넣는다). `intersect` 에
  `IMPLANT_BARRIER_CARRY_ARC` 정면 각도 게이트를 추가한다 (뒤에서 온 탄은 통과 — 지금은 양면이다).
  헥스 텍스처는 프로세스 싱글턴이고 `repeat` 가 옛 치수로 구워져 있으니 **새 치수로 굽거나 재질별 repeat** 를 쓴다.
  `regen` 은 `active` 면 즉시 반환하던 규칙을 바꿔 **든 상태에서도** `IMPLANT_BARRIER_CARRY_REGEN_DELAY` 무피격 후
  `IMPLANT_BARRIER_CARRY_REGEN` 으로 회복하고, 내린 상태에서는 기존 `IMPLANT_BARRIER_REGEN` 을 쓴다.
- `devices/ImplantDevice.ts`: `barrier` 분기를 **추가**한다. 지금은 `default: buildScanner` 라서
  `new ImplantDevice('barrier')` 가 조용히 스캐너 접시를 그린다. 왼팔에 잡은 방패 손잡이 + 프레임 (실제 막는 패널은
  `BarrierField` 가 그린다 — 장치 모델은 손에 든 그립만).
- `RemoteImplants.ts`: 손 장치 복제는 `mode === 'wielded'` 판정으로 **공짜로 따라온다**. `case 'barrier'` 를
  `case 'shield'` 로 옮기고, 피어의 `BarrierField` 를 매 프레임 `ref.position` / `ref.yaw` 로 `follow` 시킨다
  (`update` 의 `v.barrier.update(dt)` 자리). 늦은 합류: `flow rejoined` 에 `imp shield {up, hp}` 재전송.
- `BARRIER_BLOCK_DAMAGE` 모듈 상수를 `IMPLANT_BARRIER_BLOCK_DAMAGE` 로 교체. `barrierCarried` /
  `getBarrierPose(out)` 구현 (스켈레톤 교체). `barrierActive` 의 의미는 "손에 들려 있음".
- 들쳐메기 게이트: `carrying !== null` 이면 Q 는 먼저 `ctx.player.dropCarried('action')`.
- `raycastBarrier` / `damageBarrier` 시그니처는 **바꾸지 않는다**.

**검증**: `npm run verify --folders implants`. `scripts/smoke-tactical.mjs` (`:317-355`) ·
`smoke-weapons.mjs` (`:299-349`) · `smoke-enemy-delta.mjs` (`:336-384`) 는 **정적 패널을 가정**하고
`imp.activate()` 후 고정 원점에서 고정 전방 레이를 쏘고 `b.position` 을 읽는다 → 방패 기준으로 갱신해야 한다
(스모크 스크립트는 shared 가 아니라 이 레인이 고친다).

### 3-3. `src/enemies/` + `src/items/` — 사망 낙하 · 방향 다각화 · 확률 루팅

**(A) 공중 사망 낙하 (버그 리포트)** — 원인은 3단 결합이다:
`Enemy.kill()` 이 `airborne = false; leaping = false` 로 지워서 도약 적분이 멈추고, `ai/EnemyAI.ts:54` 가
`state === 'dead'` 를 early-return 해서 `integrate()` 의 지면 스냅에 도달하지 못하고, `EnemySystem.onEnemyKilled`
가 **공중 좌표로** 시체 인터랙터블을 등록한다 (`GameContext.findBest` 는 3D 거리라 그 시체는 루팅도 불가).
- 수정: 죽은 몸에 자기 중력 적분을 준다. `Enemy` 에 `deathVy` / `deathLanded` 를 두고 `EnemyAI.ts:54` 와
  `net/Replica.ts:421` 양쪽에서 `state === 'dead' && !deathLanded` 이면 `deathVy -= GRAVITY * dt`
  (`CORPSE_FALL_MAX_SPEED` 로 클램프), `position.y += deathVy * dt`, `world.getHeightAt` 이하로 내려가면 스냅 +
  `deathLanded = true`. `kill()` 은 `airborne` 을 지우기 **전에** 현재 `vy` 를 `deathVy` 로 넘긴다.
- 시체 · FX: `onEnemyKilled` 의 `fx.burst` / `fx.splat` 은 그 자리에서 터져도 되지만, `corpses.add(...)` 는
  **착지 후**로 미룬다 (또는 등록하고 `Corpse.position` 을 착지 시 갱신 — `Corpse.position.copy` 는 값 복사라
  몸을 따라가지 않는다). `CORPSE_LAND_TIMEOUT` 이 지나면 강제로 등록한다.
- 리플리카는 죽은 몸에 `drive()` 를 호출하지 않고(`Replica.ts:421`), 시체는 사망 1.5 s 후 스냅샷에서 빠지므로
  (`net/HostSync.ts` `CORPSE_SNAPSHOT_SECONDS`) **리플리카가 자기 낙하를 돌려야** 한다. 위의 적분을 양쪽에 둔 이유.

**(B) 사망 방향 다각화.**
- 지금 `BugAnim.rollSign` 은 **스폰 시** 시드 없는 `Math.random()` 으로 정해지고 사망 때 다시 뽑지 않아 호스트와
  리플리카가 이미 다르다. `Enemy` 에 `deathDir: EnemyDeathDir` 를 두고 사망 시
  `new Random(((worldSeed ^ (id * 0x85ebca6b)) >>> 0) || 1)` 같은 **독립 시드 스트림**에서 뽑아 세 방향을 균등하게
  고른다. 호스트는 `ee kill.dd` / `ee corpse.dd` 로 보내고 리플리카는 그것을 우선한다(없으면 자기 시드로 계산).
- `models/BugModel.animateBug` (`:463-474`): 지금 `roll ± / pitch += 0.25` 두 변형뿐이다.
  좌 / 우 / **뒤로 넘어감**(pitch 를 크게, roll 은 거의 0) 세 갈래로 나누고 `DEATH_FALL_TIME` 으로 블렌드한다.
  `curl` 다리 접힘 · `sink` 는 유지.
- `models/RogueModel.animateRogue` (`:279-284`): 지금 `rollSign > 0` = 뒤, `< 0` = 오른쪽뿐이고 **왼쪽이 없다**.
  좌 / 우 / 뒤 세 갈래로 만든다.
- 패턴은 `incinerated` 전소 writhe 를 그대로 따라간다 (`Enemy.incinerate` → `incapTimer` → `animate` 블렌드 →
  `animateBug` / `animateRogue` 분기 → 와이어 미러링).

**(C) 확률 루팅.**
- `Corpses.ts`: `Corpse` 에 `lootable` 을 두고 **독립 시드 스트림**
  `new Random(((seed ^ (enemyId * 0x9e3779b1)) >>> 0) || 1).chance(CORPSE_LOOT_CHANCE[type])` 으로 결정한다.
  **기존 `rng` 에서 먼저 뽑으면 안 된다** — `src/inventory/__selftest__.ts:131-142` 가 `warrior` / `rogue` /
  `rogue_boss` 의 정확한 `rollCorpse` 결과를 시드 5 / 11 / 3 으로 단정하고 있어 스트림이 밀리면 깨진다.
- `lootable` 이 false 면 인터랙터블을 **등록하지 않는다** (`CorpseManager.add` 가 null 반환). 시체 메시(=적 몸)는
  그대로 남아 자연스럽다. `corpse:spawned {lootable}` 로 알린다.
- 호스트는 `ee corpse.lt` 로 실어 보내고, 받는 쪽은 그 값을 우선한다 (동일 시드라 어차피 같지만 권위를 맞춘다).
- `items/`: `CORPSE_TABLES` · `rollCorpse` 는 **바꾸지 않는다**. 이 항목에 items 변경은 없고, 확률 표는 shared 다.
  `items/README.md` 에 "시체 루팅 가능 여부는 `CORPSE_LOOT_CHANCE` (shared) 가 결정하고 `rollCorpse` 는 그 이후에만
  호출된다" 한 줄만 추가한다.

**검증**: `npm run verify --folders enemies,items` (smoke-phase4 · tactical · uniques · rogue-v2 · enemy-delta ·
weapons · inventory-p6 · library). 공중 사망 → 착지 → 루팅 가능 검사를 `smoke-rogue-v2.mjs` 나
`smoke-phase4.mjs` 에 추가한다 (hunter 를 도약 중에 죽이고 `y` 가 지면으로 수렴하는지).

### 3-4. `src/ui/` — 크로스헤어 재장전 · 지도 핑 · 툴팁 크레딧 바 · 소프트 커서 스프라이트 · 빛기둥 · 회복 게이지

**(A) 재장전 게이지를 크로스헤어로.**
- `hud/WeaponPanel.ts` 에서 `.arc` SVG(`:84-93`) · `reloadTotal` / `reloadLeft` / `circ` · `update(dt)` 의 링 구동 ·
  `endReload()` 를 제거한다. `.reloading` 텍스트 필은 남길지 판단(재장전 중임을 알리는 값은 게이지가 대신하므로
  제거 권장).
- 새 `hud/ReloadGauge.ts`: `hud/ChargeGauge.ts` 와 같은 **크로스헤어 중심 풀서클** (`SIZE 120` / `RADIUS 48`,
  `svg { transform: rotate(-90deg) }` 로 12시 시작, `.reload` 클래스, `styles/base.css` 의 `.charge` 규칙을 참고).
  `weapon:reloadStarted {duration}` → 표시 + 자체 카운트다운, `weapon:reloadFinished` → 숨김,
  **`weapon:reloadCancelled` → 숨김** (신규 이벤트; 없으면 근접/교체 취소 후 링이 계속 찬다),
  `player:died` / `player:downed` / `game:newMission` / `game:abort` → 숨김.
- `HudSystem`: 생성 · `bind` · `dispose` 등록 + gameplay-active 가드 안에서 `update(dt)` 호출
  (`this.weapon.update(dt)` 옆).

**(B) 회복약 홀드 게이지.**
- 새 `hud/HealGauge.ts`: `hud/CookGauge.ts` 를 복사해 `heal:holdChanged {holding, t}` 를 구독하는 크로스헤어
  게이지. 요청대로 **풀서클**로 만든다 (`CookGauge` 는 120° 우측 아크; 360° 단일 SVG 아크는 퇴화하므로 두 세그먼트
  또는 `circle` + `strokeDasharray` 로).
- `hud/WeaponPanel.ts` 의 `CONSUMABLE_HINT.stim` 을 `'좌클릭 2초 홀드'` 로.
- `hud/Vitals.ts:83` 의 하드코딩된 `'H 스팀 · T 빠른 사용'` 을 `` `${keyLabel(Keys.QUICK)} 빠른 사용` `` 로 바꾸고
  `input:bindingsChanged` 에서 갱신한다. 필 이름도 회복약으로.

**(C) 지도 핑.**
- `map/MapScreen.ts`: 역변환 `fromX(px)` / `fromZ(py)` 를 추가 (`toX` / `toY` 의 역: `(px - ox) / scale() - size/2`).
  `onMouseDown` (`:94`) 의 `e.button !== 0` 게이트를 열어 `e.button === 1` 이면 `preventDefault()` 후 팬을 시작하지
  않고 핑을 놓는다. `setPingSource` 와 같은 방식으로 `setPingPlacer(fn)` 을 두고 `HudSystem` 에서 배선한다
  (`HudSystem.ts:222` 옆).
- `hud/Pings.ts`: `place()` 의 꼬리(eviction → `build` → `ping:placed` / `ping:placedV2` → 채팅 → `net.send`)를
  `placeResolved(pos, kind, label, enemy)` 로 분리하고 공개 `placeAtWorld(position, kind?)` 를 만든다.
  `canPing` (포인터 락 + `isGameplayActive`) 게이트는 **건너뛰되** `MAX_PINGS` / 쿨다운은 지킨다.
  크레이트 / 패드 / 픽업 스냅(`:341-361`)을 재사용해 지도 핑도 `보급 상자` 라벨을 갖게 한다.
  `ping:requestAt` 도 구독해 다른 폴더가 핑을 요청할 수 있게 한다.

**(D) 아이템 툴팁 크레딧 바 + `100 C` 표기.**
- `hud/ItemTip.ts`: `:124` 의 `가치` 행을 stats 표에서 빼고 **카드 하단 바**로 만든다 (`.it-value` — 좌측에
  `가치`, 우측 정렬로 `formatCredits(itemCreditValue(def))`). `.item-tip` CSS 에 바 스타일 추가.
- ui 안의 크레딧 표기를 전부 `formatCredits` 로: `hud/MetaToasts.ts:51,79` · `hud/Notifications.ts:193,198` ·
  `menus/RewardsBlock.ts:111`. 문장 안의 **`크레딧` 이라는 단어는 유지**하고 숫자 부분만 포맷터로 바꾼다
  (`+1,200 C` 처럼). `menus/MissionComplete.ts:32-33,86-87` (`전리품 가치`) 와 `menus/DeathScreen.ts:50,139`
  (`소실된 전리품 가치`) 는 단위가 없었으니 `formatCredits` 로 붙인다.

**(E) 소프트 커서.**
- 새 `hud/SoftCursor.ts`: `#ui-root` 직속 자식(`ItemTip` 과 같은 위치), `input:cursorModeChanged` 로 표시/숨김,
  매 프레임 `ctx.input.cursorX/Y` 로 `translate` (레이아웃 리플로우 없이 `translate:` 채널 사용).
  절차적 SVG 화살표 + 얇은 외곽선, `SOFT_CURSOR_SIZE`, `pointer-events: none`, 최상위 `z-index`.
  커서 모드 동안 `body { cursor: none }` 을 켜서 실제 커서가 있어도 두 개로 보이지 않게 한다.
- ui 소유 화면의 커서 이관(§2): `map/MapScreen` (`'map'`) · `hud/ChatLog` (`'chat'`).
  **`menus/MenuBase` (`'menu'`) 는 그대로 둔다.**
- `HudSystem`: 생성 · bind · dispose + `update` 에서 위치 갱신 (블로커가 있어도 도는 경로에서).

**(F) 루팅 표시 = 빛기둥.**
- 하늘색 프레넬 구체는 `hud/Detection.ts:86` (`IcosahedronGeometry`, 사거리 내, 깊이 테스트 O) 와
  `hud/ScanReveal.ts:72` (스캔, 벽 투과) **두 곳뿐**이다. 둘 다 위로 갈수록 투명해지는 원기둥으로 바꾼다:
  `CylinderGeometry(INTERACT_PILLAR_RADIUS_TOP, INTERACT_PILLAR_RADIUS_BOTTOM, H, 8, 1, true)` 를 `+H/2` 로
  translate 하고 (`PickupVisuals.ts:86` / `Pings.ts:451` 패턴), **정점 색을 구워** 위쪽을 검게 만든 뒤
  `MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false,
  side: DoubleSide, toneMapped: false })` 로 그린다 — 애디티브에서 검정 = 투명이라 새 셰이더가 필요 없다.
  `INTERACT_PILLAR_FADE` 로 페이드가 끝나는 높이를 정한다.
- `Detection.placeShells()` 의 `position.y += 0.45` 리프트를 없앤다 (기둥은 지면에서 시작).
  `ScanReveal` 의 `KIND_SCALE` 은 **높이 배수**로 의미를 바꾸고 `SCAN_PILLAR_HEIGHT` 를 기준으로 한다.
  풀링(24 / 64) · 공유 지오메트리 · 공유 재질 · 조명 없음은 유지. `DETECT_HIGHLIGHT_COLOR` 는 이름을 바꾸지 않는다.

**검증**: `npm run verify --folders ui` (smoke-phase2 · quickslots · phase3 · controls-hub · ui-p6 · ui-p5 ·
uniques · meta). 크로스헤어 게이지 · 지도 핑 · 툴팁 크레딧 바 검사를 `smoke-ui-p5.mjs` 에 추가한다.

### 3-5. `src/inventory/` — 컨테이너 실시간 루팅 · 분대원 장비 뷰 · 크레딧 표기 · 커서

**(A) 컨테이너 실시간 동기화.** 프로토콜은 **이미 충분하다** — `cont taken` 은 `'others'` 로 나가 요청자와
나머지 전원에게 도달하고 `applyRemoteTaken` 이 이미 그리드에서 제거한다. 빠진 것은 연출과 구분이다.
- `applyRemoteTaken` (실시간) 은 `applyTaken` **전에** `c.uidAt(idx)` 를 잡아 두고
  `container:itemTaken {..., live: true, by, byName: net.getLobbyPlayer(by)?.name ?? null, byLocal}` 을
  `ui.refresh()` **앞에** emit 한다. `ContainerStore.applySync` / `applyPending` 경로는 `{live: false}` 로 조용히.
  로컬 단독 take 도 `{live: true, by: null, byLocal: true}` 로 emit 해 일관되게 한다.
- `ui/GridView.refresh()` (`:220-222`) 가 지금은 제거된 타일을 동기적으로 `el.remove()` 한다. `vanish(uid)` 경로를
  만들어 `.is-vanishing` 을 붙이고 `CONTAINER_TAKE_ANIM_S` 후 제거한다. CSS 는 `inv-pop` 옆에
  `@keyframes inv-vanish { to { translate: 0 -14px; opacity: 0; scale: .9 } }` — **`transform` 은 쓰지 않는다**
  (그 채널이 타일 위치다). `pointer-events: none` 도 함께.
- `cont taken.rem / seq` 를 채워 보내고(호스트) 받는 쪽은 `seq` 로 중복 · 순서 역전을 버린다.
- 알려진 잔버그도 같이: 원격 take 로 사라진 타일의 `GridView.scan` 이 다음 `updateSearch` 프레임까지 남는다 →
  제거 시 `setScan(null)`.
- 헤더에 `n명 수색 중` 을 넣을 필요는 없다 (계약의 `cont viewers` 는 채택하지 않았다).

**(B) 분대원 장비 뷰** — 스켈레톤 교체.
- `captureCrewLoadout()`: `captureLoadoutSave()` 를 재사용하고 `searched` 플래그만 뺀다 (`Loadout.ts` 의
  `LoadoutSave` + `sanitizeLoadoutSave` 가 이미 검증기다).
- `createCrewLoadoutView(host, loadout, opts)`: `sanitizeLoadoutSave` 로 검증 후 임시 `Grid` 를 `reviveItem`
  (`Serialize.ts:80`) 으로 채우고 `GridView` + `buildTileContent` 를 **읽기 전용**으로 재사용한다
  (모든 `TileHandlers` no-op, 드래그 · 회전 · 소켓 · 버리기 없음). 블록은 기본 `['equip','bag','quick']` —
  **함선 창고 열과 크레딧 필은 없다**. 모르는 def id 는 건너뛴다. 블로커 · 포인터 락 · window Escape 리스너 없음
  (`EmbeddedView` 규약, `TradeGrids` 가 선례).
- 팝업 프레임은 `hub/` 가 소유한다 (여기서는 `EmbeddedView` 만 제공).

**(C) 크레딧 표기.** `ui/labels.ts:9` 의 `fmtValue` 를 `formatCredits` 로 재구현하고 `₩` 접두사를 없앤다.
`TEXT.credits.value` 도 `formatCreditAmount` 로 (필은 `CREDITS` eyebrow 를 따로 갖고 있다).
`ui/Tooltip.ts:121` 의 `가치` 행을 **카드 하단 바**로 옮긴다 (`ItemTip` 과 같은 형태 — 좌측 라벨, 우측 정렬 금액,
스택이면 `단가 × 수량` 을 합계와 함께). 상단 아이템 이름/등급 영역은 그대로.

**(D) 커서 이관** (§2): `'inventory'` 토큰 (`InventorySystem.ts:2348-2349` / relock `:1529-1537`).
모달리스 팝업(`Modeless.ts`) 은 블로커가 없으니 그대로. `elementFromPoint` 히트 테스트 3곳
(`InventoryUI.ts:918, 1502, 1536`) 은 `ctx.input.elementUnderCursor()` 로 바꾸거나, 합성 이벤트의 `clientX/Y` 를
쓰고 있으면 그대로 둔다 (합성 이벤트가 가상 좌표를 싣고 오므로 대부분 무변경으로 동작한다 — 실제로 확인할 것).

**검증**: `npm run verify --folders inventory`. `smoke-search.mjs` 에 원격 take → `container:itemTaken {live}` +
타일 vanish 검사, `smoke-loadout.mjs` 에 `captureCrewLoadout` / `createCrewLoadoutView` 검사를 추가한다.

### 3-6. `src/weapons/` — 회복약 2초 홀드 · H 키 폐기 · 재장전 취소 이벤트 · 들쳐메기 게이트

- **H 키 폐기**: `WeaponSystem.ts:326` 의 `Keys.STIM` 리더와 `quickStim()` (`:1020-1028`) 을 삭제한다.
  `Keys.STIM` / `DEFAULT_KEYS.STIM` 은 shared 에 남아 있지만 **읽는 곳이 없어야** 한다.
- **회복약 좌클릭 2초 홀드**: `updateQuickHand` (`:1294-1297`) 의 `q.kind === 'stim'` 분기를 즉시 `useStim` 에서
  홀드로 바꾼다. `beginHold` / `updateHold` / `endHold` 의 수류탄 패턴을 그대로 따라 `healHeld` / `healT` 를 두고
  `heal:holdChanged {holding, t}` 를 emit (변화 시 ≤ 30 Hz). `HEAL_HOLD_S` 도달 → `consumeQuick` +
  `host.applyStim(def.healAmount ?? 50)` + `quick:used` + `quickCooldown`. 버튼을 놓으면 취소 (`{t: -1}`).
  **피해로는 취소하지 않는다** (`HEAL_HOLD_CANCEL_ON_DAMAGE` false). 체력이 가득이면 시작 자체를 거부(`deny`).
  무기 교체 · 임플란트 · 사망 · 다운 · 페이즈 변경에서 취소.
- **`weapon:reloadCancelled`**: `cancelReload()` (`:854`, 호출부 6곳) 에서 emit 한다. 진행 중인 재장전이 없으면
  emit 하지 않는다.
- **배리어 방패**: `implantHolster` 경로는 이미 `blocksWeapons` 를 보므로 무변경. 무기 키가 든 임플란트를 집어넣는
  경로(`:345-357`) 도 그대로 동작한다.
- **들쳐메기 게이트**: `ctx.player.carrying !== null` 이면 사격 · 근접 · 무기 교체 · 투척 · 빠른 사용 · 재장전을
  받았을 때 먼저 `ctx.player.dropCarried('action')` 을 호출하고 그 프레임에는 아무것도 하지 않는다 (다음 프레임에
  플레이어가 정상 상태가 되면 자연히 재시도된다). F 탭은 player 레인이 `input.consume` 으로 선점하므로 근접공격
  경로는 그대로 둔다 — 단 `unique.handlesMelee` (표창 용검) 도 같은 소비를 존중해야 한다.

**검증**: `npm run verify --folders weapons` (smoke-weapons · phase2 · quickslots · phase3 · phase4 · tactical ·
uniques). `smoke-phase2.mjs` 의 "stim in hand" 검사를 2초 홀드로 갱신한다.

### 3-7. `src/hub/` — 발사 준비 패널 · 하우징 카메라 · 커서

**(A) 발사 준비 패널** (헬다이버즈 2 스타일).
- 새 `hub/ui/ReadyPanel.ts` + `hub.css`: 슬롯이 채워지기 시작하면(로컬이 탑승했거나 원격이 ready) 화면에 4칸
  가로 패널. 각 칸: `ctx.player.createPortraits(host, HUB_READY_CELLS)` 로 만든 하나의 캔버스를 4개 뷰포트로
  나눠 쓰고, `setMember(i, {slot, armorId})` / `setYaw(i, HUB_READY_PORTRAIT_YAW)` 로 채운다.
  **준비되지 않은 플레이어의 칸은 캐릭터를 그리지 않는다** (`setMember(i, null)`).
- 칸 좌상단: 이름 + `Lv. n` (`net.getCrewCard(id)?.level`; 로컬은 `ctx.progression.level`).
  칸 우측: 장착한 전술 임플란트 (`crewCard.implant`, 아이콘 + 이름 — `ui/hud/ImplantChip` 과 같은 글리프 방식이지만
  hub 소유 DOM 으로 자체 구현한다. `IMPLANT_DEFS` 는 shared 라 자유롭게 읽는다).
- **우클릭 → 모달리스 팝업**: 해당 플레이어의 장비 / 가방 / 빠른 사용.
  `net.requestCrewLoadout(id)` → `net:crewLoadout` 도착 → `ctx.inventory.createCrewLoadoutView(host, loadout,
  {name, slot})` 를 hub 소유 모달리스 프레임에 넣는다 (`inventory/ui/Modeless.ts` 는 인벤토리 창의 자식이라 재사용
  불가 — `hub.css` 에 같은 모양의 프레임을 만든다). 로컬 플레이어 칸은 `ctx.inventory.captureCrewLoadout()` 을
  바로 쓴다. **함선 창고 열과 크레딧은 표시하지 않는다.** `hub:crewLoadoutToggled` emit.
- 블로커: `HUB_READY_BLOCKER` (`'ready'`) + `ctx.input.setCursorMode(true, HUB_READY_BLOCKER)`.
  **`exitPointerLock()` 은 호출하지 않는다.** `hub:readyPanelToggled` emit.
  `HubSystem.update` 의 하선 경로 `:780` (Esc) / `:783` (E) 와 `onPointerLockChange` (`:158-165`) 는
  `ctx.uiBlockers.size === 0` 게이트를 쓰므로 **`'ready'` 토큰만 무시**하도록 고친다
  (`HousingMode.blockedByPanel()` 과 같은 모양).
- **crew card 송신**: `hub:entered` (공유 함선) · `progress:levelUp` · `implant:equipped` 계열 ·
  `equip:changed` · 디바운스된 `inventory:loadoutSaved` 에서 `crew card` 를 `'others'` 로,
  `CREW_CARD_MIN_INTERVAL_S` 로 디바운스. `crewq sync` 를 받으면 자기 카드를 요청자에게. `crewq loadout` 을 받으면
  `crew loadout` 을 요청자에게 (`CREW_LOADOUT_COOLDOWN_S` 쿨다운). 수신 · 저장 · 이벤트는 **net 레인**이 한다
  (§3-9) — hub 는 **송신과 화면**만.

**(B) 하우징 카메라 (6~10번 방).** 회전의 정체는 `HousingMode.ts:149` 한 줄이다:
`this.camGoal.set(cx - rb.side * CAM_TOWARD_DOOR, CAM_HEIGHT, cz)`. `rb.side` 는 방 0–4 가 −1, 5–9 가 +1
(`interiors/RoomLayout.ts:33`) 이라 양쪽 모두 **문 쪽 벽 위**에서 내려다보게 되고, 결과적으로 두 그룹이 서로
180° 돌아 보인다 (둘 다 문이 화면 아래).
- 수정: `rb.side` 계수를 없애고 항상 `cx + CAM_TOWARD_DOOR` 로 (좌현 규약 유지) → 방 5–9 는 외벽 쪽에서 복도를
  향해 보게 되어 **문이 화면 위**로 온다.
- **같이 고쳐야 하는 곳**: `:237-238` 의 포인터 락 커서 매핑이 같은 `rb.side` 를 곱한다
  (`cursor.z += mouseDX * CURSOR_M_PER_PX * rb.side; cursor.x -= mouseDY * ... * rb.side`).
  여기서도 `* rb.side` 를 뺀다 — 안 그러면 우현 방에서 마우스가 좌우 반전된다.
- 안전한 곳(무변경): `raycastCursor` (카메라 레이 → y = 0 평면이라 카메라를 따라간다) · `refresh` 의 셀 계산
  (순수 월드 좌표) · `glideCamera` · `interiors/PersonalShip.ts` 의 `rb.side` (기하학이지 카메라가 아니다).
- 스모크 확인: `scripts/smoke-ship-rooms.mjs:281-282` 는 카메라 `y > 4.5` 와 `|z − 2.5| < 1.0` 만 보고 x 는 보지
  않으며, `:292` 는 방 0(좌현)에서만 락 커서를 움직인다 → 좌현 규약을 유지하면 그대로 통과한다.
  **우현 방 검사를 새로 추가한다** (방 5 선택 후 카메라 x 가 방 중심보다 크고, 커서 매핑이 반전되지 않는지).
- 방 5–9 의 새 시점은 `cx + 2.2 = 6.0` 으로 외벽 슬래브(`maxX 5.8 + WALL 0.3`) 안쪽이지만 `y 6.6` 은 `CEIL 3.2`
  위이고 천장은 위에서 백페이스 컬링된다 → 가려지지 않아야 한다. **스크린샷 한 장으로 확인할 것.**

**(C) 커서 이관** (§2): `ui/HubMenu.ts` (`'hub'`) · `ui/WorkbenchMenu.ts` (`'hub'`) ·
`HousingMode.enterManage` (`'shipmanage'`, `:121-124` / `:189-200`). `HousingMode.pointerOverUI` (`:281`) 와
`raycastCursor` (`:290-303`) 의 `input.mouseX / mouseY` 는 `input.uiX / uiY` 로.

**검증**: `npm run verify --folders hub` (smoke-weapons · controls-hub · ship-rooms · housing · console · meta ·
training · library · e2e-mp). 준비 패널 검사를 `smoke-training.mjs` (페이크 로비 터미널 / 포드 상태가 이미 있다)
또는 새 검사군으로 추가한다.

### 3-8. `src/net/` + `src/pickups/` — crew 와이어 · 들쳐메기 스냅샷 · 방패 필드 · 픽업 빛기둥

**(A) crew 카드 수신** — 스켈레톤 교체.
- `NetSystem`: `crew` / `crewq` 를 구독해 `Map<PeerId, CrewCardWire>` 에 보관하고 `net:crewCard` 를 emit.
  `crew loadout` → `net:crewLoadout`. `getCrewCard(id)` (로컬 id 는 hub 가 보낸 자기 카드를 그대로 반환),
  `requestCrewLoadout(id)` → `{t:'crewq', ev:'loadout'}` 를 그 피어에게.
  `RemotePlayer` 에 `crewLevel` / `equippedImplant` 를 미러링한다. 카드는 로비를 나갈 때 비운다.
  릴레이는 `crew` / `crewq` 를 그대로 넘기므로 **서버 변경 없음**.
- **`crewq sync`**: `hub:entered` 에서 hub 가 보낸다 (송신은 hub 레인). net 은 받아서 hub 가 응답할 수 있게
  이벤트로 흘리기만 한다 (또는 `onMessage('crewq')` 구독자에게 그대로 전달 — 기존 패턴 유지).

**(B) 들쳐메기 스냅샷.**
- `Snapshotter`: `ctx.player.carrying` 이 있으면 `PlayerFlags.CARRYING` + `cr`. 운반 중에는 **무장 없음** 경로를
  타야 하므로 `HAS_WEAPON` / `HOLDING_ITEM` 게이트(`:92-99`) 를 운반 시 무장 없음으로 강제한다.
  들려 있는 쪽은 `PlayerFlags.CARRIED`.
- `RemotePlayer`: `cr` → `carrying`, `flags & CARRIED` → `isCarried`. `NetSystem` 이 모든 ref 의 `cr` 을 훑어
  `carriedBy` 를 파생하고 변화 시 `net:remoteCarryChanged` 를 emit. `DebugRemoteRef` 에도 같은 필드.
- `carry` 메시지를 릴레이 · 구독 가능하게 한다 (즉시 피드백 + 운반자가 중단됐을 때 호스트가 몸을 내려놓는 근거).
  운반자가 suspend 되면(`onPeerSuspended`) 들려 있던 쪽의 `carriedBy` 를 지운다.

**(C) 배리어 방패 필드.** `Snapshotter`: `ctx.implants.barrierHp` 를 `bhp` 로 (BARRIER 플래그가 설 때만).
`RemotePlayer`: `flags & BARRIER` → `isBarrierUp`, `bhp` → `barrierHp`.

**(D) 픽업 빛기둥** (`src/pickups/`).
- `PickupVisuals.ts`: 지금 빔은 `CylinderGeometry(0.05, 0.16, 5.5, …)` 로 **위로 갈수록 넓어지고** 균일 불투명도다.
  `PICKUP_PILLAR_HEIGHT` / `PICKUP_PILLAR_OPACITY` 로 줄이고 위로 갈수록 투명해지게 정점 색을 굽는다
  (ui 의 `Detection` / `ScanReveal` 과 같은 방식). 지면 링(`ringGeo`) 은 유지.
  `BEAM_HEIGHT` export 는 다른 곳이 읽을 수 있으니 **지우지 않고** 남긴다.
- **여기에 하늘색 구체는 없다** — `PickupVisuals` 의 유일한 구체는 수류탄 몸통 실루엣이다. 삭제하지 말 것.

**검증**: `npm run verify --folders net,pickups` (smoke-ghost · enemy-delta · weapons · e2e-mp).
`scripts/e2e-multiplayer.mjs` 에 crew 카드 왕복과 들쳐메기 플래그 검사를 추가한다.

### 3-9. `src/meta/` + `src/housing/` + `src/progression/` — 크레딧 표기 · 커서

- **`meta/`**: `ui/dom.ts:23` 의 `fmtNum` 을 유지하되, 크레딧을 표시하는 모든 곳을 `formatCredits` /
  `formatCreditAmount` 로 바꾼다: `ui/CorpView.ts:231, 351, 354-357, 399, 552` (`cr` 접미사 → `C`),
  `:179, 608, 702` (문장 안의 `크레딧` 단어는 유지, 숫자에 단위 붙임). `MetaSystem.ts:851-852` 의 콘솔 출력도.
  `buyPriceOf` / `sellPriceOf` 규칙은 **바꾸지 않는다**. `ui/CorpMenu.ts` (`'corp'`) 커서 이관 (§2) —
  임베드 모드는 블로커가 없으니 그대로.
- **`housing/`**: `ui/Panel.ts` (`'housing'`, `:62-63` / relock `:89-90`) 커서 이관. 재료 비용 칩은
  `shared/itemChip.ts` 를 쓰므로 크레딧과 무관 — 변경 없음.
- **`progression/`**: `ui/CharacterSheet.ts` (`'stats'`, `:66-67` / relock `:89-92, :103`) 커서 이관.
- **`console/`**: `ConsoleSystem` (`'console'`, `:166-167` / relock `:184-189`) 커서 이관. dev 클라이언트 전용이라
  마지막에 해도 된다.

**검증**: `npm run verify --folders meta,housing,progression,console`.

## 4. 하지 않는 것 (범위 밖)

- `PLAYER_HEIGHT` / `PLAYER_RADIUS` / 카메라 아이 높이 / 히트박스 변경 — 3등신은 머리를 키워서 만든다.
- 서버(`server/`) 변경 — `crew` / `crewq` / `carry` 는 불투명 릴레이 메시지다.
- `buyPriceOf` / `sellPriceOf` / `ItemDef.value` 재조정 — 표기만 바꾼다.
- `rollCorpse` / `CORPSE_TABLES` 변경 — 루팅 **가능 여부**만 새로 판정한다.
- `stim` def id · `ItemCategory 'stim'` · `applyStim` 이름 변경 — 표시 라벨만 회복약.
- Esc 일시정지 메뉴의 커서 — 실제 OS 커서를 그대로 쓴다.

## 5. 검증

`docs/VERIFICATION.md` 에 결과를 기록한다. `src/shared` 를 건드렸으므로 병합 전에는 **`npm run verify:all`**
(typecheck 클라이언트 + 서버, `net:selftest`, 전체 스모크, build, 새 릴레이에서 `e2e:mp`).
각 레인은 작업 중에는 `npm run verify --folders <자기폴더>` 로 돌린다.

계약 커밋 시점 기준: `npm run typecheck` 0 · `npm run typecheck:server` 0 · `npm run net:selftest` 194/194.
