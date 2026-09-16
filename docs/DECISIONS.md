# SCAVANGER — Decision log (Phase 5 – 12 · since 2026-09-09)

Merged from `docs/PHASE5-PLAN.md` … `docs/PHASE12-PLAN.md` and the drafts in `docs/plans/`. Their bodies are in git history:
`git log --oneline -- docs/PHASE10-PLAN.md` → `git show <commit>:docs/PHASE10-PLAN.md`; for a deleted draft,
`git show <deleting commit>^:docs/plans/<name>.md`.

- Current code → [CLAUDE.md](../CLAUDE.md) → folder `README.md`. When → `git log`. Not done → [TODO.md](TODO.md).
- **What belongs here**: what the user chose, the alternatives rejected, and why. Progress and verification go in commit messages.
- When a decision is overturned, **fix that section** and say what replaced it — do not append a new dated section.
- **Section titles are anchors.** Comments cite them as `docs/DECISIONS.md 「<section title>」` (e.g. `「2026-09-13 — 요리 재료 티어」`).
  Every heading starts with its original Korean title verbatim; the English after `·` is a gloss. Never reword the Korean part.

---

## Phase 5 — 메타 진행 (창고 · 로드아웃, 경험치/레벨, 기업 · 계약 · 퀘스트) · Meta progression

- XP → level → stat points only (one point per level); stat effects map onto existing `DerivedStats`. Skill books excluded.
- The stash grid is the capacity cap; no room → transfer / purchase / reward refused. Selling only at the computer.
- Planet gimmicks deferred (done 2026-09-09). localStorage persistence was overturned by Phase 7; corp quests deleted 2026-09-14.

## Phase 6 — 개발자 콘솔(치트) · 유니크 무기 · 함선 꾸미기 · Dev console · uniques · ship decoration

- Cheats **only when the page host is localhost** (`isDevHost()`); no server check, other clients have no console.
- Stat-XP model (`addStatXp`) alongside level-up points.
- Ship decoration: framework + core rooms first; other purposes filled in later.
- Uniques: legendary loot (low chance in T4/5 crates, boss corpses) + cheat crate; own ammo; **right click = secondary fire, so no ADS**.
- Furniture comes **only from crafting** (buying/looting furniture rejected 2026-09-11).

## Phase 7 — Known follow-ups 해결 · Known follow-ups

- **Server profile + raid session** per token in the relay; credits server-owned; other docs are opaque blobs, localStorage = cache/offline.
- Training range: **no countdown, individual join**, no ammo/durability use, only gun skills rise.
- **Squad wipe = raid failure**; solo death = immediate failure.
- Rogue AI v2: fire-line-blocking cover + flanking, grenades, reload cycles; no low-HP retreat, no boss HP bar.
- Principles: **furniture is not an item**; one roll, no dive; no skill books (library shelf instead).

## Phase 8 — UI/UX pass

The player's 19 written requests were implemented as given. Settled: seeds from raid loot + corp shop (not craftable); growth in real
time; audio = master + SFX with a reserved BGM channel. Superseded: stacked grow racks, the repair bench, ESC always pausing.

## Phase 9 — Known follow-ups II

- Offline profile sync by timestamp — **replaced 2026-09-11 (E-6): revisions, server wins on conflict**.
- Ghosts inherit real downed HP; no migration while nobody connected is in the mission; a reloading host's ghost is **parked** (`NET_GHOST_PARK_S`).
- Late join: `strat sync` from host, `meta sync` peer-to-peer, barrier re-sent on `flow rejoined`.
- Burn kill credit = whoever lit it. Training target modes are client-local. `es` = delta stream with keyframes.
- One-book-per-skill shelf — **replaced 2026-09-13 by library series**.

## Phase 10 — UI 개선 · UI improvements

- **Two rollbacks**: the virtual cursor under pointer lock went back to the real OS cursor (cost: it can leave a windowed game on
  multi-monitor); the 3-heads-tall character model was rejected on look (only the carry socket/pose kept).
- F tap carries a downed ally only when one is in range; E-hold revive unchanged. Healing item = rename only (`stim` ids kept).
- Corpse loot chance tiered by enemy size. Barrier = `mode: 'wielded'` shield that holsters the gun.

## Phase 11 — 행성 선택 · 소셜 · Planet select · social

- Social = **server profile document + token-derived 8-char ID**; presence from the server. Social UI is **ship only**.
- **Existing 5 biomes = 5 planets**, no new enemies/items. Planet picked **by the host** in the shared ship.
- Fullscreen terminal with planet hologram centre. Travel cutscene later **replaced by the in-ship window warp** (docking cutscene kept).

## Phase 12 — 임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · UX 정리 · Implants · barrier/recon · bullet tracking

- Implant slots: base, +1 every few levels, capped (`IMPLANT_SLOTS_*`). Sales and broken-implant repair at **Ceres Bio**.
- Three legendary perks implemented (`auto_revive` · `quick_heal` · `kill_stamina`).
- AI bullet tracking: look toward the shot (detection ×2), then advance to the origin; bugs move at once. Made global 2026-09-14.
- `IMPLANT_REPAIR_FEE` stays a `data/tuning.csv` scalar read by meta.

---

## 2026-09-09 — 사망/시체 · 구조선 · 분대장 · 전장의 안개 · 지형지물 콜리전 · Death · rescue · leader · fog · collision

- Wheel: **air strike out, rescue drop in, 4 directions** (5-slot wheel rejected; `airstrike` stays in types/csv).
- Rescue revive is **empty-handed**; the count is **spent at grant, no refund** (not on landing/death); after 5 the dead spectate.
- Implants stayed on the body — **reversed 2026-09-11 (C-12)**: broken pairs go to the corpse, solo death loses them.
- Corpses appraise cell by cell like crates (instant reveal rejected).
- Fog **gates map + world markers** (world-render fog rejected: cost, relighting).
- Collision: climbable mesh cylinders (full OBB rewrite rejected) — later boxes for buildings, hulls and ramps (2026-09-11).
- Host transfer via **server `lobby:transferHost`** — client-only consensus would desync the relay's `hostId`.
- Big-enemy spawn clearance **by radius** (`ENEMY_BIG_RADIUS`), not a per-species csv column, so new species just work.
- The leader-change toast has one owner (`game/parts/Leader`): three transfer paths meet at `net:hostChanged`.

## 2026-09-09 — 레이드 콘텐츠 (구조물 · 선로/전차 · 환경 재해 · 로그 강하 · 의사소통 휠 · 행성별 등급 드롭) · Raid content

- Grade drop rate **per crate** (not per weapon/raid); **`data/planets.csv` row order = difficulty** (player's Nth raid erases planet
  choice; `threat` 1–3 squashes the curve).
- Structures: **enterable ground building + one basement** (open ruins / multi-storey rejected). Trams: **console start → auto drive**
  (manual driving rejected: controls/HUD/sync cost).
- Hazards **random per raid from the planet's candidates**, ending by **covering the whole map** (no safe zone).
- Drop-in enemies scaled by squad size — superseded 2026-09-13 by raider waves.

Reversal: enterable buildings need walls, so `Obstacle.box` was added without a rewrite (`SpatialHash.addBox` fills the circumscribed
radius; only box branches use new math). Also: uniques and their ammo are planet-gated too; **collapsed roofs** keep the camera free
with no special code; drop-in enemies bypass the ambient cap; hazard fog **lerps** density so clear planets still get a storm.
"Enemies don't ride trams" was reversed 2026-09-11.

## 2026-09-11 — 신뢰 경로의 남은 틈 (E-8 · E-9 · B-11 · B-12) · Remaining trust-path gaps

- `explode`: **shape · sender · distance · rate**, sharing `hit`'s DPS bucket (per-kind caps rejected). A dead sender is accepted (fuses outlive throwers); only `kb` filters the dead.
- Status bits (`st`): **own count bucket only** — pre-deducting DoT would nerf legit multi-target flames; range already limits abuse.
- Refused squad ship call: **notify + full cooldown refund** (the call never stood).
- Selling rounds **down** (value-1 items sell for 0 C); buying keeps `round` (flooring would be a silent discount).
- Sold item ownership **not checked** — stash/bag are opaque blobs; a server-authoritative inventory is phase-sized.
- Blocking vs lobby join is **per direction**: I blocked → `blocked`; blocked me → `not_found`. Existing squadmates are not kicked.

## 2026-09-11 — 연구실 (A-11 품종 · A-12 분석기 · A-13 추출기/조합대/준비물 · B-13 가구 강화 UI) · Research lab

- Open **the lab only** (kitchen next cycle).
- **Soft planet gate**: entry allowed; without prep, HP-only damage. Environments only on the two threat-3 planets; prep cancels 100 %.
- Prep **used in the ship = one next raid**, kept through death in that raid. Analyzer waits in real time.
- New seeds from **wild gathering + analyzer results** — improved strains must be repeatable (a first-analysis bonus could never be grown again).
- B-13: **click inspector**; utility furniture already owned is craft-locked (dimmed, last).
- Superseded: 6 specimens/dex speedup (→ 3 families, 2026-09-13); "no rogue corpses" (→ faction loot); one-of-each utility furniture
  (→ multiple library storages); greenhouse prerequisite for lab/kitchen (removed 2026-09-14).

## 2026-09-11 — 주방 · 배양조 · 3D 프린터 (A-3c · A-14 · A-15) · Kitchen · culture tank · printer

- **All three in one cycle** — crops → meals and culture → ingredients + filament → bags are one chain.
- Meal buffs get **a separate single meal slot** (does not compete with prep); a second meal replaces the first.
- Shared ship has a fixed dining table; ~~one person serving feeds the whole squad (one meal consumed)~~ — **replaced 2026-09-16**:
  meals are table plates, and a plate in the shared ship can be eaten by every member without being consumed (see 「2026-09-16 — 식탁 요리 · 낮은 구르기 · 빈 유해 소멸 · 처치 경험치 · 서사 이상 드롭률」).
- Culture media have **one grade axis** (no soil-like tags). Pouch = **one fixed equip slot** with its own grid; keys get category `key`.
- Higher bags are **not a new tier**: rare/epic/legendary bags move to the printer + 3 filament grades (reverses the TODO draft).
- Superseded 2026-09-13: one buff per meal (→ tiered stat lines), instant cooking (→ minigame + quality), media emptying at 0 (→ durability + sockets).

## 2026-09-12 — 헬스장 · 서재 매체 (A-3a · A-3e) · Gym · library media

- New library furniture goes in **the library**; the lounge purpose was not revived.
- Gramophone · jukebox · turntable are **cosmetic variants** — counted once.
- Workout gains are a **separate trained bonus** (`PlayerProfile.trained`), not stat points. Presentation = pose + fixed side camera.
- Defaults: training during fatigue is allowed but gives 0 XP; only completed sessions count.
- Superseded: unsynced poses, per-skill media caps (→ series), TV E toggle (→ TV game screen), "perfect = 1/3 window".

## 2026-09-12 — 캐릭터 버프 · 가구 자세 원격 동기화 · Character buffs · remote poses

- The list holds **everything**: resting/working out, workout debuff, meal, prep, environment exposure. Buffs have **no effect** — display/sync only.
- Shown under the **player HP bar (in the ship too)** and under squadmates' squad-list rows — not on world nameplates. Old text badges replaced.
- Remaining time = icon + gauge (+ short text); next-raid meal/prep shown dimmed. Workout sync uses the **actual motion phase**.

## 2026-09-12 — 전투 소모품 · 소모형 열쇠 · 드론 스캔 · 즐겨찾기 · 아이템 회수 계약 · Consumables · keys · drone scan · favourites · recovery

- Adrenaline / stimulant / stabilizer, **3 s hold**; the first two cancel each other; stabilizer refills tactical implants only (not ship calls), consumed even when full.
- **Aim sway = camera drift only while aiming** (class · stance · movement, not stamina). Ready = one flash + glow while ready.
- Hook cooldown **refunded by pulled distance**; dash longer (both retuned 2026-09-14).
- **Consumable master keys** (basement key, lab keycard), no guaranteed key per structure; **drone vents** by locked doors.
- Ground-drone scan shows the best grade inside; unopened containers preview **the exact roll opening gives**.
- Favourites **per item type, per character, server-synced**; right click = menu on every item, double click = quick move.
- Recovery contract counts **only items created by that raid's loot rolls**; the mark follows the item, mixing with brought stacks unmarks (no laundering).

## 2026-09-13 — 요리 재료 티어 (분석기 결과표 · 흙/배지 내구도와 소켓 · 배양 스캐폴드) · Cooking ingredient tiers

- Specimens **merged into 3 families** (cell · mineral · DNA); old ones retired but still analysable.
- **Analysis level per family** shortens time and unlocks results (replaces dex speedup and first-analysis bonus).
- Soil is consumed when poured; **media follow the same durability rule** — at 0 the slot stays, bonuses scale with durability.
- **Sockets fit permanently to poured soil/media**; fitting into a full slot destroys the old one after a warning; slot count = grade.
- T3 meat via a **scaffold** in the culture slot (consumed on harvest); T4 via extractor components + mixer.
- Old culture content: **new ids, old retired**. Higher meals = **one buff with tier-many stat lines**.
- Specimen sources by nature (cell: bugs/gather · mineral: gather/scrap/behemoth · DNA: structure containers, rare bugs).
- Design: socket speed/yield also scale with durability (worn soil worth replacing); analysis results are **rolled on insert** (no rerolls).

## 2026-09-13 — 행성별 적 팩션 (안드로이드 · 로그 · 레이더) · Per-planet enemy factions

- Basis = **`PlanetDef.threat` (1–3)** — factions have three steps (grade drops keep row order); named chance moved to a threat table.
- Threat 3 = **raiders only**. Crate guards **replaced by site occupation**; crashed ships empty; the rogue boss becomes a group leader.
- Drop-ins = **raiders in two waves**, no leader. Grenades are **real inventory** (incendiary = real fire zone; unthrown ones drop).
- Armor/bag drops: half the proposed options, low durability. Looks: **shared rogue rig + new skins** (new rigs rejected).
- Ruin occupation and outer group size were lowered after the first pass overcrowded threat 2–3 maps.

## 2026-09-13 — 요리 미니게임 · 요리 품질 · 자동 조리 가구 · Cooking minigames · quality · auto-cookers

- Score becomes **meal quality** on the item (different quality = different stack); **a meal is always produced**.
  Since 2026-09-16 the meal is a **plate on the dining table**, not an item (quality kept on the plate; "output to stash first" and "squad serving" below are void).
- **4 auto-cook devices**; per step choose "do it yourself / auto". Dedicated bench screen, one meal at a time.
- Scoring: chop = beats · mince = balance + time · stir = hold in the boiling band · grill = auto-rising pieces, click to flip then remove.
- 2D minigame + bench pose + fixed camera.
- Design: meal score = step average (auto = device level); best device anywhere counts; squad serving keeps quality; output to stash first.
- Later: cooking gives only cooking XP; perfect band = the window itself (2026-09-14); a failed pose no longer cancels cooking.

## 2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴 / 거래소 · Access sides · generator · crypto

- Placements breaking the new access rule **move to furniture storage** (contents to the stash).
- Exchange: **buy + sell** at server prices, credit reasons validated by the relay.
- Locked coins unlocked by quests (moved to NPC mining-permit quests, 2026-09-14). Compute cluster 1×2 rotatable, **main computer required**.
- **Power allocation was removed the same day** ("too harsh"): the generator is only the **build gate for higher facilities** (Lv.1–5).
  Trap to remember: auto-fill was not in the spec, but pure manual allocation stopped every "place and use at once" flow (e.g. the tutorial workbench).
  On removal: furniture/storage upgrade gates kept · facilities above the generator level removed with **full refund** · old Lv.6–10 → Lv.5 without refund.
- Design: mining is continuous and pays each cycle; changing core count folds progress, changing coin resets it; mining works offline, charts/trades need the server.

## 2026-09-13 — 서재 시리즈 · 비디오게임 · 요리/연구 숙련 · Library series · video games · skills

Rule source: `src/shared/library.ts`.

- Video games follow **gym rules** (24 h debuff, shared trained pool); game discs = the 3 gym games + per-disc tuning; playing is a squad-visible buff.
- Effect lines: book 1 · video 2 · record 3. **Series: 10 % per volume, 100 % for the full set**, a volume counts once — this replaces per-medium caps.
- Storage furniture: multiple allowed. Recipe books add recipes **only while shelved**. Old 42 media → volume 1 of a new series.
- All media **planet-bound** (records/game discs from threat 2, tiny rates), removed from shops. "Not shelved" band hides if shelved anywhere.
- Research skill: shorter analysis + refunds at lab benches; lab benches give only research XP, the cooking bench only cooking XP.

## 2026-09-14 — 메신저 · NPC 퀘스트 · 단체방 · Messenger · NPC quests · rooms

- **P-key panel** replacing the community panel, **ship only**. All 25 corp quests **deleted** (corps keep contracts; coin unlocks → NPC quests).
- Objectives **commit when filled** (survive death); recovery commits on extraction. **Only structure discovery is squad-shared**.
- Group rooms: **owner model, friends-only invites, not linked to chat**. Quests end with **[완료 보고]; no abandoning**.

Content conventions: [data/README.md](../data/README.md) `npc_objectives.csv`. "Think about it" and level-based first contact were
replaced the same day → 「2026-09-14 — NPC 첫 연락 3단」.

## 2026-09-14 — 정보상 · 발사 슬롯 UI · NPC 개인 신뢰도 · Intel broker · launch slots · NPC trust

- Broker = **Raven reused** (`reqLevel` → 1). **Squad leader only** buys (the rover single-payer rule).
- **One intel per profile**, consumed when a raid to that planet ends; rebuying overwrites without refund; area reroll discards all, no refund.
- Map preview = **real layout as a blurred grid**, no coordinates. Named pin threat 2+ only. Planet travel **stays free**.
- NPC personal trust for every NPC, separate from corp trust (same `REP_TABLE`); **accrue + display only**, unlocks undecided.
- Terminal: wide briefing centre, broker → training right, matchmaking = top-right popup. Launch slots: **boarding ≠ ready**
  (Space hold → launch warning → ready), loadout read-only while ready. HP and shield hit ghosts both light red.

Re-decided after measurement: a **rover pin** bought nothing (natural rate was 100 %) → `ROVER_CHANCE` — **measure a gimmick's natural
rate before selling a pin**. **Underground +N builds extra structures** instead of overriding rolls; `maxCount` caps natural placement
only. Small screens shrink **grid cells by window height** (`INV_CELL_*`).

## 2026-09-14 — 튜토리얼 개편 (레이드에서 시작한다, 1–4차) · Tutorial rework (starts in a raid)

| Question | Chosen |
|---|---|
| Entry | New characters **skip the ship**, wake on a hand-built planet (`MissionMode 'tutorial'`), escape on a real landed extraction ship and **keep it** |
| Tracks | **Three** (raid controls · level-up/stats/messenger · build/craft), **each skippable** |
| Made global | **Fall damage** (can kill) · auto-equip of consumables to quick slots |
| Tutorial-only | Checkpoint respawn, gradual HUD, narrow-detection fixed enemies, cliff `kill`/`clamp` volumes |
| Death | Main rule: gear stays on your corpse; killed enemies stay dead |
| NPC | Raven with **dialogue choices** that converge (branches not saved). **Overturned 2026-09-15**: the ship track no longer ends on Raven's quest (`ravenQuest` out of the order, 3 steps: level-up · stats · open the messenger); Raven's first contact is **deferred until the ship track is done and no track is running** — existing saves that never had the tutorial get it as before |

Rules: ① a respawned player's corpse must not sit in enemy detection — solved **by the map** (checkpoints outside detection). ② No holes in
main-game rules — checkpoint respawn is a separate branch inside `missionMode === 'tutorial'` via `player:respawn`.

**2026-09-15 follow-up (user decisions)**: ③ the build track gets a **`하우징 모드 닫기` step right before `작업실로 이동`** (`manageDone` back
in the order, 17 steps — reverses the 2026-09-14 3차 "no close-only step"), and the **floor guide is never drawn while housing mode is open**.
④ **No cryptography XP at tutorial start**: the pre-landed tutorial ship replays `extraction:activated {duration: 0}`, which is not a hack —
progression ignores `duration <= 0` and the tutorial mission; a real console hack still trains 암호학.

Later passes: **full HP at start and respawn** (tension comes from fall damage) · skip lives in the **ESC menu and the raid track
extracts immediately** (hiding hints would strand you) · **no starting implant**, hook granted on first ship entry (hiding the HUD still
let Q fire) · control guide **replaced per step**, objectives revealed in sequence · per-section corridor widths, **decks not narrowed** ·
bugs **ambush from pits** · tutorial ship **lifts off at once** with enemies holding fire · ship marker **hidden** (read as an unknown
object) · **"move forward" steps** between sections · fall respawn at the **last ground you stood on** · tutorial corpses **never despawn**.

Also: **in the ship, `타이틀로` and `게임 종료` are a single tap** — the hold exists because something is lost; `파티 떠나기` keeps the hold.

## 2026-09-14 — NPC 첫 연락 3단 · 메신저 UI · NPC first contact · messenger UI

- **All 10 NPCs**: greeting → my answer → the point (`introAfter`) → quest card; later quests use offer line → card.
- **"Think about it" retired** — quest list shows accepted only; offers arrive only as chat cards.
- Corp NPCs contact you after **traces of play, not level** (one gather · one raid return · prerequisite quest; `reqFlag`). After the tutorial only Raven writes.
- List row = portrait + name + last line; trust in the chat header and portrait ring; **only newly arriving** bubbles type out.

## 2026-09-15 — TODO 묶음 (E-12 · E-13 · A-17 · B-14 · B-15 · B-16 · D-7 · D-8) · TODO batch

- E-12: **three smokes** (`smoke-tutorial-raid` · `smoke-tutorial-ship` · `smoke-fall-damage`), teleporting between sections, real input only for judged actions.
- A-17: tutorial XP = **fixed grant of exactly Lv.2** (`TUTORIAL_RAID_XP`). B-14: landing sound + shake + red vignette + **sound for squadmates** (`fall`).
- B-15: locked cooking recipes **dimmed with a skill badge**, sorted last (badge says `제작 n` — the data's required skill is `crafting`).
- B-16: fire zones get sound, danger indicator and drone damage, player incendiaries too; **G-10 makes a real, smaller fire zone**; rogue/raider footsteps on.
- D-7: **soldier-only fresnel rim shader** (scene-wide env map rejected). D-8: **merged-geometry greebles only**. E-13: pitch pages audited, screenshots unchanged.

Design: G-10 is a **small blast** + zone (full HE damage would make it strictly better); remote grenade
type is **carried on the wire** (`GrenadeMessage.fire`), never guessed, because the receiver's local player takes the damage; ground
effects stand on `getSurfaceY`, not terrain height; the HUD fire-zone indicator ranks behind incoming projectiles.

## 2026-09-15 — 결과 창 · 키캡 · 튜토리얼 다듬기 · Result screens · keycaps · tutorial polish

- Hold keycap: **chevron only, inside the top edge** (no accent border, no wobble). Mouse buttons = **mouse-top drawing everywhere keycaps appear**.
- Extraction result: mission time · loot value · rewards; **`다시 배치 (같은 시드)` removed**. Death result: **lost loot = the raid's peak
  carried value** + cause of death (last hit; non-enemy causes as icon + name, never hidden) + XP.
- Tutorial: `\` diagonal barrier + tall blind barbed wire before the ship; the last android **shoots you in the bay but cannot kill**
  (HP clamped to 1); `supplyLoot` step; passing a section skips it and releases earlier aggro; skip = blackout → result → ship;
  objectives are noun phrases with inline keycaps, only completed lines grey.

Design: cause of death sums per enemy **instance** (`enemyId`); lost loot measured until just before the corpse fill; downed players in a squad
extraction see the death-style result.

## 2026-09-15 — 전설 무기 후속 (이름 · 종류 · 활 · 화염 · 전격총 게이지 · 탄약 · 로켓 점프 · 훈련장 · 대전차포) · Legendary follow-up

User choices:
- Legendaries are named **by nickname only**; shown type is a unique type (`UNIQUE_WEAPON_LABEL_KO`), not the regular class.
- **No gun-skill bonus and no per-class kill credit**; csv `class` stays only because it needs a value.
- Bow `롱혼`: horizontal grip, string toward the body, **no reload**, wide crosshair. Flamethrower flame pulses and blooms from small.
- Shock-gun gauge right of the crosshair, full = brighter blue, percentage only.
- Legendary ammo weight halved; shuriken/arrow stacks sized so one cell weighs the same.
- Bazooka rocket jump: the buff was tuned in the **ceilinged** training range → vertical impulse restored; forward impulse and air carry kept.
- Training range: **no ceiling, invisible walls**. Tactical implant **anti-tank gun removed** (overlaps the bazooka).

Design: no skill bonus ⇒ **no skill XP** (`weaponClassOf` → null for uniques), stimulant reload multiplier stays; anti-tank gun kept only in
the type (like `airstrike`), saves migrate to the hook; bow no-reload = **instantly refilled 1-round magazine** (`autoFeed`) so the ammo
contract is unchanged; invisible walls are a height-independent XZ clamp (side effect: no grappling onto range walls).

## 2026-09-15 — 분대 · 도킹 매칭 · 빌드에서 서버 제외 · 핑 휠 · 해머헤드 넉백 · Squads · docked matching · server out of builds

User choices:
- **Builds ship no server.** The desktop app loses its embedded relay and the deploy folder loses `SCAVANGER-Server.exe` (and the
  exe tooling is deleted). A server runs only from the repo via `start-server.bat`, which now carries the operator console
  (`list` · `kick` · `max` · `gc`). With no address configured the app looks for `ws://127.0.0.1:8787/ws`.
- **Squad ≠ shared ship.** Sending an invite makes the sender squad leader at once (lobby created, `docked: false`); the invitee
  becomes a member **only by accepting** (P hold). Members stay in their own personal ships and see the squad list bottom-left.
- The leader docks from the terminal's new **매칭** tab: `비공개 매칭` / `공개 매칭` under the 4 square face portraits (me first,
  empty cells = invite button → modal with friends + recent players). The leader fades out → docking cutscene at once; members count
  down 3 s on the right, everything they had open closes, then fade → cutscene. Members cannot press the matching buttons. A member who
  accepts after the leader docked also counts down and docks.
- **공개 매칭 never merges squads**: players on their own fill free slots of open public ships (or open one); a squad of 2+ opens its own.
- While undocked, **personal launch and the training range are locked** for the whole squad; ship management, inventory, crafting stay free.
- Once docked, `도킹 해제` takes out **only the one who pressed it** (rejected: leader undocks everyone).
- Lobby codes, invite links and the public/private toggle are **removed from the UI**.
- Terminal: 행성 / 매칭 top tabs (same look as the Tab screen tabs); planet visual centred; `시뮬레이션 훈련장` button bottom-right with a
  confirm popup, its hint line removed.
- Ping wheel: holding the ping button locks the camera like the H/T wheels. Pinging (inventory request) the **equipped armor while the
  shield is not full** asks for a shield recharge; otherwise it is the plain item request.
- Hammerhead: blast throw distance ×0.5 (knockback and airborne rocket jump), ×0.25 when grounded; a grounded blast no longer triggers
  the rocket jump (it did, because the knockback cleared `grounded` before the check).

Design: `lobby:create` / `join` / `quickmatch` still make docked lobbies (smokes, old clients); an undocked lobby left with one member and
no open invite is dissolved by the relay; distance multipliers are applied as √ on speeds (flight distance ∝ speed²); portrait accent
travels as `LobbyPlayer.accent` (in-raid avatars keep slot colours).

## 2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩 · Android squadmates · raid loading

User choices:
- Androids come out of **3 bays in the shared ship's cockpit**: the squad leader holds E for 3 s to recruit one, and again to send it
  back. They are real squad members — **relay bot members** that take a lobby slot and stop matchmaking. A human joining a full squad
  wins: the **latest recruited android** returns to its bay.
- **Shared ship only** (rejected: bays in the personal ship / offline single player). Dev cheat `/android 1|0` adds or removes one android
  in my squad without a server, visible in the personal ship.
- Gear: a **fixed base kit** every raid; on extraction only items found in that raid go to the **squad leader's stash** (rejected:
  persistent per-bay gear; bag lost on extraction).
- Downed like a human and revivable by players, but **not a rescue-drop target**; androids revive downed players; **all humans dead =
  raid failed**.
- Androids follow the **squad leader**. Requests: the first one is taken, others are ignored for about 10 s.
- The comms wheel stays at 4 slots; shield / ammo requests come only from inventory item pings (rejected: 6-slot wheel).
- **Infinite ammo** (magazine and reload kept) (rejected: real ammo use). No throwables or gadgets. HP ×5.
- Raid loading: after the 3 s launch countdown the screen fades to black; a bottom-right radial gauge shows the squad's summed progress;
  it fades in and the drop plays when everyone has loaded or after **60 s** (late players drop on their own) (rejected: wait forever).

Design: the base kit is **bound** (never dropped, handed over, left in a corpse or deposited) — otherwise every raid would mint free
gear; android bodies are the soldier model with an android helmet and visor (downed / carry poses exist only there); recruited androids
stand ready in front of their launch pod; the loading gate is a render hold (sim dt 0, nothing drawn) so the mission clock, enemies and
hellpods all wait, and rejoin / training / tutorial skip it.

## 2026-09-15 — 캐릭터 탭 키캡 · 터미널 훈련장 줄 · 매칭 탭 오프라인 · Character-tab keycap · terminal training row · match tab offline

User choices:
- `포인트 투자 확정` hold keycap: **mouse glyph white, chevron accent** — scoped to that button only (`character.css` `.pg-confirm`);
  every other hold button keeps the accent-coloured glyph from `shared/keycap.mouseGlyphSvg`.
- Terminal 행성 tab: `시뮬레이션 훈련장` moves **out of the footer onto its own row above the separator line**, right-aligned;
  the footer keeps only `닫기 (E)` (rejected: training button beside 닫기 in the footer).
- Terminal 매칭 tab, not connected: `비공개 매칭` / `공개 매칭` are **hidden and a same-size `다시 연결` takes their place**
  (rejected: small reconnect button under the hint); while connecting the buttons stay, disabled. The empty cells' `초대` stays
  **clickable but dimmed**, and each click **flashes** `서버에 연결되어 있지 않습니다` instead of opening the modal
  (rejected: disabled invite button; opening the modal with the same sentence inside).

## 2026-09-15 — 제작 UI: 창고 · 가방 숨김 · 5칸 · 호버 툴팁 · 오른쪽 상세 카드 · Craft UI: no grids · 5 columns · hover tooltip · detail card

User choices (every crafting window — 총기 작업대 and the other `WorkbenchKind` benches, 빠른제작; salvage / repair popups untouched):
- **No stash + bag grids in the craft window** — materials are counted from the inventory model (`craftCountDef`), so the
  `.inv-panel-grids` card is hidden by CSS while `.inv-layout.is-craft` (rejected: keeping the grids as a materials view).
  Tab / Escape / key guide unchanged.
- Recipe thumbnail grid **4 → 5 columns** (`CRAFT_LIST_COLS`), tiles the same size; the craft panel width follows the grid.
- **Hovering a recipe thumbnail shows the output's inventory tooltip** (the window's floating `Tooltip`, same position /
  hide rules as a grid tile; no pin) (rejected: native `title`, chip card `ui/hud/ItemTip`).
- The **craft detail is a separate card to the right** of the workbench panel (`.inv-panel-craft-detail`, top and height
  aligned to it, hidden with no selection) (rejected: detail column inside the workbench panel).
- Detail layout **like an item tooltip**: icon top-left, name (rarity colour) to its right, type · rarity under the name
  (weapon class for weapons, category otherwise — `Tooltip` labels), then the tooltip's spec body, material chips
  (`보유 / 필요`, shortage red), quantity stepper and the 제작 hold button — behaviour (bench level, skill gate, XP, room
  check) unchanged.

Design: `CraftDetail` keeps its public contract (`CraftDetailHandle`); the card mirrors the body's state classes and `--rc`
(`CraftPanel.syncDetailCard`), so tutorial spotlights (`.inv-craft-row[data-recipe] .inv-craft-btn`) still resolve.

## 2026-09-15 — 땅굴벌레 · 진동 장치 · Sandworm thumper

User choices (gadgets side of the 땅굴벌레 rework — the director side is in enemies/):
- New consumable gadget **진동 장치** (`gad_thumper` / `GadgetId 'thumper'`): a Dune-style thumper. **One use**, stacks like mines, rare, 1×2.
- **Found only in 아켈론 II (`amber`) 전진기지 지하실 containers**, ~5 % per basement container (`structures.csv` `basementBonus*` — the same
  per-container bonus roll the basement key uses, outside the crate-tier roll) (rejected: a loot-table weight — tier 4 also appears in
  wrecks, trams and lab locked rooms, so tier + planet cannot isolate outpost basements).
- Placed like a mine (ghost preview), but only where **`WorldRef.burrowGroundOk(x, z, THUMPER_GROUND_R)`** is true — the preview is red
  and placement refused elsewhere (structure floors and roofs included); the host re-checks with the same function.
- It **strikes the ground every 1 s** forever (hammer animation, dust, thump, nearby shake); on the **5th strike** the host emits
  `sandworm:summon` once. **Placement is allowed even after the worm already appeared** in this raid — the summon is simply ignored
  and the device keeps thumping (rejected: refusing placement / consuming nothing once the worm is out).
- **Not recoverable** (no E prompt, no item back) and **destroyed when the worm erupts** inside `SANDWORM_ERUPT_RADIUS`.

Design: strikes carry no wire — every client counts them from the deployable's `age`, and `DeployableWire.age` aligns late joiners;
the ground test lives in world so the worm director and the placement preview cannot disagree; the item works on every planet once
found (only the drop is amber-bound).

## 2026-09-15 — 튜토리얼 마지막 구간: 웅덩이 벽 · 절벽 · 안드로이드 · Tutorial final area: pit walls · abyss · androids

User choices:
- Pit depth **stays 0.9 m and gets a 2.5 m wall** (rejected: a deeper pit; a ramp-only exit). The wall is open toward the fence
  (grenades thrown over the wire must land inside) and toward the ship-side ramp; the far wall is the grenade backstop and
  replaces the old concrete `BACKSTOP`.
- Pit "about 2×": delivered as **×1.55** (9.5 × 8.5 m) with the two androids 1.8 m apart — a true 2× cannot keep "any explosion
  in the pit kills both" (`GRENADE_RADIUS` 7.2 vs the half-diagonal); the bound is written above `PIT`.
- The last two androids are both **100 % drop**: one **shotgun**, one **DMR** (grade I, one full stack of the matching ammo,
  `mat_cable`), they **face the ship**, and wake **both** ways: sense radius **22 m** (ramp and bay inside) **and** the launch
  switch (in the tutorial the switch is the liftoff, so the existing liftoff fire window covers it).
- ~~Right 40 % of the fence has no floor beyond it; beyond the fence everything except the pit, its walls, the flat strip in
  front of the wire and the ship strip is the same bottomless abyss as the ship's front edge (rule `kill`).~~ **Replaced 2026-09-16**:
  everything beyond the fence is abyss except the path from the gap, the pit (walls kept) and a raised ship hill; the left wall
  lowers faster (see 「2026-09-16 — 식탁 요리 · 낮은 구르기 · 빈 유해 소멸 · 처치 경험치 · 서사 이상 드롭률」).
- Decorative pillar (the fallen mast) at the wake spot moved beside the left ruin wall and given a matching collider.

Design: the lower deck is seven axis-aligned pieces and the holes are the gaps (`DECKS` ∪ `PIT` ∪ `PIT_WALLS` ∪ `ABYSS_CUTS` tile
the old rect); the abyss edge follows the diagonal fence with a 2 m staircase so no hole opens on the player's side; the `ship`
checkpoint band moved 2 m back (z −150…−158) and is narrowed to the ship strip so a body falling into the cut cannot trigger it;
the `ship` respawn is inside the 22 m sense radius — the only exception to the "checkpoints outside enemy sense" rule (see
`docs/TODO.md`). The weapon override travels as a world-side extension of `TutorialEnemySpawn` until `src/shared` is free.

## 2026-09-15 — 땅굴벌레 · Sandworm renamed, cumulative appearance chance, thumper summon, threat-1 weak worm

User choices:
- **Rename** `지하벌레` → **`땅굴벌레`** everywhere the player or the docs see it (ids / keys stay `sandworm`).
- **Cumulative probability instead of a pre-roll**: no seeded "will it happen / when" plan and no time window. The host checks
  every 2 s and rolls that check's chance; **at most once per raid** stays.
- **Condition**: at least **2 members** who are **sprinting** and carrying **`light` (조금 무거움) or heavier** within 40 m of each
  other. Chance grows with more members, heavier loads and a tighter group (3 heavy within 20 m ≈ certain within a few checks;
  2 light at 40 m is low). **Solo never** — a lone human with no android is 0 %.
- **Android squadmates count as members** (their own loadout weight, their sprint flag).
- A **lure grenade** adds to the chance and its spot becomes a candidate eruption spot next to the group centre.
- **Thumper** (`진동 장치`, gadgets): its 5th strike summons the worm at once at that spot if it has not happened this raid.
- **Threat 1 gets a weak worm**: `sandworm_weak` with 750 hp fixed, body 70 %, eruption knockback / damage radius 70 %, spits only
  the weakest bug (scavenger). Threat 2–3 keep the adult.

Design: the eruption spot must pass one world query `WorldRef.burrowGroundOk` (flat bare ground, nothing in the circle — also the
thumper's placement preview) so the two callers cannot disagree; weight state rides on `PlayerSnapshot.ws` (older senders = normal);
the weak worm scales **radius only** (damage and knockback speed unchanged) and bakes its own rig geometry from its csv row so the hit
capsule, burrow depth and look agree without a root scale; `SANDWORM_WINDOW_*` and `SANDWORM_CHANCE_BY_THREAT` are retired rows.

## 2026-09-15 — 타이틀 이어하기 · 레이드 포기 · Title resume · raid abandon (drift)

User choices:
- A remaining raid — a solo save, a tutorial save, **or a squad raid still running on the relay** — no longer drops the boot
  straight back into it. The game starts at the **title**: a highlighted `이어하기` **above** `게임 시작`, and `게임 시작` in
  the warning red.
- With a raid remaining, `게임 시작` opens a warning popup built like the matching screen: the raid's participants as four
  character face tiles, then `닫기` and a 1 s hold `레이드 포기` at the bottom right (`닫기` to its left). It never opens character
  select — switching to another character already means not playing that raid any more (user's reason).
- `레이드 포기` = the character dies in that raid and **drifts** (`표류`): a squadmate's rescue drop cannot bring them back. Then
  `이어하기` disappears and `게임 시작` returns to its normal colour.
- Tutorial: abandoning clears the progress so the next start replays the tutorial from the beginning; the character save stays.
- The solo 5-minute grace is judged **when 이어하기 is pressed** — time on the title counts; past it `이어하기` disappears and the
  raid fails.

Rejected: solo / tutorial only (no title-time server check); a "different character" button in the popup that leaves the raid
alone; judging the grace at boot; tutorial abandon as a skipped track or as a failure.

Design: `game/parts/Resume` publishes `ctx.raidResume`, and `ui/menus/enterShip` (the one road into the game) waits for it. The
solo save is no longer deleted at boot. A squad raid is only visible through the relay, so a local marker written at raid start
(`SQUAD_RAID_MARK_KEY`) is what makes the title connect. A reloaded page's `lobby:mission {false, keep}` keeps the relay's raid
blob, so a second reload still offers the raid. `lobby:abandon` → `LobbyPlayer.drifted` (refuses `lobby:mission true`, left out of
rescue candidates, cleared by the next start / reset). The abandoning client raises its own corpse from the blob at
`RaidSessionBlob.pose` (the `pcorpse` "the dead send it" rule) and settles like a voluntary return. An abandoned or expired solo
raid settles like a solo death, implants included — the old stale-at-boot path only reset the kit.

## 2026-09-16 — 식탁 요리 · 낮은 구르기 · 빈 유해 소멸 · 처치 경험치 · 서사 이상 드롭률 · Table meals · low roll · empty corpses · kill XP · epic+ drops

User choices:
- **Meals are not items any more.** A finished cook becomes **one plate on the personal 식탁**; cooking again **replaces** it after a
  warning popup shown **before the cook starts**. The plate can be eaten any time in the ship and **eating never consumes it**
  (the one pending-meal slot → next raid rule stays). A leftover plate is **deleted when the next raid starts**. **No 식탁 → the 조리대
  cannot be used**; the 식탁 is kitchen-only facility furniture.
- **Shared ship**: my plate is set on my personal table **and** the shared ship's table; **every squad member can eat it**, and it
  is not consumed (replaces `분대에 차리기`).
- **No save migration** for old meal items ("the game is still in development").
- **Crouched roll = low roll** (same animation and hit judgement, ends crouched); **no roll from prone**.
- **All fall damage goes straight to HP** (armor shield ignored) — chosen over a tutorial-only fix for the skipped bandage step.
- **Empty corpses vanish**: player / android corpses 1 s after they hold no items (died empty or looted empty); enemy corpses only
  once opened and emptied (unopened ones keep the 45 s fade). They **sink into the ground**.
- **Liftoff hides every remaining HUD element** (key guide, tutorial UI, chat, squad list, toasts), not only the gameplay layer.
- **Ship Tab = 창고 | 장비 | 가방**; `모두 창고로 이동` (ship only, bag grid only, favourites included) between `모두 수리` and `정렬`.
- **Raid XP = kills only**: a per-enemy csv value (first pass hp/10); loot-value, extraction and survival-time XP removed; death keeps
  ×0.4; quest / contract XP and the tutorial's fixed 120 stay.
- **Epic-and-above loot halved on every planet, except the lab's locked room** (which is fine as is) — guaranteed picks included.
- Tutorial end area: see the replaced line in 「2026-09-15 — 튜토리얼 마지막 구간: 웅덩이 벽 · 절벽 · 안드로이드」; pit walls kept.

Rejected: one plate that blocks cooking; several plates; removing squad meals; the shared plate being consumed; refunds for old meal
items; enemy corpses without loot vanishing at once; hiding HUD from boarding; a per-planet maximum rarity cap; leaving favourites in
the bag; committing this batch.

Design: the plate is the cook's own state (`ShipState.plate`) and travels as `plate state` with no host step, because eating only
changes the eater's profile; the replace warning sits before the cook, but the swap happens only when the cook completes (a cancelled
cook keeps the old plate). The epic+ cut is applied to roll **outcomes** (keep with `epicPlusMul`, else the best rarity below epic in
the same pool) — lowering `epicMul`/`legMul` weights could not work because they cancel inside guaranteed picks and the fallback ignores
weights; it therefore also halves keys, named drops, processors and records (listed in `docs/TODO.md` for review). Carry XP reads a
self-propelled odometer from the controller instead of filtering movement sources one by one. Emptied enemy corpses are client-rolled,
so a client reports `ecorpseq emptied` and the host shortens the body's own `corpseLife` (survives host migration). The tutorial pit's
fence side stays a deck-level rim (2.5 m walls east/south only) so the androids stay visible and a grenade thrown over the fence lands in
the pit, as the 09-15 decision required. Raid XP: `raidXp` column appended last because smokes read `hp` by column position.

## 2026-09-16 — 안드로이드 AI 2차 · 발사 슬롯 · BGM 창 · Android AI pass 2 · launch slots · music window

User choices (UI):
- **The music window shows in the personal ship only.** The record player / gramophone / turntable state is untouched — the shared
  ship simply does not draw the window.
- **The launch-slot panel opens only while I am sitting in a launch slot.** Recruiting an android used to pop the panel open because a
  bot cell counts as seated.
- **The squad list never draws my own row** — in the shared ship *and* in a raid (my HP is already under the crosshair).
- **An android's launch-slot card draws the same full body as a human**, wearing the base kit's armor; the gear thumbnails keep coming
  from `ctx.allies.getLoadout` (the face-only portrait is gone from this panel).
- **Androids carry the base kit from the moment they are called**, not only from raid spawn — the body in the ship is armed and the
  card shows the kit.
- **A raid fails only when every human *and* every android is down or dead.** A standing android keeps the raid alive because it comes
  to revive; a downed one does not count.

User choices (android AI):
- **Free search inside the leader's harness** instead of trailing the leader: prefer a structure / cover point of interest and wander
  around it, but **switch to random patrol when another squadmate or android is already at that point** (a mix of the two options
  offered, chosen by the user).
- **No overlapping**: keep 2 m from other squad members and androids, soft — *"부득이 겹칠 경우, 갈 수 있음"*.
- **Spread out when moving toward a person** instead of stacking into one line.
- **「앞장서라」 doubles the harness** so each android searches its own area, and **expires by itself after a set time** (a newer order
  still overrides it immediately).
- **A PC's enemy ping is agreed to and engaged** — close to a range that suits the weapon in hand: the distance where the weapon still
  does about **50 %** of its damage (from `falloffStart`, not the 100 % point), not one fixed 45 m for every gun.
- **A PC's extraction ping + the 탈출 comms is agreed to**, and the androids move to *that* extraction, inside the harness.
- **Crates, containers and corpses are no longer raced for**: a pinged one first (no distance limit), and an unpinged one only when
  the android is idle and it is close by.
- Bugs fixed as part of the same pass: androids could not shoot an enemy that closed to contact range, and a 「저쪽으로 가자」 ping made
  them oscillate between the ping and the leader.

Rejected: showing the launch-slot panel whenever any member is seated; keeping my row in the raid squad list; a face-only android
portrait; androids outside the wipe decision (a squad of one human + androids ended the moment the human went down); purely random
roaming; pure point-of-interest roaming (two androids would pile onto the same structure); 앞장서라 that never expires; a per-weapon
engage-range table in csv (the falloff columns already say it); leaving autonomous looting on with a priority tweak.


## 2026-09-16 — UI 대묶음 · 기업 가격 · 가치 재조정 · UI batch · shop prices · value rebalance

A single pass over the inventory / workbench / trade screens and the item economy.

User choices (UI):
- **The native `<select>` is gone from the whole game.** The inventory filter — the only one — is now a drawn dropdown
  (`shared/dropdown.ts`). The three reasons the native control had been chosen for (clipping inside `.tg-gridwrap` /
  `.inv-stash-scroll`, outside-click dismissal, Escape) are paid for by a `position: fixed` list under `document.body`,
  a capture-phase `pointerdown`, and a capture-phase Escape that the list swallows so the inventory window behind it
  stays open.
- **The stash header says `함선 창고` on the left and only `사용칸 / 전체칸` on the right** — the item-*kind* count is
  dropped; the player wants to know how full the grid is, not how many distinct things are in it. `TradeGrids`'s
  `N점` readout is replaced by the same string (`ui/labels.capacityLabel`), so the two headers cannot drift.
- **`[업그레이드]` opens the 창고 upgrade modal from two places** — the inventory Tab stash header and the workbench
  window's title bar. It is the existing housing `UpgradeModal` made standalone, not a second modal, and the two callers
  reach it through **one new `HousingRef.openStorageUpgrade()`** rather than importing housing internals.
- **An empty workbench keeps its size** — the frame stays as wide as five item thumbnails so upgrading a bench does not
  make the window jump.
- **The furniture popup sits below the inventory family.** It had z-index 77 against the inventory window's 50, and its
  ancestors make no stacking context, so a cheat-opened container drew under it.

User choices (items · economy):
- **기업 판매가 = 가치 × 3** (`SHOP_PRICE_BASE_MUL`). Reputation discount and the player's sell price are untouched.
- **A shop tooltip shows the price of that screen, not 가치** — 구매가 on the shelf and the buy tray, 판매가 on the sell
  tray. Everywhere else the tooltip keeps showing 가치.
- **Ammo is sold by the full stack** (`Rules.shopQtyOf` → `AMMO_STACK_ROUNDS`), and the shelf is **10 columns** wide.
- **Numbers of credits, value, currency and XP are abbreviated from 10,000** — `10.0k` (one decimal), `1.00m` / `1.00b`
  (two decimals), decimals truncated so `999,999` reads `999.9k` and `1.00m` starts exactly at a million. `k` starts at
  ten thousand, not one thousand: four digits are read at a glance, five are not. Counts, weights, durability, ammo and
  times stay exact.
- **모든 재료 가치 −50 %** (`category: material`, 61 items) and **모든 귀중품 가치 −80 %, then the ones digit dropped**
  (`category: valuable`, 14 items — the only category holding samples and artefacts). Truncated, floor 10, so nothing
  becomes worthless.
- **가젯은 노마드 장비가 판다**, not 세레스 바이오 — and since `grenade` stopped being an `ItemCategory` on 2026-09-15,
  that one `corp_stock` row moves grenades with it. 세레스 keeps 회복 소모품 · 부착물 · 임플란트.
- **생체 조직 is gone from every facility and furniture cost** (의학 작업대 · 재배층 · 재배 스테이션 · 분석기 ·
  배양조 · 조합대). Deleted outright, not substituted — those things are simply cheaper now.
- **진동 장치 does not stack and has no recipe**; it stays a drop (아켈론 II 전진기지 지하실, 5 %).

Bugs whose cause was not what the symptom suggested:
- **Right-aligned item tooltips** in the corp / craft-ingredient / bookshelf / compute-cluster screens were a CSS
  **prefix collision**: `hub/intel.css` took the `.it-` prefix the item card had used since Phase 8 and declared a global
  `.it-head { align-items: flex-end }`. In a column flex that is "right-align", which is why only 이름 and 종류 moved.
  Fixed at the card (it now states every axis, so a future foreign `.it-*` rule loses on specificity); renaming
  `intel.css`'s class is left as a to-do for hub/.
- **Items could not be moved inside the embedded 창고 | 가방 card.** Not a broken drop — `TradeGrids` had never had one:
  its `pointerup` only looked at the caller's drop tray. Cell moves, 창고 ↔ 가방, rotation and merge now all go through
  `DropResolver`, so every existing rule (no silent displacement of equipped gear, merge overflow stays on the cursor,
  bag padding rows are not targets) holds unchanged.
- **The workbench 닫기 opened the bag**: `openBenchCraft` opens the Tab window as the host for the craft column, and
  `닫기` closed only the column, revealing it. Fixing it broke the tutorial in a way only the smoke caught — step 11
  `equipGun` spotlights slots inside the inventory window, which `닫기` now closes, so the step began with no window,
  no spotlight and a hint that still described the old behaviour. The tutorial's `openBag` / `equipGun` hints now say
  Tab reopens it, and `equipGun` carries the `Tab 가방 · 장비` control guide while the window is shut.
- **Drag ghosts from grow stations and display stands were a fixed square** — they ignored `ItemDef.width/height`.
  The footprint formula moved to `shared/itemChip.ts` so housing and inventory cannot drift.

Rejected: a second inventory-styled upgrade modal beside housing's; moving the `[업그레이드]` button to the ship
management screen; replacing 생체 조직 with another material or raising the remaining quantities; abbreviating item
counts and weights along with credits; `k` from 1,000; rounding (rather than truncating) the abbreviations and the
귀중품 values; locking the embedded grids read-only.

## 2026-09-16 — 제작과 숙련 · Crafting and skills

The crafting skills (제작 · 의학 · 원예) were doing three jobs: they gated recipes (`recipes.csv` `skillRequired`), they
shortened the craft hold (`craftSpeedMul`), and — for the research benches only — they refunded materials. The user cut
that down to **one**: *"아이템 제작에 관련 숙련도는 전혀 관여하지 않도록 변경 (요리, 연구 등 모든 제작관련). 숙련도가
관여하는 것은 제작 시 재료 아이템을 일부 돌려받을 확률, 돌려받는 양 등에만 관여."*

User choices:
- **No skill gate anywhere** — normal crafting, the cooking bench and the lab benches. What a bench can make is decided by
  the **workbench level** alone (and, for a dish, its recipe book). `skillRequired` stays as a csv column and a contract
  field with every value `0`, so a future design can raise it again without a data migration.
- **…and, the same day, the reading side was put back** (2차 결정): *"작업대에 숙련도 부족한 아이템에 대한 잠금 처리도
  넣어줘 (현재 숙련도에 의한 잠금은 없으나, 숙련도 요구 컬럼 자체는 존재하므로 추후에 추가될 수도 있음)."* A column with
  nobody reading it is not a switch that can be flipped later — it is a number that silently does nothing. So the gate is
  live in all four places (`Crafting.getRecipes`, `cookBlock`, `CraftPanel.lockedReason`, `Cooking.cookRecipeSkillBlock`)
  and simply never fires while every value is `0`. A gated recipe does **not** vanish from the list: it becomes a locked
  cell tagged `제작 20 필요` in the workbench window and a `제작 20` badge on the cook rail, and crafting it is refused.
  Verified with temporary fake csv values (gadget bench `20` / `15`, cook `20` / `25`): `smoke-cooking` 136/136 with its
  skill-lock section actually running for the first time, plus a throwaway check of the workbench window; the values were
  then returned to `0`.
- **No skill craft speed** either. Every craft is the same `CRAFT_HOLD_TIME`.
- **The refund is rolled per consumed material unit**, not once per craft: the chance is linear from 0 at skill 0 to
  `CRAFT_REFUND_CHANCE_AT_MAX` (`data/tuning.csv`) at skill 100. A big recipe therefore feels bigger and the outcome
  spreads out naturally, instead of one all-or-nothing roll making a 35-scrap sniper feel like a 1-powder round of ammo.
- **Durable gear (무기 · 방탄복 · 가방 · 내구 가젯) is excluded from the refund** (lead's call inside the user's decision).
  Those items' repair cost and salvage yield *are* their craft materials, so discounting the craft alone moves the
  economy invariant's own baseline; with the refund applied to them, `checkSalvageEconomy` reports 66 violations of
  「수리 + 분해 ≤ 제작」 (all from rounding on 2–6-unit material lines: repair rounds up, so `ceil(0.5 × 3) = 2` already
  exceeds `0.65 × 3 = 1.95`). Materials, consumables, ammo, attachments and dishes keep the refund; those are exactly the
  things salvage cannot pay out on, and the hand-written salvage rows (탄약 · 기계 부품 · 실드 충전기) are now checked
  against the **discounted** craft cost.

Rejected: lowering `CRAFT_REFUND_CHANCE_AT_MAX` to make durable gear fit; deleting the `skillRequired` column, its loader
and `CraftRecipe.skillRequired`; keeping the always-×1.0 `제작 속도` row on the character sheet; a separate
`재료 회수` toast per refund source (craft skill and research skill now share one line).
