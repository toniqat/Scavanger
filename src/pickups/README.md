# pickups/ — world-dropped items

`PickupSystem` (`name: 'pickups'`, registered right after `InventorySystem`) owns items lying on the ground and
publishes `ctx.pickups` (`PickupsRef`). Items are tossed on an arc, rest, and are taken with **E**. Multiplayer is
host-authoritative. This folder never edits the bag directly — taking goes through `ctx.inventory.tryAddItem`, and
local drops arrive via `inventory:itemDropped`.

## Files

| File | Responsibility |
|---|---|
| `PickupSystem.ts` | `PickupsRef` impl, toss physics, one `Interactable` per pickup, host-authoritative `item` / `itemq` protocol, wire (de)serialisation (`wireOf` / `itemFromWire`) |
| `PickupVisuals.ts` | `PickupVisualPool`: pooled procedural bodies per visual kind, tinted from `ItemDef.color`, emissive pulse + ground ring; `restHeightFor`, `BEAM_HEIGHT` |
| `index.ts` | Barrel (`PickupSystem`) |

## Public API

- `ctx.pickups` — `getPickups()`, `findNear(pos, radius)` (pings snap to it, `PingKind 'item'`), `spawn(item, pos, vel?)`
  (local authority / host only — clients drop via `ctx.inventory.dropItem`), `takeBy(id, by)` (2026-09-15: authority
  only — a non-human body, i.e. an android id, picks the item up; removes it, broadcasts `item take {id, by}` and
  returns the instance), `clear()`. Types: `src/shared/types.ts` (`PickupsRef`, `PickupRef`).
- Emits:
  - `pickup:spawned {id, item, position}` — `position` is the pickup's live `Vector3` (moves while airborne).
  - `pickup:taken {id, item, byLocal, byName}` — `byName` = lobby name of a remote taker, `null` for local.
  - `pickup:removed {id}` — fires on **every** removal (taken, expired, evicted, cleared); markers clear on this.
  - `audio:play {id: 'pickup'}` when the local player takes an item.
- Consumes: `inventory:itemDropped`, `world:ready`, `net:hostChanged`; clears on `game:newMission`, `game:abort`,
  `hub:entered`, `world:ready`.
- Wire (`src/shared/net.ts`): `ItemMessage` (`item drop|take|sync`, host → clients), `ItemRequest`
  (`itemq drop|take|sync`, client → host), payload `PickupWire` (`ex` = durability / ammo / sockets, `rf` =
  `raidFound`, `q` = meal quality). Also answers `flow rejoined` from a peer with `item sync`.

### Protocol

Ids are `${peerId | 'sp'}-${n}` from the peer that created the pickup; the host **keeps** client-proposed ids so the
optimistic spawn and the echo dedupe.

```
Solo / host drop                       Client drop
inventory:itemDropped                  inventory:itemDropped
  → spawn locally                        → spawn locally, optimistic (proposed id)
  → item drop ─────────► others          → itemq drop ─────────► host
                                           host: spawn(id kept) → item drop ──► others
                                           client: id exists → optimistic = false (dedupe)
                                           no echo within OPTIMISTIC_TIMEOUT → optimistic pickup removed

Solo / host take (E)                   Client take (E)
tryAddItem ok?                         itemq take {id} ──────► host
  no  → keep (inventory:full)            host: exists? remove, pickup:taken{byName}
  yes → remove, pickup:taken{byLocal}          → item take {id, by} ──► others
      → item take ─────────► others    client: by === me → tryAddItem; full → re-drop in place
                                               by !== me → pickup:taken {byLocal:false, byName}

Sync
client world:ready (multiplayer, !host) → itemq sync ──► host → item sync {items} ──► that peer
net:hostChanged {isLocalHost:false} + world ready → itemq sync ──► the new host
```

Host validation is existence only: an unknown / already-taken id is dropped silently and the requester's
`TAKE_REQUEST_COOLDOWN` lets the prompt return.

## Rules

- Pool cap `PICKUP_MAX` (oldest evicted) and `PICKUP_LIFETIME` (> 0 → expires on every client) live in
  `data/constants.csv`. Interact radius / cooldowns are file-local constants in `PickupSystem.ts`.
- Landing and resting-spawn height use `world.getSurfaceY(x, z, bodyTop − PROP_STEP_UP_MAX)` + `restHeightFor`, not
  `getHeightAt` — otherwise items fall through upper floors. — `PickupSystem.ts`
- The prompt is available only while resting, not optimistic, and `ctx.isGameplayActive()`. — `makeInteractable`
- Any new item field that must survive the network (like `raidFound`, `quality`) is added to `wireOf` and
  `itemFromWire`; omitted = default (no mark / quality 0). Received items are rebuilt with
  `ctx.loot.createItem(defId, qty, ex)` (fresh uid). — `PickupSystem.ts`
- No lights in visuals (scene light count must stay constant). Bodies are on `Layers.NO_RAYCAST`. — `PickupVisuals.ts`
- The locator pillar exists in the pool but is always hidden (`beam.visible = false`); light pillars are shown only
  for corpses (`ui/hud/pillar.pillarAllowed`). The ground ring and body glow remain.
- `REST_Y` is `Record<VisualKind, number>`: a new `ItemCategory` fails typecheck here first. `VisualKind` =
  `ItemCategory | 'grenade'` (grenades are `category: 'gadget'` but keep their own silhouette via `def.grenade`).
  Categories with a dedicated silhouette (`primary`, `secondary`, `grenade`, `stim`, `ammo`, `valuable`, `book`,
  `meal`, `pouch`, `key`) are pre-created in `warm()`; the rest use the default crate body. — `PickupVisuals.ts`

## Recent changes

Older: `git log -- src/pickups`.
- 2026-09-15 — `takeBy(id, by)`: an android picks a ground item up on the authority (same broadcast as a peer's take).
- 2026-09-15 — `ItemCategory 'grenade'` retired; visuals key on `VisualKind` (`def.grenade` → grenade silhouette).
- 2026-09-13 — meal quality crosses the wire (`PickupWire.q`).
- 2026-09-12 — `raidFound` mark crosses the wire (`PickupWire.rf`).
- 2026-09-11 — `meal` / `pouch` / `key` silhouettes; `crop` / `soil` rest heights.
- 2026-09-11 — locator pillar hidden; landing height uses `getSurfaceY`.
