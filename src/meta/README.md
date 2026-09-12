# src/meta — 기업 · 신뢰도 · 계약 · 퀘스트 · 크레딧 · 상점 (`MetaSystem`)

Phase 5-c (2026-09-06, brief `docs/DECISIONS.md` Phase 5). Publishes `ctx.meta` (`MetaRef`, contract in `src/shared/meta.ts`),
persists everything in localStorage `META_STORAGE_KEY` (`scav.meta`), owns the **기업 네트워크** screen (ship computer,
blocker token `'corp'`) and the `credits / rep / contract / quest` developer-console commands. Character XP stays with
`progression/` (`ctx.progression.addXp`), the bag / stash with `inventory/`; this folder only asks them through `ctx.*Ref`.
Registered in `main.ts` right after `InventorySystem` (buy / sell / deliveries need the bag + stash) — see the root `CLAUDE.md`.
**Phase 8** (2026-09-06, brief `docs/DECISIONS.md` Phase 8): the screen body moved to `ui/CorpView.ts` so the standalone overlay and the
**embedded 기업 tab** of the inventory Tab screen (`createCorpView(host)` → `EmbeddedView`) share one set of renderers; the popup has a fixed
size (no more per-tab resizing) and every item requirement is a `buildItemChip` / `renderItemCost` thumbnail.

| File | Purpose |
|---|---|
| `MetaSystem.ts` | `GameSystem` (`name: 'meta'`) + `MetaRef`. Bus subscriptions for contract goals, `meta` net message (squad share), `settleMission`, shop buy / sell, quests, corp-screen open / close, console commands, save on `hub:entered` and after every change. Phase 7: server credits (`addCredits` = optimistic local apply + `credits:tx`, `serverTx` adopts / reverts), `buy` = `canFit` → debit → item (async completion → `meta:purchase`, failure → `lastPurchaseFailure` / `onPurchaseFailed`), `net:profileLoaded` (replace / migrate), training gating. Phase 8: `createCorpView(host)` (embedded 기업 tab, tracked in a `views` set whose message timers tick with `update()`), `onPurchaseFailure(fn)` fan-out, public `countAll(defId)`. **Phase 12** (2026-09-08): the 임플란트 수리 desk API — `getRepairableImplants()` / `getImplantRepair(uid)` (`ImplantRepairInfo`: inst · broken · target · cost with `have` · fee · `blocked`), `repairImplant(uid)` (fee through the purchase path: local debit offline, optimistic debit + `credits:tx` then the swap only on `ok`; `performRepair` re-validates, takes the broken implant, `consumeDefAll` each material, `createItem(repairsTo)` → `tryAddToStash` then anywhere, full undo + refund on any failure), `onImplantRepaired(fn)` / `isRepairPending(uid)`, `ui:notify` `임플란트 수리 완료 — <name>`, console `implant list|repair <uid|first>`. `priceOf` / `getShop` hand `implantRepairMaterialIds` to the shop rules. Folder-internal — `MetaRef` is frozen for the batch. |
| `model.ts` | 폴더 공용 어휘 — `MetaSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `MetaSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Trade.ts` | **기업 상점: 구매 · 판매 · 가격**. 신뢰도가 무엇을 팔지 정하고(`getShop`), 크레딧은 릴레이가 있으면 **서버 트랜잭션**이다: 낙관적으로 차감 → `credits:tx` → `ok` 에서 아이템 지급, 실패하면 전액 되돌림. 오프라인이면 같은 검사를 로컬에서 미리 하고 끝낸다. |
| `parts/Contracts.ts` | **계약 · 퀘스트**. 계약은 하나만 활성이고 목표 카운터가 버스 이벤트(`enemy:killed` / `crate:open` / …)에서 오른다. 분대원의 진척은 `meta contractHit` 로 공유되고, 레이드가 끝나면 `settleMission` 이 `outcome` 에 따라 정산한다. 퀘스트는 가방 + 창고에서 납품받는 사슬이다. **훈련장에서는 아무것도 세지 않는다.** |
| `parts/Credits.ts` | **크레딧 · 신뢰도 · 서버 프로필**. 크레딧 잔액의 유일한 소유자. 릴레이가 있으면 서버가 진실이고(`serverTx`), 없으면 localStorage 다. `net:profileLoaded` 에서 서버 값을 받아들이는 규칙(`adoptServerCredits`)도 여기 있다. 분대 중계(`meta` · `metaq`)의 검증 — 로비 멤버 · 킬 목표 무시 · 토큰 버킷 · `rid` 짝맞춤 — 도 여기다 (2026-09-11 E-4). |
| `parts/ImplantDesk.ts` | **세레스 바이오 임플란트 수리 데스크** (Phase 12). 레이드에서는 **망가진 임플란트만** 나온다. 여기서 재료 + 수수료를 내고 고치면 쓸 수 있는 물건이 된다. 크레딧 경로는 구매와 완전히 같고(서버 트랜잭션 / 오프라인 분기), 실패하면 재료까지 전액 되돌린다. |
| `parts/Console.ts` | 개발자 콘솔 명령 `credits` / `rep` / `contract` / `quest` / `implant`. dev 클라이언트에서만 등록된다(`src/console` 참고). 게임 규칙은 하나도 갖지 않고 위의 API 만 부른다. |
| `Storage.ts` | `MetaSave` v1: `freshMetaSave()`, `sanitizeMetaSave()` (clamped credits, known corp / quest / contract ids only, only `accepted` / `complete` quest states kept), `MetaStorage` (load, 350 ms debounced `markDirty()`, `flush()` on `pagehide` / hub entry / dispose, every storage access in try/catch). Phase 7: `flush()` = `writeCache()` (localStorage) + `upload()` (`ctx.net.profile.set('meta', snapshot())`); `replace(doc)` adopts a server document without echoing it back. **Phase 9**: `upload()` dropped its `available` guard — the document is handed to `ProfileSync` offline too (stamped + queued, newest wins on the next connection) — and `MAX_PROGRESS` is exported so live hits clamp to the same ceiling as a load. |
| `Rules.ts` | Pure functions, no ctx / DOM: `repInfoOf`, shop filter (`ruleMatches` / `corpSells` / `shopRarityCap` / `buildShop` sorted by category → rarity → price, `fits` → 공간 없음), `killGoalOf`, `contractBlockReason`, `contractHitDelta` (Phase 9: a non-finite `amount` is 0, not `NaN`), `settleContract` (fills `outcome`), `questStateOf`, `questBlockReason`, the 한국어 `REASON` strings. `rarityRank` / `RARITY_ORDER` come from `@/shared` (`labels.ts`) since Phase 7. **Phase 12**: `ruleMatches` honours `ShopRule.maxRarity`, never sells a broken implant, and resolves an `implantRepairMaterials` rule against `implantRepairMaterialIds(defs)`; `CATEGORY_SORT` gained `implant / seed / book`; pure repair rules `IMPLANT_REPAIR_FEE` (150 × grade, grade = rarity rank + 1 of the **repaired** def), `implantGrade` / `implantRepairFee` / `isRepairableImplantDef` / `implantRepairCost` / `canRepairImplant(ImplantRepairCheck)` (reason order 아이템 → 함선 → 크레딧 → 재료 → 공간), `REASON.notBroken / noTarget / materials`. |
| `ui/CorpView.ts` | **(2026-09-12 2차)** 좌 `.corp-rail` 은 이제 `.corp-shell` **밖의 독립 카드**다 — 호스트 격자의 첫 칸에서 **세로 중앙**에 뜨고 메인 패널(`.corp-shell` → `.corp-page`)과 `--corp-rail-gap` 만큼 떨어져 각자 배경 · 테두리를 갖는다. `기업` 제목 줄은 없다. **퀘스트**: 목록 우측 상단 `완료된 항목 보기` 체크박스(기본 켜짐 · 화면이 열려 있는 동안만, `showDoneQuests`), 완료는 **딤드 + 맨 아래**(정렬은 `renderQuests` 의 안정 분할 — `parts/Contracts.getQuests()` 의 순서는 그대로다), 보상 줄(`.cq-rewards`)은 목록 열이 아니라 **납품 패널 바로 아래**. **임플란트**: 좌 한 열에 망가진 임플란트 격자 + 수리 카드, 우에 `makeGrids()` 의 **가방 + 함선 창고**(드롭 대상이 없으므로 `dropSelector` · `onTake` 없이 읽기 전용). 거래 · 퀘스트 · 임플란트 세 화면의 우측 격자 열 폭은 `--cv-inv-w` 하나다. 아래는 그 이전 기록. **(2026-09-12 기준)** 좌 `.corp-rail` 은 **트리** — 기업 버튼들 사이로 가지 하나(`.corp-branch` = 신뢰도 게이지 + 거래 / 계약 / 퀘스트 / 임플란트 탭)가 선택한 기업 바로 아래로 옮겨 다니고(`aria-expanded`), 크레딧 표시는 없다. 거래칸의 모든 칸(기업 판매 물품 · 구매 / 판매 트레이 · 임플란트 데스크)은 `InventoryRef.buildItemTile` 의 **인벤토리 타일**을 `ui/TileGrid` 에 채운 것이라 가방 / 창고와 같은 모양이고 `data-item-tip` 으로 호버 카드가 뜬다. 구매 트레이 우측 상단 › ×3 · 판매 트레이 좌측 상단 ‹ ×3 (`dom.chevrons`), 거래 후 크레딧은 라벨 없이 가운데(+ 초록 ▲ 오른쪽 / − 빨강 ▼ 왼쪽 / 0 은 화살표 없음), **거래 성사는 1초 홀드**(`UI_HOLD_CONFIRM_S` — 게이지는 rAF, 확정은 타이머; 클릭 · Enter 는 안내만). 진행 중인 계약 패널 · 행의 `--cc` 는 그 계약 기업의 색. 클래스 접두사는 `.cv-`. 아래는 그 이전 기록. **(2026-09-09 기준)** The screen **body**. 좌 `.corp-rail` 한 열(기업 목록 → 신뢰도 게이지 → 페이지 탭 → 크레딧) + 우 `.corp-page`(세로 전부). 계약 보상 · 퀘스트 보상은 `@/shared/currency` 의 **재화 칩**이고 퀘스트 목록 행은 이름 + 상태 배지뿐이다. 아래는 그 이전 기록. **(Phase 8)** The screen **body**, shared by both shells: header 기업 네트워크 + credit readout, 4 corp tabs (`CorpDef.color` accent, `Lv.n`), banner (slogan, description, rep bar `rep / next`), sub-tabs 상점 / 판매 / 계약 / 퀘스트, rows with 구매 / 판매 / 수락 / 포기 / 납품 buttons (disabled + tooltip from `blocked`), `귀중품 전부 판매`, `.form-msg` in a reserved slot. Renders into whatever host it is given and marks it `.corp-view` (`.is-embedded` for the inventory tab). Item thumbnails / 납품 requirements use `buildItemChip` / `renderItemCost` (`@/shared/itemChip`). Purchase messages come from `meta:purchase` (`구매 처리 중…` while a server transaction is pending) and refusals from `MetaSystem.onPurchaseFailure(fn)`. **No blocker, no pointer-lock, no window listener** — those belong to the shell. **Phase 12**: a fourth vertical page **임플란트** (`CorpPage 'implants'`, `PAGES[].corp = 'ceres'` → `pagesFor(corp)`; the button is `hidden` for every other corp and `setCorp` falls back to 거래): left `.ci-list` grid of broken implants (`.ct-cell.broken[data-uid]`, fee badge, `.is-sel`), right `.ci-repair` card — broken → result chips, `renderItemCost` material chips, `.ci-fee`, `.ci-block` reason + `.ci-repair-btn` 수리; results arrive through `meta.onImplantRepaired`. |
| ~~`ui/CorpMenu.ts`~~ | **Deleted 2026-09-07.** The standalone overlay `.menu.corp-menu` (and with it the `'corp'` blocker, the capture-phase Esc and the cursor ownership) is gone: the 기업 screen is the Tab window's 기업 tab, opened through `ctx.inventory.openScreen('corp')`. `CorpPage` is exported from `ui/CorpView.ts`. |
| `ui/TileGrid.ts` | **(2026-09-12)** 기업 화면의 **채움식 아이템 격자**. 호출부가 만든 타일(`InventoryRef.buildItemTile`)과 발자국을 받아 인벤토리의 `.inv-grid > .inv-cells + .inv-tiles` 마크업 위에 줄 우선 first-fit(`packFootprints`)으로 `transform` 배치한다. 열 수는 고정(트레이 5) 또는 스크롤 상자 폭에 맞춘다(`minCols`), 빈 줄은 상자 높이까지 채우고, 비었을 때 사유를 가운데 띄운다. `ResizeObserver`(한 프레임 미룸)로 다시 배치. 리스너는 호출부 몫. |
| `ui/HoldAsk.ts` | **(2026-09-12, E2)** 기업 화면의 **한 번 더 확인** 팝업 — 지금은 즐겨찾기 아이템 판매 하나에 쓴다. `ui/menus/askPopup` 과 같은 규약(확인 = `UI_HOLD_CONFIRM_S` 홀드 · 게이지 rAF · 확정 타이머, 클릭 · Enter · Space 는 삼킨다, 일찍 떼면 안내 줄이 번쩍인다, 최초 포커스 `취소`)이지만 폴더끼리 import 하지 않으므로 meta 가 따로 갖는다. **Escape = 취소**는 `ctx.escape` 토큰 `meta:holdAsk` 로 — Tab 창보다 위라 먼저 닫힌다. 뒤판 빈 곳 = 취소. `ctx.uiRoot` 바로 아래에 붙는다(창의 transform 이 `position: fixed` 를 가두지 않게). blocker · 커서 소유 없음. 스타일 `meta.css` 의 `.cv-ask*`. `isOpen` / `holdProgress`. |
| `ui/dom.ts` | `el / setText / toggleClass / fmtNum` helpers + **`chevrons(dir, count)`** (2026-09-12 — 겹친 셰브런 인라인 SVG, 흐름 애니메이션용 `c0…` 클래스) (other folders' helpers are internal to them). `fmtNum` is for **non-credit** numbers only (신뢰도, 목표 진척, 납품 수량) — every credit readout goes through `formatCredits` (`@/shared`). |
| `meta.css` | **2026-09-12 2차**: 호스트(`.corp-view`)가 격자다 — `var(--corp-rail-w) minmax(0,1fr)` × `minmax(--corp-page-min,1fr) auto`, 첫 칸이 **기업 카드**(`align-self: center` · 자기 배경 · 테두리 · 그림자), 둘째 칸이 **메인 패널**(`.corp-shell`, 자기 배경 · 테두리), 아래 전 폭이 `.corp-msg-slot`. 900 px 아래는 세로로 접는다. `--cv-inv-w`(창고 10칸)가 `.corp-view` 로 올라가 `.cv` · `.cq` · `.ci` 가 같은 값을 쓴다. 셰브런은 **정적**(`cv-chev-flow` 키프레임 · 스태거 삭제), `.corp-row.st-complete` 는 딤드, `.cq-head` · `.cv-check` 체크박스, `.cq-col.detail .cq-rewards` 는 납품 패널에 이어 붙고(`border-top: 0`), `.ci-col.desk` 는 4행 격자 · `.ci-col.inv` 는 창고 열. 아래는 그 이전 기록. **2026-09-12: 클래스 접두사 `.cv-`** (예전 `.ct-*` 는 housing.css 배양조와 이름이 겹쳤다), 트리 `.corp-branch`, 타일 격자 `.cv-scroll / .cv-grid / .cv-tile`, 거래 열 `shop | tray | inv(창고 10칸 폭)` 과 `max-width 1500` 접힘(판매 물품 위 · 거래칸 아래, 트레이 나란히) · `1240` 에서 가방 열 숨김, `.cv-chev` · `.cv-total` · `.cv-confirm-fill`. Corp-screen styles on top of `.menu .frame .ui-btn .form-msg` (`ui/styles/base.css`) and `.hub-head .hub-foot` (`hub/hub.css`); `--cc` = selected corp colour, `--corp-rail-w` = the 기업 열 width, `--corp-page-min` = the page's **floor** on a short viewport (2026-09-09: the height itself comes from `.inv-screen.corp-view { height: calc(100vh - 130px) }`, so the page fills the window — the old fixed `--corp-page-h` band is gone). `.item-chip*` / `.currency-chip*` are ui's (`base.css`). **Phase 12**: `.ci*` — the 임플란트 desk (two columns, selected cell accent, repair card). |
| `index.ts` | Barrel. |

## Rules (all numbers from `src/shared/meta.ts`)
- **Credits**: start `CREDITS_INITIAL` 500, cap `CREDITS_MAX`; `addCredits(delta)` refuses (false, no change) below 0 → `meta:creditsChanged`.
  **Server-owned since Phase 7** whenever `ctx.net.profile.available`: the local apply is optimistic, then `profile.addCredits(delta, reason)`
  (`credits:tx`) runs and its answer **overwrites** the balance (`meta:creditsChanged {reason: 'server:<reason>'}` when it differs); a refusal
  reverts the delta (`revert:<reason>`); a dead socket keeps the local value (offline fallback, resynced on the next `net:profileLoaded`).
  `hasPendingTx` = transactions in flight. Offline (no relay / single-player) nothing changes from Phase 5.
- **Reputation**: cumulative per corp, `repLevelOf` over `REP_TABLE`, never below 0 → `meta:repChanged {levelUp}`.
- **Shop** (`getShop / priceOf / buy`): opens at `SHOP_UNLOCK_REP_LEVEL` 1. `ctx.loot.getAllItemDefs()` filtered by the corp's `ShopRule`s — same
  `category`; weapons by `WeaponDef.weaponClass`, **uniques never**; ammo by `ammoType`; bags by `BagDef.tactical`; `minRepLevel` hides a rule; rarity ≤
  `SHOP_RARITY_CAP_BY_REP[level]` (bags +`SHOP_BAG_RARITY_BONUS`); `value > 0`. Price `buyPriceOf(value, level)`. `blocked` in order: 함선에서만 가능 /
  크레딧 부족 / **공간 없음** (`inventory.canFit(defId)` null — pre-checked before the click; a missing `canFit` counts as "fits").
  **`buy` (Phase 7)** stays synchronous and answers *was the request accepted*: ship → on the shelf → `canFit` → credits. Offline: debit →
  `loot.createItem` → `inventory.tryAddItemAnywhere` (bag, else stash) → `meta:purchase {placed}` right away (a placement failure after the
  pre-check still refunds defensively). With a server profile: optimistic debit → `profile.addCredits(−price, 'buy:<def>')` → only an `ok`
  answer creates + places the item (placement failure → local refund + `addCredits(+price, 'refund:<def>')` on the server) → `meta:purchase`;
  a refusal reverts the balance and reports through `lastPurchaseFailure` / `onPurchaseFailed` (folder-internal, the corp screen listens).
  The corp screen refreshes on `meta:purchase`, never on the return value of `buy()`.
- **Sale** (`getSellable / sellPriceOf / sell`): bag + stash items with a value, equipped gear excluded; `sellPriceOf(value, qty)` =
  **`floor`**(value × `SELL_PRICE_MUL` 0.5 × qty);
  `sell` = ship only → `inventory.takeItem(uid, qty)` (stub → false) → credits for the units actually removed → `meta:sale`.
  2026-09-11 (E-4): the server transaction is `sell:<def>:<qty>` (one per `stackMax` chunk); a relay refusal reverts the credits **and puts the
  units back** (same uid when the whole stack left, stash first when it came from there) with a `ui:notify` warning.
  2026-09-11 (E-9): the formula itself lives in `shared/credits.sellPriceFrom` (the relay imports that file and cannot run the csv loader);
  `shared/meta.sellPriceOf` only passes `SELL_PRICE_MUL` in. It **floors** so a split stack can never out-earn the bundle, which means a
  value-1 single is worth **0 C** — the desk shows `0` and sells it anyway (사용자 결정). A 0 C chunk skips its `credits:tx` entirely
  (`server/Economy.ts` demands `0 < delta`, so sending it would come back refused and `restoreSold` would undo a sale the player made).
- **Credit reasons (2026-09-11, E-4)**: every `credits:tx` reason comes from `formatCreditReason` (`src/shared/credits.ts`) — the relay parses it
  and checks the amount against `server/economy.gen.json`; a malformed / wrong-amount transaction answers `CREDIT_TX_INVALID_KO` and is reverted.
- **Contracts**: one active (`CONTRACT_MAX_ACTIVE`), accepted in the ship at `minRepLevel` → `meta:contractAccepted`; `abandonContract` drops it
  (progress lost). Progress from bus events **only during a gameplay phase**: `enemy:killed` (`rogue | rogue_boss` → `kill_rogues`, else `kill_bugs`),
  `crate:open` → `open_crates`, `inventory:containerOpened {corpse:…, first}` → `loot_corpses` (fallback `crate:looted` on a `corpse:` id until that
  event exists, deduped per mission), `stratagem:called` with `caller` null / the local peer → `use_stratagems`; `inventory:changed.totalValue` mirrors
  `extract_with_value` live for the HUD. Every local hit with a matching contract → `meta:contractProgress` + in multiplayer
  `net.send({t:'meta', ev:'contractHit', corp, goal, amount}, 'others')`; an incoming `meta` message counts `amount × CONTRACT_SQUAD_SHARE` when the
  local contract is of the same corp (gameplay only). `reportContractHit` itself is not phase-gated (console / smoke).
  **Phase 9 — validation + late-join catch-up**: an incoming `meta contractHit` is dropped unless its `corp` and `goal` are on the `CORP_IDS` / `GOAL_IDS` whitelists and its `amount` is finite in `1..META_HIT_MAX` (a real hit is 1); the resulting progress is clamped to `MAX_PROGRESS`, and the emitted `delta` is the *applied* difference, not the requested one. A client that **rejoins** a running raid (`net:gameStarting {rejoin:true}`) sends `metaq sync` to `'others'` on its `world:ready`; every peer answers **once per requester per mission** (`syncAnswered`) with the hits it has broadcast so far (`sentHits`, per goal, reset at `game:newMission`) as `meta sync {corp, hits}` unicast, capped by the contract's `target`. The requester feeds each entry through `reportContractHit(goal, n, false)`, so a caught-up hit is worth the same `CONTRACT_SQUAD_SHARE` as a live one.
- **Settlement** (`settleMission(stats)`, called by `game/GameFlowSystem.awardMissionXp` before `game:complete` / `game:over`): `extract_with_value`
  reads `stats.lootValue`; **success = extracted ∧ progress ≥ target** → rep + credits paid here, **XP is not** (GameFlow adds `settlement.xp` to its
  `addXp`), contract cleared; extracted but short → progress kept; death → progress back to the value at `game:newMission`. Emits `meta:contractSettled`.
  Phase 7: `settlement.outcome` = `'success'` / `'incomplete'` (extracted, short) / `'failed'` (raid failed) — ui words 미완 / 실패 from it;
  `stats.mode === 'training'` → **null** (the 시뮬레이션 훈련장 settles nothing, no event). Goal counters, the live loot readout and relayed
  `meta contractHit` messages are ignored while `ctx.isTraining()`.
- **Item contracts (2026-09-12, E2 — `extract_with_items`)**: `ContractDef.itemDefId` × `target` **on the body** at settlement — bag grid
  + quick slots + pouch (`InventoryRef.countWhere`, `MetaSystem.carriedCount(defId)`), never the 함선 창고 (사용자 결정 "가방에 담고 탈출" 의
  해석: 퀵슬롯과 주머니도 가방 공간이다 — 루트 CLAUDE.md 「퀵슬롯은 가방 격자가 아니다」 의 무게 · `countWhere` 쪽). `settleMission` counts
  the body itself and hands it to `Rules.settleContract(…, carried)` — `game/parts/Death.complete` settles **before** `game:complete`, so the
  bag still holds what came out of the raid (nothing moves it to the stash until the player does). Same three outcomes as every contract
  (`success` / `incomplete` / `failed`). Live progress (`Contracts.trackItemCount`, raid only, never in the 훈련장) follows
  `inventory:changed` · `inventory:quickSlotsChanged` · `game:phaseChanged` and feeds the HUD + the squad row (`broadcastContract`).
  **No hits**: `model.INVENTORY_GOALS` makes `reportContractHit` a no-op for it and `Credits.onMetaMessage` drops a relayed `contractHit` /
  `sync` entry for it (nobody legitimately sends one). The 계약 row draws the item chip (`buildItemChip`, have = carried now / need = target)
  + the item name; the bar and `아이템 회수 n / t` use the same carried count (the 기업 screen only opens in the ship).
- **Quests**: `locked / available` recomputed from `QuestDef.requires` (rep level + prerequisite quests complete); `accepted / complete` in the save.
  `acceptQuest` ship only → `meta:questChanged`. `completeQuest` ship only: deliveries counted with `inventory.countDefAll` (bag + stash); **reward
  items are placed first** (`tryAddItemAnywhere`, stack-split by `stackMax`) — if one does not fit the placed ones are taken back and the quest reports
  `blocked: 공간 없음`, nothing consumed; then `consumeDefAll`, credits, rep, `progression.addXp` → `meta:questChanged {complete}`.
- **Corp screen**: `openCorpMenu(corp?)` (refused while `isRaidActive()`), `closeCorpMenu`, `isMenuOpen`. Emits `ui:corpToggled {open, corp}` and
  `audio:play ui_click / ui_equip / ui_deny / ui_close`. No `ui:notify` from this folder — toasts belong to `ui/` and listen to the `meta:*` events.
- **Embedded 기업 tab (Phase 8)**: `createCorpView(host)` builds the **same** `CorpView` body inside the inventory Tab screen's host and returns an
  `EmbeddedView {refresh, dispose}`. It adds **no `'corp'` blocker, never touches the cursor mode / pointer lock and installs no window Escape listener** — the
  inventory window owns all three; `dispose()` removes only the nodes / listeners the view added (never the host). Several views may live at once, so
  async purchase refusals are broadcast through `MetaSystem.onPurchaseFailure(fn)` (the legacy single-slot `onPurchaseFailed` still fires first).
- **Page height (2026-09-09, was the Phase 8 fixed band)**: `.inv-screen.corp-view` takes a **definite** `height`
  (`calc(100vh - 130px)`, the same number `.inv-screen` already had as its `max-height`), so `.corp-page` is simply the second
  cell of the `.corp-shell` grid and every column inside it stretches to the window. `--corp-page-min` is only a floor for a
  short viewport. The `.form-msg` still sits in a reserved `.corp-msg-slot`, so switching 거래 / 계약 / 퀘스트 / 임플란트, an
  empty ↔ full list or hiding 귀중품 전부 담기 never resizes the frame. Rows scroll inside each column
  (`overflow-y: auto; overflow-x: hidden; scrollbar-width: thin`).
- **Item chips (Phase 8)**: 상점 / 판매 rows show the item through `buildItemChip` (`.thumb` cell; sell rows carry the stack `×qty`, shop rows the owned
  count when non-zero), 퀘스트 납품 uses `renderItemCost` (썸네일 + 보유/필요, `is-short` → dimmed chip + red 보유 number) and quest reward items are
  `buildItemChip(..., {need: qty})`. No plain-text material runs remain in this folder.
- **Persistence**: every mutation `markDirty()`; `save()` flushes; `resetMeta()` wipes to a fresh save (emits `meta:loaded` / `creditsChanged` / `repChanged`).
  **Server profile (Phase 7)**: every flush also `profile.set('meta', save)`. `net:profileLoaded` → the server `meta` document (when present)
  replaces the save (`MetaStorage.replace`, sanitised, cached to localStorage, not re-uploaded) and the balance is `profile.credits`
  (server wins over the document's stale figure); no document → the local save is uploaded; `migrated` (server had no balance) → the local
  balance is uploaded once with `addCredits(local, 'migrate')`. Re-emits `meta:loaded`, `meta:creditsChanged {reason:'profile'}` and one
  `meta:repChanged` per corp whose rep moved.
- **Console** (dev clients, registered on the first `update()` once `ctx.console.enabled`): `credits <±n>`, `rep <helix|bastion|nomad|ceres|한국어> <±n>`,
  `contract list|accept <id>|abandon|hit <goal> <n>`, `quest list|accept <id>|complete <id>` (with completions).

## Events
| Emits | When |
|---|---|
| `meta:loaded {credits}` | `init` (before other listeners exist — read `ctx.meta.credits` instead) and `resetMeta` |
| `meta:creditsChanged {credits, delta, reason}` | every successful `addCredits` (buy / sell / contract / quest / console / refund) |
| `meta:repChanged {corp, rep, level, delta, levelUp}` | `addRep` with a non-zero change |
| `meta:contractAccepted / contractAbandoned {id, corp}` | accept / abandon |
| `meta:contractProgress {id, corp, goal, progress, target, delta}` | local or relayed hit on the matching goal; live loot value |
| `meta:contractSettled (ContractSettlement)` | `settleMission` |
| `meta:questChanged {id, corp, state}` | accept (`accepted`) / deliver (`complete`) |
| `meta:purchase {corp, defId, price, placed}` · `meta:sale {defId, qty, credits}` | shop (`purchase` fires after the server answer when credits are server-owned) |
| `ui:corpToggled {open, corp}` | corp screen open / close |

Listens: `game:newMission` (progress snapshot, per-mission dedupe reset), `hub:entered` (flush), `net:profileLoaded`, `enemy:killed`, `crate:open`, `crate:looted`,
`inventory:containerOpened`, `stratagem:called`, `inventory:changed`, net `meta`. The menu refreshes on every `meta:*`, `inventory:changed`,
`inventory:stashChanged`, `loadout:changed`.

## Verification
`node scripts/smoke-meta.mjs [url]` (registered in `scripts/verify.mjs` for `meta / inventory / hub / ui / game`): fresh save → rep → shop
filter / prices → buy + refusal → **`canFit` 공간 없음 pre-check** → **server credits through a fake `ctx.net.profile`** (optimistic debit,
`meta:purchase` after the answer, refusal revert, `addCredits` tx, `profile.set('meta')`, `net:profileLoaded` replace + migrate) → sell →
contract gating → real kill progress in a mission → death settlement (`outcome 'failed'`) → **training null + `'incomplete'` + goal counters off
while `isTraining()`** → success (`'success'`) → squad share → quest h1 → reload persistence → corrupt-save sanitising → corp-screen DOM /
blocker / tabs / Esc. **2026-09-11 (E-9)**: 판매 반올림 — 묶음 판매가 = `floor(value × 0.5 × qty)` (경량탄 40 · 중량탄 37 · 준중량탄 50),
낱개 × qty ≤ 묶음이고 **어떤 2분할도** 묶음을 넘지 못한다, 가치 1 한 개 = 0 C, 그 0 C 판매가 성사되고(크레딧 그대로 · 판 1발만 빠짐 ·
`meta:sale {credits 0}`) 서버 크레딧에서도 `credits:tx` 를 보내지 않는다, 거래대 판매칸에 0 C 줄이 담기고 가격 배지가 `0`. **120 / 120** on 2026-09-06 (Phase 7, private vite 5307), 0 console errors. The script parks the relay socket so a relay
on 8787 cannot hand the page a real profile mid-run. `npm run typecheck` clean for this folder.

## Known gaps
- `getSellable` lists the whole bag + stash; there is no per-unit partial sale in the UI (stacks sell whole, `sell(uid, qty)` supports it).
- Relayed contract hits are validated by shape only (whitelists + `1..META_HIT_MAX` + progress clamp, Phase 9) — never against the sender's position, weapon or line of sight; a peer that lies within those bounds is believed. The Phase 9 `metaq sync` catch-up hands a late joiner the hits each peer **broadcast itself**, so hits a peer received from a third party are not forwarded (no double counting, but a joiner can still miss the share of a member that has since left), and each peer answers a given requester only once per mission.
- A purchase whose server answer never arrives (socket dropped mid-transaction) delivers the item on the local debit; the balance is corrected on the next `net:profileLoaded`.
- The corp screen has no keyboard navigation beyond Esc. (Item tooltips: every desk tile and chip raises the shared `ui/hud/ItemTip` card — the 2026-09-12 fix; before it the stock cells showed none.)
- `.inv-screen.corp-view`'s `height: calc(100vh - 130px)` repeats a number that belongs to `inventory/`'s own `.inv-screen`
  (`max-height`). If the Tab window ever changes its chrome, the two have to move together — meta/ cannot read it.
- 2026-09-12: the 기업 열's `크레딧` readout is gone (사용자 결정) — the Tab window's `CREDITS` pill top-right is the only balance.
- The desk needs about 1500 px of window for its three columns; below that it folds (stock over trays, trays side by side) and
  below 1240 px the 가방 / 창고 column is hidden, so selling needs a wider window there (unchanged from before).
  2026-09-12 2차: 퀘스트에 이어 **임플란트**도 1240 px 아래에서 그 열을 숨긴다 — 세 화면이 같은 규칙이다.
- 2026-09-12 2차: 기업 카드는 세로 중앙 고정이라 기업 넷 + 가지가 창보다 길면 **카드 자신이 스크롤**한다(`max-height: 100%`).
  900 px 아래에서만 위로 접히고 `align-self: stretch` 로 돌아간다.
- `.item-chip*` styling is ui's (`ui/styles/base.css`); until that lands the chips render as bare glyph + count.

## Phase 9 UI pass (2026-09-07) — the trading desk

`ui/CorpView.ts` was rebuilt around a Tarkov-style desk (both shells still share it):

- **header** — a compact **기업 패널** (name + 신뢰도 bar) top-left beside the corp tabs. The motto and the description
  paragraph are gone.
- **거래** (상점 + 판매 merged) — the corp's stock on the left, a two-tray **거래칸** in the middle (구매 / 판매) with the
  net credit delta and one big **거래 성사** button under it, and the player's real 가방 + 함선 창고 grids down the right
  (`InventoryRef.createTradeGrids`). Nothing buys or sells on click any more: a stock row is clicked or dragged into the
  구매 tray, an inventory tile is dragged (or double-clicked) into the 판매 tray, and the whole basket settles at once —
  sales first (they free credits and space), then the purchases, in staging order. The footer button became
  **귀중품 전부 담기** (it stages, it no longer sells).
- **계약** — the corp's contract list with the accepted contract (whatever corp it belongs to) pinned on the right.
- **퀘스트** — the quest list on the left, the selected quest's 납품 table in the middle and the same inventory grids on
  the right.

Page bodies are built **once** and swapped, not rebuilt per refresh: the embedded grids own bus subscriptions and a
pointer drag, so recreating them on every `inventory:changed` would drop a drag mid-flight.

### Known follow-ups (Phase 9 UI pass)
- The basket is **not** validated per line: `tradeBlock` only checks that the balance survives (`credits + revenue ≥
  cost`). A purchase that fails for space mid-settle stops that line and is reported in the summary; earlier lines stay
  bought.
- With server-owned credits `meta.buy` resolves asynchronously, so `bought` / `spent` in the summary are the optimistic
  counts. `quietPurchases` swallows the late per-purchase toasts so the summary is the message that stands; a late
  **failure** still toasts (it is a real problem).
- Staging is whole-stack: there is no split-on-drag, and a staged sale is only re-checked (and dropped) when the item
  disappears from bag + stash (`pruneBasket`). Switching corps clears the basket.
- The right-hand grids are hidden below 1240 px — the desk falls back to stock + trays there.

## Phase 9 UI/UX 개선 pass (2026-09-07)

- **분대 계약 동기화.** Every member broadcasts its own contract over the new `meta contract {id, progress}` message
  (`shared/net.ts`): on `world:ready`, on every local progress change (deduped on `{id}|{floor(progress)}`), on accept
  and on abandon, and once more to whoever asks with `metaq sync`. Received entries land in a per-peer map that
  `MetaRef.getSquadContracts()` exposes and `meta:squadContract` announces; `ui/hud/ContractPanel` draws one row per
  entry under the player's own contract. The map is per-mission — cleared at `game:newMission`, `game:abort`,
  `hub:entered` and `net:lobbyLeft`, and a peer that leaves drops its row. Nothing is aggregated and nobody is
  authoritative: an unknown contract id or a progress above the contract's target is clamped / ignored on arrival.
- **기업 화면.** The `기업 네트워크` title and its `거래 / 계약 / 퀘스트` subtitle are gone — the **corp list** sits in
  the header's top-left slot with the credits readout on its right, and the compact 기업 패널 (name + 신뢰도) became a
  full-width strip under it. The frame widened to `min(1760px, 100vw − 32px)` (and `.inv-screen.corp-view` matches it,
  so the embedded 기업 tab is just as wide).
- **거래 page is item grids.** 기업 판매 물품 and both 거래칸 trays render `.ct-cell` tiles built from
  `buildItemChip` — thumbnail, name, price, a `×n` staged badge — instead of wide rows, so hovering any of them raises
  the shared `ui/hud/ItemTip` card (no element carries a `title` that would race it). The right-hand 내 가방 /
  함선 창고 column stretches over the full page height, and its tiles get the same card through the `data-item-tip`
  hook. Staging, the credit delta and the 거래 성사 settlement are unchanged.

## Phase 10 UI 개선 pass (2026-09-07)

- **크레딧 표기 = `100 C`.** `@/shared`'s `formatCredits(n, {sign?, suffix?})` / `formatCreditAmount(n)` /
  `itemCreditValue(def, qty?)` (`shared/meta.ts`) are now **the** credit formatter for the whole game, and this folder
  routes every readout through them: the header credits pill (`.corp-credits .v`), the stock-cell and sale-chip prices
  (the old `123 cr` suffix is gone), the 구매 / 판매 tray totals, the 거래 후 크레딧 value, the 거래 성사 summary line,
  the contract and quest reward lines, and the `/credits` console answer. `ui/dom.ts`'s `fmtNum` stays for the
  **non-credit** numbers (신뢰도 `rep / next`, 목표 `progress / target`, 납품 `have / qty`).
  Display only — `buyPriceOf` / `sellPriceOf` / `ItemDef.value` and every rule in `Rules.ts` are untouched.
  In sentences 크레딧 stays a **word** and only the number carries the unit (`크레딧 +1,200 C`); a line that already
  says what it is drops the word entirely (`구매 · −1,200 C`, `거래 성사 · 구매 2점 · +340 C`).
- **인게임 커서 (§2 of `docs/DECISIONS.md`).** `ui/CorpMenu.open()` now adds the `'corp'` blocker and then calls
  `ctx.input.setCursorMode(true, 'corp')` **without** exiting the pointer lock; `close()` deletes the token and calls
  `setCursorMode(false, 'corp')`, and the microtask re-lock is gone (nothing ever unlocked). `close(relock)`'s
  parameter is kept for the call signature only. `setCursorMode` is ref-counted per blocker token, so the corp screen
  layered under / over another panel never steals the cursor from it. Not one DOM handler changed: the software cursor
  dispatches real bubbling `pointer*` / `mouse*` / `click` / `contextmenu` / `wheel` events at its virtual position, so
  the two `document.elementFromPoint(ev.clientX, ev.clientY)` drag hit-tests in `ui/CorpView.ts` keep working as they
  are (the synthetic event carries the virtual coordinates). The **embedded** 기업 tab is unchanged — it owns neither
  the blocker nor the cursor.

### Known follow-ups (Phase 10)
- The header pill reads `크레딧  1,200 C`, so the unit is spelled twice in two forms. That is what the plan asks for
  (`§3-9` puts `:231` in the `C` group); switch it to `formatCreditAmount` if the eyebrow ever becomes `CREDITS`.
- `CorpMenu.close(relock)` and `CorpView`'s two `elementFromPoint` calls are the only places that still mention the
  old lock etiquette; nothing reads `relock` any more.

## 2026-09-07 UI/UX pass — 기업 화면이 Tab 창의 탭이 되었다

- **`ui/CorpMenu.ts` 삭제.** 전용 오버레이(`.menu.corp-menu`)와 `'corp'` blocker · 자체 Esc 리스너 · 커서 소유가
  모두 사라졌다. `openCorpMenu(corp?)` 는 이제 `ctx.inventory.openScreen('corp')` 를 불러 **Tab 창을 기업 탭으로**
  연다 (함선 컴퓨터 `E` 와 Tab > 기업 이 같은 DOM 을 쓴다). `closeCorpMenu()` 는 그 창을 닫고, `isMenuOpen` 은
  `inventory.isOpen && inventory.screenTab === 'corp'` 이다. 어느 기업으로 열지는 `preferredCorp` 에 담아 두었다가
  `createCorpView` 가 `setCorpSilent` 로 소비하며, `ui:corpToggled` 는 뷰 생성 / dispose 에서 한 번씩 나간다.
- **화면 구성이 바뀌었다** (`ui/CorpView.ts` + `meta.css`):
  - 상단은 창의 화면 탭(인벤토리 / 캐릭터 / 기업 / 함선)이고, `.corp-shell` 이 **좌 `.corp-rail`(세로 기업 목록 +
    크레딧) · 우 `.corp-main`** 으로 나뉜다.
  - `.corp-main` 의 좌열 `.corp-side` 는 **기업 패널(이름 · Lv · 신뢰도) 위 · 거래 / 계약 / 퀘스트 세로 탭 아래**.
  - 화면 푸터는 없어졌고 **귀중품 전부 담기**는 판매 트레이 하단 버튼(`.ct-stage`)이 되었다.
- **거래가 전부 아이템 그리드다.** 구매 / 판매 트레이는 위아래로 쌓여 각각 **가로 5칸**(아이템 최대 폭)이고,
  기업 재고 · 가방 · 함선 창고가 같은 칸 크기(`--ct-cell` = `CT_CELL` 40 px, `createTradeGrids({cell})`)를 쓴다.
  칸은 아이템 발자국만큼 자리를 차지하고(`gridCell`, `grid-column/row: span n`), 이름은 공용 호버 카드
  (`ui/hud/ItemTip`)가 맡으며 칸에는 가격 / 수량 배지만 그린다. 거래 불가한 재고도 그리드 형태를 유지한 채
  가운데에 `신뢰도 Lv.1 부터 거래 가능` 을 띄운다.

### Known follow-ups (2026-09-07)
- 재고 / 트레이 칸은 이름을 그리지 않는다 — 호버 카드가 없는 입력(터치 등)에서는 아이콘과 가격만 보인다.
- 데스크는 여전히 넓다: 1240 px 아래에서는 우측 가방 / 창고 열이 숨는다(기존 미디어 쿼리 그대로).
- 기업 탭에서 Esc 는 창 전체를 닫는다(`hub/` 가 Escape 를 삼키지 않고 `inventory/` 가 처리한다).

## Phase 12 — 세레스 바이오 임플란트 (2026-09-08, `docs/DECISIONS.md` Phase 12)

Implants are **items** (`ItemDef.implant`, category `'implant'`, owner items/ — `src/items/ImplantDefs.ts`: `imp_<stat>_<1..4>`,
`imp_perk_*`, broken twins `imp_broken_*`). meta/ owns three things about them, all driven off `def.implant` rather than ids:

- **상점** (`src/shared/meta.ts` data): 세레스 바이오 gained `{ category: 'implant', maxRarity: 'uncommon' }` and
  `{ category: 'material', implantRepairMaterials: true }`. Two **append-only `ShopRule` fields** were added for that
  (`maxRarity` caps one rule below the rep cap; `implantRepairMaterials` sells exactly the materials some implant's
  `repairCost` names — 회로 기판 · 전력 케이블 · 합금 판 · 소독약 today, resolved from the live defs). The rep rarity cap still
  applies on top (rare 회로 기판 from Lv.2), a broken implant is never on any shelf, and no other corp has an implant rule.
  Implants sell at the usual `SELL_PRICE_MUL`; a broken one is worth a quarter of its twin (items/ sets `value`).
- **퀘스트** (`QUEST_DEFS`): the ceres implant chain `ci1` 신경 접합제 (Lv.1: 혈근초 6 · 잿빛잎 4 · 소독약 3 → `imp_perception_3`)
  → `ci2` 망가진 회로 분석 (`imp_broken_intelligence_1` · 회로 기판 2 · 생체 조직 6 → `imp_intelligence_3`) → `ci3` 가속 대사 임상
  (Lv.3: 발광버섯 6 · 소독약 6 · 주사기 6 · 터미니드 분비선 4 · 회로 기판 4 → `imp_perk_quick_heal`). Same `QuestDef` shape,
  deliveries from bag + stash, rewards through the existing `completeQuest` path.
- **임플란트 수리 desk**: the 기업 tab's fourth page at 세레스 바이오 (see the table rows). Fee `IMPLANT_REPAIR_FEE × grade`
  (150 / 300 / 450 / 600, legendary 750), materials from `repairCost`, the repaired implant goes to the 함선 창고 first.

### Known follow-ups (Phase 12)
- The server path debits the fee optimistically and swaps the item only on `ok`; between the click and the answer the row
  reads `수리 진행 중` and a broken implant moved elsewhere in that window fails the swap with a refund (nothing is lost).
- `priceOf` rebuilds the shop for the one def (+ the implants, so `implantRepairMaterials` can resolve) — fine per click,
  not per frame.
- The desk shows only broken implants in the **bag + stash**; an equipped implant lives in progression and cannot be
  broken anyway. There is no bulk 모두 수리.


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`MetaSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `MetaSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: MetaSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `MetaSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

- **2026-09-12 (아이템 회수 계약 — 이번 레이드에서 얻은 것만 센다, §5-2 사용자 결정)** — `parts/Contracts.ts` · `MetaSystem.ts` ·
  `ui/CorpView.ts`(주석). `carriedCount(defId, seed?)` 가 몸의 그 아이템 중 **`ItemInstance.raidFound` 가 레이드 시드와 같은 단위만** 센다
  (`shared/raidFound.isRaidFound`; `seed` 기본 = 진행 중인 레이드의 `raidFoundSeed`, 레이드 밖이면 0). 실시간 진행도(`trackItemCount`) ·
  정산(`settleMission` — 레이드 시드, 없으면 `stats.seed`) · 기업 화면 계약 행이 전부 그 값이다 — 그래서 **함선에서는 행이 늘 0 / n** 이다.
  목표 전체를 한 레이드 안에서 채워야 한다. 레이드 밖에서는 `trackItemCount` 가 저장된 진행도를 0 으로 되돌리고(`markDirty`),
  미완료 정산도 이 목표만은 0 으로 둔다 — 한 레이드의 개수가 함선 UI · 다음 레이드로 새지 않는다. 성공 · 보상 규칙은 그대로.
  표식 · 스택 분리 · 사선 띠는 inventory(`parts/RaidFound.ts`), 표식을 찍는 루팅 원천은 inventory · world · enemies 다.

- **2026-09-12 (즐겨찾기 · 특정 아이템 회수 계약 — 에이전트 E2)** — `ui/CorpView.ts` · 새 `ui/HoldAsk.ts` · `meta.css` · `model.ts` ·
  `Rules.ts` · `parts/Contracts.ts` · `parts/Credits.ts` · `MetaSystem.ts`, 그리고 `shared/meta.ts` · `data/contracts.csv`.
  1. **상점 · 거래칸 타일 = 즐겨찾기 우클릭 메뉴.** `makeTile` 이 드래그 고스트를 뺀 모든 타일에 `ITEM_FAVORITE_MENU_ATTR` 를 단다 —
     메뉴 자체는 `ui/hud/ItemFavoriteMenu` 의 위임 리스너 하나다(칩과 같은 메뉴, 가지고 있지 않은 상점 물품도 켠다). 파란 띠는
     `buildItemTile`(E1)이 그리므로 뷰는 `inventory:favoritesChanged` 에 refresh 만 한다. 퀘스트 납품 · 보상 · 임플란트 수리 재료 칩은
     `buildItemChip` / `renderItemCost` 라 손대지 않고 저절로 메뉴 · 띠를 받는다.
  2. **즐겨찾기 판매 = 한 번 더 확인.** 거래 성사 홀드가 끝나면 `requestTrade()` 가 판매칸에서 즐겨찾기를 찾고, 있으면 `HoldAsk`
     (`즐겨찾기 아이템 판매` · 이름 목록 · `그래도 판매` 1초 홀드 · Escape 취소)를 띄운다. 취소하면 바구니 · 아이템 · 크레딧이 그대로다.
     없으면 예전처럼 곧장 정산한다. **`귀중품 전부 담기` 는 즐겨찾기를 건너뛰고** 메시지에 `즐겨찾기 n점 제외` 를 붙인다(손으로 담는 것은 된다).
  3. **새 계약 목표 `extract_with_items`** (위 Rules 절) — 기업마다 둘, 8줄 (`data/README.md` 표). 계약 행에 아이템 칩(보유/필요) + 이름.
     `settleContract` 에 선택 인자 `carried` (생략 = 예전과 같다), `GOAL_IDS` 에 추가(콘솔 자동 완성 · 중계 화이트리스트), `INVENTORY_GOALS`.
  - `scripts/smoke-meta.mjs`: ceres 계약 행 수 4 → **6** (그 한 줄뿐). 새 `scripts/smoke-favorite-chips.mjs` (50/50, E1 실제 API).
  - 알려진 한계: 계약을 받은 뒤 **창고의 그 아이템을 가방에 넣고 출격해 곧장 탈출해도 달성**이다 — `extract_with_value` 와 같은 결이고
    (들고 들어간 귀중품도 전리품 가치다) 명세가 "지니고 탈출" 이라 그대로 뒀다. 레이드에서 **새로 얻은** 개수로 바꾸려면 `game:newMission`
    에서 몸의 개수를 찍어 두고 빼면 된다.

- **2026-09-12 2차 (기업 화면 UI/UX 6건 — 목록 분리 · 정적 셰브런 · 퀘스트 · 임플란트)** — `ui/CorpView.ts` · `meta.css` 두 파일뿐.
  1. **좌측 상단 `기업` 라벨 삭제.** 기업 이름 넷이 곧 그 설명이다. `.cv-title` 규칙 자체는 판매 물품 · 계약 · 퀘스트 · 임플란트가
     계속 쓰므로 남긴다.
  2. **기업 목록 = 메인 패널과 분리된 카드.** `.corp-rail` 이 `.corp-shell` 밖으로 나와 **호스트의 직접 자식**이 됐고, 격자를
     `.corp-shell` 이 아니라 **호스트**(`.corp-view`)가 갖는다 — 첫 칸 기업 카드(`align-self: center` = 세로 중앙) · 둘째 칸 메인 패널 ·
     아래 전 폭 메시지 슬롯. 둘 다 자기 배경 · 테두리를 갖고 사이는 `--corp-rail-gap`(18 px, 1500 px 아래 12 px). 자리를 CSS 로 못 박는
     결정은 `.menu.pause`(세로 중앙 · 가로 왼쪽) 와 같은 결이다 — 매번 다른 자리보다 늘 같은 자리. 호스트를 격자로 만들어도 안전한 이유는
     `inventory/ui/parts/Screens` 가 `screenHost.replaceChildren()` 로 비운 뒤 뷰를 짓기 때문이다(그 안의 자식은 전부 이 폴더 것이다).
     900 px 아래는 예전처럼 세로로 접는다(카드는 유지, 페이지 탭은 가로줄).
  3. **거래 셰브런 점멸 삭제.** `@keyframes cv-chev-flow` 와 `.c1` · `.c2` 스태거를 걷어내고 `opacity: 0.65` 정적으로. 방향 미러
     (`dir-left` / `dir-up`)와 순변화 ▲▼(`net-up` / `net-down`)는 그대로다. `ui/dom.chevrons` 가 붙이는 `c0…cN` 클래스는 남겨 뒀다
     — 마크업 계약이고, 나중에 다시 쓸 수 있다.
  4. **퀘스트 보상 = 납품 패널 하단.** `.cq-rewards` 가 목록 열에서 상세 열로 옮겨 가 `.cq-deliver` 바로 아래에 `border-top: 0` 으로
     이어 붙는다(한 패널처럼 읽힌다). 선택한 퀘스트의 납품 내용 바로 밑에 그 보상이 온다.
  5. **퀘스트 목록 — 완료는 딤드 · 맨 아래 · 숨길 수 있다.** `.corp-row.st-complete` 의 초록 배지를 흐린 색으로 바꾸고 행 전체를
     `opacity: 0.45`(선택된 행만 0.8). 정렬은 **`renderQuests` 의 렌더 단계**에서 안정 분할(완료 아닌 것 → 완료)로 한다 —
     `parts/Contracts.getQuests()` 의 반환 순서는 콘솔 · 스모크도 보므로 건드리지 않았다. 목록 머리 우측에 `완료된 항목 보기`
     체크박스(`.cv-check`, **기본 켜짐**)를 달고 끄면 완료 행이 빠진다. 상태는 `showDoneQuests` 필드 — 화면이 열려 있는 동안만 산다
     (영속화 불필요, 사용자 지시). 기본 선택은 **보이는 목록**에서만 고르므로 숨겨진 행이 선택되지 않는다.
  6. **임플란트 데스크에 가방 + 창고.** 좌 한 열(4행 격자)에 망가진 임플란트 타일 격자 + 수리 카드를 쌓고, 우는 거래 · 퀘스트와
     **같은 `createTradeGrids` 블록**이다. `makeGrids(host, dropSelector?)` 의 `dropSelector` 를 선택 인자로 바꿨다 — 이 화면에는
     드롭 대상이 없고, `onTake` 를 넘기면 **더블클릭이 판매칸도 없는 화면에서 판매를 예약**해 버린다. 수리 대상 수집
     (`parts/ImplantDesk.getRepairableImplants()`)은 한 줄도 바뀌지 않았다.
  - ⚠ `scripts/smoke-meta.mjs` 의 세 단언이 옛 DOM 을 본다(이 폴더 밖이라 손대지 않았다): `:587` `.corp-shell > .corp-rail …`,
    `:588` `railOrder`(`cv-title,corp-tabs` 를 기대), `:610` 의 그 비교. 새 구조에서는 rail 이 `.corp-view > .corp-rail` 이고
    자식은 `corp-tabs` 하나다.

- **2026-09-12 (기업 화면 개편 — 트리 · 인벤토리 타일 · 1초 홀드 거래)** — `ui/CorpView.ts` · 새 `ui/TileGrid.ts` · `ui/dom.ts` · `meta.css`,
  그리고 `shared/currency.ts` 마크업은 그대로 둔 채 `ui/styles/base.css` 의 재화 칩 규칙.
  - **판매 물품이 아래가 둥근 관 모양이던 것**: housing.css 의 배양조 `.ct-cell` / `.ct-slots` 와 이 폴더의 `.ct-*` 가 이름이 겹쳤다.
    접두사를 **`.cv-`** 로 바꿨고, 칸 자체를 `InventoryRef.buildItemTile`(인벤토리 에이전트가 이번에 추가)의 **인벤토리 타일**로 바꿨다 —
    발자국 크기 · 등급 색 · 내구도 · `data-item-tip` 그대로라 가방 / 창고와 똑같이 보이고 **호버 카드가 뜬다**(예전에는 칩의
    `pointer-events: none` + 칸에 `data-def-id` 없음). 배치는 `TileGrid` 가 `.inv-cells` 위에 first-fit.
  - **기업 목록 = 트리.** 선택한 기업 버튼 바로 아래에 가지(신뢰도 Lv · 경험치 게이지 → 거래 / 계약 / 퀘스트 / 임플란트 탭)가 열린다.
    가지는 DOM 하나를 옮기므로 한 번에 하나다. **좌하단 크레딧 삭제**.
  - **거래칸.** 구매 트레이 머리 끝(우측 상단)에 › ×3, 판매 트레이 머리 처음(좌측 상단)에 ‹ ×3 — 물건이 흐르는 쪽이고 차례로 밝아진다.
    `거래 후 크레딧` 라벨과 두 안내 문구(`왼쪽 목록에서 담으세요` · `오른쪽 가방 / 창고에서 끌어 놓으세요`) 삭제. 크레딧 변화는 가운데 한 줄:
    + 는 초록 ▲ 가 수치 **오른쪽**, − 는 빨강 ▼ 가 수치 **왼쪽**, 0 은 화살표 없음(방향은 명세에 없어 위 / 아래 = 이득 / 손해로 골랐다).
    **거래 성사 = 1초 홀드** (`UI_HOLD_CONFIRM_S`) — 클릭 · Enter 로는 확정되지 않고, 일찍 떼면 `1초간 꾹 누르세요` 안내. 게이지는 rAF,
    확정은 `setTimeout` 이라 프레임이 멈춘 탭에서도 거래가 멎지 않는다. 상점 타일 드래그는 pointermove 를 프레임당 한 번으로 합치고 고스트를 `transform` 으로 옮긴다.
  - **가방 5칸 · 창고 10칸.** 우측 열 폭을 창고 10칸(`10 × 56 − 2` + 스크롤바)으로 잡았다. 격자 자체(한 스크롤 · 정렬 · 필터)는 inventory 의 `TradeGrids` 몫.
    창이 1500 px 보다 좁으면 판매 물품 위 · 거래칸 아래로 접고 트레이를 나란히 둔다 — 5칸 트레이 둘(582 px)이 1440 px 화면에 들어가도록
    창 좌우 여백 · 기업 열(172 px) · 간격을 줄이고, 그보다 좁으면 트레이 격자가 옆으로 스크롤한다. 1240 px 아래 가방 열 숨김은 그대로.
  - **진행 중인 계약 = 그 계약 기업의 색.** 행마다 `--cc` 를 자기 계약 기업 색으로 박고, 우측 열(`.cc-col.active.has-contract`)도 같은 색 테두리 ·
    제목 · 기업 이름 태그. 예전에는 호스트의 `--cc`(선택한 기업)를 물려받아 세레스 탭에서 본 헬릭스 계약이 세레스 색이었다.
  - **재화 칩 우측 하단 수치 잘림**: `.currency-thumb` 의 `clip-path` 가 자식인 개수 배지까지 잘랐다. 깎은 모서리 · 테두리 · 배경을
    `::before` 뒤판으로, 안쪽 링을 `::after` 로 옮기고(`isolation: isolate` + `z-index: -1`) 썸네일은 투명 상자로 — 모든 재화 칩에 적용된다.
  - `scripts/smoke-meta.mjs`: 트리 구조 · 가지 이동 · 크레딧 없음, 타일(발자국 크기 · 관 모양 아님 · 호버 카드), 셰브런 · 라벨 없음, −/0 화살표,
    클릭 · Enter 로 거래 안 됨 → 0.45 s 홀드 중 → 1.35 s 에 정산, 다른 기업 계약 색, 재화 칩 clip-path. `scripts/shots-uiux.mjs` 선택자 갱신.

- **2026-09-11 (E-9 판매 반올림 `round` → `floor` — 에이전트 ③)** — 수식 자체는 리드가 `shared/credits.sellPriceFrom` 하나로 합쳤고
  (`shared/meta.sellPriceOf` 는 `SELL_PRICE_MUL` 만 넘긴다), 이 폴더는 **파급**을 받았다. 반올림이 `qty` 를 곱한 뒤에 일어나서
  홀수 value 아이템을 낱개로 쪼개 팔면 묶음보다 많이 받았다 — 경량탄(value 1 · 80발) 묶음 `round(40)=40 C` 대 낱개
  `round(0.5)=1 C × 80 = 80 C`. 서버는 막을 수 없었다(낱개 거래 하나하나가 자기 상한과 정확히 같아 정당했다).
  `floor` 면 분할이 **항상** 손해다. 바뀐 것:
  - `ui/CorpView.stageSell` 이 **0 C 를 거절하지 않는다** (사용자 결정). 거절하는 것은 `sellPriceOf === null`(값 없음 · 장착 중 ·
    가방에도 창고에도 없음)뿐이고, 가격 배지는 `formatCreditAmount(0)` → `0` 을 그대로 찍는다. 무게를 비우는 수단이고, 묶어 팔면
    제값이 나오므로 분할이 손해라는 것을 플레이어가 스스로 배운다. `귀중품 전부 담기`(`stageValuables`)만 0 C 를 건너뛰는데,
    귀중품의 최저 value 는 90 이라 실제로는 닿지 않는 방어선이다.
  - `parts/Trade.sell` 의 `price <= 0 → continue` 가 **동작을 떠받치는 줄**이 됐다 (예전에는 방어선이었다):
    `server/Economy.ts` 의 sell 분기가 `0 < delta` 를 요구하므로 0 C tx 는 거절되고, 그러면 `restoreSold` 가 아이템을 되돌려
    "팔았는데 안 팔림 + 실패 토스트" 가 된다. 0 C 는 서버에 알릴 것이 없다 — 잔액이 안 움직인다. 주석으로 못 박았다.
  - `server/economy.gen.json` 은 **다시 굽지 않았다.** `scripts/economy-table.mjs` 가 표에 싣는 것은 수치뿐이고(`sellPriceMul`
    0.5 · 아이템 value · stack), `hash` 도 그 본문의 digest 다 — 수식은 코드에 있다. `checkEconomyTable` 이 모든 아이템 ×
    모든 수량에서 `sellPriceOf` 와 `tableSellPrice` 를 비교하는데 둘 다 같은 `sellPriceFrom` 을 부르므로 값이 함께 움직인다
    (`npm run data:check` 통과 = 증명).
  - `scripts/smoke-meta.mjs` 에 단언 추가(위 `Verification` 절), `scripts/e2e-multiplayer.mjs` 의 잔액 0 대체 경로가
    `sell:ammo_light:1`(이제 0 C 라 릴레이가 거절한다) 대신 **표에서 고른 1 C 이상짜리 낱개 판매**를 쓴다.
  - 소유 검증(창고 조작)은 여전히 하지 않는다 — `docs/TODO.md` 의 `참고 — 의도된 한계`.

- **2026-09-11 (E-6 퀘스트 완료 트랜잭션 — 에이전트 ③)** — `parts/Contracts.completeQuest` 끝의 저장이 `commitQuestTx` 를 거친다:
  `ctx.inventory.flushSaves?.()`(창고 · 로드아웃 디바운스를 지금) → `save()`(meta) → `ProfileRef.setMany({meta, stash, loadout})`
  (`get` 으로 방금 큐에 들어간 문서를 모은다 — 바뀌지 않은 키는 `setMany` 가 건너뛴다). 납품 차감 · 보상 지급 · `complete` 기록이
  서버에 **한 번에 전부 또는 전무**로 간다 (`net/README.md` `문서 리비전`). 크레딧 tx 는 여전히 따로다(`credits:tx`, ⑦).

- **2026-09-11 (E-4 서버 크레딧 검증 — 에이전트 ⑦)** — 릴레이가 이제 `credits:tx` 의 사유를 해석하고 금액을 검사한다
  (`server/README.md` 의 `서버 크레딧 검증`). meta 쪽은 **사유를 계약 문법으로만** 만든다 — 모든 tx 가 `shared/credits.formatCreditReason`:
  `buy:<def>` · `refund:<def>` (`Trade`), `sell:<def>:<qty>` (**qty 가 붙었다**), `repair:<broken>` · `refund:repair:<broken>` (`ImplantDesk`),
  `contract:<id>` · `quest:<id>` (`Contracts`), `migrate` (`Credits`), `console` (`Console`, dev 사유 — `SCAV_DEV_ECONOMY` 가 없는 릴레이는
  되돌린다). 정상 흐름은 금액이 그대로라 거절되지 않는다(표의 가격 식이 `buyPriceOf` · `sellPriceOf` · `implantRepairFee` 와 같은 값이라는
  것을 `data:check` 가 매번 검산한다). **판매 거절 시 아이템 복구**: `sell` 은 여전히 `takeItem` 을 먼저 하지만(연타 이중 판매 방지)
  빼기 직전 인스턴스를 복사해 두고, 서버가 거절하면 크레딧 되돌림(`serverTx`)에 더해 **그 유닛을 되돌려 놓는다** — 통째로 판 스택은
  같은 uid · 내구도 · 소켓 그대로, 원래 창고에 있었으면 창고부터(`restoreSold`) + `ui:notify` warning `판매가 취소되었습니다 — …`,
  `stats.creditsEarned` 도 뺀다. 소켓이 끊긴(`null`) 판매는 예전처럼 로컬 판매가 선다. 스택이 `stackMax` 를 넘는 옛 인스턴스는
  스택 단위로 tx 를 나눈다(서버는 `qty ≤ stack` 만 받는다). 검증: 자기 릴레이(8895, 새 서버 코드)에 붙인 실제 흐름 — 레벨 1 · 5 구매 ·
  일괄 구매 · 배치 실패 환불 · 부분 판매 37/43 · 일괄 판매 · 임플란트 수리 + `refund:repair` · 계약 정산 · 퀘스트 — 15 tx 전부 수락,
  변조한 판매(+1)는 거절되고 같은 uid 가 창고로 돌아옴 (27/27).

- **2026-09-11 (E-4 — 분대 계약은 호스트의 적 사망에서 파생 · 중계 검증)** — `MetaSystem` 이 `enemy:squadKill`(enemies/ 가 호스트 권위
  사망에서 모든 클라이언트에 낸다)을 구독해 킬 목표(`kill_bugs` · `kill_rogues`)의 분대 몫을 **스스로** 센다. `parts/Credits.onMetaMessage`:
  ① 보낸 사람이 연결된 로비 멤버여야 한다(`meta contract` 포함) ② `contractHit` 의 킬 목표는 무시 ③ 나머지는 보낸 사람 · 목표별 토큰
  버킷(`META_HIT_RATE`/s, 버스트 ×2 — `MetaSystem.hitBuckets`) ④ `meta sync` 는 내가 보낸 `metaq sync.rid`(`MetaSystem.syncRid`)와 짝이
  맞고 보낸 사람당 한 번(`syncRepliedBy`)만. `onMetaRequest` 는 요청의 `rid` 를 되돌려 준다. 셋 다 `game:newMission` 에서 비운다.
  내 킬의 `contractHit` 송신(`Contracts.reportContractHit`)은 그대로다 — 구버전 수신자 호환 · `sentHits` 기록. 검사: `scripts/smoke-trust.mjs`.

- **2026-09-11 (C 항목 배치 — C-2 · C-6 · C-10 · X-1)** — ① **`open_crates` 계약 진척이 상자 id 별 한 번**(X-1):
  `crate:open` 은 이미 연 상자에 E 를 누를 때마다 다시 나오므로 연타로 계약을 채울 수 있었다. `cratesCounted`
  (`corpsesCounted` 와 같은 방식, `game:newMission` 에서 비움)가 막는다. 감정 XP 쪽은 `progression/` 이 따로 막는다.
  ② `ui/CorpView.ts` 의 죽은 옵션 `accentTarget` · `onClose` · `isVisible` 삭제 (임베드 뷰 하나뿐이고 아무도 넘기지
  않았다). `visible` = `!disposed && host.isConnected`. ③ `ui/dom.ts` `fmtNum` 로캘 `en-US` → **`ko-KR`**
  (`shared/currency.groupDigits` 와 같은 쪽 — 지금 표기는 둘 다 `1,200` 이라 화면은 그대로다).
  ④ `Rules.ts` `IMPLANT_REPAIR_FEE` 주석의 "shared/ is frozen" 을 사실대로(기능 폴더 스칼라 `tuning.csv`),
  이 README 의 해당 follow-up 두 줄(수수료를 shared 로 옮기자 · 로캘이 다르다) 삭제 — 위치는 data 규약에 맞다 (C-2 닫기).

- **2026-09-10 (보조무기 제거)** — 상점 카테고리 순서(`Rules`)에서 `secondary` 가 빠졌고 헬릭스의
  `secondary,PISTOL` 판매 규칙 줄(`data/corp_stock.csv`)도 사라졌다. `ruleMatches` 의 `primary || secondary`
  가지는 그대로 뒀다 — 옛 세이브의 정의를 막지 않기 위해서다.

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (기업 화면: 한 열은 기업, 나머지는 전부 페이지 · 보상은 재화 칩)** — `ui/CorpView.ts` + `meta.css`
  - **`기업 패널`(`.corp-panel`) 삭제.** 이름 · Lv 는 기업 목록이 이미 찍고 있었고, 그 패널이 앉아 있던
    `.corp-top` 가로 줄이 화면의 **세로를 통째로 깎아** 오른쪽 가방 / 함선 창고 · 진행 중인 계약이 납작했다.
    껍데기는 이제 **좌 `.corp-rail`(기업 목록 → 신뢰도 게이지 → 페이지 탭 → 크레딧) · 우 `.corp-page`** 두 열
    (`.corp-top` / `.corp-main` / `.corp-side` 는 없어졌다).
  - **신뢰도 게이지가 기업 목록 아래로.** 막대 + `Lv.n` + `420 / 700`(만렙은 `최고 등급`)뿐이고 **`신뢰도` 라벨은
    없다** — 기업 목록 밑의 눈금이 무엇을 재는지는 적을 것이 없다. 색은 선택한 기업의 `--cc`.
  - **페이지가 창 높이를 전부 쓴다.** 고정 밴드 `--corp-page-h` 를 버리고 `.inv-screen.corp-view` 에
    `height: calc(100vh − 130px)`(`.inv-screen` 이 이미 갖고 있던 `max-height` 와 같은 값)를 못 박아 flex 사슬에
    확정 높이를 줬다. `--corp-page-min` 은 낮은 뷰포트에서의 바닥일 뿐이고, `@media (max-height: …)` 도 그 바닥만 낮춘다.
  - **진행 중인 계약이 우측 열로.** 다른 페이지의 가방 / 함선 창고와 같은 자리, 같은 전체 높이 (`.cc` 두 열).
  - **퀘스트 목록은 이름 + 상태 배지뿐.** 설명 줄(`.sub`)을 뺐다 — 목록은 고르는 자리다. 설명은 상세 패널에 그대로.
  - **보상 = 재화 칩** (`@/shared/currency`, commit `a315693`). 계약 목록의
    `신뢰도 +12 · XP +40 · 크레딧 +1,200` 글자 줄과 퀘스트 상세의 보상 줄이 `appendCurrencyRewards` /
    `buildCurrencyChip` 의 육각 칩으로 바뀌었다. 신뢰도는 **기업마다 다른 재화**(`repCurrencyId(def.corp)`)라
    썸네일 색이 기업 색이고, 다른 기업 계약이 우측에 꽂혀 있으면 그 기업의 칩이 나온다. 호버 카드는
    `ui/hud/ItemTip` 이 `data-currency-id` 로 알아서 띄우므로 이 폴더에는 리스너가 없다. 퀘스트 보상은
    **퀘스트 목록 아래 고정 줄**(`.cq-rewards`)에서 재화 칩 + 아이템 칩이 **한 줄로** 서고, 완료 토스트(`summary`)만
    예전처럼 말로 보상을 적는다.
  - 크레딧 표시는 기업 열 맨 아래로 돌아왔다 (`.corp-view.is-embedded .corp-credits { display: none }` 삭제).

- **2026-09-09 (수치 csv 이관)** — 기업 · 계약 · 퀘스트 표가 `shared/meta.ts` 에서 csv 로 나갔다:
  `data/corps.csv`(4곳) · `data/corp_stock.csv`(판매 규칙 한 줄씩) · `data/contracts.csv` · `data/quests.csv`,
  신뢰도 표와 등급 상한은 `data/tables.csv`(`REP_TABLE` · `SHOP_RARITY_CAP_BY_REP`), 크레딧 · 가격 계수 ·
  계약 규칙 스칼라와 `IMPLANT_REPAIR_FEE` 는 `data/tuning.csv` 다. `Rules.ts` 의 판정 로직은 그대로

- **2026-09-08 (잠긴 탭 안내)** — 신뢰도가 모자란 `거래` / `계약` 서브탭은 이제 `disabled` 가 아니다. 흐리게
  (`.is-locked`) 두되 클릭은 받아서, `setPage` 가 필요한 신뢰도를 **토스트**(`ui:notify`)와 패널 자체 메시지 줄로
  알려 준다. `disabled` 였을 때는 클릭 이벤트가 아예 발생하지 않아 왜 잠겼는지 볼 방법이 툴팁뿐이었다.

- **2026-09-08 (기업 화면 재배치)** — `ui/CorpView` 의 껍데기가 **위-아래**로 바뀌었다: 상단 `.corp-top` 에
  기업 목록(가로 칩) + 기업 패널, 그 아래 `.corp-main` 이 좌측 페이지 탭 rail + 페이지 전폭. 예전에는 기업 목록과
  기업 패널이 왼쪽에 열을 **두 겹** 차지해 오른쪽 가방 · 창고가 잘게 눌려 있었다. 그래서 `CT_CELL` 을 40 → **54**
  (= Tab 인벤토리의 `labels.CELL`) 로 올려 가방 · 함선 창고가 인벤토리와 같은 칸 크기 · 같은 칸 수로 보인다.

- **Phase 7** — labels from `@/shared`, purchase = `inventory.canFit` (`공간 없음` before the click) + server credits transaction when `ctx.net.profile.available` (optimistic debit → `addCredits` → item placed on `ok`, refund on failure, completion via `meta:purchase`; offline = local pre-checked path), every `addCredits` mirrored to the server balance, `meta` document + credits migration on `net:profileLoaded`, `ContractSettlement.outcome`, nothing settles / counts in a training

- **Phase 8** — `createCorpView(host)` for the 기업 tab and a **fixed-height** `.corp-page` (the frame no longer resizes per tab), shop / sale / quest deliveries as item chips

- **Phase 9** — a rejoining client asks the squad for the contract hits it missed (`metaq sync` → each peer answers once per requester per mission with `meta sync {corp, hits}`) and every relayed hit is validated (goal / corp whitelists, finite `1..META_HIT_MAX`, progress clamped)

- **Phase 9 UI/UX 개선** — **분대 계약 동기화** (`meta contract` 브로드캐스트 → `getSquadContracts()` + `meta:squadContract`, 임무 단위로 초기화), 기업 화면에서 제목 · 부제를 없애고 **기업 목록을 좌측 상단**으로, 패널 폭 1760 px, 거래 재고 · 구매/판매 칸을 **아이템 그리드**(`.ct-cell` + `buildItemChip` → 공용 호버 툴팁)로, 가방/창고 열은 전체 높이. **Phase 9 UI pass**: `CorpView` 재작성 — 좌측 상단 **기업 패널**(이름 + 신뢰도, 모토 · 설명 제거), 상점 + 판매를 하나의 **거래** 탭으로 통합(좌 재고 · 중앙 구매/판매 거래칸 + 크레딧 차액 + **거래 성사** 일괄 정산 · 우 실제 가방/함선 창고 격자), 계약은 목록 + 진행 중 계약, 퀘스트는 목록 + 납품 테이블 + 격자; 즉시 구매/판매 버튼은 사라지고 footer 는 **귀중품 전부 담기**

- **Phase 10** — every credit readout goes through `formatCredits` / `formatCreditAmount` from shared (`100 C`; the `cr` suffix and the currency prefix are gone, 크레딧 stays a word in sentences), and `ui/CorpMenu` migrated to cursor mode. `buyPriceOf` / `sellPriceOf` / `ItemDef.value` are unchanged — display only

- **2026-09-07 UI/UX pass** — **`ui/CorpMenu.ts` 삭제** — 기업 화면은 Tab 창의 기업 탭 하나뿐이고 `openCorpMenu` 는 `ctx.inventory.openScreen('corp')`, `isMenuOpen` 은 창이 그 탭인지, `closeCorpMenu` 는 창을 닫는다 (`'corp'` blocker · 전용 Esc · 커서 소유 모두 사라졌다). 화면은 **좌 `.corp-rail`(세로 기업 목록 + 크레딧) · 우 `.corp-main`**(좌열 = 기업 패널 위 · 거래/계약/퀘스트 세로 탭 아래)이 되고 푸터는 없앴다. 거래는 전부 **아이템 그리드**다 — 구매/판매 트레이가 위아래로 쌓여 각각 가로 5칸, 기업 재고 · 가방 · 함선 창고가 같은 칸 크기(`--ct-cell` 40 px = `createTradeGrids({cell})`), 칸은 발자국만큼 span 하고 이름은 공용 호버 카드가 맡으며, 거래 불가 재고도 그리드 형태로 `신뢰도 Lv.1 부터 거래 가능` 을 가운데 띄운다. **귀중품 전부 담기**는 판매 트레이 하단으로

- **Phase 12 (2026-09-08)** — 세레스 바이오 임플란트 — 상점 규칙 `{implant, maxRarity uncommon}` + `{material, implantRepairMaterials}`(append-only `ShopRule` 필드), 퀘스트 사슬 `ci1→ci3`(보상 `imp_perception_3` / `imp_intelligence_3` / `imp_perk_quick_heal`), 기업 탭 4번째 세로 페이지 **임플란트** = 수리 데스크(`Rules.canRepairImplant`, 수수료 `IMPLANT_REPAIR_FEE` 150 × 등급, `getRepairableImplants` / `getImplantRepair` / `repairImplant` 가 구매와 같은 크레딧 경로를 쓰고 창고 우선 배치, 실패 시 전액 되돌림), 콘솔 `implant`

- **2026-09-08 (UI/UX)** — **탭 잠금** (`ui/CorpView.pageLock` / `resolvePage`): 신뢰도가 모자란 페이지는 빈 목록을 보여주는 대신 **세로 탭 자체가 잠긴다** (`disabled` + `.is-locked` + 🔒, 사유는 `title`), 그리고 화면은 잠기지 않는 **퀘스트 탭으로 열린다**. 거래는 `SHOP_UNLOCK_REP_LEVEL`(Lv.1), 계약은 그 기업 계약 중 가장 낮은 `minRepLevel` 이 기준이라 Lv.0 짜리 계약이 있는 기업(전부)은 **Lv.0 에서도 계약 탭이 열려 있다** — 계약 정의는 손대지 않았다. 퀘스트와 임플란트 수리 데스크는 절대 잠기지 않는다(신뢰도를 버는 통로다). 잠긴 탭을 눌러도 넘어가지 않고 사유만 뜬다
