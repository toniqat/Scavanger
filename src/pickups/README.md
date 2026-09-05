# src/pickups — World item pickups (`ctx.pickups`)

Owner: `PickupSystem` (`name: 'pickups'`), registered right after `InventorySystem`. Dropped items lie on the ground, pulse, show a locator beam, and are taken with **E**. Multiplayer is host-authoritative.

| File | Purpose |
|---|---|
| `PickupSystem.ts` | `PickupsRef` impl (`getPickups`, `findNear(pos, r)`, `spawn(item, pos, vel?)`, `clear`). Listens `inventory:itemDropped` → toss arc (`GRAVITY`, `world.resolveCollision`, lands on `world.getHeightAt` + per-category rest height, small bounce, then rests). Registers one `Interactable` per pickup (`pickup:<id>`, radius 2.2 m, instant, prompt `"<이름> ×n 줍기"` / `"<이름> 줍기"`, only while resting and `isGameplayActive()`). Take → `ctx.inventory.tryAddItem(item)`; false keeps the pickup (inventory already emitted `inventory:full`). Pool cap `PICKUP_MAX` (oldest evicted), `PICKUP_LIFETIME` (> 0 → expires on every client). Cleared on `game:newMission`, `game:abort`, `hub:entered`, `world:ready`. Emits `pickup:spawned / pickup:taken / pickup:removed`. |
| `PickupVisuals.ts` | `PickupVisualPool`: pooled per-category procedural bodies (primary = rifle silhouette, secondary = pistol, ammo = box + stripe, stim = capsule, grenade = sphere + band, valuable = octahedron on a base, material = crate), tinted from `ItemDef.color` (rarity colour) with an emissive pulse, plus an additive vertical beam (5.5 m) and ground ring. Layer `NO_RAYCAST`. **No lights** (constant scene light count → no shader recompiles). `warm()` pre-creates one visual per category at init. |
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
```

Host-side validation is existence only (an unknown/already-taken id is silently dropped; the requester's 1 s cooldown expires and the prompt returns). Item instances received over the wire are re-created with `ctx.loot.createItem(defId, qty)` (fresh uid).

## Verification
Headless Chrome (puppeteer-core, ANGLE D3D11), single-player mission, 18/18 checks: `inventory:itemDropped` with `ctx.loot.createItem('ammo_rifle', 2)` from chest height → pickup `sp-1` spawns, lands with `y − terrainHeight = 0.09`, interactable `pickup:sp-1` registered with prompt `소총 탄약 팩 ×2 줍기`, `findNear(player, 6)` → `sp-1` (null 50 m away), `interact()` adds the item to the bag (3 → 4 items), removes the pickup + interactable, emits `pickup:spawned → pickup:removed → pickup:taken {byLocal:true}`; `spawn()` ×5 categories (stim/grenade/gem/material/pistol) all land and rest; `game:abort` clears everything. Also verified: weapon model hidden + `hasWeapon:false` in phase `hub`, re-armed on return to `playing`. 0 console errors. The multiplayer `item`/`itemq` paths are implemented per the protocol above but were not exercised with two clients (the inventory drop UI was not landed yet at test time).

Audio: emits `audio:play {id:'pickup'}` on a local take — the audio module needs a matching synth (currently logs an "unknown sound id" warning).
