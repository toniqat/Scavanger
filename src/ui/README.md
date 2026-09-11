# src/ui — HUD & menus (`HudSystem`)

Arc Raiders-style minimalist HUD and all full-screen menus. Everything is plain DOM under `ctx.uiRoot`
(no React), styled by `styles/base.css`. Korean text throughout. Components only touch the DOM when a
value actually changes; moving elements use `transform`.

Import via `@/ui` → `HudSystem`, `OBJECTIVE_TEXT`.

| File | Purpose |
|---|---|
| `HudSystem.ts` | `GameSystem` (`name: 'hud'`). Builds three `.hud` layers — **overlay** (vignette / edge flash / damage arcs / scope; gameplay + `dead`), **gameplay HUD** (`.hud.gameplay`: reticle, **cook gauge**, **quick wheel**, **ship-call wheel / panel / charge ring / targeting frame**, **off-screen indicators**, vitals, weapon, compass, world markers, objective, mission info, pings + gesture hint, spectate banner; gameplay phases + `deploying`, hidden while `ctx.uiBlockers` has `'menu'` or the player is dead in single-player) and **social HUD** (`.hud.social`: nameplates, squad list, interaction prompt, notifications, chat log; additionally visible in phases `hub` / `docking`). Both HUD roots get `.hub` in the hub phases and `.spectating` when a dead local player keeps watching in multiplayer (CSS hides reticle / vitals / weapon / prompt / wheels / cook gauge / charge / strat panel / targeting frame) and `.targeting` while a ship call is being aimed (`TargetingHud` callback; CSS hides the reticle). Also owns the deploy overlay, the tactical map and the four menus (title, pause, death, complete). Drives the default objective flow on `game:phaseChanged` / `extraction:boarded` / `extraction:tick` (emits `ui:objective`). Wires `MapScreen.setPingSource(() => pings.getPings())`. `isMapOpen` / `isChatOpen` / `isWheelOpen` / `isConsumableMode` / `isStratagemWheelOpen` / `isTargeting` / `offscreenCount` getters for debugging. **Phase 6:** a fourth root **`.hud.housing`** (always attached, `pointer-events:none`) so the 시설 관리 screen survives the gameplay/social gating in the ship (**2026-09-09:** `HousingHint` is gone from it — the 키 가이드 replaces the housing key bar; only `ShipManage` lives there now); `WeaponChargeGauge` + `StatusMarkers` join the gameplay layer, `CheatTag` + `RoomLabel` the social layer (`RoomLabel.update` runs every frame regardless of visibility). Debug getters `weaponChargeKind` / `statusMarkerCount` / `hasWeaponModes` / `isMoveCheatTagOn` / `isRoomLabelOn`. **2026-09-09:** `KeyGuide` is constructed as a **direct child of `ctx.uiRoot`** right after `ItemTip` (bound with the Phase 6 widgets, `keyGuide.update()` every frame next to `community.update`, disposed with them); debug getters `keyGuideOwner` / `keyGuideOwners` / `keyGuideEntries` / `isKeyGuideOn`. **Phase 5:** `ContractPanel` in the gameplay layer right after `Objective`; `MetaToasts` constructed on `progressToasts.root` (social layer); both bound / disposed with the Phase 6 widgets; `contractPanel.update(ctx)` + `metaToasts.update(dt)` run every frame next to `roomLabel.update`; `death.update(dt)` joins `complete.update(dt)`. Debug getters `isContractPanelOn` / `isContractPulsing` / `metaToastCount` / `completeRewards` / `deathRewards`. **Phase 8:** `ShipManageHint` joins the social layer (`shipHint.update(ctx)` runs every frame next to `roomLabel.update`), `ShipManage` the `.hud.housing` layer, and the `SettingsMenu` overlay is constructed with the one `KeybindMenu` instance and handed to `PauseMenu` as its `설정` callback. Debug getters `isSettingsOpen` / `isShipManageOn` / `shipManageRoom` / `shipManageCardCount` / `isShipHintOn` / `isPauseHubVariant`. **Phase 9:** `TrainingPanel` joins the gameplay layer next to `ContractPanel` (bound, updated every frame and disposed with it); debug getters `isTrainingPanelOn` / `isTrainingPulsing` / `trainingPanelMode` / `isGiveUpBarOn`. **Phase 8 UI pass:** `ItemTip` is constructed as a **direct child of `ctx.uiRoot`** (not in a `.hud.*` layer) so the 재료 요구 칩 hover card floats above the inventory window, the 시설 관리 screen and every menu; debug getter `itemTipDefId`. **Phase 10:** two more crosshair rings join the gameplay layer — `ReloadGauge` (`reload.update(dt)` took the place of `weapon.update(dt)`, which is gone) and `HealGauge` (event-driven only); **2026-09-08** a third, `HoldGauge` (event-driven, 상호작용 홀드 + 포기), joins them with `isHoldGaugeOn` / `holdGaugeProgress` / `isHoldGaugeGiveUp` — and `SoftCursor` joined `ItemTip` as a direct child of `ctx.uiRoot` (**gone since the 2026-09-07 커서 rework** — `GameCursor` replaces it, has no DOM node and no per-frame update). The map is also handed `setPingPlacer((position, kind) => pings.placeAtWorld(position, kind))` next to the existing `setPingSource`. Debug getters `isReloadGaugeOn` / `reloadProgress` / `isHealGaugeOn` / `isGameCursorOn`. **Phase 11:** `Community` joins the social layer (constructed after `ShipManageHint`, bound on its own, `community.update(dt, ctx)` next to `shipHint.update(ctx)`, disposed with the menus) and the smoke hook `debugSocial(snapshot, invites, mySquad)` installs a synthetic social mirror for both `SocialColumn`s (the ESC one and the community one) through `menus/social/socialSource`. Debug getters `debugSocialLog` / `isCommunityOn` / `isCommunityOpen` / `communityInviteCount` / `communityHoldProgress` / `chatWhisperTarget`. **2026-09-09 (레이드 플레이 개선):** 게임플레이 레이어에 `CommsWheel` (형제 휠들 옆) 과 `HazardHud` (배너 · 게이지는 게임플레이, `.hz-edge` 는 **오버레이** 레이어 — 생성자가 부모 둘을 받는다) 가, 그리고 DOM 없는 `RaidAlerts` 가 붙었다. 셋 다 함께 bind / dispose 하고, `comms.update(dt, ctx)` 와 `hazard.update(ctx)` 는 **레이어 가시성과 무관하게** 매 프레임 돈다 (`rescuePick.update` 옆) — 의사소통 휠은 자기 키를 스스로 폴링하므로 게이트를 자기가 걸어야 하고, 재해 HUD 는 `ctx.world.hazard` 가 null 이면 즉시 돌아온다. Debug getters `isCommsWheelOpen` / `commsWheelHover` / `commsWheelSlots` / `isPingWheelOpen` / `isPingWheelDowned` / `isHazardBannerOn` / `isInHazard` / `hazardSafeShare`. **2026-09-11 (C-53 · X-9):** `lateUpdate` 의 **첫 줄이 `ctx.camera.updateMatrixWorld()`** 다 — `Vector3.project` 는 `camera.matrixWorldInverse` 만 읽는데 그것을 갱신하는 것은 `updateMatrixWorld` / `updateWorldMatrix` 뿐이고 렌더러는 `render()` 안(= 이 뒤)에서야 한다. 그래서 투영 전에 `getWorldDirection` / `getWorldPosition` 을 부르지 않는 WorldMarkers · Pings · OffscreenIndicators 가 **직전 프레임의 뷰**로 투영하고 있었다. 투영하는 새 위젯은 `update` 가 아니라 여기(`lateUpdate`)에 둔다. `NamedScanWarning` 도 이 블록으로 옮겼다. **2026-09-11 (C-9):** `TitleMenu` 에 세 번째 인자(설정을 `키 설정` 구획으로 여는 콜백)를 넘기고, debug getter `keybindNotice` (`{report, lines, on}`). **C-26:** `hud/SlotStrip` 흔적 주석 정리. |
| `dom.ts` | Helpers: `el()`, `setText()` (no-op if unchanged), `toggleClass()`, `setVisible()`, `fmtTime()` (MM:SS), `fmtInt()`, `damp()` (frame-rate independent lerp), `rarityColor()`, `escapeHtml()`. |
| `index.ts` | Barrel. |
| `styles/base.css` | Global reset, `#app` / `#game-canvas` / `#ui-root` layout (`pointer-events:none`; children opt in with `.interactive`), palette CSS variables (`--c-accent #ffb347`, `--c-danger #ff4d4d`, `--c-success #4fd17e`, rarity colors), font stack, utilities (`.ui-panel`, `.ui-label`, `.ui-btn`, `.ui-input`, `.keycap`) and all HUD/menu component styles. Ends with the `── multiplayer ──` and `── ship hub / chat ──` sections (see below). |
| `styles/title.css` | **타이틀 흐름 전용 스타일시트** (2026-09-09, `menus/TitleMenu.ts` 가 import). `.menu.title.home` (워드마크 위쪽 가운데 · 액자 없는 프레임 · `.title-actions` 버튼 열 · `.stacked`), `.title-screen` (`.char-select` / `.char-create` 공용 전체화면 껍데기, z-index 84 · `.ts-head` · `.ts-foot` · `.form-msg`), `.cs-card*` (슬롯 카드 · `--ac` 악센트 · `.cc-mini` 능력치 축소판 · 빈 칸), `.cc-*` (생성창의 세 열 `.cc-body` · 패널 · 임플란트 타일 `.cc-imp-tile` + 컨텍스트 메뉴 `.cc-imp-menu`(`.sc-menu` 껍데기) · 세로 능력치 `.cc-stat-list > .cc-stat` · 미리보기 열 `.cc-side` + 스와치 `.cc-accent`), `.tm-ask*` (경고 팝업 + 홀드 채움), **`.kb-notice`** (2026-09-11 옛 키 설정 알림 카드 — `.kbn-head` · `.kbn-lines > .kbn-line` · `.kbn-sub` · `.kbn-foot`, 가운데 정렬은 `menuIn` 의 transform 과 싸우지 않게 `margin: 0 auto`, `.stacked` 에서 같이 흐려진다). 색 · 여백 · 트랜지션은 전부 `base.css` 의 변수를 쓰고 여기서 새로 정의하지 않는다. **`base.css` 는 건드리지 않는다** — `.menu.title .frame` 의 900 px 상자는 `.home` 을 하나 더 얹은 선택자로 덮어쓴다. |
| `styles/wheels.css` | **2026-09-09 에 생긴 두 방사형 휠의 스타일시트** (`hud/CommsWheel` · `hud/PingWheel` 이 import). `.cwheel` (`.carc` / `.csector` / `.centre .cname .ccd .csub`, `.cooling`, `.downed`) 와 `.pwheel` (`.parc` / `.psector`, `--pc` 로 칸 색 — **2026-09-10 에 `.ammo-leg` 블록은 지웠다**, 탄약 요청 제스처가 없어졌다). `.qwheel` / `.swheel` 과 같은 규약 — 가운데 고정 · `pointer-events:none` · `.show` 페이드, 색과 트랜지션 변수는 전부 `base.css` 의 `:root` 것을 쓴다. 끝에 `.hud.spectating` 숨김 규칙 한 줄. |
| `styles/hazard.css` | **환경 재해 HUD 스타일시트** (`hud/HazardHud` 가 import). `.hz-hud` (상단 중앙 104 px 블록) > `.hz-banner` (붉은 맥동 배너) · `.hz-prog(.critical) .bar .fill` (남은 안전지대) · `.hz-arrow` (`--rot` 로 도는 안전 방향 삼각형) · `.hz-inside` (위험 구역 상시 경고), 그리고 오버레이 레이어에 붙는 `.hz-edge(.show)` 화면 가장자리 radial 맥동. 색 · 트랜지션은 `base.css` 변수. |
| `styles/implant.css` | **전술 임플란트 HUD 스타일시트** (2026-09-10, `hud/ImplantWidget` 와 `hud/Reticle` 이 import). 맨 위에 **화면 하단 중앙 줄의 공용 기하** `:root { --imp-th · --imp-tw · --imp-bottom · --imp-gap }` 가 있다 (2026-09-10 2차) — 짧은 화면 media 두 단계도 이 변수만 바꾸고, **`styles/shipCall.css` 의 `.scall` 이 그것을 읽어** 임플란트 왼쪽에 같은 밑단 · 같은 높이로 앉는다. `.imp-hud`(중앙 하단 · `bottom: var(--imp-bottom)` 로 스태미나 바 `bottom: 9%` 아래에 붙는다 · `--ic` 임플란트 색 · `--th` = `--imp-th` · `--fill` 0…1) > `.imp-thumb` > 얼굴 두 장 `.ib-face` / `.ib-reveal > .ib-face.lit` · `.ib-cd` 중앙 숫자 · `.ib-ch` 우하단 충전 수 · `.ib-gauge > i` 중앙 하단 게이지, 그리고 `.imp-key` 키캡. 상태 클래스 `dim` / `accent` / `low` / `empty` / `wielded` / `holding` / `pulse` / `hit` / `blocked`. 끝에 크로스헤어 좌측 **갈고리 칩** `.reticle .rgrap(.can)` 규칙. 짧은 화면용 media 두 단계. `base.css` 는 건드리지 않는다(2026-09-10 에 옛 `.implant-gauge` · `.implant-chip` 블록은 지웠다). |
| `styles/shipCall.css` | **함선 호출 썸네일 스타일시트** (2026-09-10 2차, `hud/StratagemPanel` 만 import). `.scall`(`--sc` 호출 색 · `--fill` 0…1) > `.sc-thumb` **정사각**(한 변 = `--imp-th`) > 얼굴 두 장 `.sb-face` / `.sb-reveal > .sb-face.lit` · `.sc-cd` 중앙 쿨타임 숫자 · `.sc-ch` 우하단 구조선 잔여, 그리고 `.sc-key` 키캡. 상태 클래스 `off` / `armed` / `targeting` / `dim` / `spent` / `pulse` / `blocked`. **자리와 크기는 `implant.css` 의 `:root` 변수가 원본**이고 여기서 그 숫자를 다시 적지 않는다 — `right: calc(50% + var(--imp-tw)/2 + var(--imp-gap))` 라 임플란트가 숨어도 자리가 흔들리지 않는다. 얼굴 클래스를 `.ib-*` 와 나눠 쓰지 않고 `.sb-*` 로 갈라 뒀다 (2026-09-09 `.hold` 사고와 같은 이유). |
| `styles/danger.css` | **위험 인디케이터 스타일시트** (2026-09-10, `hud/DangerIndicators` 가 import). `.dgr` > `.dgr-arcs > .dgr-arc(.show/.hot)`(240 px 링 · `conic-gradient` 쐐기를 `mask: radial-gradient` 로 잘라 낸 `.wedge` + `--rot` 만큼 되돌려 세운 `.tag`(글리프 · 라벨)) 과 `.dgr-head(.hot)`(마름모 `.ring` · `.ico` · `.lbl`). 색은 `--dc` 하나로 갈리고 `.dmg-arc` 와 같은 두께 · 마스크 규약을 따른다. |
| `styles/raidHud.css` | **레이드 HUD 개편 스타일시트** (2026-09-10, `hud/Objective` · `hud/WeaponPanel` · `hud/QuickStrip` · `hud/Vitals` 넷이 import — 같은 파일이라 Vite 가 한 번만 싣는다). 커진 `.objective .head .clock`, 무기 패널의 **가로 상자**(`.wbox` — 어두운 반투명 + 1px 테두리 · `min-width` 330 px, 안에 `.wthumb` 76 px 정사각형 + `--wrc` 등급색 테두리·글로우·**바탕색**, `.ammo-nums` 가로 한 줄 `24 / 120`, `.mag` 64 px, 오른쪽 끝으로 밀린 `.name-row`, **바닥의 `.dura`**; 소모품 모드는 `.weapon.consumable > .wbox { display:none }`), 0.6배로 되돌린 퀵슬롯(`.qstrip.is-single .qs-body` 54 px, `.qs-key.keycap`), 그리고 좌하단의 `.vt-name` · `.sh-bar .sh-seg .fill`(`--shc` 등급색, `--sh-cells` 로 칸 폭을 체력과 맞춘다) · 5등분 `.hp-bar` · 전투불능 전용이 된 `.vitals > .ui-label`. **`base.css` 는 건드리지 않는다** (`hazard.css` · `rescuePicker.css` 와 같은 규약) — 같은 클래스를 다시 칠하는 자리는 전부 `.hud` 를 한 단계 더 붙여 **specificity 로** 이기므로 로드 순서에 기대지 않는다. 색 · 트랜지션 변수는 전부 `base.css` `:root` 것이다. |
| `styles/drone.css` | **드론 조종 HUD 스타일시트** (2026-09-11, `hud/DroneHud` 만 import). `.hud.drone-view` 규칙(조종 중 `.weapon` · `.imp-hud` · `.scall` · `.stamina` · `.reticle` · 크로스헤어 게이지 · 휠 숨김 `!important`, `.vitals` 0.55 × 0.8, `.compass` 0.35) · `.dr-static(.on .burst)`(`--si` 강도, 외곽 radial 마스크, 캔버스 + `.dr-scan` · `.dr-fringe` · `.dr-tear`, 애니메이션은 `.on` 일 때만) · `.dr-view(.show .is-air .is-ground .hit)` > `.dr-frame` · `.dr-tag` · `.dr-hp(.low .hit)` · `.dr-aim` · `.dr-alt(.at-max)` · `.dr-keys > .dr-key(.air .ground .back)` + `.dr-noise(.on .linger)` · `.dr-link(.warn .lost)` · `.dr-ring(.show)` (`--dc`) · `.dr-alert(.show)` (1.5 s). 색 · 트랜지션 변수는 `base.css` 의 `:root` 것. |
| **hud/** | |
| `hud/Reticle.ts` | Center 4-tick crosshair + dot. Base gap by stance × aim (`ctx.player.stance`: stand 14/7, crouch 10/5, prone 8/4 px hip/ADS), sprinting 18, +2 while moving (`ctx.player.velocity`); blooms on `weapon:fired` (decays). Hitmarker X on `ui:hitmarker` (white = hit, red = kill; **2026-09-09** a `headshot` draws the same X at **1.6배**(24 → 38.4 px) via `.hitmarker.head`, colour unchanged — 처치의 빨강만 따로다). Fades out while any UI blocker is active, is fully hidden while the scope overlay shows (`weapon:scopeChanged.scope && aiming`) and dims to 25 % while the quick-use or ship-call wheel is open (`quick:wheelChanged.open` / `stratagem:wheelChanged.open`); `.hud.targeting .reticle` hides it via CSS while a call is being aimed.  **2026-09-10 (임플란트 HUD 이전):** 크로스헤어에서 임플란트 쿨타임 · 충전 수 표기가 **전부 사라지고**(중앙 하단 `hud/ImplantWidget` 썸네일로 이사) 대신 **갈고리 칩**(`.rgrap`, 크로스헤어 **좌측**)이 붙었다 — 갈고리를 장착했을 때만 존재하고, 지금 조준한 방향에 걸 수 있으면 아이콘이 밝고 `Keys.IMPLANT` 키캡이 보이며, 걸 수 없으면 **키캡은 `hidden`, 아이콘만 딤드**다. 판정은 흉내내지 않는다: implants/ 의 `updateGrapple` 이 자기 조준 광선으로 계산해 보내는 `implant:grappleTargetChanged {valid}` 하나가 근거이고(= `castGrapple` 이 보는 `grappleTargetValid`) 이 파일은 레이캐스트를 쏘지 않는다. 기존 `.hook` 괄호(거리 표시)는 그대로다. 스타일은 `styles/implant.css`, 디버그 getter `grappleChip` (`off` / `dim` / `ready`). |
| `hud/QuickWheel.ts` | **Quick-use wheel** (`.qwheel`, `pointer-events:none`, 260 px, fades ~100 ms via `.show`): SVG ring of 8 annular sectors (`.qarc`) + 8 DOM `.qsector`s at `QUICK_SLOT_DIRS` (index 0 = N, clockwise), each with the item icon (`ItemDef.icon`, tinted `ItemDef.color`) and stack count; `.hover` (accent) from `quick:wheelChanged.hover`, `.locked` (dim + 🔒) where `!isQuickSlotActive(i, active)`, `.empty` (dim + direction tag). Centre: `빠른 사용` label, hovered item name (`이름 ×n` / `비어 있음` / `잠긴 슬롯 — 더 큰 가방 필요`), hint. Data = last `inventory:quickSlotsChanged {slots, active}`, seeded from `ctx.inventory.getQuickSlots()/getQuickSlotCount()` at bind and on open; defs via `ctx.inventory.getDef` (fallback `ctx.loot.getItemDef`); counts follow `quick:used.remaining` and re-read on `inventory:itemUpdated` while open. Closed on `player:died/downed`, `game:newMission/abort`. `isOpen` getter. |
| `hud/CookGauge.ts` | **Grenade cook gauge** (`.cook`, `pointer-events:none`): 120° SVG arc of radius 48 px bulging right of the reticle (`pathLength=1`, fill via `stroke-dasharray`), shown while `grenade:holdChanged.holding` (`.show`). `cooking` → fill = `cooked / GRENADE_COOK_MAX`, `.warm` amber > 60 %, `.hot` red + `cookPulse` > 85 %. Label under the arc end: `R 핀 제거` before the pin, `n.n s` (= `fuse` left on release) while cooking; `.tag.show` `언더핸드` when `underhand`. Hidden on `holding:false`, `player:died/downed`, `game:newMission/abort`. |
| `hud/ReloadGauge.ts` | **재장전 링 at the crosshair** (`.reload`, Phase 10 — it replaced the tiny `.arc` SVG beside the bottom-right weapon panel; a reload is watched in the centre of the screen, not in a corner). Same shape as `ChargeGauge`: one full-circle SVG ring (`SIZE 120` / `RADIUS 48`, `svg { transform: rotate(-90deg) }` so it fills from 12 o'clock, `stroke-dasharray` on the circumference) plus a `n.n s` label under it. `weapon:reloadStarted {duration}` shows it and starts a **local countdown** (`update(dt)` from `HudSystem`; there is no per-frame reload event), `weapon:reloadFinished` hides it, and so does the new **`weapon:reloadCancelled`** — without that event a melee swing / weapon swap that aborts the reload left the ring filling to 100 % and sitting there. `weapon:equipped` (the old panel's behaviour), `player:died` / `player:downed` and `game:newMission` / `game:abort` hide it too. **2026-09-08 — 무기 교체도 이 링이다**: `weapon:swapStarted {duration}` starts the same countdown with the `무기 교체` label and `.reload.swap` (a cooler tint). The two states cannot overlap (a swap cancels a running reload), so one ring serves both, and `mode` only decides which events may hide it — `weapon:equipped` fires **halfway through** a swap (the new gun is attached at 50 %), so it clears a reload ring and never a swap ring that is still counting. `isShowing` / `progress` / `gaugeMode` getters. |
| `hud/HealGauge.ts` | **회복 소모품 hold gauge** (`.heal`, Phase 10; generalised 2026-09-07): a 회복 소모품 is never a tap but a hold of the item's **own** length (`heal:holdChanged.dur` — 붕대 5 s · 회복주사 2 s · 제세동기 1 s; `HEAL_HOLD_S` is only the fallback), and a 회복 스프레이 channels instead (`spray: true` → `t` is the remaining gauge, label `스프레이 n %`, no `.near` / `.ready` states). This is that ring. A copy of `CookGauge` (same 48 px radius, same `.show` fade, same reticle anchor, same bottom-left label block) drawn as a **full circle** instead of the 120° arc — a 360° single SVG arc degenerates, so it is a `circle` with `stroke-dasharray` like `ChargeGauge`. Driven only by `heal:holdChanged {holding, t}` (weapons owns the timing; `t < 0` / `holding: false` = cancel): fill = `t`, `.near` green past 75 %, `.ready` pulse at 1, label `회복 n.n s` counting down from `dur`. Damage does **not** cancel the hold (`HEAL_HOLD_CANCEL_ON_DAMAGE` false), so it only closes on release, on the injection, and on death / downed / mission reset. `isShowing` getter. |
| `hud/GameCursor.ts` | **게임 마우스 커서 art** (2026-09-07 rework; replaced the Phase 10 `hud/SoftCursor.ts` sprite). Since a cursor screen releases the pointer lock, the **real** OS cursor is back and the only job left is making it look like the game's: three variants are drawn procedurally on a `<canvas>` (`GAME_CURSOR_SIZE`, 1× + 2× for HiDPI — `default` white arrow, `pointer` accent arrow, `grab` corner brackets), baked into `cursor: image-set(url(data:…) 1x, url(data:…) 2x) hx hy, <fallback>` and injected once as `<style id="game-cursor-style">` under `body.cursor-ui` (added at construction and never removed — while the pointer is locked the browser shows no cursor at all, so the rules cost nothing during play). **Which element gets which variant is not a hand-written list**: `mirrorSheetRules()` walks `document.styleSheets` and re-emits every rule whose `cursor` is `pointer` / `grab` / `grabbing` / `move`, prefixed with `body.cursor-ui`, so a new panel that styles its rows `cursor: pointer` gets the game's pointer for free (a selector already anchored on `body`/`html`/`:root` is skipped, and the pass re-runs on `window.load` for the production build's `<link>` CSS). Text inputs keep the native I-beam — a caret position is what a bitmap cannot express. `bind(ctx)` only toggles **`body.cursor-on`** from `input:cursorModeChanged` ("a surface owns the mouse right now"). No DOM node, no per-frame work, `isShowing` getter. |
| `hud/pillar.ts` | **빛기둥 builder** (Phase 10) shared by `Detection` and `ScanReveal`: `makePillarGeometry(height, rBottom, rTop, fade)` = an **open** `CylinderGeometry` (8 radial × 6 height segments, no caps) translated `+height / 2` so its **base sits at the mesh origin** (place the mesh on the target and it starts at ground level — the `PickupVisuals` / `Pings` beam trick), with a **baked vertex-colour ramp** that reaches black at `INTERACT_PILLAR_FADE × height` (`(1 − t) ^ 1.4`); `makePillarMaterial(color, opacity, throughWall)` = `MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: !throughWall, side: DoubleSide, toneMapped: false })`. In additive blending **black is transparent**, so the vertical fade needs no shader; the material's `color` tints the whole pillar and `opacity` stays free for the breathing pulse. Scaling a mesh on Y scales the ramp with it, which is how `ScanReveal` turns a per-kind number into a height multiplier. The extra height segments (the plan sketched 1) are what let the ramp actually end at `FADE` rather than only at the very top. **2026-09-11 (C-4, 에이전트 1):** `pillarAllowed(it)` 는 `string | {id, kind?}` 를 받는다 — `Interactable.kind`(`corpse` · `playerCorpse`) 가 먼저, 없으면 접두어. ScanReveal 은 reveal 이벤트마다 등록물에서 id→kind 표를 채워 쓴다. |
| `hud/stratagemGlyphs.ts` | Shared ship-call presentation: `STRATAGEM_GLYPH` (◎ 궤도 폭격, ▼ 항공 폭탄, ▣ 보급품 투하, ▦ 트라이포드 투하, **✚ 구조선 투하** — 2026-09-09), `STRATAGEM_COLOR`, `stratagemDef(id)` (lookup in `STRATAGEM_DEFS`), `stratagemArmHint(def)` (`좌클 홀드 → 위치 지정` topview / `좌클 투하 · 우클 취소` ground) and `stratagemTargetHint(def)` (`좌클 확정 · 우클 취소` / `좌클 투하 · 우클 취소`). |
| `hud/StratagemWheel.ts` | **Ship-call wheel** (`.swheel`, `pointer-events:none`, 280 px, `.show` fade): SVG ring of 4 annular sectors (`.sarc`) + 4 DOM `.ssector.<id>`s in `STRATAGEM_ORDER` (N 궤도 폭격, E 항공 폭탄, S 보급품 투하, W 구조물 투하; glyph tinted `--sc`, name, cooldown text `.cd` = the call's own cooldown, or the shared remaining seconds while cooling). Shown while `stratagem:wheelChanged.open`, `.hover` from `.hover`; `stratagem:cooldown.remaining > 0` → `.cooling` (sectors dimmed to 40 %, centre `.scd` `재충전 n초`), seeded from `ctx.stratagems.cooldown` when the wheel opens. Centre: `함선 호출` label, hovered call name (`—` when none) and its `STRATAGEM_DEFS.hint` (default `마우스로 선택 · G 놓기`). Closed on `player:died/downed`, `game:newMission/abort`. `isOpen` getter. **2026-09-09**: 목록이 `STRATAGEM_ORDER` 를 따라 N 궤도 폭격 · E 보급품 투하 · S 트라이포드 투하 · W 구조선 투하로 바뀌었고(항목은 여전히 4개, 이름은 `STRATAGEM_DEFS` 에서 읽는다), 구조선 칸은 쿨다운 대신 **남은 횟수 `n/5`** 를 보여 준다. 지금 무장할 수 없는 칸은 `.locked` (opacity 0.4) + `🔒 분대장 전용 / 대상 없음 / 소진` 한 줄이고 중앙 힌트도 그 사유로 바뀐다 — 판단은 이 파일이 export 하는 **`stratagemLockReason(ctx, id)`** 하나뿐이고, `STRATAGEM_HOST_ONLY` (계약 상수) 와 `ctx.stratagems.rescueLeft / rescueAvailable` 만 본다(stratagems 폴더 안을 들여다보지 않는다). `net:hostChanged` · `rescue:countChanged` 로 열려 있는 동안에도 다시 칠한다. |
| `hud/CommsWheel.ts` | **의사소통 휠 (`H` 홀드, 2026-09-09)** — `.cwheel`, 게임플레이 레이어, `pointer-events:none`, 280 px. 형제 휠 둘과 성격은 같지만 **입력까지 스스로 본다**: 의사소통에는 소유 시스템 폴더가 없고 `shared/comms.ts` 계약 + 채팅 + 네트워크만으로 끝나기 때문이다. (1) `Keys.COMMS` 를 `COMMS_WHEEL_HOLD_S` 넘게 누르면 열리고 (2) 포인터 락 델타를 누적해 `COMMS_WHEEL_DEAD_PX` 를 넘기면 그 방향 칸이 hover, (3) 키를 놓으면 그 한 마디가 나간다 — **톡 누르면 아무 일도 없다**. 열려 있는 동안 `ctx.player.setLookLocked(true)` (duck-type — `PlayerWeaponHost` 를 import 하지 않는다; **우리가 건 락만 우리가 푼다**). 배치는 `commsLayout(downed)` — 서 있으면 4칸(`COMMS_ALIVE` 가 정확히 N/E/S/W 순이라 `round(ang/(π/2))` 이 그대로 index 다), 전투불능이면 2칸(가로 우세 드래그만 고른다). 전투불능 여부를 매 프레임 다시 보므로 **휠이 열린 채 쓰러져도 그 자리에서 배치가 갈린다**. **문구는 여기서 쓰지 않는다** — `CommsDef.label` / `.line` 그대로이고 `{n}`·`{name}` 이 든 `contract` 만 `ctx.meta.activeContract` (`CONTRACT_MAX_ACTIVE` = 1 이라 "가장 가까운 하나" = 그 하나) 에서 이름과 `target − progress` 를 읽어 `fillCommsLine` 으로 채운다(계약 없음 → `fallback`). 보내면 `comms:sent {id, text, by:null, byName, slot, position}` + 로비가 있으면 `CommsMessage {t:'comm', id, text}` → `'others'`; 원격 `comm` 은 `COMMS_DEF_MAP` 으로 id 를 검증하고 text 를 120자로 잘라 같은 이벤트를 (`by`/`byName`/`slot`/`position` 채워) 낸다. **채팅 · 토스트는 `comms:sent` 하나만 듣는다**: 로컬이면 `chat:post {kind:'request'}` (ChatLog 가 내 이름을 붙이고 그 줄을 중계하므로 원격에도 `<이름>: 문장` 이 뜬다 — 핑 v3 콜아웃과 같은 경로), 원격이면 채팅을 다시 쏘지 않고 `ui:notify` 토스트만. 효과음은 `chat:message {kind:'request'}` 를 듣는 audio/ 가 낸다. 쿨다운 `COMMS_COOLDOWN_S` — 재충전 중에도 열리지만 `.cooling` + 중앙 `재충전 n초` 이고 놓아도 `ui_deny` 뿐. **blocker · 포인터 락 · ESC 스택 어디에도 손대지 않는다**, 그래서 키 가이드에도 올리지 않는다(가이드는 `Tab·Esc 닫기` 를 스스로 붙이는데 이 휠은 키를 **놓아서** 닫힌다) — 안내는 형제들처럼 중앙 한 줄(`마우스로 선택 · H 놓기`). `isOpen` / `hoverIndex` / `slotCount` getters. |
| `hud/PingWheel.ts` | **지역 핑 홀드 휠** (`.pwheel`, 2026-09-09) — 순수 표현 위젯. 제스처는 그대로 `hud/Pings` 가 보고 (`PING_HOLD_MAX` · `PING_DRAG_THRESHOLD_PX` · 누른 시점의 조준 광선까지 v2 그대로) 이 클래스는 `setOpen(open, downed)` / `setHover(side|'ammo'|null)` 로 그린다. 2026-09-09 이전의 한 줄 `.ping-hint` (`◄ 주의 · 돌격 ► · ▼ 탄약`) 를 대신한다 — **그 CSS 는 `base.css` 에서 지웠다**. 좌/우 반원 두 칸뿐이다 — **2026-09-10 에 아래 `▼ 탄약` 다리를 없앴다**(`H` 의사소통 휠 · 인벤토리 장착 무기 휠클릭이 같은 부탁을 이미 한다; 이제 아래 드래그는 평범한 핑이고 `setHover` 는 `PingSide | null` 만 받는다). 두 칸의 뜻은 `PING_HOLD_KINDS` 가 정한다: 서 있을 때 좌 = 여기 조심해(`caution`) · 우 = 저쪽으로 가자(`attack`), **전투불능이면** 좌 = 살려줘(`help`) · 우 = 나를 버려(`abandon`); 라벨은 `PING_HOLD_LABEL_KO`, 색은 `hud/Pings` 의 `PING_COLOR` 와 같은 값이다. `PingHoldKind` 를 `PING_HOLD_KINDS` 에서 **파생해** export 한다 (그 네 종류를 손으로 다시 적지 않는다). `isOpen` / `isDowned` / `kindOf(side)`. |
| `hud/HazardHud.ts` | **환경 재해 HUD** (2026-09-09). `ctx.world.hazard` (`HazardRef`) 와 `hazard:*` 만 본다 — world/ 가 아직 재해를 만들지 않는 동안 `hazard` 는 null 이고 이벤트도 오지 않으므로 통째로 잠들어 있다. 세 부분: **예고/시작 배너** (`.hz-banner`, 상단 중앙 104 px — 나침반 22 · 탈출 카운트다운 64 **아래**) 는 `hazard:announced {kind, secondsLeft}` 에 뜨고 **남은 초를 로컬에서 센다** (예고는 이벤트 한 번이지 매 초 오지 않는다), `hazard:started` 에 `<이름> 시작` 으로 3초; 둘 다 `ui:notify` + `wave_alarm` 을 한 번씩 낸다. **안전지대 게이지** (`.hz-prog`) 는 `hazard:progress` / `HazardRef.progress` 를 **남은 안전지대(`1 − progress`)** 로 뒤집어 그리고 20 % 아래면 `.critical`; `ui:objective` 는 **건드리지 않는다** (그 한 줄은 미션 플로우 것이라 탈출 카운트다운을 덮어쓴다). **위험 구역 경고** 는 `hazard:insideChanged` 로 `.hz-inside` 상시 한 줄 + 오버레이 레이어의 `.hz-edge` 붉은 맥동 + 들어갈 때 `wave_alarm`. 덤으로 **안전 방향 화살표** (`.hz-arrow`, `--rot`): `getZones()` 의 각 구역에서 벗어나는 방향의 합 (`front` 는 법선, `circle` 은 `safeInside` 면 중심 쪽 · 아니면 바깥쪽) 을 카메라 기준 상대 각으로 돌린다 — 나침반을 건드리지 않고 이 블록 안에서 끝난다. 스타일은 `styles/hazard.css`. `isBannerOn` / `isInside` / `safeShare` getters. |
| `hud/RaidAlerts.ts` | **레이드 알림** (2026-09-09) — DOM 이 하나도 없는 이벤트 → 토스트 변환기다(그리는 일은 `hud/Notifications` 가 한다). ① **새 랜드마크 발견**: `fog:discovered` 의 `structure` · `rail` · `grove`. 구조물은 `ctx.world.getStructures()` (실패하면 `structureAt`) 에서 `StructureKind` 를 찾아 `STRUCTURE_LABEL_KO` 로, 선로는 `getRailLines()` 에서 `RAIL_LABEL_KO` 로 이름을 붙인다. **`world/Fog` 의 `TOAST` 표에 이 셋을 넣으면 토스트가 두 번 뜬다** — 넣지 않기로 한 자리다 (신호소 · 둥지는 계속 Fog 가 띄운다). ② **로그 강하 예고**: `rogueDrop:incoming` → `적 n명 강하 감지 (분대장 포함) — n초` danger 토스트, `dropId` 로 한 번만. **2026-09-10: 소리는 여기서 내지 않는다** — `wave_alarm`(벌레 웨이브와 같은 소리였다)을 걷어냈고 `audio/AudioSystem` 이 같은 이벤트로 `rogue_drop_alarm` 을 울린다 (거리 감쇠가 붙은 소리라 크기를 정할 수 있는 곳이 거기뿐이고, 한 사건에 두 폴더가 경보를 울리면 겹쳐 난다). 화면 표시는 `hud/DangerIndicators` 가 그린다. |
| `hud/StratagemPanel.ts` | **함선 호출 썸네일** (`.scall`) — **전술 임플란트 바로 왼쪽**, 화면 중앙 하단. **2026-09-10 (2차, 사용자 결정):** 우측 하단 무기 열의 텍스트 패널(`.strat-panel` — `G` 키캡 + 호출 이름 + 설명 한 줄 + 조작 힌트 + 가로 쿨다운 바)을 통째로 걷어내고 **정사각 썸네일 하나**로 바꿨다 — 글자는 전부 없앴고 썸네일 + 그 아래 `G` 키캡뿐이다(조작 설명은 `G` 를 꾹 눌러 여는 휠 가운데가 그린다). **쿨타임은 `hud/ImplantWidget` 과 똑같이 그린다**: 딤드 + `--fill` 이 아래에서 위로 차오르며 밝아짐 + 한가운데 남은 초(10초 미만은 소수 한 자리, 같은 `secs` 규칙). 네 호출이 **하나의 쿨타임을 공유**하므로(`StratagemSystem._cooldown`) 이 썸네일 하나가 곧 전체 상태다. **글리프는 무장 중이면 그 호출, 아니면 마지막으로 무장했던 호출** — `G` 탭이 바로 그것을 다시 무장하기 때문이다. `lastArmed` 를 `StratagemsRef` 에 새로 뚫지 않고 `stratagem:armed` 의 null 아닌 id 로 같은 값을 따라 만든다(초기값은 시스템과 같은 `STRATAGEM_ORDER[0]`). 무장하면 테두리 · 키캡이 그 호출 색(`STRATAGEM_COLOR`)이 되고 한 번 `pulse` 한다. 구조선을 손에 들었을 때만 우하단에 분대 공용 잔여 횟수(`rescue:countChanged`, `3/5`). `.off` = `ctx.stratagems` 도 없고 이벤트도 아직 없음, `.blocked` = UI blocker. 조준 중에는 **남는다**(임플란트는 `.hud.targeting` 으로 사라진다 — 무엇을 들었는지 보여야 한다). 스타일 `styles/shipCall.css`, getters `armedId` / `shownId` / `fillAmount` / `isDimmed`. |
| `hud/RescuePicker.ts` + `hud/rescuePicker.css` | **구조선 대상 선택 화면** (`.rescue-pick`, 2026-09-09). 구조선 투하만 흐름이 다르다 — 지면을 찍기 **전에** 누구를 되살릴지 고른다. 그래서 이 위젯은 이벤트가 아니라 `ctx.stratagems` 를 폴링해 스스로 뜬다: `armed === 'rescue_drop' && rescueTarget === null && isGameplayPhase()`. 분대 슬롯 그대로의 1×4 칸(`getRescueCandidates()` + 빈 자리)을 그리고 **죽은 대원만** 고를 수 있다(살아 있거나 전투불능이면 회색 `작전 중`); 시체 좌표를 아는 칸은 그것도 적는다. 마우스 클릭 또는 `1`~`4`(raw `Digit1..4` — 분대 슬롯에는 리바인딩 키가 없다), **우클릭 · Escape · Tab** 으로 취소. 고르면 `rescue:selectTarget {peerId}`, 취소는 `{peerId:null}` (stratagems 가 호출을 내려놓는다). 열려 있는 동안 자기 blocker(`'rescuePick'`)와 커서를 쥐므로 그 사이 조준은 저절로 멈춘다(`isGameplayActive()` 가 거짓). `ui:keyGuide {owner:'rescue'}` 규약을 따르고 (`Tab 닫기` 는 가이드가 스스로 붙인다), **Escape 는 이 화면이 먼저 먹는다**(가장 안쪽 화면 예외, capture phase). 스타일은 자기 스타일시트(`inventory.css` · `title.css` 와 같은 방식, `base.css` 는 건드리지 않는다). `isOpen` / `selectableCount` getters. |
| `hud/ChargeGauge.ts` | **Charge ring** (`.charge`): full-circle SVG ring (radius 48 px, CookGauge look, `stroke-dasharray` on the circumference) around the reticle while `stratagem:chargeChanged.t ≥ 0`, label `위치 지정까지 n.n s` (= `(1 − t) × STRATAGEM_CHARGE_TIME`), `.ready` red pulse at 1. Hidden on `t = −1`, `stratagem:targeting {active:true}`, `stratagem:armed {id:null}`, death / down / mission reset. |
| `hud/TargetingHud.ts` | **Targeting frame** (`.targeting-hud`, `pointer-events:none`): on `stratagem:targeting {active:true}` calls the `onToggle` callback (HudSystem adds `.targeting` to the gameplay root → reticle hidden) and shows `.show`: centre `.frame` with 4 `.corner` brackets (72 px, `.topview` 120 px), `.head` glyph + `<name> — 위치 지정` (tinted `--sc`), `.dist` = horizontal distance from the last `position` to `ctx.player.position` (updated each frame, `n m`), `.hint` `좌클 확정 · 우클 취소` (topview) / `좌클 투하 · 우클 취소` (ground). `position` is refreshed from every `stratagem:targeting` event while active. Removed on `active:false`, `stratagem:armed null`, death / down / mission reset. `isActive` getter. |
| `hud/OffscreenIndicators.ts` | **Off-screen indicators** (`.offscr`, gameplay layer): pool of 12 `.oarrow`s (triangle `.tip` rotated by `--rot` + `.body` glyph/label tinted `--oc`). Targets collected each `lateUpdate`: **(a)** `ctx.weapons?.getGrenades()` → `.grenade` (● amber, label fuse `n.ns`, `.hot` red pulse < 1 s); **(b)** pings from `ping:placedV2` — **2026-09-09 (핑 v3): own pings too (any `owner`), kept for the ping's whole lifetime (`until = expires` from the event; the shared `OFFSCREEN_PING_SECONDS` is no longer read here)**, dropped on `ping:removed` → `.ping.<kind>` (icon ◆▲■◇◈➤⚠ by kind, `PING_COLOR`, label `PING_LABEL`, fades over the last 1.5 s; the arrow hides while the ping is on screen — the marker shows then); **(c)** ship calls from `stratagem:called` → `.call.<kind>` (glyph/colour from `stratagemGlyphs`, label `n초` until `landsAt`, then the call name), removed on `stratagem:landed` (airstrike / supply / structure) or `stratagem:ended` (laser; laser/airstrike tips pulse). Projection: `position + 0.6 m` through `ctx.camera`; inside the viewport minus a 6 % margin and in front → no arrow; otherwise the centre→point direction is clamped to a rect 44 px inside the viewport and the arrow points along it; behind the camera → mirrored and forced to the lower half. Nearest 12 (to the player) win; DOM written only when the rounded key changes. Cleared on `game:newMission/abort`. `visibleCount` getter. **2026-09-09**: 네 번째 갈래 **(d) 로그 강하** (`.oarrow.drop(.boss)`) — `ctx.enemies.getRogueDrops()` 를 매 `lateUpdate` 에 직접 묻는다 (예고에서 착지까지 살아 있는 목표라 캐시한 이벤트보다 매니저의 목록이 정확하다). ⬇ 호박색(보스면 빨강), 라벨은 착지까지 `n초` → 그 뒤 `로그 n` / `로그 분대장`. 토스트와 경보는 `hud/RaidAlerts` 가 낸다. `PING_ICON` 에 `help ✚ · abandon ✖ · structure ⬢ · rail ═` 가 계약과 함께 들어왔다.  **2026-09-10 (위험 인디케이터 통합):** 갈래 **(a) 수류탄** 과 **(c) 함선 호출** 이 이 파일을 떠나 `hud/DangerIndicators` 로 갔다 — 날아오는 위험물은 화면 안이면 머리 인디케이터 · 밖이면 크로스헤어 둘레의 방향 호라는 하나의 언어로 그리고, **같은 목표를 두 위젯이 그리지 않는다**. 여기 남은 것은 핑과 로그 강하뿐이고 `stratagem:*` 구독 · `stratagemGlyphs` import 도 함께 지웠다. **2026-09-10 (로그 강하 경보):** 갈래 **(d) 로그 강하**도 같은 이유로 `hud/DangerIndicators` 로 갔다 — 화살표만 있으면 강하가 **화면 안에 들어온 순간 표시가 사라졌다**(강하가 조용했던 이유 중 하나). **남은 갈래는 핑 하나뿐**이고 `Cat` 도 `'ping'` 으로 좁혔다. `.oarrow.grenade` / `.call` 처럼 `.drop` 규칙도 CSS(`styles/base.css`)에는 남아 있다 — 인라인 `--oc` 로만 칠하던 갈래라 지울 규칙도 사실상 없다. |
| `hud/HoldGauge.ts` | **홀드 진행 링 at the crosshair** (`.hold`, 2026-09-08). One place for every hold in the game, the way 재장전 / 회복약 already were: the eye is on the reticle during a hold, not on a 3 px bar at the bottom of the screen or in the corner of the vitals block. Same shape as `ReloadGauge` (`SIZE 120` / `RADIUS 48`, `svg` rotated −90°, `stroke-dasharray`), fed by two events and driven by them alone (no local countdown — both emitters send progress per frame): `interact:promptChanged {holdProgress}` for any `Interactable.holdTime` (상자 · 시체 · 부활 · 채집 · 스위치) and `player:giveUpProgress {t}` for the Space 포기 hold while 전투불능, which **wins** when both are live and adds `.is-giveup` (a `포기` label and the danger colour). The state colour rides an inherited custom property (`--hc`, the `hud/WeaponChargeGauge` `--wc` pattern) rather than a descendant selector. The 포기 branch is gated on `ctx.player.isDowned`, so a stale progress event outside the downed state never lights it. `player:revived` / `player:died` / `player:respawn` / mission reset clear it. `isShowing` / `progress` / `isGiveUp` getters (`HudSystem.isHoldGaugeOn` / `holdGaugeProgress` / `isHoldGaugeGiveUp`). |
| `hud/Vitals.ts` | Bottom-left. **2026-09-10 (레이드 HUD 개편, 사용자 결정):** 위에서부터 **이름**(`.vt-name`) · **실드 게이지**(`.sh-bar`) · **체력 게이지**(`.hp-bar`) 세 줄이고 **체력 수치(`.hp-num`)와 `생명력` 라벨은 없어졌다**. 두 게이지는 폭 · 정렬 · 눈금이 같다 — 한 칸 = `ARMOR_SHIELD_PER_SEGMENT`(20, `data/constants.csv`) 라 체력 100 은 **5등분**이고 실드 칸 수는 `maxShield / 20` (일반 1 · 고급 2 · 희귀 3 · 서사 4 · 전설 5). 칸 색은 방탄복 등급색(`rarityColor(ctx.player.shieldRarity)` → `--shc`), 값은 `ctx.player.shield / maxShield` 폴링 + `player:shieldChanged` (둘 다 본다). **방탄복이 없으면(`maxShield` 0) 실드 줄은 통째로 `hidden` 으로 접혀** 이름 + 체력만 남는다 (전투불능 동안에도 접힌다). 이름은 `ctx.net.playerName`(= 캐릭터 이름) → `ctx.progression.profile.name` → `스캐빈저` 순으로 고르므로 싱글 플레이에서도 나온다. 칸 DOM 은 **칸 수가 바뀔 때만** 다시 만든다(`setCells`). 게이지 자체는 예전 그대로 — smooth drain + 지연된 흰 "damage ghost", thin stamina bar (`.stamina`, polls `ctx.player.stamina/maxStamina`, damped; `.full` dims to 40 %, `.low` < 25 % amber, `.depleted` amber pulse on `player:staminaDepleted`), and nothing else — **2026-09-07** the 회복약 / 수류탄 pills under the bar are gone (both counts read off the right-hand column: the `QuickStrip` thumbnail and `WeaponPanel`'s consumable block), so this corner is health + stamina only. Reads `ctx.player.hp` each frame. **Downed mode** (`.vitals.downed`, `player:downed` → `player:revived` / `player:spawned` / `player:died` / `game:newMission` / `game:abort`): the bar snaps to and shows `downHp / PLAYER_DOWN_HP` in red (`player:downHpChanged`; polled from `ctx.player.downHp` while `ctx.player.isDowned`), label `전투불능 — 아군의 구조 대기 중`, `.down-sub` `Space 길게: 포기`, stamina bar hidden; `player:reviveProgress {t, byName}` → `.revive.show` `부활 중 <byName> … n%` + green progress bar (hidden on `t = -1`). **Phase 9 → 2026-09-08**: the Space give-up hold shows a red `포기` **caption** (`.giveup.show`, `player:giveUpProgress {t}` from player/, `t < 0` hides it) — and leaving the downed state hides it too, so a revive / respawn never leaves a stale one. The progress bar that used to sit under it moved to the crosshair ring (`hud/HoldGauge`, `.hold.is-giveup`). Debug: `HudSystem.isGiveUpBarOn`, `shieldSegments` / `displayName` getters. 스타일은 `styles/raidHud.css`. |
| `hud/ScopeOverlay.ts` | `.scope` full-screen sniper overlay (in the overlay layer): radial-gradient black mask with a clear circle (`--scope-r`), lens vignette, 4-arm crosshair with mil-dot ticks, zoom label (`4×`). Shown while `weapon:scopeChanged.scope` is true **and** `player:aimChanged.aiming` and gameplay is active; `.show` toggles (120 ms in / 80 ms out via CSS). Never intercepts pointer events. |
| `hud/Pings.ts` | **Pings v3 (2026-09-09)** — the v2 text below still describes the gesture / marker / beacon / tracking; v3 changes on top: **① 함선 안에서도 핑이 된다** — the gate is `ctx.isControlActive()` (gameplay OR hub) + pointer lock; in a ship (`ctx.isHubPhase()` / `ctx.hub.active`) the ray hits `ctx.hub.collider.raycast` (miss → 12 m along the ray at `getFloorAt`), always kind `ground`, no snapping; relayed only while `ctx.net.lobby` exists; remote pings are accepted in gameplay **and** hub phases; `hub:entered` / `hub:left` clear every ping. **② 플레이어당 3개** (`PING_MAX_PER_PLAYER`): me and each squadmate may hold 3 live pings, a 4th evicts that player's oldest (`evictFor`) — the "one live ping per remote sender" rule is gone. **③ 모든 핑이 채팅 한 줄** (`chat:post {kind:'ping'}`, distance appended): `핑 (32m)` · `적 발견 (32m)` · `보급 상자 (n등급) 여기 (32m)` · `탈출 지점 (32m)` · **`<아이템 이름> 여기 있음 (32m)`** · `돌격!` · `주의!`; remote pings post nothing locally (the sender's line comes through the chat relay). **④ 화면 공간 조준 보정** (`PING_AIM_ASSIST_PX`, plain gesture pings only — not 돌격 / 주의, not the map's `placeAtWorld`): candidates are projected and the nearest to the crosshair within the radius wins if in front and unoccluded (`screenDistance`: frustum + `world.raycast` / `hub.collider.raycast`); priority (1) a squadmate's ping → **ack**, (2) living enemies at chest height, (3) pickups (`ctx.pickups.getPickups()`), (4) crates, (5) pads; same priority → smallest screen distance; nothing → the exact ray path. **⑤ 확인 핑 "알겠다"**: aiming at a squadmate's ping (own pings and legacy pings without `seq` are not candidates, nor one I already acked) places nothing — the acker posts `chat:post {text:'알겠다고 확인.', kind:'ping'}` (the chat prefixes the name → `<이름>: 알겠다고 확인.` for everyone), sends `PingAckMessage {t:'pingack', owner, seq}` to `'others'`, and every client that has the ping (owner peer id + sender-local `seq`; the owner finds its own by its own `seq` via `ctx.net.localId`) adds the acker's `NET_SLOT_COLORS[slot]`: a thin flat ground ring outside the base ring (`ackGeo(index)`, nested per acker) + a coloured dot in the marker's `.pmarker .acks` row; `acks: {id, slot}[]` on the ping, duplicates from the same peer ignored; emits `ping:acked {id, by, name, slot}` (`by` null = local). Every local ping carries `seq` (`PingMessage.seq`, incrementing counter); remote pings store the sender's `seq`; incoming numbers are validated. `PingView` gained `acks`. **⑥ 탄약 요청 문구** = `탄약 필요: <탄종>` (**2026-09-10 에 이 제스처 자체가 삭제됐다** — 아래 문단 참조; 같은 문구는 인벤토리 휠클릭 `InventoryRef.requestItem` 이 계속 낸다). — **v2:** Middle mouse (`MouseButtons.PING`) while gameplay active + pointer locked + alive, 0.3 s cooldown. **Gesture = hold + drag** (pointer-locked `ctx.input.mouseDX/DY` accumulated per frame while held): on release `dx ≥ +PING_DRAG_THRESHOLD_PX` → `attack` (돌격), `dx ≤ −threshold` → `caution` (주의), (**아래 드래그의 ammo request 는 2026-09-10 에 삭제됐다** — `classify()` 는 이제 세로 성분을 아예 보지 않고, `weapon:equipped` / `loadout:changed` 구독과 `AMMO_TYPE_KO` 표도 함께 없앴다), otherwise a plain ping. Holding longer than `PING_HOLD_MAX` locks the gesture to a plain ping (hint hides). Directional pings use the aim ray captured at **press** time (the drag turns the camera), plain pings the ray at release. A press+release inside one frame still pings. `.ping-hint` (`◄ 주의 · 돌격 ► · ▼ 탄약`) fades in after 150 ms of holding and highlights the active direction (`.caution/.attack/.ammo`). **Targets:** ray (≤ 300 m) vs `ctx.enemies.raycast` / `ctx.world.raycast`, else 120 m clamped to terrain; enemy hit → `enemy`; else `ctx.pickups.findNear(point, 2)` → `item` (label `이름 ×n`); ≤ 2.5 m of a crate → `crate` (label `보급 상자 (n등급)`); ≤ 8 m of a pad → `extraction`; else `ground`. **Enemy tracking:** the marker follows the enemy only while it is *visible* to the local camera (inside the frustum **and** `ctx.world.raycast(camera → enemy)` hits nothing closer; re-checked every 0.1 s). Out of sight → marker parks at the last seen position, `.lost` (dimmer marker/beacon), label `적 (마지막 위치)`; snaps back when visible again. Enemy dies → detached, ping expires within 1.5 s. Each ping = projected DOM marker (`.pmarker.<kind>`: icon, label, live distance) + scene beacon (additive emissive 6 m line + pulsing ground ring; shared geometries, per-ping materials). Max 3 **local** pings, expire after `PING_LIFETIME`, fade the last 2 s. **Chat callouts:** `item`/`crate` → `chat:post {text:'아이템 발견: <label> (<d>m)', kind:'ping'}`, `attack` → `돌격!`, `caution` → `주의!`. Emits `ping:placed` **and** `ping:placedV2 {…, owner}` (`null` = own ping, else the sender's `PeerId`) / `ping:removed` for local **and** squad pings. **Multiplayer:** local pings are sent as `PingMessage {t:'ping', p, kind, label?, enemyId?}` to `'others'` whenever `ctx.net` has a lobby; incoming pings are read through `ctx.net.onMessage('ping')` (full message; `net:remotePing` is only used when no net module exists) and rendered as `.pmarker.remote` in the sender's `NET_SLOT_COLORS[slot]` with `이름 · 라벨` (one live ping per sender; `enemy` pings latch onto the enemy with the same `enemyId`, else the nearest enemy ≤ 2.5 m, and then track visibility locally). Ignored outside gameplay phases (hub). `player:died` clears only own pings; `net:remotePlayerRemoved` clears that peer's. `getPings()` → `PingView[]` (`owner`, `label`, `lost`) for the map. **Phase 10:** the tail of the private ray-based `place()` (eviction → `build` → `ping:placed` / `placedV2` → chat callout → relay) is now `placeResolved(...)` and the crate / pad / pickup snapping is `snap(ctx, pos)`, so the new public **`placeAtWorld(position, kind = 'ground')`** (also reachable through the `ping:requestAt` event, which this component subscribes to) can ping a world point from a surface with no aim ray — the tactical map's middle-click. It **skips** the `canPing` gate (pointer lock + `isGameplayActive()`, which a map blocker fails by definition) but keeps `MAX_PINGS`, the 0.3 s cooldown, the terrain clamp + `getHeightAt` snap and the same snapping, so a map ping dropped on a crate still reads `보급 상자 (n등급)` and still reaches the squad. Exports `PingKind` (re-export of the shared type), `PingView`, `PingOwner`, `PING_LABEL`, `PING_COLOR`. **2026-09-09 (레이드 플레이 개선) — 홀드 제스처가 보이는 휠이 됐다.** `.ping-hint` 한 줄은 사라지고 `hud/PingWheel` 이 좌/우 2칸 휠 + `▼ 탄약` 다리를 그린다 (`HINT_DELAY` 0.15 s 는 그대로, 열고 닫을 때 **`ping:wheelChanged {open, downed, hover}`** 를 낸다). `Gesture` 가 `attack`/`caution` 대신 **`left`/`right`** 다 — 그 두 쪽이 어떤 `PingKind` 가 되는지는 `PING_HOLD_KINDS` 가 정하고, 로컬 플레이어가 **전투불능**이면 `help`(살려줘) / `abandon`(나를 버려) 이 된다 (그 둘도 다른 핑과 똑같이 월드 마커 · 지도 · 채팅 · 오프스크린 화살표에 나온다). 배치는 **누른 순간에 고정**(`holdDowned`)돼 드래그 도중 부활해도 뜻이 뒤바뀌지 않는다. **2026-09-10 (사용자 결정): 아래 드래그의 탄약 요청을 없앴다** — `H` 의사소통 휠과 인벤토리의 장착 무기 휠클릭이 같은 부탁을 이미 하고 있어 제스처가 겹쳤다. 이제 세로 드래그는 서 있든 전투불능이든 그냥 평범한 핑이다. `chatLine` 은 네 방향 kind 를 모두 `<PING_LABEL> (32m)` 로 쓴다 — v2 의 `돌격!` / `주의!` 는 라벨 자체가 바뀌었고(`저쪽으로 가자` · `여기 조심해`) `살려줘` 는 **어디서** 왔는지가 핵심이라 v3 의 "모든 핑 줄에 거리" 규칙을 따른다. `isHoldWheelOpen` / `isHoldWheelDowned` getters. |
| `hud/ChatLog.ts` | **Chat log** (`.chat`, social layer; bottom-left above the vitals, at the bottom in the hub / while spectating). Lines `[HH:MM] 이름: 텍스트` (`.chat-line.<kind>`: `text` default, `ping` cyan italic, `request` amber bold, `system` grey italic, `.me` = own line, accent name), rendered with `textContent` (no HTML injection). Max `CHAT_MAX_LINES`; lines get `.faded` ~12 s after arrival unless the input is open (then the full log shows in a 300 px panel with a scrollbar; wheel scrolls). **Closed height (2026-09-09): exactly 3.5 line pitches** — `measure()` reads one real line's height and sets `--chat-closed-h` (3 lines + 3 gaps + half a line) on `.chat`, so the fourth-oldest visible line is cut in half at the top under the fade mask. **Stick-to-bottom (2026-09-09):** `stick()` pins `scrollTop` now *and* on the next frame, and runs on add / open / close / `document.fonts.ready` / a `ResizeObserver` on `.chat-lines` — the old single `scrollTop = scrollHeight` after `appendChild` was defeated by `close()` shrinking the box (a scroll container keeps its `scrollTop`, not its bottom edge) and by the web font swapping in after the first lines. **Input:** `Keys.CHAT` (Enter) while `ctx.isControlActive()` (gameplay **or** hub, no blockers) opens the field — blocker token `'chat'` plus `ctx.input.setCursorMode(true, 'chat')` (**2026-09-07**: that call now *releases* the lock and `main.ts` re-locks when the last owner leaves — the per-screen `exitPointerLock()` / relock microtask stay gone; `close(relock)` keeps its parameter for the existing call sites but ignores it). **2026-09-09: Enter sends (`chat:post {kind:'text'}`, ≤ 120 chars) and keeps the input open** — cleared, focused, the row never hidden so its `objSwap` entrance does not replay; an empty Enter is a no-op. **2026-09-09 (later) — 한글 IME:** the Enter that *commits* a composing syllable fires `keydown` with `isComposing` / legacy `keyCode 229` before `compositionend`, so sending on it cleared the field and the IME re-inserted the last syllable ("안녕" → posted "안녕", "녕" left behind). The capture handler now defers Enter / Esc while `e.isComposing`, `e.keyCode === 229` or the input's own `compositionstart`→`compositionend` window (`composing` flag) is open — a composing Tab only keeps focus; a composing **Enter** is remembered (`sendAfterCompose`) and `send()` runs one tick after `compositionend`, so Korean still posts one clean line on a single Enter. **Tab (`Keys.INVENTORY`) closes** (consumed via `ctx.input.consume` so the inventory does not open) and Esc keeps its behaviour (drop the whisper target on an empty input, else close); on close the token and the cursor-mode ownership are both released. Row layout: `.chat-prompt` › · `.chat-target` chip · `.chat-input` (`flex:1; min-width:0`, single line, text scrolls inside) · **`.chat-hint`** flush right (`.keycap` = live `keyLabel(Keys.INVENTORY)`, refreshed on `input:bindingsChanged`, + `.chat-hint-t` `키로 닫기`) — the old `120자` hint is gone; placeholders read `메시지 입력… (Enter 전송)` / `귓속말 입력… (Enter 전송 · Esc 대상 해제)`. Capture-phase `keydown` listener on `window` with `stopImmediatePropagation` for Enter/Tab/Esc; the input element stops propagation of everything else so letters never reach `Input`. Emits `ui:chatToggled {open}` (the 키 가이드 hides on `open:true` — the chat carries its own close hint). **Feeds:** `chat:post` → own line (`ctx.net?.playerName ?? '나'`) and, while `ctx.net.lobby` exists, `send({t:'chat', text, kind}, 'others')`; `net:chat` → remote line (`kind ?? 'text'`); system lines: `net:peerJoined` (`{name} 합류`), `net:peerLeft` (`{name} 이탈`), `pickup:taken` when not local (`{byName}이(가) {item} 획득`), `hub:slotChanged` (`{name}이(가) 발사 포드 n에 탑승` / `발사 포드 n 비움`), `hub:launchCountdown` (`발사 n초 전 (r/t 탑승)`, `발사!` at 0; deduped per second); **Phase 7:** `net:hostChanged` → `호스트 변경: <name>` (lobby list → remote ref → own name when `isLocalHost`, else `분대원`), `net:peerSuspended` → `<name> 연결 끊김` / `<name> 재연결`, `game:newMission {mode:'training'}` → `시뮬레이션 훈련장 입장`, `training:exitRequested` → `시뮬레이션 훈련장 퇴장`. Every line emits `chat:message {id, name, text, kind, local}`. Closes on `game:newMission` / `game:abort` / leaving gameplay+hub phases. Works as a local log in single-player. **Phase 11 — 귓속말:** `chat:whisperTo {code, name}` (from the ESC column / community panel's 귓속말하기) opens the input in whisper mode with a `.chat-target` `→ 이름` chip; Enter then goes out through `socialOf(ctx).whisper(code, text)` instead of `chat:post`, and the sender writes **no** local echo — the mirror answers with `social:whisper {line}` and *that* draws the `kind:'whisper'` line for both directions (`귓속말 → 이름:` out, `귓속말 이름:` in). `whisper()` returning false leaves a system `귓속말 전송 실패 — …` line. The target survives a close (the next Enter whispers too) and is cleared by the chip's `×`, by Escape on an empty input, or by `game:newMission` / `game:abort`; while it is set the bottom-left column is raised to mid-screen (`.hud-bl.whispering`, toggled on the log's `.hud-bl` parent). `whisperTarget` getter. |
| `hud/Squad.ts` | **Multiplayer.** Compact squad list (`.squad`; since the Phase 9 UI pass it sits in the bottom-left `.hud-bl` column **above the vitals**, next to the player's own health bar, instead of top-left under the objective — the column drops to the bottom edge in the hub / while spectating, and `.hud-bl > .squad.hidden` collapses outright so it reserves no gap) visible while `ctx.isMultiplayer` **or** in the shared ship (hub / docking phase with `ctx.net.lobby`): per row a slot colour bar (`--sc`), name, 3 px hp bar (`scaleX`), state text. Local player first (`ctx.net.playerName` + `(나)`), then `ctx.net.lobby.players` by slot with `getRemotePlayer(id)`. States: `연결 끊김` (`SUSPENDED_LABEL_KO`: `LobbyPlayer.connected === false`, `RemotePlayerRef.suspended`, `!ref.connected || stale`, or the local socket is down → `.off.suspended` grey), `전사`, `강하 중` (`PlayerFlags.DROPPING`), `연결 중` (no snapshot yet); in the hub `함선 내` / `탑승 준비` (`LobbyPlayer.ready`, `.ready` green). **Phase 7 badges** (`.badge` between name and state, only while `lobby.started`): `훈련장` (`.training`, `lobby.mode === 'training'` + `inMission`), `임무 중` (raid + `inMission`), `함선` (`.ship`, not in the running mission); `LobbyPlayer.inMission` undefined reads as `started && connected`, the local row falls back to "in a mission phase". `net:lobbyUpdated` / `net:missionMembership` / `net:peerSuspended` force the next refresh. `setDebug(lobby, refs)` = smoke hook (synthetic lobby + refs from `remotePlayers.debugSpawn`, judged on their own fields). Refreshes at ≤ 10 Hz and writes the DOM only when a row's key changed. Rows pooled (`NET_MAX_PLAYERS`). **Phase 9:** a suspended member's host ghost shows on its row — `ref.ghostState === 1` overlays a red bleed bar (`.bleeding`, `ghostDownHp / PLAYER_DOWN_HP`) on the grey hp bar and `ghostState === 2` reads `사망` (`GHOST_DEAD_LABEL_KO`) instead of `연결 끊김`. |
| `hud/Nameplates.ts` | **Multiplayer.** One pooled `.nameplate` per remote player: name + 46 px hp bar in the slot colour, projected from `ref.avatar.getHeadPosition()` + 0.35 m each `lateUpdate`. Active in missions **and** in the hub / docking phases (shared-ship avatars). Hidden when `avatar` is null, `!connected`, `stale`, `DROPPING`, **`IN_POD`**, behind the camera, off-screen or > 150 m (fades from 110 m; `.far` > 60 m drops the hp bar; `.dead` strikes the name through). Removed on `net:remotePlayerRemoved`, cleared on `net:lobbyLeft` / `game:abort` / `game:newMission`. **Phase 7:** a `RemotePlayerRef.suspended` member (socket down, ghost body kept) stays visible although `stale`: `.suspended` swaps the inline `--sc` to grey `#9aa0aa` and shows a `연결 끊김` tag (`.tag`, `SUSPENDED_LABEL_KO`) under the name (hidden on `.far`). `setDebugRefs(refs)` = smoke hook rendering extra refs (`remotePlayers.debugSpawn`) next to `ctx.net`'s list. **Phase 9:** the host ghost's state now shows on the plate — `ref.ghostState === 1` (downed) overlays a red bleed bar (`.bleeding`, `.hp .bleed` scaled by `ghostDownHp / PLAYER_DOWN_HP`) on the grey hp bar, and `ghostState === 2` (bled out) swaps the tag to `사망` (`GHOST_DEAD_LABEL_KO`, exported for `Squad`) and strikes the name through. Both are part of the plate's change key, so the DOM is still only touched when something moved. **2026-09-11 (C-19): 원격 실드 바.** 체력 바 바로 위에 얇은 `.sh` 바(46 × 2 px, 분리 바 — 체력 칸에 이어 붙이지 않는다: 가득 찬 실드가 그 밑의 체력 손상을 가리지 않게)가 `ref.shield / ref.maxShield`(`PlayerSnapshot.sh / shm`, 방탄복을 입었을 때만 실린다 — `shield` 없이 max 만 오면 가득으로 읽는다)를 그린다. `.has-shield` 는 `maxShield > 0` 이고 **전투불능(`isDowned` / `DOWNED`) · 사망 · 연결 끊김이 아닐 때만** 붙고 (고스트는 와이어에 실드가 없다 — `net/RemotePlayer.applyGhost` 가 지운다), `.far` 에서는 체력 바와 함께 숨는다. 색은 로컬 `Vitals` 실드 칸과 같은 **방탄복 등급색**(`--shc` ← `ctx.loot.getItemDef(ref.armorId).rarity`, `armorId` 가 바뀔 때만 다시 푼다). 실드 비율이 plate 의 change key 에 들어간다. |
| `hud/TypingBubbles.ts` | **입력 중 말풍선** (`.typing-bubbles` / `.tbubble`, social layer, 2026-09-09). For every **remote** player whose snapshot carries `PlayerFlags.TYPING` (net raises it while the chat input is open; never for the local player) a small dark rounded bubble with three dots (`<i>` × 3, CSS `tbubbleDot` scale 0.6→1.2, `animation-delay` 0 / 0.15 / 0.3 s) is projected from `avatar.getHeadPosition()` + **0.7 m** (Nameplates' 0.35 + 0.35 so it rides just above the plate). Same gating as `Nameplates`: missions and the hub / docking phases, hidden when `avatar` is null, `!connected`, `stale`, `DROPPING` / `IN_POD`, behind the camera, off-screen or > 150 m (fades from 110 m). Elements are created lazily per peer the first time they type and pooled; removed on `net:remotePlayerRemoved`, cleared on `net:lobbyLeft` / `game:abort` / `game:newMission`. `HudSystem` constructs it right after `Nameplates`, binds / disposes it with the core widgets and runs `typing.lateUpdate(ctx)` next to `nameplates.lateUpdate` while the social HUD is visible. `visibleCount` getter. |
| `hud/SpectateOverlay.ts` | **Multiplayer.** `.spectate` banner (`pointer-events:none`, no blocker token) shown on `player:died` while `ctx.isMultiplayer`: `전사 — 분대원의 구조선을 기다립니다` + `남은 분대원 n` (refreshed 4 Hz; `분대 전원 전사` at 0) + **`.rescue` line** = 분대 공용 `ctx.stratagems.rescueLeft` (`남은 구조선 n`, 0 이면 `남은 구조선 없음` + `.none` 펄스), `rescue:countChanged` / `rescue:called` 에 즉시 갱신. **2026-09-09: 부활 카운트다운도 Space 도 없다** — 자동 부활이 사라졌고 되살아나는 길은 분대원의 구조선뿐이라 이 배너는 순수 표시다. Hidden on `player:spawned`, non-gameplay `game:phaseChanged`, `game:abort`, `game:newMission`. |
| `hud/WeaponPanel.ts` | Bottom-right (`.weapon`). **2026-09-10 (레이드 HUD 개편, 사용자 결정):** 패널 위의 **슬롯 칸(`.wslots`)과 아래의 주무기 키 · 무기 이름이 전부 없어졌다** — 없어진 높이만큼 썸네일(34 → 58 px)과 잔탄(40 → 64 px)이 커졌다 (`styles/raidHud.css`). **2026-09-10 (2차, 사용자 결정):** 그 총기 표시가 **가로로 긴 한 상자**(`.wbox`, 어두운 반투명 + 얇은 테두리) 안에 들어갔다 — 안은 한 줄로 **좌측 등급색 정사각 썸네일** → `24 / 120` → 오른쪽 끝의 클래스 태그, 그리고 상자 **바닥**의 `.dura`. `예비` 라벨은 없앴다(`base.css` 의 `/ ` 구분자로 복귀). **내구도 바가 상자 밖 맨 위에 있을 때는 퀵슬롯 칸과 패널을 가르는 흰 가로 구분선으로 읽혔다** — 그래서 상자 안으로 들어갔다. `.cons` · `.modes` 는 `.weapon` 의 직계 자식으로 남아 `base.css` 의 `> ` 규칙을 살렸고, 총기 쪽은 `.weapon.consumable > .wbox { display:none }` 이 숨긴다. `weapon:swapStarted` 는 이제 이 패널에서 아무것도 하지 않는다(교체 표시는 크로스헤어 링). thin **durability bar** (`.dura .fill` scaleX; `.worn` amber < 30 %, `.broken` red at 0 → `.weapon.broken` tints name + mag red, `.broken-flash` shake on `weapon:broken`; seeded from `ctx.inventory.getLoadout()[slot].durability` / `WeaponDef.maxDurability ?? WEAPON_DEFAULT_DURABILITY` on equip, then `weapon:durabilityChanged` matched by item `uid`), **2026-09-08** `weapon:swapStarted` only switches the slot tag early — the `.swap` hairline and its `swapShow` / `swapSweep` keyframes are gone, the 교체 timer is the crosshair ring (`hud/ReloadGauge`, `.reload.swap`) — large mag count, reserve = `reserveRounds` (rounds of the calibre in the bag) and, **left of them, the weapon thumbnail** (`.wthumb` — 2026-09-07 에는 탄약 **우측**의 208 × 46 이름 상자였고, 2026-09-10 부터 이름 없는 76 × 76 정사각형이고 2차부터 `.wbox` 안 **좌측**이다: `buildItemChip(def, {size:58})` 한 장 — icon and rarity colour identical to the bag tile, `data-def-id` so the shared `ItemTip` hover card works — 그리고 **상자 자신의 테두리 · 안쪽 글로우 · 바탕색도 무기 등급색**이다 (`--wrc` = `rarityColor(def.rarity)`, 칩의 `--rc` 와 같은 값; 바탕은 `color-mix` 로 20 % 섞는다); the item def is `getLoadout()[slot].defId`, falling back to `wpn_<weaponId>`), class tag (`WEAPON_CLASS_LABEL_KO` from `@/items`, def via `ctx.loot.getWeaponDef`; the calibre 준중량탄 … was dropped in the Phase 9 UI pass), low (amber ≤ 25 %) / empty (red) states, flash on `weapon:dryFire`. **Phase 10:** the `.arc` reload SVG, its countdown (`update(dt)` — the method is gone entirely) and the `.reloading` pill are **removed** — `hud/ReloadGauge` draws the reload at the crosshair instead, and its CSS rules left `base.css` with them. `loadout:changed` with all three weapon slots empty → `무장 없음`. **Consumable mode** (`.weapon.consumable`): `quick:equipped {item}` hides the gun rows (CSS) and shows the `.cons` block — slot tag `F` + `빠른 사용`, item name (`ctx.inventory.getDef`), large count (`quick:used.remaining`, re-read via `ctx.inventory.findItem` on `inventory:itemUpdated`; `.empty` at 0 / `.low` at 1) and a hint `좌클릭 2초 홀드` (회복약, Phase 10 — `HEAL_HOLD_S`) / `좌클릭 홀드 · R 코킹 · 우클릭 언더핸드` (grenade); back to gun mode on `quick:equipped {item:null}` or the next `weapon:equipped` (gun state keeps updating underneath). `isConsumable` getter. **Phase 6 fire modes** (`.modes`, `.weapon.has-modes`): when the equipped def (`ctx.loot.getWeaponDef`) carries `unique` / `altFire`, two lines `좌 …` / `우 …` with fixed texts per `UniqueWeaponKind` (`UNIQUE_MODES`: flamethrower 넓은 화염 / 긴 화염 제트, shockgun 연쇄 전격 / 충전 볼트, shuriken 표창 1개 / 표창 3개 (F 길게: 용검), bow 화살 / 정조준, bazooka 착탄 로켓 / 공중 폭발 (바닥 우클릭: 로켓 점프), minigun 예열 후 사격 / —); hidden for graded weapons, on `loadout:changed` with no weapons and in consumable mode. `hasModes` getter. **Phase 9 UI pass:** the two strips (`ImplantChip`, `QuickStrip`) are prepended into this panel by `HudSystem`, so they inherit its bottom-right anchor and its `.hud.spectating` rule (2026-09-10 부터 그 아래가 슬롯 칸이 아니라 `.dura` 다 — `HudSystem` 의 `prepend` 는 그대로다). |
| `hud/QuickStrip.ts` | **빠른 사용 썸네일** (`.qstrip.is-single`, 무기 패널 **바로 위**에 `HudSystem` 이 prepend). 마지막으로 고른 휠 칸 하나만 그린다 — `quick:equipped` → `quick:used` → 첫 채워진 칸 순 (`pickIndex`), 자물쇠는 `ctx.inventory.getBagSize().quickSlots` + `isQuickSlotActive`. 칸 DOM 은 8개를 미리 만들어 두고 `hidden` 으로 고르며, 다시 그리는 것은 `defId|qty|손에 들었나` 키가 바뀔 때뿐이다(`dirty` + per-cell `key`). 손에 든 동안 `.is-hand`. **2026-09-10 (레이드 HUD 개편, 사용자 결정):** 썸네일을 1.5배(60 → 90 px)로 키웠다가 **2차에서 그 0.6배인 54 px** 로 되돌렸다 — 칩 크기(`THUMB`, `buildItemChip(..., {size:THUMB})`)와 칸 크기(`styles/raidHud.css` 의 `.qs-body`)가 **다른 파일이라 둘을 같이** 고친다. 그리고 썸네일 위의 **칸 번호 · 방향 화살표(`.qs-dir`)가 빠진 자리에 빠른 사용 키캡**(`.qs-key.keycap`)이 들어갔다 — 라벨은 하드코딩하지 않고 `keyLabel(Keys.QUICK)` 이며 `input:bindingsChanged` 에 다시 읽는다. `filledCount` / `isShowing` getters. |
| `hud/Compass.ts` | Top-center heading strip (cardinals + 15° ticks, 3 wrapped copies) scrolled from `ctx.player.getForward()`. Markers for extraction pads (icon + distance), active pad amber, ship triangle; markers clamp to the strip edges. Rebuilt on `world:ready`; no pad markers at all when `ctx.missionMode` / `ctx.world.mode` is `'training'` (Phase 7 arena). **2026-09-09 — 발견 게이트**: a pad marker is `hidden` until `ctx.world.fog.isDiscovered(pos)` is true. The **active** pad and the ship are exempt (the whole squad already knows), and a world with no fog (훈련장) shows everything as before. **2026-09-09 (레이드 플레이 개선)**: 구조물 · 선로 · 거대 버섯 군락이 `fog:discovered` 로 하나씩 붙는다 (`.marker.structure` / `.rail` / `.grove`, 스타일은 `base.css` 의 나침반 절). 신호소처럼 `world:ready` 에 미리 만들지 않는 이유는 개수가 맵마다 다르고 **발견 뒤에만 존재해야** 하기 때문이다 — 위의 `isDiscovered` 게이트는 이미 참이라 이중으로 안전하다. 환경 재해는 여기 오지 않는다(랜드마크가 아니라 함선이 관측하는 현상이고, 안전 방향 화살표는 `hud/HazardHud` 가 자기 블록 안에서 그린다). |
| `hud/WorldMarkers.ts` | Projects pad centers (and the landed ship) through `ctx.camera` in `lateUpdate`; diamond icon + label + distance, hidden behind the camera / off-screen, fades when < 12 m. Skipped in the training arena (`missionMode` / `world.mode` `'training'`). **2026-09-09 — 발견 게이트**: same rule as the compass — the marker is built at `world:ready` as before but stays hidden until `ctx.world.fog.isDiscovered(pos)`; the active pad and `__ship` are exempt. The fog reveals on the **whole squad's** positions, so a squadmate finding the console lights it up for everyone. |
| `hud/Objective.ts` | **2026-09-10 (레이드 HUD 개편, 사용자 결정): 좌측 상단은 임무 시간뿐이다.** `임무 목표` 라벨 · 목표 문구(`.text`) · 보조 문구(`.sub`) · `.swap` 애니메이션이 전부 없어지고, `.head` 의 마름모 표식 + **mission clock**(`.clock`, `update(ctx)` 가 `ctx.missionTime` 으로 쓴다) 만 남아 그만큼 커졌다 (`styles/raidHud.css`). `ui:objective` 구독도 없앴다 — 이벤트와 `OBJECTIVE_TEXT` 는 계약이라 그대로 있고(`HudSystem` 이 계속 발행한다) `set()` 은 **no-op 으로 남긴다**(HudSystem 이 탈출 카운트다운마다 부른다). 훈련장이 `ui:objective` 로 갱신하던 명중/격추 카운터는 `hud/TrainingPanel` 이 이미 자기 패널에 그리므로 화면에서 사라지지 않는다. Plus the large digital countdown under the compass (`extraction:tick`; pulses red ≤ 30 s; shows "도착" on `extraction:shipLanded`). Exports `OBJECTIVE_TEXT` (Phase 7: `training` = `시뮬레이션 훈련장 · 출구 콘솔로 종료`, set by HudSystem on phase `playing` while `ctx.missionMode === 'training'`; world/ refreshes the target hit counter through `ui:objective` `subText`). |
| `hud/InteractionPrompt.ts` | Center-bottom key cap "E" + prompt text from `interact:promptChanged`. Lives in the social layer so hub interactables (terminal, pods) get prompts too. **2026-09-08:** the linear hold bar under it is gone — `hud/HoldGauge` draws every hold at the crosshair, and `.prompt .bar` left `base.css` with it. **2026-09-09/10:** a hold interactable puts **`.kc-hold`** on the cap (`interact:promptChanged.hold`) → the shared chevron. 그 modifier 는 `hold` 가 **아니다** — 그 이름은 크로스헤어 홀드 링(`hud/HoldGauge`)이 이미 쓰고 있어 키캡이 120×120 투명 상자가 됐다. |
| `hud/Notifications.ts` | Right-center stack (max 6, social layer → also visible in the hub) with kind-colored left border and slide/fade dismiss. Feeds: `ui:notify`, `inventory:itemAdded` (rarity-colored name), `inventory:full`, `inventory:bagChanged` with `dropped.length > 0` → `가방이 작아져 아이템 n개를 떨어뜨렸습니다` (warning; `weapon:broken` toasts come from weapons), `enemy:waveStarted` ("적 증원 감지!"), `crate:looted`, `player:stimUsed`, all `extraction:*` milestones. **Down / revive / rescue:** `player:revived {hp}` → `부활 — 체력 <hp>` (success); **2026-09-09** `rescue:called` → `<이름> 구조선 호출됨` (success, label `구조`) 와 `leader:deviceDropped` → `분대장 기기가 떨어졌습니다` (warning, label `분대장`) 가 사라진 `game:respawnAvailable` 자리를 대신한다 (`분대장이 되었습니다` 토스트는 `game/parts/Leader` 가 `ui:notify` 로 띄운다). **Squad feed** (label `분대`): `net:remoteDied` → `{name} 전사`, `net:remoteDowned` → `{name} 전투불능 — 구조 필요` (danger), `net:remoteRevived` → `{name} 부활` (success), `net:peerJoined` → `{name} 합류`, `net:peerLeft` → `{name} 이탈`, `net:lobbyLeft {hostLeft}` → `호스트가 나갔습니다`, `pickup:taken` (remote) → `{byName} 획득: {item}`. **Network / hub feed:** `net:reconnecting` → `서버 재연결 중… (n)` (warning), `net:resumed` → `재연결됨` (seamless) / `함선에 복귀했습니다` (+ `임무 진행 중, 발사 포드에서 재합류` when `inProgress`), `net:matched` → `공유 함선 신호 포착` / `신호 송출 시작 — 대원 대기 중` (created), `hub:launchCountdown` → `발사 n초 전` (once per second, 1.1 s toasts). **Ship calls (Phase 3, label `호출`):** `stratagem:called` with a remote `caller` → `<이름> 함선 호출: <name>` (warning; name via `ctx.net.getLobbyPlayer/getRemotePlayer`, own calls are silent), `stratagem:landed` for `orbital_laser` / `airstrike` → `착탄 — <name>` (danger), `structure:destroyed` → `엄폐물 파괴` (warning, deduped 1 s), `stratagem:cooldown {remaining:0}` after a running cooldown → `함선 호출 준비 완료` (success). Names are `escapeHtml`'d. Cleared on `game:abort` / `game:newMission`. **Phase 5:** `meta:questChanged {state:'complete'}` → `퀘스트 완료 · name` (`QUEST_DEFS`), `meta:contractAccepted` / `meta:contractAbandoned` → `계약 수락 / 포기 · name` (`CONTRACT_DEFS`), `meta:purchase` → `구매: name · 크레딧 −price C (창고)`, `meta:sale` → `판매: name ×qty · 크레딧 +credits C` (Phase 10: amounts through the shared `formatCredits`) (item names / rarity colours via `ctx.loot.getItemDef`). **Phase 7:** `net:hostChanged` → `호스트 변경: <name>` (+ `(나)` when `isLocalHost`; label `네트워크`, warning), `net:peerSuspended` → `<name> 연결 끊김 — 자리 유지 중` (warning) / `<name> 재연결` (success), `game:newMission {mode:'training'}` → `시뮬레이션 훈련장 입장 — 탄약 · 내구도 미소모, 출구 콘솔로 종료` (after the clear), `training:exitRequested` → `시뮬레이션 훈련장 퇴장 — 장비 복원`. `meta:purchase` lines are unchanged (meta's async buy raises the event when the item lands). **Phase 11** (label `소셜`, since this folder is the one toast owner and the social panels never toast themselves): `social:error` → the Korean `SOCIAL_ERROR_MESSAGE_KO` line (warning), `social:play` → `<이름> 분대에 합류합니다` (`joined`, success) / `<이름>에게 분대 초대를 보냈습니다` (`invited`), `social:invited` → `<이름> 분대 초대 — <keyLabel(Keys.INVITE)> 홀드로 참여`. |
| `hud/DamageOverlay.ts` | Directional red arcs around the reticle (pooled ×6), red edge flash on `player:damaged`, low-HP vignette with heartbeat (< 40 % HP), heavy vignette when dead. **2026-09-09:** the arc is a **220 px ring, 6 px thick, ~70° red wedge** (`.dmg-arc` = conic-gradient masked to a ring with `mask: radial-gradient`, soft ends, double `drop-shadow` glow; peak opacity 0.95, life 1.4 s, the `rotate(angle) scale(…)` transform unchanged) instead of the faint 140 px / 3 px `border-top` arc. Arcs are fed by **`ui:damageIndicator` only** — `player/parts/Vitals` emits it and `player:damaged {from}` for the same hit, and listening to both drew two arcs per hit; `player:damaged` now drives the edge flash alone. |
| `hud/DeployOverlay.ts` | Bottom-center "행성 표면 강하 중…" sweep bar, visible during phase `deploying`. |
| **hud/ — tactical kit** | |
| `hud/ImplantWidget.ts` | **전술 임플란트 썸네일 — 화면 중앙 하단, 스태미나 바 아래** (`.imp-hud`, 2026-09-10 재작업; 2026-09-06 의 크로스헤어 좌측 세로 게이지 `.implant-gauge` 를 대신한다). 조준점 주위에서 숫자를 읽게 하지 않는다는 사용자 결정이라 쿨타임 · 충전 수 · 게이지가 전부 이리로 내려왔고 **이름은 적지 않는다** — 가로로 긴 썸네일(글리프) + 그 아래 `Keys.IMPLANT` 키캡뿐이다. 표시 유형 셋은 `ctx.implants` 가 주는 값으로 갈린다(코드에 수치를 적지 않는다): **쿨타임형**(갈고리 · 정찰 · 대전차포 — `maxCharges === 1`) = 딤드된 썸네일이 `--fill` 로 **아래에서 위로 밝아지고** 중앙에 남은 초, **충전형**(대시 — `maxCharges > 1`) = 우측 하단에 충전 수, 0 이면 쿨타임형과 같은 딤드 + 밝아짐, 1 개 이상이면 딤드 없이 **강조색이 위로 차오르며** 다음 충전을, 최대면 정상 표기, **게이지형**(배리어 내구도 · 오버차지 에너지) = 썸네일 안 **중앙 하단의 가로 게이지**. 배리어 붕괴 잠금(`barrierLockout`) 중에는 쿨타임형과 같은 딤드 + 밝아짐 + 남은 초다 — 내구도가 잠금 시간에 맞춰 0 → 만충으로 차오르므로 게이지가 그대로 진행도다. 밝아짐은 같은 얼굴(`.ib-face`) 두 장 — 딤드된 바탕 위에 밑에서부터 `--fill` 만큼만 드러나는 밝은 사본 — 으로 만든다. 값은 매 프레임 `ctx.implants` 에서 읽고 `implant:*` 는 늦은 등록과 연출(`pulse` / `hit`)에만 쓴다. 장착 없음 · **전투불능**(2026-09-08 규칙 유지) 이면 숨고, blocker 는 `.blocked`, `.hud.targeting` / `.spectating` 은 CSS. 짧은 화면(≤760 / ≤620 px)에서는 썸네일이 줄어 스태미나 바와 겹치지 않는다. 스타일 `styles/implant.css`, getters `shownId` / `displayKind` / `fillAmount` / `isDimmed`. |
| `hud/DangerIndicators.ts` | **위험 인디케이터** (`.dgr`, 게임플레이 레이어, 2026-09-10). "지금 날아오고 있는 것" 하나마다 **화면 안이면 머리 인디케이터(`.dgr-head`), 밖이면 방향 호(`.dgr-arc`)** 를 그린다 — 한 목표는 정확히 한 요소를 쓰므로 **둘이 같이 뜨지 않는다**. 호는 피격 방향 호(`hud/DamageOverlay` 의 `.dmg-arc`)와 같은 언어(크로스헤어를 감싸는 240 px 링의 한 쐐기, 각도 = 카메라 기준 상대 방위, 0° = 정면 · 시계방향)이고 색만 위험물별(`--dc`)이다. 대상 셋(사용자 확정): **적 곡사포탄**(`enemy:shellFired` → `@/shared/ballistics` 의 `shellLaunchVelocity` / `shellPositionAt` 로 실제 포탄과 **같은 포물선**을 적분한다 — 수식을 베끼지 않는다; `shellLanded` / `shellIntercepted` 에 지우고 `flightTime + 2.5 s` 안전망), **수류탄**(`ctx.weapons.getGrenades()` — 내 것 + 원격 복제본, 라벨은 남은 신관), **함선 호출 낙하물**(`stratagem:called` → `landed` / `ended`). **2026-09-10 추가 — 넷째 `로그 강하 포드`**: `ctx.enemies.getRogueDrops()` 를 매 프레임 직접 묻는다(예고에서 착지까지 살아 있는 목표라 캐시한 이벤트보다 매니저의 목록이 정확하다). ⬇ **빨강**(적의 것 — 분대장이 섞이면 한 단계 진하게), 라벨은 착지까지 `n초` → 착지 순간 `로그 n` / `로그 분대장`. 2026-09-09 에 `hud/OffscreenIndicators` 가 그리던 `.oarrow.drop` 화살표를 여기로 옮겨 온 것이라 **한 목표가 두 언어로 그려지지 않는다.** **인지력 반경 게이트**: 포탄에만 걸리고(`derived.enemyDetectRadius`), **착탄 지점이 `DANGER_NEAR_RADIUS` 안이면 인지력과 무관하게** 보여 준다 — 인디케이터의 목적이 "날아오는 줄도 모르는 것" 을 알리는 것이기 때문이다. 수류탄 · 낙하물에는 게이트가 없고, **로그 강하는 인지력을 아예 보지 않고 전용 반경 `ROGUE_DROP_ALERT_RADIUS`(260 m = 인지력의 10배) 하나를 본다** — 대기를 찢고 떨어지는 굉음이라 인지력이 좁아도 알아야 하고, `audio/AudioSystem` 의 강하음이 쓰는 반경과 **같은 값**이라 "들리는데 안 보인다" 가 없다. **전장의 안개 게이트는 걸지 않는다**(`OffscreenIndicators` 의 2026-09-09 근거 그대로 — 발견된 오브젝트가 아니라 지금 벌어지는 사건이다). DOM 은 풀링(머리 10 + 호 10)이고 반올림한 key 가 바뀔 때만 쓴다, 후보도 풀이라 프레임당 할당 0, 가까운 것부터 상한. 메뉴 / 지도 / 사망에는 전부 숨고 `game:abort` · `game:newMission` · `hub:entered` 에서 비운다. 2026-09-09 의 `hud/ShellMarkers`(+ `styles/shellMarkers.css`)를 흡수하고 그 파일은 삭제했다. 스타일 `styles/danger.css`, getters `visibleCount` / `trackedCount`. |
| `hud/NamedScanWarning.ts` | **로든 스캔 · 저격 경고** (`.named-scan`, 게임플레이 레이어, 2026-09-11, 스타일 `styles/named.css`). ① **노출 배너**(`.ns-banner`, 상단 중앙 top 156px — 재해 HUD 블록 아래): `named:scanExposure {count, total}` 의 count > 0 이면 `스캔에 노출되고 있음` + 칸 `count / total`, 절반 이상 `.warm`, `total − 1` 이상 `.crit`(짙은 빨강 · 빠른 맥동 + 부제 `엄폐하라`), count 0 이면 사라진다. 칸이 늘면 한 번 튄다(`.bump`). ② **음파 훑기**(`.ns-sweep`): `named:scanPulse` 가 `exposedLocal` 일 때만 가장자리 붉은 비네트 + 바깥으로 퍼지는 링이 0.76 s 한 번 — 노출되지 않은 음파는 조용하다. ③ **조준경 반짝임**(`named:sniperGlint`, 풀 3): `DangerIndicators` 와 같은 문법으로 화면 안이면 적 자리에 반짝임(`.ns-head`), 밖이면 280 px 붉은 방향 호(`.ns-arc`) — 둘은 같이 뜨지 않고 남은 시간이 45 % 아래면 빨리 깜빡인다. **표적이 나면** 호 + 큰 마커(`.mine`) + 크로스헤어 위 `저격 조준!`(`.ns-aim`), **남이면 화면 안의 작은 반짝임만**(호 · 문구 없음 — 내 화면 가장자리의 붉은 호는 "내가 노려진다" 로 읽히므로). 방위는 **카메라 위치** 기준이라 드론 조종 중에도 맞고, 조종 중에도 숨지 않는다(PC 는 그대로 저격된다). 메뉴 / 지도 / 사망 / 페이즈 밖이면 `.off`, `player:died` · `game:abort` · `game:newMission` · `hub:entered` 에서 비운다. DOM 풀 · key 가 바뀔 때만 쓰기 · 프레임당 할당 0. getters `exposureCount` / `isBannerOn` / `glintCount` / `isAimWarningOn`. **2026-09-11 (C-53):** `update` → **`lateUpdate(dt, ctx)`** — `HudSystem.lateUpdate` 에서 `DangerIndicators` 다음에 돈다 (타이머 · 게이트 · 투영이 한 진입점, `DangerIndicators` 와 같은 모양). `update` 에서 투영하면 `CameraRig`(플레이어 `lateUpdate`)가 카메라를 옮기기 **전**이라 화면 안 반짝임이 돌아가는 시점을 한 프레임 늦게 따라갔다. |
| `hud/GadgetHandHint.ts` | **손에 든 가젯 안내** (`.gadget-hand-hint`, 크로스헤어 92px 아래 — 홀드 링과 그 라벨을 비킨다, 2026-09-11, 스타일 `styles/gadgetHint.css`). 키캡 + 문구 최대 두 줄: **설치 미리보기** `gadget:placementChanged`(살아 있는 `ctx.gadgets.placement` 가 있으면 그것 우선) → valid `[좌클릭] 설치` / mount 면 `드론에 탑재`, invalid 빨간 `reason`(없으면 `설치 불가`) — 판정은 gadgets 것을 옮겨 적을 뿐이다. **원격 지뢰** — 손(`ctx.weapons.remoteState.heldItemId` → `ItemDef.gadgetId`)이나 미리보기가 `remoteMine` 이고 `liveRemoteMineCount() > 0` 이면 `[우클릭] 기폭 (n)`; **기폭기 손**(`remoteState.detonator === true`, 마지막 C4 를 놓은 뒤 슬롯 없는 손)에서는 설치 줄 없이 `기폭기 · [우클릭] 기폭 (n)`. **드론** (`droneKindOfGadget`) — 내 드론 없음 `[좌클릭] 드론 배치`, 사거리 안 `[R] 꾹 조종`(`.keycap.kc-hold`), `linkLost` 빨간 `신호 범위 밖`. 마우스 키는 `좌클릭` · `우클릭` 으로 적되 `Keys.FIRE` · `AIM` · `RELOAD` 를 매 프레임 읽는다. 드론 조종 중(`ctx.player.droneControl`) · 화면 열림 · 사망 · 페이즈 밖이면 숨는다. 매 프레임 폴링, 줄 서명이 바뀔 때만 DOM. getters `rowCount` / `lines`. |
| `hud/DroneHud.ts` | **드론 조종 HUD** (`.drone-hud`, 게임플레이 레이어, 2026-09-11). 데이터는 `ctx.drones`(`controlled` · `controlHold` · `DroneRef`)와 `drone:*` 뿐. **조종 중**(`controlled` 폴링 + `drone:controlChanged`, 한 길 `setControlled`) 게임플레이 루트에 `drone-view` 를 켜 쓸 수 없는 위젯을 CSS 로 숨기고, 가운데 뷰파인더 브래킷 · `● DRONE 공중 드론` · 드론 체력 바(`drone:damaged` own → 번쩍) · 작은 조준점을 그린다. **하단 사거리 게이지**(스태미나 자리): 채움 = `linkRatio`, `DRONE_LINK_WARN_RATIO` 눈금, 넘으면 붉게 깜빡 `신호 약함`, `linkLost`/≥1 `신호 끊김`, 아래 `현재 / 최대 m`(`DRONE_*_RANGE`). **외곽 지지직**: 경고 비율 → 1 에서 강도 0 → 1, 160×90 절차 캔버스 노이즈(xorshift, 18 Hz, 켜졌을 때만) + CSS 스캔라인 · 색수차 · 찢어진 띠, 게임플레이 레이어 **맨 아래에 prepend**. **공중**: 크로스헤어 좌측 `고도 n m`(= y − `world.getSurfaceY(x, z, y)`, `DRONE_AIR_MAX_ALTITUDE` 세로 게이지), 우측 `Space 상승` · `C 하강`. **지상**: 우측 `Space 점프` · `Shift 질주` + 질주 중 `소음` 배지(`aggroable` 이면 흐리게 남음). 공통 `R`(`kc-hold`) `복귀`. **홀드 링**: `controlHold > 0` 이면 조종 전 · 중 모두 반지름 60(HoldGauge 48 바깥), 라벨 `드론 조종` / `복귀`. **끊김 알림** 1.5 s: `range` = 전체 노이즈 번쩍 + `신호 끊김`, `destroyed` = `드론 파괴됨`, `damage` = `피격 — 연결 해제`, `manual` · `reset` = 조용히. 드론 시점에 들어갈 때 0.35 s 짧은 노이즈. 키 라벨은 `keyLabel(Keys.JUMP/CROUCH/SPRINT/RELOAD)` + `input:bindingsChanged` · `onKeybindsChanged`. 키 가이드에는 올리지 않는다(Tab · Esc 로 닫히지 않는다). Debug: `isDroneView` · `linkStatus` · `staticIntensity` · `alertText` · `isHoldShowing`. |
| `hud/QuickBar.ts` | Bottom-center 빠른 사용 바 (`.quickbar`): one `.qslot` per `ctx.inventory.getQuickSlots()` entry (4 normally, 8 with the 전술 가방 — `.wide`), each showing the `QUICK_SLOT_KEYS` number, the item def's icon/colour, the stack size and the name. Fed by `quickbar:changed` and re-polled every 0.15 s (also forced on `equip:changed` / `loadout:changed` / `game:newMission`); `quickbar:used` flashes the slot for 0.45 s. Hides itself when the inventory reports no quick slots. |
| `hud/Detection.ts` | **감지 시스템.** (1) Interactables (`ctx.interactables.all()`, `canInteract()` and **not** `hidePillar`) within `ctx.progression.derived.detectRadius` (fallback `DETECT_BASE_RADIUS`) get a pooled **light pillar** in the scene (**Phase 10** — it replaced the light-blue fresnel sphere and its `ShaderMaterial`): the shared `hud/pillar.ts` geometry + `MeshBasicMaterial` (`INTERACT_PILLAR_HEIGHT` / `_RADIUS_BOTTOM` / `_RADIUS_TOP` / `_FADE`, depth-tested so walls still occlude it), one shared geometry + material for **24 pooled meshes**, `mat.opacity` breathing around `INTERACT_PILLAR_OPACITY` at 3 Hz. The old `position.y += 0.45` lift is gone — a pillar starts at ground level. **2026-09-08**: an interactable may opt out with the appended `Interactable.hidePillar` — a corpse this client has already opened sets it, so its pillar goes away while the body stays searchable. Purely local: another player looting the same body never clears our pillar. (2) Enemies within `derived.enemyDetectRadius` (fallback `DETECT_ENEMY_BASE_RADIUS`; uses `ctx.enemies.queryNear` when the enemies folder provides it, else a filtered `getEnemies()`) that are **off-screen** get one of **6 pooled** `.detect-arrow` DOM arrows placed on a 0.34-viewport ellipse and rotated toward the target, fading with distance. Candidate list re-scanned every 0.15 s; transforms updated in `lateUpdate`. Everything hides itself outside gameplay phases / while dead / with a `menu` or `map` blocker, and the scene group is disposed on `game:abort` / `game:newMission` (recreated lazily). **2026-09-11 — 빛기둥은 시체에만**(`pillar.pillarAllowed`: `corpse:` · `pcorpse:`) — 상자 · 컨테이너는 world 의 열린 모습이, 나머지는 프롬프트 · 나침반이 알린다. **C-4 (2026-09-11):** 등록물 자체를 넘긴다(`pillarAllowed(it)`) — `kind` 우선 판정. |
| `hud/ScanReveal.ts` | Through-wall outlines for `detect:reveal` **and** `implant:scanned` (the 정찰 implant emits both; entries are keyed `kind:id` so duplicates just refresh the expiry). Up to **64 pooled** **light pillars** (**Phase 10**, `hud/pillar.ts` — the fresnel shell and its shader are gone) with `depthTest:false` + `renderOrder 999`, one shared geometry of height `SCAN_PILLAR_HEIGHT` and two shared materials (enemy red / everything else cyan); `KIND_SCALE` is now a **height multiplier** applied as `scale.set(1, s, 1)` (the baked colour ramp scales with it, so the fade still ends at the same fraction of each pillar's own height) and the `position.y += 0.5` lift is gone; targets that carry an `object` follow it, so revealed enemies keep their outline while moving. Expires per entry (default `IMPLANT_SCAN_REVEAL_TIME` = 10 s), cleared by `detect:clear` / `player:died`, disposed on `game:abort` / `game:newMission`. No DOM. **2026-09-11**: 시체(`pillarAllowed`)에만 기둥 — 정찰로 드러난 적은 붉은 투시 실루엣 · 화살표로 충분하다. |
| `hud/Deployables.ts` | Deployed-gadget indicators. Truth is `ctx.gadgets.getDeployables()` (polled every 0.2 s); until the gadget system exists the list is kept from `gadget:deployed` / `gadget:removed`. **Mines are shown to everyone** (friendly fire) out to 140 m: a red `.dmarker.mine` plus one of **6 pooled** additive blast-radius rings in the scene (amber + fast pulse while `.arming`, i.e. `armed === false`). Other deployables get a quieter cyan marker within 55 m. Exports `DEPLOYABLE_LABEL_KO`. Markers/rings hide outside gameplay; scene objects disposed on `game:abort` / `game:newMission`. |
| `hud/DownedOverlay.ts` | 다운/부활 UI (own layer directly under `ctx.uiRoot`, `pointer-events:none`, never takes a blocker token). Local `player:downed` → `.downed-layer.active` red vignette + `.downed-panel` (전투 불능, bleed-out bar and `n초` from `ctx.player.bleedoutRemaining`, falling back to a local countdown from the event's `bleedout`; `.critical` under 30 %). Hidden on `player:revived` / `player:died` / `player:spawned` / abort. Squadmates with `RemotePlayerRef.isDowned` get one of 3 pooled world markers (pulsing ring, slot-coloured name, distance, `제세동기로 부활` hint within 6 m). |
| `hud/ProgressToasts.ts` | Top-center `progress:*` feedback in the social layer (also visible in the ship, where mission XP is scored): `progress:skillUp` → compact `이름 n` toast (name via `ctx.progression.getSkillDef`), `progress:xpGained` → `+n XP` chip coalescing 1.2 s of gains. `progress:levelUp` is deliberately **not** toasted since Phase 7 — the result screen's `RewardsBlock` owns the level-up moment (badge + burst + chime). Max 4 live toasts, cleared on `game:abort` / `game:newMission`. |
| `hud/ActionFeedback.ts` | Screen-space feedback in the overlay layer, all CSS animations on fixed elements: `melee:swing` / `melee:hit` sweep arc (red on hit, white flash on a kill), `player:rolled` vignette punch, `implant:dashed` speed lines, `implant:barrierHit` blue rim flash, `player:gritSaved` gold flash + `인내 — 버텨냈다` banner, `player:revived` banner, persistent `.fx-burn` (`player:burning`) and `.fx-cloak` (`player:cloakChanged`) edge glows that are also re-synced from `ctx.player.isBurning` / `isCloaked` each frame. Everything resets on death / abort / new mission. |
| **hud/ — Phase 6 (dev console · unique weapons · ship housing)** | |
| `hud/WeaponChargeGauge.ts` | **Unique-weapon wind-up arc** (`.wcharge`, gameplay layer): 120° SVG arc (radius 48 px, `pathLength=1`, `stroke-dasharray = t 1`) bulging right of the reticle like the cook gauge, driven by `weapon:chargeChanged {kind, t}`. Kind class + colour via `--wc`: `.charge` electric blue (전격총 충전 볼트), `.spinup` amber (미니건 예열), `.slash` red (표창 용검 hold); label right of the arc `충전 n%` / `예열 n%` / `용검 n%`, at 1 `.ready` (pulse) with `충전 완료` / `사격` / `용검 준비`. Hidden on `t = −1` (cancel / release), `weapon:equipped`, `quick:equipped {item}`, death / down, mission reset. `activeKind` getter (`HudSystem.weaponChargeKind`). |
| `hud/StatusMarkers.ts` | **Pooled world markers for enemy status** (`.status-markers` / 12 × `.smarker`, gameplay layer): `enemy:incinerated {position}` → `🔥 전소` (`.burn`, rises 0.8 m and fades over 1.5 s), `enemy:shocked` → `⚡` (`.shock`, `sparkPop` 0.6 s). Ages on `ctx.time` (never wall-clock), projected through `ctx.camera` at `position + 1.6 m` in `lateUpdate`, DOM written only when the rounded transform / opacity changes, off-screen / behind → opacity 0. Oldest slot is recycled when all 12 are busy; cleared on `game:newMission` / `game:abort`. `activeCount` getter. |
| `hud/CheatTag.ts` | `MOVE CHEAT` corner tag (`.cheat-tag`, top-right, social layer → also visible in the ship) toggled by `cheat:moveCheat {enabled}` from the dev console's `/movecheat`. Nothing else clears it — the cheat persists across missions until the console turns it off. `isOn` getter. |
| `hud/KeyGuide.ts` | **키 가이드** (2026-09-09; replaces `hud/HousingHint`, which is deleted — its bottom-centre key bar and `.housing-exit` chip are superseded). One line in the bottom-right corner, `R 회전 · X 버리기 · Tab 닫기`, for the topmost open screen / mode. Consumes **`ui:keyGuide {owner, keys}`**: an owner with keys is pushed onto a stack in open order (a re-emit — e.g. on `input:bindingsChanged` — updates it in place), `keys: null` pops it, the **top** owner is rendered (popups over a screen win). **The guide appends the close entry itself** (`keyLabel(Keys.INVENTORY)` + `닫기`, always last; re-rendered on `input:bindingsChanged`) — owners never list it, and that last item carries the extra class **`kg-close`** (2026-09-09) so something can point at just the close key (the tutorial's 함선 관리 닫기 step spotlights `.key-guide .kg-close`). DOM: `.key-guide(.show)` > `.kg-item` (`.keycap` + `.kg-label`) separated by `.kg-sep` `·`; a **direct child of `ctx.uiRoot`** at **z 84** (over the inventory window 50–80, the hub terminal, the 시설 관리 panel, the map 40, the tutorial spotlight 78 / popups 79–80; under the 일시정지 85). Hidden while the stack is empty, while the `'menu'` blocker is up (polled in `update()`) and while the chat input is open (`ui:chatToggled`). Stack cleared on `game:newMission` / `game:abort`. Same corner as `.ship-hint`, but they never coexist (the hint needs no blocker, the guide an open screen). Getters `owner` / `owners` / `entries` / `isShowing`. Emitters in this folder: `map/MapScreen` (`'map'`), `hud/Community` (`'community'`); hub/HousingMode emits `'housing'`, the hub terminal / 작업대 / inventory their own. |
| **hud/ — Phase 8 (함선 관리)** | |
| `hud/ShipManageHint.ts` | **시설 관리(M) hint** (renamed from 함선 관리 in the Phase 8 UI pass — the Tab 함선 tab is the 함선 관리 screen, this key opens 시설 관리) (`.ship-hint`, bottom-right of the **social** layer — the layer that stays visible in the ship). `update(ctx)` runs every frame from `HudSystem` (two compares) and shows `.show` whenever `ctx.isHubPhase()`, `ctx.uiBlockers.size === 0` **and** 함선 관리 is not already open (`ctx.housing.shipManageMode` — the room list would only repeat the hint). Text `시설 관리` + `keyLabel(Keys.MAP)` in a `.keycap`, refreshed on `input:bindingsChanged` (never cached). No blocker, `pointer-events:none`. `isShowing` getter. |
| `hud/ShipManage.ts` | **시설 관리 screen** (`.ship-manage`, in the **`.hud.housing`** layer so the gameplay / social gating never hides it; the panels are `.interactive` because that layer is `pointer-events:none`). **Left `.sm-rooms`**: `SHIP_ROOM_COUNT` `.sm-room` buttons — `방 n` (1-based), `ROOM_PURPOSE_LABEL_KO[purpose]` (`.empty` when unassigned) and `n개` from `ctx.housing.getPlaced(i).length`; click → `ctx.housing.setManageRoom(i)` (the `.is-on` highlight follows the housing event, not the click). **Right `.sm-side`** (Phase 8 UI pass — it used to be a horizontal `.sm-bar` along the bottom): a vertical panel whose head reads `가구 · 방 n — 용도` (or `방 n — 용도 지정`) with a `빈 방으로` button beside it (hidden while `purposeBlock(room, 'empty')` refuses, so never on the built-in 작업실), showing **one of two lists**, both vertical scrollers whose wheel is captured locally so it does not also cycle the housing selection: `.sm-purposes` for an **empty** room — one `.sm-purpose` per assignable `RoomPurpose` with the **materials its 시설 증축 costs** (`ctx.housing.purposeCost` through `renderItemCost`; the prose description was dropped in the Phase 9 UI pass), a `다음 업데이트` badge for the inactive ones and `.is-blocked` + `disabled` + the reason from `ctx.housing.purposeBlock` — and `.sm-cards` otherwise, one `.fcard` per `ctx.housing.getFurnitureFor(purpose)` def (`.fcard-thumb`: def colour ring + a `MODEL_GLYPH` character per `FurnitureModelKind` + the `cols×rows` footprint; `.fcard-body`: name, `renderItemCost(def.craft, ctx.loot.getItemDef, ctx.inventory.countDefAll)` `.item-chip`s and `보유 n` from `getStored()`, `.is-empty` when none is in storage); click → `ctx.housing.selectFurniture(defId)` (clicking the selected card clears it). Cards are rebuilt only when the room / def list / storage / material counts change (`cardsKey`), purpose buttons only when a block reason changes (`purposeKey`). **Phase 9 UI pass:** the furniture side is behind two tabs (`.sm-tabs`, hidden while the 용도 지정 picker is up) — **가구 제작** (`.sm-cards`, the list above, each row gaining a `제작` button that calls `ctx.housing.craftFurniture`; this is the only place furniture is crafted) and **가구 창고** (`.sm-store`, one row per `getStored()` def — pieces this room accepts first, the rest under them dimmed + `disabled`; **2026-09-09: a store card click only selects (`.is-sel`), and each accepted card carries a `배치` button (`.fcard-place`) that drops the piece on the room's first free cell — `findFreeSpot` delegates to `ctx.housing.findFreeSpot(room, defId)` (2026-09-10: the scan itself moved into `housing/Rules.autoPlaceSpot`, x outer ascending × y inner descending = 화면 기준 좌측 상단부터 가로줄 우선, `AUTO_PLACE_YAWS = [1, 0]` so a bench faces **down** instead of the right wall, and the door mouth is kept clear); disabled with `자리 없음` in `.fcard-note(.is-full)` when nothing fits, `배치 가능` otherwise, `<용도> 전용` on blocked cards; the fit result is in the list's memo key**). Driven by `housing:shipManageChanged` (open / close / room), `housing:changed` / `inventory:changed` / `inventory:stashChanged` (refresh), `housing:furniturePlaced` / `furnitureMoved` / `furnitureRecovered` / `facilityUpgraded` / `roomPurposeChanged` (2026-09-09, re-scan the 배치 fit) and `housing:selectionChanged` (`.is-sel` only); hidden on `game:newMission` / `game:abort`. No blocker token. `isShowing` / `activeRoom` / `cardCount` / `purposeCount` / `furnitureTab` getters. **2026-09-08 (빈 방으로 = 100 % 환급)**: the header `빈 방으로` button opens the same confirm popup (title `방 n — <용도> 제거`, the refund chips from `HousingRef.facilityRefund`) and then calls `HousingRef.removeRoomFacility`. It used to call `setRoomPurpose(i,'empty')` straight — the *free* path housing takes **after** it has worked out a refund — so clearing a room here burned the 시설 증축 price and the player could not rebuild what they had just torn down by mistake. |
| `hud/ItemTip.ts` | **재료 요구 칩 hover card** (`.item-tip`, Phase 8 UI pass). A **direct child of `ctx.uiRoot`** (z-index above every window and menu, `pointer-events: none`) with one delegated `pointerover` / `pointermove` / `pointerout` on `ctx.uiRoot`: any `.item-chip[data-def-id]` — the hook `src/shared/itemChip.ts` stamps on every chip it builds — or any `[data-item-tip][data-def-id]` element that opted in (Phase 9 UI pass: `inventory/ui/TradeGrids` stamps its 기업 거래 tiles) — shows the item's name, 분류 · 등급, description and a small stat table (보유 from `ctx.inventory.countDefAll`, 재배 시간 / 회복 / 가방 / 최대 묶음 from the `ItemDef`; hidden when no row is left). **Phase 10:** 가치 left that table for the card's **bottom bar** (`.it-value`, the card's last child, faint amber ground) rendered with the one credit formatter, `formatCredits(itemCreditValue(def))` → `1,200 C`; the old ` cr` suffix is gone. **2026-09-09:** the **`크기 (w × h)` row is gone** from every card (the bag grid already shows the footprint) and **무게 moved into the bottom bar** — `.it-value .wt` (`무게 1.2 kg`, `—` when the def has no weight) on the **left**, `.it-value .val` (`가치 1,200 C`, accent) on the **right**; the 재화 card (`.is-currency`) still hides the bar and the table. 희귀도 stays in the sub line. **2026-09-08:** an `implant` def also lists 장착칸 · 퍽 · 능력치 (· 상태 when broken) — the inventory's 임플란트 칸 is a row of square thumbnails with no words on them, so this card is where an equipped implant is read. Def data only: a chip has no `ItemInstance`, so there is no durability / socket section like `inventory/ui/Tooltip`. Hides itself on `game:phaseChanged`, `inventory:closed` and `housing:shipManageChanged` so a chip that vanishes under the cursor never strands the card. `isShowing` / `shownDefId` getters. **2026-09-11 (C-36 후속):** 가방 def(`durabilityMax`)면 `가방` 줄 아래 **`내구도`** 줄 — 호버한 요소가 `data-uid` 도 달고 `ctx.inventory.findItemAnywhere` 로 같은 def 인스턴스를 찾으면 `cur / max`(0 이어도 `파손` 이라 적지 않는다, `inventory/ui/Tooltip` 과 같은 규칙), 칩뿐이면 `최대 max`. 카드 캐시 키에 uid 가 들어간다. |
| `hud/ContractPanel.ts` | **Active corp contract** (`.contract-panel`, gameplay layer, under the objective at `top: 104px`; Phase 5): `계약` label + `달성` badge, contract name, goal label (`CONTRACT_GOAL_LABEL_KO`) and a `p / t` bar. `world:ready` reads `ctx.meta?.activeContract` (`ContractInfo.def` / `progress`; null or skeleton = hidden); `meta:contractProgress {id, goal, progress, target}` updates it — and opens it on its own, resolving the name from `CONTRACT_DEFS` — and pulses it (`.pulse`, 0.9 s of `ctx.time`, dropped in `update(ctx)`); progress ≥ target → `.done` (green bar, badge). Hidden on `meta:contractSettled` / `meta:contractAbandoned`, `game:abort` and the phases `complete` / `dead` / `hub` / `menu`. Opacity only (no `visibility` transition — Chrome reports `hidden` for a frame or two after a class flip). **Phase 9 UI pass:** the own contract moved into a `.mine` block and a **`분대 계약`** block (`.mates`, one `.mrow` per entry of `ctx.meta.getSquadContracts()` — slot-coloured name, contract name, `p / t` and a thin bar) follows it; the block hides itself when nobody else has a contract, `meta:squadContract` marks the rows dirty and the next `update(ctx)` repaints them, and the `.done` colours are scoped to `.mine` so a finished own contract never tints a squadmate's bar. **2026-09-08:** the panel never shows while `ctx.missionMode === 'training'` — the 시뮬레이션 훈련장 is not a raid, so a contract accepted back at the ship has no business on that HUD. `isShowing` / `isPulsing` / `mateRowCount` getters. |
| `hud/TrainingPanel.ts` | **시뮬레이션 훈련장 패널** (`.training-panel`, gameplay layer, Phase 9 — the `ContractPanel` slot, since a contract never settles in a training). Shown only while `ctx.missionMode === 'training'`: mode chip (`TRAINING_MODE_LABEL_KO`, `training:modeChanged`), 격추 score (`training:scored`; in `timed` mode `n / TRAINING_COURSE_TARGETS` with a bar that goes `.done` at the target), a 남은 시간 row while a course runs (`ctx.world.training` polled in `update` for fields that changed on the ref itself — events win otherwise; `-1` hides it, red pulse under 10 s) and 최고 기록 from `bestTime` (hidden while null). `training:courseFinished` → `ui:notify` (`타임 코스 완료 12.3초` / `시간 초과`) + a 0.9 s pulse. Any `training:*` event also brings the panel up on its own, so a world without a `TrainingRef` still shows one. `isShowing` / `isPulsing` / `shownMode` → `HudSystem.isTrainingPanelOn` / `isTrainingPulsing` / `trainingPanelMode`. |
| `hud/MetaToasts.ts` | **Meta toasts** (Phase 5) appended to the `ProgressToasts` column (constructed with its root): `meta:creditsChanged {delta}` → coalesced `크레딧 +n C` / `크레딧 −n C` chip (`.ptoast.credits[.minus]`, 1 s window, signed net, 0 = nothing; **Phase 10**: the amount goes through the shared `formatCredits(n, {sign:true})`, the word 크레딧 stays as the label), `meta:repChanged {levelUp:true}` → `<기업 이름> 신뢰도 Lv.n` (`.ptoast.rep`, name from `CORP_DEFS`), `meta:contractSettled` → big toast keyed on **`settlement.outcome`** (Phase 7, via `contractOutcome` / `CONTRACT_OUTCOME_TEXT` from `menus/RewardsBlock`; never `ctx.stats.extracted`): `계약 성공 · name · 신뢰도 +rep · 크레딧 +credits C` (`.success`), `계약 미완 · 계속 · name · p / t` (`.keep`), `계약 실패 · 진척 유지 안 됨 · name · p / t` (`.fail`); a settlement without `outcome` (older producer) falls back to success / 미완. Max 4 live, cleared on `game:abort` / `game:newMission`; `update(dt)` runs every frame regardless of the social layer so a chip raised behind the result screen expires instead of greeting the hub. `liveCount` getter. The meta folder never toasts itself. |
| `hud/RoomLabel.ts` | **Room entry label** (`.room-label`, top-centre, social layer): `hub:roomEntered {room, purpose}` → `방 n · 용도` (**1-based** room number, `ROOM_PURPOSE_LABEL_KO[purpose]`, `빈 방` when purpose is null) slides in, stays `HOLD_TIME` 1.5 s of `ctx.time` (the `update` runs regardless of layer visibility) and then fades out through the CSS transition; `room: null` hides it at once. `isShowing` getter. |
| **hud/ — Phase 11 (소셜)** | |
| `hud/Community.ts` | **커뮤니티 아이콘 · 분대 초대 스택** (`.community`, social layer — the layer that stays up in the ship), Phase 11. Ship only, self-gated in `update(dt, ctx)` on `ctx.isHubPhase()` **and** an empty `ctx.uiBlockers` (its own `COMMUNITY_BLOCKER` excepted), exactly like `hud/ShipManageHint`. Top-right at `right: 32px / top: 28px`: a 64 px **thumbnail** (`.cm-btn`, glyph + `커뮤니티` tag) with `SocialRef.onlineFriends` **inside its bottom-right** (`.cm-count`) and a red `.cm-dot` at its **top-right** while `SocialRef.hasNews`; the `.cheat-tag` moves to `top: 108px` in the hub so the two corners never collide. Clicking it opens the **커뮤니티 panel** — a direct child of `ctx.uiRoot` (`.community-panel`, so the social layer's own gating can never hide it) whose body is a second **`menus/social/SocialColumn`**, headed by `내 아이디 <formatPlayerCode(me.code)>` and a `닫기 (${keyLabel(Keys.INVITE)})` button; it adds `COMMUNITY_BLOCKER` **then** `ctx.input.setCursorMode(true, COMMUNITY_BLOCKER)` (never `exitPointerLock`), emits `ui:communityToggled` and — **2026-09-08** — opens **and closes on a P tap** (the capture-phase Escape listener is gone; Escape is the 일시정지 메뉴, which stacks over the panel). This is the game's only social surface now. **분대 초대**: up to `SQUAD_INVITE_MAX` `.cm-invite` cards stack *under* the thumbnail, **newest first** (아이디 · `<이름> 분대 초대` · `<keyLabel(Keys.INVITE)> 홀드로 참여` · a `scaleX` gauge like `InteractionPrompt`), and holding `Keys.INVITE` for `SQUAD_INVITE_HOLD_S` in the ship with **no** blocker up calls `social.acceptInvite(from)` on the top card; `×` calls `dismissInvite`. **The same key taps the panel open / closed** — the toggle fires on *release* and only inside `COMMUNITY_TAP_MAX_S`, so an abandoned invite hold does not also open a panel; with no invite on screen any release toggles. Count / dot / invite list are polled once per frame and compared before any DOM write. With no relay the thumbnail still shows (0, no dot) and the panel carries the one unavailable line. **2026-09-08 (고정 크기)**: `.cp-frame` is a fixed 940 × 760 box (clamped to the viewport) instead of shrink-to-fit — the lists growing, and 받은 친구 요청 appearing out of nowhere, used to resize the frame between two openings and move 닫기 out from under the cursor; `.sc-body` scrolls instead. **2026-09-09:** **Tab (`Keys.INVENTORY`) closes the open panel too** (polled in `update`, consumed; the inventory's own guard already refuses while `COMMUNITY_BLOCKER` is up) and the panel emits `ui:keyGuide {owner:'community', keys:[우클릭 메뉴, P 닫기]}` on open / `input:bindingsChanged`, `null` on close. `isShowing` / `isOpen` / `inviteCount` / `holdProgress` / `socialColumn` getters. **2026-09-09 (분대장 넘기기)**: 패널 안 분대원 행(`.sc-srow[data-peer-id]`)을 **우클릭**하면 `분대장 넘기기` 한 줄 메뉴가 뜬다 — **내가 호스트이고** 대상이 나 자신이 아니며 같은 로비의 접속 중인 멤버일 때만(서버와 같은 규칙). 고르면 `menus/askPopup` 의 **확인 팝업**(초기 포커스 `취소`, 홀드 없음 — 되돌릴 수 없는 일은 아니다)을 거쳐 `leader:transferRequested {peerId}` 를 낸다. 메뉴 · 팝업 모두 `ctx.uiRoot` 아래에 살고 패널이 닫히면 함께 닫힌다. `leaderMenuTarget` getter. |
| **map/** | |
| `map/MapScreen.ts` | Tactical map (`Keys.MAP` = M, toggled in gameplay phases when no other blocker is active — **M also closes it**, and the poll ignores the press while `MENU_BLOCKER` is up; 2026-09-08: the capture-phase Escape listener is **gone**, Escape is the 일시정지 메뉴; **2026-09-09: Tab (`Keys.INVENTORY`) closes it too**, consumed so the inventory does not open, and while open it emits `ui:keyGuide {owner:'map', keys:[MMB 핑, 휠 확대, LMB 드래그 이동]}` — re-emitted on `input:bindingsChanged`, `null` on close — for the 키 가이드, which appends `Tab 닫기` itself). `.map-screen.interactive` (hidden via the `hidden` attribute, z-index 40) with a side panel (title, seed, legend incl. `돌격 핑` / `주의 핑` / `떨어진 아이템` / `분대원`, zoom readout, `초기화`, hint) and a square canvas (~85 % of viewport height). Static layer built lazily per `world:ready` seed (256×256 `getHeightAt` samples, NW hillshade, contours every 4 m). Dynamic layer every frame while open: 100 m grid, nests, crates, pads, landed ship, **dropped pickups** (`ctx.pickups.getPickups()` → small violet diamonds), pings (from `setPingSource()` when set — kind icons: enemy triangle, crate square, extraction diamond, `item` diamond, `attack` arrow, `caution` triangle with `!`; owner slot colour + `이름 · 라벨`; `lost` enemy pings at 50 % alpha), squad members (slot-coloured arrows; dead = ring + X; Phase 7: a `suspended` member is drawn in grey `#8a8f99` at 60 % alpha with `이름 · 연결 끊김` instead of being skipped for `!connected`), player arrow + view cone, north badge. Wheel zooms 1×–4×, left-drag pans, **middle-click drops a ping** (Phase 10: `fromX` / `fromZ` invert `toX` / `toY`, `pingAt(clientX, clientY)` snaps the point to `getHeightAt` and hands it to the `setPingPlacer(fn)` callback that `HudSystem` wires to `Pings.placeAtWorld`; the footer hint gained `휠클릭 핑`). Adds blocker `'map'` and, **Phase 10 §2**, `ctx.input.setCursorMode(true, 'map')` instead of `exitPointerLock()` — the lock is kept, so `close(relock)` keeps its parameter for the existing call sites but no longer re-requests anything. Emits `ui:mapToggled`. `PingKind` comes from `@/shared`. **Tactical kit:** 채집물 (`ctx.world.getGatherNodes()`, green crosses, 25 % alpha once harvested) and 설치물 (`ctx.gadgets.getDeployables()`) — mines draw a red X with their blast circle (amber while arming), every other deployable a small cyan square; legend rows `채집물` / `설치물` / `지뢰 (피아 구분 없음)` were added. **2026-09-09 — 전장의 안개.** The map no longer opens fully drawn. `buildStatic` now bakes **two** 1024² layers from the same 256² height pass (`upscale(img, n, decorate)`): the familiar **colour** layer and a flat **grey outline** (≈14 grey + a touch of the same hillshade, contour lines a little brighter — map size and ridges, no colour, no detail). A third canvas, `fogLayer`, is the colour layer cut to the mask: the `cells × cells` `FogRef.mask` is pushed in as `ImageData` **alpha**, upscaled with `imageSmoothingEnabled` so the edge is soft rather than 8 m stair steps, then `globalCompositeOperation = 'source-in'` + the colour layer. It is rebuilt **only when `fog:revealed` marks it dirty** (or on open) — never per frame, and never while the screen is closed. `draw` paints outline → fogLayer; with no fog (훈련장) it paints the single colour layer exactly as before. **오브젝트 발견 게이트**: nests, crates, gather nodes and pads are skipped unless `fog.isDiscovered(position)` (the **active** pad is exempt — the countdown is squad-wide knowledge). Live squad information — pings, squadmates, dropped pickups, deployables, the landed ship — is never gated, because whoever placed it saw the spot. The side panel gained a **탐색률** readout (`FogRef.explored`, updated from the same event). **2026-09-09 (레이드 플레이 개선) — 재해 · 구조물 · 선로 · 전차.** `drawHazard(ctx)` 가 `ctx.world.hazard.getZones()` 를 그린다: `shape:'front'` 는 **반평면** (전선은 `center` 를 지나고 법선이 `(dirX,dirZ)` = 진행 방향이므로 **법선 반대편**(이미 지나온 쪽)을 붉게 채우고 전선을 굵게 긋는다), `shape:'circle'` 은 `safeInside` 면 캔버스에서 원을 도려내고(`fill('evenodd')`, `rect` 뒤에 `moveTo` 를 넣어 이음선을 막는다) 아니면 원 안을 채운다. **이 층은 안개 레이어 `위`에 그리고 `discovered()` 게이트를 걸지 않는다** — 함선이 궤도에서 관측해 알려 주는 현상이라 걸어서 밝힌 구역과 무관하다(사용자 명시 요구). **2026-09-10**: 채움을 0.16 → 0.26 으로 올리고 그 위에 **빗금 무늬**(`hatch()`, 9 px 타일 `CanvasPattern`)를 한 겹 더 깔며, 경계선은 어두운 밑선 4.5 px + 밝은 선 2.2 px 두 겹이다 — 컬러 지형 위에서 폭풍이 있는지조차 안 보였다. 같은 날 **안개 경계선**(`buildFogEdges` / `drawFogEdges`)이 붙었다: 밝혀진 칸이 미탐색 이웃과 맞닿는 격자 변을 선분 목록으로 만들어(`fog.revision` 이 바뀔 때만) 어두운 밑선 + 밝은 선으로 긋는다 — 컬러 레이어의 스무딩된 가장자리로는 "여기까지 봤다" 가 읽히지 않았다. 좌하단에 `<재해 이름> · 안전지대 n%` 한 줄. `drawRails(ctx)` 는 선로 중심선(파선, `loop` 이면 닫는다) · 플랫폼(작은 사각) · **전차**(자기 `yaw` 로 도는 사각, `moving` 이면 밝게)를 그리고, 구조물은 `getStructures()` 의 `radius` 원 + 중앙 사각 + **지하실이 잠겨 있으면 호박색 자물쇠 점**, 거대 버섯 군락은 `hazard.getSources()` 의 `discovered` 인 것만 버섯 갓 아이콘. 이 넷은 전부 안개 게이트를 지킨다. 범례에 `버려진 구조물` · `선로 · 플랫폼` · `전차` · `거대 버섯 군락` · `위험 구역` 다섯 줄이 붙었다. |
| **menus/** | |
| `menus/MenuBase.ts` | Abstract full-screen menu: scanline backdrop, framed panel with corner accents, `show()/hide()` add/remove the `ctx.uiBlockers` token `'menu'` **and** `ctx.input.setCursorMode(active, 'menu')`; `button()` helper plays `ui_click`. **2026-09-07 (커서 rework)**: the pause menu is no longer a special case — every screen releases the lock now, so it takes the same token as the rest and `main.ts` does the single re-lock. |
| `menus/TitleMenu.ts` | **타이틀 (2026-09-09 개편)**: `.menu.title.home` — 화면 위쪽 가운데의 워드마크 + 태그라인, 그 아래 버튼 셋뿐이다: **`게임 시작`** (캐릭터 선택창을 연다) / **`설정`** (HudSystem 이 넘겨준 콜백 → 공유 `SettingsMenu`) / **`종료`** (`PauseMenu.quit()` 과 같은 다섯 줄을 **일부러 복제** — `window.close()`, 브라우저 탭이면 한 틱 뒤 `ui:notify` 로 알린다; PauseMenu 를 import 하면 두 화면이 묶인다). **콜사인 입력칸 · `Lv. n` 칩 · 조작 다이어그램 · `키 설정 변경` · `새 캐릭터로 시작` 은 전부 없어졌다** — 이름은 캐릭터의 것(`progression` → `net.setPlayerName`), 조작 다이어그램과 리바인딩은 `설정 → 키 설정`, 캐릭터 지우기는 선택창의 `삭제`. 하위 화면 둘(`menus/CharacterSelect` · `menus/CharacterCreate`)을 **소유**하고 같은 `parent`(= `ctx.uiRoot`) 아래 자기 **뒤에** 붙인다 — 둘은 blocker 토큰도 커서 소유권도 갖지 않고, phase `menu` 동안 이 메뉴(`MenuBase`)가 계속 쥐고 있다 (`SettingsMenu` 와 같은 규칙). 하위 화면이 떠 있는 동안 타이틀 본체는 `.stacked` 로 **눈에서만** 사라진다 (`hide()` 는 blocker 까지 놓아 버린다). **부팅 자동 시작**: `bind()` 에서 `takeAutoStart()` 를 **정확히 한 번** 읽고, 참이면 타이틀 · 선택창을 건너뛰고 한 마이크로태스크 뒤 `menus/enterShip` 으로 함선에 들어간다 (Engine 은 모든 `init()` 을 한 동기 패스로 돌리므로 허브가 아직 `hub:enter` 를 구독하지 않았을 수 있다). 여기가 자리인 이유는 건너뛸 대상이 이 화면이고, `bind` 는 부팅에 한 번 불리며, phase `menu` 의 show/hide 를 이미 이 클래스가 쥐고 있어서다 — 다른 곳에서 읽으면 타이틀이 한 프레임 번쩍인다. 표시는 읽으면서 지워지므로 나중에 `타이틀로` 로 돌아오면 타이틀이 정상으로 뜬다. `update(dt)` (HudSystem) 는 생성창의 3D 미리보기만 돌린다. `isSelectOpen` / `isCreateOpen` getters. 스타일은 **새 `styles/title.css`** (`import '../styles/title.css'` — `inventory.css` · `tutorial.css` 와 같은 방식). **2026-09-11 (C-9 · X-8):** `bind()` 에서 `takeAutoStart()` 바로 다음에 **`takeKeybindLoadReport()` 도 정확히 한 번** 읽어 `menus/keybindNotice` 에 넘긴다 (같은 이유 — 부팅에 한 번뿐인 값이고 첫 화면이 여기다). 카드는 타이틀 root 안이라 타이틀과 함께 보이고 숨으며 `.stacked` 에서 같이 흐려진다. 생성자의 선택 인자 `onKeySettings` 가 카드의 `키 설정 열기` 이고(`HudSystem` 은 `settings.open()` + `select('keys')`), `update(dt)` 가 카드 타이머를 **타이틀이 하위 화면에 가려지지 않은 동안만** 돌린다. getter `keybindNotice`. |
| `menus/keybindNotice.ts` | **옛 키 설정 세이브 알림** (2026-09-11, C-9 · X-8). `scav.keybinds` 에는 버전이 없어서 기본 키가 옮겨 가기 전에 저장한 블롭(예: `RELOAD=V` ↔ 새 기본 `DIVE=V`)이 새 기본 키와 **조용히** 겹치고, 목록에서 빠진 액션(`SWAP` · `SECONDARY` · `CURSOR`)의 줄은 블롭에 영영 남았다. `shared/Keybinds.loadKeybinds()`(main.ts 부팅)가 모은 `KeybindLoadReport` 를 `TitleMenu.bind` 가 한 번 받아 여기로 넘긴다. `describeKeybindReport(report)` = 사람이 읽는 줄 — 겹침은 **키마다 한 줄** `같은 키 V: 재장전 · 구르기`(블롭에서 온 두 액션이 서로 겹치면 리포트에 양방향이 다 있으므로 키 코드로 묶는다, 라벨은 `getKeyActionDef(id).label` 의 ` / ` 앞), 은퇴 액션은 한 줄 `없어진 기능의 키 설정을 지웠습니다: 이전 무기 · …`(은퇴 액션은 원시 문자열이라 `RETIRED_LABEL_KO` 가 `SWAP` 이전 무기 · `SECONDARY` 보조무기 · `CURSOR` 커서만 이름을 붙이고 나머지는 원문), 최대 4줄(넘치면 `외 n건`). `KeybindNotice` = 타이틀 아래쪽 가운데의 카드 `.kb-notice` (`⚠ 키 설정을 확인하세요` + 줄 + 부제 + `키 설정 열기` / `확인`, 스타일 `styles/title.css`). 타이틀이 보이는 시간으로 `KEYBIND_NOTICE_S`(14 s) 뒤 스스로 접힌다(`.fade` 0.4 s). **슬롯 전환 자동 시작**(타이틀을 건너뛴다)이면 카드 대신 첫 `hub:entered` 에서 같은 줄을 `ui:notify {kind:'warning', duration 8}` 로 흘린다. 어느 쪽이든 **알린 순간** `saveKeybinds()` 를 불러 은퇴 줄을 블롭에서 지운다 — 겹침은 사용자가 고칠 때까지 블롭에 남으므로 다음 부팅에 다시 알린다(실제로 두 동작이 한 키에 묶여 있으므로 조용히 넘기지 않는다). getters `report` / `lines` / `isOn`. |
| `menus/CharacterSelect.ts` | **캐릭터 선택** (2026-09-09, `.title-screen.char-select`, z-index 84). `SLOT_IDS` 만큼(기본 3)의 큰 카드를 `readSlotCards()` 로 채운다 — 색인 파일 없이 그 슬롯의 세이브에서 바로 읽는다. **채워진 칸**: 이름 · `Lv. n` · 크레딧(`formatCredits`) · 레이드/탈출 횟수 · 능력치 다섯(`.cc-mini`, 캐릭터 시트 `.cs-stat` 과 같은 어휘의 축소판; 바의 기준은 생성 상한 5 이되 더 자란 능력치가 있으면 그 카드의 최댓값으로 늘린다), 카드의 색(`--ac`)은 그 캐릭터의 `accent`. 카드는 `<button>` 이 **아니라** `role="button"` 인 `<div>` 다 (안에 `삭제` 버튼이 들어가므로 — 버튼 중첩 금지), Enter / Space 를 손으로 받는다. **빈 칸**: `＋ 캐릭터 생성` → `onCreate(slot)`. **시작**: 고른 칸이 `activeSlot()` 이면 새로고침 없이 `menus/enterShip`, 아니면 `setActiveSlot` + `markAutoStart` + `location.reload()`. **삭제**: `menus/askPopup` 의 danger 팝업(무엇이 사라지는지 적고 **1초 홀드**) → `deleteSlot(id)`. 푸터 `뒤로`. `isOpen` / `occupiedCount` getters. |
| `menus/CharacterCreate.ts` | **캐릭터 생성** (2026-09-09, `.title-screen.char-create`, z-index 84). **세 열**(`.cc-body`, 1280×720 에 스크롤 없이 들어간다 — 같은 날 개편). **왼쪽 `.cc-panel`** — 이름 입력칸(placeholder `최대 N자까지 입력`, `sanitizeCharacterName`, `CHARACTER_NAME_MAX`, 게임 키는 필드에서 끊는다, 안내문 없음) + 🎲 (`rollCallsign`); **시작 임플란트**는 목록이 아니라 지금 고른 것 하나의 **큰 타일** `.cc-imp-tile[data-id]` (아이콘 크게 · `--ic` 색 · 이름은 **우하단** `.nm`) — 누르면 **타일 오른쪽에 컨텍스트 메뉴** `.cc-imp-menu` (껍데기는 커뮤니티 우클릭 메뉴의 `.sc-menu`/`.sc-mi`, 항목 `.cc-imp-mi[data-id]` = 아이콘 + 이름 + 설명, 고른 것은 `.is-on`) 가 `CREATE_IMPLANT_IDS` 전부를 나열한다(이름 · 설명 · 아이콘 · 색은 `ctx.implants.getAllDefs()`); 고르면 닫히고 **바깥 mousedown · Escape** 로도 닫힌다 (Escape 는 `window` capture 에서 삼켜 `Input` 이 못 본다 — 다른 팝업과 같은 규약). **가운데 `.cc-stats-wrap`** — `ctx.progression.getAllStatDefs()` 다섯 줄을 **세로 한 줄씩**(`.cc-stat-list > .cc-stat`) 캐릭터 시트(`progression/ui/SheetBody` 의 `.cs-stat`)와 같은 어휘로 그리고 `＋` 자리에 `◀ ▶` 를 넣는다(`canAdjustStat`, **둘 다 주황** — 못 누르는 쪽만 흐려진다), 남은 점수(`statPointsLeft`)를 크게, 🎲 는 `rollCreateStats`. **오른쪽 `.cc-side`** — **3D 미리보기** (`.cc-preview`, `menus/SoldierPreview`, 열의 남는 높이를 채운다) 와 그 **바로 아래 악센트 스와치** `.cc-accent > .cc-swatches` (`ACCENT_COLORS`) — 고르면 즉시 다시 칠해진다. **주사위는 손으로 넣은 것을 말없이 지우지 않는다** — 이름을 직접 쳤거나 능력치를 한 번이라도 조정했으면 먼저 경고 팝업을 지난다. **`확정` 은 점수가 남아 있으면 `disabled`** (툴팁 `남은 점수를 모두 배분하세요`) 이고, 우회해서 눌리면 `능력치 배분 미완료` 안내 팝업(`남은 점수 N점을 모두 배분해야 캐릭터를 만들 수 있습니다.`)만 뜬다; 다 썼으면 이름 + 다섯 능력치를 적은 요약 팝업 뒤 `createCharacterInSlot` → `setActiveSlot` + `markAutoStart` + `location.reload()` (null 이면 저장소가 막힌 것 — 안내만 남기고 리로드하지 않는다). 숫자는 하나도 없다: 규칙은 전부 `shared/character.ts` 다. `isOpen` / `targetSlot` / `draftStats` / `draftImplant` / `isImplantMenuOpen` / `hasPreview` getters. |
| `menus/SoldierPreview.ts` | **생성창의 병사 미리보기** (2026-09-09). `hub/ui/PlanetHologram` · `player/Portraits` 와 같은 물건 — 자기 `WebGLRenderer` + `Scene` + 카메라 + 조명(키 · 림 · 반구광)을 들고 자기 `<canvas>` 에 그린다 (`core/Engine` 은 `EffectComposer` 로 월드를 그리고 렌더 후 훅을 주지 않는다). `@/player` 배럴의 `SoldierModel` 을 쓴다 (다른 폴더 내부를 import 하지 않는 규칙의 명시적 예외). 악센트는 생성자에서 구워지므로 `setAccent('#rrggbb')` 는 **모델을 다시 짓는다**(`Portraits` 가 슬롯 색이 바뀔 때 하는 것과 같다). 천천히 턴테이블(정면이 −Z 이므로 시작 yaw 는 π − 0.35), 닫혀 있으면 `render` 가 즉시 돌아온다, `dispose()` 가 모델 · 씬 · 렌더러 · 캔버스를 전부 놓는다. 두 번째 GL 컨텍스트를 못 얻으면 `createSoldierPreview` 가 **null** 을 돌려주고 화면은 `.cc-nogl` 안내로 내려간다. |
| `menus/askPopup.ts` | **타이틀 흐름의 경고 팝업** (2026-09-09, `.tm-ask`). `menus/PauseMenu` 의 `.pause-ask` 와 같은 물건 · 같은 2026-09-09 규약: **Escape = 취소**, **Enter 는 삼키고 아무것도 하지 않는다**, 최초 포커스는 **취소**, 그리고 `danger: true` 인 팝업(캐릭터 삭제)의 확인 버튼은 **`UI_HOLD_CONFIRM_S` 만큼 홀드**해야 실행된다(`.tm-ask-fill`, 메뉴에는 프레임 훅이 없어 rAF 로 돈다, 포인터 릴리스는 `window` 에서 듣는다). 되돌릴 수 있는 것(주사위 덮어쓰기 · 생성 확정)은 클릭 한 번. PauseMenu 와 공유하지 않는 이유는 그쪽이 `MenuBase` · 일시정지 이벤트에 묶여 있어서다. blocker 토큰 없음. `isOpen` / `holdProgress` getters. |
| `menus/enterShip.ts` | **함선 탑승 한 갈래** (2026-09-09). 예전 `TitleMenu.board()` 의 내용 그대로다 — 초대 링크(`?lobby=CODE` → `ctx.net.inviteCode`)가 있으면 `ensureConnected()` 뒤 `hub:enter {ship:'personal'}` + `joinLobby(code)` + `초대 코드 … 공유 함선에 합류 중` 토스트, 실패하면 안내(`서버에 연결할 수 없습니다 — 초대를 수락하지 못했습니다…`)를 남기고 그 다음부터는 오프라인 개인 함선. 함수로 뽑은 이유: 함선에 들어가는 문이 **둘**(선택창의 카드 · 슬롯 전환 뒤의 자동 시작)이 됐고, 초대 흐름이 한쪽에만 붙어 있으면 초대받은 사람이 슬롯을 바꾸는 순간 개인 함선에 떨어진다. `hasPendingInvite(ctx)` 로 화면이 안내 문구를 바꾼다. **`menus/newCharacter.ts` 는 삭제됐다** (2026-09-09) — `resetCharacterSaves()` 는 이미 `shared/saveSlot.deleteSlot` 의 얇은 껍데기였고, 이제 선택창이 `deleteSlot(id)` 를 직접 부른다. |
| `menus/PauseMenu.ts` | Shown on `game:paused {paused:true}`. **Phase 8** buttons: **`게임으로 돌아가기`** (emits `game:paused false`) / **`설정`** (opens the `SettingsMenu` overlay on top — key rebinding moved inside it) / **`함선으로 귀환`** (**mission only**, `display:none` in the ship because `.ui-btn` sets `display` and the `hidden` attribute would not hide it) → `hub:enter {ship: ctx.net?.lobby ? 'shared' : 'personal'}` / **`타이틀로`** → `ctx.net.leaveLobby()` (first, else `onAbort` regroups us in the shared ship) then `game:paused false` + `game:abort` → phase `menu` + hub teardown. **Ship variant** (`ctx.isHubPhase()`): the only difference is that `함선으로 귀환` is hidden. **2026-09-08**: the `함선 · 일시 정지` title variant, both subtitles, the `.mp-note` and the footer `.hint` are **removed**, and so is the ship-only `.pause-social` column (social is `hud/Community` alone) — the menu is a title plus the button column, in a raid and in the ship alike, and it **cannot be closed with Escape** (see `game/README.md`). Hidden on `game:phaseChanged`. `isHubVariant` getter. **2026-09-09 (자리 고정)**: the menu does not chase the mouse any more. `parkUnderCursor()`, `CURSOR_BIAS`, the resize listener and the `--menu-dx/dy` custom properties are **all gone**; the frame is parked by CSS alone — vertically centred, **in the left half** (`.menu.pause { justify-content: flex-start }` + `margin-left: clamp(24px, calc(25vw - 210px), 40vw)`), the same place every time (사용자 결정 2026-09-09). It replaced the 2026-09-08 behaviour, where the frame shifted itself so `게임으로 돌아가기` sat under the viewport centre, which is where Escape leaves the OS cursor. **2026-09-08 (2차)**: the `일시 정지` title is gone (Escape does not actually freeze anything), **Tab** resumes as a second, fixed shortcut — the literal `'Tab'` code, not `Keys.INVENTORY`, so the `게임으로 돌아가기 (Tab)` label can never disagree with it, and `InventorySystem` already refuses Tab under the `'menu'` blocker — and two buttons joined the column: **`파티 떠나기`** (only while `ctx.net.lobby` exists; `net.leaveLobby()`, the 도킹 해제 call) and **`게임 종료`** (`window.close()` — the Electron shell quits; a browser tab cannot be closed by a script it did not open, so it says so and falls back to 타이틀로). Those two and 타이틀로 all go through the in-frame **경고 팝업** `.pause-ask`, which owns Escape (취소) and Enter (확인) while it is up. `isAskOpen` / `partyButton` getters. |
| `menus/SettingsMenu.ts` | **설정 패널** (`.menu.settings-menu.side` — **centred and 960–1120 px wide** since 2026-09-09; it hugged the left edge from Phase 11 to stay clear of the ESC column, but the pause menu moved into the left half and this overlay carries its own backdrop, so it is centred now and the extra width goes to the 키 설정 diagram + function list; z-index 86, above the pause menu and below the key-settings overlay; **no** blocker token, like `KeybindMenu`, since the pause menu already holds `'menu'`). **2026-09-08**: a **nav rail** (`.set-nav`, 화면 설정 / 오디오 설정 / 키 설정 / **서버 설정** — 화면 first and re-selected on every `open()`) beside a **fixed-size** `.set-pane` that scrolls vertically, so switching sections never resizes the frame; `activeSection` getter. Four sections: **화면 설정** = 전체화면 (a real `document.documentElement.requestFullscreen()` — the only way `Input.syncKeyboardLock` can route Escape to the page and stop it breaking the pointer lock; refused requests simply leave the pill 끔), 화면 효과 (bloom), 그림자, 해상도 배율 (75 / 100 / 125 %), stored by `menus/displaySettings.ts` in localStorage `scav.display` and published on `ui:displayChanged` for **`main.ts`** to hand to the `Engine` (ui/ must not import core/), **키 설정** = a real **`ControlsPanel`** instance (the title screen's keyboard + mouse diagram and the per-function list, `refresh()`ed with the panel and `dispose()`d before the root, in `TitleMenu`'s order) with the `KEYBIND_BUTTON_LABEL` button under it opening the shared `KeybindMenu` instance handed to the constructor (the game has exactly one rebinding code path; these rows are never duplicated), **오디오** = one `.set-row.vol` per `AudioChannel` in `CHANNELS` (`master` 전체 / `sfx` 효과음; a BGM row would just be appended — there is no BGM) with a `<input type=range>` 0…100, the live percentage (`.set-vol`) and the description. `input` → `ctx.audio.setVolume(channel, v/100)`, `change` (release) → `+ ctx.audio.preview(channel)`. `ctx.audio` null → sliders disabled + a note in the subtitle, **서버 설정** (2026-09-10) = 접속할 릴레이 주소 한 칸(`.set-text`) + `연결 테스트` / `적용하고 다시 접속` / `기본값으로` + 상태 한 줄(`.set-net-status`, `.ok` 초록 · `.bad` 붉은색 · 클래스 없음 = 진행 중) + `기본값: …` 줄. 배포본에서 다른 PC 의 서버로 붙는 **유일한 창구**다: 적은 주소는 `NetRef.setRelayOverride` 로 슬롯 공용 localStorage 에 남고 `defaultUrl()` 이 그것을 제일 먼저 본다 (나머지 경로 — `--relay` · `SCAV_RELAY` · `server.txt` · 임베디드 — 는 데스크톱 셸이 고르고 렌더러에는 같은 오리진 `/ws` 로만 보인다; 우선순위 전체는 `shared/net` 의 `RELAY_STORAGE_KEY` 주석). `연결 테스트` 는 `probeRelay` (익명 소켓 — 살아 있는 접속을 끊지 않는다), `적용` 은 `reconnectRelay`; 분대에 들어가 있으면 그 사이에 **`AskPopup {danger}` 의 1초 홀드**가 들어간다 (파티 떠나기와 같은 규약) 그리고 **레이드 중에는 칸 · 버튼을 전부 잠근다**. `기본값: …` 줄의 값은 데스크톱 셸의 loopback 라우트 `/__scav/relay` 에서 받아 오고, 브라우저 · vite 에는 그 라우트가 없으므로 "같은 주소의 서버" 로 남는다. `networkState` getter (입력값 · 마지막 probe · 버튼 잠금 · 기본값 줄). **주의**: 이 패널이 자기 `AskPopup` 을 갖는 순간부터 `.tm-ask` 가 문서에 **둘**이다 (타이틀의 것 + 이것). 이쪽에는 `set-ask` 클래스가 붙어 있고 **문서 순서상 먼저** 오므로, 전역 `.tm-ask` 로 타이틀 팝업을 찾는 코드는 `:not(.set-ask)` 로 걸러야 한다 (`scripts/smoke-loadout.mjs` 가 실제로 여기 걸렸다). Capture-phase Escape closes it — ignored while `keybinds.isOpen` (that overlay owns Escape then); `close()` also closes the keybind overlay. This is one of the deliberate Escape exceptions: 설정 is a sub-screen **inside** the pause menu, so Escape steps back to the menu it was opened from rather than opening a second pause. Emits `ui:settingsToggled {open}`; `isOpen` / `refresh()`. |
| `menus/displaySettings.ts` | **화면 설정 store** (2026-09-08). `DisplaySettings` (fullscreen / bloom / shadows / scale), `DISPLAY_SCALES` 0.75 · 1 · 1.25, `DISPLAY_DEFAULTS`, `loadDisplaySettings()` / `saveDisplaySettings()` (localStorage `scav.display`, `scav.` prefixed so it survives 새 캐릭터로 시작 the way `scav.keybinds` / `scav.audio` do — a display preference is not a character), `isFullscreen()` and `setFullscreen(on)` (async, resolves to the state that actually took effect). `fullscreen` is deliberately **not** persisted: restoring it would need a user gesture the page does not have at startup. Only `SettingsMenu` writes it. |
| `menus/ControlsPanel.ts` | **Controls diagram** (`.controls-panel`): a procedural DOM keyboard (`KEYBOARD_ROWS`, compact ANSI layout, key widths in units) and an inline-SVG mouse (LMB / RMB / MMB / M4 / M5 regions). Every key / button that carries a bound action is lit (`.bound`) with a short caption inside; beneath, the per-function list grouped by `KEY_GROUPS` (W A S D collapse into one 이동 row, `menuOnly` inventory keys are omitted). Re-renders on `onKeybindsChanged`. Exports `KEYBIND_BUTTON_LABEL`. |
| `menus/KeybindMenu.ts` | **Key-settings overlay** (`.menu.keybind-menu`, z-index 58, above the title / pause menus; adds no blocker of its own). One row per `KEY_ACTION_DEFS` entry grouped with rules: label left, key button right (`마우스` tag on mouse-only actions, `MENU` fixed on Esc). Click a button → `키 입력…` capture (window capture-phase keydown / mousedown with `stopImmediatePropagation`; Esc cancels; `canBind` refuses keyboard keys on 사격 / 조준 / 핑) → `setKeybind` → `input:bindingsChanged`. Rows sharing a key in overlapping scopes get `.conflict` + a `⚠ … 와 겹침` warning and the note names the clash. Footer: `기본 키 설정으로 초기화` (`resetKeybinds`) / `닫기`. Emits `ui:keybindsToggled`. |
| `menus/DeathScreen.ts` | "전사" + kills / survival time / crates / damage / **소실된 전리품 가치** (from `ctx.inventory.getTotalValue()`, rendered `1,200 C` through `formatCredits` since Phase 10). Shown on `game:phaseChanged {phase:'dead'}` (solo death flow v2; the legacy `game:over {stats}` still shows it), hidden when the phase leaves `dead`. **2026-09-09: 부활 버튼과 Space 핸들러가 사라졌다** (자동 부활 제거) — 유일한 버튼은 **`함선으로 귀환`** → `hub:enter {ship}` 이고 부제는 `스캐빈저 신호 소실 — 장비는 유해에 남았습니다` 다. phase `dead` 는 이제 레이드가 정말 끝났을 때(솔로 사망 · 분대 전멸)만 오고, 분대에서 혼자 죽으면 `hud/SpectateOverlay` 가 구조선 대기를 보여 준다. The old `다시 배치 (같은 시드)` button is gone (no mission failure on death). **Phase 5:** `RewardsBlock` (`fill(stats.rewards, 'dead')` → `진척 유지 안 됨` fallback wording) under the stats; `update(dt)` (called by HudSystem) drives its count-up; `rewardsBlock` getter. **Phase 7 — 레이드 실패 mode:** `game:raidFailed` (emitted by game/ right before `game:over` on a squad wipe / solo death) arms `.raid-failed`: title `레이드 실패`, subtitle `분대 전멸 — 스캐빈저 신호 완전 소실`, `함선으로 귀환` stays, and a `.auto-return` line counts `n초 후 자동 귀환` down from `RAID_FAILED_AUTO_RETURN_S` on `update(dt)` (display only — game/ performs the return, `함선으로 귀환 중…` at 0). The mode resets on `game:newMission` / `game:abort`; `isRaidFailed` getter (also `HudSystem.isRaidFailed`). The multiplayer spectate overlay is untouched (it stays until the wipe). **Phase 11:** a `.planet-line` under the subtitle (`행성 · <planetLabel(ctx.missionPlanet)>`, `목표 미지정` with no planet), filled in `fill()`. |
| `menus/RewardsBlock.ts` | **XP settlement block** shared by both result screens (`.rewards`, between the stats and the actions; Phase 5). `fill(stats.rewards, 'complete' | 'dead')`: `획득 XP +n` counts up (0.35 s delay, 1.1 s eased), `Lv. a → b` (or `Lv. a`), XP bar `xp / xpToNext` filling from the pre-mission fraction (a level-up runs it to full first, then to the new fraction), `xp / xpToNext XP` numbers. **Level-up moment (Phase 7):** the instant the eased count-up crosses the boundary (`LEVEL_CROSS` 0.6 — the bar hits the old cap) `cross()` adds `.up`, pops the `레벨 업` badge (`rewardsUp`), flashes the level / bar (`rewardsLvFlash` / `rewardsBarFlash`), spawns a `.up-burst` radial light burst (`rewardsBurst`, removed after 900 ms) and emits `audio:play {id:'level_up'}` — the **only** place that chime plays (audio/ dropped its `progress:levelUp` hook, `ProgressToasts` no longer toasts level-ups). Contract line (`.contract-line`) keyed on `settlement.outcome` through the exported `contractOutcome()` / `CONTRACT_OUTCOME_TEXT` / `CONTRACT_OUTCOME_CLASS` (shared with `MetaToasts`): `계약 성공 · name · 신뢰도 +rep · 크레딧 +credits C` (`.success`), `계약 미완 · 계속 · name p / t` (`.keep`), `계약 실패 · 진척 유지 안 됨 · name p / t` (`.lost`); the `fill(…, 'complete' | 'dead')` mode is only the fallback for settlements without `outcome`. Hidden when `contract` is null; `rewards` undefined hides the whole block (legacy emitters). `update(dt)` from the owning menu, `stop()` on hide, `isCounting` / `isLevelUp` / `isBursting` getters. |
| `menus/MissionComplete.ts` | "탈출 성공" summary with counting-up **전리품 가치** (eased, 1.6 s, `ui_equip` chime at end; every frame of the count-up is formatted `1,200 C` by `formatCredits` since Phase 10), kills / time / crates / damage. **`함선으로 귀환`** (primary, `hub:enter`); `다시 배치 (같은 시드)` only in single-player. Shown on `game:complete`. **Phase 5:** `RewardsBlock` (`fill(stats.rewards, 'complete')`) under the stats, driven by `update(dt)`; `rewardsBlock` getter. **Phase 11:** a `.planet-line` (`행성 · <planetLabel(ctx.missionPlanet)>`) under the subtitle, and `다시 배치` emits `game:newMission {seed, planet: ctx.missionPlanet}` — without the field the same seed would be re-generated for whatever planet is selected next. |
| **menus/social/ — Phase 11** | |
| `menus/social/socialSource.ts` | The **one** place `src/ui/` reads the social mirror from. `socialOf(ctx)` = the installed debug ref, else `ctx.net?.social`, else null; `socialReady(ctx)` folds in `available`; `SOCIAL_UNAVAILABLE_KO` is the single `소셜 기능을 사용할 수 없습니다` string. `setDebugSocial(snapshot, invites, mySquad)` builds a **synthetic `SocialRef`** from a plain snapshot for the headless smoke (the `debugRemotes` pattern): its getters are live, its mutators are real enough to test the UI (`respondFriend(code, true)` moves the row into `friends`, `acceptInvite` / `dismissInvite` drop the invite, `removeFriend` removes it) and every call is appended to the exported `debugSocialCalls` (`HudSystem.debugSocialLog`). `setDebugSocial(null)` hands the UI back to the relay. |
| `menus/social/SocialColumn.ts` | The **소셜 열** (`.social-col`) — one component, two hosts: the ESC screen's right column (`menus/PauseMenu`, ship only) and the 커뮤니티 panel (`hud/Community`). Sections top to bottom: **분대원** (from `ctx.net.lobby.players`, hidden with no lobby) — **2026-09-08 a 1×`NET_MAX_PLAYERS` grid**, one cell per lobby slot (slot-coloured bar, 아이디 + 이름 + `Lv. n` stacked left, the **voice slider + mute toggle** right — `SQUAD_VOICE_DEFAULT`, **UI only**, kept in a local `Map` keyed by PeerId, titled `보이스 채팅 준비 중`); unheld slots are drawn as `빈 자리` so the row never changes width, and the section header carries **파티 떠나기** (`.sc-leave` → `net.leaveLobby()` behind `SocialMenu.askConfirm`) —, **받은 친구 요청** (hidden when empty; each card gains 수락 / 거절 → `respondFriend`), **친구** (`친구 n · 접속 m` head, `SOCIAL_FRIEND_ROWS` visible then scroll) and **최근 플레이어** (`SOCIAL_RECENT_ROWS`, capped at `SOCIAL_RECENT_MAX`). Grids are `SOCIAL_CARDS_PER_ROW` wide via `--cols` and `--rows` custom properties, and capture their own `wheel`; 친구 / 최근 are `.sc-grid.fixed` — an exact `rows × 56 px` box rather than a `max-height`, so the panel never resizes around them (받은 친구 요청 stays elastic: taller cards, and it only exists while it has something in it). Everything comes from `socialOf(ctx)`; while that is missing or `available === false` the column collapses to the single `.sc-off` line (its start state, so an unrefreshed column never shows empty grids). Repaints only when a **change key** (snapshot rows + the lobby roster) moved, or on `refresh(true)` after a local mutation; re-keyed by `social:updated` / `social:play` / `social:error` / `net:lobbyUpdated` / `net:lobbyLeft`. `contextMenu` / `isAvailable` getters. |
| `menus/social/ProfileCard.ts` | `buildProfileCard(p, handlers, request?)` → one `.sc-card`: 아이디 (`formatPlayerCode`) + `Lv. n` on top, 이름 + presence dot / `PRESENCE_LABELS` under it, `data-code` = the bare 8-char code, `.is-<presence>` for the dot colour (offline dims the card). **Identity is always the `PlayerCode`** — a PeerId never reaches the UI. `request: true` adds the 수락 / 거절 row. A left **or** right click raises the column's context menu; the card holds no state. |
| `menus/social/SocialMenu.ts` | The card's right-click menu (`.sc-menu`) and the column's shared **경고 팝업** (`.sc-confirm` — 친구 삭제 since Phase 11, and 분대 → **파티 떠나기** since 2026-09-08 through the general `askConfirm(title, body, ok, run)`), both **direct children of `ctx.uiRoot`** and `.interactive` so they float over the ESC frame and the community panel alike. Entries: `같이 하기` (enabled only while `SocialRef.playBlock(code)` is null, else disabled with the `PLAY_BLOCK_LABELS` reason beside it), `귓속말하기` (the host closes itself, then emits `chat:whisperTo`), `친구 삭제` (friends only, and only through the confirm card — its title / body / 확인 label are per-call now) / `친구 추가` (non-friends only). Positioned `fixed` at the click point, clamped into the viewport. Takes **no** blocker token — it only opens over a surface that already owns one — and a capture-phase Escape closes just the menu (or just the confirm), so the first Escape never also closes the screen underneath. Closes on an outside `mousedown`. `isOpen` / `isConfirmOpen` / `targetCode` getters. |

Removed: `menus/LobbyMenu.ts` (the shared ship hub replaces the lobby screen; `ui:lobbyToggled` stays in the contract but nobody emits/consumes it now) and `menus/seed.ts` (seed parsing lives in the hub terminal).

## Phase → UI mapping
| `ctx.phase` | Shown |
|---|---|
| `menu` | `TitleMenu` only |
| `hub` / `docking` | social HUD (chat, squad — when `ctx.net.lobby` —, nameplates, notifications, prompt) with `.hub`; the hub's own terminal menu is owned by `src/hub/` (blocker token `'hub'`) |
| `deploying` + gameplay phases | gameplay HUD + social HUD (+ overlay); `PauseMenu` on `game:paused` hides both HUD layers (`'menu'` blocker) |
| `dead` (solo, ~2.5 s after `player:died`) | `DeathScreen` (2026-09-09: 부활 버튼 없음); in multiplayer the phase stays a gameplay phase and both HUD layers go `.spectating` (`SpectateOverlay` carries `남은 구조선 n`) |
| `complete` | `MissionComplete` |

## Events consumed
`game:phaseChanged`, `game:paused`, `game:complete`, `game:over`, `game:abort`, `game:newMission`, `world:ready`, `player:*`
(incl. `player:staminaDepleted`, `player:aimChanged`, `player:died`, `player:spawned`), `interact:promptChanged`, `weapon:*` (incl. `weapon:equipped`, `weapon:scopeChanged`),
`weapon:durabilityChanged`, `weapon:broken`, `weapon:swapStarted` (WeaponPanel),
`stim:countChanged`, `grenade:countChanged`, `loadout:changed` (`primary/primary2/secondary`), `inventory:itemAdded/full/bagChanged/itemUpdated`, `crate:looted`,
`enemy:waveStarted`, `extraction:*`, `ping:placed/removed` (map), `ui:notify`, `ui:objective`, `ui:hitmarker`, `ui:damageIndicator`,
`chat:post`, `pickup:taken`, `hub:slotChanged`, `hub:launchCountdown`, `hub:entered`,
`net:lobbyLeft`, `net:peerJoined`, `net:peerLeft`, `net:remotePlayerRemoved`, `net:remoteDied`, `net:remotePing` (fallback only), `net:chat`,
`net:reconnecting`, `net:resumed`, `net:matched`; `ctx.net.onMessage('ping')`.
**Phase 2:** `player:downed`, `player:downHpChanged`, `player:revived`, `player:reviveProgress`, `game:respawnAvailable`, `net:remoteDowned`, `net:remoteRevived`,
`inventory:quickSlotsChanged`, `quick:wheelChanged`, `quick:equipped`, `quick:used`, `grenade:holdChanged`; reads `ctx.player.isDowned/downHp`, `ctx.inventory.getQuickSlots/getQuickSlotCount/getDef/findItem`, `ctx.input.wasPressed(Keys.RESPAWN)`.
**Phase 3:** `stratagem:wheelChanged`, `stratagem:armed`, `stratagem:chargeChanged`, `stratagem:targeting`, `stratagem:called`, `stratagem:landed`, `stratagem:ended`, `stratagem:cooldown`, `structure:destroyed`, `ping:placedV2` (own emission, owner-filtered); reads `ctx.stratagems?.cooldown/cooldownTotal`, `ctx.weapons?.getGrenades()` (both null-guarded), `ctx.net.getLobbyPlayer/getRemotePlayer` for caller names.

**Tactical kit:** `implant:equipped/activated/cooldownChanged/wieldChanged/grappleTargetChanged/grappleAttached/grappleReleased/dashed/barrierChanged/barrierHit/scanned`,
`gadget:deployed/removed/recovered`, `melee:swing/hit`, `player:rolled/downed/revived/cloakChanged/gritSaved/burning`,
`equip:changed`, `inventory:weightChanged`, `inventory:overloaded`, `quickbar:changed/used`, `durability:changed/broken`, `repair:completed`,
`detect:reveal`, `detect:clear`, `gather:collected`, `craft:completed/failed`, `progress:levelUp/skillUp/xpGained`.
Refs read (all optional, always null-checked): `ctx.implants` (`equipped`, `wielded`, `cooldownRemaining/Total`, `charges/maxCharges`, `barrierHp/MaxHp/Active`, `getDef`),
`ctx.progression.derived.detectRadius / enemyDetectRadius` + `getSkillDef`, `ctx.gadgets.getDeployables()`, `ctx.inventory.getQuickSlots/getWeight/getDef`,
`ctx.enemies.queryNear` (optional, falls back to `getEnemies()`), `ctx.world.getGatherNodes()`, `ctx.player.isDowned/bleedoutRemaining/isBurning/isCloaked`,
`RemotePlayerRef.isDowned`.

**Phase 6:** `weapon:chargeChanged` (WeaponChargeGauge), `enemy:incinerated` / `enemy:shocked` (StatusMarkers), `cheat:moveCheat` (CheatTag),
`ui:keyGuide` (KeyGuide, 2026-09-09), `hub:roomEntered` (RoomLabel), `input:bindingsChanged` (KeyGuide close label, ChatLog close hint, MapScreen / Community guide re-emit);
reads `WeaponDef.unique / altFire` through `ctx.loot.getWeaponDef` (WeaponPanel), `FURNITURE_DEF_MAP` and `ROOM_PURPOSE_LABEL_KO` from `@/shared`. `weapon:beamChanged` and
`console:toggled` are deliberately not consumed (audio loops on the beam; the console overlay is not a HUD concern).
**Phase 5:** `meta:creditsChanged`, `meta:repChanged`, `meta:contractProgress`, `meta:contractSettled`, `meta:contractAccepted`, `meta:contractAbandoned`, `meta:questChanged`, `meta:purchase`, `meta:sale`,
`progress:loaded`, `progress:levelUp` (title chip only); reads `ctx.meta?.activeContract`, `ctx.progression?.level`, `stats.rewards` (`MissionRewards`) on `game:complete` / `game:over`, and `CORP_DEFS` / `CONTRACT_DEFS` / `CONTRACT_GOAL_LABEL_KO` / `QUEST_DEFS` from `@/shared`.
**Phase 7:** `game:raidFailed` (DeathScreen), `net:hostChanged`, `net:peerSuspended`, `net:missionMembership`, `net:lobbyUpdated` (Squad refresh), `training:exitRequested`, `game:newMission.mode` (chat / notifications);
reads `RemotePlayerRef.suspended / inMission`, `LobbyPlayer.inMission`, `LobbyState.mode / started`, `ctx.missionMode`, `ctx.world.mode`, `ContractSettlement.outcome`, and `SUSPENDED_LABEL_KO` / `RAID_FAILED_AUTO_RETURN_S` from `@/shared`. `ctx.stats.extracted` is no longer read anywhere in ui/.
**Phase 11:** `social:updated`, `social:play`, `social:error`, `social:invited`, `social:inviteClosed`, `social:whisper`, `chat:whisperTo`,
`net:lobbyUpdated` / `net:lobbyLeft` (SocialColumn's 분대원 rows), `input:bindingsChanged` (the invite hint's `Keys.INVITE` label);
reads `ctx.net.social` (`SocialRef`: `me` / `friends` / `incoming` / `outgoing` / `recent` / `invites` / `onlineFriends` / `hasNews` /
`playBlock` and the mutators) through `menus/social/socialSource`, `ctx.net.lobby.players` for 분대원, `ctx.missionPlanet` on the result
screens, `ctx.input.isDown(Keys.INVITE)` for the hold, and `formatPlayerCode` / `PRESENCE_LABELS` / `PLAY_BLOCK_LABELS` / `planetLabel` /
`SOCIAL_*` / `SQUAD_*` / `COMMUNITY_BLOCKER` from `@/shared`. **Only `PlayerCode` is ever shown** — no PeerId reaches the social UI.

## Events emitted
`hub:enter {ship}` (title / pause / death / complete), `game:newMission {seed}` (complete-screen redeploy), `game:respawn {}` (death screen button / Space, spectate Space), `game:paused {paused:false}`, `ui:objective`, `ui:notify` (title invite feedback),
`ping:placed {id, position, kind, expires}` + `ping:placedV2 {…, owner}` (local and squad pings), `ping:removed {id}`, `ui:mapToggled {open}`, `ui:chatToggled {open}`,
`ui:keyGuide {owner, keys|null}` (MapScreen `'map'`, Community `'community'` — 2026-09-09), `chat:post {text, kind}` (Pings: item/crate/attack/caution callouts, ammo request), `chat:message {id, name, text, kind, local}` (ChatLog, every line),
`audio:play {id:'ui_click'|'ui_equip'}`, `audio:play {id:'level_up'}` (RewardsBlock, once per level-up settlement at the boundary crossing — the only level-up chime in the game since Phase 7).
**Phase 8:** `ui:settingsToggled {open}` (SettingsMenu), `game:abort` (PauseMenu 타이틀로). Refs called: `ctx.audio.setVolume / preview`, `ctx.housing.setManageRoom / selectFurniture`, `ctx.net.leaveLobby`.
**Phase 11:** `ui:communityToggled {open}` (Community), `chat:whisperTo {code, name}` (both social columns' 귓속말하기),
`game:newMission {seed, planet}` (MissionComplete 다시 배치 now carries `ctx.missionPlanet`). Social refs called:
`social.refresh / requestFriend / respondFriend / removeFriend / playWith / acceptInvite / dismissInvite / whisper`.
Net calls: `setPlayerName`, `ensureConnected`, `joinLobby`, `send({t:'ping', p, kind, label?, enemyId?}, 'others')`, `send({t:'chat', text, kind}, 'others')`, `onMessage('ping')`, `getLobbyPlayer`, `getRemotePlayer(s)`.

## Pointer lock etiquette
Anything that opens a full-screen UI adds its `ctx.uiBlockers` token **first** and only then calls `ctx.input.exitPointerLock()`;
GameFlow pauses on any lock loss that happens with no blocker present. When a UI closes back into gameplay (or the hub, for chat) it
requests the lock again (map, chat, inventory, pause resume) — deferred one microtask so a synchronous phase change right after the close wins.
Blocker tokens owned here: `'menu'` (MenuBase), `'map'` (MapScreen), `'chat'` (ChatLog), **`COMMUNITY_BLOCKER`** (`hud/Community`,
Phase 11 — `uiBlockers.add` **then** `ctx.input.setCursorMode(true, COMMUNITY_BLOCKER)`, the reverse on close; it never calls
`exitPointerLock`). `menus/social/SocialMenu` and its confirm card take **no** token (they only open over a surface that already owns
one) and swallow just their own Escape; `.pause-social` is inside the pause menu's `'menu'` token. `SpectateOverlay`, `Squad`, `Nameplates`,
`Notifications` and the closed chat log never take a token and are `pointer-events:none` (the chat root becomes `.interactive` only while its input is open).

## CSS added for these features (`styles/base.css`)
`.vitals .stamina(.full/.low/.depleted) .stam-bar .fill`, `.scope(.show) …`, `.ping-markers`,
`.pmarker(.ground/.enemy/.crate/.extraction/.item/.attack/.caution/.lost/.remote) .ico .lbl .dist` (**2026-09-09: `.ping-hint` 는 삭제됐다** — 그 자리는 `styles/wheels.css` 의 `.pwheel` 이다),
`.map-screen …`, `.map-legend-row .sw(.ping.attack/.ping.caution/.pickup/.squad)`, `.ui-btn.small`.

**Weapon package (after `@keyframes ammoFlash`):** `.weapon .slot-lbl`, `.weapon .dura(.worn/.broken) .fill`, `.weapon.broken .name/.mag`, `.weapon.broken-flash` (`@keyframes weaponBroken`),
`.weapon .swap(.show) .fill` (`--swap-d`, `@keyframes swapShow/swapSweep`). (`.wslots` / `.wslot…` 는 2026-09-10 에 없어졌다.)

**`── multiplayer ──` section:** `.slot-0…3` (`--sc`), `.menu .form-msg(.info/.success/.warning/.danger)`, `.menu .ui-btn:disabled`, `.menu .mp-note`,
`.squad`, `.srow(.me/.dead/.off/.drop/.ready/.low) .bar .body .top .name .state .hp .fill`, `.nameplates`, `.nameplate(.far/.dead/.has-shield) .name .sh .hp .fill` (`.sh` = 2026-09-11 C-19 실드 바, `--shc`),
`.pmarker.remote`, `.spectate .inner .main .count`, `.hud.spectating` (hides `.reticle/.vitals/.weapon/.prompt`). The lobby-screen rules
(`.menu.lobby`, `.lobby-*`, `.status-pill`, `.code-block`, `.slots`, `.slot-card`, `.host-row`) were removed with `LobbyMenu`.

**`── tactical kit ──` section:** `.implant(.ready/.cooling/.wielded/.pulse) .dial .ico .cd .info .head .name .charges i(.on) .barrier(.active/.low/.hit) .bar i .val`,
`.quickbar(.wide)`, `.qslot(.empty/.used) .k .ico .qty .nm`, `.weightbar(.light/.heavy/.over/.alert) .row .val .bar .fill .tick(.heavy) .state`,
`.detect-arrows`, `.detect-arrow i`, `.deployables`, `.dmarker(.mine/.arming) .ico .lbl .dist`,
`.downed-layer(.active)`, `.downed-panel(.critical) .title .sub .bar .time`, `.downed-markers`, `.downed-marker(.near) .ico .nm .dist .hint`,
`.progress-toasts`, `.ptoast(.level/.skill/.xp/.in/.out) .k .v .s`,
`.action-fx`, `.fx-swipe(.go/.hit) i`, `.fx-roll(.go)`, `.fx-dash(.go)`, `.fx-shield(.go)`, `.fx-flash(.go/.grit)`, `.fx-burn(.on)`, `.fx-cloak(.on)`, `.fx-banner(.in)`,
`.reticle .hook(.valid/.attached) i .gdist`, `.map-legend-row .sw(.gather/.deploy/.mine)`,
`.hud.spectating .implant/.quickbar/.weightbar`. Keyframes: `barrierHit`, `implantPulse`, `qslotUse`, `weightAlert`, `downedPulse`, `meleeSwipe`, `rollBlur`, `dashLines`, `shieldFlash`, `fxFlash`, `fxGrit`, `burnPulse`.

**`── ship hub / chat ──` section:** `.chat(.open/.interactive)`, `.chat-lines`, `.chat-line(.text/.ping/.request/.system/.me/.faded) .ts .who .txt`,
`.chat-input-row`, `.chat-prompt`, `.chat-input`, `.chat-hint`, `.hud.hub .chat` (bottom 32 px), `.hud.spectating .chat`, `.hud.hub .prompt`, `.hud.hub .squad`.

**`── Phase 2 ──` section (end of file):** `.qwheel(.show) .ring .qarc(.empty/.locked/.hover) .items .centre .qname(.dim) .qsub`, `.qsector(.hover/.locked/.empty) .ico .cnt .lock .dir`,
`.cook(.show/.cooking/.warm/.hot) .track .fill .text .lbl .tag(.show)` (`@keyframes cookPulse`), `.weapon .cons …` + `.weapon.consumable` (hides the direct-child gun rows), (`.wslot.quick` 두 줄은 2026-09-11 C-26 에서 지웠다),
`.vitals.downed …` + `.vitals .down-sub` / `.revive(.show) .txt .bar .fill` (`@keyframes downedPulse`), `.spectate .respawn(.ready)`, `.menu.death .ui-btn.respawn(.waiting)`, `.hud.spectating .qwheel/.cook`.

**`── Phase 3 ──` section (end of file):** `.swheel(.show/.cooling) .ring .sarc(.hover) .items .centre .sname(.dim) .scd .ssub`, `.ssector(.hover) .ico .nm .cd` (`--sc`),
`.strat-panel(.off/.armed/.targeting/.cooling) .row .keycap.g(.lit) .ico .nm .hint .ctrl .cd-bar .fill`, `.charge(.show/.ready) .track .fill .lbl`,
`.hud.targeting .reticle` (hidden), `.targeting-hud(.show/.topview) .frame .corner(.tl/.tr/.bl/.br) .head .ico .nm .dist .hint` (`--sc`), `.hud.spectating .swheel/.strat-panel/.charge/.targeting-hud`,
`.offscr`, `.oarrow(.show/.grenade(.hot)/.ping.<kind>/.call.<kind>) .tip .body .ico .lbl` (`--oc`, `--rot`).

**`═══ Phase 6 ═══` section (end of file):** `.wcharge(.show/.ready/.charge/.spinup/.slash) .track .fill .lbl` (`--wc` per kind, `cookPulse` when ready), `.status-markers`, `.smarker(.show/.burn/.shock)` (`@keyframes sparkPop`),
`.cheat-tag(.show)`, `.hud.housing`, `.housing-hint(.show) .row(.sel/.cell/.keys) .k .v .name(.none) .yaw .valid(.ok/.bad)` (`--fc`), `.room-label(.show) .num .sep .purpose`,
`.weapon .modes .mode .mk .mv` + `.weapon.has-modes > .modes` / `.weapon.consumable > .modes` (hidden), `.hud.spectating .wcharge`.

**`═══ Phase 8 ═══` section (end of file):** `.item-chips`, `.item-chip(.is-short/.is-free) .item-chip-thumb .item-chip-icon .item-chip-count .item-chip-have .item-chip-sep .item-chip-need .item-chip-name`, `.item-chip-free`
(`--chip-size` / `--rc` / `--ic`; the markup contract lives in `src/shared/itemChip.ts` and is emitted by housing / inventory / meta / ui alike);
`.menu.settings-menu` (z-index 56) `.set-head .set-body .set-section(.audio) .set-section-title .set-row(.vol) .set-row-left .set-row-label .set-row-desc .set-row-right .set-key-btn .set-slider .set-vol .set-hint .set-foot`;
`.ship-hint(.show) .t .keycap`; `.key-guide(.show) .kg-item .keycap .kg-label .kg-sep` (2026-09-09; `.housing-hint` / `.housing-exit` are gone); `.chat-hint .keycap .chat-hint-t`, `--chat-closed-h` on `.chat`; `.ship-manage(.show) .sm-rooms .sm-title .sm-room-list .sm-room(.empty/.is-on) .n .p .c`, `.sm-bar .sm-bar-head .sm-empty .sm-cards`, `.fcard(.is-sel/.is-empty) .fcard-thumb .fcard-glyph .fcard-size .fcard-name .fcard-cost .fcard-own(.none)` (`--fc`).

**`═══ Phase 11 ═══` section (end of file):** `.menu.pause` (`justify-content: flex-start`) + `.menu.pause .frame` (left margin) +
`.pause-social`; the shared column `.social-col .sc-off .sc-body .sc-section(.squad/.reqs/.friends/.recent) .sc-head .sc-note .sc-empty
.sc-grid(.is-empty)` (`--cols` / `--rows`), the card `.sc-card(.is-ship/.is-raid/.is-training/.is-offline/.is-request) .sc-top .sc-bot
.sc-id .sc-lv .sc-name .sc-pres .dot .sc-acts .sc-act(.ok)`, the squad row `.sc-squad .sc-srow(.me) .sc-sleft .sc-sright .sc-vol .sc-mute(.is-on)`
(`--sc`), the menu `.sc-menu(z-index 300) .sc-menu-items .sc-mi(.is-off) .l .w` and `.sc-confirm .sc-confirm-card .sc-confirm-title
.sc-confirm-body .sc-confirm-foot`; `.menu.settings-menu.side` + `.set-section.keys .controls-panel` / `.ctl-list` (2 columns);
`.community(.show) .cm-btn .cm-glyph .cm-tag .cm-count .cm-dot` (`@keyframes cmDot`) + `.hud.hub .cheat-tag` (`top: 108px`) +
`.cm-invites .cm-invite(.is-active) .ci-top .ci-id .ci-x .ci-name .ci-hint .ci-bar i` + `.community-panel .cp-frame .cp-head .cp-title
.cp-code .cp-close`; `.chat-target .t .x`, `.chat-line.whisper`, `.hud-bl.whispering`.

## Verification (2026-09-06, Phase 2 HUD)
`npm run typecheck` 0 errors. Throwaway headless smoke (puppeteer-core against vite, synthetic bus events in a live solo mission) 37/37: wheel show/hide + 6 locked sectors with `active:2` + hover name + S-sector icon/count + reticle inline opacity 0.25 → 1; cook gauge pin hint → `.hot` / `0.3 s` / `언더핸드` / dasharray 0.9 → hidden; consumable mode name/count/hints, `F` cell active, `quick:used` count, back to gun mode; downed vitals label / `60` / revive 50 % → cancel → revived + toasts (`부활 — 체력 10`, `박대원 전투불능 — 구조 필요`, `박대원 부활`); death screen on `setPhase('dead')` with `부활 (30초)` disabled → `부활` enabled at 0 + `부활 준비 완료` toast → click emits `game:respawn` and hides; spectate `부활 가능까지 5초` → `Space: 부활` → Space emits `game:respawn` → hidden on `player:spawned`. Note for future smokes: under swiftshader the CSS `opacity` transition lags the inline style by ~0.4 s wall time — assert on `el.style.opacity`, and fire `game:respawnAvailable {seconds:0}` in the same `evaluate` as the click/keydown because the real `GameFlowSystem` ticks its own countdown after `player:died`.

## Verification (2026-09-06, Phase 3 HUD)
`npm run typecheck` 0 errors. Throwaway headless smoke (puppeteer-core against a running vite, synthetic `stratagem:*` / `ping:placedV2` / `structure:destroyed` bus events in a live solo mission — the stratagems system was not required) 47/47: wheel 4 sectors, `.show`, hovered 항공 폭탄 + centre name/hint, reticle inline opacity 0.25 → 1, ◎ glyph, `.cooling` + `재충전 43초`; panel `재충전 43초` + bar scaleX 0.531 → `함선 호출 준비` + toast `함선 호출 준비 완료`, armed 궤도 폭격 with `좌클 홀드 → 위치 지정`, 보급품 투하 with `좌클 투하 · 우클 취소`; charge ring `위치 지정까지 1.5 s` at t 0.5 (dasharray 150.8/301.59), hidden at −1, `.ready` at 1; targeting: `.hud.targeting`, topview frame with 4 corners, `항공 폭탄 — 위치 지정`, `50 m`, confirm hint, reticle computed opacity 0, removed on `active:false`; off-screen: airstrike behind the camera + remote 돌격 ping → 2 arrows pinned to the lower half (own ping and an on-screen supply drop skipped), `▼5초` ETA label, remote-caller toast, arrows gone on `landed` / `ping:removed`, `착탄` toast, `엄폐물 파괴` deduped, laser arrow persists after landing until `ended` while the ping expired after `OFFSCREEN_PING_SECONDS`; title controls list `G 함선 호출 (길게: 휠)`. 0 page errors (only the relay-less `ws://…/ws` connection error).

## Tactical kit (merged 2026-09-06)

New gameplay-layer widgets (all bound by `HudSystem`): `hud/ImplantWidget` (icon + cooldown ring + charges + barrier bar from `implant:*`), `hud/Detection` (fresnel highlight shells on interactables inside `derived.detectRadius`, off-screen enemy arrows inside `derived.enemyDetectRadius`, pooled), `hud/ScanReveal` (`detect:reveal` outlines through walls), `hud/Deployables` (mine indicators + deployable markers), `hud/ActionFeedback` (roll / melee / grit feedback), `hud/ProgressToasts` (level-up / skill-up, social layer); `hud/Reticle` grows the grapple bracket on `implant:grappleTargetChanged`; `hud/Notifications` adds durability / weight / gather / craft / gadget / implant toasts (the standalone `hud/WeightBar` readout was removed in the Phase 9 UI pass — 무게 lives in the inventory window only); `map/MapScreen` draws deployables and gather nodes.
Dropped from the branch: `hud/QuickBar` (the Phase 2 quick wheel + `hud/SlotStrip` stay) and `hud/DownedOverlay` (Phase 2 downed vitals stay). Key hints now read **T** 빠른 사용 / **H** 스팀 (`Vitals`, `SlotStrip`, `WeaponPanel`, title controls).

## 2026-09-06 — controls screen · key rebinding · implant gauge · screen tabs
- **Title screen**: the text list of controls is gone; `menus/ControlsPanel` draws a keyboard + mouse with the bound keys lit and the function list under it
  (R reads `재장전 / (수류탄을 들고 있을 때) 코킹`, G reads `함선 호출`, no grenade row, no inventory-internal keys). `키 설정 변경` (title footer and the pause menu) opens
  `menus/KeybindMenu`; every HUD key hint now reads the live binding (`keyLabel(Keys.X)`, refreshed on `input:bindingsChanged`): InteractionPrompt (E), StratagemPanel (G),
  WeaponPanel / SlotStrip (1 2 3 T — `weaponSlotKey(slot)` replaced the static `WEAPON_SLOT_KEY`), ImplantWidget (Q).
- **Implant HUD**: the bottom-centre dial is replaced by `hud/ImplantWidget`'s vertical gauge left of the reticle (see the table). `hud/Reticle` shows the grapple
  bracket whenever the grapple is *equipped* and the anchor is hookable (or attached) — the grapple no longer has a wielded state.
- **Screen tabs** (`.scr-tabs` / `.scr-tab` in `styles/base.css`, shared with inventory and progression): 인벤토리 · 캐릭터 · 기업 (disabled) on top of the inventory
  window and the character sheet.
- Smoke: `npm run smoke:controls` (`scripts/smoke-controls-hub.mjs`, 60 checks, `--shots` for PNGs).

## 2026-09-06 — Phase 6 HUD (dev console · unique weapons · ship housing)
- New: `hud/WeaponChargeGauge` (charge / spin-up / slash arc, colour per kind), `hud/StatusMarkers` (pooled 🔥 전소 / ⚡ world markers on sim time),
  `hud/CheatTag` (`MOVE CHEAT`), `hud/HousingHint` (own `.hud.housing` layer: furniture + yaw, cursor cell + 설치 가능/불가, live key hints), `hud/RoomLabel`
  (`방 n · 용도`, 1.5 s). `hud/WeaponPanel` shows `좌 / 우` fire-mode lines for `WeaponDef.unique` defs. See the table rows above.
- Verification: `npm run typecheck` 0 errors. `node scripts/smoke-ui-p6.mjs` **48/48** (registered in `scripts/verify.mjs` as `smoke-ui-p6`, `folders: ['ui']`):
  layers, charge 50 % → spinup ready → slash 25 % → −1 hidden → swap hides, all six unique defs' mode lines + graded rifle hides them, burn marker
  projected / fading / released on `ctx.time`, 3 sparks expire, 14 bursts stay within the 12-slot pool, MOVE CHEAT on/off, housing bar text / yaw / cell
  validity / reset, room label show → fade after 1.5 s → null hides, `game:abort` clears everything, 0 console errors. `node scripts/smoke-phase2.mjs` 44/44 (HUD regression).
- Smoke-running note: while other agents edit the tree in parallel, vite 5273 full-reloads the page on every non-HMR-able change and no smoke ever
  reaches `playing` (`ctx.time` keeps resetting to 0). Run against a second vite with `server.hmr: false` on another port (temporary config, untracked)
  and with the relay up — a missing relay adds one `ws://…/ws` console error that fails the final check of every smoke.

## 2026-09-06 — Phase 5 HUD (corporations · credits · contracts)
- New: `menus/RewardsBlock` (result-screen XP settlement + contract line, used by `MissionComplete` / `DeathScreen`), `hud/ContractPanel` (active contract
  under the objective), `hud/MetaToasts` (credits chip / reputation level / contract settlement in the `ProgressToasts` column); `hud/Notifications` gained the
  quest / contract accept-abandon / purchase / sale lines; `menus/TitleMenu` shows a `Lv. n` chip beside the callsign. CSS at the end of `styles/base.css`
  (`.menu .rewards`, `.contract-panel`, `.ptoast.credits / .rep / .contract`, `.menu.title .lv-chip`). The meta folder never toasts — every toast lives here.
- Driven purely by bus events + `ctx.meta?.activeContract` / `stats.rewards`, so a skeleton `ctx.meta` still yields a panel on `meta:contractProgress`.
- Verification: `npm run typecheck` 0 errors in `src/ui`. `node scripts/smoke-ui-p5.mjs` **52/52** (registered in `scripts/verify.mjs` as `smoke-ui-p5`,
  `folders: ['ui', 'meta', 'game']`; parks the `vite-hmr` socket): title chip live / levelUp / loaded, panel layer + `world:ready` follows `activeContract`,
  progress → show / name / goal / bar / pulse → pulse drops on sim time → `.done` + `달성` → settle hides → new contract re-opens → abandon hides, contract
  success toast, credits coalescing (+150, delta 0 silent, −40 `.minus`), rep level-up only, quest complete / accepted silent, contract accepted, purchase,
  sale, 계약 미완 (extracted) vs 계약 실패 (dead), stack ≤ 4, complete screen block order / `Lv. 2 → 3` / numbers / success line / count-up mid + end / `.up`
  + badge / bar 13 % / `level_up` audio once, death screen `Lv. 3` / pre-mission bar / `진척 유지 안 됨` / count-up +80 without audio, contract null hides the
  line, `rewards` undefined hides the block on both screens, `game:abort` reset, 0 console errors. Regressions on the same vite: `smoke-ui-p6` **48/48**,
  `smoke-phase2` **44/44**.

## 2026-09-06 — Phase 7 HUD (level-up moment · 레이드 실패 · suspended members · training)
Brief: `docs/DECISIONS.md` Phase 7. Only `src/ui/` (+ `scripts/smoke-ui-p5.mjs`) changed; the container-search DOM stays inventory's.
- **Result screen** (`menus/RewardsBlock`): the level-up moment fires when the count-up crosses the boundary (badge pop, level / bar flash,
  `.up-burst` radial light burst, single `audio:play level_up`) — `ProgressToasts` dropped its `progress:levelUp` toast, audio/ its automatic chime.
  Contract wording unified on `settlement.outcome` through the exported `contractOutcome()` / `CONTRACT_OUTCOME_TEXT` / `CONTRACT_OUTCOME_CLASS`
  (used by `hud/MetaToasts` too): `계약 성공` / `계약 미완 · 계속` / `계약 실패 · 진척 유지 안 됨`; `ctx.stats.extracted` is not read any more.
- **레이드 실패** (`menus/DeathScreen`): `game:raidFailed` → `.raid-failed` mode (title `레이드 실패`, no 부활 / Space, `함선으로 귀환`,
  `.auto-return` `n초 후 자동 귀환` from `RAID_FAILED_AUTO_RETURN_S`, display only); reset on `game:newMission` / `game:abort`; `HudSystem.isRaidFailed`.
- **Suspended members**: `hud/Nameplates` keeps a `suspended` ref visible in grey with a `연결 끊김` tag; `hud/Squad` shows `연결 끊김` (`.suspended.off`)
  plus per-row `훈련장` / `임무 중` / `함선` badges from `LobbyPlayer.inMission` + `lobby.mode` (refresh on `net:lobbyUpdated` / `net:missionMembership`);
  `map/MapScreen` draws suspended members grey. Smoke hook `HudSystem.debugRemotes(refs, lobby)` → `Nameplates.setDebugRefs` / `Squad.setDebug`.
- **Chat / notifications**: `net:hostChanged` → `호스트 변경: <name>`, `net:peerSuspended` → `<name> 연결 끊김 / 재연결`, training enter / exit lines.
- **Training HUD**: `OBJECTIVE_TEXT.training` (`시뮬레이션 훈련장 · 출구 콘솔로 종료`) on phase `playing` while `ctx.missionMode === 'training'`;
  `Compass` / `WorldMarkers` build no extraction markers in the arena; world/ refreshes the hit counter via `ui:objective` `subText`.
- CSS: `.menu .rewards .up-burst` + `rewardsBurst` / `rewardsLvFlash` / `rewardsBarFlash`, `.menu.death.raid-failed` + `.auto-return`,
  `.nameplate.suspended` / `.nameplate .tag`, `.srow.suspended`, `.srow .badge[.training|.ship]`.
- Verification (private `npx vite --port 5309` + relay 8787; `npm run typecheck` clean for `src/ui/`, remaining errors are in `enemies/` / `player/`
  from the concurrent agents): `scripts/smoke-ui-p5.mjs` **89/89** (52 → 89: no level-up toast, outcome wording on toasts / both result screens
  incl. the no-`outcome` fallbacks, crossing-time `.up` + burst + one chime + burst removal, raid-failed screen incl. Space at 0 s and the abort reset,
  suspended nameplate / squad row / badges / chat + notification lines with a `debugSpawn` peer, host-change lines, training objective + subText),
  `scripts/smoke-ui-p6.mjs` **48/48** regression on the same vite.

## 2026-09-06 — Phase 8 UI (함선 ESC 일시정지 · 설정 · 함선 관리 · item chips)
Brief: `docs/DECISIONS.md` Phase 8. Only `src/ui/` + `src/game/` changed here.
- **Pause in the ship**: `game/GameFlowSystem` now allows a `hub` pause (`freeze:false`), so `menus/PauseMenu` grew a
  ship variant and a new button set — 게임으로 돌아가기 / 설정 / (임무 중에만) 함선으로 귀환 / 타이틀로. The old
  `키 설정 변경` button is gone; rebinding lives in the new 설정 overlay.
- **`menus/SettingsMenu`** (new): 키 설정 (opens the one shared `KeybindMenu`) + 오디오 (전체 / 효과음 sliders on
  `ctx.audio.setVolume`, `preview` on release, live percentage). No blocker token, capture-phase Escape, emits
  `ui:settingsToggled`. Null-safe when `ctx.audio` is missing.
- **`hud/ShipManageHint`** (new, social layer): persistent bottom-right `시설 관리` + `Keys.MAP` keycap in the ship
  (the label was 함선 관리 until the Phase 8 UI pass).
- **`hud/ItemTip`** (Phase 8 UI pass, direct child of `#ui-root`): the shared hover card for `.item-chip[data-def-id]`.
- **`hud/ShipManage`** (new, `.hud.housing` layer): 방 목록 (10 rows → `setManageRoom`) + a **vertical right-hand
  side panel** (Phase 8 UI pass; it was a horizontal bottom bar before) that shows the 가구 목록 (thumbnail + name +
  `renderItemCost` chips + 보유 수 → `selectFurniture`) for an assigned room and the **용도 지정 picker**
  (`purposeBlock`-gated `RoomPurpose` buttons → `setRoomPurpose`) for an empty one, plus a `빈 방으로` header button.
  Driven by `housing:shipManageChanged` / `housing:changed`. `hud/HousingHint` mentions **C** as a cancel key now
  (and C with an empty cursor leaves the mode).
- **`.item-chip` CSS** in `styles/base.css` implements the shared markup contract documented in
  `src/shared/itemChip.ts` (`--chip-size`, rarity ring `--rc`, glyph tint `--ic`, bottom-right 보유/필요 badge,
  `.is-short` = dimmed chip + red 보유, `.is-free`, `.item-chips` row host). housing/, inventory/ and meta/ render
  that markup; ui/ owns its look.
- Known limits: the 함선 관리 panels are DOM, so they need the pointer **unlocked** — hub/'s manage-mode camera must
  release the lock (housing mode's "pointer-locked cursor" would swallow the clicks). Verification of this section is
  the lead's (`npm run verify` for `ui` / `game`).

## 2026-09-06 — Phase 9 HUD (포기 진행 바 · 훈련장 패널 · 고스트 출혈 표시)

Contract consumed: `player:giveUpProgress`, `training:modeChanged / scored / courseFinished`, `TrainingMode` /
`TRAINING_MODE_LABEL_KO` / `TRAINING_COURSE_*`, `WorldRef.training` (`TrainingRef`), `RemotePlayerRef.ghostState` /
`ghostDownHp`.

- **포기 홀드 바** — `hud/Vitals` draws a red `포기` bar from `player:giveUpProgress {t}` (0..1 while Space is held,
  `-1` hides it; leaving the downed state hides it too). CSS `.vitals .giveup*` in `styles/base.css`.
- **`hud/TrainingPanel`** — the 훈련장 counterpart of `ContractPanel` in the same slot: 표적 모드 chip, 격추 score
  (`n / TRAINING_COURSE_TARGETS` with a bar in 타임 코스), 남은 시간 polled from `ctx.world.training`, 최고 기록,
  and a `ui:notify` + pulse on `training:courseFinished`. The per-frame poll adopts a field **only when the ref itself
  changed** since the last frame, so a value a `training:*` event already put on the panel is not overwritten by a ref
  that has not moved yet (the arena emits its events from inside its own update, one poll ahead of the HUD).
- **Suspended teammates show their ghost** — `hud/Nameplates` and `hud/Squad` read `ghostState` / `ghostDownHp` off the
  ref (net/ fills them): downed → a red bleed bar over the grey hp bar, bled out → `사망` instead of `연결 끊김`.
  `GHOST_DEAD_LABEL_KO` is exported by `Nameplates` and reused by `Squad`.
- Debug getters: `isGiveUpBarOn`, `isTrainingPanelOn`, `isTrainingPulsing`, `trainingPanelMode`.
- **CSS** (`styles/base.css`): `.vitals .giveup(.show) .txt .bar .fill`, `.training-panel(.show/.timed) .head .mode .row(.time/.time.urgent/.best) .num .bar .fill`, and the ghost bleed bar `.nameplate(.bleeding) .hp .bleed` / `.srow(.bleeding) .hp .bleed` + `.nameplate .tag.dead` / `.srow.suspended.dead`.

## Phase 9 UI pass (2026-09-07)

- `hud/HousingHint.ts` — the bottom-centre bar carries **only the placement key hints** (`LMB 설치 · R 회전 · X 회수 ·
  휠 선택 · C · Esc 취소`); the 가구 / 셀 rows are gone (the selected piece is highlighted in the 시설 관리 panel and the ghost
  is already green / red under the cursor). 종료 (Esc) moved to its own bottom-right `.housing-exit` chip, styled like
  the ship's 시설 관리 (M) hint it stands in for.
- `hud/ShipManage.ts` — every room row and every 용도 지정 entry leads with the shared facility thumbnail
  (`ROOM_PURPOSE_GLYPH` / `ROOM_PURPOSE_COLOR` from `@/shared`, class `.sm-thumb`), and the picker is **sorted**:
  제작 가능 (no block) → 제작 불가 (a prerequisite refuses it) → 이미 제작 (that purpose already exists elsewhere on the
  ship, badged 이미 제작). `purposeRank()` owns that mapping.

## Phase 9 UI/UX 개선 pass (2026-09-07) — the in-raid HUD

- **무게 표시 제거** — `hud/WeightBar.ts` is deleted along with its `.weightbar` CSS. Carry weight is an inventory
  concern now: the readout in the 가방 panel (`inventory/ui/InventoryUI`) is the only one, and the 과적 warning still
  arrives as a `Notifications` toast.
- **분대 목록이 좌하단으로** — `HudSystem` builds a `.hud-bl` column in the social layer holding the chat log over the
  squad list, anchored `bottom: 122px` so it stacks directly on top of the vitals (and drops to `32px` in the hub /
  while spectating, where there are no vitals). `.chat` and `.squad` are plain flex children now — neither positions
  itself any more — and `.hud-bl > .squad.hidden` uses `display:none` so a solo raid leaves no gap.
- **좌측 상단은 계약 전용** — with the squad gone from `top: 118px`, `hud/ContractPanel` owns that corner. It renders
  the own contract in a `.mine` block and, under it, a `분대 계약` block with one `.mrow` per
  `ctx.meta.getSquadContracts()` entry (slot colour, member name, contract name, `p / t`, thin bar). The list is fed by
  the relayed `meta contract` broadcast (see `src/meta/README.md`); `meta:squadContract` only marks it dirty, the next
  `update(ctx)` repaints.
- **`hud/QuickStrip.ts`** (new) — the 빠른 사용 thumbnail above the weapon slot strip. It used to draw one `.qs-cell`
  per **unlocked** wheel slot (a ~300 px row on an 8-slot bag); since **2026-09-07** it is `.qstrip.is-single`: a
  **single** cell showing the slot the player last selected (`quick:equipped.index`, else `quick:used.index`, else the
  first filled slot — `pickIndex`), with its direction arrow and a `buildItemChip` thumbnail at **60 px** (twice the
  old size), so the shared `hud/ItemTip` card describes it for free. `.is-hand` while that item is in the hands; the
  widget hides while the wheel is empty. Repaints only when a `quick:*` / `inventory:*` event marked it dirty.
- **`hud/ImplantChip.ts`** (new) — the 전술 임플란트 thumbnail above the quick strip: glyph + name + the `Keys.IMPLANT`
  keycap, `.is-cooling` on `implant:cooldownChanged`, `.is-wielded` on `implant:wieldChanged` and a one-shot `.flash`
  on `implant:activated`. The live numbers stay on `ImplantWidget` (the gauge left of the crosshair).
  Both strips — and `StratagemPanel`, whose old fixed `bottom: 176px` now falls inside the taller panel — are
  `prepend`ed into `WeaponPanel.root` by `HudSystem`, so the right-hand column reads
  **함선 호출 → 임플란트 → 빠른 사용 → 무기 슬롯 (1/2/3/F) → 무기 정보** from top to bottom, adjusts itself to what the
  player carries, and inherits the panel's fade and its `.hud.spectating` rule.
- **무기 정보** — `hud/WeaponPanel` dropped the Korean slot word (`.slot-lbl` 주무기 I …) and the calibre half of the
  type tag; the numbered chip and the weapon class carry it. `AMMO_LABEL_KO` is no longer imported here.
- **스태미나** — `.stam-bar` is a solid white fill with a glow on a dark bordered track (it used to be a translucent
  grey that vanished over a bright floor), and its label is full-opacity.
- **`hud/ItemTip`** also accepts `[data-item-tip][data-def-id]`, which lets a non-chip element opt into the hover card
  (`inventory/ui/TradeGrids` stamps it on the 기업 거래 grids).
- **CSS** (`styles/base.css`): `.hud-bl`, `.qstrip .qs-cell(.empty/.is-hand) .qs-dir .qs-body`,
  `.implant-chip(.is-cooling/.is-wielded/.flash) .ic-thumb .ic-glyph .ic-name .ic-key` + `@keyframes implantChipFlash`,
  `.contract-panel > .mine` / `.mates .mrow(.done) .who .ct .num .bar .fill`, `.sm-tabs .sm-tab`, `.sm-store`,
  `.sm-cost`, `.fcard-craft`, `.fcard-note`, `.fcard.store.is-blocked`; 2026-09-09: `.fcard-place` (shares the
  `.fcard-craft` rules), `.fcard-note.is-full`.

## 2026-09-07 — Phase 10 UI 개선 (크로스헤어 게이지 · 지도 핑 · 크레딧 표기 · 소프트 커서 · 빛기둥)

- **재장전 게이지를 크로스헤어로.** `hud/WeaponPanel` lost its `.arc` SVG, its `reloadTotal` / `reloadLeft` / `circ`
  state, its whole `update(dt)` method and the `.reloading` pill (their CSS left `base.css` too). The new
  `hud/ReloadGauge` is the `hud/ChargeGauge` shape at the reticle (`SIZE 120` / `RADIUS 48`, `rotate(-90deg)` so it
  fills from 12 o'clock) with its own countdown from `weapon:reloadStarted {duration}`. It closes on
  `weapon:reloadFinished` **and on the new `weapon:reloadCancelled`** — that event is the point of the exercise: a
  melee swing or a weapon swap that aborts the reload used to leave the ring filling to 100 % and standing there.
  `HudSystem` calls `reload.update(dt)` where `weapon.update(dt)` used to be.
- **회복약 홀드 게이지.** `hud/HealGauge` is `hud/CookGauge` as a **full circle** (a 360° single SVG arc degenerates,
  so it is a `circle` + `stroke-dasharray` like the charge ring), driven only by `heal:holdChanged {holding, t}`.
  `WeaponPanel`'s `CONSUMABLE_HINT.stim` reads `좌클릭 2초 홀드`, and `hud/Vitals`' pill key line is now the live
  `` `${keyLabel(Keys.QUICK)} 빠른 사용` `` (refreshed on `input:bindingsChanged`) instead of the hard-coded
  `H 스팀 · T 빠른 사용` — H is retired and the item is the 회복약.
- **지도 휠클릭 핑.** `map/MapScreen` gained the inverse transform (`fromX` / `fromZ`), a `pingAt(clientX, clientY)`
  that snaps to `getHeightAt`, and `setPingPlacer(fn)` next to `setPingSource`; `onMouseDown` handles `e.button === 1`
  without starting a pan. `hud/Pings` split the tail of the private `place()` into `placeResolved(...)` and the
  crate / pad / pickup snapping into `snap(...)`, so the new public `placeAtWorld(position, kind?)` (also reachable via
  `ping:requestAt`) reuses both: a map ping over a crate still reads `보급 상자 (n등급)` and still reaches the squad.
  It skips the `canPing` gate (pointer lock + `isGameplayActive()` — an open map fails it by definition) but keeps
  `MAX_PINGS` and the 0.3 s cooldown.
- **크레딧은 `100 C`.** `hud/ItemTip`'s 가치 row became the card's bottom bar (`.it-value`), and every credit readout
  in this folder goes through the shared `formatCredits` / `itemCreditValue`: `hud/ItemTip`, `hud/MetaToasts`,
  `hud/Notifications`, `menus/RewardsBlock`, `menus/MissionComplete` (전리품 가치, every frame of its count-up) and
  `menus/DeathScreen` (소실된 전리품 가치). The word 크레딧 stays as a **label** in sentences (`크레딧 +1,200 C`); the
  bare `n 크레딧` unit and the `cr` suffix are gone.
- **소프트 커서** (Phase 10; **superseded 2026-09-07**). The sprite and the virtual cursor are gone — see
  `hud/GameCursor` in the table above and the 커서 rework section at the end of this file. What survived from §2 is the
  API: `map/MapScreen` (`'map'`) and `hud/ChatLog` (`'chat'`) still call `setCursorMode(true, TOKEN)` and still have no
  relock microtask of their own (both `close(relock)` signatures keep the parameter and ignore it).
- **루팅 표시 = 빛기둥.** The light-blue fresnel sphere is gone from both places it lived. `hud/Detection` (in range,
  depth-tested) and `hud/ScanReveal` (scan, through-wall) now build their pooled meshes from the new shared
  `hud/pillar.ts`: an open cylinder translated `+H/2` with **baked vertex colours** going black toward the top plus
  `MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false,
  side: DoubleSide, toneMapped: false })` — in additive blending black is transparent, so no shader is needed. Pooling
  (24 / 64), the shared geometry / materials and "no lights" are unchanged, `DETECT_HIGHLIGHT_COLOR` keeps its name,
  `Detection.placeShells()` dropped its `+= 0.45` lift and `ScanReveal`'s `KIND_SCALE` is a **height** multiplier of
  `SCAN_PILLAR_HEIGHT` applied as `scale.set(1, s, 1)`.
- **CSS** (`styles/base.css`): new `.reload(.show) .track .fill .lbl` and `.heal(.show/.near/.ready) .track .fill
  .text .lbl` next to `.charge`; `.item-tip .it-value .k .v`; (the Phase 10 `body.soft-cursor-on` + `.soft-cursor` rules were removed again on 2026-09-07);
  `.hud.spectating` now also hides `.reload` / `.heal`; `.weapon .arc*` and `.weapon .reloading*` were deleted.

### Known follow-ups (Phase 10, ui)
- `hud/ReloadGauge` runs its own clock from the event's `duration`, so a reload whose real speed changes mid-cast
  (a stat / socket change applied after the start) drifts from the ring; weapons only publishes start / finish /
  cancel. It also hides on `weapon:equipped`, which is the old panel behaviour and harmless because a swap emits
  `weapon:reloadCancelled` first.
- `hud/HealGauge` is purely event-driven (no local countdown): if `heal:holdChanged` stops arriving without a
  `holding:false`, the ring freezes at its last `t` until death / downed / a mission reset. Its label converts `t`
  back into seconds with `HEAL_HOLD_S`, so a future per-item heal time would need the event to carry the duration.
- The map ping is always `ground` before snapping — there is no way to place a directional 돌격 / 주의 ping or an
  `enemy` ping from the map, and the middle-click gesture (hold + drag) has no map equivalent.
- `pillar.ts` uses **6 height segments** rather than the 1 the plan sketched: with a single segment the colour ramp
  can only reach black at the very top, which makes `INTERACT_PILLAR_FADE` unusable. `ScanReveal` also dropped its
  `position.y += 0.5` (not called out in the plan) for the same reason `Detection` dropped `+= 0.45` — a pillar's base
  is its origin. Both pillars share `INTERACT_PILLAR_RADIUS_*` (there is no separate scan radius constant), and the
  through-wall markers are noticeably fainter than the old 0.8-opacity shells because `INTERACT_PILLAR_OPACITY` is
  0.28; the extra silhouette height is what carries them.
- (The Phase 10 note about the map's middle-click arriving twice is obsolete: there are no synthetic events any more.)

## 2026-09-07 — Phase 11 (ESC 재배치 · 소셜 열 · 설정 사이드 패널 · 커뮤니티 · 귓속말 · 행성)

Brief: `docs/DECISIONS.md` Phase 11. Only `src/ui/` changed here (+ the new `scripts/smoke-social.mjs`, and one selector in
`scripts/smoke-controls-hub.mjs`). Identity in every one of these surfaces is the **`PlayerCode`** (`formatPlayerCode`);
no PeerId is ever shown or sent.

- **ESC 재배치** (`menus/PauseMenu` + `base.css`): the button column moved to the **left** (`.menu.pause` left-aligns the
  frame) and a right-hand `.pause-social` column appeared — **in the ship only**, driven by the same `ctx.isHubPhase()`
  branch that already decides the title / subtitle / hint wording and the `returnBtn` `display`. The button set, the
  wording and the `game:paused` flow are untouched; a raid's Escape is still nothing but the buttons.
- **소셜 열** (`menus/social/`, four new files): `SocialColumn` is **one component with two hosts** — the ESC screen and
  the community panel — so the two can never drift. 분대원 (voice slider + mute, `SQUAD_VOICE_DEFAULT`, UI only, hinted
  `보이스 채팅 준비 중`) / 받은 친구 요청 (수락 · 거절) / 친구 / 최근 플레이어, cards `SOCIAL_CARDS_PER_ROW` wide with
  `SOCIAL_FRIEND_ROWS` and `SOCIAL_RECENT_ROWS` visible. The right-click menu (`SocialMenu`) greys 같이 하기 with the
  pure `SocialRef.playBlock` → `PLAY_BLOCK_LABELS` rule the server refuses with, and 친구 삭제 always goes through a
  confirm card. `socialSource.ts` is the single read point (`socialOf(ctx)`) and the smoke's synthetic-mirror hook.
- **설정 패널** (`menus/SettingsMenu`): a **left-centre side panel** (`.side`) holding 오디오 (전체 · 효과음) and 키 설정,
  the latter now containing a real `ControlsPanel` instance above the `KEYBIND_BUTTON_LABEL` button — the title screen's
  own diagram, disposed in `TitleMenu`'s order. Blocker / Escape etiquette (no token, capture keydown, yields while
  `keybinds.isOpen`) is unchanged.
- **커뮤니티** (`hud/Community`, social layer): the ship-only top-right thumbnail with the online-friend count inside its
  bottom-right and a red dot for a pending request; its panel reuses the same `SocialColumn` under `COMMUNITY_BLOCKER` +
  `setCursorMode` and emits `ui:communityToggled`. 분대 초대 panels stack under it (newest first, `SQUAD_INVITE_MAX`) with
  a `Keys.INVITE` (P) hold gauge of `SQUAD_INVITE_HOLD_S` → `social.acceptInvite`.
- **귓속말** (`hud/ChatLog`): `chat:whisperTo` opens the input in whisper mode with a `→ 이름` chip; Enter goes out through
  `social.whisper` and the **mirror's** `social:whisper {line}` draws both directions as `.chat-line.whisper`. The chat
  column rises to mid-left (`.hud-bl.whispering`) while a target is set.
- **행성** on the result screens: a `.planet-line` on `menus/MissionComplete` / `menus/DeathScreen`, and 다시 배치 now
  emits `game:newMission {seed, planet: ctx.missionPlanet}`.
- **Toasts** stay this folder's: `hud/Notifications` gained the `소셜` lines for `social:error` / `social:play` /
  `social:invited` — the social panels never toast themselves.
- Verification (private `npx vite --port 5300` + the relay on 8787): `npm run typecheck` 0 errors,
  `node scripts/smoke-social.mjs` **116/116**, regressions `node scripts/smoke-ui-p5.mjs` **132/132** and
  `npm run smoke:controls` **77/77** (its `mouse LMB / RMB / MMB lit` check had to be scoped to `.menu.title`, because
  the 설정 panel is a second `ControlsPanel` in the document — the count, not the behaviour, changed).

### Known follow-ups (Phase 11, ui)
- A squad-mate's 아이디 / 레벨 in the 분대원 rows can only be resolved when that player also appears in one of my own
  social lists (friends / requests / recent): `LobbyPlayer` carries a name, never a `PlayerCode`. Unknown members read
  `아이디 미확인` rather than an invented id, and the match is **by name**, so two members with the same name resolve to
  the same card. A `code` on `LobbyPlayer` would fix it properly.
- The voice slider and mute toggle do nothing at all — there is no voice chat. Their values live in the component and
  are lost when the column repaints a different lobby (they are keyed by PeerId, so a reconnecting member keeps theirs).
- There is no way to add a friend by **typing** an 아이디: 친구 추가 only exists on a card, so a player you have never
  been matched with cannot be added from the UI. §3-4 did not ask for an input field.
- Two `SocialColumn`s live in the DOM at once (the ESC one and the community one) and therefore two `.sc-menu` /
  `.sc-confirm` elements under `#ui-root`. Each is scoped to its own column and only one is ever visible, but any
  document-wide query for those classes must filter on `:not([hidden])` — the smoke does.
- `hud/ChatLog` toggles `.whispering` on its **parent** when that parent is the HudSystem-owned `.hud-bl` column; a
  future host that reparents the log would silently lose the mid-left position.
- The community thumbnail is drawn even while `SocialRef.available` is false (count 0, no dot) and its panel then shows
  only the unavailable line — deliberate, so the affordance explains itself instead of vanishing. The `.cheat-tag`
  collision is solved by a CSS rule that moves the tag to `top: 108px` **in the hub**, so a future top-right widget in
  that corner has to join the same stack rather than pick its own `top`.
- The P-hold accepts only the **top** (newest) invite; there is no way to pick an older one except by dismissing the
  ones above it. The gauge is redrawn at 1/50 granularity, so a very short hold shows nothing.


## 2026-09-07 — 마우스 커서 rework (락 = 시점 / 언락 = 커서)

The Phase 10 software cursor is removed. `shared/cursor.ts` now only ref-counts the mode; releasing the pointer lock is
what shows the mouse, and the real OS cursor is restyled in place.

- **`hud/SoftCursor.ts` deleted**, `hud/GameCursor.ts` added (see the table). It draws the three cursor variants on a
  canvas, injects them as CSS `cursor:` images under `body.cursor-ui`, and mirrors every stylesheet `cursor:`
  affordance so the arrow / pointer / grab split stays correct without a hand-maintained selector list.
- **`menus/MenuBase`** joined the normal contract: `show()` / `hide()` take and drop `setCursorMode(*, 'menu')`
  instead of calling `exitPointerLock()`. The Esc menu is no longer the one screen with different rules.
- **CSS**: the `.soft-cursor` sprite block and `body.soft-cursor-on { cursor: none !important }` are gone from
  `styles/base.css`; `inventory.css`'s `.inv-root.is-dragging` rule lost its `body:not(.soft-cursor-on)` scoping and
  its `!important` (it is a fallback now — `GameCursor` mirrors it with the 잡기 art).
- **`HudSystem`** constructs `GameCursor` with no parent element and calls no per-frame update for it; the debug getter
  is `isGameCursorOn`.
- Every other cursor surface in this folder (`map/MapScreen`, `hud/ChatLog`, `hud/Community`, the ESC social column)
  is **unchanged** — the `setCursorMode(active, token)` API did not move.

### Known follow-ups (커서 rework, ui)
- The art is generated once at construction (plus one re-run on `window.load`). A stylesheet added later — a lazily
  imported panel's CSS, a hot-module replacement during `npm run dev` — is **not** mirrored, so its `cursor: pointer`
  rows show the plain game arrow until a reload. Nothing in the game loads CSS lazily today.
- `image-set` is applied to `body.cursor-ui *`, i.e. one `!important` blanket rule. An element that genuinely wants
  the **native** cursor (a future `<select>` popup, an iframe) has to be added to the exceptions next to the text
  inputs.
- The cursor art is fixed at `GAME_CURSOR_SIZE` (22 px). There is no size / sensitivity setting — sensitivity is now
  the OS pointer speed, which is the point, but it also means the in-game cursor is exactly as fast as the desktop
  one and nothing in the game can change that.
- A canvas that refuses `toDataURL` (a hardened browser, an odd headless build) silently leaves the native cursor in
  place; `isGameCursorOn` reports false and nothing else changes.

## 2026-09-08 — ESC = 항상 일시정지 · 설정 3분할 · 소셜은 커뮤니티로

**The rule**: Escape opens the 일시정지 메뉴 and does nothing else. It never closes a screen, and it never closes the
menu either — `게임으로 돌아가기` does. Every screen is closed by the key that **opened** it. See `game/README.md`
for why the browser makes this the only workable shape (Escape is eaten by the pointer lock, and the button click is
the user gesture Chrome demands before it re-locks).

| screen | opens | closes |
|---|---|---|
| 인벤토리 / 캐릭터 / 기업 / 함선 | `Keys.INVENTORY` (Tab) | Tab |
| 전술 지도 | `Keys.MAP` (M) | M |
| 커뮤니티 | `Keys.INVITE` (P) tap, or the thumbnail | P tap, or 닫기 |
| 함선 관리 (housing mode) | M | M (or C with an empty cursor) |
| 함선 터미널 · 정비 벤치 · 하우징 패널 | E on the object | E |
| 일시정지 메뉴 | **Escape**, from anywhere | 게임으로 돌아가기 |

> **2026-09-09 개정 — ESC 도 닫는다.** 위 표의 `opens` 열은 그대로이고, `closes` 열에 **Tab**(2026-09-09 공용
> 닫기)과 **Escape** 가 더해졌다. Escape 한 번은 열려 있는 화면 중 **맨 위 하나**를 닫고(열린 순서의 역순 —
> `shared/escape` 의 `ctx.escape`, 정책은 `game/parts/Phases.escapeKey`), 닫을 화면이 없을 때만 일시정지 메뉴가
> 열린다. 화면은 `uiBlockers.add` 옆에서 `ctx.escape.push(token, () => this.close())` 하고 `delete` 옆에서
> `remove(token)` 한다. 일시정지 메뉴 자신은 **데스크톱 앱에서만** Escape 로 닫힌다(`isDesktopShell()`,
> `PauseMenu` 의 capture 핸들러) — 브라우저에서는 `게임으로 돌아가기` 클릭이 재락 제스처를 겸하므로 그대로다.
> 우측 하단 키 가이드의 `닫기` 항목은 keycap 이 둘(`Tab` · `Esc`)이 됐다. 이유와 환경별 차이는 `game/README.md`
> 의 2026-09-09 절.

Escape still cancels the **innermost popup** when there is one — a context menu, a split dialog, a confirm card, the
key-capture prompt, the chat input, the dev console — and those handlers keep their capture-phase
`stopImmediatePropagation`, so `Input` never sees the key and the menu does not open behind them. That is the
industry-standard shape (Minecraft, Krunker) and it means a mistyped Escape cannot throw away typed text.

### ui changes
- **`menus/PauseMenu.ts`** is a bare button column: the `함선 · 일시 정지` title variant, both subtitles
  (`함선 시스템은 계속 작동합니다` / `분대 임무 — 시뮬레이션은 계속됩니다`), the `.mp-note` and the footer `.hint`
  are **removed**, and so is the ship-only `.pause-social` column — social lives in `hud/Community` alone now, so
  there is one social surface instead of two. `SocialColumn` / `socialColumn` are gone from this class; `isHubVariant`
  and the `함선으로 귀환` `display` handling are unchanged. It does **not** handle Escape at all (never did — `game/`
  drives it), and `game/` now refuses to close it on Escape.
- **`menus/SettingsMenu.ts`** is a two-column screen: a `.set-nav` rail on the left (화면 설정 / 오디오 설정 /
  키 설정, **화면 first and selected on every open**) and a `.set-pane` on the right whose box is **fixed**
  (`height: calc(100vh - 220px)`, capped 560 px) so switching sections never resizes the frame; only the pane scrolls.
  The old `.set-head` / `.set-section-title` blocks are gone. New **화면 설정** section: 전체화면 (a real
  `document.documentElement.requestFullscreen()` — the one thing that makes Escape stop breaking the pointer lock),
  화면 효과 (bloom), 그림자, 해상도 배율 (75 / 100 / 125 %). The last three are published on `ui:displayChanged` and
  applied by **`main.ts`** (it owns the `Engine`; ui/ must not import core/). `activeSection` getter for the smokes.
- **`menus/displaySettings.ts`** (new): the 화면 설정 store — `DisplaySettings`, `DISPLAY_SCALES`,
  `loadDisplaySettings` / `saveDisplaySettings` (localStorage `scav.display`), `isFullscreen` / `setFullscreen`.
  `fullscreen` is deliberately **not** persisted: restoring it would need a user gesture the page does not have at
  startup.
- **`hud/Community.ts`**: `Keys.INVITE` (P) is now **tap = open / close the panel, hold = 분대 초대 수락**. The tap
  fires on *release* and only inside `COMMUNITY_TAP_MAX_S` (a longer press was an invite hold the player abandoned);
  with no invite on screen any release toggles. The capture-phase Escape listener is gone, the 닫기 button reads
  `닫기 (${keyLabel(Keys.INVITE)})`, and the panel is left open under the 일시정지 메뉴 when Escape stacks it.
- **`map/MapScreen.ts`**: the capture-phase Escape listener is **removed**; M closes it (and M is ignored while the
  `MENU_BLOCKER` is up, so it cannot reach through the menu).
- **`hud/HousingHint.ts`**: the 종료 chip names `Keys.MAP`, not `Keys.MENU`.
- **`hud/TargetingHud.ts` / `hud/StratagemPanel.ts` / `hud/stratagemGlyphs.ts`**: the top-view hint reads
  `좌클 확정 · 우클 취소` — Escape never reached that code (the browser ate it while locked) and now means the menu.
- **`HudSystem`**: `debugSocial` no longer refreshes a pause column (there isn't one); new `settingsSection` getter.
- **CSS** (`styles/base.css`): `.pause-social` and the `.set-head` / `.set-section*` blocks removed; new `.set-cols`,
  `.set-nav`, `.set-nav-btn`, `.set-pane`, `.set-toggle`, `.set-seg`. The settings frame grew to 760–900 px.

### Known follow-ups (2026-09-08, ui)
- The pause menu **stacks** over whatever is open rather than replacing it, so `게임으로 돌아가기` returns you to the
  inventory / community panel you were in. That is deliberate, but it means the menu can sit over a blurred screen
  and the only way out of *both* is two steps.
- 전체화면 is the only display setting that can be refused (a permissions policy, a missing user gesture); the row
  then simply stays 끔 with no message. It is also not restored on reload, and browser **F11** is a different kind of
  fullscreen in the Electron shell — the row reflects `document.fullscreenElement`, so an F11 there reads 끔.
- 그림자 turns off the sun's `castShadow` rather than `renderer.shadowMap.enabled`; that keeps every material's
  shader intact (no recompile) at the cost of the shadow code path still being compiled in.
- The P tap window is a fixed `COMMUNITY_TAP_MAX_S` with no setting. A player who presses P slowly while an invite is
  up gets neither the panel nor the invite.

## 2026-09-08 — Phase 12 (감지 나침반 · 정찰 reveal · 채집/지속 사용 티커 · 컷씬 버튼 숨김 · 시설 관리 확인 팝업)

Plan: `docs/DECISIONS.md` items 3 · 4 · 8 · 9 · 15 · 16 (agent F). Contract: `scan:cast`, `item:channelChanged`,
`COMPASS_ENEMY_COLOR`, `IMPLANT_SCAN_REVEAL_TIME_V2` (`src/shared/README.md` § 2026-09-08).

- **`hud/ScanTracker.ts` (new)** — the one owner of 정찰 reveals for the HUD: `scan:cast {targets, duration}` (mine or a
  squadmate's; `implant:scanned` feeds it too) keeps every `kind:'enemy'` target for the cast's duration (15 s),
  follows its `object` live, prunes expired / dead entries (one `getEnemies()` pass every 0.25 s, not per frame),
  clears on `detect:clear` / abort / new mission / hub / death. `HudSystem` owns one instance and hands it to the compass
  and the detection component so the bookkeeping runs once.
- **`hud/Compass.ts`** — **감지 스탯 ticks**: every living enemy inside `derived.enemyDetectRadius` (polled through
  `ctx.enemies.queryNear` at ≤ 10 Hz; bearings recomputed per frame from the cached refs) is a pooled red tick
  (`.etick`, `COMPASS_ENEMY_COLOR`, 24 nodes created once) at its bearing, fading toward the edge of the radius; a
  scan-revealed enemy gets a taller `.etick.scanned` for the reveal's duration **regardless of distance**. Only bearings
  inside the visible ±80° arc are drawn (the edge arrows cover the rest); ticks clear outside gameplay. `enemyTickCount`.
- **`hud/Detection.ts`** — the arrow loop became a **candidate** loop (detected refs + 정찰 reveals, pooled, no
  allocation): off-screen → the existing edge arrow, **on screen → a small red chevron** (`.detect-mark`, 12 pooled)
  floating `MARK_LIFT` above the body's `height`, from the same projection. `markCount`.
- **`hud/ScanReveal.ts`** — also listens to `scan:cast` (merged by `kind:id`, so an implants build that still emits
  `implant:scanned` / `detect:reveal` never doubles a pillar); pool **64 → 160** (one 70 m pulse can hand over every
  gather node + crate + pickup + enemy in range for 15 s, and the old pool evicted valid reveals).
- **`hud/Notifications.ts`** — the `gather:collected` toast is **gone**: the herb reaches the bag through
  `inventory.tryAddItem`, whose `inventory:itemAdded` line is the one ticker a gather shows (the 채집 line doubled it;
  the 온실 harvest path goes through `tryAddItemAnywhere` → the same line). **Channel line**: `item:channelChanged
  {active:true, gauge}` creates ONE `.notif.channel` (`<이름> 사용 중 · n %`, `gauge` 0..1 — an absolute value ≥ 1 is
  read against the def's `durabilityMax`), updated in place per tick, pinned outside the `MAX_VISIBLE` rotation,
  dismissed on `active:false`; while it is live the `player:stimUsed` toast (`applyHeal` fires it 10×/s for a spray)
  is muted. `channelText` / `liveCount` for the smokes.
- **`hud/ProgressToasts.ts`** — the `+n XP` chip is **held** while a channel runs (`item:channelChanged`) and flushed
  once when it ends, instead of one chip per `XP_FLUSH` for the 의학 XP of every spray tick.
- **`hud/CutsceneWatch.ts` (new)** — `hub:docking` / `hub:travel` start → end, phase `'docking'`, `ctx.hub.travelling`
  and the current `HubShipKind`, shared by the two corner widgets. **`hud/ShipManageHint.ts`** hides during a cutscene
  and on the **shared ship** (no 시설 관리 there); **`hud/Community.ts`** hides during a cutscene (the phase check alone
  missed the warp, whose phase stays `hub`) and closes its panel when one starts.
- **`hud/ShipManage.ts`** — the 시설 증축 that "did nothing" (root cause in `src/housing/README.md`): the 용도 지정
  picker now **leads with a 발전기 row** (`.sm-gen`: `Lv.n / max`, next-level cost chips, 가동 / 업그레이드 button →
  confirm → `ctx.housing.upgrade('generator')`; `.is-hint` while the gate is what blocks the purposes, with a printed
  `시설 증축에는 발전기 Lv.1 이 필요합니다 — 먼저 발전기를 가동하세요` line); every blocked purpose prints its 한국어
  reason **inline** (`.sm-block`) and **stays clickable** (`aria-disabled`, click → the reason as a toast + a red
  flash) instead of a `disabled` button with a tooltip; an allowed purpose opens the centred **modeless confirm popup**
  (`.sm-confirm` inside the screen root: `정말로 N번 방을 <용도> 시설로 만들겠습니까?` + `renderItemCost` chips of
  `purposeCost`, 확인 → re-check + `setRoomPurpose`, 취소 / backdrop / **Esc** → close). Escape is caught by a
  capture-phase `window` listener and `Input.consume`d, so it closes the popup only — the hub's Esc (leave 시설 관리)
  and game/'s pause never see it. `isConfirmOpen` / `confirmPurpose`.
- **`HudSystem.ts`** — constructs / binds / disposes the two trackers, passes them to `Compass` / `Detection` /
  `ShipManageHint` / `Community`; debug getters `compassEnemyTicks`, `detectMarkCount`, `scanRevealCount`,
  `channelTickerText`, `notifCount`, `isShipManageConfirmOn`, `shipManageConfirmPurpose`.
- **CSS** (`styles/base.css`, "Phase 12" block at the end): `.compass .eticks / .etick(.scanned)`, `.detect-mark`,
  `.notif.channel`, `.sm-gen*`, `.sm-block`, `.sm-purpose.is-blocked` (clickable again) + `.flash`, `.sm-confirm*`.
- **Smokes**: `smoke-ui-p6` 72 → **87** (ticks in / out of radius, chevron, `scan:cast` persist / follow / expire /
  `detect:clear`, ScanReveal pillar, channel line, gather ticker), `smoke-housing` 176 → **194** (fresh ship with the
  기본 지급품: 발전기 row hint → blocked rows clickable → 발전기 confirm → Esc → 확인 → 작업실 confirm text → Esc → 확인 →
  materials consumed), `smoke-controls-hub` 99 → **106** (corner widgets across `hub:docking` / `hub:travel`, shared
  ship), `smoke-ship-rooms` 71 and `smoke-ui-p5` 133 unchanged.

### Known follow-ups (Phase 12, ui)
- Compass ticks are drawn only for bearings inside the visible arc — an enemy behind the player has **no** tick (the
  edge arrow is the only cue) and the arc mask fades ticks near its ends. The pool is 24 ticks + 6 arrows + 12
  chevrons; a horde beyond that is truncated in enemy order, not by distance.
- The channel line trusts `item:channelChanged` alone: if weapons stops emitting `active:false` (a death mid-spray,
  a screen change) the line stays until `game:abort` / `game:newMission` clears it. The `player:stimUsed` mute is
  keyed on the same flag, so a 붕대 finished *during* a spray channel also toasts nothing.
- `ScanTracker` drops a reveal the moment the enemy dies; `ScanReveal`'s pillar keeps its own expiry (a corpse can keep
  a pillar for the rest of the 15 s). The `crate` / `pickup` / `gather` targets of a `scan:cast` are pillars only —
  no compass mark.
- `CutsceneWatch` reads `hub:docking` / `hub:travel` **events**; a cutscene that started before `HudSystem.init` is
  covered only by the phase / `travelling` fallbacks. The shared-ship gate uses `ctx.hub.ship`, so a hub build that
  leaves `ship` null shows the hint.
- The confirm popup lives inside `.ship-manage` (the `.hud.housing` layer), so it is gated with the screen and never
  outranks a real menu; its Escape listener is capture-phase on `window` — any future component that also captures
  Escape earlier will win. `.sm-gen` is a picker-only row: a room **with** a purpose still sends the player to the
  Tab 함선 tab for the 발전기.

---

## 변경 이력

- **2026-09-11 (C 배치 · 다른 에이전트가 고친 ui 파일 — 리드 기록)**
  ① **`map/MapScreen` (C-11 · C-15, 에이전트 3)** — 폐허 전초를 `fog:discovered {kind:'outpost'}` 로 id → 위치 표에 쌓아
  ㄷ자 아이콘 + `폐허` 라벨로 그린다(`world:ready` · `game:abort` 에서 비움, 범례 견본은 인라인 스타일 — `base.css` 에
  `.map-legend-row .sw.outpost` 를 두면 걷을 수 있다). 재해 원 반경 ≤ 0.5 m(`CLOSED_RADIUS_M`, `world/hazard` Visuals 와 같은
  문턱)는 **닫힌 원** — 안이 안전한 원이면 캔버스 전체가 위험이고 1 px 구멍 · 테두리를 남기지 않는다(`STORM_EYE_RADIUS_END` 0).
  ② **`menus/SoldierPreview` (C-42, 에이전트 5)** — 색 칸을 바꿀 때 옛 병사 모델은 씬에서 떼기만 하고 `pendingDispose` 에 두었다가
  **다음 render 뒤** dispose 한다(`player/Portraits` 와 같은 패턴). 먼저 dispose 하면 같은 셰이더 프로그램이 지워졌다 다시
  컴파일돼 색을 바꿀 때마다 멎었다.
  ③ **`hud/pillar` · `hud/ScanReveal` (C-4, 에이전트 1)** — 위 2B 절의 Detection 한 줄과 함께: `pillarAllowed(it)` 는
  `string | {id, kind?}` 이고 `Interactable.kind` 를 먼저 본다. `ScanReveal` 은 reveal 이벤트마다 등록물에서 id → kind 표를 채운다.

- **2026-09-11 (C 배치 · 에이전트 2B — 옛 키 설정 알림 · 원격 실드 바 · HUD 투영 시점 · SlotStrip 삭제)**
  ① **C-9 · X-8 옛 키 설정 알림** — 새 `menus/keybindNotice.ts`. `TitleMenu.bind` 가 `takeAutoStart()` 옆에서
  `takeKeybindLoadReport()` 를 한 번 읽어, 타이틀이면 아래쪽 카드 `.kb-notice`(`같은 키 V: 재장전 · 구르기` ·
  `없어진 기능의 키 설정을 지웠습니다: 이전 무기`, 14 s 뒤 접힘 · `확인` · `키 설정 열기`), 자동 시작이면 첫 `hub:entered` 의
  `ui:notify` 로 알리고 **그 순간** `saveKeybinds()` 로 은퇴 줄을 지운다. **결정**: 겹침은 블롭에 남으므로 고칠 때까지 부팅마다
  다시 알린다 — "보지 않음" 저장 키를 새로 만들지 않았다(두 동작이 실제로 한 키에 묶여 있는 상태다).
  ② **C-19 원격 명판 실드 바** — `hud/Nameplates` 에 체력 바 위 얇은 분리 바 `.sh`(방탄복 등급색). 전투불능 · 사망 · 연결 끊김이면 숨는다.
  ③ **C-53 · X-9 HUD 투영 시점** — `HudSystem.lateUpdate` 첫 줄 `ctx.camera.updateMatrixWorld()`, `NamedScanWarning` 을
  `update` → `lateUpdate`. WorldMarkers · Pings · OffscreenIndicators 가 직전 프레임 뷰로 투영하던 것이 같이 고쳐졌다(그 파일들은 안 건드렸다).
  ④ **C-26** — 소비자 없는 헬퍼만 남았던 `hud/SlotStrip.ts` 삭제, `styles/base.css` 의 죽은 `.wslot.quick` 두 줄 삭제, 흔적 주석
  (`HudSystem` · `WeaponPanel` · `base.css`) 정리. 이 README 의 표 행도 지웠다 (`.wslots` 0 단언은 `smoke-weapons` 에 그대로).
  **스모크**: `smoke-controls-hub` 가 옛 블롭 `{"SWAP":"KeyX","RELOAD":"KeyV"}` 로 부팅해 리포트 · 카드 · 블롭 정리 · 키 설정 화면의
  겹침 두 줄을 본 뒤 초기화하고 원래 검사를 잇는다. `smoke-ui-p5` 는 백스페이스 제어문자였던 정규식을 `\bready\b` 로 고치고
  (예전 단언은 늘 참이었다) 스프레이 100 % 단언 1줄 + 명판 실드 4줄 → 141 checks.
  ⑤ **C-4 후속(리드 요청)** — `hud/Detection` 이 `pillarAllowed(it.id)` 대신 `pillarAllowed(it)` 를 부른다 (`Interactable.kind` 우선; `pillar.ts` 시그니처 변경은 에이전트 1).
  ⑥ **C-36 후속(리드 요청)** — 공용 호버 카드 `hud/ItemTip` 에 가방 `내구도` 줄(인스턴스면 `cur / max`, 칩이면 `최대 max`). 무기 · 방탄복 내구도 줄은 원래 이 카드에 없다(def 전용 카드) — 가방만 넣었다. smoke-ui-p5 +1 → 142 checks.

- **2026-09-11 (드론 조종 HUD)** — 리드 스텁 `hud/DroneHud` 를 채우고 `styles/drone.css` 를 새로 만들었다.
  ① **드론 시점 모드는 CSS 한 클래스다**: `ctx.drones.controlled` 가 있으면 게임플레이 루트에 `drone-view` —
  무기 패널 · 퀵 스트립 · 임플란트 · 함선 호출 · 스태미나 · 총 크로스헤어 · 크로스헤어 게이지 · 휠을 숨기고
  체력은 작게(0.55 × 0.8) 남긴다(PC 가 맞으면 조종이 끊기므로). 다른 위젯 파일은 건드리지 않았다 —
  `Reticle` 이 인라인 `opacity` 를 매 프레임 쓰므로 숨김은 `!important` 다(`.hud.spectating` 과 같은 이유).
  ② **사거리 게이지는 스태미나 자리 · 같은 문법**이고 채움 = `linkRatio`(멀어질수록 꽉 찬다). ③ **외곽 지지직**은
  경고 비율 → 1 에서 0 → 1, 절차 캔버스 노이즈를 외곽 마스크로 깎는다 — 게임플레이 레이어 맨 아래에 prepend 해
  HUD 글자를 덮지 않고, 강도 0 이면 그리지도 애니메이션을 돌리지도 않는다. ④ **공중 드론 고도**는
  `world.getSurfaceY(x, z, y)` 기준, 조작 안내(크로스헤어 우측)는 실제 바인딩 라벨. ⑤ **홀드 링은 반지름 60** —
  `HoldGauge`(48)와 같은 모양이지만 바깥이라 겹치지 않고, 조종 전에도 뜬다. ⑥ 끊김 알림은
  `drone:controlChanged {id:null}.reason` 로 갈리고 `manual` · `reset` 은 조용하다.
  **키 가이드에는 올리지 않았다** — 가이드가 붙이는 `Tab · Esc 닫기` 가 드론 시점에는 거짓이다(`CommsWheel` 과 같은 판단).
  **알려진 한계**: `ctx.drones` 가 이 작업 시점에 stub 이라 실제 드론으로 눈으로 본 것은 아니다. 복귀 키는
  `Keys.RELOAD` 로 가정했다(드론 계약의 "R 꾹"). 나침반은 PC 방위라 흐리게만 했다.

- **2026-09-11 (로든 스캔/저격 경고 · 손에 든 가젯 안내 · 조종 중 H 휠 차단)** — 계약 단계 스텁 두 개를 채웠다.
  ① `hud/NamedScanWarning` + 새 시트 `styles/named.css`: 스캔 노출 배너(`count / total` 칸, `.warm` / `.crit` + `엄폐하라`),
  노출된 음파의 가장자리 훑기, 조준경 반짝임(화면 안 반짝임 / 화면 밖 방향 호 — `DangerIndicators` 문법, 그 파일은 안 건드렸다).
  **결정**: 표적이 내가 아니면 화면 안의 작은 반짝임만 그리고 호 · `저격 조준!` 은 띄우지 않는다 — 분대원이 노려지는 자리는
  부를 수 있어야 하지만 가장자리의 붉은 호는 "내가 노려진다" 로 읽힌다. 방위는 카메라 위치 기준(드론 시점에서도 맞다).
  ② `hud/GadgetHandHint` + 새 시트 `styles/gadgetHint.css`: 설치 가능/불가 사유 · `우클릭 기폭 (n)` · 기폭기 손
  (`remoteState.detonator`) · 드론 `좌클릭 드론 배치` / `R 꾹 조종`(`kc-hold`) / `신호 범위 밖`. 드론 조종 중엔 숨는다.
  ③ `hud/CommsWheel` 의 `usable` 게이트에 `!ctx.player.droneControl` 한 줄 — 조종 중엔 H 휠이 열리지 않고, 열려 있으면
  아무것도 보내지 않고 접힌다. 핑은 막지 않았다.
- **2026-09-11 (빛기둥은 시체에만)** — 사용자 요청 "아이템 상자, 컨테이너에 빛기둥 모두 제거. 빛기둥은 시체에만".
  `hud/pillar.pillarAllowed(id)` (`corpse:` · `pcorpse:`) 를 `Detection`(범위 안) · `ScanReveal`(정찰 결과) 이 같이 쓴다.
  상자 · 컨테이너가 조사됐는지는 world 의 **열린 모습**(분대 동기화)이 대신 말한다. 떨어진 아이템의 기둥은 `pickups/` 에서 껐다.
- **2026-09-10 (로그 강하 알림)** — 전진기지 · 연구실을 조사해 일어나는 **로그 강하가 조용했다.**
  화면 쪽으로 바꾼 것은 셋이다: ① `hud/DangerIndicators` 에 **넷째 갈래 `drop`** 을 붙였다 — 색은 적의 것이라
  빨강(분대장이면 진하게), 라벨은 `n초` → `로그 n` / `로그 분대장`, 게이트는 **인지력이 아니라** 강하 전용 반경
  `ROGUE_DROP_ALERT_RADIUS`(260 m, `audio/` 의 강하음과 **같은 값**) 하나다. ② 그래서 `hud/OffscreenIndicators`
  의 2026-09-09 `.oarrow.drop` 갈래를 **걷어냈다** — 수류탄 · 함선 호출과 같은 이유(한 목표는 한 언어)이고,
  화살표만 있으면 강하가 **화면 안에 들어오는 순간 표시가 사라졌다.** 이제 이 파일에 남은 갈래는 핑뿐이다.
  ③ `hud/RaidAlerts` 의 토스트는 그대로 두고 거기서 울리던 `wave_alarm` 만 지웠다 — 벌레 웨이브와 **같은
  소리**였고, `enemies/RogueDrop` 도 같은 id 를 울려 **한 사건에 경보가 둘**이었다. 경보(`rogue_drop_alarm`)와
  낙하 굉음(`rogue_pod_fall`)은 `audio/AudioSystem` 이 `rogueDrop:incoming` 하나를 받아 거리 감쇠와 함께 낸다.
  **전장의 안개 게이트는 걸지 않았다** — 지금 벌어지는 사건이지 발견된 오브젝트가 아니다(기존 규약 그대로).

- **2026-09-10 (3차 — 함선 호출 썸네일 · 공유 쿨타임 · 탄약 핑 제거)** — 사용자 요구 4건.
  ① **함선 호출이 임플란트 왼쪽의 정사각 썸네일이 됐다** (`hud/StratagemPanel` 재작성, `.scall`,
  새 시트 `styles/shipCall.css`). 우측 하단 무기 열의 텍스트 패널(`G` 키캡 + 이름 + 설명 + 조작 힌트 +
  가로 쿨다운 바)을 통째로 걷어내고 **글자를 전부 없앴다**(사용자 결정) — 썸네일 + 그 아래 `G` 키캡뿐이다.
  쿨타임은 **임플란트와 똑같이** 딤드 + 아래에서 위로 차오름 + 한가운데 남은 초이고, 같은 `secs` 규칙
  (10초 미만은 소수 한 자리)을 쓴다. 무장하면 테두리 · 키캡이 그 호출 색이 되고 한 번 `pulse` 한다.
  구조선을 들었을 때만 우하단에 분대 공용 잔여 횟수가 붙는다.
  ② **글리프는 `lastArmed` 다.** `G` 탭이 마지막 호출을 다시 무장하므로 평상시 썸네일이 그것을 그린다.
  `StratagemsRef` 에 `lastArmed` 를 새로 뚫지 않고 이미 흐르는 `stratagem:armed` 의 null 아닌 id 로 같은
  값을 따라 만든다 (초기값은 시스템과 같은 `STRATAGEM_ORDER[0]`).
  ③ **하단 중앙 줄의 기하를 `implant.css` 의 `:root` 로 올렸다** (`--imp-th` · `--imp-tw` · `--imp-bottom` ·
  `--imp-gap`). 두 시트가 같은 숫자를 각자 적으면 짧은 화면 media 에서 어긋난다 — 이제 임플란트 썸네일이
  줄면 함선 호출도 함께 줄고, `.scall` 은 `right: calc(50% + var(--imp-tw)/2 + var(--imp-gap))` 라
  **임플란트가 숨어도(미장착 · 전투불능) 자리가 흔들리지 않는다.** 얼굴 클래스는 `.ib-*` 를 나눠 쓰지 않고
  `.sb-*` 로 갈랐다 — HUD 위젯끼리 클래스를 공유하면 한쪽 수정이 다른 쪽을 무너뜨린다(2026-09-09 `.hold`).
  ④ **조준 중에는 함선 호출만 남는다.** `.hud.targeting` 이 임플란트를 숨기는 규칙은 그대로 두고 `.scall`
  에는 걸지 않았다 — 지금 무엇을 들고 조준하는지가 그 순간 유일하게 중요한 정보다.
  ⑤ **아래로 드래그하던 탄약 보충 핑을 없앴다** (`hud/Pings` · `hud/PingWheel` · `styles/wheels.css`).
  `H` 의사소통 휠과 인벤토리의 장착 무기 휠클릭이 같은 부탁을 이미 하고 있어 제스처가 겹쳤다.
  `Gesture` 에서 `'ammo'` 가 빠지고 `classify()` 는 세로 성분을 아예 보지 않는다 — 따라서 `weapon:equipped` ·
  `loadout:changed` 구독, `activeWeaponSlot/Name`, `AMMO_TYPE_KO` 표, `requestAmmo()`, `dragY`, `.ammo-leg`
  DOM · CSS 가 전부 함께 사라졌다. `setHover` 는 `PingSide | null` 만 받는다. **같은 문구를 내던
  `InventorySystem.requestItem` 은 그대로다** — 없어진 것은 핑 제스처뿐이다.
  ⑥ `base.css` 에서는 **죽은 규칙만** 지웠다 (`.strat-panel` 블록 28줄, `.hud.spectating` 목록의 그 한 항목).
  ⑦ 스모크: `smoke-ui-p5` 의 우하단 순서 단언(`strat-panel,qstrip` → `qstrip,wbox` + `.scall` 이 열에 없다),
  `smoke-phase3` 의 `.strat-panel` 존재 검사(→ `.scall .sc-thumb`), `smoke-stratagems` 의 공유 쿨타임 값
  (60 → 90) 을 고치고 **쿨타임 중 휠이 열리지 않는다**는 단언 3개를 새로 넣었다.

- **2026-09-10 (2차 — 레이드 HUD 손보기: 무기 패널 상자 · 퀵슬롯 0.6배 · 흰 구분선 제거)** — 사용자 피드백 3건.
  스타일은 전부 `styles/raidHud.css` 안이고 `base.css` 는 이번에도 한 줄도 건드리지 않았다.
  ① **무기 표시가 "가로로 긴 한 상자" 가 됐다** (`hud/WeaponPanel`). 아이콘만 배경 없이 떠 있던 것을 새 래퍼
  `.wbox`(어두운 반투명 `rgba(0,0,0,0.32)` + 1px `--c-border`, `min-width` 330 px)로 감쌌다. 상자 안은 한 줄 —
  **좌측 등급색 정사각 썸네일**(`.wthumb` 76 × 76; `--wrc` 가 이제 테두리 · 안쪽 글로우뿐 아니라 **바탕색**까지
  정한다: `color-mix(in srgb, var(--wrc) 20%, rgba(0,0,0,0.45))`) → `24 / 120` → 오른쪽 끝의 분류 태그
  (`.wbox .name-row { margin-left: auto }`) — 그리고 상자 **바닥**의 내구도 바.
  ② **`예비` 라벨 제거.** `raidHud.css` 의 `.reserve::before { content: "예비 " }` 를 걷어내 `base.css` 의 `/ `
  구분자로 돌아갔고, `.ammo-nums` 도 세로 열 → **가로 한 줄**이라 `40 / 80` 으로 읽힌다.
  ③ **빠른 사용 · 무기 패널 사이의 흰 가로 구분선 = 내구도 바였다** (사용자 확인). `.dura` 는 `.weapon` 열의
  **맨 위 직계 자식**이라 폭 100 % 흰 선이 퀵슬롯 칸 바로 밑에 그어졌다. 지우지 않고 `.wbox` **바닥**으로
  옮겼다 — 내구도 표시는 그대로 살아 있고 게이지로 읽힌다.
  ④ **퀵슬롯 썸네일 0.6배** (`hud/QuickStrip`). 90 → **54 px**. 칩 크기(`THUMB`)와 칸 크기
  (`.qstrip.is-single .qs-body`)가 **다른 파일에 있으므로 둘을 같이 고친다**.
  ⑤ DOM 이 한 단계 깊어졌지만 `base.css` 의 `.weapon.consumable > .name-row / > .dura / > .ammo-row` 직계
  선택자는 **살려 뒀다** — `.cons` · `.modes` 는 여전히 `.weapon` 의 직계 자식이고, 총기 쪽은
  `raidHud.css` 의 `.hud .weapon.consumable > .wbox { display: none }` 한 줄이 대신 숨긴다. 스모크가 쓰는
  `.weapon .wthumb` · `.weapon .mag` · `.weapon .reserve` 는 전부 descendant 선택자라 그대로 맞는다.
  ⑥ 남은 한계: 퀵슬롯 **위**의 흰 가로선 하나가 더 있는데 그것은 이 두 위젯이 아니라 함선 호출 패널의
  쿨다운 바(`.strat-panel .cd-bar`, 준비 상태라 100 % 로 차 있다)다 — 이번 요청 범위 밖이라 두었다.

- **2026-09-10 (전술 임플란트 HUD 이전 · 크로스헤어 갈고리 · 위험 인디케이터)** — 새 스타일은 전부 **새 시트
  둘**(`styles/implant.css` · `styles/danger.css`)에 있고, `base.css` 에서는 **죽은 규칙만** 지웠다
  (`.implant-gauge` · `.implant-chip` 블록 — 그 클래스를 쓰는 요소가 없어졌다).
  ① **임플란트 표시가 화면 중앙 하단(스태미나 바 아래)으로 내려갔다** (`hud/ImplantWidget` 재작성, `.imp-hud`).
  크로스헤어 좌측 세로 게이지는 사라졌고 쿨타임 · 충전 수 · 내구도가 전부 가로로 긴 썸네일 하나에 들어간다
  (**이름 없음**, 아래에 `Keys.IMPLANT` 키캡). 유형 셋 — 쿨타임형(갈고리 · 정찰 · 대전차포) 딤드 + 아래에서 위로
  밝아짐 + 중앙 남은 초, 충전형(대시) 우하단 충전 수 · 0 이면 쿨타임형 연출 · 1 이상이면 강조색 차오름 · 최대면
  정상, 게이지형(배리어 내구도 · 오버차지 에너지) 중앙 하단 게이지(배리어 잠금 중에는 쿨타임형 연출 겸용).
  ② **`hud/ImplantChip` 삭제.** 무기 패널 위의 임플란트 칩은 새 썸네일과 같은 정보(글리프 + 키)라 중복이었다 —
  `HudSystem` 에서 생성 · prepend · bind · dispose 네 줄이 빠졌다.
  ③ **크로스헤어 갈고리 칩** (`hud/Reticle`, `.rgrap`). 갈고리를 장착했을 때만, 조준 방향에 걸 수 있으면 아이콘 +
  키캡, 없으면 키캡을 숨기고 아이콘만 딤드. 판정은 `implant:grappleTargetChanged {valid}` 하나 — UI 가 레이캐스트를
  새로 쏘지 않는다.
  ④ **위험 인디케이터** (`hud/DangerIndicators`, `.dgr`). 곡사포탄 · 수류탄 · 함선 호출 낙하물을 **화면 안 = 머리
  인디케이터 / 화면 밖 = 크로스헤어 둘레의 방향 호**로 통일했다(피격 방향 호와 같은 언어). 중복 제거: 2026-09-09 의
  `hud/ShellMarkers` 와 `styles/shellMarkers.css` 는 **삭제**하고 그 일을 흡수했으며, `hud/OffscreenIndicators` 에서
  수류탄 · 함선 호출 갈래를 걷어냈다(핑 · 로그 강하만 남는다). 인지력 반경 게이트는 포탄에만 남기되 **착탄 지점이
  `DANGER_NEAR_RADIUS`(csv) 안이면 무조건** 보여 준다. 안개 게이트는 걸지 않았다.
  ⑤ **`data/constants.csv` 에 `DANGER_NEAR_RADIUS` 한 줄 추가**(+ `shared/constants.ts` 의 export 한 줄) —
  코드에 적힌 새 수치는 없다.
  ⑥ 남은 한계: **적(로그)이 던지는 수류탄은 아직 못 그린다** — `enemies/fx/RogueGrenade` 는 버스 이벤트도
  `EnemyManagerRef` 질의도 내지 않는다. enemies/ 가 `getEnemyGrenades()` 같은 읽기 질의를 열어 주면
  `DangerIndicators.collect` 에 갈래 하나만 붙이면 된다. 그리고 `scripts/smoke-controls-hub.mjs` 의 임플란트
  게이지 검사군(`.implant-gauge` 위치 · `.seg` 3분할 · `.read`)은 새 DOM 기준으로 고쳐야 한다.

- **2026-09-10 (레이드 중 HUD 개편 — 사용자 요구 그대로)** — 네 귀퉁이를 한꺼번에 정리했다. 새 스타일은 전부
  **새 시트 `styles/raidHud.css`** 에 있고 `base.css` 는 한 줄도 건드리지 않았다 (`.hud` 를 한 단계 더 붙여
  specificity 로 이긴다 — 로드 순서에 기대지 않는다).
  ① **좌측 상단 = 임무 시간뿐** (`hud/Objective`). `임무 목표` 라벨 · 목표 문구 · 보조 문구 · `.swap` 애니메이션과
  `ui:objective` 구독이 사라지고 시계만 남아 22 px 로 커졌다. `OBJECTIVE_TEXT` · `ui:objective` · `Objective.set()`
  은 **계약이라 남긴다**(`set` 은 no-op) — `HudSystem` 은 손대지 않았다. 훈련장 카운터는 `hud/TrainingPanel` 이
  이미 그리므로 화면에서 사라지지 않는다.
  ② **우측 하단 무기 패널이 커졌다** (`hud/WeaponPanel`). 패널 위의 슬롯 칸(`.wslots` = `hud/SlotStrip`)과 아래의
  주무기 키 · 무기 이름을 걷어내고 그 높이를 썸네일(34 → 58 px, 상자 76 × 76)과 잔탄(40 → 64 px)이 가져갔다.
  썸네일 상자는 **무기 등급색**(`--wrc` = `rarityColor(def.rarity)`, 칩의 `--rc` 와 같은 값)으로 테두리 · 안쪽
  글로우를 칠하고, **예비 탄약은 잔탄 우측 아래**에 `예비 n` 으로 작게 붙는다. 썸네일이 숫자의 **왼쪽**으로 갔다.
  `hud/SlotStrip` 은 위젯 클래스를 지우고 헬퍼(`WEAPON_SLOTS` · `weaponSlotKey` · `weaponShortName`)만 남겼다.
  ③ **퀵슬롯 1.5배 + `T` 키캡** (`hud/QuickStrip`). 60 → 90 px, 칸 번호 · 방향 화살표(`.qs-dir`) 대신
  `.qs-key.keycap` 에 `keyLabel(Keys.QUICK)` — 하드코딩하지 않고 `input:bindingsChanged` 에 다시 읽는다.
  ④ **좌측 하단 = 이름 · 실드 · 체력** (`hud/Vitals`). 체력 수치와 `생명력` 라벨을 지우고 **체력 게이지를 5등분**
  (한 칸 = `ARMOR_SHIELD_PER_SEGMENT` = 20, `data/constants.csv`), 그 **바로 위에 같은 폭 · 같은 눈금의 실드
  게이지**를 올렸다 — 칸 수 = `maxShield / 20`(일반 1 … 전설 5), 칸 색 = `ctx.player.shieldRarity` 의 등급색,
  값은 `ctx.player.shield` 폴링 + `player:shieldChanged`. **방탄복이 없으면 실드 줄은 접히고**(`hidden`) 이름 +
  체력만 남는다(전투불능 동안에도 접힌다). 이름은 `ctx.net.playerName` → `ctx.progression.profile.name` →
  `스캐빈저` 라 싱글 플레이에서도 나온다. 전투불능 표시(`.down-sub` · `.revive` · `.giveup`)는 그대로다.
  **남은 일:** 슬롯 칸 · 목표 문구를 보던 스모크 세 곳(`smoke-ui-p5` 의 우하단 순서 · 훈련 목표 문구,
  `smoke-weapons` 의 `.wslots .wslot` 개수)은 이 개편으로 깨진다 — 스크립트는 이 레인 소유가 아니라 손대지 않았다.
- **2026-09-10 (꾹 누르기 키캡이 사라지던 버그 · 지도 두 가지)** —
  ① **키캡 modifier 이름이 `hold` → `kc-hold`.** `.hold` 는 이미 크로스헤어의 **홀드 링**(`hud/HoldGauge`,
  `position:absolute; width:120px; height:120px; margin:-60px; opacity:0`)이 쓰고 있었다. 그 규칙은 `.keycap` 과
  특정도가 같고 스타일시트에서 **뒤에** 오므로 `class="keycap hold"` 는 **120×120 투명 상자**가 됐다 — 상호작용
  프롬프트에서 키캡이 통째로 안 보이고 `:has()` 여백(16 px)만 남아 패널이 세로로 길어지던 그것이다.
  `hud/InteractionPrompt` · `hud/KeyGuide` · `styles/base.css` 세 곳이 같이 바뀌었고 chevron 그림은 그대로다.
  **HUD 위젯 클래스와 같은 이름을 modifier 로 쓰지 않는다.**
  ② **지도의 재해가 안개 위에 확실히 덮인다.** 채움 0.16 → 0.26 에 **빗금 무늬**(`hazardHatch`, 9 px 타일)를 한
  겹 더 깔고 경계선은 어두운 밑선(4.5 px) + 밝은 선(2.2 px) 두 겹이다 — 모래 폭풍 · 눈보라가 컬러 지형 위에서
  "있는지조차 안 보인다" 던 문제. 그리는 자리는 예전과 같이 안개 레이어 **위**다.
  ③ **전장의 안개 경계선**(`buildFogEdges` / `drawFogEdges`). 컬러 레이어는 마스크를 업스케일 스무딩해 만들어
  가장자리가 번졌다 — 이제 밝혀진 칸이 미탐색 이웃과 맞닿는 **격자 변**을 그대로 이어 또렷한 선을 긋는다
  (어두운 밑선 + 밝은 선). 선분 목록은 `fog.revision` 이 바뀔 때만 다시 만든다 (`cells²` 한 번 훑기).
  ④ **보조무기 칸 제거**(전역 결정) — `hud/SlotStrip` 의 `WEAPON_SLOTS` 가 둘이고 `cells` 는 `Partial<Record<…>>`
  다. `WeaponSlot` 타입의 `'secondary'` 는 계약이라 그대로 있고 칸만 그리지 않는다.

- **2026-09-09 (가구 창고 `배치` 버튼)** — 결정 2026-09-09: 시설 관리의 **가구 창고** 탭에서 카드를 클릭하면
  **선택만** 된다(`.is-sel` 강조) — 더는 `selectFurniture` 로 커서에 고스트가 올라오지 않는다 (가구 제작 탭의
  "보유 > 0 카드 클릭 → 고스트" 는 그대로). 놓는 것은 카드 **오른쪽의 `배치` 버튼**(`.fcard-place`, 제작 탭의
  `.fcard-craft` 와 같은 칩)이다: `ShipManage.findFreeSpot` 이 `ctx.housing.findFreeSpot(room, defId)` 에 물어 그 자리에
  `HousingRef.place` 로 곧바로 내려놓는다 — **2026-09-10 부터 자리를 고르는 규칙 자체는 `housing/Rules.autoPlaceSpot`
  이 갖는다**: 화면 기준 **좌측 상단부터 가로줄 우선**(격자 x 오름차순 바깥 · y 내림차순 안쪽)으로 훑고 회전은
  `AUTO_PLACE_YAWS = [1, 0]` 이라 작업대가 **아래를 향한다**(예전 yaw 0 = 오른쪽 벽을 보던 그것). 문 앞 여유도
  자동 배치에서만 비켜 간다 — 창고 수량 차감 · `housing:furniturePlaced` 는 기존 place 경로가 낸다
  (튜토리얼 `benchPlace` 단계는 그 이벤트로 넘어가므로 그대로 동작한다). 성공 `ui_equip` + 토스트, 실패 `ui_deny`.
  **자리가 없으면 버튼이 꺼지고** `.fcard-note` 가 `자리 없음`(`.is-full`, 악센트색)을, 맞으면 `배치 가능`, 이 방
  용도가 아니면 전과 같이 `<용도> 전용` 을 적는다. 맞는지는 **방이 바뀔 때마다 다시 잰다**: 목록 메모 키에 fit
  결과가 들어가고 `housing:changed` 외에 `housing:furniturePlaced` / `furnitureMoved` / `furnitureRecovered` /
  `facilityUpgraded` / `roomPurposeChanged` 와 방 전환(`housing:shipManageChanged`)이 전부 `refresh` 를 부른다.
  `card.dataset.defId` 손잡이는 그대로다 (튜토리얼 스포트라이트 `.sm-store .fcard[data-def-id="furn_bench_gun"]` —
  `배치` 버튼이 카드 안에 있어 같은 구멍 안에 든다). 스모크: `scripts/smoke-housing.mjs` 에 배치 버튼 · 사유 ·
  클릭 관통(선택만 → 배치 → 방 1 에 놓임 → recover) 을, `scripts/smoke-tutorial.mjs` 의 `benchPlace` 는 카드 클릭이
  고스트를 만들지 않는 것과 `배치` 버튼이 단계를 넘기는 것으로 바꿨다. 튜토리얼 `benchPlace` 의 힌트 문구("작업실
  바닥을 클릭해 내려놓습니다")는 `src/tutorial` 소유라 여기서 고치지 않았다 — `배치` 버튼 문구로 바꾸는 것이 남은 일.

- **2026-09-09 (캐릭터 생성창 개편)** — `menus/CharacterCreate` 가 **세 열**이 됐다: [이름 · 임플란트 타일] [능력치
  세로 다섯 줄] [미리보기 + 악센트]. 1280×720 에 스크롤 없이 들어가야 해서 아래 띠였던 능력치가 가운데 열로
  올라왔고 나머지 두 열은 grid stretch 로 같은 높이다 (`styles/title.css`). 바뀐 것: ① 이름 칸의 안내문이
  사라지고 placeholder 가 `최대 N자까지 입력` (`CHARACTER_NAME_MAX`); ② 악센트 스와치가 **미리보기 바로 아래**
  (`.cc-side > .cc-accent`) 로 갔고 안내문은 없다; ③ 시작 임플란트는 여러 줄 목록(`.cc-implants > .cc-imp`) 대신
  **큰 타일 하나** `.cc-imp-tile[data-id]` (아이콘 · `--ic` · 이름 우하단) + 타일 오른쪽에 뜨는 **컨텍스트 메뉴**
  `.cc-imp-menu` (`.sc-menu` 껍데기 재사용, 항목 `.cc-imp-mi[data-id]`, 바깥 클릭 · Escape 로 닫힘 — Escape 는
  capture 에서 삼킨다); ④ 능력치는 `.cc-stat-grid`(2열 auto-fit) → `.cc-stat-list`(세로) 이고 `◀` 도 `▶` 와 같은
  주황; ⑤ **`확정` 은 `statPointsLeft > 0` 이면 `disabled`** (툴팁 `남은 점수를 모두 배분하세요`), 우회 시
  `능력치 배분 미완료` 팝업, 요약의 "남은 점수 N점은 버려집니다" 줄 삭제. 새 getter `draftImplant` ·
  `isImplantMenuOpen`. 스모크는 생성창 안을 아직 건드리지 않는다 (`smoke-ui-p5` 는 선택창까지만).

- **2026-09-09 (전장의 안개 · 발견 게이트)** — 레이드 지도는 더 이상 열려 있지 않다.
  `map/MapScreen` 의 정적 캔버스가 **회색 윤곽**(미탐색)과 **컬러**(밝혀진 곳) 두 겹으로 갈라졌고, 컬러 겹은
  `FogRef.mask` 를 `ImageData` 알파로 밀어 넣어 `source-in` 으로 잘라 낸 `fogLayer` 로 그린다 — **`fog:revealed`
  가 왔을 때만** 다시 만든다(매 프레임 마스크를 훑지 않는다). 둥지 · 상자 · 채집물 · 탈출 신호소는
  `fog.isDiscovered` 가 true 인 것만 그리고, `hud/WorldMarkers` · `hud/Compass` 도 같은 게이트를 쓴다
  (**활성 신호소와 함선은 예외** — 이미 분대 전원이 아는 사실이다). `hud/OffscreenIndicators` 는 **일부러
  게이트하지 않는다**: 화살표는 전부 살아 있는 분대 사건(수류탄 · 핑 · 함선 호출)이지 월드 랜드마크가 아니다.
  사이드 패널에 **탐색률**(`FogRef.explored`) 이 붙었다. 안개가 없는 세계(훈련장)에서는 셋 다 예전 그대로다.

- **2026-09-09 (함선 호출 재편 · 구조선 선택 화면 · 분대장 넘기기)** — 세 가지가 UI 쪽에 걸렸다.
  - **호출 목록**: 휠은 4분할 그대로지만 항공 폭탄이 빠지고 **구조선 투하 ✚** 가 들어왔으며 구조물 투하의 표기가
    **트라이포드 투하**로 바뀌었다. 이름은 코드에 없다 — 전부 `STRATAGEM_DEFS`(= `data/stratagems.csv`) 에서 읽는다.
    지금 무장할 수 없는 칸은 회색 + `🔒 사유` 이고, 그 판단은 `hud/StratagemWheel` 이 export 하는
    **`stratagemLockReason(ctx, id)`** 하나다 — `STRATAGEM_HOST_ONLY` 와 `ctx.stratagems` 의 구조선 필드만 보므로
    stratagems 의 거부 규칙과 어긋날 수 없다(문자열만 다르다: 휠은 `분대장 전용`, 거부 토스트는 `분대장만 쓸 수 있습니다`).
  - **`hud/RescuePicker`** (새 파일 + 자기 스타일시트): 위 표의 행 참조. `ctx.stratagems` 를 폴링해 스스로 뜨는
    유일한 HUD 화면이다 — stratagems 가 "화면을 열어라" 이벤트를 갖고 있지 않고(계약에는 `rescue:selectTarget`
    한 방향뿐이다), `armed` + `rescueTarget` 두 필드로 이미 유도할 수 있어서 계약을 늘리지 않았다.
  - **`hud/Community` 우클릭 → 분대장 넘기기**: 확인 팝업(`menus/askPopup`)을 거쳐 `leader:transferRequested`.
    행을 PeerId 로 되짚기 위해 `menus/social/SocialColumn.squadRow` 가 `data-peer-id` 를 한 줄 더 쓴다 —
    그 파일에서 바뀐 것은 그 한 줄뿐이다.


- **2026-09-09 (자동 부활 제거 → 구조선 대기)** — `hud/SpectateOverlay` 의 `부활 (n초)` · `Space: 부활` 줄이
  **`남은 구조선 n`** (`ctx.stratagems.rescueLeft`, 0 이면 붉게 펄스) 로 바뀌었고 입력 폴링이 사라졌다;
  `menus/DeathScreen` 에서 부활 버튼 · Space 캡처 핸들러 · 카운트다운이 통째로 빠졌다 (`함선으로 귀환` 하나만 남는다);
  `hud/Notifications` 는 `game:respawnAvailable` 대신 `rescue:called` / `leader:deviceDropped` 를 듣는다;
  `styles/base.css` 의 `.spectate .respawn` · `.ui-btn.respawn` 규칙이 `.spectate .rescue` 로 교체됐다.

- **2026-09-09 (ESC 자리 · 설정 폭 · 스크롤바 · 키 가이드 닫기 항목)** — 사용자 요청 넷.
  ① **ESC 일시정지 메뉴는 화면 중앙 왼쪽 고정**이다. 2026-09-08 의 "메뉴가 커서를 찾아간다"(`parkUnderCursor` →
  `--menu-dx/dy`)를 통째로 걷어냈다 — 커서 추적 코드 · `CURSOR_BIAS` · resize 리스너 · 커스텀 속성이 전부 사라졌고,
  자리는 CSS 하나가 정한다 (`.menu.pause` 가 `justify-content: flex-start` + `margin-left: clamp(24px, calc(25vw - 210px), 40vw)`).
  메뉴가 매번 다른 자리에 뜨는 것보다 **늘 같은 자리**가 손에 익는다는 판단(사용자 결정).
  ② **설정은 화면 중앙**에 오고 좌우로 넓어졌다 (min 960 / max 1120 px, `width: min(1120px, 100vw - 80px)`).
  왼쪽으로 붙어 있던 이유는 ESC 열을 피하려던 것이었는데, ESC 가 왼쪽 절반으로 옮겨 갔고 설정은 자기 배경을
  깔고 그 위에 뜨므로 더는 피할 것이 없다. 좁은 화면 fallback 은 980 → 1040 px 로 함께 올렸다.
  ③ **스크롤바가 UI 템플릿 색을 쓴다.** `:root` 에 `--sb-track` · `--sb-thumb` · `--sb-thumb-hover` 세 값을 두고
  `#ui-root` 아래 **모든** 스크롤러에 한 규칙으로 적용한다 (Firefox 의 `scrollbar-color` + Chromium 의
  `::-webkit-scrollbar-*` 둘 다). 패널마다 흰 막대(`rgba(255,255,255,0.22)`)를 따로 적던 것들은 토큰 참조로
  바뀌었고, 채팅의 "열려야 보인다" 규칙은 그대로다. `inventory/inventory.css` 는 이 스타일시트를 import 하지
  않으므로 같은 이름을 **fallback 과 함께** 참조한다 — 값은 여기서만 고친다.
  ④ `hud/KeyGuide` 가 스스로 붙이는 마지막 `Tab 닫기` 항목에 **`kg-close`** 클래스가 생겼다. 튜토리얼의
  함선 관리 닫기 단계가 `.key-guide .kg-close` 를 포커싱해 "이 키로 나갑니다"를 가리킨다.

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (채팅 UI 정리 · 키 가이드)** —
  ① **`hud/ChatLog` 하단 버그**: 로그가 길어지면 최신 줄이 아니라 중간이 보이던 원인은 스크롤 상자의 **높이가
  `scrollTop` 을 맞춘 뒤에 바뀌는 것**이었다 — `close()` 가 300 px 패널을 닫힌 높이로 줄이면 브라우저는 `scrollTop`
  값을 그대로 두므로(아래 모서리를 붙잡지 않는다) 최신 ~130 px 이 시야 밖으로 밀렸고, 첫 줄들이 찍힌 뒤 웹폰트가
  들어오면 모든 줄이 키가 자라 같은 일이 났다. `stick()` 이 지금 + 다음 프레임에 다시 붙이고 add / open / close /
  `document.fonts.ready` / `ResizeObserver` 에서 호출한다.
  ② **닫힌 상태는 정확히 3.5줄**: 실제 줄 하나를 측정해 `--chat-closed-h`(3줄 + 간격 3 + 반 줄)를 `.chat` 에
  쓴다 — 위쪽 네 번째 줄이 반만 보이고 페이드 마스크가 그걸 의도처럼 보이게 한다. 열린 상태는 300 px 그대로.
  ③ **Enter 는 보내고 입력창을 유지한다** (비우고 포커스 유지, 행을 숨기지 않아 `objSwap` 입장 애니메이션이 다시
  돌지 않는다; 빈 Enter 는 무시; 귓속말 대상 유지). **닫기는 Tab(`Keys.INVENTORY`) · Esc 만** — Tab 은
  `ctx.input.consume` 으로 삼켜 인벤토리가 열리지 않는다. 입력창 오른쪽 끝에 **`<Tab> 키로 닫기`** 힌트
  (`.chat-hint`, `flex:none`, 라이브 `keyLabel`, `input:bindingsChanged` 갱신); 입력은 `flex:1; min-width:0`
  한 줄이라 긴 글은 안에서 스크롤되고 힌트를 덮지 않는다. `120자` 힌트와 플레이스홀더의 `Esc 취소` 는 뺐다.
  ④ **새 `hud/KeyGuide`**: `ui:keyGuide {owner, keys|null}` 스택의 맨 위를 우하단 한 줄(`R 회전 · X 버리기 · Tab 닫기`)
  로 그린다 — **닫기 항목은 가이드가 스스로 붙인다** (항상 마지막). `#ui-root` 직계 자식 z 84, `'menu'` 블로커 ·
  채팅 입력 중 · 빈 스택이면 숨김, `game:newMission` / `game:abort` 에 스택 초기화. `HudSystem` 디버그 getter
  `keyGuideOwner` / `keyGuideOwners` / `keyGuideEntries` / `isKeyGuideOn`.
  ⑤ **`hud/HousingHint` 삭제** (하단 중앙 키 바 + `.housing-exit` 칩, CSS 포함) — hub/HousingMode 가
  `ui:keyGuide {owner:'housing'}` 를 내고 가이드가 그린다. `.hud.housing` 레이어에는 `ShipManage` 만 남는다.
  `isHousingHintOn` getter 도 없어졌다 → **`scripts/smoke-ui-p6.mjs` 의 housing-hint 블록(88–91 · 175–188 · 424행)은
  손봐야 한다** (scripts/ 는 이 작업 범위 밖).
  ⑥ **Tab 이 화면을 닫는다**: `map/MapScreen` (M 또는 Tab, `owner:'map'` 가이드 — 핑 · 확대 · 이동),
  `hud/Community` (P 또는 Tab, `owner:'community'` — 우클릭 메뉴 · P 닫기). 둘 다 Tab 을 consume 한다.
  `ShipManageHint` 는 그대로 — 블로커가 없을 때만 보이고 가이드는 화면이 열렸을 때만 보여 같은 모서리를 나눠 쓴다.
  Esc 는 예전 그대로다: 채팅을 닫으면서 **일시정지 메뉴가 그 위에 쌓인다** (2026-09-08 규칙 — 헤드리스에서도
  `blockers:['menu']` 로 확인).

- **2026-09-08 (UI/UX 정리 2차)** —
  ① **무기 교체 게이지가 크로스헤어로**: `hud/ReloadGauge` 가 `weapon:swapStarted` 도 받아 같은 링을 `무기 교체`
  라벨(`.reload.swap`, 밝은 흰색)로 돌린다. 교체와 재장전은 겹칠 수 없어서(교체가 재장전을 끊는다) 링 하나면
  충분하고, `mode` 는 **어떤 이벤트가 링을 끌 수 있는지**만 가른다 — `weapon:equipped` 는 교체 **중간**(새 총이
  붙는 50 % 지점)에 오므로 재장전 링만 끈다. `hud/WeaponPanel` 의 160 px `.swap` 실선과 `swapShow`/`swapSweep`
  키프레임은 삭제 (전투 중 아무도 우하단을 보지 않는다).
  ② **일시정지 메뉴** (`menus/PauseMenu`): `일시 정지` 제목 삭제(Escape 는 실제로 멈추지 않는다), **Tab** 이
  `게임으로 돌아가기` 의 고정 단축키(`Keys.INVENTORY` 가 아니라 `'Tab'` 코드 — 라벨이 어긋날 수 없다;
  `InventorySystem` 은 `'menu'` blocker 아래에서 Tab 을 이미 거른다), **파티 떠나기**(`ctx.net.lobby` 가 있을
  때만) · **게임 종료** 추가, 그리고 파티 떠나기 / 타이틀로 / 게임 종료는 전부 새 **경고 팝업**(`.pause-ask`,
  Escape=취소 · Enter=확인)을 거친다. 게임 종료는 `window.close()` — Electron 셸에서는 앱이 닫히고, 브라우저
  탭은 스크립트로 닫을 수 없으므로 안내 토스트 후 타이틀로 간다.
  ③ **커뮤니티 패널 고정 크기** (`.cp-frame`): 940 × 760 (뷰포트로 클램프). 목록이 늘고 줄 때마다,
  `받은 친구 요청` 이 나타날 때마다 프레임이 커졌다 작아져 `닫기` 가 커서 밑에서 도망갔다. `.sc-body` 가 대신
  스크롤한다.
  ④ **분대원 1×4** (`menus/social/SocialColumn`): 세로 스택이 아니라 `NET_MAX_PLAYERS` 칸 가로 그리드 —
  로비 슬롯당 한 칸(프로필 왼쪽 · 사운드 조절 오른쪽), 빈 슬롯은 `빈 자리` 로 그려서 인원이 바뀌어도 가로 폭이
  변하지 않는다. 섹션 헤더에 **파티 떠나기**(`.sc-leave`)가 붙고, 확인 카드는 `SocialMenu.askConfirm(...)` 으로
  일반화해 친구 삭제와 공유한다.
  ⑤ **친구 3.5줄 / 최근 플레이어 5.5줄 고정** (`.sc-grid.fixed`): `max-height` 가 아니라 `height` 라 카드가
  둘이든 마흔이든 상자 크기가 같다. `받은 친구 요청` 은 카드가 더 높고(수락/거절) 있을 때만 존재하므로 그대로
  탄력적으로 둔다.

- **2026-09-08 (지도 · 고철 더미)** — `map/MapScreen` 이 `getGatherNodes()` 의 `kind: 'salvage'` 노드를
  약초의 초록 십자 대신 **호박색 작은 사각**으로 그린다 (해체하면 똑같이 흐려진다). 폐금속을 찾아다닐 수 있게
  하는 게 목적이라 채집물과 한눈에 구분되어야 했다.

- **2026-09-08 (UI/UX 정리 6건)** —
  ① **일시정지 메뉴가 커서를 찾아간다**: 페이지는 OS 커서를 옮길 수 없으므로 메뉴가 움직인다 —
  `PauseMenu.parkUnderCursor()` 가 `게임으로 돌아가기` 버튼 안(중앙보다 살짝 오른쪽)에 **화면 한가운데**가 오도록
  `--menu-dx/dy` 를 쓴다. Escape 로 포인터 락이 풀리면 커서가 돌아오는 자리가 거기다. Phase 11 의 좌측 정렬
  (`justify-content: flex-start` + `margin-left: 72px`)은 그래서 사라졌고, `menuIn` 키프레임도 같은 오프셋을
  실어야 애니메이션이 가운데로 되돌아가지 않는다.
  ② `hud/ShipManage` 의 **빈 방으로**가 `HousingRef.removeRoomFacility` 로 간다 — 확인 팝업에 돌려받을 재료 칩을
  띄우고 **100% 환급**한다 (전에는 환급 계산이 끝난 뒤 housing 이 타는 무료 경로 `setRoomPurpose(i,'empty')` 를
  직접 불러 시설 증축 값을 그냥 태웠다).
  ③ `hud/ItemTip` 에 **임플란트 줄**(장착칸 · 퍽 · 능력치 · 망가짐)이 생겼다 — 인벤토리 임플란트 칸이
  썸네일 줄로 바뀌면서 그 글자들이 사는 곳이 이 카드다.
  ④ `hud/ContractPanel` 은 **시뮬레이션 훈련장에서 뜨지 않는다**.
  ⑤ 훈련장의 목표 줄은 `world/TrainingArena.announce()` 가 갖는다 — 강하가 없어져 `'playing'` 이 `world:ready`
  와 같은 tick 에 오면서 `HudSystem` 이 카운터를 덮어 쓰던 것을 끊었다.
  ⑥ `hud/HousingHint` 가 `C · Esc 취소` 로 읽는다 (하우징 모드가 Escape 를 먹는다).

- **tactical kit** — `hud/ImplantWidget` (**vertical gauge left of the crosshair** since 2026-09-06: cooldown fill / dash 3 yellow segments / barrier hp + lockout / overcharge energy), `hud/WeightBar`, `hud/Detection`, `hud/ScanReveal`, `hud/Deployables`, `hud/ActionFeedback`, `hud/ProgressToasts`, grapple reticle bracket (equipped + hookable), durability / weight / craft / gadget toasts; every key hint reads `keyLabel(Keys.X)` and refreshes on `input:bindingsChanged`; **title controls diagram** `menus/ControlsPanel` (procedural keyboard + mouse, bound keys lit, function list) + **key settings** `menus/KeybindMenu` (title footer / pause menu `키 설정 변경`; capture next key, conflicts flagged, reset); shared screen tabs `.scr-tabs`

- **Phase 6** — `hud/WeaponChargeGauge` (`weapon:chargeChanged` charge / spinup / slash arc), unique-weapon mode lines `좌 … / 우 …` in `WeaponPanel`, `hud/StatusMarkers` (🔥 전소 / ⚡), `hud/CheatTag` (MOVE CHEAT), `hud/HousingHint` (`.hud.housing` fourth root: selection / cursor / key line), `hud/RoomLabel` (`방 n · 용도`)

- **Phase 5** — `menus/RewardsBlock` (result-screen XP count-up, `Lv. a → b`, XP bar, contract line from `stats.rewards`), `hud/ContractPanel` (active contract `p / t` under the objective, `달성`), `hud/MetaToasts` (credits chip, rep level, contract settlement) + quest / purchase / sale lines in `Notifications`, title `Lv. n` chip

- **Phase 7** — `RewardsBlock` owns the level-up moment (badge + light burst + the only `level_up` chime when the bar crosses the level; `ProgressToasts` no longer toasts it), contract wording from `settlement.outcome`, `DeathScreen` 레이드 실패 mode (`game:raidFailed`: no 부활, auto-return countdown), `Nameplates` / `Squad` / `MapScreen` show `연결 끊김` + grey for suspended members and 훈련장 / 임무 중 / 함선 badges, host-change / suspend / training chat + notification lines, training objective text, `hud.debugRemotes` for smokes

- **Phase 8** — `menus/SettingsMenu` (키 설정 + 오디오 전체·효과음), pause menu 게임으로 돌아가기 / 설정 / 타이틀로 (+ 함선으로 귀환 on a mission only) and it now opens **in the ship** too, `hud/ShipManageHint` (bottom-right **시설 관리** + M) and `hud/ShipManage` (방 목록 + a **vertical right-hand** 가구 목록 that becomes a 용도 지정 picker for an empty room), `.item-chip*` CSS implementing the `src/shared/itemChip.ts` contract, **`hud/ItemTip`** (Phase 8 UI pass: the one hover card for every `.item-chip[data-def-id]`, a direct child of `#ui-root`)

- **Phase 9** — the downed 포기 hold has a progress bar (`player:giveUpProgress` → `hud/Vitals` `.giveup`), `hud/TrainingPanel` (표적 모드 · 격추 · 남은 시간 · 최고 기록, training only), and a suspended teammate's ghost bleed shows on `Nameplates` / `Squad` (`ghostState` 1 → red `ghostDownHp` bar, 2 → `사망`)

- **Phase 9 UI/UX 개선** — `hud/WeightBar` 삭제 (무게는 인벤토리에서만), 채팅 + 분대 목록을 좌하단 `.hud-bl` 열로 (체력바 위), `hud/ContractPanel` 에 **분대 계약** 행 추가, 새 `hud/QuickStrip` (빠른 사용 썸네일) · `hud/ImplantChip` (임플란트 썸네일) 과 `hud/StratagemPanel` 을 무기 패널 열에 prepend (고정 `bottom` 좌표가 겹치던 문제 해결), `hud/WeaponPanel` 에서 주무기 / 탄약 표기 제거, 스태미나 불투명 흰색, `hud/ShipManage` 에 가구 제작 / 가구 창고 탭 + 용도 지정 재료 칩, `hud/ItemTip` 이 `[data-item-tip]` 도 인식. **Phase 9 UI pass**: `hud/HousingHint` is the placement **key line only** + a bottom-right `.housing-exit` 종료 (Esc) chip, `hud/ShipManage` rows / 용도 지정 entries carry the shared facility thumbnail (`.sm-thumb`) and the picker is sorted 제작 가능 → 제작 불가 → 이미 제작 (`purposeRank`)

- **Phase 10** — the reload radial moved from the weapon panel to the **crosshair** (`hud/ReloadGauge.ts`, closed by the new `weapon:reloadCancelled`), new `hud/HealGauge.ts` (full-circle 회복약 hold ring), **middle-click pings on the tactical map** (`MapScreen.fromX/fromZ` + `setPingPlacer` → the new public `Pings.placeAtWorld`, which keeps the crate / pad / pickup snapping and also serves `ping:requestAt`), the item tooltip gained a **bottom credit bar** and every ui credit readout uses `formatCredits`, `hud/SoftCursor.ts` drew the in-game cursor sprite (`input:cursorModeChanged`, `translate:` channel, `body.soft-cursor-on`) — **2026-09-07 커서 rework 로 삭제**, `hud/GameCursor.ts` 가 절차 생성 커서 아트를 CSS `cursor:` 이미지로 주입한다, and the light-blue fresnel spheres in `hud/Detection.ts` / `hud/ScanReveal.ts` became **upward-fading light pillars** (shared `hud/pillar.ts`, baked vertex colours, still pooled and light-free). `menus/MenuBase` (the Esc pause menu) deliberately keeps the real OS cursor

- **Phase 11 (2026-09-07)** — ESC 는 버튼 열이 **화면 좌측**으로 가고 **함선에서만** 우측 `.pause-social` 열이 붙는다(분대원 — 아이디 · 레벨 + 보이스 슬라이더/음소거는 **UI 전용** · 받은 친구 요청 · 친구 · 최근 플레이어), 새 `menus/social/` (`SocialColumn` 은 ESC 와 커뮤니티 패널이 **공유**, `ProfileCard`, `SocialMenu` 우클릭 4항목은 `SocialRef.playBlock` → `PLAY_BLOCK_LABELS` 로 게이팅, `socialSource` 가 유일한 읽기 지점), `menus/SettingsMenu` 는 **좌측 중앙 측면 패널**(오디오 + 키 설정 안에 실제 `ControlsPanel`), `hud/Community.ts` (함선 전용 우상단 썸네일 — 내부 우하단 접속 친구 수 · 우상단 레드닷, `COMMUNITY_BLOCKER` 패널, 아래로 쌓이는 분대 초대 + `Keys.INVITE` 홀드 게이지), `hud/ChatLog` 귓속말 모드(`→ 이름` 칩 · `.chat-line.whisper` · `.hud-bl.whispering`), `MissionComplete` 다시 배치가 `ctx.missionPlanet` 을 싣고 결과 화면에 `행성 · <이름>` 줄

- **2026-09-07 (인게임 HUD 정리)** — `hud/MissionInfo` **삭제**(우상단 처치수 제거, 임무 시간은 `hud/Objective` 의 `임무 목표` 라벨 옆 `.clock`), `hud/Vitals` 의 회복약 · 수류탄 알약 제거(좌하단은 체력 + 스태미나만), `hud/QuickStrip` 은 **마지막으로 선택된 슬롯 1칸**을 2배(60 px) 썸네일로, `hud/WeaponPanel` 은 이름 줄 대신 탄약 우측에 **고정 크기 무기 썸네일 상자**(`.wthumb` = `buildItemChip` + 명칭), `hud/SoftCursor` 는 `SoftCursor.onMove` 로 입력 이벤트마다 즉시 그린다 (**2026-09-07 커서 rework 로 삭제** → `hud/GameCursor`)

- **2026-09-07 (회복 소모품)** — `hud/HealGauge` 가 `heal:holdChanged.dur` 로 아이템별 사용 시간을 세고 `spray` 면 남은 게이지를 `스프레이 n %` 로 보여주며, `hud/WeaponPanel` 의 소모품 힌트가 아이템별 홀드 시간 + `이동 50 %` 를 적는다

- **2026-09-07 (새 캐릭터)** — `menus/TitleMenu` 에 **새 캐릭터로 시작** 버튼 + `.newchar-confirm` 확인 카드, 새 `menus/newCharacter.ts` (`resetCharacterSaves()` — `scav.` 접두 키를 전부 지우되 키 설정 · 오디오 · 콘솔 기록은 남기고 **세션 토큰까지** 버려 서버 프로필도 새로 발급받는다; 확인 뒤 페이지를 리로드)

- **Phase 12 (2026-09-08)** — 새 `hud/ScanTracker` · `hud/CutsceneWatch`; `hud/Compass` 가 감지 반경 안의 적을 빨간 눈금으로(`queryNear` ≤10 Hz, `COMPASS_ENEMY_COLOR`) 그리고 `scan:cast` 로 드러난 적은 거리와 무관하게 15초 유지, `hud/Detection` 화면 내 붉은 인디케이터 + 스캔 대상 포함, `ScanReveal` 풀 160 + `scan:cast`, `Notifications` 에서 채집 토스트 삭제 · `item:channelChanged` 단일 라인(그 동안 `player:stimUsed` 음소거), `ShipManageHint` / `Community` 는 도킹 · 워프 컷씬 동안 숨고 시설관리 힌트는 개인 함선 전용, `hud/ShipManage` 에 발전기 행 + 인라인 차단 사유 + 중앙 모달리스 확인 팝업(Esc 소비); 일시정지 z-index 85(설정 86 · 키설정 88)

- **2026-09-08 (UI/UX)** — `styles/base.css` 에 `.scr-tab.has-alert::after` **레드닷** (Tab 화면 탭 위 빨간 점, 1.6 s 맥박, `prefers-reduced-motion` 이면 정지). 오늘의 유일한 사용처는 인벤토리 창의 **캐릭터** 탭 — 쓰지 않은 능력치 포인트가 있을 때 `inventory/ui/parts/Screens.markTab` 이 붙인다

- **2026-09-08 (튜토리얼)** — `hud/Community` 가 `ctx.tutorial?.hides('community')` 면 버튼을 숨기고 열려 있던
  패널을 닫는다. `hud/ShipManage` 의 가구 카드에 `data-def-id` 를 붙였다(튜토리얼 스포트라이트 · 스모크가
  카드를 집는 손잡이). `styles/base.css` 에 `.scr-tab.is-locked` (자물쇠 + 흐리게) 추가 — 튜토리얼이 잠근
  화면 탭용이다. 튜토리얼의 목표 패널 · 스포트라이트 · 안내 카드는 `src/tutorial/` 이 직접 그린다

- **2026-09-08 (튜토리얼이 집을 손잡이)** — `hud/ShipManage` 의 가구 탭 버튼에 `data-tab`(`craft` · `store`),
  가구 창고 카드에 `data-def-id`(가구 제작 카드와 같은 이름)를 달았다. 튜토리얼 스포트라이트가 '가구 창고'
  탭과 그 안의 작업대를 차례로 밝히기 위한 것으로, 동작에는 영향이 없다 (`src/tutorial/README.md`)

- **2026-09-08 (튜토리얼: 잠그지 않고 감춘다)** — `hud/ShipManage` 가 `ctx.tutorial.hides('roomPurpose'|'furniture', id)`
  로 **용도 행 · 가구 카드를 목록에서 뺀다** (안내 중에는 발전기 행 + 작업실 한 줄만 남는다). 두 목록의
  캐시 키에 현재 단계를 섞고 `tutorial:changed` 를 구독하므로 건너뛰거나 끝나면 그 자리에서 전부 돌아온다.
  `styles/base.css`: 시설 증축 확인 팝업 `.sm-confirm` 의 z-index 5 → **79** — 스포트라이트(`.tut-spot`, 78)가
  그 위를 덮어 **확인을 누를 수 없던** 버그. `.scr-tab.is-locked` 는 삭제했다 (탭은 이제 잠기지 않고 숨는다)

- **2026-09-09 (경고 팝업: 취소 버튼 튀어나옴 · 확정 1초 홀드)** — `menus/PauseMenu` + `styles/base.css` 만 건드렸다.
  - **레이아웃 버그의 진짜 원인**: `.ui-btn` 이 메뉴 버튼 열을 위해 갖고 있는 `min-width: 220px` 를 `.pause-ask-foot`
    가 되돌리지 않았다. 420 px 카드 안에서 220 px 짜리 둘(+ gap)은 440 px 아래로 못 줄어드는데
    `justify-content: flex-end` 라 넘친 만큼이 **카드 왼쪽 밖으로** 밀려 나갔다 — 그게 "취소가 왼쪽으로 튀어나온다".
    이제 `.pause-ask-foot .ui-btn { flex: 1 1 0; min-width: 0; height: 40px }` — 같은 높이의 반반 한 쌍이라 어떤
    카드 너비(`min(420px, 100vw − 48px)`)에서도 넘치지 않는다.
  - **확정은 1초 홀드**(`UI_HOLD_CONFIRM_S`, `data/constants.csv`). 파티 떠나기 · 타이틀로 · 게임 종료 셋 다.
    제작 / 분해와 같은 어휘다 — 버튼 위를 쓸고 지나가는 채움(`.pause-ask-fill`, `inventory.css` 의 `.inv-craft-fill`
    과 같은 모양), 도중에 놓으면 취소 + 0 으로 리셋, 다 차면 **한 번만** 실행. 포인터 릴리스는 이 프로젝트의 드래그
    코드처럼 `window` 에서 듣는다(버튼 밖에서 놓아도 게이지가 남지 않는다), 버튼을 벗어나면 취소, rAF 로 진행한다
    (메뉴에는 프레임 훅이 없다). 카드에는 `UI_HOLD_CONFIRM_S` 로 만든 한 줄 안내가 붙는다.
  - **Enter 확정은 없앴다.** 이제 삼켜 버리고 아무것도 하지 않는다 — Enter 는 채팅 키이자 브라우저가 포커스된
    버튼을 누르는 키라, 실수로 한 번 눌러 레이드를 나가는 일이 있어서는 안 된다. Escape 는 그대로 취소, 최초
    포커스는 **취소** 버튼으로 옮겼다(스페이스가 위험한 쪽이 아니라 안전한 쪽을 누른다).
  - 디버그 게터: `isAskOpen` · `partyButton` 은 그대로, `askConfirmButton` · `askHoldProgress` 추가.
    스모크는 `.pause-ask-fill` 의 `style.width` 로도 진행도를 읽을 수 있다(분해 스모크와 같은 방식)

- **2026-09-09 (타이틀 개편: 캐릭터 슬롯 3칸 · 생성창 · 3D 미리보기)** — 타이틀이 **워드마크 + 버튼 셋**(`게임 시작` /
  `설정` / `종료`)만 남았고, 그 뒤로 두 화면이 새로 생겼다. 새 파일 다섯: `menus/CharacterSelect.ts` ·
  `menus/CharacterCreate.ts` · `menus/SoldierPreview.ts` · `menus/askPopup.ts` · `menus/enterShip.ts`,
  그리고 새 스타일시트 **`styles/title.css`** (`base.css` 는 건드리지 않았다 — `.menu.title .frame` 은 `.home` 을
  하나 더 얹은 선택자로 덮어쓴다).
  - **콜사인 입력칸이 사라졌다.** 대원 이름은 이제 캐릭터의 것이다 — `progression/ProgressionSystem` 이
    `progress:loaded` 를 받을 때마다 `ctx.net.setPlayerName(profile.name)` 을 부른다 (부팅 방송 · 서버 프로필
    수신 · 캐릭터 초기화가 전부 지나가는 **한** 지점이라 거기가 자리다).
  - **조작 다이어그램 · `키 설정 변경` 이 타이틀을 떠났다.** 둘 다 이미 `menus/SettingsMenu` 의 `키 설정` 구획에
    있었으므로 `SettingsMenu` 는 **고치지 않았다**; 타이틀의 `설정` 버튼이 `HudSystem` 을 통해 같은 오버레이를 연다.
  - **`새 캐릭터로 시작` 이 사라졌다** (`menus/newCharacter.ts` 삭제). 그 일은 선택창에서 채워진 칸의 `삭제` 가 한다 —
    `deleteSlot(id)` 를 직접 부르고, 무엇이 사라지는지(창고 · 장비 · 함선 · 진행도 · 크레딧) 적은 danger 팝업 뒤
    **1초 홀드**(`UI_HOLD_CONFIRM_S`)로만 실행된다.
  - **`Lv. n` 칩(`.lv-chip`)이 사라졌다** — 레벨은 이제 선택창 카드가 그린다.
  - **하위 화면은 blocker 를 갖지 않는다.** phase `menu` 동안 `TitleMenu`(`MenuBase`)가 `'menu'` 토큰과 커서
    소유권을 계속 쥐고, 선택 · 생성은 그 위에 얹힌 화면이다 (`SettingsMenu` 와 같은 규칙). 타이틀 본체는 `.stacked`
    로 **눈에서만** 지워진다.
  - **슬롯 전환은 언제나 새로고침**(`setActiveSlot` + `markAutoStart` + `location.reload()`) — 시스템은 부팅 때
    한 번 저장소를 읽는다. `TitleMenu.bind()` 가 `takeAutoStart()` 를 한 번 소비해 타이틀을 건너뛴다.
  - **초대 링크 흐름은 `menus/enterShip` 한 곳으로 모았다.** 함선에 들어가는 문이 둘(카드 · 자동 시작)이 됐고,
    한쪽에만 붙어 있으면 초대받은 사람이 슬롯을 바꾸는 순간 공유 함선 대신 개인 함선에 떨어진다.
  - **미리보기는 두 번째 GL 컨텍스트**다 (`hub/ui/PlanetHologram` · `player/Portraits` 와 같은 규칙: 자기 렌더러 ·
    씬 · 카메라 · 조명, 닫히면 `render` 가 즉시 반환, `dispose()` 가 전부 놓는다, 컨텍스트를 못 얻으면 null →
    글자 안내). 프레임은 `HudSystem.update` → `TitleMenu.update(dt)` 로 온다.
  - **`HudSystem`**: 타이틀의 `설정` 콜백이 `keybinds.open()` → `settings.open()` 으로 바뀌었고,
    `title.update(dt)` 가 update 루프 끝에 붙었으며, 디버그 게터 `isCharacterSelectOpen` / `isCharacterCreateOpen` 이
    생겼다.
  - **다른 폴더에서 고친 것 (최소 · 국소)**: `player/PlayerSystem` 의 `readonly model` 이
    `new SoldierModel(localAccentColor())` 이 됐다 — 모델은 `init(ctx)` 전에 만들어지므로 `ctx.progression` 대신
    `shared/saveSlot.readSlotCard(activeSlot()).accent` 를 읽는다. **원격 아바타는 그대로 로비 슬롯 색**이다.
    `progression/Profile.migrate` 는 이제 `accent` / `createdAt` / `playedAt` 을 옮겨 담는다 — 옮기지 않으면
    첫 저장에서 사라져 새로고침 한 번에 캐릭터의 색이 기본값으로 되돌아갔다.
- **2026-09-09 (HUD 묶음: 핑 v3 · 화면 밖 화살표 · 한글 IME · 입력 중 말풍선 · 피격 방향 · 아이템 카드)** — `src/ui/` 만
  고쳤다 (계약은 이미 `src/shared` 에 있었다: `PING_MAX_PER_PLAYER` · `PING_AIM_ASSIST_PX` · `PingMessage.seq` ·
  `PingAckMessage` · `ping:acked` · `PlayerFlags.TYPING`). 새 파일 하나 `hud/TypingBubbles.ts`.
  - **`hud/Pings.ts` — 핑 v3.** ① **함선 안에서도 핑이 된다**: 게이트가 `isGameplayActive()` → `isControlActive()` + 포인터
    락. 함선에서는 `ctx.world` 가 없으므로 `ctx.hub.collider.raycast` 로 실내를 쏘고(빗나가면 12 m 앞 `getFloorAt` 높이),
    적 · 상자 · 패드 · 픽업 스냅은 하지 않는다(전부 `ground`). 릴레이는 `ctx.net.lobby` 가 있을 때만(개인 함선은 들을 사람이
    없다); 원격 핑은 gameplay **와** hub 페이즈에서 받고 그 외엔 버린다; `hub:entered` / `hub:left` 가 핑을 전부 지운다.
    ② **플레이어당 3개** (`PING_MAX_PER_PLAYER`): 나와 분대원 각자 3개, 4번째는 그 사람의 가장 오래된 것(`evictFor`)을
    밀어낸다 — "원격 송신자당 1개" 규칙은 사라졌다. ③ **모든 핑이 채팅 한 줄**: `핑 (32m)` · `적 발견 (32m)` ·
    `보급 상자 (n등급) 여기 (32m)` · `탈출 지점 (32m)` · **`<아이템 이름> 여기 있음 (32m)`** (사용자가 "아이템 발견: X" 를
    "여기 있음" 표현으로 바꿨다) · `돌격!` · `주의!`; 원격 핑은 로컬에 채팅을 쓰지 않는다(보낸 쪽 줄이 릴레이로 온다).
    ④ **화면 공간 조준 보정** (`PING_AIM_ASSIST_PX` = 56 px, 일반 핑만): 후보를 화면에 투영해 십자선에서 가장 가까운 것을
    고른다 — 카메라 앞 + 가려지지 않은 것만(`screenDistance`: 프러스텀 + `world.raycast` / `hub.collider.raycast`).
    우선순위 (1) **분대원의 핑** → 확인(ack), (2) 살아 있는 적(가슴 높이), (3) 픽업(`ctx.pickups.getPickups()` — `PickupsRef`
    에 순회 메서드가 있어 `findNear` 에 기대지 않았다), (4) 상자, (5) 탈출 패드; 같은 우선순위면 화면 거리. 아무것도
    없으면 기존의 정확한 레이 경로. ⑤ **확인 핑 "알겠다"**: 분대원 핑을 조준하면 새 핑을 놓지 않고
    `chat:post {text:'알겠다고 확인.', kind:'ping'}` (채팅이 이름을 붙여 모두에게 `<이름>: 알겠다고 확인.`) + `pingack {owner,
    seq}` 를 보낸다. 그 핑을 가진 모든 클라이언트(소유자 peer id + 송신자 로컬 `seq`; 소유자는 자기 `seq` 로 찾는다)가
    확인한 사람의 슬롯 색을 붙인다 — 기본 링 바깥의 얇은 바닥 링(`ackGeo(index)`, 확인자마다 한 칸씩 바깥) + 마커의
    `.pmarker .acks` 점. 같은 사람의 중복은 무시, `ping:acked {id, by, name, slot}` 발행(`by` null = 나). 자기 핑 · `seq`
    없는 옛 핑 · 이미 내가 확인한 핑은 후보가 아니다. 로컬 핑마다 `seq` 를 매기고 `PingMessage.seq` 로 보낸다; 수신 숫자는
    검증한다. `PingView` 에 `acks` 가 추가됐다(지도는 읽기만 한다). ⑥ **탄약 요청 문구** `탄약 필요: <탄종>` —
    `ctx.loot.getEffectiveStats(inst).ammoType` 을 로컬 `AMMO_TYPE_KO` 표로 옮긴다(`items/ItemDefs.AMMO_LABEL_KO` 와 같은
    값; 이 폴더는 `@/shared` 만 import 한다). 클래스 doc 주석이 v3 명세다.
  - **`hud/OffscreenIndicators.ts`** — **내 핑도 가장자리 화살표**를 받는다(`owner === null` 조기 반환 삭제), 화살표는
    핑의 **수명 내내**(`until = ping:placedV2.expires`) 살고 마지막 1.5 s 페이드 · `ping:removed` 제거는 그대로. 화면 안에
    들어오면 화살표 대신 마커가 보인다. `OFFSCREEN_PING_SECONDS` 는 계약에 남아 있으나 여기서 더 읽지 않는다.
  - **`hud/ChatLog.ts` — 한글 IME 버그.** 조합 중 Enter 가 `isComposing` / `keyCode 229` 상태의 keydown 으로 먼저 오고
    `compositionend` 가 뒤따르므로, 그 Enter 에 `send()` 가 칸을 비우면 IME 가 마지막 음절을 도로 넣었다("안녕" 전송 뒤
    "녕" 이 남음). 이제 capture 핸들러가 `e.isComposing || e.keyCode === 229 || composing`(input 의
    `compositionstart`/`compositionend` 창) 동안 Enter · Esc 를 바로 처리하지 않고 Tab 은 포커스만 지킨다. 조합 중의
    Enter 는 **버리지 않고 기억**(`sendAfterCompose`)해 `compositionend` 직후 한 틱 뒤에 `send()` 하므로 한글도 **Enter 한
    번**에 "안녕" 한 줄이 나가고 칸은 비어 있다. 그 외 동작(Enter 유지 · Tab/Esc 닫기)은 그대로다.
  - **`hud/TypingBubbles.ts` (새 파일)** — `PlayerFlags.TYPING` 이 켜진 **원격** 플레이어 머리 위에 어두운 둥근 말풍선
    + 점 세 개(CSS `tbubbleDot`, 0 / 0.15 / 0.3 s 지연, scale 0.6→1.2). `Nameplates` 와 같은 투영(`getHeadPosition` +
    0.7 m = 이름표 0.35 위로 0.35 더), 같은 숨김 규칙(카메라 뒤 · 화면 밖 · 150 m · 끊김 · 강하 · 포드). 함선과 임무 둘
    다. peer 별 풀, `net:remotePlayerRemoved` 제거, `net:lobbyLeft` / `game:abort` / `game:newMission` 초기화.
    `HudSystem` 이 `Nameplates` 바로 다음에 만들고 social 레이어가 보일 때 `lateUpdate` 를 돈다. 스타일
    `.typing-bubbles` / `.tbubble` / `.tbubble i` (`base.css`).
  - **`hud/DamageOverlay.ts`** — 피격 방향 호가 **220 px 링 · 6 px 두께 · 약 70° 빨간 쐐기**(`conic-gradient` 를
    `mask: radial-gradient` 로 링으로 깎고 `drop-shadow` 글로우, 최고 불투명도 0.95, 1.4 s 수명, `rotate(angle)` 유지)
    가 됐다 — 140 px / 3 px `border-top` 호는 전투 중에 읽히지 않았다. 호는 **`ui:damageIndicator` 만** 듣는다:
    `player/parts/Vitals` 가 같은 타격에 `player:damaged {from}` 도 내보내 호가 두 개씩 그려지고 있었다. `player:damaged`
    는 가장자리 플래시만 맡는다.
  - **`hud/ItemTip.ts`** — 카드의 **`크기` 줄 삭제**, **`무게` 가 스탯 표에서 하단 바로**: 바는 왼쪽 `무게 1.2 kg`(`.wt`),
    오른쪽 `가치 1,200 C`(`.val`, 악센트). 줄이 하나도 없으면 스탯 표를 숨긴다. 재화 카드는 그대로 바 · 표 없음,
    희귀도는 부제 줄에 남는다.
  - `npm run typecheck` 통과. 스모크는 리드가 `npm run verify` 로 돈다.

## 2026-09-09 — ESC 닫기 (ui/ 쪽 변경)

- **`hud/KeyGuide.ts`** — 스스로 붙이는 `닫기` 항목이 keycap **두 개**를 갖는다: `keyLabel(Keys.INVENTORY)` 다음에
  `keyLabel(Keys.MENU)`. 첫 keycap 은 Tab 으로 남는다 (튜토리얼의 `.kg-close` 스포트라이트와 스모크가 그 첫
  `.keycap` 을 읽는다). `renderKey` 에 Escape 라벨을 섞어 두어 키를 리바인딩해도 다시 그린다. `.kg-item` 이
  `gap: 6px` 인 flex 라 CSS 변경은 없다.
- **`menus/PauseMenu.ts`** — capture 핸들러가 **데스크톱 셸에서만** Escape 를 Tab 과 똑같이 처리한다
  (`isDesktopShell()` → `resume()`). 브라우저는 그대로 클릭 전용이고, 경고 팝업이 떠 있으면 그 팝업이 Escape 를
  먼저 먹는 예외도 그대로다. 이 핸들러가 capture 라서 `Input` 이 키를 기록하기 전에 삼키므로 `game/escapeKey`
  가 같은 프레임에 메뉴를 다시 열지 않는다.
- **`map/MapScreen.ts` · `hud/Community.ts` · `hud/RescuePicker.ts`** — 열 때 `ctx.escape.push`, 닫을 때
  `remove` (blocker 토큰과 같은 자리, dispose 경로 포함). 구조선 대상 선택은 `cancel()` 을 올린다 (취소 =
  `rescue:selectTarget {peerId:null}`).
- 팝업 계층은 **바뀌지 않았다** — 채팅 · 설정 · 키 바꾸기 · 경고 팝업 · 소셜 우클릭 메뉴 · 개발자 콘솔은 계속
  자기 capture 핸들러에서 Escape 를 삼킨다. 닫기 스택은 그 아래층인 **화면** 만 다룬다.

## 2026-09-09 — 레이드 플레이 개선 (ui/ 쪽): 의사소통 휠 · 핑 홀드 휠 · 환경 재해 · 새 지도 마커

리드가 먼저 커밋한 계약(`9ea3fc0`: `shared/comms.ts` · `hazard:*` · `PingKind` 추가 · `WorldRef.getStructures/
getRailLines/getTrams/hazard` · `EnemyManagerRef.getRogueDrops`) 위에 ui/ 만 얹었다. **`src/shared/*` 는 한 글자도
고치지 않았다.**

### 새 파일

- **`hud/CommsWheel.ts`** — `H` 홀드 의사소통 휠. **ui/ 의 세 휠 중 유일하게 입력까지 스스로 본다**: 의사소통에는
  소유 시스템 폴더가 없고 계약 + 채팅 + 네트워크만으로 완결되기 때문이다 (빠른 사용은 weapons/, 함선 호출은
  stratagems/ 가 키를 보고 ui/ 는 그리기만 한다). 제스처 · 배치 · 문구 채우기 · 송수신 · 채팅 · 토스트가 한 파일에.
- **`hud/PingWheel.ts`** — 지역 핑 홀드의 좌/우 2칸 휠 (순수 표현; 제스처는 `hud/Pings` 가 그대로 본다).
- **`hud/HazardHud.ts`** — 재해 예고 배너 · 남은 안전지대 게이지 · 안전 방향 화살표 · 위험 구역 상시 경고 +
  화면 가장자리 맥동.
- **`hud/RaidAlerts.ts`** — DOM 없는 이벤트 → 토스트 변환기 (새 랜드마크 발견 · 로그 강하 예고).
- **`styles/wheels.css`** · **`styles/hazard.css`** — 위 셋의 스타일 (`title.css` · `rescuePicker.css` 와 같은
  규약: 색 · 여백 · 트랜지션 변수는 전부 `base.css` 의 `:root` 것을 쓰고 여기서 새로 정의하지 않는다).

### 결정과 근거

- **의사소통 휠은 blocker 를 잡지 않는다.** 포인터 락도 풀지 않고 ESC 스택에도 올라가지 않는다 — `QuickWheel` ·
  `StratagemWheel` 과 완전히 같은 성격의 `pointer-events:none` 오버레이다. 카메라만 `setLookLocked(true)` 로 묶고
  (`ctx.player` 를 duck-type 한다 — `PlayerWeaponHost` 를 import 하면 player/ 내부를 보는 셈이다) **우리가 건 락만
  우리가 푼다**.
- **그래서 키 가이드(`ui:keyGuide`)에 올리지 않았다.** 가이드는 맨 위 owner 의 키를 그리고 **`Tab · Esc 닫기` 를
  스스로 붙인다** — 그런데 이 휠은 Tab 으로도 Esc 로도 닫히지 않고 **키를 놓아야** 닫힌다. 올리면 거짓말을 하는
  줄이 하나 생긴다. 형제 휠 둘도 가이드에 없고 안내를 휠 중앙 한 줄이 맡는 이유가 그것이다 — 여기도 중앙에
  `마우스로 선택 · H 놓기` 를 두고 `keyLabel(Keys.COMMS)` 로 리바인딩을 따라간다.
- **채팅 한 줄은 로컬만 쏜다.** `ChatLog` 의 `chat:post` 는 로컬 줄을 쓰면서 그 줄을 분대에 **중계**하므로,
  원격 `comms:sent` 에서도 쏘면 같은 문장이 두 줄이 된다. 그래서 로컬 = `chat:post`(중계가 원격의 줄을 만든다),
  원격 = `ui:notify` 토스트만. 핑 v3 의 콜아웃이 쓰는 규약과 **같다**. 소리는 `chat:message {kind:'request'}` 를
  이미 듣고 있는 audio/ 가 낸다 (`chat_request`) — audio/ 는 건드리지 않았다.
- **전투불능 핑의 아래 드래그(탄약 요청)는 없앴다.** 총을 못 쏘는 사람이 탄약을 부탁할 이유가 없다. 대신 그
  드래그는 **평범한 핑**으로 떨어진다 — 쓰러진 자리를 찍는 것은 여전히 쓸모가 있고, 제스처를 "아무 일도 안 남"
  으로 만들면 눌렀는데 반응이 없는 순간이 생긴다. 휠의 `▼ 탄약` 다리도 그때는 `hidden` 이라 화면이 먼저 설명한다.
- **핑 홀드 휠은 시점을 묶지 않는다.** v2 의 계약이 "방향 핑은 **누른 시점**의 조준 광선을 쓴다 (드래그가 카메라를
  돌리니까)" 이고 평범한 핑은 **놓는 시점**의 광선을 쓴다. 여기서 카메라를 묶으면 그 두 규칙이 다 무너진다.
  그래서 휠은 보이기만 하고 입력 의미는 v2 그대로다.
- **지도의 재해는 안개 위에 그리고 게이트를 걸지 않는다** (사용자 명시 요구). 함선이 궤도에서 관측해 알려 주는
  현상이라 걸어서 밝힌 구역과 상관이 없다. 반대로 구조물 · 선로 · 전차 · 버섯 군락은 **지형지물**이라 `discovered()`
  게이트를 그대로 지킨다.
- **재해 진행도는 `ui:objective` 에 쓰지 않았다.** 그 한 줄은 미션 플로우(`HudSystem` 의 페이즈 핸들러 ·
  `extraction:tick`)가 매초 덮어쓰는 자리라, 재해가 끼어들면 탈출 카운트다운이 지워진다. 별도 위젯(`.hz-prog`)이다.
- **`.ping-hint` 는 `base.css` 에서 삭제했다** — 대체된 죽은 CSS 다. 나침반의 새 마커 세 종과 지도 범례 스와치
  다섯 종은 `base.css` 에 **추가**했다 (기존 `.compass .marker .ico` · `.map-legend-row .sw` 규칙을 덮어써야 해서
  별도 시트로는 로드 순서를 보장할 수 없다).

### 알려진 한계

- `ctx.world.hazard` · `getStructures()` · `getRailLines()` · `getTrams()` · `ctx.enemies.getRogueDrops()` 는 이
  작업 시점에 전부 **stub**(null / 빈 배열)이었다. 그리는 쪽은 계약만 보고 썼으므로 world/ · enemies/ 가 채우면
  그대로 살아나지만, **실제 도형으로 눈으로 확인한 것은 아니다** — 특히 `front` 반평면의 위험한 쪽이 맞는지,
  전차 아이콘의 `yaw` 부호가 맞는지는 world/ 가 채운 뒤 한 번 봐야 한다.
- 로그 강하 예고 토스트는 `rogueDrop:incoming` 을 `dropId` 로 한 번만 띄운다. 강하가 취소되는 경로는 계약에
  없어서 다루지 않았다.
- 구조물 · 선로 · 군락의 **발견 토스트를 ui/ 가 띄운다**. `world/Fog` 의 `TOAST` 표에 같은 종류를 넣으면 두 번
  뜬다 — 그 표에는 넣지 않기로 했다 (신호소 · 둥지는 계속 Fog 가 띄운다).
- 의사소통 휠의 `내 계약` 은 `ctx.meta.activeContract` 하나만 본다 (`CONTRACT_MAX_ACTIVE` = 1). 동시 계약이
  여러 개가 되면 "남은 게 가장 적은 하나" 를 고르는 자리는 `varsFor()` 다.
- `npm run typecheck` 는 ui/ 변경분에 대해 초록이다. 스모크 · `verify` 는 다른 레인과 포트 · GPU 가 겹쳐
  돌리지 않았다 (리드가 마지막에 돈다).
