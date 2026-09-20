/**
 * The **economy table** the server validates credits against — build · check · staleness (2026-09-11, E-4 ⑦).
 *
 * The relay checks the amount in `credits:tx {delta, reason}` against `server/economy.gen.json`
 * (`server/Economy.ts`). The relay cannot run the Vite csv loader and `ItemDef.value` is derived by
 * `src/items/` (the weapon grade steps · the armor formula · the broken-implant division …), so the table is
 * built by reading **the same code the client reads** through a headless Vite — the rules are not written out
 * again here. `scripts/data-check.mjs` calls it with the Vite server it has already started:
 *
 *   npm run data:check              checks the table against the csv (a mismatch = fail + the command to fix it)
 *   npm run data:check -- --write   rebuilds and writes the table → commit it
 *
 * The check (`problems`) runs every time, including after the table has been written: whether the table price
 * formulas (`credits.tableBuyPrice` · `tableSellPrice` · `tableMinBuyPrice`) give the same value as the game
 * (`shared/meta.buyPriceOf` · `sellPriceOf` · the shop `meta/Rules.buildShop` · the repair fee
 * `implantRepairFee`) for **every item × every 신뢰도 level × every quantity**, whether everything the shop
 * sells is in the table, and whether every reason string round-trips through the grammar within 64 characters.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ECONOMY_TABLE_PATH = resolve(ROOT, 'server', 'economy.gen.json');
export const ECONOMY_TABLE_REL = 'server/economy.gen.json';
export const ECONOMY_WRITE_HINT = 'npm run data:check -- --write';

const sortedObject = (entries) => Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

/** Build the table from the live client modules (`server` = a Vite dev server in middleware mode). */
export async function buildEconomyTable(server) {
  const shared = await server.ssrLoadModule('/src/shared/index.ts');
  const itemsMod = await server.ssrLoadModule('/src/items/ItemDefs.ts');
  const rules = await server.ssrLoadModule('/src/meta/Rules.ts');
  const defs = itemsMod.ITEM_DEFS;
  const byId = itemsMod.ITEM_DEF_MAP;

  const items = [];
  for (const d of defs) if (d.value > 0) items.push([d.id, { value: d.value, stack: Math.max(1, Math.floor(d.stackMax || 1)) }]);
  const repairFees = [];
  for (const d of defs) {
    if (!rules.isRepairableImplantDef(d)) continue;
    const target = byId.get(d.implant.repairsTo);
    if (target) repairFees.push([d.id, rules.implantRepairFee(target)]);
  }
  const contracts = shared.CONTRACT_DEFS.map((c) => [c.id, c.creditsReward]);
  // 2026-09-14: corp quests were dropped — `quest:<id>` is an NPC quest credit reward
  //   (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」)
  const quests = shared.NPC_QUEST_DEFS.filter((q) => (q.rewards.credits ?? 0) > 0).map((q) => [q.id, q.rewards.credits]);

  const table = {
    v: 1,
    hash: '',
    creditsInitial: shared.CREDITS_INITIAL,
    creditsMax: shared.CREDITS_MAX,
    shopPriceBaseMul: shared.SHOP_PRICE_BASE_MUL,
    shopPriceDiscountPerRep: shared.SHOP_PRICE_DISCOUNT_PER_REP,
    shopPriceMinMul: shared.SHOP_PRICE_MIN_MUL,
    sellPriceMul: shared.SELL_PRICE_MUL,
    repLevelMax: shared.REP_LEVEL_MAX,
    /* 2026-09-13: the rover fare range (`rover:<from>:<to>`) — the route distance differs per seed, so the
       relay only checks the range */
    roverFareMin: shared.ROVER_FARE_MIN,
    roverFareMax: shared.ROVER_FARE_MAX,
    /* 2026-09-13: crypto — read by the relay's quote simulation (`server/CryptoMarket.ts`) and by the `cbuy:` ·
       `csell:` validation */
    crypto: {
      unitsPerCoin: shared.CRYPTO_UNITS_PER_COIN,
      fee: shared.CRYPTO_TRADE_FEE,
      maxUnits: shared.CRYPTO_TRADE_MAX_UNITS,
      quoteWindowMs: Math.round(shared.CRYPTO_QUOTE_WINDOW_S * 1000),
      tickMs: Math.round(shared.CRYPTO_TICK_S * 1000),
      coins: sortedObject(shared.CRYPTO_COIN_DEFS.map((d) => [d.id, d.unlockQuest
        ? { basePrice: d.basePrice, volatility: d.volatility, unlockQuest: d.unlockQuest }
        : { basePrice: d.basePrice, volatility: d.volatility }])),
    },
    /* 2026-09-14: the intel broker — the relay checks the `intel:<planet>:<code>` amount with **the same
       `intelCost`** (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
    intel: {
      options: sortedObject(shared.INTEL_OPTION_DEFS.map((d) => [d.id, { baseCost: d.baseCost, maxTier: d.maxTier }])),
      tierMul: shared.INTEL_COST_TABLE.tierMul,
      bundleMul: shared.INTEL_COST_TABLE.bundleMul,
      threatMul: shared.INTEL_COST_TABLE.threatMul,
      planetThreat: sortedObject(shared.PLANET_DEFS.map((p) => [p.id, p.threat])),
    },
    items: sortedObject(items),
    repairFees: sortedObject(repairFees),
    contracts: sortedObject(contracts),
    quests: sortedObject(quests),
  };
  table.hash = shared.economyTableDigest(table);
  return table;
}

/** Every way the table could disagree with the game. Empty = the relay prices exactly like the client. */
export async function checkEconomyTable(server, table) {
  const shared = await server.ssrLoadModule('/src/shared/index.ts');
  const itemsMod = await server.ssrLoadModule('/src/items/ItemDefs.ts');
  const weapons = await server.ssrLoadModule('/src/items/WeaponDefs.ts');
  const rules = await server.ssrLoadModule('/src/meta/Rules.ts');
  const out = [];
  const push = (m) => { if (out.length < 40) out.push(m); else if (out.length === 40) out.push('… (더 있음)'); };

  const levels = Array.from({ length: shared.REP_LEVEL_MAX + 1 }, (_, i) => i);
  for (const [id, it] of Object.entries(table.items)) {
    for (const lv of levels) {
      const game = shared.buyPriceOf(it.value, lv), tab = shared.tableBuyPrice(table, it.value, lv);
      if (game !== tab) push(`${id}: 구매가 Lv.${lv} 게임 ${game} ≠ 표 ${tab}`);
    }
    const best = shared.buyPriceOf(it.value, shared.REP_LEVEL_MAX), min = shared.tableMinBuyPrice(table, it.value);
    if (best !== min) push(`${id}: 최저 구매가 게임 ${best} ≠ 표 ${min}`);
    for (const lv of levels) if (shared.buyPriceOf(it.value, lv) < min) push(`${id}: Lv.${lv} 구매가가 표의 최저가 ${min} 보다 싸다`);
    for (let q = 1; q <= it.stack; q++) {
      const game = shared.sellPriceOf(it.value, q), tab = shared.tableSellPrice(table, it.value, q);
      if (game !== tab) { push(`${id}: 판매가 ×${q} 게임 ${game} ≠ 표 ${tab}`); break; }
    }
  }

  /* Every row the shop sells must be in the table at the same value — a missing one makes the server refuse
     that purchase. */
  const all = itemsMod.ITEM_DEFS;
  for (const corp of Object.values(shared.CORP_DEFS)) {
    for (const lv of levels) {
      for (const line of rules.buildShop(corp, all, lv, Number.MAX_SAFE_INTEGER, true, (id) => weapons.getWeaponDef(id))) {
        const it = table.items[line.def.id];
        if (!it) { push(`${corp.id} Lv.${lv}: 상점이 파는 ${line.def.id} 가 표에 없다 (value ${line.def.value})`); continue; }
        /* 2026-09-16 (user's decision): an ammo shelf slot is a **full stack**, so one slot costs `table ×
           bundle size` (`Rules.shopQtyOf`). The table itself keeps the single-unit value — the relay `buy:`
           check is a floor ("was less than this paid?"), so the bundle value (the larger one) passes as it is.
           Without multiplying by the bundle size here, this invariant alone would break falsely. */
        const want = shared.tableBuyPrice(table, it.value, lv) * rules.shopQtyOf(line.def);
        if (line.price !== want) push(`${corp.id} Lv.${lv}: ${line.def.id} 상점가 ${line.price} ≠ 표 ${want}`);
      }
    }
  }

  for (const d of all) {
    if (!rules.isRepairableImplantDef(d)) continue;
    const target = itemsMod.ITEM_DEF_MAP.get(d.implant.repairsTo);
    if (!target) { push(`${d.id}: 수리 결과 ${d.implant.repairsTo} 가 없다`); continue; }
    if (table.repairFees[d.id] !== rules.implantRepairFee(target)) push(`${d.id}: 수리비 게임 ${rules.implantRepairFee(target)} ≠ 표 ${table.repairFees[d.id]}`);
  }

  /* Reason grammar: 64 characters · a round trip. For sell the longest form is measured at the maximum
     quantity (a stack). */
  const reasons = [];
  for (const [id, it] of Object.entries(table.items)) {
    reasons.push({ kind: 'buy', id }, { kind: 'refund', id }, { kind: 'sell', id, qty: it.stack });
  }
  for (const id of Object.keys(table.repairFees)) reasons.push({ kind: 'repair', id }, { kind: 'refund-repair', id });
  for (const id of Object.keys(table.contracts)) reasons.push({ kind: 'contract', id });
  for (const id of Object.keys(table.quests)) reasons.push({ kind: 'quest', id });
  for (const r of reasons) {
    const raw = shared.formatCreditReason(r);
    const back = shared.parseCreditReason(raw);
    if (!back || back.kind !== r.kind || back.id !== r.id || (r.qty !== undefined && back.qty !== r.qty)) push(`사유 ${raw} 가 문법을 왕복하지 못한다 (id 에 [a-z0-9_] 밖의 글자이거나 64자 초과)`);
  }
  /* 2026-09-13: the rover fare — integers with 0 < MIN ≤ MAX, and the reason `rover:<from>:<to>` round-trips */
  if (!Number.isInteger(table.roverFareMin) || !Number.isInteger(table.roverFareMax) || table.roverFareMin <= 0 || table.roverFareMin > table.roverFareMax) {
    push(`탐사 차량 요금 범위 ${table.roverFareMin}…${table.roverFareMax} 가 0 < ROVER_FARE_MIN ≤ ROVER_FARE_MAX 인 정수가 아니다`);
  }
  const rov = shared.parseCreditReason(shared.formatCreditReason({ kind: 'rover', id: 'rst0', to: 'rst4' }));
  if (!rov || rov.kind !== 'rover' || rov.id !== 'rst0' || rov.to !== 'rst4') push('사유 rover:rst0:rst4 가 문법을 왕복하지 못한다');
  /* 2026-09-13: crypto — the coins match the csv, the numbers are usable, a locked coin quest can reach the
     ledger as `quest:` (with no credit reward that coin can never be traded on the server), and the longest
     `cbuy` · `csell` reason round-trips within 64 characters */
  const cx = table.crypto;
  if (!cx) push('crypto 절이 없다 — 릴레이가 시세를 돌리지 않고 모든 cbuy / csell 을 거절한다');
  else {
    if (!(cx.unitsPerCoin >= 1) || !(cx.fee >= 0 && cx.fee < 1) || !(cx.maxUnits >= 1) || !(cx.quoteWindowMs >= 0) || !(cx.tickMs >= 1000)) {
      push(`crypto 수치가 이상하다 (unitsPerCoin ${cx.unitsPerCoin} · fee ${cx.fee} · maxUnits ${cx.maxUnits} · quoteWindowMs ${cx.quoteWindowMs} · tickMs ${cx.tickMs})`);
    }
    const defs = shared.CRYPTO_COIN_DEFS;
    if (Object.keys(cx.coins).length !== defs.length) push(`crypto 코인 수 ${Object.keys(cx.coins).length} ≠ data/crypto.csv ${defs.length}`);
    for (const d of defs) {
      const c = cx.coins[d.id];
      if (!c || c.basePrice !== d.basePrice || c.volatility !== d.volatility || (c.unlockQuest ?? null) !== (d.unlockQuest ?? null)) push(`crypto ${d.id}: 표가 csv 와 다르다`);
      if (d.unlockQuest && table.quests[d.unlockQuest] === undefined) push(`crypto ${d.id}: 해금 퀘스트 ${d.unlockQuest} 에 크레딧 보상이 없어 원장에 오르지 않는다 — 서버가 이 코인의 매매를 영영 거절한다`);
      for (const kind of ['crypto-buy', 'crypto-sell']) {
        const raw = shared.formatCreditReason({ kind, id: d.id, qty: cx.maxUnits });
        const back = shared.parseCreditReason(raw);
        if (!back || back.kind !== kind || back.id !== d.id || back.qty !== cx.maxUnits) push(`사유 ${raw} 가 문법을 왕복하지 못한다`);
      }
    }
  }
  /* 2026-09-14: the intel broker — the table matches the csv, every planet has a threat, the longest reason
     round-trips within 64 characters, and for every combination of picks the game and the relay produce the
     same amount from **the same formula** (there is one formula, `shared/intel.intelCost`). */
  const ix = table.intel;
  if (!ix) push('intel 절이 없다 — 릴레이가 모든 정보상 구매를 거절한다');
  else {
    const defs = shared.INTEL_OPTION_DEFS;
    if (Object.keys(ix.options).length !== defs.length) push(`intel 옵션 수 ${Object.keys(ix.options).length} ≠ data/intel_options.csv ${defs.length}`);
    for (const d of defs) {
      const o = ix.options[d.id];
      if (!o || o.baseCost !== d.baseCost || o.maxTier !== d.maxTier) push(`intel ${d.id}: 표가 csv 와 다르다`);
      if (!Number.isInteger(d.baseCost) || d.baseCost <= 0) push(`intel ${d.id}: baseCost ${d.baseCost} 가 양의 정수가 아니다`);
    }
    if (!(ix.tierMul.length >= shared.INTEL_TIER_MAX)) push(`INTEL_TIER_COST_MUL 이 ${shared.INTEL_TIER_MAX} 단계를 다 덮지 않는다 (${ix.tierMul.length}개)`);
    if (!(ix.bundleMul >= 1)) push(`INTEL_BUNDLE_COST_MUL ${ix.bundleMul} 은 1 이상이어야 한다 (누진 배수)`);
    for (const p of shared.PLANET_DEFS) {
      if (ix.planetThreat[p.id] !== p.threat) push(`intel planetThreat ${p.id} 이 csv 와 다르다`);
      const ti = Math.max(0, Math.min(ix.threatMul.length - 1, Math.round(p.threat) - 1));
      if (!(ix.threatMul[ti] > 0)) push(`INTEL_THREAT_COST_MUL 에 ${p.id}(threat ${p.threat}) 의 배수가 없다`);
    }
    /* The reason round trip with the longest code of all the combinations (7 gimmicks × tier 0..max) plus a
       game ↔ table amount match. There are fewer than 3^7 combinations, so all of them are walked. */
    const all = defs.map((d) => d.id);
    const worst = defs.map((d) => ({ g: d.id, tier: d.maxTier }));
    const raw = shared.formatCreditReason({ kind: 'intel', id: shared.PLANET_DEFS[0].id, code: shared.intelCode(worst) });
    const back = shared.parseCreditReason(raw);
    if (!back || back.kind !== 'intel' || back.id !== shared.PLANET_DEFS[0].id || back.code !== shared.intelCode(worst)) {
      push(`사유 ${raw} 가 문법을 왕복하지 못한다 (64자 초과이거나 코드 글자가 문법 밖이다)`);
    }
    let combos = 0;
    const walk = (i, picks) => {
      if (combos > 4000) return;
      if (i >= all.length) {
        if (picks.length === 0) return;
        combos++;
        for (const p of shared.PLANET_DEFS) {
          const code = shared.intelCode(picks);
          const parsed = shared.parseIntelCode(code);
          if (!parsed) { push(`정보 코드 ${code} 를 되읽지 못한다`); return; }
          const game = shared.intelCost(p.threat, picks, shared.INTEL_COST_TABLE);
          const relay = shared.intelCost(ix.planetThreat[p.id], parsed, ix);
          if (game !== relay) { push(`intel ${code} @ ${p.id}: 게임 ${game} ≠ 표 ${relay}`); return; }
          if (!Number.isInteger(game) || game <= 0) { push(`intel ${code} @ ${p.id}: 금액 ${game} 이 양의 정수가 아니다`); return; }
        }
        return;
      }
      const def = defs[i];
      for (let t = 0; t <= def.maxTier; t++) walk(i + 1, t === 0 ? picks : [...picks, { g: def.id, tier: t }]);
    };
    walk(0, []);
  }
  for (const [id, n] of [...Object.entries(table.contracts), ...Object.entries(table.quests), ...Object.entries(table.repairFees)]) {
    if (!Number.isInteger(n) || n < 0) push(`${id}: 크레딧 ${n} 이 0 이상의 정수가 아니다`);
  }
  if (table.hash !== shared.economyTableDigest(table)) push(`표의 hash ${table.hash} 가 본문 digest 와 다르다`);
  return out;
}

/** Deterministic text: one map entry per line so a csv edit reads as a one-line diff. */
export function formatEconomyTable(t) {
  const lines = ['{'];
  const keys = Object.keys(t);
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    const v = t[k];
    if (k === 'crypto' && v && typeof v === 'object') {
      /* 2026-09-13: one coin per line (a csv edit of one coin stays a one-line diff) */
      lines.push(`  ${JSON.stringify(k)}: {`);
      const ents = Object.entries(v);
      ents.forEach(([ek, ev], j) => {
        const c = j < ents.length - 1 ? ',' : '';
        if (ek === 'coins' && ev && typeof ev === 'object') {
          const coins = Object.entries(ev);
          lines.push(`    ${JSON.stringify(ek)}: {`);
          coins.forEach(([ck, cv], n) => lines.push(`      ${JSON.stringify(ck)}: ${JSON.stringify(cv)}${n < coins.length - 1 ? ',' : ''}`));
          lines.push(`    }${c}`);
        } else lines.push(`    ${JSON.stringify(ek)}: ${JSON.stringify(ev)}${c}`);
      });
      lines.push(`  }${comma}`);
      return;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ents = Object.entries(v);
      if (ents.length === 0) { lines.push(`  ${JSON.stringify(k)}: {}${comma}`); return; }
      lines.push(`  ${JSON.stringify(k)}: {`);
      ents.forEach(([ek, ev], j) => lines.push(`    ${JSON.stringify(ek)}: ${JSON.stringify(ev)}${j < ents.length - 1 ? ',' : ''}`));
      lines.push(`  }${comma}`);
    } else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * `data:check` entry. Returns `{ problems, stale, wrote, table }`: `problems` = pricing disagreements (always a failure),
 * `stale` = the committed file differs from what the csv produce now (a failure unless `write`).
 */
export async function runEconomyTable(server, { write = false } = {}) {
  const table = await buildEconomyTable(server);
  const problems = await checkEconomyTable(server, table);
  const text = formatEconomyTable(table);
  const current = existsSync(ECONOMY_TABLE_PATH) ? readFileSync(ECONOMY_TABLE_PATH, 'utf8').replace(/\r\n/g, '\n') : null;
  let stale = current !== text;
  let wrote = false;
  if (stale && write && problems.length === 0) {
    writeFileSync(ECONOMY_TABLE_PATH, text, 'utf8');
    wrote = true;
    stale = false;
  }
  return { problems, stale, wrote, table, missing: current === null };
}
