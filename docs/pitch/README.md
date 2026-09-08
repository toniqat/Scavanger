# 피칭 위키 (`docs/pitch/`)

투자자 · 퍼블리셔용 소개 문서. **페이지마다 HTML 파일 하나** — 좌측 트리 메뉴, 중앙 본문, 우측 페이지 목차.
브라우저로 `docs/pitch/index.html` 를 그냥 열면 된다 (서버 불필요 — `pages/00-intro.html` 로 넘어간다).

**빌드 단계가 없다.** `pages/*.html` 이 곧 원본이다. 고치고 저장하면 끝.

```
docs/pitch/
├── index.html      pages/00-intro.html 로 넘기는 표지 한 장
├── style.css       모든 페이지가 공유하는 스타일
├── app.js          사이드바 트리 · 우측 목차 · 이미지 자동 교체 (+ 페이지 목록 `TREE`)
├── pages/          페이지 23개. 파일 하나 = 메뉴 항목 하나 = <article> 하나
│   │                 앞의 두 자리는 메뉴 순번 — 파일 정렬이 곧 목차 순서다.
│   ├── 00-intro.html                                                         1 개요
│   ├── 01-stats · 02-skills · 03-implant-item · 04-tactical                  2 캐릭터
│   ├── 05-weapons · 06-gadget · 07-stratagem                                 3 전투
│   ├── 08-raid-flow · 09-planets · 10-enemies · 11-extraction · 12-dungeon   4 레이드
│   ├── 13-ship · 14-facility · 15-guild                                      5 함선
│   ├── 16-corp · 17-rep · 18-quest                                           6 기업
│   ├── 19-crypto · 20-auction                                                7 미니게임
│   └── 21-status · 22-controls                                               8 부록
└── assets/         스크린샷 · 레퍼런스 이미지 · 인물 초상
```

`pages/` 안에서는 `style.css` · `app.js` · `assets/` 가 전부 `../` 로 시작한다.

## 페이지 하나의 뼈대

`pages/*.html` 은 전부 같은 모양이다. 새 페이지는 아무 파일이나 복사해서 `<article>` 안만 갈아 끼운다.

`pages/01-stats.html` 기준:

```html
<body data-page="p-stats">        ← 사이드바가 어디를 켤지 알려 준다. TREE 의 id 와 같아야 한다.
  <aside class="side"> … <nav class="tree" id="tree"></nav> </aside>
  <main class="main" id="main">
    <article id="p-stats">        ← 첫 줄 <div class="crumb">, 그다음 <h1>, 그다음 <p class="lede">
      …
    </article>
  </main>
  <aside class="toc"> … <div id="toc"></div> </aside>
  <script src="../app.js"></script>
```

`#tree` 와 `#toc` 는 비어 있는 채로 두고 `app.js` 가 채운다.

## 페이지 추가

파일 이름은 `<메뉴 순번 2자리>-<이름>.html` 이고, 번호는 `app.js` 의 `TREE` 순서에서 나온다.
둘이 어긋나면 링크가 조용히 404 가 되므로, `app.js` 가 페이지를 열 때 자기 이름을 확인하고 **콘솔에 경고**를 남긴다.

1. `app.js` 상단 `TREE` 배열의 원하는 자리에 `['p-<이름>', '메뉴에 보일 이름']` 을 넣는다.
   **여기 없으면 사이드바에 안 나온다.**
2. 그 자리부터 뒤쪽 페이지의 번호가 하나씩 밀린다 — **뒤에서부터** 파일 이름을 바꾸고,
   본문 · `.nextnav` 링크에 남은 옛 이름도 같이 고친다. (맨 뒤에 붙이면 이 단계가 없다.)
3. `pages/<번호>-<이름>.html` 을 만든다 (기존 파일 복사). `<title>` · `<body data-page>` · `<article id>` 를 새 이름으로 고친다.
4. 앞뒤 페이지의 `.nextnav` 링크를 이어 준다.

절 제목은 `<h2 id="s-...">`, 소제목은 `<h3>`. 우측 목차는 그 페이지의 h2/h3 에서 자동 생성되며,
id 가 없는 제목에는 `<article id>-h<번호>` 를 붙인다 — 순서가 바뀌면 그 링크도 바뀌니 **링크를 걸 제목에는 직접 id 를 준다.**

## 링크

- 다른 페이지: `<a class="wl" href="18-quest.html">` (나무위키식 본문 링크). **번호까지 적는다.**
- 다른 페이지의 특정 절: `href="18-quest.html#s-daily"`. 페이지를 열면 그 앵커로 스크롤한다.
- 같은 페이지 안: `href="#s-daily"`.

## 이미지

`<figure class="shot" data-src="../assets/foo.png">` 안에 플레이스홀더 박스를 그려 두면,
페이지가 열릴 때 그 경로에 파일이 **있는지 확인해서 있으면 이미지로 바꿔 끼운다**.
즉 `assets/` 에 PNG 를 떨어뜨리는 것만으로 플레이스홀더가 사라진다. 지우면 다시 플레이스홀더로 돌아온다.
없는 파일은 콘솔에 `ERR_FILE_NOT_FOUND` 를 남기는데 — 그게 정상 동작이다, 그렇게 존재를 확인한다.

- `class="shot ref"` = 레퍼런스 자료 (보라색 테두리). 게임 화면이 아니라 참고 이미지 자리다.
- `.shotrow` = 2열, `.shotrow.c3` = 3열 그리드.
- 인물 썸네일은 `<div class="person" data-src="../assets/npc-*.png">` 로 같은 규칙을 따른다 (없으면 이니셜).

### 프로토타입 스크린샷 자동 촬영

구현된 화면은 손으로 찍지 않는다 — `scripts/shots-pitch.mjs` 가 헤드리스 크롬으로 게임을 몰아서 찍는다.

```sh
npm run dev                       # 다른 창에서
node scripts/shots-pitch.mjs      # 전부
node scripts/shots-pitch.mjs char-sheet corp-screen    # 골라서
```

자세한 내용과 주의점(스테이징 디렉터리, 재시도, 워프 컷씬 회피)은 [scripts/README.md](../../scripts/README.md) 참조.

**남은 플레이스홀더 19개**는 두 종류다: ① `ref-*` 레퍼런스 이미지와 `npc-*` 인물 초상 — 사람이 직접 넣는다.
② 아직 구현되지 않은 기능(길드 함선 · 암호화폐 채굴 · 발사 포드 4인 패널)의 화면.

## 내용 규칙

- 문장은 **최대한 짧게**. 손실이 있어도 짧은 쪽을 고른다. 다만 페이지가 다르면 중복 설명을 허용한다.
- 표로 쓸 수 있는 것은 표로 쓴다 (스탯 · 숙련도 · 임플란트 · 적 · 시설 · 기업 · 계약).
- 세부 수치는 `<details><summary>세부 수치 — …</summary>` 안에 접어 둔다. 본문은 피칭 톤을 유지한다.
- 연관된 개념은 `<a class="wl" href="...">` 로 링크한다 (나무위키 방식).
- 구현 상태는 배지로 구분한다: `<span class="badge ok">구현</span>` · `wip 다음` · `plan 기획`.
  **수치와 이름은 코드가 원본이다** — `src/progression/defs.ts`, `src/items/ImplantDefs.ts`, `src/shared/meta.ts`,
  `src/shared/housing.ts`, `src/shared/planets.ts`, `src/enemies/EnemyTypes.ts`, `src/items/WeaponDefs.ts` 에서 가져온다.

---

## 변경 이력

- **2026-09-08 (3)** 페이지 파일에 **메뉴 순번 두 자리를 붙였다** (`intro.html` → `00-intro.html` … `22-controls.html`).
  탐색기와 에디터의 파일 정렬이 곧 문서 목차 순서가 된다. 본문 · `.nextnav` 링크 124개를 함께 바꿨다.
  `app.js` 는 번호를 `TREE` 순서에서 만들어 쓰므로 손으로 맞출 곳은 파일 이름 하나뿐이고,
  파일 이름과 `TREE` 순서가 어긋나면 페이지를 열 때 콘솔에 경고가 뜬다.
- **2026-09-08 (2)** 단일 파일 SPA 를 **페이지별 파일 23개**로 쪼갰다. 116KB `index.html` 하나 + `_src/` 조각 5개를
  이어붙이던 구조 → `pages/<이름>.html` 23개 + 공용 `style.css` · `app.js`. **`_src/` 와 이어붙이기 빌드 명령은 없앴다** —
  이제 편집 대상과 열리는 파일이 같다. 본문 텍스트는 23개 전부 문자 단위로 동일함을 확인했다.
  - 해시 라우터를 없애고 진짜 페이지 이동으로 바꿨다. 본문 링크 `#p-xxx` → `xxx.html` (147개), `data-src` → `../assets/`.
  - 목차 제목 id 가 매번 랜덤이라 새로고침하면 딥링크가 깨지던 것을 `<article id>-h<번호>` 로 고정했다.
  - 페이지를 넘길 때마다 사이드바가 접히지 않도록 절 펼침 상태와 스크롤 위치를 `sessionStorage` 에 남긴다.
  - 감수한 것: 페이지 전환이 새로고침(깜빡임)이고, 브라우저 Ctrl+F 는 한 페이지만 훑는다.
- **2026-09-08** 최초 작성. 8개 절 23페이지 (개요 · 캐릭터 · 전투 · 레이드 · 함선 · 기업 · 미니게임 · 부록),
  이미지 슬롯 43개 중 24개를 `scripts/shots-pitch.mjs` 로 자동 촬영해 채웠다. 표 데이터는 전부 현재 구현에서 추출.
  촬영 중 확인된 사실 하나: **임플란트 아이템 장착 UI 는 캐릭터 탭이 아니라 인벤토리 탭의 장비 열**(`src/inventory/ui/ImplantPanel.ts`)에 있다.
