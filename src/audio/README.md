# src/audio — Procedural WebAudio (`AudioSystem`)

All sound is synthesized at runtime (oscillators, noise buffers, envelopes, biquad filters) — no audio files.
The `AudioContext` is created/resumed on the first pointer/key gesture. Graph: voice → optional `PannerNode`
→ sfx bus / ambient bus → `DynamicsCompressor` (limiter) → master gain → destination.

Import via `@/audio` → `AudioSystem`, `Synth`, `SOUNDS`, `SOUND_IDS`.

| File | Purpose |
|---|---|
| `AudioSystem.ts` | `GameSystem` (`name: 'audio'`). Plays `audio:play {id, position?, volume?, pitch?}` (positional → equal-power panner, inverse distance, listener follows `ctx.camera` each frame). Auto-hooks events whose owners do not send audio themselves (see below). Dedupe: the same id from an explicit `audio:play` and an auto-hook within 100 ms plays once. Rate limit: max 8 identical ids per 100 ms. Ambience: wind/planet drone (looped noise → LFO-swept lowpass + 42 Hz sub), tension pulse during `extracting`/`shipLanded` (tremolo rate rises as the countdown runs out), ship engine hum while the ship is present (fades 8 s after liftoff), **ship-interior hum + ventilation** while in the hub (see below), **창문 워프 drive hum** following `hub:warpProgress.speed` (2026-09-09, see below). Master ducks to 25 % while paused. **Phase 8**: implements `AudioRef` and publishes `ctx.audio` (volume settings, see below). |
| `Synth.ts` | `Synth` primitives (`tone()`, `noise()`, `envelope()`, `click()` metallic transient, `tail()` staggered reverberant noise) and the `SOUNDS` library: `Record<id, (synth, dest, t0, pitch) => duration>`. |
| `index.ts` | Barrel. |

## 볼륨 설정 — `ctx.audio` (`AudioRef`, Phase 8)
`AudioSystem` assigns `ctx.audio = this` in `init` (and nulls it in `dispose`), so `ui/menus/SettingsMenu` drives the
sliders without importing this folder.

| Member | Behaviour |
|---|---|
| `settings` | `Readonly<AudioSettings>` — `{ master, sfx }`, both 0 … 1. Loaded in `init()` from `localStorage[AUDIO_STORAGE_KEY]` (`{v:1, master, sfx}`, clamped, corrupt/blocked storage → `AUDIO_DEFAULT_MASTER` 0.8 / `AUDIO_DEFAULT_SFX` 1) **before** the graph is built, so the very first gains are already the player's. |
| `setVolume(channel, value)` | Clamps to 0…1, ignores an unchanged value, ramps the matching GainNode immediately (`setTargetAtTime`, 0.03 s), saves debounced (250 ms; also flushed in `dispose`) and emits `audio:volumeChanged {channel, value}`. Works before the `AudioContext` exists (the value is applied when the graph is created). |
| `preview(channel)` | `master` → `ui_click` @0.8, `sfx` → `shot_pistol` @0.7 (both through the sfx bus). Calls `ensureContext()` first (the slider click is a valid unlock gesture) and is throttled to one blip per 140 ms so dragging does not machine-gun. |

- **Routing**: `sfxBus.gain = settings.sfx`, `master.gain = settings.master × (paused ? 0.25 : 1)`. The `game:paused`
  duck now only flips a `ducked` flag and re-applies (0.1 s ramp), so it composes with a mid-pause slider change.
- **Ambience** (`ambBus`) is deliberately *not* on the sfx slider — it goes straight to the limiter → master, i.e. it
  follows 전체 only. There is no BGM and no ambience slider.
- `masterVolume` survives as a read-only alias of `settings.master` for readability inside this folder.

## Sound ids (`SOUNDS`)
Weapons: `shot_rifle` `shot_pistol` `shot_shotgun` `shot_energy` `shot_smg` `shot_sniper` `bolt_cycle` `dry_fire` `reload_start` `reload_end` `hit_flesh` `hit_terrain` `grenade_throw` `grenade_bounce` `explosion`
World/UI: `crate_open` `interact` `ui_pickup` `ui_drop` `ui_rotate` `ui_error` `ui_deny` `ui_equip` `ui_click` `ui_open` `ui_close` `ping` `map_open` `map_close` `scope_in` `scope_out` `mission_complete`
Player: `stim` `player_hurt` `player_death` `footstep` `ladder_step` `player_land` `player_jump` `dive` `stamina_depleted` `stance_change` `hellpod_fall` `hellpod_impact` `hellpod_open`
World (structures): `glass_break`
Bugs: `bug_screech` `bug_attack` `bug_death` `bug_step` `bug_hit` `acid_splash` `wave_alarm`
로그 강하: `rogue_drop_alarm` `rogue_pod_fall` `rogue_pod_impact`
Extraction: `extract_activate` `countdown_beep` `ship_approach` `ship_land` `ship_liftoff` `door_close`
Ship hub: `hub_dock_thrusters` `hub_dock_clamp` `pod_door` `launch_rumble`
Chat: `chat_blip` `chat_request` `chat_open` `chat_close`
Pings v2: `ping_attack` `ping_caution` `ping_item`
Pickups: `item_toss` `pickup_land` `pickup_chime` `pickup` (alias of `pickup_chime`, the id `pickups/` sends)
Net: `net_warning` `net_resumed` `net_matched`
Tactical kit — melee/movement: `melee_swing` `melee_hit` `roll` `jumppad`
Tactical kit — implants: `grapple_fire` `grapple_attach` `grapple_release` `dash` `barrier_deploy` `barrier_hit` `barrier_break` `overcharge_beam` `scan_pulse` `rocket_fire` `rocket_explode`
Tactical kit — gadgets: `gadget_place` `dome_deploy` `smoke_hiss` `lure_beep` `mine_arm` `mine_explode` `fire_ignite` `turret_shot` `gadget_break` `defib`
Tactical kit — survival: `downed` `revive` `grit_save` `cloak_on` `cloak_off`
Tactical kit — upkeep/progression: `gather` `craft_start` `craft_done` `repair_done` `durability_break` `level_up` `skill_up`

Notes on the newer ids:
- `shot_smg` — snappy, lighter than `shot_rifle`, ~0.09 s tail (built for ~14 rounds/s).
- `shot_sniper` — sharp transient + sub boom + ~0.8 s darkening reverb tail (`Synth.tail`); louder than the rifle.
- `bolt_cycle` — two-click metallic bolt action (~0.36 s): bolt back at 0 s, bolt forward/lock at 0.27 s.
- `ping` — two-tone chirp; positional when a position is given. Pitch per kind: enemy 1.35 (urgent), ground 1, crate 0.92, extraction 0.8.
- `dive` — 0.4 s cloth whoosh only; the landing thud is the separate `player_land` the player system emits.
- `stance_change` — cloth/gear rustle; pitch 1.05 stand, 0.9 crouch, 0.72 prone.
- `hub_dock_thrusters` — 2.6 s thruster swell (noise opening up + saw/sine rumble). `hub_dock_clamp` — metallic clamp thunk (sub impact + ringing plate + rattles).
- `pod_door` — pneumatic hiss then lock clunk (~0.65 s); pitch 0.9 when the pod empties. `launch_rumble` — sub thump + 2.4 s rising roar.
- `ping_attack` — urgent two-tone rising figure ×2; `ping_caution` — descending warning with low undertone; `ping_item` — light glassy bell.
- `chat_blip` — soft two-note blip; `chat_request` — two radio tones + held note with faint static; `chat_open`/`chat_close` — 35 ms ticks (rising / falling).
- `item_toss` — 0.28 s whoosh; `pickup_land` — soft tick (positional, low volume); `pickup_chime` — G5-D6-G6.
- `net_warning` — low square+sine tone (~0.45 s); `net_resumed` — two-note confirmation; `net_matched` — static burst → three rising blips → held note.

Tactical-kit ids in detail:
- `melee_swing` — 0.24 s air whoosh (bandpass sweep up), slight random pitch. `melee_hit` — thud (150 → 48 Hz sine) + lowpassed noise + metallic click; callers pass the hit point so it is positional, volume 1 / pitch 0.85 on a kill. **`weapons/` sends these ids itself** when it resolves the swing; the auto-hooks on `melee:swing` / `melee:hit` are deduped against it.
- `roll` — cloth tumble with two ground contacts (0.5 s). `jumppad` — 180 → 1200 Hz spring + air pop.
- `grapple_fire` — pneumatic thump + 0.35 s wire zip; `grapple_attach` — clank + latch + ring; `grapple_release` — servo whir (also reused as the barrier fold-away).
- `dash` — saw sweep 260 → 1500 Hz + highpass air. `barrier_deploy` — clack then an energy field settling; `barrier_hit` — bright 1.5 kHz ping + splash (positional); `barrier_break` — descending shatter with debris clicks.
- `overcharge_beam` — 1 s shimmering tremolo tone (played once when the beam locks on). `scan_pulse` — sonar ping with a long ring; pitch rises 6 % per pulse index.
- `rocket_fire` — heavy back-blast; `rocket_explode` — bigger/longer than `explosion` with a `Synth.tail` reverb.
- `gadget_place` — bolt-down clunk + servo (turret / barricade / jump pad); `dome_deploy` — airy swell; `smoke_hiss` — 1.7 s pressurised hiss; `lure_beep` — three beeps; `mine_arm` — two rising beeps + lock click; `mine_explode` — tight sharp blast; `fire_ignite` — fuel whoomph + six random crackles; `turret_shot` — compact mechanical shot (the turret sends this itself); `gadget_break` — metal crunch + debris; `defib` — capacitor whine then discharge thump.
- `downed` — falling groan + two heartbeats; `revive` — warm four-note rising chord; `grit_save` — heartbeat + defiant rise; `cloak_on` / `cloak_off` — phasing shimmer down / up.
- `gather` — leafy rustle + snap; `craft_start` — three workbench clicks; `craft_done` — clink + two-note confirm; `repair_done` — two clinks + rising confirm; `durability_break` — metal snap + rattle; `level_up` — five-note fanfare (1.3 s); `skill_up` — quiet two-note chime.

## 발소리 — 로컬 · 원격 (2026-09-10)

`player:footstep` (본인) 과 `remote:footstep {position, sprinting, peerId}` (원격 분대원, `player/RemotePlayerSystem`
이 아바타의 보행 위상에서 낸다) 이 **한 경로**(`AudioSystem.footstep`)로 모여 같은 `footstep` 신디를 쓴다.

| | 본인 | 원격 분대원 |
|---|---|---|
| 위치 | **주지 않는다** — 패너를 타지 않으므로 **늘 같은 크기** (감쇠 대상이 아니다) | 준다. 패너는 **방향만** (`play(..., panOnly)` → `distanceModel 'linear'`, `rolloffFactor 0`) |
| 거리 | — | `d ≥ FOOTSTEP_AUDIBLE_RANGE` (26 m) 면 **재생조차 하지 않고**, 안쪽은 `(1 − d/range) ^ FOOTSTEP_FALLOFF_EXP` (1.6) 를 곱한다. 밑값 `× FOOTSTEP_REMOTE_GAIN` (1.7) |
| 크기 | 자세별: `FOOTSTEP_VOL_SPRINT` 0.5 > `_WALK` 0.32 > `_CROUCH` 0.2 > `_PRONE` 0.12 | 같은 표 |
| 자세 출처 | `ctx.player.stance` | `ctx.net.getRemotePlayer(peerId)?.stance` (이벤트 계약에는 자세가 없다 — 계약은 **추가만** 한다는 규칙대로 두고 `ctx` 로 질의한다). 모르면 걷기/달리기만 구분 |

- **왜 패너의 감쇠를 끄나**: 기본 경로의 `distanceModel 'inverse'` 를 그대로 두면 우리 곡선과 **두 번** 곱해져
  20 m 짜리 발소리가 사실상 무음이 된다. `panOnly` 는 "감쇠는 호출부가 이미 계산했다" 는 뜻이다.
- **함선 안에서도 들린다.** 페이즈로 막지 않으므로 개인 · 공유 함선에서 걸어 다니는 분대원의 발소리가 그대로
  난다. 갑판은 금속이라 톤만 조금 높다 (`FOOTSTEP_PITCH_DECK` 1.16 — 피치는 "소리 그 자체"라 코드에 둔다).
- 사거리 밖은 아예 보이스를 만들지 않고, `FOOTSTEP_MIN_VOLUME` (0.012) 밑도 버린다. 그 위로는 기존
  `RATE_MAX_SAME` (같은 id 8회/100 ms) 가 상한이다 — 4인 분대가 전부 달려도 초당 ~10회라 걸리지 않는다.
- 예전 `play()` 의 **160 m 하드 컷**에서 `footstep` 은 빠졌다 (`bug_step` · `hit_terrain` 만 남았다) —
  발소리는 그보다 훨씬 짧은 자기 사거리를 갖는다.

## 로그 강하 경보 — 인지력을 보지 않는다 (2026-09-10)

전진기지 · 연구실을 조사해 **로그 강하**(`enemies/RogueDrop`)가 트리거되면 조용히 일어나면 안 된다.
`AudioSystem` 이 `rogueDrop:incoming` / `rogueDrop:landed` 를 직접 받아 **소리 두 개**를 낸다 (세 번째인
착지 충격음 `rogue_pod_impact` 만 포드 위치가 필요해 `enemies/RogueDrop.impactFx` 가 낸다).

| | 언제 | 위치 | 크기 |
|---|---|---|---|
| `rogue_drop_alarm` | 예고 즉시 (`rogueDrop:incoming`) | **주지 않는다** — 분대 무전에 뜨는 경고이지 하늘에서 나는 소리가 아니다 (본인 발소리와 같은 처리) | `ROGUE_DROP_ALARM_VOLUME` × 감쇠, 피치 `1.06` |
| `rogue_pod_fall` | 착지 `ROGUE_DROP_FALL_LEAD_S`(4.2) 초 전 — `update` 가 기다린다 | 준다. 패너는 **방향만** (`panOnly`) | `ROGUE_DROP_FALL_VOLUME` × 감쇠, 피치 `0.88` |
| `rogue_pod_impact` | 포드마다 착지 순간 (enemies/) | 포드 자신 | 기본 패너 (가까이서만 나는 소리) |

- **인지력 게이트를 쓰지 않는다.** 강하는 대기를 찢는 굉음이라 `derived.enemyDetectRadius`(기본 26 m)가
  좁아도 들려야 한다. 대신 **전용 반경 `ROGUE_DROP_ALERT_RADIUS`(260 m = 인지력의 10배)** 하나로 게이트한다 —
  `ui/hud/DangerIndicators` 의 화면 표시가 쓰는 반경과 **같은 값**이라 "들리는데 안 보인다" 가 없다.
- **감쇠는 남긴다** (`MAP_SIZE` 640 이므로 맵 반대편까지 들리면 안 된다). 원격 발소리와 같은 곡선이다:
  반경 밖은 아예 재생하지 않고, 안쪽은 `(1 − d/radius) ^ ROGUE_DROP_ALERT_FALLOFF_EXP` 를 곱하며,
  `ROGUE_DROP_MIN_VOLUME` 밑은 버린다. 굉음의 거리는 **울리는 순간에 다시 잰다** — 예고 때 멀었어도
  달려갔으면 크게 들린다.
- **멀티**: `rogueDrop:incoming` 은 호스트(`RogueDropDirector.call`)와 리플리카(`onIncomingWire`) 양쪽에서
  나가므로 새 와이어 없이 전원이 듣는다.
- 예고 → 굉음을 **나눈 이유**: 예고에서 착지까지 `ROGUE_DROP_ETA_S`(8초)라, 8초 전에 다 울려 버리면 정작
  떨어질 때가 조용하다. 그래서 추적 목록(`drops`)을 들고 착지 직전에 한 번만 굉음을 낸다
  (`game:newMission` / `game:abort` 에서 비운다).

## Ship hub (phases `hub` / `docking`)
The hub is **not gameplay**: while `hubActive` (set on `hub:entered`, cleared on `hub:left` / `game:newMission`) or the phase is
`hub`/`docking`, the planet wind target is 0, the extraction engine hum is muted, the tension pulse is 0, and `enemy:waveStarted` is ignored
(`ctx.isGameplayPhase()` gate). The interior loop (`amb.hub`: triangle 55 Hz + sine 110.7 Hz + sub saw 27.5 Hz → lowpass 260 Hz, plus looped
noise through a 0.09 Hz-swept bandpass for ventilation) fades to 0.15 in the hub and 0.22 with a brighter filter during `docking`.
`hub:entered` / phase `hub` also reset `shipPresent` / `engineTarget` / `liftoffTimer` so a mission's ship never hums into the hub.

**창문 워프 drive (`amb.warp`, 2026-09-09)**: two detuned saws (38 / 38.7 Hz) + a 19 Hz sub sine + a 1.4 kHz bandpassed noise
"rush" → lowpass (Q 1.6) → gain, all on `ambBus`. Every frame the targets follow the last `hub:warpProgress.speed` (0..1):
gain `0 → 0.22`, filter `180 → 1600 Hz`, pitch `38 → 90 Hz`, rush `0 → 0.55` — so the hum rises over the warp's ramp-up,
holds, and falls with the ramp-down. The speed is forgotten `WARP_HUM_HOLD_S` (0.3 s) after the last progress event and on
`hub:travel {end}` / `hub:left`, so a warp cancelled mid-flight (interior torn down) fades out on its own. Silent outside the hub.
The one-shots at the ends of a trip (`hub_dock_thrusters` / `hub_dock_clamp`) are sent by `hub/` itself.

## Auto-hooked events → id
`player:damaged`→player_hurt · `player:died`→player_death · `player:footstep` / `remote:footstep`→footstep (see *발소리* below) · `player:stimUsed`→stim ·
`player:landed`→hellpod_impact · `player:dived`→roll (Phase 7: the legacy `dive` one-shot no longer doubles it) · `player:staminaDepleted`→stamina_depleted · `player:stanceChanged`→stance_change (pitch by stance) ·
`player:aimChanged`→scope_in|scope_out **only** while the last `weapon:scopeChanged.scope` was `true` (the flag is tracked, no sound on `weapon:scopeChanged` itself; reset on `game:newMission`) ·
`weapon:reloadStarted/Finished`→reload_start/end · `weapon:dryFire`→dry_fire ·
`weapon:hit`→hit_flesh|hit_terrain · `grenade:thrown/exploded`→grenade_throw/explosion · `enemy:waveStarted`→wave_alarm ·
`inventory:opened/closed`→ui_open/close · `inventory:itemAdded`→ui_pickup · `inventory:full`→ui_error · `inventory:itemRotated`→ui_rotate ·
`crate:open`→crate_open · `ping:placed`→ping (positional, pitch/volume by kind) for `ground|enemy|crate|extraction`, ping_attack | ping_caution | ping_item for the v2 kinds · `ui:mapToggled`→map_open|map_close · `input:pointerLockLost`→ui_close (soft; there is no dedicated pause sound) ·
`extraction:boarded`→ui_equip · `extraction:doorsClosed`→door_close ·
`game:phaseChanged` deploying→hellpod_fall, complete→mission_complete, menu→ui_close.
Gunshots are **not** auto-hooked — WeaponSystem sends `audio:play shot_*` (incl. `shot_smg`, `shot_sniper`, `bolt_cycle`) itself. EnemySystem sends its own `bug_*`. `ping:removed` is intentionally silent.

Appended (ship hub / chat / pickups / reconnection):
- `hub:docking {stage:'start'}`→hub_dock_thrusters · `{stage:'end'}`→hub_dock_clamp · `hub:slotChanged {local:true}`→pod_door (pitch 0.9 when `peerId` is null) ·
  `hub:launchCountdown`→countdown_beep once per distinct `seconds` > 0 (pitch 1.25 for the last 3), launch_rumble once at `seconds === 0` · `ui:hubMenuToggled`→ui_click.
  `hub:entered` / `hub:left` only switch the ambience (no one-shot). `hub:warpProgress {speed}` → the 창문 워프 drive hum targets (no one-shot; see the Ship hub section), `hub:travel {end}` silences it.
- `chat:message`: remote `text`→chat_blip, remote `request`→chat_request, own (`local:true`) text/request→ui_click at 0.35, `system` and `ping` lines silent (the ping already sounded) · `ui:chatToggled`→chat_open|chat_close.
- `inventory:itemDropped`→item_toss (positional) · `pickup:spawned`→pickup_land (positional, volume 0.3) **except** within 0.15 s of our own drop (that spawn is the thrown item, not a landing) · `pickup:taken` is **not** auto-hooked: PickupSystem sends `audio:play {id:'pickup'}` itself on a local take (`pickup` = `pickup_chime` synth); remote takes are silent.
- `net:reconnecting`→net_warning, rate-limited to once per 5 s across attempts · `net:resumed`→net_resumed · `net:matched`→net_matched.

Appended (tactical kit):
- Melee / movement: `melee:swing`→melee_swing · `melee:hit`→melee_hit (positional, kill = louder/lower) · `player:rolled`→roll (positional) · `player:launched`→jumppad (positional).
- Survival: `player:downed`→downed · `player:revived`→revive · `player:gritSaved`→grit_save · `player:burning {active:true}`→fire_ignite · `player:cloakChanged`→cloak_on|cloak_off.
- Implants: `implant:activated {id:'atlauncher'}`→rocket_fire · `implant:dashed`→dash · `implant:grappleFired/Attached/Released`→grapple_fire/attach/release ·
  `implant:barrierChanged`→barrier_deploy when `active` flips true, the servo whir when it folds away, barrier_break the first time `hp` reaches 0 (the system tracks `barrierActive` / `barrierHp`; both reset on `game:newMission`) ·
  `implant:barrierHit`→barrier_hit (positional) · `implant:scanned`→scan_pulse (pitch + 6 % per pulse) · `implant:overcharge {active:true}`→overcharge_beam ·
  `implant:rocketExploded`→rocket_explode (positional) · `implant:wieldChanged`→ui_equip|ui_close · `implant:equipped`→ui_equip.
- Gadgets: `gadget:used`→defib (defib) | cloak_on (cloakVeil) | grenade_throw (everything else) · `gadget:deployed`→mine_arm | dome_deploy | smoke_hiss | fire_ignite | lure_beep | gadget_place by `kind` (positional) ·
  `gadget:removed {reason:'destroyed'}`→mine_explode (mines) | gadget_break, `'recovered'`→ui_equip · `gadget:throwModeChanged`→ui_click.
- Gear / crafting / weight: `gather:collected`→gather · `craft:started`→craft_start · `craft:completed`→craft_done · `craft:failed` (not cancelled)→ui_error ·
  `repair:completed`→repair_done · `durability:broken`→durability_break · `inventory:overloaded` (heavy/over)→ui_deny · `quickbar:used`→ui_click · `equip:changed`→ui_equip.
- Progression: `progress:skillUp`→skill_up. `level_up` is no longer auto-played on `progress:levelUp` (Phase 7) — the result screen's `RewardsBlock` emits `audio:play {id:'level_up'}` when its XP bar crosses the level, so the fanfare plays exactly once at the visible moment.
`turret_shot` is provided for `gadgets/` to send via `audio:play` (turret fire is not auto-hooked — there is no per-shot event).

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-10 (로그 강하 경보)** — 강하가 조용히 일어나던 문제. `rogue_pod_fall`(대기를 찢는 굉음 — 밴드패스
  노이즈가 2.6 kHz → 260 Hz 로 쓸려 내려오고 **디튠된 saw 둘**이 190 → 46 Hz, 서브 사인 34 → 22 Hz, 마지막
  1초에 역추진 상승음)과 `rogue_pod_impact`(56 → 19 Hz 서브 + 로우패스 노이즈 + **파편 클릭 3개** + 해치
  클렁크)를 새로 합성했고, 2026-09-09 에 만들어 두고 아무도 부르지 않던 `rogue_drop_alarm` 을 여기서 쓴다.
  세 소리 모두 아군 헬포드(`hellpod_fall` / `hellpod_impact`)와 **같은 어휘 · 다른 음색**이다.
  `rogueDrop:incoming` / `landed` 를 이 시스템이 받아 **인지력이 아니라 `ROGUE_DROP_ALERT_RADIUS`** 로
  게이트하고 거리 감쇠를 건다 (위 *로그 강하 경보* 절). 예전에 `enemies/RogueDrop` 이 내던 `wave_alarm`
  (벌레 웨이브와 같은 소리) + `hellpod_fall` 과 `ui/hud/RaidAlerts` 의 `wave_alarm`(같은 사건에 경보가 둘)
  은 걷어냈다.

- **2026-09-10 (PC · 원격 분대원 발소리)** — `remote:footstep` 을 받아 재생한다. 로컬 · 원격이 `footstep()`
  한 경로로 합쳐지고 **거리 감쇠는 원격에만** 걸린다 (`FOOTSTEP_AUDIBLE_RANGE` 밖은 재생하지 않음,
  안쪽은 `(1−d/range)^FOOTSTEP_FALLOFF_EXP`). 본인 발소리는 위치를 주지 않아 **패너를 타지 않고** 늘 같은
  크기다. `play()` 에 `panOnly` 인자가 붙었다 — 패너를 방향 전용(`linear` · `rolloffFactor 0`)으로 만들어
  inverse 감쇠가 우리 곡선과 겹치는 것을 막는다. 자세별 크기(달리기 > 걷기 > 웅크림 > 엎드림)는
  `data/constants.csv` 의 `FOOTSTEP_VOL_*` 이고, 자세는 이벤트가 아니라 `ctx.player` / `ctx.net` 에서 읽는다.
  위 *발소리* 절 참고.

- **2026-09-09 (창문 워프)** — `amb.warp` 드라이브 험 신설: `hub:warpProgress.speed` 를 따라 게인 · 필터 · 피치 · 노이즈가
  함께 오르고 내린다 (`WARP_HUM_HOLD_S` 0.3초 안에 진행 이벤트가 없으면 스스로 꺼진다 — 중단된 워프 대비). 원샷은 그대로
  `hub/` 가 보낸다.

- **tactical kit** — 36 tactical-kit SFX (grapple, dash, barrier, overcharge, scan, rocket, melee, roll, jump pad, turret, mine, fire, defib, gather, craft, gear break, level up)

- **Phase 7** — the roll no longer double-plays (`dive` one-shot removed), `level_up` is played only by the result screen

- **Phase 8** — publishes `ctx.audio` (`AudioRef`) — 전체 / 효과음 volumes on the master + sfx gains, persisted in `AUDIO_STORAGE_KEY`, `preview()`, `audio:volumeChanged`, pause duck composes instead of overwriting

- **2026-09-09 (레이드 플레이 개선)** — `Synth.SOUNDS` 에 9종 추가. 전부 절차 합성이고 `audio:play {id}` 로만
  불린다 (AudioSystem 의 자동 구독은 붙이지 않았다 — 발행 시점이 각 폴더의 사정이라 그쪽에서 명시적으로 쏜다):
  `comms_wheel` (휠 열림 틱) · `comms_send` (무전 클릭 + 블립) · `keycard_use` (삑삑 + 빗장 클렁크) ·
  `keycard_deny` (거부 버저) · `tram_start` (릴레이 + 모터 감김) · `tram_dock` (제동 쉭 + 완충기) ·
  `hazard_warn` (함선의 낮은 3음 경보) · `hazard_inside` (피해 구역 진입 저역 러시) ·
  `rogue_drop_alarm` (강하 경보 3음 + 대기 가르는 소리).
  기존 것을 재사용한 곳: 행성 스캔 = `scan_pulse`, 상자 = `crate_open`, 핑 = `ping_attack` / `ping_caution`.

- **2026-09-11 (사다리 · 유리창)** — `Synth.SOUNDS` 에 2종 추가, 둘 다 `audio:play {id, position}` 으로만 불린다
  (자동 구독 없음). `ladder_step` — 가로대 하나: 짧은 금속 클렁크(대역 노이즈 + 비조화 삼각파 · 사인) + 낮은 몸 쿵,
  약 0.1초, 일부러 작다. `player/` 가 가로대(`LADDER_RUNG_M`)마다 로컬 0.45 · 빠르게 0.6, 원격 아바타는 0.35 로 낸다.
  `glass_break` — 유리창이 깨지는 소리(약 0.6초): 밝은 광대역 크랙 + 창틀의 낮은 노크 + 짧은 유리 울림(비조화 사인 둘) +
  시차를 둔 고역 파편 버스트 9개와 하이패스 노이즈 꼬리. `world/` 가 구조물 창문이 맞으면 낸다.
