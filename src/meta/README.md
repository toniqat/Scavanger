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
| `parts/Credits.ts` | **크레딧 · 신뢰도 · 서버 프로필**. 크레딧 잔액의 유일한 소유자. 릴레이가 있으면 서버가 진실이고(`serverTx`), 없으면 localStorage 다. `net:profileLoaded` 에서 서버 값을 받아들이는 규칙(`adoptServerCredits`)도 여기 있다. |
| `parts/ImplantDesk.ts` | **세레스 바이오 임플란트 수리 데스크** (Phase 12). 레이드에서는 **망가진 임플란트만** 나온다. 여기서 재료 + 수수료를 내고 고치면 쓸 수 있는 물건이 된다. 크레딧 경로는 구매와 완전히 같고(서버 트랜잭션 / 오프라인 분기), 실패하면 재료까지 전액 되돌린다. |
| `parts/Console.ts` | 개발자 콘솔 명령 `credits` / `rep` / `contract` / `quest` / `implant`. dev 클라이언트에서만 등록된다(`src/console` 참고). 게임 규칙은 하나도 갖지 않고 위의 API 만 부른다. |
| `Storage.ts` | `MetaSave` v1: `freshMetaSave()`, `sanitizeMetaSave()` (clamped credits, known corp / quest / contract ids only, only `accepted` / `complete` quest states kept), `MetaStorage` (load, 350 ms debounced `markDirty()`, `flush()` on `pagehide` / hub entry / dispose, every storage access in try/catch). Phase 7: `flush()` = `writeCache()` (localStorage) + `upload()` (`ctx.net.profile.set('meta', snapshot())`); `replace(doc)` adopts a server document without echoing it back. **Phase 9**: `upload()` dropped its `available` guard — the document is handed to `ProfileSync` offline too (stamped + queued, newest wins on the next connection) — and `MAX_PROGRESS` is exported so live hits clamp to the same ceiling as a load. |
| `Rules.ts` | Pure functions, no ctx / DOM: `repInfoOf`, shop filter (`ruleMatches` / `corpSells` / `shopRarityCap` / `buildShop` sorted by category → rarity → price, `fits` → 공간 없음), `killGoalOf`, `contractBlockReason`, `contractHitDelta` (Phase 9: a non-finite `amount` is 0, not `NaN`), `settleContract` (fills `outcome`), `questStateOf`, `questBlockReason`, the 한국어 `REASON` strings. `rarityRank` / `RARITY_ORDER` come from `@/shared` (`labels.ts`) since Phase 7. **Phase 12**: `ruleMatches` honours `ShopRule.maxRarity`, never sells a broken implant, and resolves an `implantRepairMaterials` rule against `implantRepairMaterialIds(defs)`; `CATEGORY_SORT` gained `implant / seed / book`; pure repair rules `IMPLANT_REPAIR_FEE` (150 × grade, grade = rarity rank + 1 of the **repaired** def), `implantGrade` / `implantRepairFee` / `isRepairableImplantDef` / `implantRepairCost` / `canRepairImplant(ImplantRepairCheck)` (reason order 아이템 → 함선 → 크레딧 → 재료 → 공간), `REASON.notBroken / noTarget / materials`. |
| `ui/CorpView.ts` | **(Phase 8)** The screen **body**, shared by both shells: header 기업 네트워크 + credit readout, 4 corp tabs (`CorpDef.color` accent, `Lv.n`), banner (slogan, description, rep bar `rep / next`), sub-tabs 상점 / 판매 / 계약 / 퀘스트, rows with 구매 / 판매 / 수락 / 포기 / 납품 buttons (disabled + tooltip from `blocked`), `귀중품 전부 판매`, `.form-msg` in a reserved slot. Renders into whatever host it is given and marks it `.corp-view` (`.is-embedded` for the inventory tab). Item thumbnails / 납품 requirements use `buildItemChip` / `renderItemCost` (`@/shared/itemChip`). Purchase messages come from `meta:purchase` (`구매 처리 중…` while a server transaction is pending) and refusals from `MetaSystem.onPurchaseFailure(fn)`. **No blocker, no pointer-lock, no window listener** — those belong to the shell. **Phase 12**: a fourth vertical page **임플란트** (`CorpPage 'implants'`, `PAGES[].corp = 'ceres'` → `pagesFor(corp)`; the button is `hidden` for every other corp and `setCorp` falls back to 거래): left `.ci-list` grid of broken implants (`.ct-cell.broken[data-uid]`, fee badge, `.is-sel`), right `.ci-repair` card — broken → result chips, `renderItemCost` material chips, `.ci-fee`, `.ci-block` reason + `.ci-repair-btn` 수리; results arrive through `meta.onImplantRepaired`. |
| ~~`ui/CorpMenu.ts`~~ | **Deleted 2026-09-07.** The standalone overlay `.menu.corp-menu` (and with it the `'corp'` blocker, the capture-phase Esc and the cursor ownership) is gone: the 기업 screen is the Tab window's 기업 tab, opened through `ctx.inventory.openScreen('corp')`. `CorpPage` is exported from `ui/CorpView.ts`. |
| `ui/dom.ts` | `el / setText / toggleClass / fmtNum` helpers (other folders' helpers are internal to them). `fmtNum` is for **non-credit** numbers only (신뢰도, 목표 진척, 납품 수량) — every credit readout goes through `formatCredits` (`@/shared`). |
| `meta.css` | Corp-screen styles on top of `.menu .frame .ui-btn .form-msg` (`ui/styles/base.css`) and `.hub-head .hub-foot` (`hub/hub.css`); `--cc` = selected corp colour, `--corp-page-h` = the **fixed** page height. `.item-chip*` itself is ui's (`base.css`). **Phase 12**: `.ci*` — the 임플란트 desk (two columns, selected cell accent, repair card). |
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
- **Sale** (`getSellable / sellPriceOf / sell`): bag + stash items with a value, equipped gear excluded; `sellPriceOf(value, qty)` = value × 0.5;
  `sell` = ship only → `inventory.takeItem(uid, qty)` (stub → false) → credits for the units actually removed → `meta:sale`.
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
- **Fixed popup size (Phase 8)**: `.corp-page` has a constant `height` (`--corp-page-h`, only the viewport height changes it — no min/max band), the
  `.form-msg` sits in a reserved `.corp-msg-slot` and `.hub-foot` keeps a `min-height`, so switching 상점 / 판매 / 계약 / 퀘스트, an empty ↔ full list
  or hiding 귀중품 전부 판매 never resizes the frame. Rows scroll inside the page (`overflow-y: auto; overflow-x: hidden; scrollbar-width: thin`).
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
blocker / tabs / Esc. **120 / 120** on 2026-09-06 (Phase 7, private vite 5307), 0 console errors. The script parks the relay socket so a relay
on 8787 cannot hand the page a real profile mid-run. `npm run typecheck` clean for this folder.

## Known gaps
- `getSellable` lists the whole bag + stash; there is no per-unit partial sale in the UI (stacks sell whole, `sell(uid, qty)` supports it).
- Relayed contract hits are validated by shape only (whitelists + `1..META_HIT_MAX` + progress clamp, Phase 9) — never against the sender's position, weapon or line of sight; a peer that lies within those bounds is believed. The Phase 9 `metaq sync` catch-up hands a late joiner the hits each peer **broadcast itself**, so hits a peer received from a third party are not forwarded (no double counting, but a joiner can still miss the share of a member that has since left), and each peer answers a given requester only once per mission.
- A purchase whose server answer never arrives (socket dropped mid-transaction) delivers the item on the local debit; the balance is corrected on the next `net:profileLoaded`.
- The corp screen has no keyboard navigation beyond Esc, and no item tooltips beyond the row subtitle (the chip's `title` carries name + description).
- `--corp-page-h` is a constant per viewport height, not per host: an embedded 기업 tab inside a short inventory window cannot shrink it on its own
  (the host may override the variable inline if it ever needs to).
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
- `formatCredits` groups with `ko-KR` while `fmtNum` groups with `en-US`. Both render `1,200` today, so a page mixing
  the two is consistent by accident, not by contract.
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
- `CorpViewOptions.accentTarget / onClose / isVisible` 는 남아 있지만 지금은 아무도 넘기지 않는다 (임베드 뷰 하나뿐).
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
- `IMPLANT_REPAIR_FEE` lives in `Rules.ts` (shared/ was frozen) — move it to `shared/meta.ts` next time the contract opens.
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

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 7** — labels from `@/shared`, purchase = `inventory.canFit` (`공간 없음` before the click) + server credits transaction when `ctx.net.profile.available` (optimistic debit → `addCredits` → item placed on `ok`, refund on failure, completion via `meta:purchase`; offline = local pre-checked path), every `addCredits` mirrored to the server balance, `meta` document + credits migration on `net:profileLoaded`, `ContractSettlement.outcome`, nothing settles / counts in a training

- **Phase 8** — `createCorpView(host)` for the 기업 tab and a **fixed-height** `.corp-page` (the frame no longer resizes per tab), shop / sale / quest deliveries as item chips

- **Phase 9** — a rejoining client asks the squad for the contract hits it missed (`metaq sync` → each peer answers once per requester per mission with `meta sync {corp, hits}`) and every relayed hit is validated (goal / corp whitelists, finite `1..META_HIT_MAX`, progress clamped)

- **Phase 9 UI/UX 개선** — **분대 계약 동기화** (`meta contract` 브로드캐스트 → `getSquadContracts()` + `meta:squadContract`, 임무 단위로 초기화), 기업 화면에서 제목 · 부제를 없애고 **기업 목록을 좌측 상단**으로, 패널 폭 1760 px, 거래 재고 · 구매/판매 칸을 **아이템 그리드**(`.ct-cell` + `buildItemChip` → 공용 호버 툴팁)로, 가방/창고 열은 전체 높이. **Phase 9 UI pass**: `CorpView` 재작성 — 좌측 상단 **기업 패널**(이름 + 신뢰도, 모토 · 설명 제거), 상점 + 판매를 하나의 **거래** 탭으로 통합(좌 재고 · 중앙 구매/판매 거래칸 + 크레딧 차액 + **거래 성사** 일괄 정산 · 우 실제 가방/함선 창고 격자), 계약은 목록 + 진행 중 계약, 퀘스트는 목록 + 납품 테이블 + 격자; 즉시 구매/판매 버튼은 사라지고 footer 는 **귀중품 전부 담기**

- **Phase 10** — every credit readout goes through `formatCredits` / `formatCreditAmount` from shared (`100 C`; the `cr` suffix and the currency prefix are gone, 크레딧 stays a word in sentences), and `ui/CorpMenu` migrated to cursor mode. `buyPriceOf` / `sellPriceOf` / `ItemDef.value` are unchanged — display only

- **2026-09-07 UI/UX pass** — **`ui/CorpMenu.ts` 삭제** — 기업 화면은 Tab 창의 기업 탭 하나뿐이고 `openCorpMenu` 는 `ctx.inventory.openScreen('corp')`, `isMenuOpen` 은 창이 그 탭인지, `closeCorpMenu` 는 창을 닫는다 (`'corp'` blocker · 전용 Esc · 커서 소유 모두 사라졌다). 화면은 **좌 `.corp-rail`(세로 기업 목록 + 크레딧) · 우 `.corp-main`**(좌열 = 기업 패널 위 · 거래/계약/퀘스트 세로 탭 아래)이 되고 푸터는 없앴다. 거래는 전부 **아이템 그리드**다 — 구매/판매 트레이가 위아래로 쌓여 각각 가로 5칸, 기업 재고 · 가방 · 함선 창고가 같은 칸 크기(`--ct-cell` 40 px = `createTradeGrids({cell})`), 칸은 발자국만큼 span 하고 이름은 공용 호버 카드가 맡으며, 거래 불가 재고도 그리드 형태로 `신뢰도 Lv.1 부터 거래 가능` 을 가운데 띄운다. **귀중품 전부 담기**는 판매 트레이 하단으로

- **Phase 12 (2026-09-08)** — 세레스 바이오 임플란트 — 상점 규칙 `{implant, maxRarity uncommon}` + `{material, implantRepairMaterials}`(append-only `ShopRule` 필드), 퀘스트 사슬 `ci1→ci3`(보상 `imp_perception_3` / `imp_intelligence_3` / `imp_perk_quick_heal`), 기업 탭 4번째 세로 페이지 **임플란트** = 수리 데스크(`Rules.canRepairImplant`, 수수료 `IMPLANT_REPAIR_FEE` 150 × 등급, `getRepairableImplants` / `getImplantRepair` / `repairImplant` 가 구매와 같은 크레딧 경로를 쓰고 창고 우선 배치, 실패 시 전액 되돌림), 콘솔 `implant`

- **2026-09-08 (UI/UX)** — **탭 잠금** (`ui/CorpView.pageLock` / `resolvePage`): 신뢰도가 모자란 페이지는 빈 목록을 보여주는 대신 **세로 탭 자체가 잠긴다** (`disabled` + `.is-locked` + 🔒, 사유는 `title`), 그리고 화면은 잠기지 않는 **퀘스트 탭으로 열린다**. 거래는 `SHOP_UNLOCK_REP_LEVEL`(Lv.1), 계약은 그 기업 계약 중 가장 낮은 `minRepLevel` 이 기준이라 Lv.0 짜리 계약이 있는 기업(전부)은 **Lv.0 에서도 계약 탭이 열려 있다** — 계약 정의는 손대지 않았다. 퀘스트와 임플란트 수리 데스크는 절대 잠기지 않는다(신뢰도를 버는 통로다). 잠긴 탭을 눌러도 넘어가지 않고 사유만 뜬다
