# Phase 8 — UI/UX pass (2026-09-06)

Contract-first, like Phases 5–7: `src/shared` is already written and committed before any folder work starts.
Every folder implements its own rows below against that contract. **Never edit another folder's files.**

Read `CLAUDE.md` first, then your folder's `README.md`. Update both when you are done.

---

## 0. What the player asked for (verbatim requirements)

1. Tab 화면에서 캐릭터/기업을 별도 팝업이 아니라 **Tab 화면 안**(배경 블러)에서 보이도록.
2. 기업 UI: 탭마다 팝업 크기가 바뀌는 문제 → **고정 크기**, 내용만 교체, 필요하면 수직 스크롤.
3. 캐릭터 팝업의 **상시 수평/수직 스크롤바** 제거.
4. 함선에 있을 때 Tab 메뉴에 **함선 메뉴**(시설 업그레이드)도 표시.
5. 약초 심기를 조종석이 아니라 **온실의 '재배층' 가구**에서. 상호작용 시 팝업이 뜨고 창고의 **씨앗**을 심는다.
   씨앗은 **현실 시간**에 맞춰 자란다.
6. 한 자리에 **재배층 4층까지** 중복 배치.
7. 함선 터미널의 **캐릭터 버튼 제거**.
8. 함선에서 **ESC = 일시정지 메뉴** (터미널이 아님): 타이틀로 / 게임으로 돌아가기 / 설정(키 설정 + 오디오).
9. **승무원 이름 변경 기능 제거** (최초 1회만).
10. 함선 터미널을 **조종석 중앙**으로 (좌측 터미널 제거).
11. 조종석 **정비벤치를 작업실 배치형 가구**로.
12. 요구 아이템 표시를 텍스트가 아니라 **썸네일 + 우측하단 보유/필요**, 부족하면 딤드 + 빨간 보유 수.
13. 함선에서 항상 우측 하단 **함선 관리(M)** 키 힌트. M → 개인 함선 하우징 모드,
    좌측 **방 목록**(클릭 시 카메라 이동), 하단 **가구 카드 목록**(수평 스크롤, 썸네일 아래 재료 썸네일).
    가구 선택 → 설치 상태, **ESC 또는 C 로 취소**.
14. 방/조종석 문을 **자동문**으로 (가까이 가면 열림).
15. **빈 방은 어둡게**, 용도가 있는 방은 라이팅.
16. 인벤토리 **전술 임플란트** → 인벤토리 위에 **모달리스 추가 팝업**.
17. 인벤토리 **필드 제작** → 모달리스 추가 팝업.
18. **아이템 분해**는 제작이 아니라 **우클릭 메뉴 → 모달리스 팝업**(기대 결과 표시).
19. 인벤토리 우상단 `CREDITS 크레딧 500` → `CREDITS 500`.

Answered design questions (do not re-litigate):

- **씨앗 수급**: 레이드 루팅(tier 1–3 컨테이너 / 시체) **+ 기업 상점**. 제작 불가.
- **성장 시간**: 현실 시간 **1–6시간** (일반 1h · 고급 2.5h · 희귀 6h), 원예 스킬로 최대 −35 %.
- **정비벤치 이관**: 기존/신규 프로필 모두 `furn_repair_bench` 1개를 **가구 창고에 무상 지급**.
- **오디오 설정**: **전체 + 효과음** 2단 (BGM 없음; 채널만 남겨둠).

---

## 1. Contract already in `src/shared` (read, do not change)

`src/shared/types.ts`
- `ItemCategory` += `'seed'`; `ItemDef.seed?: SeedDef`; `SeedDef {growHours, yieldDefId, yieldQty}`.
- `EmbeddedView {refresh(), dispose()}` — the handle every embedded tab returns.
- `AudioChannel`, `AudioSettings`, `AudioRef`.

`src/shared/housing.ts`
- `ROOM_PURPOSES_ACTIVE` += `'greenhouse'`; its description no longer says 다음 업데이트.
- `FurnitureModelKind` += `'grow_rack' | 'repair_bench'`; `FurnitureInteraction` += the same two.
- `FurnitureDef.stackLimit?`; `PlacedFurniture.layer?`.
- `GrowPlot`, `GrowPlotInfo`; `ShipState.plots?`, `ShipState.nameLocked?`.
- `FURNITURE_DEFS` += `furn_repair_bench` (작업실, 4×2) and `furn_grow_rack` (온실, 4×2, `stackLimit: 4`).
- `HousingRef` += 함선 관리 (`shipManageMode`, `openShipManage`, `setManageRoom`, `closeShipManage`),
  재배 (`getPlots`, `plantSeed`, `harvestPlot`, `harvestAll`, `getOwnedSeeds`, `openGrowMenu`),
  and `createShipView(host)`.

`src/shared/meta.ts` — `MetaRef.createCorpView(host)`.
`src/shared/progression.ts` — `ProgressionRef.createSheetView(host)`.
`src/shared/net.ts` — `NetRef.serverNow()`.
`src/shared/GameContext.ts` — `ctx.audio: AudioRef | null`.
`src/shared/labels.ts` — `seed` entries in the three category records.

`src/shared/itemChip.ts` (**new**) — `buildItemChip(def, opts)` and
`renderItemCost(host, cost, lookup, owned, opts)`. **This is the only way to render a material requirement from now
on.** It emits `.item-chip` markup; ui/ owns the CSS in `base.css`.

`src/shared/constants.ts` — Phase 8 block: `GROW_PLOTS_PER_RACK` 4, `GROW_RACK_STACK_LIMIT` 4,
`GROW_RACK_LAYER_HEIGHT` 0.8, `GROW_SKILL_SPEEDUP` 0.35, `SEED_GROW_HOURS_BY_RARITY`,
`AUDIO_STORAGE_KEY` / `AUDIO_DEFAULT_MASTER` / `AUDIO_DEFAULT_SFX`,
`DOOR_OPEN_DISTANCE` 3.2, `DOOR_SLIDE_SPEED` 3.0,
`ROOM_LIGHT_POOL` 3, `ROOM_LIGHT_INTENSITY` 11, `ROOM_LIGHT_DISTANCE` 7,
`ROOM_STRIP_DIM` 0.15, `ROOM_STRIP_LIT` 2.2.

New events: `housing:growChanged`, `ui:growToggled`, `housing:shipManageChanged`,
`audio:volumeChanged`, `ui:settingsToggled`, `ui:disassembleToggled`.

---

## 2. Per-folder work

### 2.1 `src/items/` — 씨앗

- Three seed defs, category `'seed'`, 1×1, `stackMax` 5, `weight` 0.05, glyph from `CATEGORY_ICON.seed`:
  - `seed_bloodroot` 혈근초 씨앗 — common, `seed {growHours: 1, yieldDefId: 'herb_bloodroot', yieldQty: 3}`, value 40
  - `seed_ashleaf` 잿빛잎 씨앗 — uncommon, `{2.5, 'herb_ashleaf', 3}`, value 90
  - `seed_glowcap` 발광버섯 씨앗 — rare, `{6, 'herb_glowcap', 2}`, value 220
- Loot: add `'seed'` to the container categories of tiers 1–3 with a modest `categoryWeights` entry, and to the
  `CORPSE_TABLES` of the bug types (they eat plants). **No craft recipe** — seeds are found or bought only.
- No other change. Do **not** touch `Recipes.ts` beyond leaving 원예 recipes as they are.

### 2.2 `src/housing/` — 온실 재배, 함선 관리, 함선 view, 정비벤치 지급

Owner of every new `HousingRef` member.

- **Stacking** (`Rules.ts` `canPlaceAt`): when `def.stackLimit > 1`, a footprint may be shared **only** by pieces of
  the same `defId` at the same `x`/`y`/`yaw`; the stack height must stay `< stackLimit`. Everything else keeps the
  strict no-overlap rule. `place()` assigns the lowest free `layer`; `recover()` may only take the **top** layer
  (otherwise the stack would float) — return false with a 한국어 message otherwise.
- **Plots**: `ShipState.plots`. `plantSeed` looks the seed up through `ctx.loot.getItemDef`, refuses a non-seed,
  consumes 1 via `ctx.inventory.consumeDefAll`, stamps `plantedAt = ctx.net?.serverNow?.() ?? Date.now()` and
  `readyAt = plantedAt + growHours × 3600e3 × (1 − GROW_SKILL_SPEEDUP × 원예/SKILL_LEVEL_MAX)`.
  `harvestPlot` creates `yieldQty × derived.gatherYieldMul` of `yieldDefId`, tries the bag then the stash, emits
  `gather:collected` (so 원예 XP still rises) and `housing:growChanged`. Sanitize drops plots whose rack is gone.
- **Grow panel** `ui/GrowMenu.ts` — a `HousingPanel` subclass: one card per plot (progress ring / 남은 시간 / 수확),
  a seed picker built from `getOwnedSeeds()` using `buildItemChip`, 모두 수확. Emits `ui:growToggled`.
- **함선 관리**: `openShipManage(room?)` enters housing mode **without** the "player stands in the room" gate
  (keep that gate for `enterHousingMode` from the room console), emits `housing:shipManageChanged`;
  `setManageRoom` moves the edit room; `closeShipManage` leaves both.
- **`createShipView(host)`**: the 함선 tab — 시설 rows (generator / storage / workshop / range) with
  `renderItemCost` costs and the derived summary, plus a 방 목록 with purpose pickers. Reuse `FacilityMenu`'s
  renderers; **no blocker, no pointer-lock, no Escape listener**.
- **Cost rendering**: replace `ui/dom.ts` `renderCost` with `renderItemCost` from `@/shared` everywhere
  (`RoomMenu`, `FacilityMenu`, the new views).
- **정비벤치 지급**: bump `SHIP_STATE_VERSION` to 2. `sanitize` on a v1 save (and `freshState`) adds one
  `furn_repair_bench` level 1 to `furnitureStorage`. Idempotent — never grant twice.
- `README.md` + `housing.css` updated.

### 2.3 `src/hub/` — 조종석 재배치, 자동문, 방 조명, 재배층/정비벤치 모델, 함선 관리 카메라

- **Terminal to the cockpit centre**: delete the `-X` wall `consolePedestal` and place the terminal console on the
  centre line in front of the viewport (between the two pilot seats, facing `+Z` so the player reads it walking in).
  Keep the same `hub_terminal` id / radius. Shared ship keeps its bridge terminal.
- **Remove the cockpit workbench**: drop `P.workbench(...)` and `interior.workbench` from `PersonalShip`; the
  personal ship's repair menu now opens from a placed `furn_repair_bench` (`FurnitureInteraction 'repair_bench'` →
  `WorkbenchMenu.open()`). The **shared** ship keeps its built-in bench.
- **Remove the cockpit hydroponics rack** and `GardenStation` entirely (its localStorage key `scav.hub.garden.v1`
  is abandoned; do not migrate). 재배 lives in the 온실 now.
- **New furniture models** in `interiors/Furniture.ts`: `grow_rack` (tray + 4 plot pads + magenta grow strip, front
  −Z) and `repair_bench` (the old `Parts.workbench` silhouette at furniture scale). `FurnitureLayer.addPiece` must
  offset stacked pieces by `layer × GROW_RACK_LAYER_HEIGHT` and register a per-piece interactable that calls
  `ctx.housing.openGrowMenu(uid)` / the repair menu.
- **자동문**: give every room doorway and the cockpit arch a two-leaf sliding slab (merged into the interior batch is
  not possible — they animate, so build them as their own small meshes). Open when the player is within
  `DOOR_OPEN_DISTANCE` of the threshold, `DOOR_SLIDE_SPEED` per second, no collider change (they never block).
- **방 조명**: give each room's wall strips their own material instance and set `emissiveIntensity` to
  `ROOM_STRIP_DIM` when `purpose === 'empty'`, `ROOM_STRIP_LIT` otherwise. Add a **constant** pool of
  `ROOM_LIGHT_POOL` point lights that re-anchor to the nearest non-empty rooms and ramp `intensity` — never toggle
  `visible` (shader recompiles). React to `housing:changed`.
- **함선 관리 camera**: `HousingMode` gains a "manage" entry that does not require the player to be in the room,
  and `setManageRoom` retargets the camera with the existing blend. **C** (`KeyC`) cancels the current selection
  exactly like Escape does today, and Escape leaves manage mode.
- Terminal menu (`ui/HubMenu.ts`): remove the **캐릭터** button and the **승무원 이름** input (show the name as a
  read-only line once `ShipState.nameLocked`; the first run still asks once). Keep everything else.
- Esc in the hub must no longer open the terminal menu — see 2.7.
- `README.md` + `hub.css` updated.

### 2.4 `src/inventory/` — Tab screen host, modeless popups, credits label

- **Screen tabs** become `인벤토리 / 캐릭터 / 기업 / 함선` (함선 only in the hub). Clicking one no longer closes the
  window: it swaps the `.inv-layout` content for a `.inv-screen` host and builds the matching embedded view
  (`ctx.progression.createSheetView` / `ctx.meta.createCorpView` / `ctx.housing.createShipView`), calling
  `refresh()` on show and `dispose()` on leave. The blurred `.inv-root` backdrop is the requested 배경 블러.
  Hide `.scr-tabs` outside hub mode (today it also draws over a crate window — fix that).
- **전술 임플란트** picker → a **modeless** floating panel above the window (`.inv-modeless`), not an inline
  expander: opened by the slot, closed by Escape / outside click, the grid stays interactive behind it.
- **필드 제작** → the same modeless treatment (keep `CraftPanel`'s renderers, change only its shell + placement).
  Bench crafting (`openBenchCraft`) uses the same popup.
- **분해**: remove the `break_ammo_*` rows from the craft list and add a `분해` entry to the item context menu
  (ammo and any item with a matching `break_*` recipe). It opens a modeless dialog that shows the **expected
  result** with `buildItemChip` (input → output, quantities) and a 분해 button. Emit `ui:disassembleToggled`.
- **Craft / repair costs** → `renderItemCost` from `@/shared` (drop the text chips).
- **Credits**: `TEXT.credits.value` becomes `` `${n.toLocaleString('ko-KR')}` `` so the pill reads `CREDITS 500`.
- **씨앗** are just items; make sure the catalog's category tabs include them.
- `README.md` + `inventory.css` updated.

### 2.5 `src/progression/` — embeddable sheet, scrollbar fix

- `createSheetView(host)`: build the existing sheet body into `host`; no blocker / lock / Escape. The standalone
  overlay stays for the `P` shortcut and `ui:statsToggled`; both must share one renderer.
- **Scrollbars**: in `character.css` pull the corner brackets inside
  (`.menu.char-sheet .frame::before {left:0;top:0}` / `::after {right:0;bottom:0}`), add
  `overflow-x: hidden; scrollbar-width: thin;`, and drop `min-width: 820px` to something that fits
  (`min-width: min(820px, 100%)`). Mirror `hub.css:5–13`, which documents this exact trap.
- The embedded variant must not show the `.scr-tabs` pill (the inventory window owns it).
- `README.md` updated.

### 2.6 `src/meta/` — embeddable corp screen, fixed size

- `createCorpView(host)` sharing every renderer with the standalone screen.
- **Fixed size**: give `.corp-page` a fixed `height` (not the `min-height`/`max-height` band) so the frame stops
  resizing per tab; content scrolls vertically inside it (`overflow-y: auto; overflow-x: hidden`). The rows keep
  their current grids. Verify all four tabs on an empty and a full state.
- 상점 / 판매 / 퀘스트 costs and delivery chips → `buildItemChip` / `renderItemCost`.
- `README.md` + `meta.css` updated.

### 2.7 `src/game/` + `src/ui/` — 함선 ESC 일시정지, 설정, M 힌트, 함선 관리 UI, item-chip CSS

**`src/game/`**
- `GameFlowSystem.setPaused` currently bails outside a gameplay phase. Allow the **hub** phase to pause too
  (`freeze` stays false there — the ship keeps animating). Esc in the hub with no blocker opens the pause menu.
- `hub` pause must not emit mission-only side effects (no `game:abort`, no stats).

**`src/ui/`**
- **PauseMenu**: buttons become 게임으로 돌아가기 / 설정 / 타이틀로, plus 함선으로 귀환 **only during a mission**.
  Title text switches to 함선 for the hub variant.
- **SettingsMenu** (`menus/SettingsMenu.ts`, new): two sections — 키 설정 (mount the existing `KeybindMenu` rows or
  open it, your call, but one code path) and 오디오 with 전체 / 효과음 sliders driving `ctx.audio.setVolume` and
  `preview`. Emits `ui:settingsToggled`.
- **함선 관리 hint**: a bottom-right hint in the **social** layer, visible whenever `ctx.isHubPhase()` and no
  blocker, reading `함선 관리` + `keyLabel(Keys.MAP)`; refresh on `input:bindingsChanged`.
- **M in the hub**: `MapScreen` keeps its gameplay-only gate; add the hub binding where the hub input is polled
  (hub/ calls `ctx.housing.openShipManage()`), and the HUD only draws the hint.
- **함선 관리 screen** (`hud/ShipManage.ts`, new, `.hud.housing` layer): left **방 목록** (10 rows, purpose +
  furniture count, click → `ctx.housing.setManageRoom`), bottom **가구 카드 바** (one row, horizontal scroll, each
  card = thumbnail + name + `renderItemCost` material chips + 보유 수), click selects for placement
  (`ctx.housing.selectFurniture`). Driven by `housing:shipManageChanged` / `housing:changed`.
  Update `HousingHint` to mention **C** as a cancel key.
- **`.item-chip` CSS** in `base.css` — the markup contract is in `src/shared/itemChip.ts`; implement
  `--chip-size`, the rarity ring, the bottom-right count, `.is-short` (dimmed chip + red 보유 수), `.is-free`.
- `README.md` updated.

**`src/audio/`**
- Publish `ctx.audio`: `settings`, `setVolume(channel, v)` (ramps `master.gain` / `sfxBus.gain` immediately and
  keeps the pause duck working), `preview(channel)`. Persist to `AUDIO_STORAGE_KEY`, load in `init`.
  Emit `audio:volumeChanged`. Ambience stays on `ambBus` and follows `master` only.

### 2.8 `src/net/`

- Implement `serverNow()` from the existing `NetClient.serverTimeOffset`
  (`performance.now() + serverTimeOffset` normalised to epoch ms; `Date.now()` while disconnected).

---

## 3. Rules that still apply

- Korean UI text. No asset files — procedural geometry only.
- `Keys.X` read at use time, never cached; labels refresh on `input:bindingsChanged`.
- Panels add their blocker token **before** `ctx.input.exitPointerLock()` and re-request the lock on close.
  Embedded views and modeless popups do **neither** — their host window already owns the blocker.
- Constant scene light count; never toggle `light.visible`.
- Dispose geometries / materials you create on `game:abort` / `game:newMission`.

## 4. Verification

`npm run typecheck` after every edit; `npm run verify` for the folders you touched;
`npm run verify:all` before the merge. Record the run in `docs/VERIFICATION.md`.
New/So-updated smokes: `smoke-housing` (stacking, plots, 함선 관리), `smoke-ui-p6` (hint, item chips),
`smoke-controls-hub` (Tab tabs, pause in hub, settings), `smoke-inventory-p6` (modeless popups, 분해),
`smoke-ship-rooms` (doors, lights, terminal position).
