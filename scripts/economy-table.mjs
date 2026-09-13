/**
 * 서버 크레딧 검증용 **경제 표** — 생성 · 검산 · 최신 여부 (2026-09-11, E-4 ⑦).
 *
 * 릴레이는 `credits:tx {delta, reason}` 의 금액을 `server/economy.gen.json` 으로 검사한다 (`server/Economy.ts`).
 * 릴레이는 Vite csv 로더를 못 돌리고 `ItemDef.value` 는 `src/items/` 가 파생하므로(무기 등급 단계 · 방탄복 공식 ·
 * 망가진 임플란트 나눗셈 …), 표는 **클라이언트와 같은 코드**를 헤드리스 Vite 로 읽어서 만든다 — 규칙을 여기에
 * 다시 적지 않는다. `scripts/data-check.mjs` 가 이미 띄운 Vite 서버를 넘겨받아 부른다:
 *
 *   npm run data:check              표가 csv 와 같은지 검사 (다르면 실패 + 고치는 명령 안내)
 *   npm run data:check -- --write   표를 다시 만들어 쓴다 → 커밋한다
 *
 * 검산(`problems`)은 표를 쓴 뒤에도 매번 돈다: 표의 가격 식(`credits.tableBuyPrice` · `tableSellPrice` ·
 * `tableMinBuyPrice`)이 게임의 `shared/meta.buyPriceOf` · `sellPriceOf` · 상점(`meta/Rules.buildShop`) · 수리비
 * (`implantRepairFee`)와 **모든 아이템 × 모든 신뢰도 레벨 × 모든 수량**에서 같은 값인지, 상점이 파는 모든 물건이
 * 표에 있는지, 모든 사유 문자열이 64자 안에서 문법을 왕복하는지.
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
  // 2026-09-14: 기업 퀘스트 폐지 — `quest:<id>` 는 NPC 퀘스트의 크레딧 보상이다 (docs/plans/messenger-quests.md)
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
    /* 2026-09-13: 탐사 차량 요금 범위 (`rover:<from>:<to>`) — 경로 거리는 시드마다 달라 릴레이는 범위만 본다 */
    roverFareMin: shared.ROVER_FARE_MIN,
    roverFareMax: shared.ROVER_FARE_MAX,
    /* 2026-09-13: 암호화폐 — 릴레이의 시세 시뮬레이션(`server/CryptoMarket.ts`)과 `cbuy:` · `csell:` 검증이 읽는다 */
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

  /* 상점이 파는 모든 줄이 표에 있고 같은 값이어야 한다 — 없으면 그 구매가 서버에서 거절된다. */
  const all = itemsMod.ITEM_DEFS;
  for (const corp of Object.values(shared.CORP_DEFS)) {
    for (const lv of levels) {
      for (const line of rules.buildShop(corp, all, lv, Number.MAX_SAFE_INTEGER, true, (id) => weapons.getWeaponDef(id))) {
        const it = table.items[line.def.id];
        if (!it) { push(`${corp.id} Lv.${lv}: 상점이 파는 ${line.def.id} 가 표에 없다 (value ${line.def.value})`); continue; }
        if (line.price !== shared.tableBuyPrice(table, it.value, lv)) push(`${corp.id} Lv.${lv}: ${line.def.id} 상점가 ${line.price} ≠ 표 ${shared.tableBuyPrice(table, it.value, lv)}`);
      }
    }
  }

  for (const d of all) {
    if (!rules.isRepairableImplantDef(d)) continue;
    const target = itemsMod.ITEM_DEF_MAP.get(d.implant.repairsTo);
    if (!target) { push(`${d.id}: 수리 결과 ${d.implant.repairsTo} 가 없다`); continue; }
    if (table.repairFees[d.id] !== rules.implantRepairFee(target)) push(`${d.id}: 수리비 게임 ${rules.implantRepairFee(target)} ≠ 표 ${table.repairFees[d.id]}`);
  }

  /* 사유 문법: 64자 · 왕복. sell 은 최대 수량(스택)으로 가장 긴 형태를 잰다. */
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
  /* 2026-09-13: 탐사 차량 요금 — 0 < MIN ≤ MAX 정수, 사유 `rover:<from>:<to>` 왕복 */
  if (!Number.isInteger(table.roverFareMin) || !Number.isInteger(table.roverFareMax) || table.roverFareMin <= 0 || table.roverFareMin > table.roverFareMax) {
    push(`탐사 차량 요금 범위 ${table.roverFareMin}…${table.roverFareMax} 가 0 < ROVER_FARE_MIN ≤ ROVER_FARE_MAX 인 정수가 아니다`);
  }
  const rov = shared.parseCreditReason(shared.formatCreditReason({ kind: 'rover', id: 'rst0', to: 'rst4' }));
  if (!rov || rov.kind !== 'rover' || rov.id !== 'rst0' || rov.to !== 'rst4') push('사유 rover:rst0:rst4 가 문법을 왕복하지 못한다');
  /* 2026-09-13: 암호화폐 — 코인이 csv 와 같고, 수치가 쓸 만하고, 잠긴 코인의 퀘스트가 `quest:` 로 원장에 오를 수 있고(크레딧 보상이 없으면
     그 코인은 서버에서 영영 거래할 수 없다), 가장 긴 `cbuy` · `csell` 사유가 64자 안에서 왕복한다 */
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
