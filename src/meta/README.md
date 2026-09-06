# src/meta — 기업 · 신뢰도 · 계약 · 퀘스트 · 크레딧 · 상점 (`MetaSystem`)

Phase 5-c (2026-09-06, brief `docs/PHASE5-PLAN.md` §8-1). Publishes `ctx.meta` (`MetaRef`, contract in `src/shared/meta.ts`),
persists everything in localStorage `META_STORAGE_KEY` (`scav.meta`), owns the **기업 네트워크** screen (ship computer,
blocker token `'corp'`) and the `credits / rep / contract / quest` developer-console commands. Character XP stays with
`progression/` (`ctx.progression.addXp`), the bag / stash with `inventory/`; this folder only asks them through `ctx.*Ref`.
Registered in `main.ts` right after `InventorySystem` (buy / sell / deliveries need the bag + stash) — see the root `CLAUDE.md`.

| File | Purpose |
|---|---|
| `MetaSystem.ts` | `GameSystem` (`name: 'meta'`) + `MetaRef`. Bus subscriptions for contract goals, `meta` net message (squad share), `settleMission`, shop buy / sell, quests, corp-screen open / close, console commands, save on `hub:entered` and after every change. |
| `Storage.ts` | `MetaSave` v1: `freshMetaSave()`, `sanitizeMetaSave()` (clamped credits, known corp / quest / contract ids only, only `accepted` / `complete` quest states kept), `MetaStorage` (load, 350 ms debounced `markDirty()`, `flush()` on `pagehide` / hub entry / dispose, every storage access in try/catch). |
| `Rules.ts` | Pure functions, no ctx / DOM: `repInfoOf`, shop filter (`ruleMatches` / `corpSells` / `shopRarityCap` / `buildShop` sorted by category → rarity → price), `killGoalOf`, `contractBlockReason`, `contractHitDelta`, `settleContract`, `questStateOf`, `questBlockReason`, the 한국어 `REASON` strings. |
| `ui/CorpMenu.ts` | `.menu.corp-menu`: header 기업 네트워크 + credit readout, 4 corp tabs (`CorpDef.color` accent, `Lv.n`), banner (slogan, description, rep bar `rep / next`), sub-tabs 상점 / 판매 / 계약 / 퀘스트, rows with 구매 / 판매 / 수락 / 포기 / 납품 buttons (disabled + tooltip from `blocked`), `귀중품 전부 판매`, inline `.form-msg`. Hub pointer-lock etiquette (blocker first, Esc capture, microtask re-lock). |
| `ui/dom.ts` | `el / setText / toggleClass / fmtNum` helpers (other folders' helpers are internal to them). |
| `meta.css` | Corp-screen styles on top of `.menu .frame .ui-btn .form-msg` (`ui/styles/base.css`) and `.hub-head .hub-foot` (`hub/hub.css`); `--cc` = selected corp colour. |
| `index.ts` | Barrel. |

## Rules (all numbers from `src/shared/meta.ts`)
- **Credits**: start `CREDITS_INITIAL` 500, cap `CREDITS_MAX`; `addCredits(delta)` refuses (false, no change) below 0 → `meta:creditsChanged`.
- **Reputation**: cumulative per corp, `repLevelOf` over `REP_TABLE`, never below 0 → `meta:repChanged {levelUp}`.
- **Shop** (`getShop / priceOf / buy`): opens at `SHOP_UNLOCK_REP_LEVEL` 1. `ctx.loot.getAllItemDefs()` filtered by the corp's `ShopRule`s — same
  `category`; weapons by `WeaponDef.weaponClass`, **uniques never**; ammo by `ammoType`; bags by `BagDef.tactical`; `minRepLevel` hides a rule; rarity ≤
  `SHOP_RARITY_CAP_BY_REP[level]` (bags +`SHOP_BAG_RARITY_BONUS`); `value > 0`. Price `buyPriceOf(value, level)`. `blocked`: 함선에서만 가능 / 크레딧 부족
  (space cannot be pre-checked — `buy` refunds when neither the bag nor the stash takes the item). `buy` = ship only → `addCredits(−price)` →
  `loot.createItem` → `inventory.tryAddItemAnywhere` (bag, else stash; falls back to `tryAddItem` while the helper is a stub) → `meta:purchase {placed}`.
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
- **Quests**: `locked / available` recomputed from `QuestDef.requires` (rep level + prerequisite quests complete); `accepted / complete` in the save.
  `acceptQuest` ship only → `meta:questChanged`. `completeQuest` ship only: deliveries counted with `inventory.countDefAll` (bag + stash); **reward
  items are placed first** (`tryAddItemAnywhere`, stack-split by `stackMax`) — if one does not fit the placed ones are taken back and the quest reports
  `blocked: 공간 없음`, nothing consumed; then `consumeDefAll`, credits, rep, `progression.addXp` → `meta:questChanged {complete}`.
- **Corp screen**: `openCorpMenu(corp?)` (refused while `isRaidActive()`), `closeCorpMenu`, `isMenuOpen`. Emits `ui:corpToggled {open, corp}` and
  `audio:play ui_click / ui_equip / ui_deny / ui_close`. No `ui:notify` from this folder — toasts belong to `ui/` and listen to the `meta:*` events.
- **Persistence**: every mutation `markDirty()`; `save()` flushes; `resetMeta()` wipes to a fresh save (emits `meta:loaded` / `creditsChanged` / `repChanged`).
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
| `meta:purchase {corp, defId, price, placed}` · `meta:sale {defId, qty, credits}` | shop |
| `ui:corpToggled {open, corp}` | corp screen open / close |

Listens: `game:newMission` (progress snapshot, per-mission dedupe reset), `hub:entered` (flush), `enemy:killed`, `crate:open`, `crate:looted`,
`inventory:containerOpened`, `stratagem:called`, `inventory:changed`, net `meta`. The menu refreshes on every `meta:*`, `inventory:changed`,
`inventory:stashChanged`, `loadout:changed`.

## Verification
`node scripts/smoke-meta.mjs [url]` (registered in `scripts/verify.mjs` for `meta / inventory / hub / ui / game`): fresh save → rep → shop
filter / prices → buy + refusal → sell → contract gating → real kill progress in a mission → death / success settlement → squad share → quest
h1 → reload persistence → corrupt-save sanitising → corp-screen DOM / blocker / tabs / Esc. **90 / 90** on 2026-09-06 (0 skipped — inventory's
`takeItem` was live by then), 0 console errors. `npm run typecheck` clean for this folder.

## Known gaps
- `ShopItem.blocked` never says 공간 없음 up front (grid fit is not queried); `buy` refunds instead.
- `getSellable` lists the whole bag + stash; there is no per-unit partial sale in the UI (stacks sell whole, `sell(uid, qty)` supports it).
- Relayed contract hits are not validated against the sender's position / phase; a late-joining client gets no catch-up of a squadmate's contract.
- `RARITY_LABEL` / `CATEGORY_LABEL` are duplicated from `items/ItemDefs.ts` (folder isolation); the Korean strings must be kept in sync by hand.
- The corp screen has no keyboard navigation beyond Esc, and no item tooltips beyond the row subtitle.
