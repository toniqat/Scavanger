# src/pickups — World item pickups (`ctx.pickups`)

Owner: `PickupSystem` (`name: 'pickups'`), registered right after `InventorySystem`. Dropped items lie on the ground, pulse, show a locator beam, and are taken with **E**. Multiplayer is host-authoritative.

| File | Purpose |
|---|---|
| `PickupSystem.ts` | `PickupsRef` impl (`getPickups`, `findNear(pos, r)`, `spawn(item, pos, vel?)`, `clear`). Listens `inventory:itemDropped` → toss arc (`GRAVITY`, `world.resolveCollision`, lands on `world.getHeightAt` + per-category rest height, small bounce, then rests). Registers one `Interactable` per pickup (`pickup:<id>`, radius 2.2 m, instant, prompt `"<이름> ×n 줍기"` / `"<이름> 줍기"`, only while resting and `isGameplayActive()`). Take → `ctx.inventory.tryAddItem(item)`; false keeps the pickup (inventory already emitted `inventory:full`). Pool cap `PICKUP_MAX` (oldest evicted), `PICKUP_LIFETIME` (> 0 → expires on every client). Cleared on `game:newMission`, `game:abort`, `hub:entered`, `world:ready`. Emits `pickup:spawned / pickup:taken / pickup:removed`. **2026-09-11**: 착지 · 정지 스폰 높이가 `getSurfaceY`(건물 2층 · 옥상 · 계단 위)다 — 예전에는 지형만 봐서 2층 바닥판을 뚫고 떨어졌다. |
| `PickupVisuals.ts` | `PickupVisualPool`: pooled per-category procedural bodies (primary = rifle silhouette, secondary = pistol, ammo = box + stripe, stim = capsule, grenade = sphere + band, valuable = octahedron on a base, material = crate, **book = flat cover slab + lighter page block + raised spine, turned 0.35 rad** — Phase 9 서적), tinted from `ItemDef.color` (rarity colour) with an emissive pulse, plus an additive vertical **light pillar** and ground ring. Layer `NO_RAYCAST`. **No lights** (constant scene light count → no shader recompiles). `warm()` pre-creates one visual per category at init. **Phase 10**: the pillar is `PICKUP_PILLAR_HEIGHT` tall (was a 5.5 m column) and **fades to transparent upward** — `bakeUpwardFade()` writes a white→black vertex-colour ramp into the shared open-ended `CylinderGeometry` once at construction and the material is `MeshBasicMaterial({ vertexColors: true, blending: AdditiveBlending, … })`, where black **is** transparent, so no custom shader is needed and the per-visual tint still multiplies through. `animate()` breathes the opacity around `PICKUP_PILLAR_OPACITY`; `BEAM_HEIGHT` is still exported (now `= PICKUP_PILLAR_HEIGHT`). The only sphere here is the **grenade body** silhouette — the light-blue fresnel sphere is `ui/hud/Detection.ts` / `ui/hud/ScanReveal.ts`, not this folder. **2026-09-11 — 기둥을 껐다** (`animate` 가 `beam.visible = false`, 사용자 결정 "빛기둥은 시체에만"). 메시 · 머티리얼은 풀에 그대로라 되돌리기 쉽다. 바닥 고리 · 몸체 발광은 남는다. **2026-09-11 온실 개편 — `REST_Y` 에 `crop` 0.07 · `soil` 0.14** (`Record<ItemCategory, number>` 라 새 카테고리가 생기면 여기가 먼저 빨개진다). 둘 다 전용 실루엣 없이 `crate`(default 가지)를 타고 색은 `ItemDef.color` = 등급색이다 — `CATEGORY_COLOR.crop/soil` 은 목록 · 탭용이라 여기서 읽지 않는다. **2026-09-11 주방 · 프린터 (A-3c · A-15) — `meal` 0.06 · `pouch` 0.12 · `key` 0.05 + 전용 실루엣 3종**: 요리 = 위가 넓은 얕은 그릇(body) + 가득 담긴 내용물(accent), 주머니 = 납작한 파우치 + 덮개 + 멜빵(가방보다 한 치수 작다, 0.28 rad 돌아 있다), 열쇠 = 자기 카드 한 장 + 자기 띠 + 칩(서적처럼 납작하게 눕고 0.35 rad 돌아 있다). 셋 다 `warm()` 의 선생성 목록에 올라간다 (`book` 이 만든 선례 — 자기 실루엣이 있는 카테고리만). |
| `index.ts` | Barrel. |

## Events other modules can rely on
- `pickup:spawned {id, item, position}` — `position` is the pickup's live `Vector3` (same instance as `PickupRef.position`; it moves while the item is in the air).
- `pickup:taken {id, item, byLocal, byName}` — `byLocal` true when the local player got the item into the bag; `byName` = lobby name of the remote taker (null for local).
- `pickup:removed {id}` — fires on **every** removal (taken, expired, evicted, cleared). UI markers should clear on this.
- `ctx.pickups.findNear(pos, radius)` — nearest pickup within `radius` (pings snap to it, `PingKind 'item'`).
- Audio: emits `audio:play {id: 'pickup'}` when the local player takes an item.

## Host-authoritative protocol (`src/shared/net.ts`: `ItemMessage` host → clients, `ItemRequest` client → host)

Ids are `${peerId | 'sp'}-${n}` from the peer that created the pickup; the host **keeps** client-proposed ids so the optimistic spawn and the echo dedupe.

```
Solo / host drop                       Client drop
────────────────                       ───────────
inventory:itemDropped                  inventory:itemDropped
  → spawn locally (id host-n)            → spawn locally, optimistic (id client-n)
  → item drop ─────────► others          → itemq drop ─────────► host
                                                   host: spawn(id kept) → item drop ──► others
                                                   client: id exists → optimistic=false (dedupe)
                                                   (no echo within 4 s → optimistic pickup removed)

Solo / host take (E)                   Client take (E)
────────────────────                   ───────────────
tryAddItem ok?                         itemq take {id} ──────► host
  no  → keep (inventory:full)                    host: exists? remove, pickup:taken{byName}
  yes → remove, pickup:taken{byLocal}                  → item take {id, by} ──► others
      → item take ─────────► others    client: remove; by === me → tryAddItem
                                                 full → re-drop in place (itemq drop path)
                                              by !== me → pickup:taken {byLocal:false, byName}

Sync
────
client world:ready (multiplayer, !host) → itemq sync ──► host → item sync {items} ──► that peer (rebuild all, resting)
host also answers `flow rejoined` from a peer with `item sync`.
host migration (Phase 9): net:hostChanged {isLocalHost:false} + ctx.world.ready → itemq sync ──► the *new* host
  (it answers from its own mirror, which may hold drops we never saw / lack ones it never received)
```

Host-side validation is existence only (an unknown/already-taken id is silently dropped; the requester's 1 s cooldown expires and the prompt returns). Item instances received over the wire are re-created with `ctx.loot.createItem(defId, qty)` (fresh uid).

## Verification
Headless Chrome (puppeteer-core, ANGLE D3D11), single-player mission, 18/18 checks: `inventory:itemDropped` with `ctx.loot.createItem('ammo_rifle', 2)` from chest height → pickup `sp-1` spawns, lands with `y − terrainHeight = 0.09`, interactable `pickup:sp-1` registered with prompt `소총 탄약 팩 ×2 줍기`, `findNear(player, 6)` → `sp-1` (null 50 m away), `interact()` adds the item to the bag (3 → 4 items), removes the pickup + interactable, emits `pickup:spawned → pickup:removed → pickup:taken {byLocal:true}`; `spawn()` ×5 categories (stim/grenade/gem/material/pistol) all land and rest; `game:abort` clears everything. Also verified: weapon model hidden + `hasWeapon:false` in phase `hub`, re-armed on return to `playing`. 0 console errors. The multiplayer `item`/`itemq` paths are implemented per the protocol above but were not exercised with two clients (the inventory drop UI was not landed yet at test time).

Audio: emits `audio:play {id:'pickup'}` on a local take — the audio module needs a matching synth (currently logs an "unknown sound id" warning).

## Phase 10 (2026-09-07): 루팅 표시 = 빛기둥
- `PickupVisuals.ts` only. The locator beam became a **light pillar**: `PICKUP_PILLAR_HEIGHT` (3.2 m) instead of
  5.5 m, radii 0.15 at the ground tapering to 0.045 at the top, and a **baked vertex-colour fade** (white at
  `y = 0` → black at `y = height`, exponent 1.35) on the shared geometry. Because the material is additive, black
  renders as transparent — the pillar dissolves into the sky with no shader of its own, and `material.color ×
  vertexColor` keeps the rarity tint.
- Pooling, the shared per-category geometry, the ground ring, `NO_RAYCAST` and the **no-lights** rule are unchanged;
  the fade is baked exactly once (in the constructor), so a pickup still allocates nothing after `warm()`.
- `BEAM_HEIGHT` stays exported for outside readers and now equals `PICKUP_PILLAR_HEIGHT`.
- `PickupSystem.ts` is untouched by this phase.

## Weapon package (2026-09-05)
- `PickupWire.ex` (`ItemInstanceExtras`: `durability` / `ammoInMag` / `sockets`) is filled by `wireOf()` for every drop / echo / sync and
  restored on the receiving side through `ctx.loot.createItem(defId, qty, ex)`, so a dropped weapon keeps its wear, loaded rounds and attachments
  across the network. Items without those fields send no `ex`.

---

## 변경 이력

- **2026-09-12 (아이템 회수 계약 — 표식이 바닥을 건넌다)** — `PickupSystem.wireOf` 가 `ItemInstance.raidFound` 를 `PickupWire.rf` 로 싣고
  `itemFromWire` 가 되살린다(생략 = 표식 없음 — 옛 피어 · 가져온 아이템). 싱글 플레이는 인스턴스가 그대로 오가므로 원래 보존됐다.
  분대원이 떨어뜨린 「이번 레이드에서 얻은」 계약 아이템을 주워도 그대로 센다.

- **2026-09-11 (A-3c · A-15 주방 · 프린터)** — `PickupVisuals` 에 새 카테고리 셋. `REST_Y` 에 **`meal` 0.06 ·
  `pouch` 0.12 · `key` 0.05** 을 더하고, 이번에는 **전용 실루엣도 함께** 만들었다 (작물 · 토양 · 표본 · 준비물은
  `crate` 공용 가지를 탔다): 그릇에 담긴 요리 · 덮개 달린 파우치 · 자기 카드. 지오메트리는 전부 코드에서 만든
  Box / Cylinder 이고 (외부 에셋 금지) 공용 풀에 들어가므로 픽업 하나가 새로 할당하는 것은 여전히 없다.
  **광원은 한 개도 더하지 않았다** — 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」 그대로다.
  `warm()` 목록에 셋을 올렸다. `PickupSystem.ts` 는 한 줄도 안 바뀌었다.

- **2026-09-11 (온실 개편)** — `PickupVisuals.REST_Y` 에 새 카테고리 **`crop` 0.07 · `soil` 0.14**. 작물은 약초처럼
  낮게 눕고 토양은 한 자루라 재료 상자와 같은 높이다. 실루엣은 `crate` 공용(default 가지)이라 새 지오메트리는
  없다 — `PickupSystem.ts` 는 한 줄도 안 바뀌었다. `warm()` 의 선생성 목록은 그대로다 (그 둘은 월드에 잘 안 떨어진다).

- **2026-09-11** — 떨어진 아이템의 빛기둥을 감췄다 (빛기둥은 시체에만). 착지 높이는 `getSurfaceY` (건물 바닥판 위).
프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 9** — `itemq sync` is re-requested on `net:hostChanged` (a takeover no longer loses the world's dropped items)

- **Phase 10** — the 5.5 m beam became a shorter `PICKUP_PILLAR_HEIGHT` pillar that **fades to transparent upward** via baked vertex colours on the shared geometry (additive blending makes black transparent, so no new shader); `BEAM_HEIGHT` is still exported. The only sphere here is the grenade-body silhouette — the light-blue lootable sphere was never in this folder
