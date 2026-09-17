# src/meta/ — corporations, reputation, credits, trade desk, contracts, NPC quests, intel broker

`MetaSystem` (`name: 'meta'`, registered in `main.ts` right after `InventorySystem`) publishes `ctx.meta` (`MetaRef`,
contract in `src/shared/meta.ts`). It owns the 4 corporations' reputation, the credit balance, the corp network screen
(the Tab window's `기업` tab), shops and selling, contracts, the Ceres implant repair desk, the NPC quest engine behind the
messenger (`ctx.meta.npc`), per-NPC trust, and intel broker purchases (`ctx.meta.intel`). Character XP belongs to
`progression/`, items to `inventory/`, the messenger UI to `ui/`; this folder reaches them only through `ctx.*Ref`.
All numbers come from `data/` (`corps.csv`, `corp_stock.csv`, `contracts.csv`, `npcs.csv`, `npc_quests.csv`,
`npc_objectives.csv`, `intel_options.csv`, `tables.csv`, `tuning.csv`) through `src/shared/meta.ts`, `npc.ts`, `intel.ts`.

## Files

| File | Responsibility |
|---|---|
| `index.ts` | Barrel |
| `MetaSystem.ts` | `GameSystem` + `MetaRef`: bus subscriptions for contract goals, settlement entry, corp screen open/close, embedded views (`views`), purchase-failure / repair listener sets, console registration on first `update()`; one-line delegates into `parts/` |
| `model.ts` | Folder vocabulary (types, constants, `isValidHit`); re-exported by `MetaSystem.ts` |
| `Rules.ts` | Pure rules: `repInfoOf`, shop filter (`ruleMatches`, `corpSells`, `shopRarityCap`, `shopQtyOf`, `buildShop`, `implantRepairMaterialIds`), `killGoalOf`, `contractBlockReason`, `contractHitDelta`, `settleContract`, implant repair (`IMPLANT_REPAIR_FEE`, `implantGrade`, `implantRepairFee`, `isRepairableImplantDef`, `implantRepairCost`, `canRepairImplant`), legacy `questStateOf`/`questBlockReason`, Korean `REASON` strings |
| `NpcRules.ts` | Pure NPC rules: `enemyMatches`, `weaponSpecClass`, `itemMatches`, `requirementMet` (level, corp rep, NPC trust, completed quests, progress flags), `objectiveLabel`, `rewardSummary`, `npcTrustLabel`, `npcTrustReason`, `legacyQuestState`, `freshNpcSave`, `sanitizeNpcSave`, `NPC_REASON` |
| `Storage.ts` | `MetaSave` (`META_SAVE_VERSION`) in localStorage `slotKey(META_STORAGE_KEY)`: `freshMetaSave`, `sanitizeMetaSave`, `MetaStorage` (debounced `markDirty`, `flush` on `pagehide`/`beforeunload`/hub entry/dispose, `upload` → `ctx.net.profile.set('meta', …)`, `replace` adopts a server document without echoing), `MAX_PROGRESS` |
| `parts/Credits.ts` | Credit balance owner: `addCredits` (optimistic + `credits:tx`), `creditsTx` (awaits the relay answer), `serverTx`, `adoptServerCredits`, `onProfileLoaded`, `getRep`/`addRep`; relayed `meta` / `metaq` validation (`onMetaMessage`, `onMetaRequest`) |
| `parts/Trade.ts` | Shop and selling: `getShop`, `priceOf`, `buy`, `completePurchase`, `failPurchase`, `onPurchaseFailure`, `sell`, `getSellable`, placement helpers (`fits`, `addAnywhere`, `takeBack`, `findAnywhere`, `countAll`) |
| `parts/Contracts.ts` | Contracts: accept/abandon, `reportContractHit`, live trackers (`trackLootValue`, `trackItemCount`, `carriedCount`), squad contract rows (`applySquadContract`, `broadcastContract`), `settleMission`, `libraryTrustMulOf`, `commitQuestTx`; legacy corp-quest API stubs |
| `parts/ImplantDesk.ts` | Ceres implant repair desk: `getRepairableImplants`, `getImplantRepair`, `repairImplant`, `performRepair`, `giveBack`, `finishRepair`, `onImplantRepaired`, `isRepairPending` |
| `parts/NpcQuests.ts` | `class NpcQuests implements NpcQuestRef` = `ctx.meta.npc`: contact/offer evaluation, event log → messages, intro choices, accept/deliver/report, unread and `readAtOf`, raid tracks, NPC trust, progress flags, console helpers (`forceContact`, `forceOffer`, `devProgress`, `reset`) |
| `parts/NpcObjectives.ts` | Raid objective counting for active NPC quests: `advance`, `tryConfirm`, `onKill`, `onDiscover`, `onSearch`, `onInteract`, `trackRecover`, `settleRaid`, `resetRaid` |
| `parts/Intel.ts` | `class Intel implements IntelRef` = `ctx.meta.intel`: `get`, `effects`, `costOf`, `maxTierOf`, `buy`, `discard`, `consume`, lobby sync |
| `parts/Console.ts` | Dev console commands `credits`, `rep`, `contract`, `implant`, `npc` (calls the APIs above only; registered when `ctx.console.enabled`) |
| `ui/CorpView.ts` | The corp screen body (`CorpPage` = `trade` \| `contracts` \| `implants`, `implants` only at `ceres`): corp rail, trade desk (stock, buy/sell trays, stash + bag card), contract page, implant desk; cell fitting (`fitLayout`) |
| `ui/TileGrid.ts` | Fill-style item grid for stock/trays/desk: packs caller-built tiles (`InventoryRef.buildItemTile`) first-fit in the inventory grid markup; `setCell` |
| `ui/HoldAsk.ts` | "Confirm once more" popup (favorite-item sale): 1 s hold confirm, Escape token `meta:holdAsk`, attaches to `ctx.uiRoot` |
| `ui/dom.ts` | `el`, `setText`, `toggleClass`, `fmtNum` (non-credit numbers only), `chevrons(dir, count)` |
| `meta.css` | Corp screen styles. Class prefixes: `.corp-` (shell, rail), `.cv-` (trade desk, cards), `.cc` (contracts), `.ci-` (implant desk) |

## Public API

**`MetaRef`** (see `src/shared/meta.ts` for signatures):

- balance / rep: `credits`, `addCredits(delta, reason)`, `creditsTx?(delta, reason)`, `getRep(corp)`, `addRep(corp, delta, reason)`
- shop: `getShop`, `priceOf`, `buy`, `sellPriceOf`, `sell`, `getSellable`
- contracts: `getContracts`, `activeContract`, `acceptContract`, `abandonContract`, `reportContractHit`, `settleMission(stats)`,
  `getSquadContracts`
- corp quests (legacy contract): `getQuests` → `[]`, `acceptQuest`/`completeQuest` → `false`, `getQuestState(id)` answers from NPC quests
  (housing's coin unlock gate reads it)
- screen: `openCorpMenu(corp?)` (refused during a raid; opens the Tab window on `ctx.inventory.openScreen('corp')`), `closeCorpMenu`,
  `isMenuOpen`, `createCorpView(host)` → `EmbeddedView`
- persistence: `save`, `resetMeta`
- sub-refs: `npc?: NpcQuestRef` (`src/shared/npc.ts`), `intel?: IntelRef` (`src/shared/intel.ts`); NPC trust `npcTrust`, `npcTrustLevel`,
  `addNpcTrust`

Main consumers: `game/` (`settleMission` before `game:complete`/`game:over`), `hub/` (computer → `openCorpMenu`, intel screen →
`intel`), `inventory/` (Tab window hosts `createCorpView`), `housing/` (`creditsTx` for crypto trades, `getQuestState`), `ui/`
(messenger and map read `npc`, HUD reads `activeContract`, `getSquadContracts`, `credits`).

**Events emitted**: `meta:loaded`, `meta:creditsChanged {credits, delta, reason}`, `meta:repChanged {corp, rep, level, delta, levelUp}`,
`meta:contractAccepted`, `meta:contractAbandoned`, `meta:contractProgress`, `meta:contractSettled`, `meta:squadContract`,
`meta:purchase`, `meta:sale`, `meta:npcTrustChanged`, `npc:message`, `npc:unreadChanged`, `npc:questChanged {prev}`,
`npc:objectiveProgress {raid, done, delta}`, `npc:questReady`, `intel:purchased`, `intel:changed`, `ui:corpToggled {open, corp}`,
`ui:notify`, `audio:play`. Toasts for `meta:*` / `npc:*` events are drawn by `ui/`.

**Events consumed**: `game:newMission`, `game:complete`, `game:over`, `game:abort`, `game:phaseChanged`, `world:ready`, `hub:entered`,
`net:profileLoaded`, `net:gameStarting`, `net:lobbyUpdated`, `net:lobbyLeft`, `net:peerLeft`, `enemy:killed`, `enemy:squadKill`,
`crate:open`, `crate:looted`, `inventory:containerOpened`, `inventory:changed`, `inventory:quickSlotsChanged`, `stratagem:called`,
`fog:discovered`, `world:interacted`, `gather:collected`, `progress:loaded`, `progress:levelUp`; the corp view also refreshes on
`inventory:stashChanged`, `inventory:favoritesChanged`, `loadout:changed`, `housing:libraryChanged`.

**Wire** (`src/shared/net.ts`): `meta {ev: 'contractHit', corp, goal, amount}` (live squad share), `meta {ev: 'contract', id, progress}`
(each member's own contract for the squad HUD rows), `meta {ev: 'sync', corp, hits, rid}` (answer to a rejoiner),
`metaq {ev: 'sync', rid}` (sent by a rejoining client on `world:ready`). Credits use `credits:tx` through `ctx.net.profile`.

## Credits and trade

- **Credits are server-owned** whenever `ctx.net.profile` is available: `addCredits` applies locally, sends `credits:tx`, and the answer
  overwrites the balance (a refusal reverts). Offline / single-player the local save is the truth. Every reason string comes from
  `formatCreditReason` (`src/shared/credits.ts`); the relay checks the amount against `server/economy.gen.json`.
- **`creditsTx`** awaits the relay: local shortfall → `{ok:false}`, offline or delta 0 → `{ok:true}`, refusal → reverted, no answer →
  local apply reverted. Use it where the caller must change state only on success (intel, crypto trades).
- **Shop**: opens at `SHOP_UNLOCK_REP_LEVEL`. Items from `ctx.loot.getAllItemDefs()` filtered by the corp's `ShopRule`s (category, weapon
  class, ammo type, tactical bag, `minRepLevel`, `maxRarity`, `implantRepairMaterials`), rarity ≤ `SHOP_RARITY_CAP_BY_REP[level]`
  (+`SHOP_BAG_RARITY_BONUS` for bags), `value > 0`; uniques and broken implants are never sold.
- **One shelf slot = one purchase = `shopQtyOf(def)` units** (2026-09-16 사용자 결정): ammo comes as a **full stack** (`stackMax`),
  everything else as a single unit. So `ShopItem.price` is `buyPriceOf(value, level) × shopQtyOf(def)` and `canFit` is checked for that
  many units. The relay's `buy:<defId>` rule is a **lower** bound (`|delta| ≥ the best-discount price`), so the bigger amount still passes
  and `qty ≤ stackMax` holds by construction.
- **`buy`** is synchronous and answers "was the request accepted" (ship, on shelf, `canFit`, credits) and delivers `shopQtyOf(def)` units.
  With a server profile the item is created only after an `ok` answer; placement failure refunds with `refund:<def>`. Refusals go to
  `onPurchaseFailure(fn)` listeners; the screen refreshes on `meta:purchase`, never on `buy()`'s return value.
- **Selling**: bag + stash items with a value, equipped gear excluded. `sellPriceOf` floors (`shared/credits.sellPriceFrom` ×
  `SELL_PRICE_MUL`), so a value-1 single is worth 0 C and still sells; a 0 C chunk sends no `credits:tx` (the relay requires `delta > 0`).
  The server transaction is `sell:<def>:<qty>` per `stackMax` chunk; a refusal reverts credits and restores the units.
- **Trade desk**: stock tiles and inventory tiles are staged into buy/sell trays and settled together with a 1 s hold
  (`UI_HOLD_CONFIRM_S`) — sales first, then purchases in staging order. Selling a favorite item asks again (`HoldAsk`);
  `귀중품 전부 담기` skips favorites.
- **Implant repair desk** (Ceres): broken implants in bag + stash; fee `IMPLANT_REPAIR_FEE × grade` of the repaired def plus the item's
  `repairCost` materials. The fee takes the purchase path; `performRepair` re-validates, swaps the item (stash first) and fully refunds
  materials and credits on any failure.

## Contracts

- One active contract (`CONTRACT_MAX_ACTIVE`), accepted in the ship at `minRepLevel`; abandoning loses progress. Since 2026-09-17 every
  contract starts at 신뢰도 Lv.1 — Lv.0 → 1 comes from the corp NPCs' first quests (`q_ce_s1` / `q_nm_s1` `rewardRep`), not from contracts.
- **Corp access (2026-09-17)**: a corp below `CORP_ACCESS_REP_LEVEL` cannot be selected in the corp view (`CorpView.corpLock` — `.corp-tab.is-locked`,
  title and click toast `신뢰도 Lv.1 필요`; the selection falls to the first open corp in `resolveCorp`, `setCorpSilent` ignores locked
  corps). While every corp is below it the inventory hides the `기업` screen tab and `openCorpMenu` refuses (`anyCorpAccessible`).
- Goals (`ContractGoalKind`) count only during gameplay and never in the training sim: `enemy:killed` by the local player →
  `kill_rogues` for humanoid factions (from `enemies.csv` `faction`, scan drone excluded) else `kill_bugs`; `crate:open` → `open_crates`
  (once per crate id per raid); first open of a `corpse:` container → `loot_corpses`; own `stratagem:called` → `use_stratagems`;
  `inventory:changed.totalValue` mirrors `extract_with_value`.
- Squad share: a local hit is broadcast as `meta contractHit`; receivers count `amount × CONTRACT_SQUAD_SHARE` only for a contract of the
  same corp. Kill goals are never taken from `contractHit` — squad kills come from `enemy:squadKill` (host-authoritative deaths).
- **`extract_with_items`**: counts `ContractDef.itemDefId` carried on the body (bag grid + quick slots + pouch, never the stash) with
  `raidFound` of this raid, at settlement. It has no hits (`INVENTORY_GOALS`); relayed hits for it are dropped.
- **Settlement** (`settleMission`, called by `game/` before `game:complete`/`game:over`): NPC recover objectives settle first, then the
  contract: success = extracted ∧ progress ≥ target → rep (× library trust multiplier) and credits paid here, XP returned for `game/` to
  add; extracted but short keeps progress (item contracts reset to 0); death rolls back to the value at `game:newMission`.
  `outcome` = `success` \| `incomplete` \| `failed`; training returns `null`.

## 메신저 NPC 퀘스트

Quests come from NPCs through the messenger. Tables: `data/npcs.csv`, `npc_quests.csv`, `npc_objectives.csv` (loader `shared/npc.ts`);
engine: `NpcRules.ts`, `parts/NpcQuests.ts`, `parts/NpcObjectives.ts`; UI (messenger, map panels, toasts): `ui/`.

- **States**: hidden (not saved) → `offered` → `active` → `complete`. No abandon. Old saves may still hold `deferred`; `accept` takes it
  and logs `brief`. `defer()` always returns false.
- **Evaluation** (`evaluate`) runs only in the ship, not in the training sim, and not while any tutorial track is running **nor
  before the tutorial `ship` track is done** (`tutorialBlocks` — `ctx.tutorial.active` / `isTrackDone('ship')`; profiles that
  never had the tutorial answer done). So Raven's first contact lands after the ship track, at the first evaluation with no
  track running (build skipped → next `NPC_OFFER_CHECK_S`; build completed → the `hub:entered` after the first raid). Triggers:
  hub entry, profile load, progression load/level-up, rep change, after accept/report, and every `NPC_OFFER_CHECK_S`. An NPC whose requirements are met gets a first contact (`intro`); then, if it has no `offered` quest, the next hidden
  quest in file row order whose requirements are met is offered.
- **Log**: only events (`NpcLogEntry`) are saved (capped at `NPC_LOG_MAX`); `getMessages` re-renders text from the csv, so editing
  dialogue changes past conversations. Unread = events after the contact's `readAt`; `markRead` advances it; `readAtOf(npc)` exposes it
  so the messenger can type out unread bubbles (one event may expand into several bubbles with the same `at`).
- **`getQuests()`** returns accepted and completed quests only; offers appear as cards in the chat (`getQuest(id)` answers any state).
- **Objectives**: `deliver` (ship, bag + stash, partial delivery, `commitQuestTx`), and raid objectives `recover`, `interact`, `kill`
  (local last hit, optional weapon class), `discover` (structure discovery, squad-shared through fog), `search` (structure container,
  once per crate). Raid objectives count only while a real raid is active and the planet matches; progress is confirmed the moment it
  fills (kept on death); objectives sharing a `chain` value must fill in the same raid; `recover` confirms only at extraction settlement.
  `resetRaid` (new mission, complete, over, abort, hub entry) zeroes unconfirmed progress with negative deltas.
- **Report** (`report`): reward items are placed first (if any does not fit, placed ones are taken back and nothing changes) → credits
  `quest:<id>` (server ledger pays once per id) → corp rep per `rewardRep` (no library multiplier) → NPC trust → XP. Meta, stash and
  loadout documents commit in one profile transaction.

### 첫 연락 3단 · 진행 플래그

- **Three-step first contact**: `intro` → `introChoices` / `introChoiceReplies` → `introAfter` → quest card. Either answer leads to the
  same conversation; only a `choice` event (with the chosen index) is logged, no branch state.
- **`introPending(npc)`**: the NPC has `introAfter`, has no quest in any state, and has no `choice` event → `evaluate` skips its first
  offer. `chooseIntro` re-runs `evaluate()` immediately so the card follows the answer. The "no quest in any state" condition keeps
  old saves and console-forced offers from blocking the NPC's whole chain.
- **Progress flags** (`NPC_FLAGS`, `NpcSave.flags`, `flagOf`/`bumpFlag`): `gathered` on `gather:collected`, `raidReturned` on
  `game:complete` only when `missionMode === 'raid'` — tutorial and training must not count, or corp NPCs would contact the player
  right after the tutorial. Requirements read them through `reqFlag`.
- `sanitizeNpcSave` must carry `choice` events (index within the current `introChoices`) and `flags`; dropping either re-opens answered
  intros or resets contact conditions after a reload.

### NPC trust

Per-NPC trust (`NpcSave.trust`) is separate from corp reputation and uses the same `REP_TABLE` levels. Quests grant it via `npcTrust`
alongside `rewardRep`. It is not credits, so it never touches `credits:tx`. `NpcRequirement.npcRep` is evaluated by `requirementMet`
but no content gates on it yet.

## 정보상

`ctx.meta.intel` (`parts/Intel.ts`). Types, price formula and sanitizing live in `src/shared/intel.ts`; this folder holds no numbers.

- One held intel at a time; buying again overwrites without refund. `discard()` (re-roll area) refunds nothing.
- In a lobby only the squad leader can buy or discard (`canEdit`); members read `lobby.intel`. `syncLobby` pushes the held spec with
  `NetRef.setLobbyIntel` on `hub:entered` and `net:lobbyUpdated` (covers joins and leader transfer).
- Purchase waits for `creditsTx` with reason `intel:<planet>:<code>`; the held spec changes only on success. Refusals set
  `lastRefusal` + `ui:notify`.
- A held spec for another planet is kept (the hub screen labels it) and used at launch only when the planet matches
  (`hub/parts/Pods.usableIntel`). `game:newMission` arms it when the planet matches; `game:complete`/`over`/`abort` consume it only if armed.
- Saved in `MetaSave.intel` through `sanitizeMetaSave` → `sanitizeIntelSpec`.

## Rules

- **Every save field must round-trip through `sanitizeMetaSave` / `sanitizeNpcSave`** (`npc`, `trust`, `flags`, `choice` log, `intel`);
  a field the sanitizer drops disappears on the next reload or server document. — `Storage.ts`, `NpcRules.ts`
- **Subscription order matters**: `NpcQuests.subscribe()` and `Intel.subscribe()` are pushed after the `net:profileLoaded` handler that
  replaces the store, so they evaluate against the server document. — `MetaSystem.init`
- **Relayed `meta` messages** are accepted only from a connected lobby member other than self; `contractHit` needs whitelisted corp/goal,
  a finite amount in `1..META_HIT_MAX`, passes a per-sender per-goal token bucket (`META_HIT_RATE`); `sync` answers must echo this
  client's `rid` and are accepted once per peer. Each peer answers a rejoiner once per mission. — `parts/Credits.ts`
- **No credit or sell-price multipliers on the client**: the relay validates credit amounts per reason, so a client-side bonus becomes a
  refused `credits:tx`. Reputation and NPC trust are local and may be multiplied.
- **The embedded corp view owns no blocker, cursor mode, pointer lock or window Escape listener** — the inventory Tab window owns them;
  `dispose()` removes only what the view added. Several views may exist, hence listener sets for purchase failures and repairs.
- **Credit readouts go through `formatCredits` / `formatCreditAmount`** (`@/shared`); `ui/dom.fmtNum` is for non-credit numbers.
- **Corp page cell size** is 40 px and `fitLayout` shrinks it to 32 px to keep all cards in one row; below that the stash + bag card is
  hidden (`.is-inv-hidden`). The stash + bag card holds both grids side by side, so its columns are summed (`gridColsIn(…, 'sum')`).
- **기업 판매 물품 is a fixed `SHOP_COLS` (10) columns wide** — a content-sized card, not `.is-fluid` any more. `CorpView.SHOP_COLS`,
  its `data-cv-cols` and `.cv-col.shop`'s `min-width` in `meta.css` are the same number and change together.
- **Every desk tile wears its price in the same corner — bottom-left** (`.cv-price`): 매대 · 구매칸 · 판매칸 · 임플란트 데스크. The
  quantity badges (`.cv-count`, `.cv-staged`, the inventory qty) sit bottom-right, so the two never collide. — `meta.css`
- **매대 · 구매칸 tiles hide the durability gauge** (`.cv-tile.shop .inv-tile-dur`, `.cv-tile.buy`): the corp's stock is new, so the bar was
  always full on every gun. The tile builder is the bag grid's own (`InventoryRef.buildItemTile`), so it is hidden here, never removed
  there; the hover card still prints 내구도. The 판매칸 keeps it — that is the real state of the item being sold. — `meta.css`
- **Trade tiles say the screen's price, not 가치** — a tile stamped `data-tip-price` (credits) + `data-tip-price-label` (Korean) makes the
  shared hover card (`ui/hud/ItemTip`, `TIP_PRICE_ATTR`) replace its bottom-right bar: 구매가 on the shelf / 구매 tray, 판매가 on the
  판매 tray. The stash + bag grids stamp nothing, so they keep 가치 (`CorpView.tagTipPrice`).
- `.cv-confirm`'s `textContent` includes the keycap SVG `<title>` (`LMB거래 성사`); read the label from `.cv-confirm-label`.
- `.inv-screen.corp-view`'s `height: calc(100vh - 130px)` mirrors inventory's `.inv-screen` `max-height`; change both together.
- Folder split: `model.ts` holds shared vocabulary, `parts/*.ts` take `sys: MetaSystem` as first argument and import only types from
  `MetaSystem.ts`; members reached by `parts/` are public but not an external contract.
- **Nothing is locked by per-NPC trust** (2026-09-14 user decision — accrue and display only). `NpcRequirement.npcRep` and
  csv `reqNpcRep` have a loader and a check but zero readers; what to unlock is a decision first.
- **The collectible super-category is an axis, not an objective type** (2026-09-16 user decision). `SuperCategory` /
  `categoryPathKo` exist, but no objective counts them: a quest like 「가치 10,000 이상의 수집품 납품」 needs a value-sum
  objective in `npc_objectives.csv` counted here with `superCategoryOf`. Only the five library media carry one today.

## Recent changes

Last 5 only — older: `git log -- src/meta`.

- 2026-09-17 — Corp access gate: Lv.0 corps are locked in the corp rail (`corpLock`, `resolveCorp`, `.corp-tab.is-locked`), `openCorpMenu` refuses while no corp is Lv.1 (`anyCorpAccessible`); every contract's `minRepLevel` +1; `q_ce_s1` / `q_nm_s1` grant 100 rep (→ Lv.1).
- 2026-09-16 — Trade desk tile pass: the price badge is bottom-left everywhere (판매칸 no longer top-left), the 구매칸 got one at all, 매대 · 구매칸 hide the always-full durability gauge, and the 총 크레딧 변동 line lost its ▲ ▼ chevrons (sign + colour already say it).
- 2026-09-16 — Ammo is sold as a full stack (`shopQtyOf`), trade tiles show 구매가 / 판매가 instead of 가치 (`data-tip-price`), shelf fixed at 10 columns, quest XP in `rewardSummary` uses the compact formatter.
- 2026-09-15 — NPC evaluation waits for the tutorial `ship` track to finish and for no track to run (`tutorialBlocks`); Raven no longer writes during the tutorial.
- 2026-09-15 — Corp screen: stash + bag is one card (`createTradeGrids` once, columns summed in `fitLayout`).
