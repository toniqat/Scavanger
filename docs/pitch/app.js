/* ══════════════════════════════════════════════════════════════════════════
   PROJECT SCAVANGER · 피칭 위키 — 공용 스크립트
   페이지마다 이 파일 하나를 읽는다. 사이드바 트리 · 우측 목차 · 이미지 자동 교체.
   현재 페이지는 <body data-page="p-..."> 로 알려 준다.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 페이지 목록 ───────────────────────────────────────────────────────
   여기에 없으면 사이드바에 안 나온다. 페이지를 추가하면 이 배열도 고친다.
   ────────────────────────────────────────────────────────────────────── */
const TREE = [
  { n:'1', t:'개요',      pages:[['p-intro','프로젝트 개요']] },
  { n:'2', t:'캐릭터',    pages:[['p-stats','스탯'],['p-skills','숙련도'],['p-implant-item','임플란트'],['p-tactical','전술 임플란트']] },
  { n:'3', t:'전투',      pages:[['p-weapons','무기'],['p-gadget','가젯'],['p-stratagem','함선 호출']] },
  { n:'4', t:'레이드',    pages:[['p-raid-flow','레이드 흐름'],['p-planets','행성 · 기믹'],['p-enemies','적'],['p-extraction','탈출'],['p-dungeon','던전 레이드']] },
  { n:'5', t:'함선',      pages:[['p-ship','개인 함선'],['p-facility','시설'],['p-guild','길드 함선']] },
  { n:'6', t:'기업',      pages:[['p-corp','기업 · 인물'],['p-rep','신뢰도 · 계약'],['p-quest','퀘스트']] },
  { n:'7', t:'미니게임',  pages:[['p-crypto','암호화폐 트레이딩'],['p-auction','창고 경매']] },
  { n:'8', t:'부록',      pages:[['p-status','개발 현황'],['p-controls','조작']] },
];

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* 파일 이름은 <메뉴 순번 2자리>-<id 에서 p- 뗀 것>.html — 번호가 곧 목차 순서다.
   그래서 TREE 순서를 바꾸면 pages/ 의 번호도 같이 바꿔야 한다. */
const FILE = {};
TREE.flatMap((s) => s.pages).forEach(([id], i) => {
  FILE[id] = String(i).padStart(2, '0') + '-' + id.replace(/^p-/, '') + '.html';
});

const HREF = (id) => FILE[id];
const HERE = document.body.dataset.page || '';

/* 자기 점검 — 어긋나면 링크가 조용히 404 가 되므로 콘솔에 남긴다 */
if (HERE && FILE[HERE] && !location.pathname.endsWith('/' + FILE[HERE])) {
  console.warn('[pitch] 이 파일 이름은 ' + FILE[HERE] + ' 이어야 한다 —' + ' app.js 의 TREE 순서와 pages/ 의 번호가 어긋났다.');
}

/* ── 사이드바 트리 ─────────────────────────────────────────────────────
   절 펼침 상태와 스크롤 위치는 sessionStorage 에 남긴다 —
   페이지를 넘길 때마다 트리가 접히면 읽기 흐름이 끊긴다.
   ────────────────────────────────────────────────────────────────────── */
const store = {
  get open(){ try { return new Set(JSON.parse(sessionStorage.getItem('pitch.open') || '[]')); } catch { return new Set(); } },
  set open(s){ try { sessionStorage.setItem('pitch.open', JSON.stringify([...s])); } catch {} },
};

(function buildTree(){
  const host = $('#tree'); if (!host) return;
  const open = store.open;
  const root = document.createElement('ul');

  TREE.forEach((sec) => {
    const li = document.createElement('li');
    li.dataset.sec = sec.n;
    const mine = sec.pages.some(([id]) => id === HERE);
    if (mine || open.has(sec.n)) li.classList.add('open');

    const btn = document.createElement('button');
    btn.className = 'sec';
    btn.innerHTML = '<span class="caret">▶</span><span class="num">' + sec.n + '</span><span>' + sec.t + '</span>';
    btn.addEventListener('click', () => {
      li.classList.toggle('open');
      const o = store.open;
      li.classList.contains('open') ? o.add(sec.n) : o.delete(sec.n);
      store.open = o;
    });
    li.appendChild(btn);

    const sub = document.createElement('ul');
    sec.pages.forEach(([id, label]) => {
      const sli = document.createElement('li');
      const a = document.createElement('a');
      a.href = HREF(id);
      a.textContent = label;
      if (id === HERE) a.className = 'active';
      sli.appendChild(a);
      sub.appendChild(sli);
    });
    li.appendChild(sub);
    root.appendChild(li);
  });

  host.appendChild(root);

  /* 사이드바 스크롤 복원 · 활성 항목이 화면 밖이면 끌어온다 */
  const side = $('.side');
  if (side) {
    const y = +(sessionStorage.getItem('pitch.sy') || 0);
    if (y) side.scrollTop = y;
    const act = $('#tree a.active');
    if (act) {
      const r = act.getBoundingClientRect(), sr = side.getBoundingClientRect();
      if (r.top < sr.top || r.bottom > sr.bottom) act.scrollIntoView({ block:'center' });
    }
    side.addEventListener('scroll', () => {
      try { sessionStorage.setItem('pitch.sy', String(side.scrollTop)); } catch {}
    }, { passive:true });
  }
})();

/* ── 우측 목차 ─────────────────────────────────────────────────────────
   이 페이지 article 의 h2/h3 에서 만든다. id 가 없는 제목에는
   페이지 안에서 안정적인 id 를 붙인다 (새로고침해도 링크가 살아 있게).
   ────────────────────────────────────────────────────────────────────── */
let tocLinks = [];
(function buildToc(){
  const host = $('#toc'), art = $('article');
  if (!host || !art) return;
  host.innerHTML = '';

  $$('h2, h3', art).forEach((h, i) => {
    if (!h.id) h.id = art.id + '-h' + i;
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.replace(/^[\d.]+\s*/, '').trim();
    if (h.tagName === 'H3') a.className = 'h3';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior:'smooth', block:'start' });
      history.replaceState(null, '', '#' + h.id);
    });
    host.appendChild(a);
    tocLinks.push({ a, h });
  });

  if (!tocLinks.length) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:11.5px;color:var(--tx3);padding-left:11px;border-left:2px solid var(--line)';
    none.textContent = '한 절짜리 페이지';
    host.appendChild(none);
  }
})();

window.addEventListener('scroll', () => {
  if (!tocLinks.length) return;
  let cur = tocLinks[0];
  for (const l of tocLinks) if (l.h.getBoundingClientRect().top < 130) cur = l;
  tocLinks.forEach((l) => l.a.classList.toggle('on', l === cur));
}, { passive:true });

/* ── 이미지 자동 교체 ──────────────────────────────────────────────────
   ../assets/ 에 파일을 넣으면 플레이스홀더가 실제 이미지로 바뀐다.
   ────────────────────────────────────────────────────────────────────── */
/* 배포용은 같은 이름의 .webp 를 먼저 찾고, 없으면 data-src 에 적힌 원본(.png)으로 떨어진다.
   .webp 는 `node scripts/pitch-webp.mjs` 가 .png 옆에 만든다 (30 MB → 2.8 MB).
   페이지 23개의 data-src 는 .png 그대로다 — 고칠 곳이 여기 하나뿐이라는 뜻이다. */
function probeSrc(src, hit) {
  const cand = [src.replace(/\.png$/i, '.webp'), src].filter((v, i, a) => a.indexOf(v) === i);
  (function next(i) {
    if (i >= cand.length) return;               /* 둘 다 없으면 플레이스홀더가 남는다 — 정상 동작 */
    const probe = new Image();
    probe.onload = () => hit(cand[i]);
    probe.onerror = () => next(i + 1);
    probe.src = cand[i];
  })(0);
}

$$('figure.shot[data-src]').forEach((fig) => {
  probeSrc(fig.dataset.src, (src) => {
    const ph = $('.ph', fig); if (!ph) return;
    /* 제목은 .ph 안에 있다 — 갈아끼우기 *전에* 뽑아 둔다 */
    const ttl = ($('.ttl', fig) || {}).textContent || '';
    const img = document.createElement('img');
    img.src = src; img.alt = ttl;
    ph.replaceWith(img);
    if (!$('figcaption', fig)) {
      const cap = document.createElement('figcaption');
      cap.textContent = ttl;
      fig.appendChild(cap);
    }
  });
});
$$('.person[data-src]').forEach((p) => {
  probeSrc(p.dataset.src, (src) => {
    const av = $('.av', p); if (av) av.innerHTML = '<img src="' + src + '" alt="">';
  });
});

/* ── 진입 시 앵커 ──────────────────────────────────────────────────────
   목차 id 는 위에서 방금 붙였으므로 브라우저의 기본 점프는 이미 놓쳤다.
   ────────────────────────────────────────────────────────────────────── */
if (location.hash) {
  const el = document.getElementById(location.hash.slice(1));
  if (el) el.scrollIntoView({ block:'start' });
}

/* ── 이미지 크게 보기 (라이트박스) ────────────────────────────────────
   figure.shot 안의 실제 <img> 를 누르면 전체 화면으로 열리고,
   아무 데나 다시 누르거나 ESC 를 누르면 닫힌다.
   위 「이미지 자동 교체」가 나중에 끼워 넣는 <img> 도 잡아야 하므로
   document 위임으로 붙인다. 플레이스홀더(.ph)는 대상이 아니다.
   ────────────────────────────────────────────────────────────────────── */
(function lightbox(){
  let box = null, hideTimer = 0;

  function build(){
    box = document.createElement('div');
    box.className = 'lb';
    box.style.display = 'none';
    box.innerHTML = '<div class="x">닫기 · ESC</div><img alt=""><div class="cap"></div>';
    box.addEventListener('click', close);
    document.body.appendChild(box);
    return box;
  }

  function open(img){
    if (!box) build();
    const fig = img.closest('figure.shot');
    const cap = fig ? $('figcaption', fig) : null;
    $('img', box).src = img.currentSrc || img.src;
    $('img', box).alt = img.alt || '';
    $('.cap', box).textContent = (cap && cap.textContent.trim()) || img.alt || '';
    clearTimeout(hideTimer);
    box.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => box.classList.add('on'));
  }

  function close(){
    if (!box || !box.classList.contains('on')) return;
    box.classList.remove('on');
    document.body.style.overflow = '';
    hideTimer = setTimeout(() => { box.style.display = 'none'; }, 160);
  }

  document.addEventListener('click', (e) => {
    const img = e.target.closest && e.target.closest('figure.shot img');
    if (!img) return;
    e.preventDefault();
    open(img);
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
