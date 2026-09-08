# 피칭 위키 (`docs/pitch/`)

투자자 · 퍼블리셔용 소개 문서. **페이지마다 HTML 파일 하나** — 좌측 트리 메뉴, 중앙 본문, 우측 페이지 목차.
브라우저로 `docs/pitch/index.html` 를 그냥 열면 된다 (서버 불필요 — `pages/00-intro.html` 로 넘어간다).

**빌드 단계가 없다.** `pages/*.html` 이 곧 원본이다. 고치고 저장하면 끝.
공개 주소는 **https://toniqat.github.io/Scavanger/** (GitHub Pages) — 아래 [배포](#배포) 참조.

```
docs/pitch/
├── index.html      pages/00-intro.html 로 넘기는 표지 한 장
├── style.css       모든 페이지가 공유하는 스타일
├── app.js          사이드바 트리 · 우측 목차 · 이미지 자동 교체 · 크게 보기 (+ 페이지 목록 `TREE`)
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
                    `<이름>.png` 원본 + `npm run pitch:webp` 이 만든 `<이름>.webp` 배포본이 같이 있다
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

**형식.** 마크업에는 항상 `.png` 를 적는다. `app.js` 의 `probeSrc()` 가 **같은 이름의 `.webp` 를 먼저 찾고,
없으면 적힌 `.png` 로 떨어진다.** 그래서 새 스크린샷은 PNG 로만 넣으면 바로 보이고, `npm run pitch:webp` 를
돌리면 그때부터 가벼운 쪽이 나간다 (전체 30 MB → 2.8 MB, -91 %). 파일이 아예 없으면 `.webp` · `.png` 두 번
404 가 찍히는데 — 그게 존재 확인 방식이다.

**놓는 자리.** 스크린샷은 **그 화면을 설명하는 글보다 위**에 둔다 — 페이지 전체를 대표하면 `<h1>` 바로 아래
(`.lede` 앞), 특정 절의 화면이면 그 절의 `<h2>` 바로 아래. 페이지 맨 아래에 몰아 두지 않는다.

**크게 보기.** `figure.shot` 안의 **실제 이미지**를 누르면 전체 화면 라이트박스(`.lb`)가 열리고,
아무 데나 다시 누르거나 <kbd>ESC</kbd> 로 닫힌다. 페이지에 붙일 마크업은 없다 — `app.js` 가 document
위임으로 잡으므로 위의 자동 교체로 나중에 끼워진 `<img>` 도 그대로 동작한다. 캡션은 `<figcaption>`,
없으면 플레이스홀더의 `.ttl` 을 쓴다. 아직 파일이 없는 **플레이스홀더는 이미지가 아니므로 눌리지 않는다.**

### 프로토타입 스크린샷 자동 촬영

구현된 화면은 손으로 찍지 않는다 — `scripts/shots-pitch.mjs` 가 헤드리스 크롬으로 게임을 몰아서 찍는다.

```sh
npm run dev                       # 다른 창에서
node scripts/shots-pitch.mjs      # 전부
node scripts/shots-pitch.mjs char-sheet corp-screen    # 골라서
```

자세한 내용과 주의점(스테이징 디렉터리, 재시도, 워프 컷씬 회피)은 [scripts/README.md](../../scripts/README.md) 참조.

**남은 플레이스홀더 16개**는 두 종류다: ① `ref-*` 레퍼런스 이미지와 `npc-*` 인물 초상 — 사람이 직접 넣는다.
② 아직 구현되지 않은 기능(길드 함선 · 암호화폐 채굴 · 발사 포드 4인 패널)의 화면.

## 내용 규칙

- 문장은 **최대한 짧게**. 손실이 있어도 짧은 쪽을 고른다. 다만 페이지가 다르면 중복 설명을 허용한다.
- 표로 쓸 수 있는 것은 표로 쓴다 (스탯 · 숙련도 · 임플란트 · 적 · 시설 · 기업 · 계약).
- 세부 수치는 `<details><summary>세부 수치 — …</summary>` 안에 접어 둔다. 본문은 피칭 톤을 유지한다.
- 연관된 개념은 `<a class="wl" href="...">` 로 링크한다 (나무위키 방식).
- 구현 상태는 배지로 구분한다: `<span class="badge ok">구현</span>` · `wip 다음` · `plan 기획`.
  **수치와 이름은 코드가 원본이다** — `src/progression/defs.ts`, `src/items/ImplantDefs.ts`, `src/shared/meta.ts`,
  `src/shared/housing.ts`, `src/shared/planets.ts`, `src/enemies/EnemyTypes.ts`, `src/items/WeaponDefs.ts` 에서 가져온다.

## 배포

**GitHub Pages, 빌드 없음.** 저장소가 퍼블릭이라 `docs/` 를 그대로 사이트 루트로 서빙한다.
`main` 에 올라간 `docs/pitch/` 가 곧 공개본이다 — 푸시하면 1~2분 뒤 반영된다.

| | |
|---|---|
| 공개 주소 | **https://toniqat.github.io/Scavanger/** → `docs/index.html` 이 `pitch/` 로 넘긴다 |
| 문서 직행 | https://toniqat.github.io/Scavanger/pitch/ (표지 → `pages/00-intro.html`) |
| 특정 페이지 | https://toniqat.github.io/Scavanger/pitch/pages/09-planets.html — 절 앵커(`#s-gimmick`)까지 그대로 걸린다 |
| Pages 설정 | Settings → Pages → Source **Deploy from a branch** / Branch **main** / Folder **`/docs`** (최초 1회) |

`docs/.nojekyll` 이 Jekyll 처리를 끈다 — 없으면 `_` 로 시작하는 파일이 조용히 빠진다.
`docs/index.html` 은 루트로 들어온 사람을 피칭 문서로 넘기는 한 장이다 (개발 문서 `docs/*.md` 는 링크하지 않는다).

### 올리기 전 체크

1. 스크린샷을 새로 찍었으면 `npm run pitch:webp` — PNG 만 올리면 방문자가 원본 크기를 받는다.
2. 브라우저로 `docs/index.html` 을 열어 표지 → 문서 이동과 이미지를 확인한다 (`file://` 로도 전부 동작한다).
3. `main` 에 머지하고 푸시. Actions 탭의 *pages build and deployment* 가 초록이면 끝.

### 다른 경로

- **오프라인 전달**: `docs/pitch/` 폴더를 통째로 압축해서 보내면 된다. 받는 쪽이 `index.html` 을 더블클릭하면
  서버 없이 그대로 열린다 (`fetch` 도 ES 모듈도 안 쓴다). `assets/*.png` 를 빼면 2.8 MB 로 줄어든다.
- **비공개 링크**: 저장소를 노출하고 싶지 않으면 `docs/pitch/` 만 Netlify Drop / Cloudflare Pages 에 올린다.
  `pages/` 안이 전부 `../` 상대 경로라 어느 하위 경로에 놓아도 그대로 뜬다.

---

## 변경 이력

- **2026-09-08 (6)** **배포 경로를 정했다 — GitHub Pages (`main` / `/docs`), https://toniqat.github.io/Scavanger/.**
  위 [배포](#배포) 절이 절차다. 곁들여 붙인 것:
  - `scripts/pitch-webp.mjs` (`npm run pitch:webp`) — `assets/*.png` 옆에 같은 이름의 `.webp` 를 만든다.
    **30 MB → 2.8 MB (-91 %)**, 페이지 하나 전송량 162 KB. 인코딩은 로컬 Chrome 캔버스라 새 의존성이 없다
    (cwebp·ImageMagick·sharp 미설치, Windows 의 `convert` 는 ImageMagick 이 아니라 FAT 변환 도구다).
  - `app.js` 의 이미지 자동 교체를 `probeSrc()` 하나로 모으고 **`.webp` → `.png` 순서로 탐지**하게 했다.
    덕분에 **페이지 23개의 `data-src` 는 한 글자도 바뀌지 않았고**, `shots-pitch.mjs` 도 계속 PNG 를 쓴다.
  - `docs/.nojekyll` · `docs/index.html`(루트 → `pitch/` 리다이렉트) 추가.
  - 확인: `docs/` 를 사이트 루트로 로컬 서빙 → 이미지 13장 전부 `.webp` 로 붙고 깨짐 0, 좌측 트리 23 · 우측 목차 정상,
    남은 404 는 원래 비어 있던 `ref-tarkov` · `ref-gimmick` 플레이스홀더 둘뿐.
- **2026-09-08 (5)** 레퍼런스 이미지 6장(`ref-helldivers-1` · `ref-arcraiders-1` · `ref-splatoon-1,2` · `ref-popucom-1,2`)을 넣고
  `00-intro` 의 레퍼런스 구성을 **시스템 / 아트 두 갈래로 갈랐다.**
  - `1.2 차별점` 안의 «레퍼런스 좌표» 는 «레퍼런스 좌표 — 시스템» 이 되어 3열(`.shotrow.c3`)로 줄었다
    (헬다이버즈 2 · 타르코프 · 아크 레이더스). 스플래툰 항목은 여기서 빠졌다.
  - **새 절 `1.3 그래픽 스타일`**(`#s-art`)을 만들었다 — 스플래툰 3 · 팝 유 컴 4장을 `.shotrow` 기본 2열로 깔아 **2×2**,
    그 아래 «아트 원칙 4» 표와 «누구에게 파는가» 카드 3장(코어 / 라이트·여성 / 가족·저연령), 마무리 노트.
    표지 `.facts` 의 «스타일» 값에서 이 절로 링크가 걸린다.
  - 뒤따르던 `특별한 경험` 의 `.hn` 번호를 1.3 → **1.4** 로 밀었다 (`#s-special` id 는 그대로 — 바깥 링크 없음).
  - 이미지가 실제로 있는 4+2장에는 `<figcaption>` 을 직접 달았다. 자동 캡션(`.ttl` 복사)보다 그림이 무엇을 말하는지 적기 위해서다.
  - 채워진 이미지 30 / 남은 플레이스홀더 16 (`ref-tarkov` 는 아직 자리만 있다).

- **2026-09-08 (4)** 스크린샷을 **페이지 맨 아래에서 위로** 올렸다 (`05-weapons` ~ `20-auction` 13개 페이지,
  `00-intro` ~ `04-tactical` 은 이미 되어 있었다). 읽는 사람이 표부터 만나던 순서를 그림부터로 뒤집은 것.
  `09-planets` 의 기믹 레퍼런스만 페이지 최상단이 아니라 자기 절(`#s-gimmick`) 머리로 갔다.
  - **이미지 크게 보기**를 붙였다 — `style.css` 의 `.lb` + `app.js` 의 `lightbox()`. 누르면 열고, 다시 누르거나 ESC 로 닫는다.
  - 곁다리로 고친 것: 자동 교체가 `.ph` 를 갈아끼운 **뒤에** `.ttl` 을 읽어서 자동 생성 `<figcaption>` 이
    항상 빈 문자열이었다. 제목을 갈아끼우기 전에 뽑아 두도록 바꿨다.
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
