# src/weapons — Weapons, grenades, weapon FX

Owner: `WeaponSystem` (`name: 'weapons'`). Registers after `PlayerSystem`; reaches the player through `ctx.player` narrowed to `PlayerRef & PlayerWeaponHost`.

| File | Purpose |
|---|---|
| `WeaponSystem.ts` | **Two weapon slots** (2026-09-10 — `WEAPON_SLOTS` = `primary` 주무기 I / `primary2` 주무기 II; `WeaponSlot` 타입의 `secondary` 는 계약으로 남아 있으나 아무도 채우지 않는다) filled from `loadout:changed {primary, primary2, secondary, bag}` (defs via `ctx.loot.getItemDef(defId).weaponId → getWeaponDef`, fallback built-ins). Every slot keeps the inventory's own `ItemInstance` (`inst`) plus `EffectiveWeaponStats` from `ctx.loot.getEffectiveStats(inst)` (graded + socketed; `statsFromDef` when the loot service is missing) — the weapon fires with `stats.damage/magSize/spread/adsSpread/recoilV/recoilH/reloadTime/fireRate`, aims with `stats.adsZoom/scope` (`host.setAimZoom` + `weapon:scopeChanged`) and `stats.adsTime` (`host.setAdsTime`), swaps in `stats.swapTime`. Stats are re-read on equip, on `inventory:socketChanged` for the weapon uid (attachment meshes rebuilt, a shrunken mag hands excess rounds back to the bag via `createItem` + `tryAddItem`) and when `loadout:changed` repeats the same uid. Keys: **1** primary, **2** primary2 (**3 은 2026-09-10 부터 아무 칸도 가리키지 않는다** — `Keys.SECONDARY` 는 계약으로 남고 읽는 곳이 없다), **Q** previous slot (fallback: next occupied slot); empty slot → `ui_deny`; `weapon:swapStarted {slot, duration}` (0.4 s primaries / 0.1 s secondary). LMB fire (auto/semi, only while pointer-locked and `host.canUseWeapons()`), R reload. **T** (`Keys.QUICK`) = quick-use: tap → last consumable into the hand, hold → 8-way wheel (see "Phase 2" below); the old G grenade key is gone (`Keys.GRENADE` reserved) and **Phase 10 retired H** (`Keys.STIM` has no reader anywhere in the repo). **Durability**: every trigger pull (shotgun = one pull) writes `inst.durability -= WEAPON_DURABILITY_PER_SHOT` and emits `weapon:durabilityChanged {uid, weaponId, durability, max}` (also on equip / repair); at 0 the trigger only emits `weapon:broken`, plays `dry_fire` and toasts `내구도 소진 — 함선에서 수리 필요` at most every 2 s. **Ammo v2**: the magazine is `inst.ammoInMag` (undefined → full), reserve = `inventory.countWhere(ammo && ammoType === stats.ammoType)` rounds, reload takes `consumeWhere(pred, need)` rounds at reload end (`탄약 없음` when the reserve is 0). Firing: reticle ray from `host.getAimRay` with spread = lerp(hip, ADS) × **stance table** (`STANCE_ACCURACY`: stand-hip 1.0 / stand-ADS 0.7 / crouch 0.55 / 0.4 / prone 0.32 / 0.22, read from `host.stance`) × bloom × moving 1.35 / sprinting 1.5 → nearest of `enemies.raycast`/`world.raycast` (hits between camera and player ignored) gives the target; the real shot is re-cast from the muzzle toward that target; tracer from muzzle; damage × `damageFalloff(def, muzzle→hit distance)` (linear 1 → `falloffMin` between `falloffStart`/`falloffEnd`); `enemy.takeDamage(dmg, point, dir)`; shotgun pellets (falloff per pellet); `projectileSpeed` weapons use `ProjectilePool` (falloff from `ProjectileHit.distance`). Recoil = `stats.recoilV × (0.85..1.15) × stance` vertical, `(rand − 0.5) × stats.recoilH × stance` horizontal → `host.addRecoil`. **SR (bolt-action)**: after each shot a bolt-cycle phase (`1/fireRate − 0.05 s`) blocks the trigger, drives `WeaponModel.setBolt(t)` and emits `audio:play bolt_cycle` 0.22 s after the shot; extra `camera:shake`. `twoHanded` = class ≠ PISTOL. No firing while `host.isDiving`. Emits `weapon:equipped {slot: WeaponSlot}` / `ammoChanged` / `fired` / `dryFire` / `reloadStarted` / `reloadFinished` / `hit` / `scopeChanged` / `durabilityChanged` / `broken` / `swapStarted`, `quick:wheelChanged` / `quick:equipped` / `quick:used`, `grenade:holdChanged`, `weapon:reloadCancelled`, `heal:holdChanged`, `ui:hitmarker {kill, headshot}` (headshot = `EnemyHit.part === 'head'`), `grenade:countChanged`, `audio:play`. Consumes `loadout:changed`, `inventory:itemUpdated`, `inventory:socketChanged`, `inventory:changed` (HUD reserve refresh), `inventory:quickSlotsChanged`, `world:ready`, `game:abort`, `hub:entered`, `game:phaseChanged`, `net:remote*`. Pose → `host.setWeaponState`. If no `loadout:changed` arrives within 1 s of `world:ready`, equips the built-in rifle (primary) — 2026-09-10 부터 그것 하나뿐이다. **Multiplayer**: sends `fire` / `reload` / `grenade` messages (see below) and owns a `RemoteWeapons` instance that it updates every frame and clears on reset. |
| `model.ts` | 폴더 공용 어휘 — 상수 · 타입 · 스크래치 객체. `WeaponSystem.ts` 가 재수출한다 |
| `parts/Slots.ts` | **세 무기 슬롯의 상태.** 1 주무기 I · 2 주무기 II · 3 보조무기 — 어떤 `ItemInstance` 가 어느 슬롯에 있고, 그 실효 스탯 · 탄창 · 예비탄 · 내구도 · 부착물이 무엇인지. 인벤토리 쪽 변화(`loadout:changed`, 소켓 변경, 아이템 갱신)를 받아 여기서 무기 모델과 HUD 숫자를 다시 맞춘다. **발사는 하지 않는다.** |
| `parts/Firing.ts` | **격발 · 명중 · 재장전.** 트리거를 당긴 순간부터 피해가 들어갈 때까지: 실효 스탯으로 탄을 뽑고, 내구도를 깎고, 히트스캔/발사체를 쏘고(`raycastAll` — 배리어 · 돔 · 파괴 가능 엄폐물이 여기서 탄을 멈춘다), 명중을 적 · 원격 플레이어에게 전달한다. 정밀 사격 정렬(예측 카메라 원점)이 걸린 곳이기도 하다. **2026-09-12**: 탄이 어느 선을 따라 나가는지는 스스로 정하지 않고 `parts/AimLine` 의 `sys.aim.begin` / `resolve` 를 탄다 (펠릿마다 `resolve`). 예광탄 · 머즐 플래시 · `fire` 메시지는 여전히 실제 총구에서 나간다 (스코프 조준 중의 예광탄만 판정선에서). |
| `parts/AimLine.ts` | **총알은 어느 선을 따라 나가나 (하이브리드 판정, 2026-09-12).** `ShotResolver` — `begin(host, muzzle, aimO, aimDir)` 가 방향과 무관한 검사(몸 축 → 총구 = 총열이 벽을 뚫었나, 총구 → `P0` = 크로스헤어 선의 시작점이 총구에서 보이나 — 둘 다 **벽만** 센다: 몸에 붙은 적은 총열이 "뚫은" 것이 아니라 총구 앞 검사가 맡는다)를 하고, `resolve(dir, range, out)` 가 한 발을 푼다: ① 크로스헤어 선을 **총구 깊이의 점 `P0`** 부터 쏴 조준점을 찾고 ② 총열이 막혔거나 ③ 총구 → 조준점의 앞 `WEAPON_MUZZLE_BLOCK_RANGE`(3 m) 안에서 걸리면 `near` — 총알은 거기에 맞고, 그 자리가 조준점에서 `AIM_BLOCK_SAME_EPS` 보다 멀고 적 · 포탄이 아니면 `obstructed` ④ `P0` 가 총구에서 가려져 있으면 `converge`(옛 총구 → 조준점 수렴) ⑤ 아니면 `line` — 크로스헤어 선 그대로. 결과 `ShotLine {mode, origin, dir, hit, end, target, obstructed}`. `updateAimBlock` 이 매 프레임 같은 resolver 를 퍼짐 없이 돌려 `fx/AimBlockMarker` 를 띄우고 `weapon:aimBlocked {blocked}` 를 바뀔 때만 보낸다 (화염방사기 · 전격총은 선이 없어 제외). `fire()` · 유니크 `hitscan` · `aimShot` · `aimTarget` 이 전부 이 resolver 를 쓴다 — **미리보기와 실제 사격이 같은 함수**다. |
| `parts/QuickUse.ts` | **빠른 사용 (T 탭 / 홀드 휠).** 소모품 · 가젯을 손에 드는 경로 전체: 휠 열기/닫기, 슬롯 해석, 무기 홀스터, 손에 든 것을 놓고 총으로 돌아가기, 그리고 들쳐메기 중에는 모든 행동을 `dropCarried` 로 바꾸는 `carryGate`. |
| `parts/Healing.ts` | **회복 소모품 · 실드 충전기의 홀드 사용.** 붕대 · 약초 붕대 · 회복주사 · 제세동기는 좌클릭을 아이템별 시간만큼 **누르고 있어야** 하고 (`heal:holdChanged.dur`, 그 동안 이동 50 %), 회복 스프레이는 게이지를 깎으며 자신과 반경 안 아군을 계속 회복한다. 게이지가 0 이 되어도 캔은 사라지지 않고 함선에서 충전한다. **2026-09-11 (E-4)**: 아군 몫은 가슴 → 가슴이 트여 있을 때만 적는다(`shared/buffLineClear`). **2026-09-10 실드 충전기** (`shieldChargeOf(defId)`, `@/items`) 도 같은 홀드 · 같은 이동 감속을 쓰지만 끝에서 `PlayerRef.applyHeal` 대신 **`chargeShield(amount)`** 로 간다 (`Infinity` = 가득). `canChargeShield()` 가 `maxShield > 0 && shield < maxShield` 를 보고 **홀드를 시작조차 하지 않으므로** 방탄복이 없거나 실드가 가득이면 아이템이 소모되지 않는다. |
| `parts/Throwing.ts` | **손에 든 것을 던지기 (수류탄 · 투척 가젯).** 좌클릭 홀드로 들고, R 로 핀을 뽑아 쿠킹하고(`grenade:holdChanged` + 퓨즈가 와이어로 나간다), 놓으면 오버핸드 / 우클릭이면 언더핸드로 나간다. 손 안에서 터지는 경우(`explodeInHand`)도 여기. |
| `parts/Services.ts` | **`WeaponHost` 서비스 객체.** `fx/` · `unique/` · `Melee` · `Grenade` 는 `WeaponSystem` 을 직접 알지 않고 이 객체를 통해서만 월드에 접근한다(레이캐스트 · 피해 적용 · 오디오 · 카메라 흔들림 · 인벤토리 소모 …). 즉 이 파일이 무기 내부 모듈과 나머지 게임 사이의 **유일한 접점**이다. |
| `WeaponDefaults.ts` | `WEAPON_SLOTS` (**`['primary','primary2']`** — 2026-09-10), `DEFAULT_RIFLE` (`ar_fallback` 돌격소총, class AR, calibre `medium`, falloff 60→220 ×0.6), `DEFAULT_PISTOL` (`hg_fallback` 권총, class PISTOL, calibre `light`, falloff 20→70 ×0.5) fallbacks; `defaultFor(slot: WeaponSlot)` (both primaries → rifle); `statsFromDef(def)` → `EffectiveWeaponStats` for a bare def (mirrors items' `baseWeaponStats`: recoilH = 0.7 × recoil, secondary adsTime ×0.5, swapTime by slot); `kindOf(def)` → rifle/pistol/shotgun/energy/**smg**/**sniper** by class (so graded ids like `ar_g3` pick their family's silhouette; via `weaponClassOf` from `@/items`, re-exported with `damageFalloff`); `shotSoundId(kind)`; `shotPitchFor(class)` (DMR 0.78); `STANCE_ACCURACY` table. |
| `WeaponModel.ts` | Procedural rifle / pistol / shotgun / energy-rifle / **SMG** (+ **Phase 6** six unique silhouettes: 「인페르노」 fuel tank under the fore-end + hose + nozzle bell with an emissive pilot ring, 「테슬라 코일」 copper coil rings around a glowing core rod + capacitor pack, 「카게」 forearm bracer + launcher rail + a holder stacked with stars, 「롱혼」 vertical riser + angled limbs + string + nocked arrow (string / arrow pull back with the recoil kick), 「해머헤드」 fat olive tube with flare / venturi / shoulder rest / flip sight + loaded warhead, 「사이클론」 six barrels around a hub that `setSpin(0..1)` rotates + motor housing + drum; `setHeat(0..1)` drives the pilot / coil glow) (compact receiver, shrouded stub barrel, skeleton stock, vertical mag) / **sniper** (long heavy barrel + brake, scope tube with emissive lens rims and turrets, folded bipod, long stock with cheek riser, bolt handle) meshes (grip at origin, barrel -Z) with `muzzle` and `ejectPort` sockets on every variant. **Attachments** (`setAttachments(WeaponAttachmentVisuals)`, rebuilt from `inst.sockets` by `WeaponSystem.attachmentsFor`): `muzzle` brake (baffled can) / comp (ported can + accent strip) / choke (flared tube) extend the `muzzle` socket forward; `grip` vertical / angled block under the fore-end; `sight` laser (emitter beside the barrel + 1.6 m thin emissive beam — no light) or a scope tube with lens rims on non-SR weapons (mini red-dot on pistols, nothing on the sniper which already has one); `mag` extended body parented to the animated magazine (side-saddle on shotguns); `stock` cheek riser + rubber butt pad. Per-kind anchors in `ANCHORS`; attachment geometry/materials are tracked separately and disposed on every rebuild and in `dispose()`. Animation: recoil kick (`kick`), reload (mag drops, disappears, new mag slides in; weapon cants), draw/holster swing (`setDraw`), bolt cycle (`setBolt(0..1)`: handle lifts, pulls back, returns; weapon cants), energy glow pulse. |
| `RemoteWeapons.ts` | **Multiplayer only** (every entry point returns immediately unless `ctx.isMultiplayer && ctx.net`). Owned by `WeaponSystem`. **Phase 6**: `onFireMessage(from, FireMessage)` (raw `fire` with `m` / `c`, subscribed through `ctx.net.onMessage` because the `net:remoteFired` bus event drops those fields) replays the uniques — flame cone / lightning arcs held from the replica muzzle until the next ≤ 10 Hz refresh, `BEAM_GRACE` 0.35 s or the final `c:-1`; charged bolt = thick tracer + flash; shuriken = 1 / 3 visual stars; bazooka = visual rocket (fuse on `m:1`) that pops in `onVisualProjectileHit` (explosion FX + sound + shake, never damage). `onFired` (bus) skips those four uniques and keeps handling the bow / minigun like ordinary shots (arrow body via `projectileOptsFor`, no casing for the bow). (1) **Remote weapon models**: each frame walks `ctx.net.getRemotePlayers()`; when `ref.weaponId` or `ref.avatar.weaponSocket` changes it disposes the old `WeaponModel` and parents a new one (def via `ctx.loot.getWeaponDef(id)`, then the family id with `_gN` stripped, then `DEFAULT_PISTOL`/`DEFAULT_RIFLE`) into the avatar's socket with identity local transform (same convention as the local `getWeaponSocket()`); kept while `DEAD`; swept when the ref disappears, removed on `net:remotePlayerRemoved`, cleared on `game:abort` / `game:newMission` / `world:ready`. `getMuzzleWorld(id, out)` exposes the model's muzzle. (2) **Replicated fire** (`onFired` ← `net:remoteFired`): muzzle = remote model muzzle if attached else message origin; muzzle flash + tracer(s) via the shared FX pools; visual-only hit test (`enemies.raycast` → `world.raycast`) for impact sparks/dust/ichor — **no damage, no `weapon:hit`, no `weapon:fired`, no hitmarker**; shotgun fans `pellets` rays with the def's hip `spread`; `projectileSpeed` weapons spawn `ProjectilePool.fire(..., visualOnly=true)` (impacts routed to `onVisualProjectileHit`); model `kick`, casing, SR bolt cycle animation + delayed `bolt_cycle`; shot sound via `audio:play {id: shotSoundId(kind), position: muzzle, pitch: shotPitchFor(class)}`. Rate-limited per peer with a token bucket (20 FX/s, burst 6). (3) `onReloaded` ← `net:remoteReloaded`: drives `WeaponModel.setReload` over `def.reloadTime`, `audio:play reload` at the remote's chest, `reload_done` when finished. (4) `onGrenade` ← `net:remoteGrenade {…, fuse?}`: `GrenadeManager.throw(p, v, visualOnly=true, fuse ?? GRENADE_FUSE)` — a cooked remote grenade pops early on every client, `fuse 0` (blew up in the thrower's hand) explodes on the next update. A remote's model is hidden while its flags carry `IN_HUB`, `IN_POD`, `DROPPING`, **`HOLDING_ITEM`** (stim / grenade in hand — player/ draws the held item from `PlayerSnapshot.h`) or **`DOWNED`**, or lack `HAS_WEAPON`. **Phase 7**: `syncAttachments` mirrors the snapshot's attachment ids (`RemotePlayerRef.attachments`, read duck-typed) onto the replica through `WeaponModel.setAttachments` — element-wise compare per frame, rebuilt only when the id set differs (also after a model rebuild). |
| `Attachments.ts` | **Phase 7**: attachment def ids → `WeaponAttachmentVisuals` shared by the local weapon (`attachmentVisualsFor(ctx, inst)` from `inst.sockets`) and remote replicas (`attachmentVisualsFromIds(ctx, ids)` from `PlayerSnapshot.att`); socket from `ItemDef.attachment.socket`, else the instance's socket key, else a keyword in the id. `attachmentIdsOf(inst, out)` (stable socket-key order) and `sameIds(a, b)` back `ctx.weapons.remoteState.attachments`. |
| `Grenade.ts` | `GrenadeManager`: 8 pooled frags; gravity, terrain bounce (restitution/friction via `getNormalAt`), obstacle push-out, `GRENADE_FUSE` (3 s, shared constant; the local `GRENADE_FUSE` export is an alias) fuse with accelerating LED blink (emissive LED + one pooled `FlashPool` pulse per blink rising edge via `WeaponFx.ledBlink`); explosion radius 6 m / 250 dmg via `enemies.applyExplosion`, self-damage with falloff, distance-scaled `camera:shake`, `grenade:thrown/exploded`, `audio:play explosion`. **No per-grenade lights** (see "Grenade hitch" below). `throw(origin, velocity, visualOnly = false, fuse = GRENADE_FUSE)`: `fuse` = seconds left (cooked grenades leave the hand with `GRENADE_FUSE − cooked`, min 0.15; `0` explodes on the next update — used for the in-hand blow-up); a **visual-only** grenade (remote player's replica) keeps the arc/bounce/fuse/LED/explosion FX/`camera:shake`/`audio:play grenade_throw|grenade_bounce|explosion` **and (Phase 7) the radial damage to the local player** (`GRENADE_DAMAGE × (1 − d / GRENADE_RADIUS) × 0.6`, chest-height distance, the same rule as our own frag — friendly fire applies) but skips `applyExplosion` (enemy damage is the thrower's → host), `ui:hitmarker` and the `grenade:thrown/exploded` events (so enemies don't "hear" it and audio isn't doubled). When the pool is full a visual-only replica is evicted before a live local grenade. **2026-09-11**: 걸음마다 `breakFragileAlong` 으로 창문 유리를 깨고 지나가고, 바닥은 지형이 아니라 `getSurfaceY`(건물 2층 · 옥상 · 계단). |
| `Projectile.ts` | `ProjectilePool`: 48 swept projectiles (enemy + world raycast per step, slight drop), glowing tracer trail, hit callback with `ProjectileHit.distance` (meters travelled from the muzzle, for falloff). `fire(..., visualOnly = false, opts?)`: visual-only slugs (remote replicas) route their hit to the optional second constructor callback `onVisualHit(h, weaponId)` instead of the damage callback. **Phase 6** `ProjectileOptions`: `style` (`slug` sphere / `shuriken` spinning four-point star / `arrow` shaft + head + fletching / `rocket` tube + warhead + fins with a thruster + smoke trail — one hidden body group per slug, shared geometry), `gravityMul` (0.15 default, 0 = dead straight), `fuse` (self-detonates: synthetic hit at the current position, `ProjectileHit.fused`), `tag` (echoed in `ProjectileHit.tag`). `projectileOptsFor(def)` picks the body / drop for a unique def. |
| `Blocking.ts` | Shields / solid deployables in the path of a bullet: `raycastBlockers(ctx, origin, dir, maxDist, out, fromEnemy, info?)` → distance of the nearest blocker (`-1` = none), optionally filling a `BlockInfo {kind: 'barrier' \| 'gadget' \| null, owner}` (`makeBlockInfo()` allocates one; reuse a module scratch). Duck-typed and try/caught, so a half-built `ctx.implants` / `ctx.gadgets` can never break firing. Allied implant barriers ignore allied bullets (`fromEnemy=false`), solid deployables stop everything. **Phase 9**: `ctx.implants.raycastBarrier` is a *pure* query now, so this function damages nothing — a caller whose shot really ended on a barrier calls `damageBarrierAt(ctx, owner, point)` (→ `ImplantsRef.damageBarrier`) exactly once. Speculative uses (`WeaponHost.lineOfSight`, aim probes, the unique handlers' LOS filters) are therefore free. |
| `unique/UniqueHandler.ts` | Phase 6 contract between `WeaponSystem` and a unique weapon: `UniqueHandler` (`update(dt, w, input or null)`, `onEquip/onUnequip`, `pose`, `handlesMelee`, `allowsAim`, optional `onProjectileHit`, `reset`), `UniqueInput` (both mouse buttons + the melee key), `UniqueServices` (what the system lends: `mag / reserve / drain / spend / brokenCheck / dryFire / tryReload`, `muzzle / aimRay / aimTarget / hitscan / fireStandard`, `announceFire / announceBeamEnd`, `recoil / setCooldown / cooldown`, `deny / notify / lightMelee / lineOfSight / emitAmmo`), helpers `coneTargets` (alive enemies inside a cone with LOS, nearest first, radius-aware angle tolerance) and `enemyCentre`. |
| `unique/UniqueFx.ts` | Pooled beam visuals shared by the local player and remote replicas (keyed by owner `'local'` / peer id): 4 additive flame cones (outer + hot core, flicker, embers + smoke wisps off the body) and 4 lightning arcs (`LineSegments` with a preallocated `ARC_BOLTS × 9` jagged-segment buffer rewritten every frame, glow + core pass, contact sparks). Owners call `setFlame / setArc` every frame; anything not refreshed is hidden in `update`. No lights. |
| `unique/Flamethrower.ts` · `Shockgun.ts` · `Shuriken.ts` · `Bow.ts` · `Bazooka.ts` · `Minigun.ts` | The six handlers — see "Phase 6" below. `unique/index.ts` exports `createUniqueHandler(kind, services)`. |
| `fx/ThrowArc.ts` | **투척 궤적 미리보기** (2026-09-08): a dotted arc from the hand to the first ground contact plus a ring marker where the throw lands, shown by `WeaponSystem.updateThrowArc` whenever a grenade or a `use: 'throw'` gadget is in the hand. It is a **re-simulation, not an approximation** — `show(origin, velocity)` integrates exactly what `Grenade.update` / `ThrownGadget.update` integrate (gravity, `world.resolveCollision` against the obstacle hash, terrain height) from exactly the release point and velocity the throw will use, so 근력 (`derived.throwRangeMul`), the over/under-hand toggle, the player's own momentum and a rock in the way all show up for free and the arc cannot drift out of sync with the throw. `STEP` 1/30 × `MAX_STEPS` 75 (2.5 s of flight), one dot per step. Pooled and light-free: one `Points` cloud over a fixed buffer picked by `setDrawRange` and one `RingGeometry` marker, both `depthTest: false`. `hide()` / `isShowing` / `getImpact(out)`. **2026-09-11 — 끝까지 그리지 않는다** (사용자 요청): 끝까지 적분한 뒤 수평 비거리의 `THROW_ARC_PREVIEW_FRACTION`(0.5)까지만 점을 찍고 **착지 고리는 감춘다** (`getImpact` 는 여전히 실제 착지점). 근력 · 임플란트로 사거리가 늘면 보이는 궤적도 그만큼 길다. 바닥은 투척물과 같은 `getSurfaceY`. |
| `fx/AimBlockMarker.ts` | **총구 막힘 표시** (2026-09-12). 총구 선이 앞 3 m 안의 벽 · 창틀 · 엄폐물에 걸려 크로스헤어대로 나가지 않을 때 **그 표면에** 빨간 고리 + 점(`--c-danger` 와 같은 빨강)을 그린다 — 총알이 실제로 맞을 자리다. `show(point, normal, dir, camera, time)` 는 표면 법선을 향해 2 cm 띄우고 카메라 거리 × 0.018 (0.045–0.35 m)로 키워 거리와 상관없이 같은 크기로 읽히며 살짝 깜빡인다. 광원 없음, `MeshBasicMaterial` `depthTest: false`. `init` 때 씬에 (숨긴 채) 들어가 코어 셰이더 선컴파일이 함께 컴파일한다. `hide()` · `isShowing` · `getPoint(out)` · `dispose()`. |
| `fx/WeaponFx.ts` | Muzzle flash (FlashPool light + glow, sparks, wisp), casings, surface impacts (sparks on obstacles, dust on terrain), enemy ichor, explosion (fireball, sparks, smoke, ground ring, flash, expanding shockwave ring), `ledBlink` (grenade LED pulse through the FlashPool), `warmUp(renderer, scene, camera)` (`renderer.compile` of the whole scene incl. hidden pooled meshes; called by WeaponSystem one frame after phase `deploying`. **2026-09-07**: `compileAsync` was dropped — its promise was never awaited, and its 10 ms `isReady()` poll walks the material set it collected from the **live** scene, so a material disposed meanwhile (a remote avatar leaving, a gear look rebuilt) threw `Cannot read properties of undefined (reading 'isReady')` from inside three's own `setTimeout`, out of reach of our `.catch`. `compile()` issues the same links; the driver still finishes them in the background). |
| `index.ts` | Barrel. |

Audio ids emitted: `shot_rifle` (AR; DMR at pitch ×0.78), `shot_pistol`, `shot_shotgun`, `shot_energy`, `shot_smg`, `shot_sniper`, `bolt_cycle`, `dry_fire`, `reload`, `reload_done`, `weapon_swap`, `hit_flesh`, `hit_metal`, `hit_dirt`, `grenade_throw`, `grenade_bounce`, `explosion`, `ui_deny`. Remote replicas reuse the same ids (positional, slightly quieter) — `AudioSystem` does not auto-hook gunfire from `weapon:fired`, so remote shots produce sound solely through these explicit `audio:play` emits.

## Weapon package (2026-09-05): slots, stats, durability, ammo v2, attachments

**Slots & keys.** `slots: Record<WeaponSlot, WeaponInstance | null>` (`secondary` 키는 타입 때문에 남지만 언제나 null); `active` is the slot in hand, `prevActive` the one before the last completed swap. `1` / `2` request a slot (**3 은 2026-09-10 부터 읽지 않는다**), `Q` requests `prevActive` (if still occupied and not active) else the next occupied slot in 1→2 order. A request for an empty slot plays `ui_deny`. Swap = holster (first half) + draw (second half) over `stats.swapTime` of the **target** weapon (0.4 s primaries / 0.1 s secondary, from items or the fallback); `weapon:swapStarted {slot, duration}` fires at the request, `weapon:equipped {slot}` when the model switches at the midpoint. A swap cancels a reload and flushes the outgoing weapon's `ammoInMag` / `durability` to the inventory.

**Effective stats.** `resolveStats(inst, def)` = `ctx.loot.getEffectiveStats(inst)` → `getEffectiveStats(def.id)` → `statsFromDef(def)`. Used for: damage (× `damageFalloff` from the raw def, which still owns range/falloff/pellets/projectileSpeed/tracer/automatic), magSize, hip/ADS spread, recoilV/recoilH, reloadTime, fireRate, swapTime, adsZoom/scope (`applyAimZoom` → `host.setAimZoom` + `weapon:scopeChanged`, de-duplicated) and adsTime (`host.setAdsTime`, de-duplicated; items already halves it for secondaries and applies stock multipliers, so it is passed through untouched). `stats.laser` is not read — the laser sight shows through the attachment mesh (thin emissive beam, no light). Refresh points: equip, `loadout:changed` with the same uid, `inventory:socketChanged` (matching weapon uid). `inventory:itemUpdated` for a held uid only re-reads `durability` / `ammoInMag` (repair, unload) and re-announces them.

**Durability.** `inst.durability` (undefined → `stats.maxDurability`, set on equip). Each `fire()` (one per trigger pull; a shotgun's pellets count once) subtracts `WEAPON_DURABILITY_PER_SHOT`, writes the field and calls `ctx.inventory.updateItem(uid, {ammoInMag, durability})`; `selfWriting` guards against the echoed `inventory:itemUpdated` / `inventory:changed`. `weapon:durabilityChanged {uid, weaponId, durability, max}` follows every shot and every equip / repair. At 0 the trigger (`wasMousePressed`, or the first auto-fire frame — `dryFlagged` resets on release) emits `weapon:broken {uid, weaponId}` + `audio:play dry_fire` and a `ui:notify` warning (`내구도 소진 — 함선에서 수리 필요`) throttled to one per 2 s; nothing fires, no ammo or durability changes.

**Ammo v2.** Magazine = `inst.ammoInMag` (undefined → full on equip). Reserve = `ctx.inventory.countWhere(d => d.category === 'ammo' && d.ammoType === stats.ammoType)` — rounds, since an ammo item's `qty` is its round count. Reload: refused with `탄약 없음` + `ui_deny` when the reserve is 0; otherwise at the end of `stats.reloadTime` it takes `consumeWhere(pred, magSize − ammoInMag)` rounds (partial refills when the bag runs low) and persists `ammoInMag`. **Persistence policy chosen**: `ammoInMag` is written to the instance on every shot and persisted through `updateItem` on every shot together with `durability` (one call per trigger pull — durability needs the call anyway, so there is no separate throttle), plus on reload end, swap-out, holster (`flushAll` on entering hub/menu/docking) and `game:abort`. `inventory:changed` (ammo picked up / dropped) re-emits `weapon:ammoChanged` with the fresh reserve. Without an inventory (dev), a per-uid `fallbackReserve` of `magSize × reserveMags` rounds stands in. When a socket change shrinks the magazine, the excess rounds go back to the bag as ammo items of that calibre (`createItem` + `tryAddItem`, best effort). The old per-uid `AmmoState` map is gone.

**Attachments → visuals.** `attachmentsFor(inst)` walks `inst.sockets`; for each attachment the socket comes from `ctx.loot.getItemDef(defId).attachment.socket` (fallback: the socket key) and the variant from the def id: muzzle `comp` / `choke` / else `brake`; grip `angled` / else `vertical`; sight `laser` when `effects.laser` or the id contains `laser`, else `scope`; mag / stock → `true`. Sent to `WeaponModel.setAttachments` on equip and on `inventory:socketChanged`.

**Events emitted** (new): `weapon:durabilityChanged`, `weapon:broken`, `weapon:swapStarted`. **Consumed** (new): `inventory:itemUpdated`, `inventory:socketChanged`, `inventory:changed`. `loadout:changed` now carries `primary2` / `bag` (`bag` is ignored here).

**Not done in this phase**: `stats.laser` has no HUD dot. (Remote attachment meshes are replicated since Phase 7 — see below. The G grenade key was replaced by the quick-use hand in Phase 2, below.)

## Phase 2 (2026-09-06): quick-use wheel, consumables in hand, grenade cooking / underhand

Contract: `InventoryRef.getQuickSlots / getQuickSlotCount / consumeItem`, `PlayerRef.applyStim / hp / maxHp`, `PlayerWeaponHost.setLookLocked / setWeaponState({…, throwing, holdingItem})`, constants `QUICK_*`, `isQuickSlotActive`, `GRENADE_FUSE / GRENADE_COOK_MAX / GRENADE_UNDERHAND_SPEED_MUL`, events `inventory:quickSlotsChanged` (in), `quick:wheelChanged / quick:equipped / quick:used / grenade:holdChanged` (out), `GrenadeMessage.fuse`.

**F key (`Keys.QUICK`)** — gameplay only (`isGameplayActive`, pointer locked, `host.canUseWeapons()`, not diving). `updateQuickKey`: a press starts a hold timer. Released before `QUICK_WHEEL_HOLD` (0.22 s) = **tap**: the last used wheel index (`lastQuickIndex`, reset on `world:ready` / `game:abort`), else the first usable slot in `QUICK_SLOT_UNLOCK_ORDER` (N, S, E, W, diagonals); nothing usable → `ui_deny`. Tapping while that same item is already in hand goes back to the gun (toggle). Held longer = **wheel**: `host.setLookLocked(true)`, `quick:wheelChanged {open:true, hover:null}`, `audio ui_open`; `ctx.input.mouseDX/DY` accumulate and once the vector exceeds `QUICK_WHEEL_DRAG_PX` (30 px) the index is `round(atan2(dx, −dy) / 45°) mod 8` (0 = N/up, clockwise, screen y down = S); `hover` is only a slot that is active for the bag (`isQuickSlotActive(index, getQuickSlotCount())`) and holds a stim/grenade (`QUICK_USABLE_CATEGORIES`), otherwise null; `quick:wheelChanged` fires on every hover change (`ui_click`). Release: `setLookLocked(false)`, `{open:false, hover:null}`, and a valid hover is equipped. While the wheel is open, fire / swap / hand input is ignored (`inputFree`). Losing `usable` (death, menu, pod) closes the wheel without equipping.

**Consumable in hand** (`quick: QuickHand | null`; `active` keeps the gun slot to return to). `equipQuick(index)`: cancels reload / finishes a pending swap, flushes the gun, draws it down over `QUICK_HOLSTER_TIME` 0.15 s (`WeaponModel.setDraw`, the model hides itself at `drawT ≤ 0.02`; it stays parented), `applyAimZoom(null)` (→ `host.setAimZoom(1,false)` + `weapon:scopeChanged`), `quick:equipped {index, item}` (**no** `weapon:equipped`), pose `setWeaponState({hasWeapon:false, holdingItem:true, throwing: holding})`. `1 / 2 / 3 / Q` → `requestSwap`: `leaveQuick()` emits `quick:equipped {index:null, item:null}` first, then the normal swap starting at its midpoint (draw half only, `weapon:swapStarted` reports the half duration) → `weapon:equipped`. `inventory:quickSlotsChanged` with the slot empty / another def / slot no longer active → `returnToGun()` (previous gun, else the next occupied slot, else empty hands); a **sibling stack of the same def** that the inventory relinked into the slot (its `consumeItem` does this when a stack hits 0) is adopted silently (`adoptSlot`). `attachActive` in hand mode keeps the gun drawn down and announces nothing. `world:ready` / `game:abort` / `hub:entered` / holster → `dropQuick()` (hold ends without a throw, gun model restored instantly, `quick:equipped null`).

**Stim in hand**: LMB press → `host.hp >= maxHp` → `ui_deny`; else `inventory.consumeItem(uid, 1)` (must remove 1, else `ui_deny`) → `host.applyStim(def.healAmount ?? 50)` → `quick:used {index, item, remaining}` (the player plays the stim audio). `QUICK_USE_COOLDOWN` 0.4 s. `remaining` 0 → back to the gun. **Superseded by the Phase 10 2 s hold** — see the last section.

**Grenade in hand**: LMB down → `holding` (`throwing` pose, `grenade:holdChanged`). While holding: **R** pulls the pin (`cooking`, `ui_click`), `cooked` counts up and `grenade:holdChanged` fires every frame with `fuse = max(0.15, GRENADE_FUSE − cooked)`; at `GRENADE_COOK_MAX` (3 s) `explodeInHand`: item consumed, `GrenadeManager.throw(hand, 0, false, 0)` → next-frame explosion incl. self damage, `quick:used`, hold ends. **RMB** toggles `underhand` (persisted between holds, emitted). **LMB release** → `throwHeld`: item consumed (`quick:used`), `throw(hand, v, false, fuse)`; overhand `v = aim × 17 + vel × 0.5, +3.5 up`; underhand `v = aim × 17 × GRENADE_UNDERHAND_SPEED_MUL (0.45) + vel × 0.5`, flattened with +1.2 up; multiplayer `send({t:'grenade', p, v, fuse})`; `grenade:holdChanged {holding:false}`; an empty stack (no sibling) → back to the gun, else the grenade stays in hand. `grenade:thrown` / `grenade:exploded` unchanged. `cancelHold` (swap, another consumable, death / control loss, `!usable`): no throw, no consume — **except with the pin pulled**: the grenade is dropped at the feet (`throwHeld(…, dropAtFeet)`, v = 0.5 up) with the remaining fuse. Hand position = eye + aim × 0.6 + right × 0.25. `grenade:countChanged` still follows every grenade consume / loadout. The dev fallback without an inventory has no quick-use (F → `ui_deny`).

**Ordering guard**: `quickBusy` is set around our own `consumeItem` so the echoed `inventory:quickSlotsChanged` / `inventory:changed` do not swap back to the gun before `quick:used` has gone out; the stack left is read back from `getQuickSlots()[index]` after the call.

**Verified** (headless Chrome, swiftshader, harness pattern of `scripts/smoke-weapons.mjs` with the vite HMR client stubbed): 39/39 — F tap → `quick:equipped` slot 0 / no wheel / `holdingItem` pose / gun hidden after 0.15 s; F hold → `{open:true, hover:null}` → drag N → hover 0 → release closes and equips; LMB → `holding`, `throwing` pose; R → `cooking`, `fuse = 3 − cooked`; RMB → `underhand`; release → `grenade:thrown` with scaled velocity, `quick:used remaining 1`, bag −1, `grenade:countChanged`, early explosion; grenade stays in hand; `1` → `quick:equipped null` then `weapon:equipped primary`, model visible; stim: consume + `player:stimUsed`, refused at full hp; tap toggles back; `setQuickSlot` with another def while in hand → gun; cook to 3 s → in-hand explosion, item consumed, self damage → downed (Phase 2 death flow), empty stack → gun. 0 console errors.

**Not done**: remote players' cook *gauge* is not replicated (no wire field for `cooked`; the hold / pin-pulled poses are — Phase 7 `THROWING` / `COOKING` flags from `remoteState`); the underhand arc numbers are first-pass; the quick-use audio reuses `ui_open` / `ui_click` / `weapon_swap` (no dedicated pin / wheel sounds yet).

## Phase 6 (2026-09-06): unique weapons

Contract: `WeaponDef.unique / altFire / altDamage / chargeTime / ammoPerSec`, `UniqueWeaponKind`, `EnemyManagerRef.applyStatus('incinerated' | 'shocked') / queryNear / applyExplosion`, `EnemyRef.isIncapacitated`, `PlayerRef.consumeStamina / setViewWiden / startMelee('heavy') / applyKnockback / applyImpulse / isGrounded / damageReduction`, `PlayerWeaponHost.setWeaponState({charging, spraying, heavy})`, constants `FLAME_* / BURNOUT_* / SHOCK_* / SHURIKEN_* / SLASH_* / BOW_* / BAZOOKA_* / MINIGUN_*`, events `weapon:chargeChanged / weapon:beamChanged / weapon:altFired / player:slashed / player:blastJump` (out), `FireMessage.m / c` (net). Data (`u_flame` … `u_minigun`, `wpn_u_*`, `ammo_fuel/cell/shuriken/arrow/rocket/belt`) lives in items; `ctx.loot.getEffectiveStats` returns the def numbers for a unique and `canAttach` is false.

**Integration.** A slot whose def carries `unique` gets a `UniqueHandler` (`WeaponInstance.unique`, built by `createUniqueHandler` in `onLoadout`, disposed in `setSlot`). While that slot is in hand the regular trigger block is skipped: R still reloads, otherwise `handler.update(dt, w, readUniqueInput())` runs with both mouse buttons + `Keys.MELEE` (the generic F swing is skipped when `handlesMelee`). Whenever the active unique got no input this frame (menu / wheel / reload / swap / consumable in hand / holster) it is ticked with `input: null` so beams stop, charges cancel and the minigun spins down. **RMB is the alt fire, never ADS**: `zoomStatsFor()` hands `applyAimZoom` null (zoom 1, `weapon:scopeChanged {zoom:1}`) for every unique except the bow (`allowsAim`). Pose: `handler.pose` → `setWeaponState({charging, spraying, heavy})` (+ `firing`), and `altFire: true` for every unique without `allowsAim` so the player never enters the ADS state on RMB (no aim pose / camera facing / `aiming` snapshot bit — the zoom alone was neutralised before 2026-09-06). `onEquip / onUnequip` fire around the model attach in `attachActive`; `reset()` on `resetTransient` (world reset / abort / hub / holster) and on an implant holster. Projectile hits whose weapon has `onProjectileHit` (bazooka) resolve in the handler instead of `applyHit`.

**Ammo & durability.** Continuous weapons call `services.drain(w, dt)`: `def.ammoPerSec × dt` accumulates in `WeaponInstance.ammoFrac` and every whole unit is subtracted from `inst.ammoInMag` and persisted through the normal `persist()` (`inventory:itemUpdated`, `weapon:ammoChanged`); durability wears 1 per second of fire (`durFrac`). Per-shot uniques call `spend(w, rounds)` (n rounds + 1 durability, one persist). `brokenCheck` / `dryFire` reuse the system's `dryFlagged` (reset when both buttons are up) so a broken or empty unique clicks once per press and an empty one starts a reload. Reload is the standard `tryReload` (R, or auto after the bazooka's single rocket).

| Weapon | LMB | RMB | Extras | Events / net |
|---|---|---|---|---|
| 「인페르노」 `u_flame` (`Flamethrower.ts`) | cone `FLAME_RANGE` 12 m / `FLAME_CONE_DEG` 32°: every enemy in the cone with LOS (`coneTargets`, radius-aware angle) takes `FLAME_DPS × tick` in 10 Hz ticks + `applyStatus('burning', FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION)`; heat per enemy (`Map<id, heat>`) += damage, cools `BURNOUT_DECAY_PER_SEC` once the flame has left it (≥ 1.5 ticks), `BURNOUT_THRESHOLD` 240 → `applyStatus('incinerated', 0, BURNOUT_DURATION)` + heat 0 | long jet `FLAME_ALT_RANGE` 26 m / `FLAME_ALT_CONE_DEG` 7°, `altDamage` (`FLAME_ALT_DPS`) | fuel `ammoPerSec` 12/s, durability −1/s; no self damage; `model.setHeat(1)` pilot glow; `UniqueFx.setFlame('local', …)` every frame; hitmarker per tick with targets | `weapon:beamChanged {mode}` on/off, `weapon:altFired` when the jet starts, `weapon:fired` + `fire {m, c:1}` at 10 Hz, `fire {m, c:-1}` on stop |
| 「테슬라 코일」 `u_shock` (`Shockgun.ts`) | arc to the `SHOCK_MAX_TARGETS` 4 nearest enemies in `SHOCK_RANGE` 14 m / `SHOCK_CONE_DEG` 50° with LOS: `SHOCK_DPS` 72 in 10 Hz ticks + `applyStatus('shocked', SHOCK_SLOW_FACTOR, SHOCK_SLOW_DURATION)` every tick (enemies emit `enemy:shocked` once); `setArc` every frame; cells `ammoPerSec` 8/s | hold = charge over `chargeTime` (`SHOCK_CHARGE_TIME` 1.1 s), `weapon:chargeChanged {kind:'charge', t}` every frame; release = hitscan bolt `altDamage × lerp(SHOCK_CHARGE_MIN_RATIO, 1, t)` over `SHOCK_CHARGE_RANGE` (def falloff), `SHOCK_CHARGE_CELLS` 6 (refused as a dry fire below), thick tracer, cooldown = charge time, `t:-1`; input loss cancels the charge (`t:-1`) | arc stops while charging; `setHeat(charge)` coil glow | `weapon:beamChanged`, `weapon:altFired`, `fire {m:0, c:1}` 10 Hz / `{m:1, c:t}` per bolt |
| 「카게」 `u_shuriken` (`Shuriken.ts`) | one star: `Projectile` style `shuriken` (spinning, 0.08 g drop) from the muzzle toward the reticle target (`aimTarget`), `fireRate` 3.2 | three stars fanned ±`SHURIKEN_TRIPLE_SPREAD_DEG` about world up, `SHURIKEN_TRIPLE_COOLDOWN` 0.9 s, consumes min(3, mag) | **melee key**: press opens `weapon:chargeChanged {kind:'slash', t: hold/SLASH_HOLD_TIME}`; release < `SLASH_HOLD_TIME` 0.45 s → `services.lightMelee()` (normal F swing); ≥ → **용검**: `consumeStamina(maxStamina × SLASH_STAMINA_RATIO)` (false → `ui_deny` + toast `스태미나 부족 …`), `setViewWiden(true)`, `startMelee('heavy')`, hit resolved `SLASH_WINDUP` 0.18 s later: every alive enemy within `SLASH_RANGE` 3.8 m (+ radius) inside `SLASH_ARC_DEG` 160° of the horizontal forward takes `SLASH_DAMAGE` 280 (`melee:hit`, hitmarker, ichor), `player:slashed {hits}`, `setViewWiden(false)` when `SLASH_DURATION` 0.6 s ends; `melee` net message with `hit` | `weapon:altFired` on the fan, `fire {m: 0/1}` per throw |
| 「롱혼」 `u_bow` (`Bow.ts`) | semi-auto arrow through the regular `fire()` (`projectileOptsFor` → style `arrow`, gravity 0: dead straight, `BOW_PROJECTILE_SPEED` 115), `BOW_FIRE_RATE` 2.4 | **ADS** (`allowsAim`, `adsZoom` 1.6) — the only unique that aims | string / nocked arrow pull back with the kick; no casing | standard `weapon:fired` + `fire` |
| 「해머헤드」 `u_bazooka` (`Bazooka.ts`) | impact rocket (style `rocket`, 0.02 g, tag 0) → `onProjectileHit`: `applyExplosion(BAZOOKA_RADIUS 5.5, BAZOOKA_DAMAGE 420)` + destructible cover in the radius (`world.getObstaclesNear` → `destructible.onDamage` with falloff) | air-burst rocket (tag 1, `fuse: BAZOOKA_ALT_FUSE` 0.4 s → `ProjectileHit.fused`), `BAZOOKA_ALT_RADIUS` / `altDamage` | **self damage** inside the radius: `takeDamage(BAZOOKA_SELF_DAMAGE / (1 − damageReduction))` so the flat 22 lands regardless of armor, `applyKnockback(away, BAZOOKA_KNOCKBACK)`, and airborne with the blast below the feet → `applyImpulse(0, BAZOOKA_SUPER_JUMP, 0)` + `player:blastJump`; 1-rocket tube auto-reloads after the shot (`reloadAsked`); `heavy` pose; big flash / shake / `explosion` FX + sound | `weapon:altFired` on RMB, `fire {m}`; remote rockets pop visually via `onVisualProjectileHit` |
| 「사이클론」 `u_minigun` (`Minigun.ts`) | hold: spin += dt / `chargeTime` (`MINIGUN_SPINUP_TIME` 1.2 s), `weapon:chargeChanged {kind:'spinup', t}` on every change, `model.setSpin(t)` rotates the barrels; at spin 1 the regular `fire()` runs at `MINIGUN_FIRE_RATE` 24 with `MINIGUN_SPREAD_DEG`; release → spin −= dt / `MINIGUN_SPINDOWN_TIME`, `t:-1` at 0 | **hold = keep the barrels spun without firing** (no ammo, still slowed) so LMB then fires instantly | `setSpeedModifier('minigun', MINIGUN_MOVE_MUL)` while spin > 0 (reset at 0 / unequip / reset); `heavy` pose, `charging` while spinning up | standard `weapon:fired` + `fire` per shot |

**Verified** (`node scripts/smoke-uniques.mjs`, headless Chrome, 64/64): flame cone damage / fuel ~12 per s / durability −1 per s / `enemy:incinerated` + `isIncapacitated` on a charger after ~2.5 s / RMB jet alt on-off; shock arc on two warriors + 2 × `enemy:shocked` / cells ~8 per s / charge gauge rising → bolt (`altFired`, −6 cells, `weapon:hit`, `t:-1`); shuriken mag 10 → 9 → 6 / F tap = `melee:swing` / F hold → gauge 1 → 50 % stamina, `viewWiden` true → false after the swing, `player:slashed` 1+ hit, 280 dmg / refused + 스태미나 toast when short; bow `scopeChanged` zoom 1.6 / one arrow ≥ 100 dmg at 8 m; bazooka `weapon:hit` ≥ 400 / warrior + scavenger 2 m aside damaged / no self damage at 14 m / auto reload → 1; airborne + looking down + RMB → `altFired`, `player:blastJump` impulse 17, hp −22, `velocity.y` up; minigun no shot at 0.6 s / spin gauge rising / ≥ 8 shots after spin-up / gauge 1 / belt drain / `-1` after spin-down / RMB pre-spin no shots / LMB instant. 0 console errors. Regression: `smoke-weapons` 44/44, `smoke-phase2` 44/44.

**Not done / notes**: unique SFX reuse existing ids (`shot_energy` flame + arc, `melee_swing` stars / bow / slash, `shot_shotgun` rocket, `shot_rifle` minigun, `ui_click` charge / spin start) — audio can hook `weapon:beamChanged` / `weapon:chargeChanged` for loops; the flame / arc never damage the player, deployables or destructible cover (the bazooka does); remote replicas pick arc targets with their own cone test (no wire list of ids); `player:slashed` and the slash arc are local-only beyond the `melee` message; the shuriken fan uses one `fire` message with `m:1` (the receiver fans 3); the bow's string draw is faked from the recoil kick (no charge-to-draw).

## Holster outside gameplay (ship hub)
While `ctx.phase` is `hub`, `docking` or `menu` — and, since **2026-09-08**, while `ctx.player.isDowned` — the WeaponSystem is **holstered**: the attached `WeaponModel.root` is forced invisible every frame, `host.setWeaponState({hasWeapon:false, …})` poses the soldier unarmed, ADS zoom is reset to `(1,false)`, and `resetTransient()` runs on entering (grenades/projectiles/FX cleared, reload cancelled). `hub:entered` also clears transients. The 전투불능 case takes the same branch as a wielded implant (item in hand dropped, reload cancelled, neutral zoom) rather than the phase branch, so grenades / projectiles in flight are untouched; `canUseWeapons()` already refused every action while downed, but nothing hid the model, so the soldier lay there still holding a rifle. Slots and ammo are kept, so the loadout re-appears automatically when the phase returns to `deploying`/`playing` (`attachActive(false)` re-applies the zoom). Firing/reload/swap/grenade input already requires `isGameplayActive()`. `RemoteWeapons` hides a remote's model when its flags carry `IN_HUB`, `IN_POD`, `DROPPING`, `HOLDING_ITEM` or `DOWNED`, or lack `HAS_WEAPON`.

## Grenade hitch (fixed 2026-09-05)
**Root cause**: every pooled grenade carried a `THREE.PointLight` inside a group whose `visible` was toggled. A change in the number of visible lights changes every lit material's program cache key, so three.js recompiled **all** lit shaders (14 programs here) on every throw and again on every explosion — and because the old programs are released when a material switches, this repeated on every single throw (programs 35 → 49 → 63 → 77 …).
**Fix**: grenades have no light; the LED pulse and the explosion flash use the shared `FlashPool` (6 lights permanently in the scene, constant count). Plus a one-shot `warmUp` shader compile during the hellpod drop so hidden FX meshes (rings, flash sprites, grenade bodies, decals) never compile on first use. **2026-09-10**: that one-shot is **skipped whenever `ctx.shaders` exists** — core compiles the whole scene (hidden meshes included) on `world:ready` against the composer's render target and holds the frame until the driver is done. `WeaponFx.warmUp` ran with no render target bound, i.e. for the canvas (sRGB + ACES), so it compiled program variants the game never draws, and its traversal alone cost ~170 ms in the middle of the drop.
**Measured** (headless Chrome, ANGLE D3D11, 800×450, `__game.frame()` wall time; idle p50 2.6 ms, max ≤ 6 ms):

| | throw #1 | throw #2 | 2 concurrent | programs |
|---|---|---|---|---|
| before | **1064 ms** frame (throw) | **1367 ms** | **1203 ms** | 35 → 49 → 63 → 77 |
| after | 5.7 ms max | 5.5 ms max | 5.6 ms max | 64 → 64 → 64 → 64 |

(SwiftShader software GL showed the same pattern with 1.7–2.3 s stalls before, and no throw/explosion-frame spike after.) The bench script lives outside the repo (`scratchpad/grenade-bench.mjs`); it drives a single-player mission and calls `getSystem('weapons').grenades.throw()`.

## Multiplayer (WebSocket relay, host-authoritative)

Every network branch is gated on `ctx.isMultiplayer && ctx.net`; offline behaviour is byte-for-byte unchanged.

**Outbound** (`WeaponSystem`, local player only):
- `fire()` → after `weapon:fired`: `ctx.net.send({ t:'fire', w: def.id, o: muzzle, d: dir })` — one message per trigger pull (shotguns included; the receiver fans out pellets). `d` is the exact muzzle→target line for single shots, the aim centre for pellet weapons. Tuples rounded to 3 dp (`toTuple`).
- `tryReload()` → `{ t:'reload', w }` at reload start.
- `throwHeld()` / `explodeInHand()` → `{ t:'grenade', p, v, fuse }` with the same origin/velocity/fuse handed to the local `GrenadeManager` (`fuse` rounded to 2 dp; `0` + `v = 0` for a grenade that went off in the hand).

**Inbound** (`RemoteWeapons`, via NetSystem's bus events `net:remoteFired / net:remoteReloaded / net:remoteGrenade / net:remotePlayerRemoved`) — see the table row above. All of it is presentation: the existing `enemy.takeDamage` / `applyExplosion` path is untouched here; on non-host clients the enemies module forwards those to the host.

**Known limitations**
- Remote players' grenades damage the local player on every client (Phase 7) but their enemy damage still comes only from the thrower's own client via the host.
- Remote gunfire does not emit `weapon:fired`, so on the host enemies do not "hear" other players' shots (`EnemySystem.alertHearing`); wire that through `net:remoteFired` in enemies if wanted.
- Remote reload animation runs on the receiver's clock from the `reload` message (not from `PlayerFlags.RELOADING`), so a cancelled reload (swap) on the sender still plays out visually.

## Phase 3 (2026-09-06): ship calls & destructible cover
- `ctx.weapons = { getGrenades() }` (`GrenadeManager.getViews()`, pooled `GrenadeView`s: position / fuse / remote) for the HUD's off-screen indicators.
- While `ctx.stratagems.armed` or `.targeting` is set, `usable` is false: no firing, swapping, quick-use or reload — the ship call owns the mouse.
- Hits on a world obstacle call `obstacle.destructible?.onDamage(damage, point)` (hitscan via `HitInfo.obstacleRef`, projectiles via `ProjectileHit.obstacleRef`), so dropped cover structures lose hp to bullets.

## Phase 4 (2026-09-06): armour & interceptable shells
- `raycastAll` also asks `ctx.enemies.raycastInterceptable()`; when a shell is the nearest hit, `applyHit` calls `target.intercept(point)` (hitmarker, metal sparks) and deals no other damage.
- `EnemyHit.armored` (behemoth front plate): with `ARMOR_IMMUNE_AMMO` calibres the shot ricochets (`weapon:hit` with damage 0, high-pitched `hit_metal`), no `takeDamage`; heavy rounds and explosions still damage. `applyHit` takes the firing weapon's `ammoType`.

## 2026-09-06 — rebindable keys · wielded implant + weapon keys
- Every key is read live from `Keys` (`Keys.MELEE` replaced the old `KEY_MELEE`, removed 2026-09-11); nothing caches a key code. **2026-09-07 (커서 rework)**: `Keys.SWAP` (V = 이전 무기) is **retired and removed from the key table** — V is 구르기 now and Alt frees the cursor, so a weapon swap is 1 / 2 / 3 only. `quickSwapTarget()` and the `prevActive` bookkeeping went with it.
- While a **wielded implant** (대전차포) holsters the gun, pressing 1 / 2 / 3 / V now calls `ctx.implants.stow()` and draws that weapon (`requestSwap` unless it is
  already the active slot; an empty slot plays `ui_deny`). Previously the swap keys were ignored until the implant was put away with Q.
- 갈고리 / 정찰 / 오버차지 no longer holster the gun at all (instant / hold implants).

## Phase 7 (2026-09-06): remote state, replicated attachments, friendly grenade damage

Contract: `WeaponRemoteState` + `WeaponsRef.remoteState` (types), `PlayerSnapshot.h / att` + `PlayerFlags.THROWING / COOKING / CHARGING / SPRAYING / HEAVY` (net — the snapshot builder reads `ctx.weapons.remoteState`, never mutates it), `RemotePlayerRef.attachments` (net, appended).

- **`ctx.weapons.remoteState`** is one object updated in place at the end of every `update` (`updateRemoteState`): `heldItemId` = def id of the consumable / gadget in hand (`quick.defId` while `holdingItem`, else null), `throwing` = LMB wind-up with a grenade in hand, `cooking` = pin pulled, `charging / spraying / heavy` = the unique handler's pose (shock bolt charge + minigun spin-up / flame + arc / bazooka + minigun). `attachments` = socketed attachment def ids of the weapon in hand in socket-key order; recomputed only when the weapon uid in hand changes or `attachDirty` was set (`inventory:socketChanged`, `loadout:changed` with the same uid, an adopted instance in `inventory:itemUpdated`) and **replaced only when the id set differs** (`sameIds`) — holstered / consumable in hand → `[]`.
- **Remote attachments**: `RemoteWeapons.syncAttachments` applies `ref.attachments` through `attachmentVisualsFromIds` → `WeaponModel.setAttachments` when the ids differ from the ones on the model (`RemoteEntry.att`), and again after the model is rebuilt (weapon / avatar change resets `att`). The gun stays hidden while `HOLDING_ITEM` — player/ draws the held item from `h`.
- **Remote grenade damage**: visual-only replicas (`net:remoteGrenade`, including the cook-off-in-hand `fuse 0` case at the thrower's hand) now hurt the local player in `GrenadeManager.explode` with the same radius / falloff / 0.6 share as our own frags plus the distance-scaled `camera:shake`; enemies are still only damaged by the thrower's client (host-validated).
- **Training targets** (world/ Phase 7 arena): no weapons change was needed — hitscan (`raycastAll` → `HitInfo.obstacleRef`) and projectiles (`ProjectileHit.obstacleRef`) both reach `obstacle.destructible.onDamage(damage, point)` in `applyHit`, and every gate is phase-based (`isGameplayActive`, `world.ready`) so a training mission behaves like a raid for the trigger.

**Verified** (`node scripts/smoke-weapons.mjs` on a private HMR-off vite, 55/56 — the miss is another folder's in-progress `hub:entered` handler throwing `this.uploadProfileDoc is not a function`): remoteState idle → `[att_brake]` after `attachToWeapon`, same array instance across frames, new instance with both ids after a second socket, `[]` after `detachAllSockets`; T → `heldItemId grenade_frag`, LMB → `throwing`, R → `cooking`, release / 1 → clear; a visual-only replica 3 m away takes ~70 hp off the player without `grenade:exploded`. `node scripts/smoke-uniques.mjs` 71/71: `spraying` on / off with the flame, `charging` on / off with the shock bolt and the minigun spin-up, `heavy` with the bazooka.

**Not done**: the remote cook gauge (`cooked`) is not on the wire; the shuriken fan / slash arc stay local beyond `melee`; a late joiner gets the attachments on the next snapshot (no catch-up needed).

## Phase 9 (2026-09-06): 배리어 피해는 실제 명중에서만 · 화염 / 전격 킬 크레딧

Contract: `ImplantsRef.damageBarrier(owner, point, amount?)` + `raycastBarrier` as a pure query (`src/shared/implants.ts`),
`EnemyManagerRef.applyStatus(..., attacker?)` / `enemy:killed.by?` (`src/shared/types.ts`, `events.ts`).

- **Barrier damage moved to the hit.** `Blocking.raycastBlockers` gained an optional `BlockInfo` out-param that says which
  blocker won and, for a barrier, who owns it. `HitInfo.barrierOwner` (hitscan, set in `raycastAll`) and
  `ProjectileHit.barrierOwner` (swept slugs, set in `ProjectilePool.update`) carry it to `applyHit` / `onProjectileHit`,
  which call `damageBarrierAt` **once** for a shot that really stopped there — including the unique-handler path
  (a bazooka rocket bills the barrier before its own `onProjectileHit` resolves the blast). Nothing else touches shield
  durability, so `lineOfSight`, cone-target LOS filters and aim probes are pure again (before Phase 9 every speculative
  `raycastBarrier` chewed 30 hp off the shield).
- **Status kills credit the shooter.** 「인페르노」 passes `ctx.net?.localId ?? 'local'` into both
  `applyStatus('burning', …)` and `applyStatus('incinerated', …)`, and 「테슬라 코일」 does the same for `'shocked'`; enemies/
  stores it as `Enemy.burnAttacker` and fills `enemy:killed.by`, so an afterburn kill is credited to whoever lit the fire
  instead of the last damager.

## 2026-09-07: 회복 소모품 개편 (아이템별 사용 시간 · 이동 50 % · 회복 스프레이 · 제세동기 1 s)

Contract (read-only, `src/shared`): `ItemDef.heal` (`HealDef {useTime, amount, overTime, spray?}` / `SprayDef
{tick, gaugePerTick, healPerTick, radius}`), `CONSUMABLE_SLOW_MUL` (0.5) / `CONSUMABLE_SLOW_KEY` (`'consumable'`),
`DEFIB_USE_TIME_S` (1), `HEAL_SPRAY_GAUGE` / `HEAL_SPRAY_RADIUS`, `PlayerRef.applyHeal(amount, seconds, quiet?)`,
`heal:holdChanged` extended with `dur` (the item's own use time) and `spray`.

The Phase 10 회복약 hold generalised: the hold length is **per item**, not `HEAL_HOLD_S`.

- `useTimeOf(def)` (module-level): `def.heal.useTime` (붕대 5 s · 약초 붕대 5 s · 회복주사 2 s), `HEAL_HOLD_S` for a
  `stim` def without a `heal` block, `DEFIB_USE_TIME_S` for `gadgetId === 'defib'`, else 0. `updateQuickHand` routes a
  gadget with a non-zero use time through `beginHeal` too, so the 제세동기 is a 1 s hold and every other gadget is
  still an instant LMB press.
- **Movement**: `setConsumableSlow(true/false)` puts `CONSUMABLE_SLOW_MUL` on `ctx.player.setSpeedModifier` under
  `CONSUMABLE_SLOW_KEY` for the whole channel, released on finish / cancel (both paths, spray included).
- **Heal over time**: `finishHeal` calls `applyHeal(heal.amount, heal.overTime)` instead of `applyStim` (붕대 = hp 20
  spread over 5 s, 회복주사 = hp 50 over 1 s). A def without `heal` still takes the old `applyStim` path.
- **회복 스프레이** (`heal.spray`): channelled, not a fixed hold. Its gauge is the instance's `durability`
  (`durabilityMax` 100), so it survives a stash trip and draws the ordinary durability bar. Every `spray.tick` (0.1 s)
  one unit is spent through `inventory.updateItem` and `healPerTick` hp goes to the user (`applyHeal(hp, tick, quiet)`
  — quiet so 10 SFX/s do not fire) and to every squadmate inside `spray.radius`, batched into one `buff heal` per peer
  every `SPRAY_SEND_INTERVAL` (0.5 s, the wire the overcharge beam already uses). At gauge 0 the can is consumed.
- `heal:holdChanged` now carries `dur` (seconds) and `spray`; while spraying, `t` is the **remaining gauge** 0..1.
  `hud/HealGauge` labels `회복 n.n s` or `스프레이 n %` off those fields.
- Every existing cancel path (release, `usable` false, death / downed, phase change, swap, world reset) also releases
  the slow, and a spray flushes its pending ally heals first.

## Phase 10 (2026-09-07): 회복약 2 s 홀드 · H 키 폐기 · 재장전 취소 이벤트 · 들쳐메기 게이트

Contract (read-only, `src/shared`): `HEAL_HOLD_S` (2) / `HEAL_HOLD_CANCEL_ON_DAMAGE` (false),
`'heal:holdChanged' {holding, t}`, `'weapon:reloadCancelled' {weaponId}`,
`PlayerRef.carrying / dropCarried(reason)` + `CarryEndReason`.

- **H 키 폐기.** The `Keys.STIM` reader in `update` and `quickStim()` are gone. `Keys.STIM` / `DEFAULT_KEYS.STIM`
  survive in `shared/constants.ts` for append-only compatibility but **nothing in the repo reads them any more**
  (`Keybinds.KEY_ACTION_DEFS` dropped the action, so the key-settings screen no longer lists it either). 회복약 is
  reached exactly like every other consumable: `Keys.QUICK` tap / wheel.
- **회복약 = LMB 2 s 홀드.** `updateQuickHand`'s `q.kind === 'stim'` branch no longer consumes on the press; it calls
  `beginHeal(host)`, which refuses at full hp (`ui_deny`, the old rule) and otherwise sets `healHeld` and emits
  `heal:holdChanged {holding: true, t: 0}`. `updateHeal` accumulates `healT` while `MouseButtons.FIRE` is down and
  emits `{holding: true, t: healT / HEAL_HOLD_S}` **throttled to ≤ 30 Hz** (`ctx.time`-based; start / finish / cancel
  always land). At `HEAL_HOLD_S` `finishHeal` does what `useStim` did — `consumeQuick` (−1 from the bag),
  `host.applyStim(def.healAmount ?? 50)`, `quick:used {index, item, remaining}`, `QUICK_USE_COOLDOWN / useSpeedMul()`,
  and `returnToGun()` when the stack is empty — plus a final `{holding: false, t: 1}`.
  Releasing LMB cancels (`{holding: false, t: -1}`); **damage does not** (`HEAL_HOLD_CANCEL_ON_DAMAGE` is false, so
  nothing here watches for it). Cancelled from: `cancelHold` (weapon swap → `leaveQuick`, another consumable →
  `equipQuick`, control loss), `dropQuick` (holster / implant wield / world reset / abort / hub), `resetTransient`,
  the `!usable` branch of `updateQuickHand` (death, downed, menu, pod, ship call), and explicit `player:died` /
  `player:downed` / `game:phaseChanged` subscriptions so the HUD gauge can never hang.
  The hand pose is unchanged (`holdingItem`, no `throwing`) and `remoteState` gains no field — the gauge is local.
- **`weapon:reloadCancelled`.** `cancelReload()` used to be silent; it now emits `{weaponId}` whenever the phase
  really was `reloading` (all six call sites already guard on that, so this is belt-and-braces). `weaponId` is the
  active slot's `stats.weaponId`, or `''` if the slot vanished with the reload. `resetTransient` / `updateReload`'s
  no-weapon bail still set `phase = 'ready'` directly without an event — ui/ hides its crosshair ring on
  `game:abort` / `game:newMission` / `player:died` anyway.
- **들쳐메기 게이트.** `carryGate(usable)` runs once per frame right after the active weapon is resolved: while
  `ctx.player.carrying != null` (duck-typed, so an old player build is inert) **any** weapon input — LMB down or
  pressed, RMB pressed, `Keys.RELOAD` / `Keys.QUICK` / `Keys.MELEE` / `Keys.PRIMARY` / `PRIMARY2` / `SECONDARY` /
  `SWAP` — calls `ctx.player.dropCarried('action')` and the frame ends there: the returned `carryBusy` clears
  `inputFree` (swap / trigger / unique handler / gadget RMB), suppresses the melee block and is passed into
  `updateQuickKey` as `!usable`. The next frame retries naturally once the body is down. The F **tap** normally never
  reaches us — player/ pre-empts it with `input.consume(Keys.MELEE)` for the manual drop — and the 표창 용검 F-hold
  honours the same consumption for free, because `readUniqueInput().meleePressed` is `input.wasPressed` (which
  `consume` clears) and `Shuriken` only starts its hold on `meleePressed`.
- The 배리어 → `mode: 'wielded'` 방패 needed **no** change here: the holster path already reads
  `ctx.implants.blocksWeapons`, and the "weapon key stows a wielded implant" branch works for the shield unchanged.

**Verification**: `npm run typecheck` clean. New assertions in `scripts/smoke-weapons.mjs` (H does nothing → nothing
in hand; T tap → 회복약 in hand; `heal:holdChanged {t:0}` on press, rising `t`, nothing consumed at 0.6 s; release →
`t:-1`; a full 2 s hold → one `quick:used` + `player:stimUsed` + hp up + `{holding:false}`; full hp refuses to start;
a swap mid-reload → exactly one `weapon:reloadCancelled {weaponId:'ar'}`). `scripts/smoke-quickslots.mjs` needed no
change (it drives the inventory quick-slot model, never the H key or LMB).

**Known**: the heal hold has no self-cancel on movement or on a weapon-fire attempt (LMB *is* the hold, so there is
nothing to conflict with); a cancelled hold loses all progress (no partial credit); `finishHeal` consumes the item
before `applyStim`, so a stim that `applyStim` refuses in the same frame (already healing) is still spent — exactly
the pre-Phase-10 behaviour. The carry gate is a whole-frame veto rather than per-action, so pressing e.g. `2` and LMB
in the same frame drops the body once and neither action runs.

## Phase 12 (2026-09-08) — 정밀 사격 · `reportShot` · 회복 스프레이 채널 · `quick_heal`

- **정밀 사격이 왼쪽으로 쏠리던 원인 = 카메라 시차 (aim-origin lag), fixed in `player/`.** Measured, not guessed:
  standing still the shot already landed **0.000 m** from the crosshair ray at 30 m and 150 m (and the reticle sits
  exactly on the projected centre ray — 480/270 of a 960×540 canvas — so the HUD was never off-centre). The error
  only appeared while the camera was **moving**: weapons fire in `update`, the camera rig moves in `lateUpdate`, so
  `host.getAimRay()` handed out the **previous** frame's camera position together with **this** frame's look
  direction. The ray was therefore parallel-shifted sideways from the one the frame then rendered, by up to
  **0.42 m** (60 px flick; 0.09 m at 15 px, 0.22 m at 30 px, ~0.036 m during the ADS pull-in as the shoulder slides
  0.55 → 0.35) — a *constant* miss in metres at **every** range, which is exactly how a scope reads it (0.4 m at
  150 m ≈ 24 px at the 4× scope's 17.5° FOV). `player/CameraRig.predictPosition()` + one line in `PlayerSystem`
  converge the origin on the camera the frame will actually render; nothing here changed. The tracer still starts at
  the muzzle (`_muzzle`) — only the damage ray is camera-converged, as before.
- **`ctx.enemies.reportShot(origin, dir, range, hit)` after every local shot** (enemies/ does the AI reaction):
  - hitscan `fire()` — **once per trigger pull** (a shotgun's 8 pellets are one report), after the pellet loop, with
    the aim ray and the last pellet's impact point (`null` when nothing was hit within `def.range`);
  - unique hitscan (`hitscan()` in the unique services) — once per shot, same shape;
  - projectiles — `ProjectilePool.fire()` reports the launch (`hit: null`) and `onProjectileHit` reports the impact
    (origin back-projected from the impact along the flight direction). `visualOnly` replicas report nothing.
  - `RemoteWeapons` reports **nothing**: the shooter's own client owns its reports (no double-reporting).
  - `ctx.enemies` is optional-chained everywhere (hub / training / an early frame have no manager).
- **회복 스프레이: the can is never consumed.** At gauge 0 the instance stays in the quick slot / bag with
  `durability` 0 (the ship repairs it — inventory/); the channel just refuses to start (`ui:notify`
  `스프레이가 비었습니다`, throttled by `BROKEN_NOTIFY_INTERVAL`) or stops with the same toast. `finishHeal` now
  bails to the new `stopSpray()` for a spray, so the `consumeQuick` path is unreachable for it.
- **`item:channelChanged {uid, defId, active, gauge}`** (ui/ ticker): `active:true` when the channel starts,
  ≤ `CHANNEL_EMIT_HZ` (10) while it runs, `active:false` on **every** end — release, empty, swap / holster, wielded
  implant, death, 전투불능, phase change, a screen taking `usable` away, world reset. `gauge` is always 0..1 (the
  instance's `durability / durabilityMax`, clamped). All those paths funnel through `cancelHeal → stopSpray`, and
  `update()` carries a backstop that closes a ticker whose channel is no longer running, so `active:false` is always
  the last event for a uid. `heal:holdChanged` is unchanged (the HUD ring still reads `{t, dur, spray}`).
- **Perk `quick_heal`** (`derived.perks.quick_heal`): the new `holdTimeOf(def)` = `useTimeOf(def) × 0.5`, used by
  every hold-to-use path (회복 소모품 and the 제세동기's `DEFIB_USE_TIME_S`), and the halved value is what goes out
  as `heal:holdChanged.dur`, so the crosshair ring needs no change. The 스프레이 has no hold, so it is unaffected.

**Verification**: `npm run typecheck` 0; `smoke-weapons` 137/137, `smoke-phase2` 53/53, `smoke-uniques` 71/71,
`smoke-ghost` 86/86 (private vite on 5305). New assertions: SR ADS accuracy at ~30 m and ~140 m (impact within a few
cm of the crosshair ray, lateral 0.000 m), one `reportShot` per SR shot whose hit equals `weapon:hit`, no report from
a replayed remote shot, two reports per local projectile and none for a visual-only one, the spray gauge 200 /
drained-to-0 can staying in the bag and the slot, the `item:channelChanged` true→false sequence (including a
전투불능 mid-channel) with every gauge in 0..1, a refused restart on an empty can, and `quick_heal` halving the
회복주사 hold to `dur = 1`.

**Known**: `reportShot` for a shotgun is one report on the aim ray, so a pellet that flew wide is not reported
separately; a hitscan shot that hits nothing reports `hit: null` with the full `def.range` (enemies/ decides what to
do with the miss); a projectile that is still in flight when the mission ends never sends its impact report. The
spray's empty toast is throttled per `BROKEN_NOTIFY_INTERVAL`, so holding LMB on an empty can toasts about twice a
second at most but plays `ui_deny` every press. `quick_heal` halves the *hold*, not the heal-over-time (`overTime`
still runs at the item's own rate).


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`WeaponSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체). 상태도 클래스 참조도 없다.
   `WeaponSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function applyDamage(sys: WeaponSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 `ctx.*` 를 통한 호출부와
   폴더 안의 `this.foo()` 호출은 **하나도 바뀌지 않았다.**
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   접근 범위는 여전히 이 폴더이고, 외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

`parts/` 에 새 파일을 만들 때는 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고
위 표에 행을 추가한다. 순환 import 를 만들지 않으려면 `parts/` 는 `WeaponSystem.ts` 에서 **타입만**
가져와야 한다(`import type { WeaponSystem }`) — 값이 필요하면 `model.ts` 로 옮긴다.

---

## 변경 이력

- **2026-09-12 (전투 소모품 3종 — 에이전트 A1)** — 아드레날린 주사 · 각성제 · 안정제(`@/items` 의 `boostItemOf`)가 회복약과 같은
  **퀵 사용 홀드** 길을 탄다 — 사용 중 이동 50 % · LMB 떼면 취소 · 소모 시점이 같다. `model.useTimeOf` 가 `boostUseTime`(3 초)을
  돌려주고(퍽 `quick_heal` 이 반으로 줄이는 것도 같다), `parts/Healing.beginHeal` 은 이 셋에 **"체력 가득이면 거절" 을 걸지 않는다**
  (안정제는 임플란트가 가득이어도 소모 — 사용자 결정). `finishHeal` 은 소모 뒤 `adrenaline` · `stimulant` 면
  `ctx.player.applyBoost(kind, defId)`, `implant_refill` 이면 `ctx.implants.refillAll()`(둘 다 선택 호출) + `stim` 소리.
  `parts/Firing.reloadSpeedFor` 가 숙련 배수에 `ctx.player.boostReloadSpeedMul`(각성제 1.3)을 곱한다 — 장전 시작 때 읽는다.
  정조준 전환 배수는 player 가 ADS 블렌드에서 곱한다. 검사: `scripts/smoke-consumables.mjs`.

- **2026-09-12 (조준 흔들림 — 에이전트 A2, 사용자 결정)** — 새 `AimSway.ts`: `data/aim_sway.csv`(계열 6줄 — 좌우 진폭 ° · 빈도 Hz)를 읽어
  `aimSwayOfClass(cls)` · `aimSwayFor(stats)`(null = 흔들림 없음)를 낸다 (`scripts/data-owners.mjs` 의 `DATA_OWNERS` · `CSV_FOLDERS` 에 등록).
  `parts/Firing.applyAimZoom` 이 줌 옆에서 **매번** `host.setAimSway?.(amplitudeDeg, frequencyHz)` 를 부른다 (두 숫자라 중복 제거 캐시 없음 —
  player 쪽이 변화를 감쇠한다). 그래서 장착 · 교체 · 넣기(`applyAimZoom(null)`) · 손에 든 소모품 · RMB 대체 사격 유니크(`zoomStatsFor` null)가
  모두 같은 길로 0 / 계열 값이 된다. 흔들림 자체(8자 · 정조준 · 자세 · 이동 · `aimSwayMul`)는 player 의 `CameraRig` 가 돌리고
  `getAimRay` 가 그 오프셋을 포함하므로 `parts/AimLine` · 빨간 원 · 퍼짐 계산은 한 줄도 안 바뀌었다. 검증: `scripts/smoke-aim-sway.mjs`.

- **2026-09-12 (하이브리드 사격 판정 · 총구 막힘 표시 — 사용자 결정)** — 지향사격 · 정조준에서 "거리에 따라 가끔 크로스헤어보다
  왼쪽으로" 날아가던 것. 모든 사격이 모델 총구에서 나가 카메라 레이가 맞춘 점으로 수렴했는데, 카메라 레이가 아무것도 못 맞히면
  수렴점이 사거리 끝이라 중간 거리에서 탄이 크로스헤어 선보다 ~0.3 m 옆을 지나 조준하지 않은 것에 맞았고, 크로스헤어 선은
  비켜 가는 먼 가장자리에도 총구 선만 걸렸다. 다른 3인칭 슈터들이 쓰는 해법(카메라 선 판정 + 총구 앞 짧은 막힘 검사 + 막힌 자리
  표시 — Outriders 의 보조 레티클, Helldivers 2 의 총열 조준 원)을 따라 **판정은 크로스헤어 선, 총구는 앞 `WEAPON_MUZZLE_BLOCK_RANGE`
  (3 m, 사용자 결정)에서만 막는다** (`parts/AimLine`). 막히면 벽에 빨간 원(`fx/AimBlockMarker`)이 뜨고 `weapon:aimBlocked` 로
  크로스헤어가 빨갛게 바뀐다 (ui). 2026-09-08 의 "스코프 조준 중에만 조준선에서 쏜다" 는 이제 일반 규칙이라 그 특례
  (`_shotO`)는 걷어냈다. **발사체도 같다** (사용자 결정): `fire()` 의 발사체와 유니크 `aimShot`(표창 · 바주카)이 막히지 않았으면
  크로스헤어 선의 총구 깊이 점에서 나간다 — 지향사격에서는 총구보다 약 0.3–0.5 m 옆에서 보인다. 원격 복제는 그대로
  (`fire` 메시지의 `o` 는 실제 총구, `d` 는 총구 → 이번 탄의 끝). 검사: `scripts/smoke-weapons.mjs` 의 `하이브리드 사격 판정` 절.

- **2026-09-11 (C-62 — 근접은 적의 몸통 히트박스를 본다)** — `Melee.inConeEnemy`: 적이 `EnemyRef.nearestBodyPoint` 를 가지면
  그 점(히트스캔과 같은 몸통 캡슐 — 엎드린 로든은 눕힌 캡슐)을 타격 지점으로 삼고 **그 표면에서 `MELEE_RANGE`** 안 · 그 점 방향이
  원뿔 안이면 맞는다. 없으면 예전 `inCone`(발 + 키 절반 중심, `MELEE_RANGE + radius`). 구 모양 몸에서는 두 식이 같다 — 서서 휘두를
  때 몸 축에서의 최대 수평 사거리(옛 → 새, m): scavenger 2.63 → 2.63 · warrior 3.11 → 3.11 · charger 3.68 → 3.69 · rogue 2.72 → 2.80 ·
  behemoth 4.80 → 4.72 (엎드린 플레이어는 4.71 → 4.39 — 몸 구 중심이 옛 1.4 m 상한 대신 2.4 m). 엎드린 로든은 사방 2.72 에서 발 쪽
  3.08 · 머리 쪽 2.84 · 옆 2.31 로 보이는 몸을 따른다. 설치물 판정은 그대로. 검사: `scripts/smoke-named.mjs` C-62 절.

- **2026-09-11 (E-4 — 스프레이는 벽 너머로 치유하지 않는다)** — `parts/Healing.sprayAllies` 가 반경 안 분대원마다 내 가슴 →
  그 가슴(발 + 1.15 m)을 `shared/buffLineClear`(`world.raycast`)로 보고, 막혀 있으면 그 사람 몫을 적지 않는다. 받는 쪽 상한
  (보낸 사람 · 사거리 · 초당 치유 버킷)은 `implants/parts/Wire.onBuff` 의 `BuffGuard` 가 맡는다. 검사: `scripts/smoke-trust.mjs`.

- **2026-09-11 (손에 든 C4 · 기폭기 · 드론 조종기 · 조종 중 정지)** — 계약: `GadgetsRef.detonateRemoteMines` ·
  `liveRemoteMineCount`, `GadgetUseKind 'drone'`, `PlayerRef.droneControl`. 전부 `parts/QuickUse.ts` + `WeaponSystem`
  의 필드 · 게이트 몇 줄이다.
  - **C4 우클릭 = 기폭.** `remoteMine` 을 든 손에서 RMB 는 오버/언더 토글 대신 `detonateHeld` → `ctx.gadgets.detonateRemoteMines()`
    (0 개면 `ui_deny`, 성공하면 `QUICK_USE_COOLDOWN` · 아주 작은 반동 · `ui_click`).
  - **기폭기 손 (가상 상태).** 마지막 C4 를 설치해 슬롯 스택이 0 이 되면 `returnToGun` 대신 `equipDetonator` —
    `QuickHand.detonator = true`, `index −1`, `item` = **`qty: 0` 합성 인스턴스** (`uid = 'detonator:' + defId`,
    인벤토리 uid 와 겹치지 않는다). 알림은 **`quick:equipped {index: null, item}`** 이다: 기존 의미(`index` = 퀵슬롯
    번호, `item: null` = 총으로 복귀)를 깨지 않고 "슬롯에 묶이지 않은 손" 을 뜻한다 — net 의 `holdingItem` 은
    `item !== null` 이라 켜진 채이고 `remoteState.heldItemId` 는 C4 def id 로 남는다. 새 필드 `remoteState.detonator`
    (타입 밖의 덕 타이핑 필드)가 기폭기 손이면 true — **설치 미리보기는 이 값이 true 면 띄우지 않아야 한다.**
    LMB = `ui_deny` + `원격 지뢰 없음`(`BROKEN_NOTIFY_INTERVAL` 스로틀), RMB = 기폭, 무기 키 · T 탭 · 휠은 평소대로
    떠난다. `inventory:quickSlotsChanged` 는 기폭기를 튕겨내지 않는다. `liveRemoteMineCount()` 가 0 이 되면 총으로
    돌아가되, 설치 직후 `DETONATOR_CONFIRM_GRACE_S`(2 s — 밸런스가 아니라 비호스트 `gadq` 확정 여유, 한 번이라도
    1 이상이 세어지면 즉시 끝난다) 동안과 드론 조종 중에는 기다린다.
  - **T 탭.** 쓸 수 있는 슬롯이 없고 월드에 내 C4 가 있으면 기폭기를 다시 잡는다. 슬롯에 C4 가 남아 있으면 그 슬롯이
    우선이다. 추가로 **마지막으로 쓴 것이 C4 · 기폭기였고 그 슬롯이 비었으면** (`lastQuickDetonator`) 다른 소모품보다
    기폭기를 먼저 잡는다 — "탭 = 마지막으로 쓴 것" 규칙의 연장이다. 기폭기를 든 채 탭하고 고를 슬롯이 없으면 총으로.
  - **드론 조종기 손.** `droneGround` / `droneAir` 의 LMB 는 `gadgets.use` 가 true 를 돌려주고 스택을 그대로 두므로
    `adoptSlot` 이 성공해 손에 남는다. RMB 는 무시, **R 은 무기 쪽 어디서도 읽지 않고 `consume` 도 하지 않는다**
    (드론 코어의 R 홀드). 들쳐메기 게이트도 드론 조종기 손에서는 R 을 행동으로 세지 않는다.
  - **조종 중 정지.** `droneLatch` = `ctx.player.droneControl` 인 동안 + 끝난 뒤 LMB · RMB · R 을 모두 뗄 때까지.
    `armedAndFree` 에 `!droneLatch` 를 넣어 `canUseWeapons()` 에 기대지 않고도 사격 · 재장전 · 무기 교체 · 근접 ·
    T(열린 휠은 닫힌다) · 유니크 입력 · 투척 궤적이 전부 멈춘다. 쥔 수류탄은 기존 `!usable` 규칙(핀을 뽑았으면 발밑에
    떨어뜨림)을 탄다. 손에 든 것은 건드리지 않으므로 조종이 끝나면 그대로다.
- **2026-09-11 (투척 궤적 50 % · 창문 · 바닥)** — `fx/ThrowArc` 가 실제 비행의 앞쪽 `THROW_ARC_PREVIEW_FRACTION` 만 그리고
  착지 고리를 감춘다. `Grenade` 는 창문 유리를 깨고(`shared/fragile`) 건물 바닥판에 떨어진다 (`getSurfaceY`).
- **2026-09-10 (실드 충전기)** — 방탄복이 실드를 주게 되면서 그 실드를 채우는 소모품 3종이 붙었다
  (`shield_charger` / `_hi` / `_full`, `data/items.csv`). 정의는 items/ 가 갖고 (`SHIELD_CHARGE_MAP` ·
  `shieldChargeOf`) 여기서는 **퀵 사용 경로만** 갈라진다: `model.useTimeOf` 가 충전기의 자기 사용 시간(2 / 4 / 6 초)을
  돌려주고, `parts/Healing.beginHeal` 이 `canChargeShield()` 로 먼저 거른 뒤 `finishHeal` 이 소모 후
  `ctx.player.chargeShield(amount)` 를 부른다. 카테고리가 `stim` 이라 퀵슬롯 · 손에 든 모습 · `q.kind` 분기는
  전부 그대로다. 같이: `unique/Bazooka.ts` 의 자폭 피해가 `BAZOOKA_SELF_DAMAGE / (1 - damageReduction)` →
  **`BAZOOKA_SELF_DAMAGE` 그대로** (방탄복이 피해를 깎지 않으므로 되돌릴 감쇄가 없다 — 대신 실드가 맞아 준다).

- **2026-09-10 (보조무기 제거)** — `WEAPON_SLOTS` 가 `['primary','primary2']` 둘뿐이다. `WeaponSystem` 의
  1 · 2 키만 칸을 가리키고 **`Keys.SECONDARY`(3)는 아무도 읽지 않는다** (바인딩 · `Keys.SECONDARY` 상수는 계약이라
  남아 있고 설정 목록에서만 빠졌다). 로드아웃이 끝내 오지 않을 때의 대비책도 주무기 한 정이다.
  `slots` 레코드에는 `WeaponSlot` 타입 때문에 `secondary` 키가 남지만 언제나 null 이고, `DEFAULT_PISTOL` ·
  `statsFromDef` 의 `secondary` 가지는 (권총 계열 유니크가 생길 때를 위해) 그대로 뒀다.

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (투척 상수 csv 이관)** — `model.ts` 의 `GRENADE_THROW_SPEED`(17) · `GRENADE_THROW_LIFT`(3.5) ·
  `GRENADE_UNDERHAND_LIFT`(1.2) 가 `data/constants.csv` → `@/shared` 로 옮겨졌고 `model.ts` 는 re-export 만 한다 —
  `progression/derive` 가 같은 수치로 투척 사거리를 m 로 계산해 캐릭터 시트에 보여 주기 위해서다. `parts/Throwing` 의
  호출부는 그대로다. 근력 배율(`derived.throwRangeMul`) 자체의 기울기는 progression README 참조.
- **2026-09-08 (스코프 탄도)** — `parts/Firing.fire` 가 **스코프 조준 중에는 조준선에서 쏜다**. 모든 사격은
  모델 총구에서 나가 카메라 레이가 맞춘 점으로 수렴하는데, 3인칭 총구는 카메라보다 ~0.15 m **왼쪽** · ~1 m 앞이라
  총구에서 본 각도로 ~8° 왼쪽이다 — 저격 거리에서 예광탄이 비행 내내 조준선 왼쪽을 지나고, 카메라 레이가 아무것도
  못 맞힌 사격은 표적 왼쪽에 꽂혔다. `WeaponDef.scope` 무기를 조준 중이면 병사 모델이 어차피 숨겨져 있으므로
  (`PlayerSystem.scopeHidden`) 발사점을 **조준 레이 위**로 옮긴다 — 총구를 그 레이에 정사영(전방 거리는 그대로).
  머즐 플래시 · 발사음 · 원격 `fire` 메시지는 실제 총구를 그대로 쓴다(남들이 보는 건 그쪽이다). 허리 사격과
  비스코프 ADS 는 손대지 않았다 (그쪽은 총이 화면에 있다).

- **tactical kit** — **F melee** (`Melee.ts`, `MELEE_DAMAGE × meleeMul × derived.meleeDamageMul`, `melee` net message), **V** = previous weapon, weapon keys while a wielded implant is in hand → `ctx.implants.stow()` + swap (2026-09-06 fix), **H** = stim into the hand, **T** = quick use (tap / hold wheel), gadgets in the quick wheel (LMB → `ctx.gadgets.use`, RMB toggles over/under-hand), holster while `ctx.implants.blocksWeapons`, shots stop at barriers / dome hulls (`Blocking.ts`), 사격 skill recoil / reload multipliers, overcharge fire rate

- **Phase 6** — `unique/` handlers (`createUniqueHandler` by `WeaponDef.unique`) — 화염방사기 cone / jet + per-enemy heat → `applyStatus('incinerated')`, 전격총 chain arc (`SHOCK_MAX_TARGETS`, shocked) + RMB charged bolt, 표창 1 / 3 stars + **F hold → 용검** (`consumeStamina` 50 %, `setViewWiden`, `startMelee('heavy')`, `player:slashed`), 컴포짓 보우 (only unique with ADS), 바주카 impact / air-burst rockets with self damage + knockback + rocket jump (`player:blastJump`), 미니건 spin-up (RMB pre-spin, `setSpeedModifier('minigun')`); `UniqueFx.ts` pooled cones / `LineSegments` arcs (no lights), `Projectile.ts` styles (shuriken / arrow / rocket, fuse, tag), six procedural models in `WeaponModel.ts`, `fire {m, c}` replication in `RemoteWeapons`

- **Phase 7** — `ctx.weapons.remoteState` (held item, throwing / cooking / charging / spraying / heavy, attachments — `Attachments.ts`), `RemoteWeapons` applies the snapshot's `att` to the replica gun, replica grenades damage the **local** player (`Grenade.ts`), training targets are hit through the destructible-obstacle path

- **Phase 9** — a barrier only takes damage at a **real** projectile hit (`Blocking.damageBarrierAt` → `ctx.implants.damageBarrier`; `WeaponHost.lineOfSight` and every per-tick cone query are now free), 화염방사기 / 전격총 pass the attacker into `applyStatus` so a burn kill credits the shooter

- **Phase 10** — **H retired** (`Keys.STIM` has no reader left; 스팀 is 회복약, a quick-use item), 회복약 = **LMB held for `HEAL_HOLD_S`** (2 s) with `heal:holdChanged {holding, t}` at ≤ 30 Hz — damage does not cancel it, full hp refuses it — replacing the instant `useStim`, **`weapon:reloadCancelled`** emitted from `cancelReload()` (it was silent, so a crosshair ring had no way to close), and a whole-frame `carryGate` that turns fire / melee / swap / throw / quick use / reload into `ctx.player.dropCarried('action')` while carrying

- **2026-09-07 (회복 소모품)** — 홀드 시간이 **아이템별**(`useTimeOf` — `ItemDef.heal.useTime`, 제세동기는 `DEFIB_USE_TIME_S`), 사용 중 `CONSUMABLE_SLOW_MUL` 이동 감속, 완료 시 `applyHeal(amount, overTime)` 로 지속 회복, **회복 스프레이**는 인스턴스 `durability` 게이지를 0.1초마다 깎으며 자신 + 반경 내 아군(`buff heal`, 0.5초 배치)을 회복

- **Phase 12 (2026-09-08)** — `ctx.enemies.reportShot` 를 **모든 로컬 사격** 뒤에 호출(히트스캔은 트리거당 1회, 유니크 히트스캔, 발사체는 발사 + 착탄; 원격 재생은 호출하지 않는다), 회복 스프레이는 게이지 0 에서도 **소모되지 않고** 남으며(`스프레이가 비었습니다` 거부) 시작 · ≤10 Hz · **모든 종료 경로**에서 `item:channelChanged {uid, defId, active, gauge 0..1}`, 퍽 `quick_heal` 이 `holdTimeOf()` 로 모든 홀드 사용 시간(제세동기 포함)을 ×0.5 하고 그 값이 `heal:holdChanged.dur` 로 나간다
