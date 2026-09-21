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
`src/world/README.md`). The weapon override travels as a world-side extension of `TutorialEnemySpawn` until `src/shared` is free.

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
weights; it therefore also halves keys, named drops, processors and records (listed in `src/items/README.md` for review). Carry XP reads a
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
- **No overlapping**: keep 2 m from other squad members and androids, soft — 「2 m 이내에 겹치지 않도록 피해서 가기, 부득이 겹칠 경우 갈 수 있음」 (`src/allies/parts/Nav.separate` · `ALLY_SEPARATION_M`).
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
  Fixed at the card (it now states every axis, so a future foreign rule loses on specificity); the prefix itself was
  split on 2026-09-17 — see that day's entry.
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

---

## 2026-09-16 — 신화 등급 · 표본 개편 · 행성 광맥 · Mythic rarity · samples · mineral veins

The user's batch: a rarity above legendary, a full rewrite of the lab's unknown specimens, mineral veins on every planet
with a new 채광 skill, the 연산 코어 → 프로세서 swap, and a 수집품 super-category the quest system can ask about.

### 신화 (mythic)

- A **sixth `Rarity`**, pink `#ff6fd0`, label 「신화」 — not a flag on top of legendary. A flag would have forced every
  rarity comparison (the new minimum-rarity guarantee, `epicPlusMul`, the shop cap) to branch twice.
- **Drops never roll it.** `items/LootTables.RARITY_ORDER_LOOT` cuts crate and corpse rolls at legendary, so a `mythic`
  column in a loot csv is read by nobody. Mythic exists only where something hands it over directly: the 6 unique weapons,
  the 3 perk armors, 시원 세포주, mythic samples (미확인 세포 VI · 미확인 광물 VI) and the 6 mythic minerals. Consequence
  the user accepted: unique weapons have **left the crate weapon pick** and now come from crafting, the boss-corpse
  unique chance and `loot_named.csv`.
- 2026-09-17: the 유전자 line lost its mythic tier entirely — see 「표본 — 3 계열 × 6 등급」.
- 유니크 무기 6종 → mythic (written in code — `weapons_unique.csv` has no rarity column). 특성 방탄복 3벌 → mythic with
  shield 100 (전설 방탄복 V 수준) **and** their perk, durability 700.
- Rejected: a `mythic` weapon grade VI (the uniques have no grade at all, so `WeaponGrade` stays 1–5); letting the shop's
  bag bonus reach mythic (`shopRarityCap` is now pinned to the legendary rank).

### 표본 — 3 계열 × 6 등급

- Samples: `spec_gene_*` (유전자, 토양·배양조) · `spec_cell_*` (세포, 배양조) · `spec_mineral_*` (광물, 무기). The old
  3 + 11 retired rows were **deleted outright** — the user waived save migration for this development stage, so no
  `item_aliases.csv` rows were added (a knowing exception to CLAUDE.md §4.1, marked at each deletion site).
- **Overturned 2026-09-17 — 유전자 계열은 전설(V)까지다.** 신화 is now reserved for the gun line, so `spec_gene_6`
  (미확인 유전자 VI) and the only two mythic rows it fed — `sock_soil_prime` 원종 인자 · `sock_medium_prime` 원형질 인자 —
  were deleted the same way (rows gone, no aliases). 17 samples remain: 세포 · 광물 I…VI, 유전자 I…V. 미확인 세포 VI
  stays because 시원 세포주 (mythic 세포주) is its top row, and the mineral line keeps VI as the sole source of the
  6 mythic minerals. Rejected: demoting the two sockets to legendary (결실 · 분열 인자 III already hold that rank), and
  keeping VI as a legendary sample (the roman numeral **is** the rarity).
- **A sample's rarity is the floor of what it analyses into**, not the ceiling: 미확인 유전자 III(희귀) yields 희귀 이상
  only. Low-grade samples keep every higher row as a candidate; high-grade samples lose the lower ones.
- `analysis_results.csv` gained an optional `sampleRarity` column that binds a row to one sample rarity and exempts it
  from the floor. Its only use today is the six 석영 결정 rows — 「미확인 광물은 등급과 상관없이 석영이 나오되 등급이
  높을수록 많이」 — and they double as the guard that no rarity is ever left with an empty candidate list.
- **도감 보너스가 종류별에서 등급별로 바뀌었다**: filling one codex cell speeds up every sample *of that rarity*, and a
  sample gains its own level as you keep analysing it. The curve is deliberately front-loaded — reaching level 1 grants
  `ANALYSIS_SAMPLE_LEVEL_FIRST` (+3 %) at once, each level after adds only `ANALYSIS_SAMPLE_LEVEL_STEP` (+0.5 %). Level
  cap 10, combined speed-up capped at 50 %. Rejected: level 5 / cap 40 %, and an uncapped level with a flat step.

### 광물 · 광맥 · 채광

- Mineral veins spawn on hillsides (slope ≥ `MINING_HILL_MIN_SLOPE`) as a new **gather node**, not a destructible with HP
  and not a tool-gated interaction — reusing the E-hold path kept world, net and UI untouched.
- A vein's rarity uses the **gun drop table** (`loot_tiers.csv`, row `tier = 행성 threat`), so threat 1 tops out at 희귀
  by itself. The new `mining` skill (`miningRarityBonus`) **multiplies** the weights above the lowest, so a rarity the
  planet weights at 0 stays impossible at any skill level. No second probability table was created.
- 일반~희귀 광물 have real uses (가구 재료 · 가구 업그레이드 · 요리); 서사 광물 1종 is a shared ingredient of every 서사
  gun, 전설 = 쌍정석 of every 전설 gun; 신화 광물 6종 are one per unique weapon and **the uniques got craft recipes**.
- Side effect the user ruled on: those recipes made uniques salvageable. **분해는 허용하되 신화 광물은 산출에서 빠진다** —
  cut on rarity (`salvageYieldOf`), not on "is it unique", so any future item eating a mythic material inherits the rule.
- 석영 결정 moved from 귀중품 to a 일반 등급 광물 like 암염 결정; both stack to 5.

### 프로세서

- 연산 코어 deleted; **프로세서 goes straight into the 연산 클러스터** and has durability. Every mounted processor loses
  `PROCESSOR_WEAR_PER_CYCLE` when a mining cycle completes, and its contribution falls linearly to `PROCESSOR_PERF_MIN`
  (0.5) at durability 0 — repair at the ship bench to get full speed back.
- The user confirmed this is **per processor**, not per cluster: cluster speed is exponential in the mounted count, so a
  fully worn 9-slot cluster is ~22.6× slower than a fresh one, not 2×. Rejected: multiplying the cycle rate instead of the
  exponent, which would have made "절반" literal at the cluster level.
- 쌍정석 1 + 연마재 1 → 결정 코어 (추출기); 결정 코어 1 + 회로 기판 4 → 프로세서 (조합대). The user asked for 회로 기판
  without a count; **4** is the smallest value that keeps 「수리 + 분해 ≤ 제작」 true once the processor became durable gear.

### 수집품 (super-category)

- `SuperCategory` is a layer **on top of** `ItemCategory`, not a merge of book/disc/record/game_disc/console into one
  category. The tooltip 종류 line reads 「수집품 > 서적」 and a quest can ask for 「가치 10,000 이상의 수집품」, while every
  existing filter, sort, save and loot path keeps reading the unchanged `ItemCategory`.
- The quest goal type itself is **deferred** (user's call) — this batch only lays the axis. → `src/meta/README.md`

### 필라멘트

- Each grade's recipe drops the previous-grade filament and takes **1 of each** material; output is 1 as well, so the
  value per craft is unchanged rather than halved in cost and doubled in yield.

## 2026-09-16 — HUD · 메신저 · 튜토리얼 다듬기 · HUD, messenger, tutorial polish

- **Empty corpses, all kinds** (player, android, tutorial, enemy) sink 1 s after the looting ends — empty *and* nobody
  (local or squadmate) has the loot window open. Once sinking starts the corpse can't be interacted with (2026-09-17). Rejected: enemy-only / player-only.
- **Weapon panel dims for anything non-primary in hand** (quick use, grenade, stim, holstered). Rejected: T quick
  use only. A melee swing does **not** dim it — melee is hitting with the primary in hand (2026-09-17). The old consumable mode of the big panel is gone.
- **Pickup toast always shows the quantity** (`×1` included).
- **Messenger stays ship-only**: button, `P` hint and red-dot pop exist only in the ship, including over Tab / ESC menus.
- **Ship doors**: sliding leaves removed, frames kept, with overlapping trim at the openings cleaned up. Rejected: removing frames.
- **Revive from downed**: tutorial revive only. A normal raid's rescue drop keeps the raid-start pod sequence (already the case).
- **Inventory credits as text** (`n C`, compact above 10k), not the currency chip.
- **Stat tutorial control guide shows Tab only** (agent's call, pending user review): the ESC pause menu has no route to the character tab.

## 2026-09-17 — 가구 제작 모달 · 기업 신뢰도 게이트 · 함선 튜토리얼 묶기 · furniture craft modal, corp gate, grouped build tutorial

- **Furniture craft = centre modal** (list thumbnail, `{이름} 제작`, material chips, 1 s hold `제작` bottom right). **Storage red dots are
  session-only** (tab dot → cleared when the store list shows; per-card dots cleared on close / placement). Rejected: saving dots in `ShipState`.
- **Corp access starts at Lv.1**: the Tab `기업` screen tab is hidden until any corp is Lv ≥ 1 (`CORP_ACCESS_REP_LEVEL`), Lv.0 corps cannot be
  selected, **every** contract `minRepLevel` shifted +1. Lv.1 comes from the first 세레스 / 노마드 NPC quest (`q_ce_s1` / `q_nm_s1` +100).
  Rejected: shifting only Lv.0 contracts; giving Helix / Bastion first quests Lv.1 too.
- **민지후 · 차유나 first contact also needs `q_rv_0`** (Raven's first quest) — Raven alone opens the NPC chain.
- **「함선 호출」 → 「함선 지원」 game-wide** (stratagem wheel, keybind, toasts, contracts). Extraction naming unchanged.
- **Build tutorial = 7 steps with sequential objectives**; training button and launch readiness warnings hidden during it. The last step
  (`가치 1,000 C 이상 … 무사히 탈출`) is **one attempt**: the track ends when that raid ends, whatever the outcome. Rejected: keeping the
  objective until a successful extraction.
- **Tutorial-raid control guide** (M · Q · G hold · V · X, `]` folds it to one line) only in that raid.
- **No toast** on tutorial track completion or tactical implant swap. Barbed-wire fence ×1.5 (2.025 m). Extraction ship's world HUD marker
  removed (map / compass keep it); the player silhouette never shows through the leaving ship.

## 2026-09-17 — 무한 상자 창고 우선 · 좌석 꾸밈 가구 · 좌석 없는 게임 · catalog stash-first, seats as decor, seatless video games

- **Double-click quick move prefers the stash when both stash and bag are visible**; bag only if it does not fit. Applied to the
  무한 상자 (ship). Container windows never show the stash, so their double-click order (empty slot → bag) is unchanged.
- **의자 · 쇼파 are 꾸밈용 가구** (not 시설 가구) and may be placed **in any room** — reverses 2026-09-15 「쇼파는 서재 전용」. Sitting
  and the TV game seat behaviour stay. The 흔들의자 stays a facility (library book bonus).
- **Video games need no seat.** A valid seat in front of the TV (existing rule) is sat on; otherwise the player plays standing where
  they are, with the normal camera (agent's call: no new standing pose — the only standing furniture pose is the cook one). Seat
  block reasons and the "sit in front of the TV" hint are gone from the TV screen.

## 2026-09-17 — 단련 → 스탯 XP · 배양 시작 확인 · 배양조/재배 스테이션 여러 대 · 캐릭터 시트 머리

- **Gym / video game XP goes into the stat's normal XP bar.** Whoever's XP crosses the bar decides: minigame → trained +1 (shown as
  plain `+N`), action → base stat +1. Rejected: minigame XP raising the base stat; a separate 단련 bar drawn in the stat XP slot.
  Old `trainedProgress` is dropped, `trained` kept.
- **Culture starts only on a 1 s hold confirm** (`배양을 시작하겠습니까?`); before that cell line and scaffold come back out.
- **Culture tanks and grow stations: no count limit** (floor space only). Rejected: generator-level cap, fixed cap.
- **Chair / sofa seat rule: video games no longer require a seat** (sits if one is placed under the old rule).
- **Character sheet header = character name**, buff/debuff thumbnails beside it; 레이드 / 탈출 counts removed from the sheet **and** the
  title character-select cards.

## 2026-09-17 — CSS 접두사 충돌 정리 · CSS prefix collisions (B-18)

- **Both sides of the `.it-` collision were renamed**, not just the newcomer: the intel screen took `.his-`
  (hub/intel.css) and the item card took `.itip-` (ui). `.it-` is now unused, so neither side can be said to have
  "won" it. Rejected: renaming only `hub/intel.css` (the original to-do), and folding the intel screen into the
  existing `.hi-` panel prefix — five of its class names (`body`, `row`, `row-label`, `row-effect`, `actions`)
  collide with the panel's own.
- **The card keeps its defensive axis declarations** even though the collision is gone: the card hangs off
  `#ui-root` and must look the same from every screen on its own account.
- **A check now enforces "one prefix, one folder"** (`scripts/check-css-prefixes.mjs`, run by `verify`) instead of
  the convention alone. Rejected: keeping the convention and noting the gap in `scripts/README.md`.
- **The three collisions the check found were cleaned up the same way — the smaller set moves.** Community invite
  rows `.ci-` → `.cmi-` (ui, they live inside `.cm-invite` anyway; meta keeps `.ci-` for the implant desk), contract
  columns `.cc-` → `.ctr-` (meta; ui keeps `.cc-` for character creation), character-slot cards `.cs-` → `.csl-`
  (ui; progression keeps `.cs-` for the character sheet).

## 2026-09-17 — 컷씬 중 숨김 · Popups hide for a cutscene (B-17)

- **A popup that cannot be closed hides for the length of a cutscene and comes back unchanged.** The ship's
  「모든 UI 닫기」 before a dock (`hub/parts/SquadDock.cancelEverything`) cannot reach the tutorial cards: they are
  outside the escape stack and closing one is what advances the step. Rejected: the original to-do's plan of giving
  `TutorialRef` a close API plus step-state restoration — hiding needs no restoration at all, because nothing was
  changed.
- **Hiding is DOM + blocker + cursor + hold gauge**, not visibility alone. A held `uiBlockers` token over a cutscene
  floats a soft cursor and blocks the hub's pointer re-lock (`Transitions.relock`).
- **The contract lives in `src/shared`** (`cutsceneHide.ts`), not in the tutorial folder: "a cutscene owns the screen"
  is one line — docking, window warp and the liftoff cinematic — and the next unclosable popup subscribes to the same
  one. Rejected: a tutorial-only handler.
- **All three cutscenes count**, including the window warp, which keeps the camera inside the ship — the ship's corner
  widgets already disappear for it (`ui/hud/CutsceneWatch`), so a card floating through the flight would be the odd
  one out.
- **Restoring is unconditional**: the card returns exactly as it was, with no re-validation of the tutorial state and
  no sound. Rejected: dropping the card when the track ended mid-cutscene — one more judgement for a case the
  tutorial already handles by closing the card itself.

## 2026-09-18 — 폭발 · 근접 차폐 · 벌레 발소리 · Blast/melee occlusion, bug footsteps

- **Explosions (player and enemy, artillery shells included) and melee (player and enemy) no longer pass walls,
  roofs or floors.** Judged by a **3-point body sample** — feet, chest, head; any clear line = full damage, all blocked
  = none. Rejected: a single chest ray (low cover and window sills read wrong); scaling damage by the visible fraction.
- Any solid collider blocks (terrain ridges, rocks and props too), broken windows let it through. The sandworm
  eruption is not an explosion and stays unoccluded.
- **Bug footsteps louder everywhere:** longer range and higher gain with a flatter distance curve. Rejected: boosting
  only bugs behind the camera; boosting only nearby bugs.

## 2026-09-17 — 피해 1/3 · 헌터 · 포병 · 세포 드랍 · Damage ÷3, hunter, artillery, cell drops

- **All damage dealt to enemies and all enemy HP drop to 1/3 (floor)** — guns, legendary uniques, melee, ship calls,
  rover turret/ram, implants, and enemy-vs-enemy damage (`ENEMY_CLASH damageMul`). Rejected: guns only (other sources
  would be 3× stronger). **Unchanged:** damage to players, planet environment / hazard damage to enemies.
- **Explosives use explicit values, not 1/3:** frag 60, incendiary blast 30 + fire zone 10/s, mine 80, remote mine
  100, turret 15/s. **Outer ring is 50 % for every explosive** (`EXPLOSION_OUTER_MUL`). Rejected: an incendiary-only
  30/20 split. Every explosive tooltip shows `min-max`, not only the frag grenade.
- **AR −15 % damage and −10 m range** before the 1/3 cut. **Shotgun hip-fire spread = old ADS spread; ADS only zooms.**
- **Tutorial androids 30 HP** so one frag still kills both in the pit. Rejected: reshaping the pit.
- **Hunter:** red stripes; leap 10–18 m, −20 % speed, 12 s cooldown; **20 cumulative damage during one leap** drops it,
  flipped 3 s, rocking. Rejected: a single-hit threshold (an AR bullet is 17).
- **Toxic bug:** burst 60; added to threat 1–2 planets instead of raising its weight on 베르단트 III.
- **Artillery:** spawns with a 2–3 scavenger escort (rejected: joining nearby packs); fires only when another bug is
  within 10 m of the target, braces 1 s, locked 5 s after firing; a lone target in range → summons 2–3
  `scavenger_summon` **once per artillery**, a no-drop, no-XP type (0 raidXp — rejected: scavenger XP 12). `maxArtillery` stays a live cap (the double spawn was a
  counting bug).
- **Cell drops replace every sample row** of hunter · toxic · warrior · artillery · charger · behemoth · both sandworms
  (rejected: replacing cell rows only / adding on top). **Corpse sample rows are exempt from the epic+ downgrade** so
  cell IV drops at the stated rates.
- **Messenger preview shows only messages that have appeared.** Equip-gun tutorial step is skipped when an AR is
  already in a primary slot or both primaries are filled.

## 2026-09-18 2차 — 튜토리얼 분리 · 둥지 · 포병 정찰 · Tutorial split, nests, artillery scouting

### 튜토리얼
- **「증축 안내」 ends at the rifle being equipped, and 터미널 → 탑승 → 레이드 becomes its own track** 「출격 안내」
  (a 4th `TutorialTrack`, `raid2`). Rejected: one track renamed in two halves (the panel would lie about the
  progress bar); appending the two steps to the ship track.
- **The raid step's progress bar counts credits, not steps** — the bag's `raidFound` sell value against
  `TUTORIAL_RAID_EXTRACT_VALUE_C` (1 000 C) — and the label **shows the value past the goal** (`1,400 C / 1,000 C`).
  Rejected: clamping the text at the goal.
- **During a tutorial raid the map shows the track's objectives, top-left**, above the NPC quest panels.
- The equip-gun skip (already decided 2026-09-17) is re-reported as still demanding the step; it is now evaluated
  **when the inventory opens** as well as on step entry.
- **No floor guide line during the launch wait** — once the readiness hold is done there is nothing to walk to.

### 벌레 둥지
- **Bug eggs stop being scenery: each egg sac is a destructible, immobile enemy** (`bug_egg`, a new
  `data/enemies.csv` row — rejected: fewer eggs with higher HP; keeping the decorative pile and adding one big
  separate 알집). It never moves, attacks, becomes aware, staggers or makes footsteps, and it satisfies nothing that
  counts bugs (artillery support, waves, the nest garrison).
- **The eggs *are* the nest's reward: crates no longer spawn near a nest.** Drops are 미확인 세포 + 생체 조직, the
  cell rate sitting **between 헌터 and 워리어**.
- **The lost crates are not replaced anywhere else.** A raid drops ~4–6 tier-3 crates (out of ~20–40) when the nest
  ring goes, and that is the point: part of a raid's total reward moved out of the crate system and into the eggs.
  Rejected: raising the POI / structure crate rings to keep the old crate count.
- **Nest bugs are leashed to 60 m from their nest** — 「적당히 따돌리면 돌아간다」. Rejected: a 40 m leash (one
  cover-to-cover break would shake them). Bugs that did not come from a nest keep an unlimited chase.
- **Half the initial garrison, and 1–3 refills per nest per raid at 50 / 35 / 15 %** (3 deliberately rare), fired when
  the nest's living mobile bugs fall to about a third of what it started with.

### 포병
- **A shell needs a bug beside the target *and* a prep beat.** The support condition stays 「any bug within
  `supportRadius` of the target」, but it now opens a 포격 준비 state before the first shot instead of firing at once —
  the complaint was being shelled out of nowhere.
- **The artillery keeps its own scavengers alive: the once-per-lifetime summon becomes a respawn.** When every
  scavenger of that artillery (dig-in escort and summoned squad alike) is dead, a cooldown runs and it summons a fresh
  squad. Rejected: requiring shared line of sight from a scout (the artillery would almost never fire).

### 기타
- **Blast damage no longer passes a window, broken or not**; low cover is untouched (the 3-point body sample already
  lets a peeking head be hit). Rejected: letting only *unbroken* glass block; exempting destructible cover from the
  blast rays.
- **Planet 표본 채집지 are retired entirely** (`sampleNodes` 0, `samples` empty — the columns and the code stay).
  미확인 광물 comes from 광맥 and 고철 더미, 미확인 세포 from bugs and now bug eggs, 미확인 유전자 from the 연구소.
  Rejected: leaving mineral-only sample nodes standing.
- **The tram never turns around.** It keeps one orientation for the whole raid and shuttles back and forth facing the
  same way; only the travel direction flips. Flipping the body mirrored a rider across the car (the ride math re-solves
  vehicle-local coordinates every frame), which is the reported teleport. **Cabin containers are removed** — platform
  containers stay.
- **The rover's map icon faces its travel direction** (the icon was rotated with the wrong sign for the map's
  `canvas y = +Z` convention).
- **You may only buy intel for the planet you have targeted.** The 현상 수배 row looked broken on the two threat-2
  planets because the intel screen judges the ship's **target** planet while the terminal's pager is only a preview —
  paging to 보레아스 IX with 아켈론 II still targeted locked a row that is open on 보레아스 IX. 정보 구매 is now
  disabled until the paged planet is the target. Rejected: letting 정보 구매 silently set the target; buying for the
  previewed planet (money spent on a raid you may not fly); leaving it and only rewording the lock note.


## 2026-09-19 — 안드로이드 감사 묶음 · Android audit (B-59…B-62)

Four TODO rows the English comment pass had surfaced in `src/allies`. Only the questions that were a real choice are here;
everything else was code brought back in line with a rule already written down.

- **A crate ping names its container by id.** `PingMessage.containerId` / `ping:placedV3.containerId` (add-only) carry the
  loot-container id, and `allies/` acts on that. Rejected: matching the crate by the ping's position alone (the existing
  fallback, kept only for a ping that carries no id) — the ping already knows exactly which crate it snapped onto, and the
  label it used to pass (`보급 상자 (n등급)`) is a display string that matched nothing.
- **An android's atmosphere damage gets the exposure gate, not the preparation gate.** `parts/Vitals.update` now skips the
  planet-atmosphere tick outside gameplay and on the training range, the same as a person. It does **not** read
  `ProgressionRef.hasEnvPrep`: a preparation is a personal profile purchase and an android has no profile. Recorded as a known
  limit in `src/allies/README.md`. Rejected: giving an android the squad leader's preparation (a bought preparation would then
  protect bodies it was never bought for); leaving the code untouched and only documenting it.
- **Dead code is deleted, not annotated.** `Roster.isAlly` · `copyOf` · `snapshotItems` · `myPeer`, `Spawn.localPeer` and the
  `Sync.w2id` alias had no callers; their comments explained invariants nothing was keeping. `w2id` was removed without adding
  an `isAndroidId` re-check on those seven paths — `onAlly` already refuses anything not sent by the host. Rejected: keeping
  them with a 「no callers today」 note.
- **The 2 m separation decision is one sentence in three places.** 「2 m 이내에 겹치지 않도록 피해서 가기, 부득이 겹칠 경우 갈 수 있음」
  — `parts/Nav.separate` (on one line now), `ALLY_SEPARATION_M` in `data/constants.csv`, and this file. Same for the base kit:
  「호출되는 순간 기본 킷을 장착한 채로 선다」 in all three of `parts/Bag` · `parts/Hub` · `parts/Roster`.


## 2026-09-19 — 출력 언어 분리 · Output language split

The English comment / docs migration (§4.1) was starting to pull the *conversation* into English with it. The two are now
stated as separate channels: **what an AI reads is English** (code comments, `CLAUDE.md`, every `README.md`, `docs/*.md`
except `docs/TODO.md`), **what a person reads is Korean**.

- **Korean covers chat replies and work summaries, commit messages (subject and body) and `/compact` context summaries.**
  Generated trailers (`Co-Authored-By:`) stay as they are. Inside Korean prose, labels, paths, identifiers, commands and csv
  names are kept verbatim in backticks — the same rule §4.1 applies to English comments, run in reverse.
- **The rule is written twice on purpose**: `~/.claude/CLAUDE.md` §4 as the principle for every project, project
  `CLAUDE.md` §4.1 + §6 for this repo’s specifics. Rejected: a custom `~/.claude/output-styles/` file switched on with
  `/output-style` (it replaces the whole system prompt behaviour for a one-line language preference, and a teammate cloning
  the repo would not get it); leaving it implicit because replies happen to be Korean already.
- `docs/*.md` stays English — **not** rolled back to Korean. `DECISIONS.md` and `HISTORY.md` are read by an AI far more
  often than by a person; the summary in chat is where the person gets the Korean.

## 2026-09-19 — 주석 감사 묶음 · Comment audit batch (B-27…B-58)

Thirty-two TODO rows the English comment migration had surfaced across eight folders, run as eight parallel agents
with the lead owning `src/shared` · `data/` · `scripts/`. Only the questions that were a real choice are here;
everything else was prose brought back in line with code that already existed.

- **The audit is taken all the way, not just the comments.** Stale prose, dead code and the behaviour bugs the same
  pass had found are one batch. Rejected: comments only (the bugs would have stayed filed for another cycle);
  comments plus dead code (the same, one step later). Where a finding turned out to be an **intended limit** it is
  not deleted — it goes in the owning folder's `README.md` under `## Known limits` (grow-station tier locks, the
  hub's coordinate-keeping `repairBench()` · `Parts.workbench`, `TradeGridsOptions.layout`, the crafting skill gate).
- **`broken pair`, not `broken twin`.** The same thing had two names; `broken twin` was the majority (nine spots in
  `inventory` · `items` · `progression` · `shared`) but `CLAUDE.md` §4.6 · `shared/types.ts` · `game/README.md` said
  `broken pair`, and the rule document wins. The nine were renamed. Rejected: renaming the three instead (cheaper,
  but it makes the rule document follow the code rather than the other way round); leaving both and filing it again.
- **The intel note names whichever action is on screen.** With intel already held `정보 구매` is hidden, so the old
  single line explained a button nobody could see. There are now two: `분대장만 정보를 살 수 있습니다` and
  `분대장만 지역을 재배치할 수 있습니다`. Rejected: hiding the note with the button (then nothing says why
  `지역 재배치` is greyed out); keeping one line that is false half the time.
- **A game disc's minigame name moved into the contract.** `GAME_MINIGAME_LABEL_KO` · `gameMinigameLabel` are in
  `src/shared/housing.ts` now, because housing's screens and ui's item tooltip both print them and a folder may not
  read another folder's internals (§4.1). The tooltip had been printing the **gym equipment** name
  (`호흡 달리기`) and the library catalogue a third spelling of its own; all three now say `호흡형`.
- **The stirfry score divides by beats offered, not by clicks judged.** One perfect click followed by doing nothing
  until `maxTime` used to score 1.0. It is the same rule `chop` and `grill` already follow, and it makes stirfry
  harder: an empty beat now costs. Rejected: dividing by the number of perfect clicks needed (`ceil(1/FILL_PERFECT)`)
  — an all-good run then clamps to 0.96 and good stops being distinguishable from perfect. Per §4.2 the judging
  windows were not touched; if it plays too tight, `COOK_STIRFRY_BEAT_S` is the dial.
- **A smoke's wait takes the end of the run as a second exit.** `smoke-phase3`'s laser step could be outlived by its
  own raid, and reported a 60 s timeout that said nothing about the laser. Recorded in `scripts/README.md` as the
  general shape, with B-22.
- **The retyped-label check became a script.** `scripts/check-comment-labels.mjs` reads the whole tree, not just this
  pass's diff, and is **advisory** (exit 0, not run by `verify`) because its near-miss list legitimately holds
  templates and historical names. Rejected: gating `verify` on it (unrunnable until every template is reworded);
  leaving it as the scratchpad one-off the comment-translation plan's §3 step 4b describes (`git show bb4eb2c:docs/COMMENT_I18N_PLAN.md`) — that one only ever sees
  the current diff, so a label an earlier pass retyped stays invisible forever.

## 2026-09-19 — 성능 측정 방식 · How performance is measured (perf Phase 0)

- **Headful Chrome on the real GPU**, not the smokes' headless one: a headless window does not present on a swap chain
  (the smokes drive `__game.frame` from a `setInterval` when its rAF stalls), so its frame cadence means nothing.
  *Rejected*: reusing the headless smoke setup (cheap, but the number being measured is the one it cannot produce);
  driving the user's own Chrome by hand (matches what they feel, but a before/after delta per phase needs the same
  conditions twice).
- **Sound off by `--mute-audio` only.** Chrome mutes the output stream while the page still builds every WebAudio node,
  so the audio findings stay measurable. *Rejected*: turning the in-game volume down — it takes those graphs out of the
  measurement.
- **Wrap `update` on the live page**, no DevTools trace: the per-system split is what the plan needs, and wrapping costs
  no source change and no trace parsing. A trace stays the tool for splitting one known spike frame (Phase 3).
- **The harness is committed** (`scripts/perf-measure.mjs`), because every later phase is judged by re-running it with
  the same options. It asserts nothing, so `verify` never picks it.
- **Scope: S1–S4 this session.** S5 (relay, two humans) was left out, which is why C1 · C3 · A6 stay unmeasured.

## 2026-09-20 — 그리는 양 줄이기 · Cutting what gets drawn (perf Phase 1 · 2)

- **Soldier / android shadows come from the torso, head and limbs only.** Every one of the 43 body meshes used to
  cast (65 on an android). Small plates, trim, the cape, armour plates and held items lose their own shadow, which
  fell inside the body's anyway; the boot keeps one because it is what meets the ground. *Rejected*: torso only (the
  cheapest, but the limbs' shadow is what makes a body read as walking); a distance LOD that keeps all 43 up close
  (correct, but it is a second system to maintain for a shadow nobody looks at).
- **The occlusion silhouette is the torso + head (3 meshes), not a clone of all 43.** It exists to say 「a body is
  behind that wall」. *Rejected*: turning it off past a distance (the silhouette matters **most** at a distance);
  merging the 43 into one geometry (~the same result, far more code, and it has to be rebuilt when a part moves).
- **Enemy animation LOD: half rate past 40 m, frozen past 80 m** (`ENEMY_ANIM_LOD_HALF_M` · `_FREEZE_M` in
  `data/constants.csv`). Only the joints stop — position, facing and every timer keep running — and a body that is
  dead, flashing from a hit, burning, shocked or flipped is animated at any distance, because those frames are the
  feedback a player reads through a scope. *Rejected*: 25 m / 50 m (more saving, but a mid-range firefight is exactly
  where legs stop moving); no LOD at all.
- **Bloom stays optional, and it already was** — `설정 › 화면 설정 › 화면 효과`, plus the perf guard's automatic
  off (`BLOOM_AUTO_OFF_TOAST`). The plan's fourth question turned out to be already answered in the code; nothing was
  built for it.
- **One owner for the HUD's screen size** (`ui/hud/viewport.ts`, measured on `resize`). *Rejected*: reading it once
  per frame at the top of `HudSystem.lateUpdate` and passing it down — still one forced layout inside the frame, and
  it leaves the trap open for the next widget.

## 2026-09-20 — GPU 프레임 줄이기 · Cutting the GPU frame (perf Phase A)

- **벌레 지오메트리: 전 타입 12~14 세그먼트.** One budget (`BUG_MESH_SEGMENTS` = 12 in `data/constants.csv`) clips
  every sphere a bug body is built from, so the per-part `seg` arguments keep reading as intent and the csv row
  decides. A thorax goes 18×13 → 12×8 (432 triangles → 168). *Rejected*: only the small types (scavenger · hunter) —
  it was the recommended option and the user went wider, because the merge hides the facets on a warrior too;
  leaving the geometry alone (then Phase A has nothing left but shadows, and shadows alone cannot reach the target).
- **휴머노이드 적에게 병사 규칙 적용.** Trunk · head · legs cast a shadow; the visor, the thrown grenade and the
  merged `gunArms` do not — the rifle is a held item, and the four arm segments merged into it are posed against the
  chest, inside the trunk's own shadow. *Rejected*: also shrinking the shadow map / cascade range — it softens every
  shadow in the raid, for a pass that turned out to cost 1.07 ms in total; leaving the shadow pass alone.
- **블룸 기본값은 켜진 채로 둔다.** The first impression (glow · neon) is the reason, and the perf guard already turns
  it off under load. *Rejected*: defaulting it off to get the 0.6 ms back — and the 0.6 ms did not survive
  re-measuring: with the frame on vsync, bloom measured **free** (6.83 ms with it off vs 6.75–6.77 with it on).
- **The phase's own 「below 6.0 ms」 target was dropped as arithmetically impossible, not missed.** Removing the
  *entire* shadow pass lands at 5.758 ms, so no body-side change can go under 6.0 with shadows on. What is left of the
  render block is the world's own triangles and pixels — a separate decision, taken up in the next section
  (Phase A2) rather than guessed at here.

## 2026-09-20 — 월드 렌더 비용 · Cutting the world's render cost (perf Phase A2)

Measured first: in S2 the world is 678k of the scene's 930k visible triangles, and its shadow casters are 158 meshes
/ 158k triangles — of which the **four boulder `InstancedMesh` are 92k (58 %)**, because a variant spans the map and
`frustumCulled = false`, so three.js never dropped one instance from the shadow pass.

- **먼 프롭은 그림자를 드리우지 않는다 (거리 LOD).** A casting variant is split into a near mesh (`castShadow`) and
  a far one around the eye, `PROP_SHADOW_DIST_M` = 120 m, re-split every `PROP_SHADOW_REPACK_M` = 8 m of movement.
  Both halves together draw every prop exactly once, so the colour pass is untouched; what is lost is a big
  boulder's long shadow past that distance on a low-sun planet. *Rejected*: lowering boulder geometry (cheaper and
  simpler, but boulders are cover — the user kept their silhouette); shrinking the shadow map or its cascade
  (softens every shadow in the raid); spatial buckets with real bounds so three.js culls them itself (correct, but
  it turns ~20 prop meshes into hundreds).
- **작은 물체는 그림자를 드리우지 않는다.** Crates, structure containers, rail containers and debris props —
  138 casters for 12k triangles. They still **receive** shadow, which is what sits them on the ground. The user
  accepted the loss knowingly: a crate's own shadow is a cue for reading cover, and it read as a smudge underneath.
- **자갈만 낮춘다** (`PROP_PEBBLE_DETAIL` 0: 80 → 20 triangles each). Pebbles are 0.15–0.55 m ground decoration that
  never cast, and they were **137k triangles — 15 % of the whole scene**, second only to the terrain.
  *Rejected*: boulders as well (the user kept them — cover silhouette, and their colliders are convex hulls of the
  drawn mesh); the terrain's 346k (the single biggest owner, but collision, `getSurfaceY` and the silhouette all
  hang off it — not a small change).
- **`SUN_SHADOW_HALF_M` moved into csv** so `core/Atmosphere` and `world/Props` read one number instead of the
  shadow box being a literal in core and an assumption in world.
- **Both halves are sized to the real instance count and `DynamicDrawUsage`.** The scatter allocates for the worst
  case (700 slots for ~76 boulders) and `needsUpdate` uploads the **whole** attribute, so a repack was re-uploading
  ~180 KB of mostly-unused static buffer. This was chased as the cause of an apparent regression and is **not**
  one — see the next bullet — but it is kept because a buffer that gets rewritten should not be `StaticDrawUsage`
  and should not be nine times larger than its contents.
- **`x:rendererRender` is no longer trusted as a verdict, and two agreeing runs are not evidence.** The same
  committed Phase A build measured **6.842 ms and 5.112 ms** back to back (js/frame p50 9.6 vs 7.6) — a 1.7 ms
  spread on identical code, larger than any difference this plan has attributed to a change. So Phase A's
  「0.6 ms gained」 and Phase A2's 「0.6 ms lost」 are both **inside the noise**, and neither was real. Phase A2 is
  judged on what repeats instead: triangles 930k → 730k (−22 %), prop shadow casters 754 → 51 instances, and the
  instance totals per prop kind identical before and after (509 boulders · 1 712 pebbles · …), which is the proof
  that the colour pass is untouched. *Rejected*: tuning the harness until the ms looks stable (the machine, not the
  harness, is what moves); calling A2 a regression and reverting it (the deterministic counters all improved).

## 2026-09-20 — 프레임 안의 강제 레이아웃 · Forced layout inside a frame (perf Phase B)

- **범위: 재현된 것 + 지연 생성 예방 + S2 스파이크까지** (user chose the widest of three). The measurement came first
  and it moved the scope by itself: of the four one-offs the plan listed, only the android first-contact frame
  reproduced (9.10 · 9.30 ms in two runs), and **its owner was `ui`, not `allies`** — `hud/ChatLog` forcing a full UI
  layout once per chat line, from inside `AllySystem.update`. *Rejected*: fixing only what reproduced and striking the
  rest (the user asked for the lazy-build shape to be closed as well, and it was the right call — the chat's real
  cost turned out to be exactly that shape).
- **`hud/ChatLog`: CSS 로 바꿔 측정 자체를 없앤다** — not 「defer the read to the next frame」, not 「batch to one read per
  frame」. The closed height is `3.5 × font-size × line-height + 3 gaps`, so `base.css` computes it with `calc()`
  instead of measuring a live row; the scroller is `column-reverse` around one inner list, so its scroll origin **is**
  the bottom edge and it re-pins itself. Both reads are gone rather than cheaper, and two long-standing bugs go with
  them: the measurement was wrong on a **wrapped** row (closed box 3.5 × the doubled height), and a reader scrolled up
  no longer gets yanked to the bottom by an arriving line. *Rejected*: deferring `measure`/`stick` into the existing
  rAF (one forced layout survives); batching to one read per frame (same).
- **한 프레임 안에서 레이아웃을 읽지 않는다 — 주석이 아니라 스모크로** (user chose the guard over a note in
  `scripts/README.md`). `scripts/smoke-layout-reads.mjs` patches every layout-forcing accessor on its prototype and
  counts calls made **while `Engine.frame` is on the stack**, so a widget written next year is covered and a read from
  a pointer handler or a resize is not. The bar is 0 and a failure prints file + function. It paid for itself
  immediately: it failed on `hud/DamageOverlay` the first time it ran. *Rejected*: recording the gap in
  `scripts/README.md` and moving on (the rule had lived in comments alone and was broken for a year).
- **그 실패가 이끓 14곳 정리는 같은 날 철회했다.** The CSS animation restart
  `remove → void offsetWidth → add` was swept behind a `ui/dom.restartAnim` helper that rewound the running animation
  instead. It cannot work: an animation with no `fill` leaves `getAnimations()` when it finishes (so the *second*
  flash never plays), and the animation is often on a **descendant** of the element carrying the class
  (`.imp-hud.rdy-major .imp-ring`), where the root's list is empty from the start. No read-free replacement exists
  either — a same-task remove/add coalesces even with one `requestAnimationFrame`, and a **style** flush is not
  cheaper than a **layout** flush on this HUD (1.5–2.1 ms vs 0.9–1.9 ms per flush inside a dirtied raid frame).
  The idiom stays, listed as a 13-file **ratchet** in the smoke (`KNOWN_IDIOM`, may shrink only), and the real choice
  — twin `@keyframes` per animation so two classes can alternate, versus accepting ~1–2 ms on a flash frame — is
  what was TODO B-68 · B-69, **answered later the same day: accept it** (the last bullet of this section).
  *Rejected*: `{subtree: true}` (it would rewind unrelated animations on the
  same subtree); shipping the helper at the sites where it happens to work (one idiom with two behaviours is a trap
  for the next reader).
- **`ms` 는 여전히 근거가 아니다 — 세는 것으로 판정한다.** What actually cracked this phase was a counter, not a timer:
  7 forced layouts in a 637-frame window, all in one file, all on one frame. The same method refuted the standing
  NEW-2 hypothesis in passing (per-body text writes: **14 in 836 frames**; rendered boxes 1 085 → 1 116 when 60 bugs
  arrive). *Rejected*: chasing S2's `l:hud` spike frames as a HUD problem — on those frames the render block and the
  layout are both ~3× at once, which is a whole-frame stall; garbage (B6) is the honest next suspect and S2 allocates
  the most of any scenario.
- **What is knowingly left**: `#ui-root` lays out 1 085 boxes during a raid, including a ship-only screen
  (`hud/ShipManage`, `visibility: hidden`) and four faded-out `.menu` screens. Taking them out of layout is a real cut
  of a deterministic counter, but no frame-time effect can be demonstrated at this machine's noise floor, so it is
  recorded rather than built.
- **애니메이션 재시작 관용구는 받아들이고 닫는다 (B-68 · B-69, asked after the plan's closing audit).** The
  `remove → void offsetWidth → add` idiom stays at all 19 sites in the 13 `src/ui/hud` files, as an **intended limit**
  (`src/ui/README.md` Rules) instead of a to-do; the ten sites in other folders' menus (`housing/ui` · `hub/ui` ·
  `inventory/ui/CatalogView`) are left alone too — they run outside `Engine.frame`, where §4.2 does not apply. The
  evidence was already in Phase B: S4 re-measured twice with `hud/DamageOverlay` forcing a layout on every bite gave
  the same numbers as the build without it. The smoke's `KNOWN_IDIOM` ratchet (13 files, `offsetWidth` only) stays, so
  the idiom cannot spread. *Rejected*: twin `@keyframes` on the combat hot path only (`Reticle` · `DamageOverlay` ·
  `WeaponPanel` · `Vitals`, ratchet 13 → 9); twin `@keyframes` at all 19 sites with the ratchet emptied (the same
  blast radius as the sweep retracted that morning, for an effect this machine cannot show); for B-69, a two-class
  helper in `src/shared` used by the three folders, or keeping the row open.

## 2026-09-20 — 지속 CPU 비용 · The sustained CPU costs (perf Phase C)

- **범위: 측정 → B4 · B3 · B5** (user chose it over 「B4 만」, 「C 전부 + DOM 평탄화」 and 「측정만」). *Rejected*: the DOM
  flattening (`hud/ShipManage` + four faded `.menu` screens out of layout) — it is a real cut of a counter with no
  demonstrable frame effect on this machine, so it stays recorded rather than built.
- **B4 적 AI: 애니 LOD 와 같은 모양의 거리 LOD** (user chose it over time slicing, over both together, and over leaving
  it alone). Beyond `ENEMY_AI_LOD_HALF_M` (70 m) a body ticks every other frame, beyond `ENEMY_AI_LOD_QUARTER_M`
  (140 m) every fourth. Three things were decided with it, and the design only holds with all three:
  - the distance is to the nearest **anchor** — camera, players, androids, drones, rover — **not** to the camera
    alone, because a host simulates bugs fighting a squadmate 200 m from its own screen;
  - the near band is wider than the longest reach of anything the LOD applies to — `ARTILLERY_AI maxRange` 98 m,
    **not** the `ARTILLERY_RANGE` 63 that first looked like the answer: 63 m is where an artillery bug *stands*, and
    it fights while approaching and relocating out to 88 m. `smoke-phase4` found that (110 m, not the 70 m first
    written). A named sniper reaches 320 m and is excluded from the LOD outright;
  - the skipped frames' `dt` is carried in `Enemy.aiDebt`, so speed, cadence and every timer are unchanged and the
    only thing lost is one tick of reaction;
  - and a tick may never grow past `ENEMY_AI_LOD_MAX_STEP_S` (0.08 s). Carrying the `dt` keeps timers right but not
    what happens **once per tick** — one shot, one steering decision, one gravity step — so the ceiling makes the
    LOD fade out exactly when frames lengthen, and it is set under a rogue's 0.12 s `shotGap`.
  *Rejected*: time slicing (a per-frame body budget caps the cost as the crowd grows, but it reduces **near** bodies
  too and makes 「why did that one react late」 untraceable); both together (two overlapping rules, same problem);
  freezing the far band outright (a frozen body never notices anyone walking up to it).
- **B3 광원 예산: 매 프레임 정확한 채로, 순회만 싸게** — *rejected*: the plan's own suggestion of a dirty flag from the
  light-pool owners, and of a csv recount interval. Point lights really do enter and leave the scene mid-raid
  (`extraction/Ship`, `player/Hellpod`, `game/parts/Leader`), and a single frame with the count wrong costs **two**
  recompiles of every lit material — exactly what `LightBudget` exists to prevent. The honest cheap-and-exact version
  would be a registry every light is created through (11 call sites, seven folders, plus a check script), which is
  not worth 0.14 ms. So the walk itself became an explicit stack instead of `traverseVisible`.
- **B6 쓰레기: 소유자별 계측만** (user chose it over 「계측 + 상위 소유자 수정」 and over skipping it). It took three
  counters, and the lesson is that **the first two both lie in the same direction**: the V8 sampling heap profiler
  keeps only the samples whose object is still alive, so it sees 0.085 MB/s of the raid's 63 MB/s; a construct trap on
  the typed-array and `AudioContext.createBuffer` paths sees ~0, so it is not off-heap either. What sees churn is
  `performance.memory` read **around each wrapped mark**. The answer: nothing owns it — `x:rendererRender` 15 MB/s
  (three.js's own render path, not ours), `u:world` 7.9, `u:enemies` 6.5, `l:hud` 4.2, `x:audioPlay` 2.8, everything
  else under 1. No fix follows from that, which is why the measurement was the whole scope.

## 2026-09-20 — 멀티플레이 측정 · Measuring the squad (perf Phase D)

- **두 클라이언트를 한 대에서: 호스트만 headful, 피어는 headless d3d11** (user chose it over both headful side by
  side, and over a swiftshader peer). The host keeps exactly the conditions S1–S4 ran under, so its rows stay
  comparable with them; the peer renders on the same GPU, which contaminates the **render block on both sides** and
  is why only counters are quoted as results. *Rejected*: both headful (two windows sharing one vsync — the frame
  cadence itself stops being comparable with every earlier scenario); a swiftshader peer (no GPU contention, but a
  peer running at a few fps sends far fewer snapshots, so the host's replica cost would be **under**-measured — the
  one error that cannot be spotted afterwards).
- **범위: 측정 먼저, 카운터가 정당화하는 것만 수정** (user chose it over 「측정만 하고 다음 세션」 and over 「세 건
  모두 선제적으로 구현」). The third option is the shape this plan was wrong in twice (B1 「draw calls are the frame」,
  NEW-2 「per-body writes dirty the layout」), so it was declined on the file's own evidence.
- **시나리오: S5a 2인 대기 + S5b 2인 + 벌레 60** (user chose it over S5b alone). S5a mirrors S1 and S5b mirrors S2, so
  「what does one remote body and its wire add」 is a subtraction, not an estimate — and S5b's `ring60` frame **is**
  the `ee spawn` burst A6 asks about, arriving at a replica.
- **하네스: `perf-measure.mjs` 에 `--only s5`** (user chose it over a separate `perf-measure-mp.mjs`). One probe, one
  report format, one table — the Replica column is a column, not a second file to reconcile by hand.
- **C3 는 S5c 를 추가해 측정으로 닫는다** (asked after S5a · S5b came back: the two scenarios hold no androids, so
  `ally state` never reached the wire). *Rejected*: closing it by arithmetic from the contract (`AllyWire` field set ×
  `ALLY_NET_INTERVAL_S`) — a calculation is what this file keeps having to retract; and leaving C3 open, which would
  keep the plan alive for one unanswered row.
- **Phase D 뒤 `docs/PERF_PLAN.md` 는 삭제하지 않고 남긴다** — **뒤집혔다, 같은 날, 마지막 측정 뒤**
  (the last section of this file: the file is deleted and its four surviving facts live there). The file's own rule
  was 「delete it once every phase is done」; the user chose to keep it and then, once the pixel A/B closed the last
  open row, to delete it after all. It stopped being a plan and is now the **measurement record**: the machine's `ms`
  noise floor, the A/B that refuted 「draw calls are the frame」, the three times the named suspect was not the owner,
  and the method that found the real one. `CLAUDE.md` §1 · §4.5 point at it for that. Its 「how to work this plan」
  section was rewritten to say so — new work still goes to `docs/TODO.md`, and only a **measurement** may be added
  here. *Rejected*: deleting it and moving the surviving facts into `CLAUDE.md` §4.5 (the detail is the value, and
  §4.5 is a rules list, not a record); renaming it `PERF_NOTES.md` (every inbound link would move for a title).
- **애니메이션 LOD 거리를 줌 배율로 보정한다** (2026-09-20, asked while closing the perf audit's F2). The two
  distances were chosen as 「the legs are ~10 cm on screen」, which is only true at the base FOV — a scope narrows
  `camera.fov`, so through an 8× scope a body at 100 m is drawn the size it has at ~12 m and slid along with frozen
  legs. One `tan` per frame (`shared/viewZoom.viewZoomK`), clamped to ≤ 1. The **AI** LOD is deliberately not scaled:
  it measures what a body can act on, and a scope changes none of that. *Rejected*: leaving it and writing it up as an
  intended limit in `src/enemies/README.md` (the cost is a multiply per body, and the scope is exactly where a player
  looks at a distant body).
- **기준 FOV 는 `data/constants.csv` 행으로** (same question). `CAMERA_BASE_FOV_DEG` = 70, read by `player/CameraRig.baseFov`
  and by `shared/viewZoom`, which `enemies` uses twice. *Rejected*: a `src/shared` constant alone (§4.1 is 「no numbers in
  code」, and this number decides what every screen-size judgement means).
- **튜토리얼 레이아웃 읽기는 고치고 스모크 창도 늘린다** (same session, the audit's F3). `hud/Notifications` measured
  `.tut-controls` every frame; it measures from a `ResizeObserver` + window `resize` now, and `smoke-layout-reads` gained
  a fourth window that runs the tutorial. *Rejected*: fixing the code only — a rule that is 「counted, not commented」 has
  to count the screen it was being broken on (the old code fails the new window: 180 reads in 180 frames).

## 2026-09-20 — 픽셀 측정, 그리고 계획서 폐기 · The pixel A/B, and retiring the plan (perf — the last measurement)

- **마지막으로 남아 있던 빈칸을 측정으로 닫았다: 해상도 스케일은 이 기계에서 아무것도 움직이지 않는다.** S2, same
  machine state, back to back, two runs per side, `--display scale=1` against `--display scale=0.75` (1280×720 →
  960×540, **−44 % of the pixels**, bloom and shadows on in both):

  | Run | `pixelRatio` | `x:rendererRender` | js/frame p50 | frame ms p50 / p95 | frames > 33 ms | Draw calls | Triangles |
  |---|---|---|---|---|---|---|---|
  | `px-s100-a` | 1.00 | 6.531 | 9.4 | 16.7 / 16.8 | 5 | 1 284 | 726k |
  | `px-s100-b` | 1.00 | 6.777 | 9.3 | 16.7 / 16.8 | 5 | 1 313 | 732k |
  | `px-s075-a` | **0.75** | 6.812 | 9.6 | 16.7 / 16.8 | 7 | 1 310 | 733k |
  | `px-s075-b` | **0.75** | 6.729 | 9.3 | 16.7 / 16.8 | 17 | 1 299 | 728k |

  The pixel-cut side is **0.12 ms higher**, and one side's own two runs differ by 0.25 ms — the cut is invisible
  under the noise floor this whole plan has been fighting. Both sides sit on the 60 Hz vsync at p50 16.7 ms, which is
  the honest reason: **S2 at 1280×720 is not fill-limited on an RTX 4080 SUPER**, so there is nothing for a pixel cut
  to give back. The setting itself already exists for hardware where it would (`설정 › 화면 설정`), so **nothing was
  built for this** — it is a measurement that closes a question.
- **그래서 렌더 블록을 움직이는 것은 삼각형이지 픽셀이 아니다.** The plan's ranking after the draw-call A/B was
  「pixels and triangles」; only the triangle half ever reproduced (the shadow pass, 1.07 ms — triangles and a second
  camera), while both pixel probes came back free: bloom measured free in Phase A's re-split (~15 composer passes,
  entered per frame), and now a 44 % cut of every one of those pixels measures free too. `CLAUDE.md` §4.5 says
  **triangles move it; draw calls and pixels do not**.
- **스파이크 프레임에는 주인이 없다 — A2 의 고아도 그 중 하나였다.** Across these four runs, 14 spike frames: **13 are
  led by `x:rendererRender`** (9.5 – 64.1 ms in a single call) and **one by `u:enemies`** — 19.9 ms with no spawn mark
  on the frame, the same shape as the 18.8 ms that finding **A2** had been left open for since Phase B. A cost that
  lands on `x:rendererRender` twelve times, on `u:enemies` once, and never reproduces in the same place is not a fact
  about the enemy system; it is whatever mark happens to be running when the machine stalls (GC at 63 MB/s with no
  owner — B6 — or the driver). **A2 is closed as 「not an owner」**, not as fixed. *Rejected*: opening a phase to
  instrument `u:enemies` for it (one frame in ~5 400, and the census says the mark is innocent).
- **`docs/PERF_PLAN.md` 는 삭제한다**, reversing this same day's 「남긴다」 decision now that the last open measurement
  is taken. Every phase is built or struck, every decision has a section in this file, the harness documents its own
  method in `scripts/README.md`, and the surviving facts are the four bullets below. What the file held beyond them
  was the narration of how they were found, which is `git log`'s job. The ~58 inbound references (`CLAUDE.md` §1 ·
  §4.5, `scripts/README.md`, `scripts/verify.mjs`, `scripts/smoke-layout-reads.mjs`, `perf-measure.mjs` and ~20 code
  comments across `core` · `enemies` · `player` · `ui` · `world` · `shared`) were rewired to this file, keeping the
  phase name as the label (「성능 Phase A」). *Rejected*: keeping it as a measurement record (the record is four
  bullets; an 851-line file that may only be appended to is a second place for the same facts to drift in);
  shrinking it in place (the same drift, with a filename that still says 「plan」 over something that is not one).

**측정 기록 — 이 기계가 남긴 네 가지 (the record the plan is being deleted for):**

1. **`ms` 는 근거가 아니다.** The **same committed build** measured `x:rendererRender` **6.842 and 5.112 ms** back to
   back (js/frame p50 9.6 vs 7.6), and two runs of one build gave **5 and 22** frames over 33 ms. A ±1.7 ms spread is
   larger than every change this plan ever credited. **Judge by counters that repeat**: draw calls, scene nodes,
   triangles, caster counts, bytes, call counts. A mark average over ~1 300 frames repeats; a p50 or a spike count
   does not. Always take a fresh `before` (the logs are git-ignored), and **run it twice per side**.
2. **세지 말고 재지 마라 — 세어라 (「count it, don't time it」).** Three phases running, the named suspect was not the
   owner, and a **counter** found the real one each time: Phase B patched the layout-forcing accessors and counted
   calls inside `Engine.frame` (7 in 637 frames, all in one file — `hud/ChatLog`, not `allies`); Phase C bounded its
   own fix with a census before building it (60 bodies inside the full-rate band, 100 beyond 140 m); Phase D struck
   all three multiplayer suspects with byte counts and a build counter, never needing a `ms` at all. **Never write a
   fix against a mark name.**
3. **렌더 블록은 드로우 콜도 픽셀도 아니다.** The 2026-09-20 A/B (two runs per side, `git stash` between them) removed
   **31 % of the draw calls and 36 % of the scene nodes** — 1 890 → 1 300 calls, 5 940 → 3 800 nodes — and
   `x:rendererRender` did not move (7.34 → 7.23, inside the spread). The 「≈ 4 µs per draw call」 of Phase 0 was a
   correlation with scene size, not a cost per call. Pixels went the same way (the bullet above). What did reproduce:
   the **shadow pass ≈ 1.07 ms** (−188 draws, −213k triangles). The cut is kept anyway — it is worth much more on a
   weaker CPU — but it is not what the user feels.
4. **유저가 느끼는 것에 대한 답 (symptom (a), measured):** a two-human raid through the relay, with and without two
   androids, runs at **16.7 / 16.8 ms with zero frames over 33 ms on both clients** (S5a · S5c, two runs each). A
   squadmate costs **one more body drawn** — 73 visible + 32 shadow draws, the same as the local soldier — plus
   23–29 KB/s of wire that costs a replica 0.08 ms a frame **outside** the frame. It is not the network and not the
   squadmate's simulation.

**이 기계가 답할 수 없어 열려 있는 것 (not work — they need different hardware):** the flat DOM cut
(`hud/ShipManage`'s 116 `visibility: hidden` boxes + four faded `.menu` screens, ~120 of `#ui-root`'s 1 085 laid-out
boxes — a real cut of a deterministic counter with no demonstrable frame effect here) and the AI LOD's untouched
near band both need a **weaker** machine to show anything; a replica's own frame time needs a **second** machine
(S5 ran both clients on one GPU); and **terrain's 346k visible triangles**, 37 % of the scene, stay untouched because
collision, `getSurfaceY` and the silhouette all hang off that one mesh.

## 2026-09-21 — 재장전 유지 · 아군 회복 · 탐사 차량 전투 · 행성 귀속 열쇠 · 함선 외형 통일 · Reload hold · ally healing · a fightable rover · planet-bound keys · one ship

Nine requests settled in one interview. What was chosen, and what was not:

**재장전 (reload).** An **instant** action pauses the reload and it resumes where it stopped (the roll, the grapple);
a **wielded** implant cancels it (barrier, overcharge). Rejected: pausing for every "cannot shoot" state (the ladder,
the rover seat), and keeping progress across a cancel to be re-triggered with R. The investigation found the premise
wrong — only swap · consumable-in-hand · melee · loadout change · holster cancelled a reload before this, and the
roll, the grapple, drone control and the rover seat never touched it. So drone control and the rover seat were left
exactly as they were: they neither pause nor cancel.

**아군 회복 (healing an ally).** The consumable is used with the item **in hand**: left click on yourself, right click
on the ally under the crosshair — the defibrillator's aiming rule, because it is the one the player already knows.
Rejected: a 「use on an ally」 row in the inventory menu (unusable mid-fight) and auto-picking the nearest ally with no
aiming (mis-targets). The start range is short and the **hold** range longer, so a target who takes a step does not
cost the item. Using one on somebody else carries **no move-speed penalty** — the penalty is there to make healing
yourself a commitment, and holding someone else up is already a commitment. Targets are human squadmates **and**
androids. A downed body is nobody's heal target (the defibrillator's job) — and the defibrillator now reaches a
**carried** one, which is what makes 「carry them out and revive them」 a play.

**탐사 차량 (the rover).** It can now be fought. Damage resolves against a hit zone (4 wheels · a front turret · a
rear turret · the hull) and part damage **also** comes off the hull, so shooting parts still kills the car — rejected:
parts on a pool of their own (disabling and destroying become unrelated strategies) and parts *instead of* hull hp.
Hostility needs a **threshold** of cumulative player damage, not the first bullet (one stray shot must not cost the
squad its transport), and once crossed it lasts **the rest of the raid** — rejected: a timeout that lets you wait it
out. A hostile car keeps running its route and only its turrets engage; it does not chase, so leaving the road is
the counterplay. The two turrets are a common SMG (front) and a common AR (rear), and against player-side bodies
their accuracy is halved. Destroyed, it pays **exactly what an outpost basement pays** — the same tier table *and*
the locked room's epic+ exemption — because the user's framing was 「a rover raid = entering the basement」.

**열쇠 (keys).** A key is **planet-bound**: one pair of items per planet, and which planet's key drops is independent
of where you are. That is the whole point — a key found on Acheron II for Carmine I is an invitation to go to Carmine I.
Chosen over tagging one item instance with a planet (fewer csv rows, but every stack merge, save and shop path would
have to learn about the tag). To stop the key being skipped, both locked rooms got an **indestructible** ceiling
turret that only the matching key switches off — rejected: a destructible one (ammo and a minute become the price of
the key) and a respawning one.

**바닥 아이템 (dropped items).** Overlap is solved by looking for a free spot **at spawn**, never by items pushing each
other apart every frame — a hot-path cost for a cosmetic problem was not worth it.

**조명 (lighting).** Two questions the user asked as questions, both answered yes and why: lighting more rooms in ship
management is **free** because the pool's light count never changes (only which fixtures own the slots), and raid
interiors are brightened **on the local client only** by lifting hemisphere/ambient and thinning fog — never by adding
a light, because the raid budget has zero spare and one more point light recompiles every material. The lift multiplies
*on top of* a hazard's `atmo:override`, so a roof softens a storm instead of cancelling it.

**함선 (the ship).** The airlock became its own room with automatic doors, and the hangar, the docking cutscene and the
raid drop-ship now build from **one** model, so the ship parked in the shared hangar is the ship that lands. The
purchase hook is plumbed through (profile → lobby → the extraction wire) with **no shop and one model in the registry**
— a second hull is content, not plumbing. Ship interiors were deliberately *not* drawn to scale on the exterior: only
the airlock end is modelled, because a real interior would make the exterior enormous.

## 2026-09-21 — 죽은 import 일소 · 폭발의 파괴 범위 · 터렛 와이어 · 함선 권한 · Dead imports · what a blast breaks · the turret wire · who owns a ship

The TODO rows B-90 … B-101 in one pass. B-90 … B-96 were documentation defects and carry no decision; the five below do.

**죽은 import (B-97).** 2,373 declarations nothing read, all from the same cause: splitting a system into `model.ts` +
`parts/*` copied the whole import block into every part. Chosen: clear them **and turn `noUnusedLocals` on** in all three
tsconfigs, with **no exemption for an intended contract stub** — a stub kept 「for later」 is deleted, not parked
(`GameFlowSystem.onRespawnRequest` and `InventorySystem.hasAnyWeapon` went that way). Rejected: clearing without the flag
(the same 2,300 lines grow back at the next split), and a separate `verify` smoke instead of the compiler (a build error
the moment it happens beats a check at the end of a session).

**폭발이 무엇을 부수는가 (B-98).** Only the bazooka ever walked `Obstacle.destructible`, so the 탐사 차량 — shootable since
earlier the same day through exactly that hook — took bullets and ignored grenades. Chosen: **one shared loop**
(`shared/explosion.blastDestructibles`) that grenade · bazooka · mine · ship call · fire zone all hand their blast to, so
dropped cover, window glass and the vehicle answer the same explosion the same way. Rejected: teaching each blast path
about the vehicle specifically (「what an explosion breaks」 splits in five again), and limiting it to instantaneous blasts
(a car parked in a fire zone should cook). Damage that arrives this way **resolves a hit zone and counts toward hostility**
like a bullet does — the blast centre is pulled onto the hull box first, so a grenade under a wheel takes that wheel;
rejected: hull-only damage, which would have made 「blow the wheels off」 impossible. The path stays **player-side only**,
because the hostility counter is the player’s to move and enemies keep their own `Targets.damageVehicleAt`.

**피격 보고 (B-99).** A non-host client sent one message per bullet — 14 a second with an SMG. Chosen: sum a frame **per hit
zone** and send one message per zone, so 「this burst chewed the front-left wheel」 survives; rejected: one summed message a
frame (two zones hit in one frame collapse into one) and a fixed 0.1 s window (fewer messages, a late reaction).

**천장형 터렛 (B-100).** Switching it off already travelled as `struct unlocked`, but each client picked its **own** target
from 20 Hz positions — so a replica could warn a squadmate while the host was warming up on you. Chosen: the authority
sends the body and the state (`struct turret {id, tg, st}`, on a change only, plus one catch-up for a late joiner), and a
replica turns, paints and fires the look from that. Rejected: sending only the state change (the direction still drifts)
and leaving it alone as a documented limit. The **shot cadence** is deliberately not sent — a tracer a fraction of an
interval out of step costs nothing and no damage rides on it.

**함선 모델 (B-101).** `lobby:look.shipModel` was echoed as the client sent it — harmless while no ship can be bought, a free
ship the day one can. Chosen: do it **now**, before the shop exists — the relay fills `LobbyPlayer.shipModel` from that
member’s own `progression` document (`Store.shipModel`) beside `code` · `level`, and the client’s field survives only as the
nudge that asks for the re-read. Rejected: a profile-first / client-fallback blend (the fallback is the hole) and leaving a
comment for later. The nudge has to be **de-duplicated on the sender**, not against its own lobby row: that row is now the
relay's answer and stays empty for a profile that has uploaded no document, so comparing against it nudged on every
`lobby:state` and every nudge broadcast another one (caught by `verify:all` — five two-client smokes timed out in the flood).
