import { csvRows } from './data/tables';
import { CORP_DEFS, CORP_IDS, type CorpId } from './meta';

/* ────────────────────────────────────────────────────────────────────────────
 * 재화 (2026-09-09) — 아이템이 **아닌** 보상 단위: 크레딧 · 경험치 · 기업별 신뢰도.
 *
 * 계약과 퀘스트의 보상은 지금까지 `신뢰도 +12 · XP +40 · 크레딧 +1,200` 같은 한 줄 텍스트였다. 화면에서
 * 아이템 보상은 썸네일인데 재화 보상만 글자였으므로, 같은 자리에 같은 크기로 서는 **재화 칩**을 만든다.
 * `itemChip.ts` 와 짝이고 그 옆에 사는 이유도 같다 — 계약(meta/) · 퀘스트(meta/) · 임무 결산(ui/) · 진행도
 * (progression/) 가 서로를 import 하지 않고 똑같은 칩을 그리게 하는 유일한 자리다.
 *
 * **아이템과 구분되는 틀.** 아이템 칩은 네모 썸네일(`.item-chip-thumb`)이고 재화 칩은 **모서리를 깎은 육각
 * 프레임**(`.currency-chip`)이다 — 크기 · 간격 · 개수 표기는 아이템 칩과 같은 규칙을 쓰므로 한 줄에 섞여도
 * 줄이 맞고, 한눈에 "이건 물건이 아니다" 가 읽힌다. 툴팁도 같은 카드(`ui/hud/ItemTip`)를 쓰되 헤더에
 * `재화` 배지가 붙는다 (`.item-tip.is-currency`).
 *
 * **확장.** `data/currencies.csv` 에 줄을 더하면 새 재화가 생긴다. 신뢰도만 특별히 **템플릿 줄**이라
 * `data/corps.csv` 의 기업마다 `rep:<기업id>` 로 한 벌씩 불어나고, 이름 · 색 · 설명은 그 기업의 것을 쓴다 —
 * 신뢰도는 기업마다 별개의 재화이고 썸네일도 기업 색으로 달라야 하기 때문이다.
 *
 * 이 모듈은 `itemChip.ts` 처럼 **문맥을 만지지 않고 데이터만 받아 DOM 을 만든다.** 리스너도 상태도 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 재화의 갈래. 새 갈래를 넣을 때는 `data/currencies.csv` 의 `kind` 칸과 이 합집합을 같이 넓힌다. */
export type CurrencyKind = 'credits' | 'xp' | 'rep';

/** 기업 신뢰도 재화의 id (`rep:helix` …). */
export type RepCurrencyId = `rep:${CorpId}`;

/** 재화 id. 신뢰도는 기업마다 하나씩 있으므로 단순 열거가 아니다. */
export type CurrencyId = 'credits' | 'xp' | RepCurrencyId;

export interface CurrencyDef {
  id: CurrencyId;
  kind: CurrencyKind;
  /** 한국어 표시 이름 (신뢰도는 `헬릭스 방산 신뢰도`). */
  name: string;
  /** 썸네일에 찍는 글리프 한 자. */
  icon: string;
  /** 썸네일 · 툴팁 제목 색. 신뢰도는 기업 색. */
  color: string;
  description: string;
  /** 신뢰도일 때 그 기업. 그 외에는 없다. */
  corp?: CorpId;
}

/** 기업 신뢰도 재화의 id 를 만든다. */
export function repCurrencyId(corp: CorpId): RepCurrencyId { return `rep:${corp}`; }

/* ── data/currencies.csv → 정의 표 ────────────────────────────────────────── */

interface RawRow { id: string; kind: CurrencyKind; name: string; icon: string; color: string; description: string }

const RAW: readonly RawRow[] = csvRows('currencies.csv').map((r) => ({
  id: r.str('id'),
  kind: r.str('kind') as CurrencyKind,
  name: r.str('name'),
  icon: r.str('icon'),
  color: r.str('color'),
  description: r.str('description'),
}));

function buildDefs(): Record<CurrencyId, CurrencyDef> {
  const out = {} as Record<CurrencyId, CurrencyDef>;
  for (const row of RAW) {
    if (row.kind === 'rep') {
      // 템플릿 줄: 기업마다 한 벌. 이름 · 색은 기업의 것을 쓰고 설명만 표의 것을 그대로 잇는다.
      for (const corp of CORP_IDS) {
        const corpDef = CORP_DEFS[corp];
        const id = repCurrencyId(corp);
        out[id] = {
          id,
          kind: 'rep',
          name: `${corpDef?.name ?? corp} ${row.name}`,
          icon: row.icon,
          color: corpDef?.color ?? row.color,
          description: `${corpDef?.name ?? corp}: ${row.description}`,
          corp,
        };
      }
      continue;
    }
    const id = row.id as CurrencyId;
    out[id] = { id, kind: row.kind, name: row.name, icon: row.icon, color: row.color, description: row.description };
  }
  return out;
}

export const CURRENCY_DEFS: Readonly<Record<CurrencyId, CurrencyDef>> = buildDefs();

/** 정의된 재화 id 전부 (표 순서 → 기업 순서). */
export const CURRENCY_IDS: readonly CurrencyId[] = Object.keys(CURRENCY_DEFS) as CurrencyId[];

/** 없는 id 면 undefined — 지워진 재화를 참조하는 낡은 세이브가 화면을 깨지 않게 한다. */
export function currencyDef(id: string): CurrencyDef | undefined {
  return CURRENCY_DEFS[id as CurrencyId];
}

/** 하나의 재화 보상. 계약 · 퀘스트가 이 배열로 보상을 넘긴다. */
export interface CurrencyReward {
  id: CurrencyId;
  amount: number;
}

/* ── 칩 ──────────────────────────────────────────────────────────────────── */

export interface CurrencyChipOptions {
  /** 수량. 없으면 개수 없는 맨 칩. */
  amount?: number;
  /** 썸네일 한 변(px). 기본 34 — 아이템 칩과 같다. */
  size?: number;
  /** 썸네일 아래에 이름을 적는다. */
  withName?: boolean;
  /** 앞에 `+` 를 붙인다 (보상 표시). 음수는 언제나 `−`. */
  signed?: boolean;
  /** `<button>` 으로 만든다. */
  button?: boolean;
  /** 네이티브 title. 기본값은 없다 — 호버 카드(`ui/hud/ItemTip`)가 대신 뜬다. */
  title?: string;
}

/** 알 수 없는 재화 id 를 만났을 때의 대체 표시. */
const UNKNOWN: CurrencyDef = {
  id: 'credits', kind: 'credits', name: '알 수 없는 재화', icon: '?', color: '#7b828c', description: '',
};

/** `1234` → `1,234`. 재화 수량은 전부 정수로 보여 준다. */
function groupDigits(n: number): string {
  return Math.abs(Math.round(n)).toLocaleString('en-US');
}

/**
 * 재화 칩 하나. `id` 가 표에 없으면 회색 대체 칩이 나온다 (throw 하지 않는다 — 낡은 세이브 하나가 패널
 * 전체를 죽이면 안 된다).
 *
 * 마크업 (스타일은 `src/ui/styles/base.css` 의 `.currency-chip*`):
 *
 *   button|div.item-chip.currency-chip      ← `--cy` = 재화 색, `data-currency-id` = 호버 카드의 갈고리
 *     div.item-chip-thumb.currency-thumb > span.item-chip-icon
 *     div.item-chip-count > span.item-chip-have
 *     div.item-chip-name                     (withName 일 때만)
 */
export function buildCurrencyChip(id: CurrencyId | CurrencyDef, opts: CurrencyChipOptions = {}): HTMLElement {
  const def = typeof id === 'string' ? (currencyDef(id) ?? UNKNOWN) : id;
  const size = opts.size ?? 34;
  const el = document.createElement(opts.button ? 'button' : 'div');
  el.className = 'item-chip currency-chip';
  if (opts.button) (el as HTMLButtonElement).type = 'button';
  el.style.setProperty('--chip-size', `${size}px`);
  el.style.setProperty('--cy', def.color);
  // 아이템 칩의 `--rc` / `--ic` 자리를 같은 색으로 채워 둔다 — 두 칩이 같은 CSS 를 나눠 쓰기 때문이다.
  el.style.setProperty('--rc', def.color);
  el.style.setProperty('--ic', def.color);
  el.dataset.currencyId = def.id;
  if (def.corp) el.dataset.corp = def.corp;
  if (opts.title !== undefined) el.title = opts.title;

  const thumb = document.createElement('div');
  thumb.className = 'item-chip-thumb currency-thumb';
  const icon = document.createElement('span');
  icon.className = 'item-chip-icon';
  icon.textContent = def.icon || '◈';
  thumb.appendChild(icon);

  const amount = opts.amount;
  if (amount !== undefined) {
    const count = document.createElement('div');
    count.className = 'item-chip-count';
    const only = document.createElement('span');
    only.className = 'item-chip-have';
    const sign = amount < 0 ? '−' : opts.signed ? '+' : '';
    only.textContent = `${sign}${groupDigits(amount)}`;
    count.appendChild(only);
    thumb.appendChild(count);
  }
  el.appendChild(thumb);

  if (opts.withName) {
    const name = document.createElement('div');
    name.className = 'item-chip-name';
    name.textContent = def.name;
    el.appendChild(name);
  }
  return el;
}

/**
 * `host` 의 자식을 재화 보상 칩으로 갈아 끼운다. 금액이 0 이거나 없는 보상은 건너뛰므로, 크레딧이 없는
 * 퀘스트는 크레딧 칩도 없다. 아이템 보상 칩(`renderItemCost` / `buildItemChip`)과 같은 줄에 이어 붙이라고
 * `host` 를 비우는 일은 **호출부가** 정한다 — 여기서는 `append` 만 한다.
 */
export function appendCurrencyRewards(
  host: HTMLElement,
  rewards: readonly CurrencyReward[],
  opts: CurrencyChipOptions = {},
): void {
  host.classList.add('item-chips');
  for (const r of rewards) {
    if (!r || !Number.isFinite(r.amount) || Math.round(r.amount) === 0) continue;
    host.appendChild(buildCurrencyChip(r.id, { signed: true, ...opts, amount: r.amount }));
  }
}
