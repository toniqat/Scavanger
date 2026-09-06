# src/meta — 기업 · 신뢰도 · 계약 · 퀘스트 · 크레딧 · 상점 (`MetaSystem`)

Phase 5-c (2026-09-06, brief `docs/PHASE5-PLAN.md` §8-1). Publishes `ctx.meta` (`MetaRef`, contract in `src/shared/meta.ts`),
persists everything in localStorage `META_STORAGE_KEY` (`scav.meta`), owns the **기업 네트워크** screen (ship computer,
blocker token `'corp'`) and the `credits / rep / contract / quest` developer-console commands. Character XP stays with
`progression/` (`ctx.progression.addXp`), the bag / stash with `inventory/`; this folder only asks them through `ctx.*Ref`.
Registered in `main.ts` right after `InventorySystem` (buy / sell / deliveries need the bag + stash) — see the root `CLAUDE.md`.
**Phase 8** (2026-09-06, brief `docs/PHASE8-PLAN.md` §2.6): the screen body moved to `ui/CorpView.ts` so the standalone overlay and the
**embedded 기업 tab** of the inventory Tab screen (`createCorpView(host)` → `EmbeddedView`) share one set of renderers; the popup has a fixed
size (no more per-tab resizing) and every item requirement is a `buildItemChip` / `renderItemCost` thumbnail.

| File | Purpose |
|---|---|
| `MetaSystem.ts` | `GameSystem` (`name: 'meta'`) + `MetaRef`. Bus subscriptions for contract goals, `meta` net message (squad share), `settleMission`, shop buy / sell, quests, corp-screen open / close, console commands, save on `hub:entered` and after every change. Phase 7: server credits (`addCredits` = optimistic local apply + `credits:tx`, `serverTx` adopts / reverts), `buy` = `canFit` → debit → item (async completion → `meta:purchase`, failure → `lastPurchaseFailure` / `onPurchaseFailed`), `net:profileLoaded` (replace / migrate), training gating. Phase 8: `createCorpView(host)` (embedded 기업 tab, tracked in a `views` set whose message timers tick with `update()`), `onPurchaseFailure(fn)` fan-out, public `countAll(defId)`. |
| `Storage.ts` | `MetaSave` v1: `freshMetaSave()`, `sanitizeMetaSave()` (clamped credits, known corp / quest / contract ids only, only `accepted` / `complete` quest states kept), `MetaStorage` (load, 350 ms debounced `markDirty()`, `flush()` on `pagehide` / hub entry / dispose, every storage access in try/catch). Phase 7: `flush()` = `writeCache()` (localStorage) + `upload()` (`ctx.net.profile.set('meta', snapshot())` when available); `replace(doc)` adopts a server document without echoing it back. |
| `Rules.ts` | Pure functions, no ctx / DOM: `repInfoOf`, shop filter (`ruleMatches` / `corpSells` / `shopRarityCap` / `buildShop` sorted by category → rarity → price, `fits` → 공간 없음), `killGoalOf`, `contractBlockReason`, `contractHitDelta`, `settleContract` (fills `outcome`), `questStateOf`, `questBlockReason`, the 한국어 `REASON` strings. `rarityRank` / `RARITY_ORDER` come from `@/shared` (`labels.ts`) since Phase 7. |
| `ui/CorpView.ts` | **(Phase 8)** The screen **body**, shared by both shells: header 기업 네트워크 + credit readout, 4 corp tabs (`CorpDef.color` accent, `Lv.n`), banner (slogan, description, rep bar `rep / next`), sub-tabs 상점 / 판매 / 계약 / 퀘스트, rows with 구매 / 판매 / 수락 / 포기 / 납품 buttons (disabled + tooltip from `blocked`), `귀중품 전부 판매`, `.form-msg` in a reserved slot. Renders into whatever host it is given and marks it `.corp-view` (`.is-embedded` for the inventory tab). Item thumbnails / 납품 requirements use `buildItemChip` / `renderItemCost` (`@/shared/itemChip`). Purchase messages come from `meta:purchase` (`구매 처리 중…` while a server transaction is pending) and refusals from `MetaSystem.onPurchaseFailure(fn)`. **No blocker, no pointer-lock, no window listener** — those belong to the shell. |
| `ui/CorpMenu.ts` | The **standalone overlay shell** `.menu.corp-menu` (ship computer): builds a `CorpView` into its `.frame` and adds the hub pointer-lock etiquette (blocker `'corp'` first, `exitPointerLock`, capture-phase Esc, 닫기 button, microtask re-lock), `ui:corpToggled`. Re-exports `CorpPage`. |
| `ui/dom.ts` | `el / setText / toggleClass / fmtNum` helpers (other folders' helpers are internal to them). |
| `meta.css` | Corp-screen styles on top of `.menu .frame .ui-btn .form-msg` (`ui/styles/base.css`) and `.hub-head .hub-foot` (`hub/hub.css`); `--cc` = selected corp colour, `--corp-page-h` = the **fixed** page height. `.item-chip*` itself is ui's (`base.css`). |
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
  `EmbeddedView {refresh, dispose}`. It adds **no `'corp'` blocker, never calls `exitPointerLock()` and installs no window Escape listener** — the
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
- Relayed contract hits are not validated against the sender's position / phase; a late-joining client gets no catch-up of a squadmate's contract.
- A purchase whose server answer never arrives (socket dropped mid-transaction) delivers the item on the local debit; the balance is corrected on the next `net:profileLoaded`.
- The corp screen has no keyboard navigation beyond Esc, and no item tooltips beyond the row subtitle (the chip's `title` carries name + description).
- `--corp-page-h` is a constant per viewport height, not per host: an embedded 기업 tab inside a short inventory window cannot shrink it on its own
  (the host may override the variable inline if it ever needs to).
- `.item-chip*` styling is ui's (`ui/styles/base.css`); until that lands the chips render as bare glyph + count.
