# Pitch wiki (`docs/pitch/`)

Introduction document for investors and publishers. **One HTML file per page** — tree menu on the left, body in the centre, page
table of contents on the right. Just open `docs/pitch/index.html` in a browser (no server needed — it forwards to
`pages/00-intro.html`). The wiki content itself is written in Korean; this README is for maintainers.

**There is no build step.** `pages/*.html` are the sources; edit and save.
Public URL: **https://toniqat.github.io/Scavanger/** (GitHub Pages) — see [Deploy](#deploy).

```
docs/pitch/
├── index.html      one cover page forwarding to pages/00-intro.html
├── style.css       styles shared by every page
├── app.js          sidebar tree · right TOC · image auto-swap · lightbox (card flipping) (+ page list `TREE`)
├── pages/          31 pages. One file = one menu item = one <article>
│   │                 The two leading digits are the menu index — file sort order is the TOC order.
│   ├── 00-intro.html                                                         1 개요
│   ├── 01-create · 02-stats · 03-skills · 04-implant-item · 05-tactical      2 캐릭터
│   ├── 06-weapons · 07-gadget · 08-stratagem                                 3 전투
│   ├── 09-raid-flow · 10-comms · 11-planets · 12-structures · 13-rails       4 레이드
│   │   · 14-hazards · 15-fog · 16-enemies · 17-extraction · 18-dungeon
│   ├── 19-ship · 20-facility · 21-hangar · 22-guild                          5 함선
│   ├── 23-corp · 24-rep · 25-quest                                           6 기업
│   ├── 26-crypto · 27-auction                                                7 미니게임
│   └── 28-status · 29-hud · 30-controls                                      8 부록
└── assets/         screenshots · reference images · character portraits
                    `<name>.png` originals next to the `<name>.webp` release copies made by `npm run pitch:webp`
```

Inside `pages/`, every path to `style.css` · `app.js` · `assets/` starts with `../`.

## Page skeleton

Every `pages/*.html` has the same shape. For a new page, copy any file and replace only the inside of `<article>`.

Based on `pages/02-stats.html`:

```html
<body data-page="p-stats">        ← tells the sidebar what to highlight. Must equal the id in TREE.
  <aside class="side"> … <nav class="tree" id="tree"></nav> </aside>
  <main class="main" id="main">
    <article id="p-stats">        ← first a <div class="crumb">, then <h1>, then <p class="lede">
      …
    </article>
  </main>
  <aside class="toc"> … <div id="toc"></div> </aside>
  <script src="../app.js"></script>
```

Leave `#tree` and `#toc` empty; `app.js` fills them. Sidebar open sections and scroll position persist in `sessionStorage`.

## Adding a page

File names are `<2-digit menu index>-<name>.html`, and the index comes from the order of `TREE` in `app.js`. If the two disagree,
links silently 404, so `app.js` checks its own file name on load and **logs a console warning**.

1. Insert `['p-<name>', '<menu label>']` at the desired place in the section's `pages` array of `TREE` at the top of `app.js`.
   **Pages not in `TREE` do not appear in the sidebar.**
2. Every page from that position on shifts by one — rename files **starting from the back**, and fix old names left in body
   links. (Appending at the end skips this step.) When inserting several pages at once, it is safer to build an
   **old name → new name table and replace in one pass** (first check that the new and old name sets do not overlap — if they
   do, split it into two passes).
3. Create `pages/<index>-<name>.html` (copy an existing file). Update `<title>` · `<body data-page>` · `<article id>`.
4. Relink the neighbours' `.nextnav` links — **`TREE` is the source, so regenerate them from it rather than wiring by hand.**
   Section numbers (`<span class="hn">`) likewise run in page order within a section, so an insertion shifts everything after it.
5. `node scripts/smoke-pitch.mjs` — broken links and missing sidebar entries are caught here.

Section headings are `<h2 id="s-...">`, subheadings `<h3>`. The right TOC is generated from the page's h2/h3; headings without an
id get `<article id>-h<number>` — that changes when order changes, so **give an explicit id to any heading you link to.**

## Links

- Another page: `<a class="wl" href="25-quest.html">` (namuwiki-style body link). **Include the number.**
- A section on another page: `href="25-quest.html#s-daily"`. Opening the page scrolls to that anchor.
- Same page: `href="#s-daily"`.

## Images

Draw a placeholder box inside `<figure class="shot" data-src="../assets/foo.png">`; on load the page **checks whether that file
exists and swaps in the image if it does**. Dropping a PNG into `assets/` removes the placeholder; deleting it brings the
placeholder back. Missing files log `ERR_FILE_NOT_FOUND` in the console — that is the existence check working as intended.

- `class="shot ref"` = reference material (purple border) — a slot for a reference image, not a game screen.
- `.shotrow` = 2-column grid, `.shotrow.c3` = 3 columns.
- Character thumbnails `<div class="person" data-src="../assets/npc-*.png">` follow the same rule (initials when missing).

**Format.** Markup always says `.png`. `app.js`'s `probeSrc()` **looks for a `.webp` of the same name first and falls back to the
written `.png`.** So new screenshots show up as soon as the PNG is added, and after `npm run pitch:webp` the lighter file is served.
A missing file logs two 404s (`.webp` then `.png`) — again, that is the existence check.

**Placement.** Put a screenshot **above the text that describes it** — directly under `<h1>` (before `.lede`) if it represents the
whole page, directly under the section's `<h2>` if it belongs to one section. Do not collect images at the bottom of the page.

**Lightbox · card flipping.** Clicking a **real image** inside `figure.shot` opens a fullscreen lightbox (`.lb`); click the backdrop
or press <kbd>ESC</kbd> to close. No markup is needed — `app.js` uses document-level delegation, so images swapped in later work too.
Caption = `<figcaption>`, or the placeholder's `.ttl` if absent. **Placeholders are not images and are not clickable.**

**Images in the same `.shotrow` form one set.** In the lightbox, <kbd>◀</kbd> <kbd>▶</kbd> · <kbd>←</kbd> <kbd>→</kbd> · swipe flips
to the next image, with `2 / 5` top-left, wrapping at both ends. **The grouping unit is `.shotrow`**: wrap images in `.shotrow` to
flip through them as a set; leave an image outside to show it alone — a standalone image has no arrows or counter
(`.lb.multi` is the switch).

### Automated prototype screenshots

Implemented screens are not captured by hand — `scripts/shots-pitch.mjs` drives the game in headless Chrome and captures them.

```sh
npm run dev                       # in another window
node scripts/shots-pitch.mjs      # everything
node scripts/shots-pitch.mjs char-sheet corp-screen    # selected shots
```

Shots go to a staging directory outside the repo and are copied into `assets/` when the run ends (so a vite reload cannot
corrupt them). Details and gotchas: [scripts/README.md](../../scripts/README.md).

Remaining placeholders fall into three kinds: ① `ref-*` reference images and `npc-*` portraits — added by a person.
② Screens of features that are not implemented yet. ③ **The two hangar shots** (`hangar` · `hangar-visit`) — the shared-ship hangar
is only built **with a lobby**, which this single-page script cannot create (it needs a relay and two clients; for the same reason
it is tested separately by `scripts/smoke-hangar.mjs`). Capture by hand or leave the placeholder.

## Content rules

- Sentences **as short as possible**. Prefer shorter even at some loss. Repeating an explanation on a different page is fine.
- Anything that fits a table goes in a table (stats · skills · implants · enemies · facilities · corporations · contracts).
- Detailed numbers are folded into `<details><summary>세부 수치 — …</summary>`. The body keeps a pitch tone.
- Link related concepts with `<a class="wl" href="...">` (namuwiki style).
- Mark implementation status with badges: `<span class="badge ok">구현</span>` · `wip 다음` · `plan 기획`.
  **Numbers and names come from the game, not from memory** — `data/*.csv` for values, and `src/progression/defs.ts`,
  `src/items/ImplantDefs.ts`, `src/shared/meta.ts`, `src/shared/housing.ts`, `src/shared/planets.ts`,
  `src/enemies/EnemyTypes.ts`, `src/items/WeaponDefs.ts` for definitions. When game systems change, update the affected pages
  (e.g. enemy factions per planet threat, the extraction flow without defense waves, controls in `30-controls`).

## Deploy

**GitHub Pages, no build.** The repository is public and serves `docs/` as the site root.
`docs/pitch/` on `main` is the public version — changes appear 1–2 minutes after a push.

| | |
|---|---|
| Public URL | **https://toniqat.github.io/Scavanger/** → `docs/index.html` forwards to `pitch/` |
| Wiki direct | https://toniqat.github.io/Scavanger/pitch/ (cover → `pages/00-intro.html`) |
| A specific page | https://toniqat.github.io/Scavanger/pitch/pages/11-planets.html — section anchors (`#s-gimmick`) work too |
| Pages settings | Settings → Pages → Source **Deploy from a branch** / Branch **main** / Folder **`/docs`** (once) |

`docs/.nojekyll` disables Jekyll — without it files starting with `_` are silently dropped.
`docs/index.html` is a single page forwarding visitors at the root to the wiki (it does not link the dev docs `docs/*.md`).

### Pre-publish checklist

1. **`node scripts/smoke-pitch.mjs`** — opens every page and checks links · sidebar · `.nextnav` · card flipping. With no build,
   **breakage is silent**: if `TREE` order and file numbers disagree links 404, and `.nextnav` breaks when pages are inserted.
   `npm run verify` picks this script automatically when `docs/pitch/` changes (`EXTRA_PATHS` in `scripts/verify.mjs`).
2. If you captured new screenshots, run `npm run pitch:webp` — with PNGs only, visitors download the originals.
   It encodes through local Chrome canvas, so it needs no extra dependency.
3. Open `docs/index.html` in a browser and check cover → wiki navigation and images (everything works over `file://`).
4. Merge to `main` and push. Done when *pages build and deployment* in the Actions tab is green.

### Other routes

- **Offline handoff**: zip the whole `docs/pitch/` folder. The recipient double-clicks `index.html` and it opens without a server
  (no `fetch`, no ES modules). Excluding `assets/*.png` shrinks it considerably.
- **Private link**: to avoid exposing the repository, upload only `docs/pitch/` to Netlify Drop / Cloudflare Pages. All paths inside
  `pages/` are `../`-relative, so it works under any subpath.

## Known facts worth keeping

- Implant item equipping UI lives in the **inventory tab's equipment column** (`src/inventory/ui/ImplantPanel.ts`), not the character tab.
- The wiki was renumbered when pages were inserted mid-tree; old links such as `01-stats.html` no longer exist.

## Recent changes

Older: `git log -- docs/pitch`.
- 2026-09-15 — Enemy composition aligned with per-planet factions (`11-planets` · `12-structures` · `16-enemies` · `17-extraction`, text only).
- 2026-09-10 — Caught up with implementation: 23 → 31 pages, corrections (extraction, death, weapon slots, ship calls, shield, warp, controls), card flipping, `smoke-pitch`.
- 2026-09-08 — GitHub Pages deployment, `pitch:webp` + `probeSrc()` webp-first probing, `.nojekyll`.
- 2026-09-08 — Screenshots moved above their text; lightbox added.
- 2026-09-08 — Split into per-page files with two-digit menu indices; first version (8 sections).
