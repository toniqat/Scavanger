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
Player: `stim` `player_hurt` `player_death` `footstep` `ladder_step` `player_land` `player_jump` `dive` `stamina_depleted` `stance_change` `hellpod_fall` `hellpod_impact` `hellpod_open` `shield_charge`
재질별 발소리 (2026-09-11, C-22 — `SurfaceMaterial` 이름 그대로): `footstep_dirt`(= 옛 `footstep`) `footstep_sand` `footstep_snow` `footstep_mud` `footstep_moss` `footstep_ash` `footstep_rock` `footstep_crystal` `footstep_organic` `footstep_metal` `footstep_concrete`
World (structures): `glass_break`
선로 · 전차 (2026-09-11, C-39 · C-18): `tram_call` `tram_deny` `tram_hit` (+ 기존 `tram_start` `tram_dock`)
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
준비 소리 (2026-09-12): `implant_ready` (짧고 높은 전자음) `stratagem_ready` (무전 두 음 차임)
Tactical kit — gadgets: `gadget_place` `dome_deploy` `smoke_hiss` `lure_beep` `mine_arm` `mine_explode` `fire_ignite` `turret_shot` `gadget_break` `defib`
Tactical kit — survival: `downed` `revive` `grit_save` `cloak_on` `cloak_off`
Tactical kit — upkeep/progression: `gather` `craft_start` `craft_done` `repair_done` `durability_break` `level_up` `skill_up`
드론 (2026-09-11): `drone_deploy` `drone_link_on` `drone_link_off` `drone_static` `drone_move` `drone_sprint` `drone_jump` `drone_land` `drone_rotor` `drone_hit` `drone_destroyed` `drone_recover`
원격 지뢰 (2026-09-11): `c4_place` `c4_arm` `c4_beep` `c4_detonator_click`
네임드 로그 (2026-09-11): `scan_drone_hum` `scan_pulse`(기존 id, 길어짐) `sniper_glint` `sniper_shot` `hammer_swing` `hammer_impact` `minigun_spinup` `minigun_fire` `minigun_spindown`

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

## 발소리 — 로컬 · 원격 (2026-09-10) · 재질 · 적 (2026-09-11)

> **2026-09-11 (C-22 · C-23)** — 소리 id 가 **밟은 재질**로 정해진다: `footstep_<SurfaceMaterial>` 11종. 본인 · 원격 분대원은
> `footstep()` 이 발 위치에서 `ctx.world.getSurfaceMaterial?.(x, z, feetY)` 를 묻고(월드가 준비 안 됐거나 옵셔널 구현이 없으면
> `dirt` = 옛 음색), **허브 · 도킹 페이즈는 본인 포함 `metal`** 이다 — 옛 원격 전용 `FOOTSTEP_PITCH_DECK`(1.16) 피치 배수는
> 없어졌다. 크기에 재질 배수 `FOOTSTEP_MATERIAL_GAIN`(`data/tables.csv`, dirt 1 · moss 0.7 · metal 1.2 …)이 곱해진다.
> 발소리는 적과 id 를 나눠 쓰므로 `play(..., dedupe false)` 로 **중복 제거를 타지 않고**, 본인 발소리는 같은 id 속도 제한도
> 건너뛴다 (적 무리가 같은 재질을 밟아도 내 발소리는 먹히지 않는다).
> **적 발소리**는 `enemies/model.emitEnemyStep` 이 같은 id 를 **위치와 함께** `audio:play` 로 낸다 → `RANGED_SOUNDS` 에 11개
> id 가 `ENEMY_STEP_RANGE`(45 m · exp 1.5) 한 줄로 들어 있어 `panOnly` + 곡선 한 번 + 재질 배수. 호출부 볼륨은 타입 밑값
> (전사 0.55 · 베헤모스 1.7 …)이라 **거리 감쇠가 두 번 걸리지 않는다** (X-3: 예전엔 방출부 선형 × 패너 inverse 로 20 m 에서
> ≈0.06). 적 발소리는 이제 160 m 하드 컷 대상이 아니다(`panOnly`). 비호스트 리플리카도 낸다.

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
  난다. 갑판은 금속이라 `footstep_metal` 이다 (2026-09-11 — 옛 `FOOTSTEP_PITCH_DECK` 1.16 피치 배수를 대신한다).
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

## 드론 · 원격 지뢰 · 네임드 로그 — 거리 곡선을 가진 효과음 (2026-09-11)

전부 **다른 폴더가 `audio:play` 로 부른다** (자동 구독 없음 — 같은 id 를 두 번 내지 않는다). ★ = 소유자가
0.1–0.6 초마다 다시 부르는 **짧은 한 방**이다. 부드러운 어택 + 유지 + 선형 릴리스(`Synth` 의 `release` 옵션)와
약간의 피치 흔들림으로 겹치는 hit 들이 맥동 · 위상 간섭 없이 **이어진 소리**로 들린다. 한 방의 크기는 0.2–0.3 초
주기에 맞췄으므로 더 촘촘히 부르면 그만큼 겹쳐 커진다. 같은 id 스로틀(`RATE_MAX_SAME` 8회/100 ms)은 이 주기를
끊지 않는다.

**거리**: `audio:play` 에 위치가 오면 `AudioSystem.RANGED_SOUNDS` 의 id 는 기본 패너(inverse, ref 4 m) 대신
원격 발소리 · 로그 강하와 **같은 곡선** `(1 − d/range)^exp` 을 호출부 볼륨에 곱하고 패너는 방향만 맡는다(`panOnly`).
`range` 밖은 보이스를 만들지 않는다. `floor` 는 사거리 안에서 보장하는 최소 비율로, **전조가 들려야 공정한** 소리만
갖는다(마지막 15 % 구간에서 0 으로 줄어 끝이 뚝 끊기지 않는다). 위치가 없으면(× = 로컬 UI) 패너를 타지 않고 늘 같은 크기다.

| id | 무엇 | 위치 | 음색 | range m / exp / floor |
|---|---|---|---|---|
| `drone_deploy` | 드론 내려놓기 · 띄우기 | ○ | 착지 쿵 + 서보 + 전원 삑 2음 | 30 / 1.5 |
| `drone_link_on` | 조종 시작 | × | 짧은 잡음 → 상승 square 칩 4개 → 고음 | — |
| `drone_link_off` | 조종 끝 | × | 하강 칩 4개 + 낮은 블립 + 잡음 꺼짐 | — |
| `drone_static` ★ | 사거리 90 % 이상 | × | 밴드패스 잡음 + 무작위 크랙 + 100 Hz 험 | — |
| `drone_move` ★ | 지상 드론 걷기 | ○ | 아주 작은 모터 틱 | 12 / 1.8 |
| `drone_sprint` ★ | 지상 드론 질주 | ○ | 디튠 saw 모터 윙 + 바퀴 · 자갈 잡음 | `DRONE_NOISE_RADIUS`×1.5 / 1.3 |
| `drone_jump` / `drone_land` | 점프 / 착지 | ○ | 스프링 서보 퉁 / 둔탁한 쿵 + 섀시 달그락 | 30 / 1.5 |
| `drone_rotor` ★ | 공중 드론 로터 | ○ | 맥놀이 saw 둘 + 블레이드 비브라토 + 바람 (`pitch` = 로터 속도) | 45 / 1.4 |
| `drone_hit` | 피격 | ○ | 금속 핑 + 스파크 크랙 + 전기 지직 | 40 / 1.4 |
| `drone_destroyed` | 파괴 | ○ | 작은 폭발 + 전기 방전 + 파편 | 90 / 1.2 |
| `drone_recover` | 회수 | ○ | 접히는 서보 + 걸쇠 + 확인 2음 | 30 / 1.5 |
| `c4_place` | C4 설치 | ○ | 끈적한 누름 + 작은 쿵 + 케이스 클릭 | 20 / 1.5 |
| `c4_arm` | 무장 | ○ | 같은 높이 삑 두 번 (`mine_arm` 의 상승 음형과 다르다) | 18 / 1.6 |
| `c4_beep` ★ | 무장 대기 | ○ | 작은 사인 삑 | 8 / 1.8 |
| `c4_detonator_click` | 기폭기 | × | 딸깍딸깍 + 짧은 무전 스퀠치 | — |
| `scan_drone_hum` ★ | 스캔 드론 비행 | ○ | 62 Hz 맥놀이 saw + 흔들리는 124 Hz + 희미한 고음 | 120 / 1.2 |
| `scan_pulse` | 스캔 음파 (기존 id) | ○ | 소나 핑 + 에코 둘 + 낮은 경고 저음 + 잔향 (≈1.5 s) | 180 / 1.0 / 0.25 |
| `sniper_glint` | 조준경 반짝임 | ○ | 가늘게 오르는 고음 + 유리 반짝 + E6 몸통 | 260 / 0.9 / 0.4 |
| `sniper_shot` | 대물 저격 | ○ | 큰 크랙 + 서브 붐 + 긴 꼬리 + 슬랩백 에코 둘 (≈2.1 s) | 900 / 0.8 / 0.3 |
| `hammer_swing` | 망치 휘두름 | ○ | 느리고 무거운 바람 가르기 | 30 / 1.5 |
| `hammer_impact` | 망치 타격 | ○ | 서브 쿵 + 금속 머리 클렁크 + 파편 | 70 / 1.2 |
| `minigun_spinup` | 회전 시작 | ○ | 오르는 모터 휘잉 + 빨라지는 달그락, 길이 = `MINIGUN_SPINUP_TIME` | 90 / 1.2 |
| `minigun_fire` ★ | 연사 한 덩어리(≈0.1 s) | ○ | 한 덩어리에 짧은 발사음 3개 + 유지되는 모터음 | 220 / 1.0 / 0.1 |
| `minigun_spindown` | 회전 정지 | ○ | 내려가는 휘잉 + 느려지는 달그락, 길이 = `MINIGUN_SPINDOWN_TIME` | 90 / 1.2 |

- `scan_pulse` 는 **이미 있던 id** 다 (임플란트 정찰 스캔 · 옥상 행성 스캔). 앞머리는 그대로 두고 에코 · 경고 저음 ·
  잔향을 덧대 네임드 경고로도 읽히게 했다. 위치를 주는 호출(원격 임플란트 · 구조물 스캔)도 이제 이 곡선을 탄다.
- 반경들은 **플레이어 귀의 연출**이고 판정에 쓰이지 않는다. 판정 반경이 있는 것은 계약 상수에 묶었다
  (질주 드론 = 적이 듣는 `DRONE_NOISE_RADIUS` 보다 조금 멀리 — "적이 들었는데 나는 못 들었다" 가 없게).
- **자동 구독 제외**: 드론 아이템 · 원격 지뢰의 `gadget:used` 는 투척음(`grenade_throw`)을 내지 않는다.
  `gadget:deployed {kind:'remoteMine'}` 는 `gadget_place` 를 내지 않는다(`c4_place` 를 gadgets/ 가 낸다).
  `gadget:removed {kind:'remoteMine', reason:'destroyed'}` 는 `gadget_break` 를 내지 않는다. 기폭은 gadgets/ 가 이미
  `explosion` 을 냈고, 이 이벤트만으로는 불발과 기폭을 가를 수 없다.

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
  `implant:rocketExploded`→rocket_explode (positional) · `implant:wieldChanged`→ui_equip|ui_close · `implant:equipped`→ui_equip ·
  **2026-09-12** `implant:ready`→implant_ready (`full` 0.55 · 피치 1, 충전형의 중간 충전 0.26 · 피치 0.9).
- Ship calls (2026-09-12): `stratagem:ready {refunded:false}`→stratagem_ready (0.7). `refunded: true`(호스트 거절 환불로 0 이 된 순간)는 **무음**.
- Gadgets: `gadget:used`→defib (defib) | cloak_on (cloakVeil) | grenade_throw (everything else) · `gadget:deployed`→mine_arm | dome_deploy | smoke_hiss | fire_ignite | lure_beep | gadget_place by `kind` (positional) ·
  `gadget:removed {reason:'destroyed'}`→mine_explode (mines) | gadget_break, `'recovered'`→ui_equip · `gadget:throwModeChanged`→ui_click.
- Gear / crafting / weight: `gather:collected`→gather · `craft:started`→craft_start · `craft:completed`→craft_done · `craft:failed` (not cancelled)→ui_error ·
  `repair:completed`→repair_done · `durability:broken`→durability_break · `inventory:overloaded` (heavy/over)→ui_deny · `quickbar:used`→ui_click · `equip:changed`→ui_equip.
- Progression: `progress:skillUp`→skill_up. `level_up` is no longer auto-played on `progress:levelUp` (Phase 7) — the result screen's `RewardsBlock` emits `audio:play {id:'level_up'}` when its XP bar crosses the level, so the fanfare plays exactly once at the visible moment.
`turret_shot` is provided for `gadgets/` to send via `audio:play` (turret fire is not auto-hooked — there is no per-shot event).

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-12 (준비 소리 2종 — 사용자 결정, 에이전트 B, docs/plans/consumables-keys-favorites.md §2)** — `Synth.SOUNDS` 에 2종.
  `implant_ready` — implants/ 가 오래전부터 `audio:play` 로 보내던 id 인데 **정의가 없어 한 번도 울리지 않았다**(자동 경로가 아니라 콘솔
  경고만 남았다). 짧고 높은 전자음: 위로 튕기는 사각파 칩 + 맑은 2.6 kHz 사인 핑 + 옅은 배음, ≈0.17 s. `stratagem_ready` — 무전 톤 두 음
  차임: 스퀠치 열림 잡음 + 딸깍, 좁은 대역(lowpass 3.2 kHz)의 G5 → D6 삼각파 두 음(뒤 음이 길다) + 한 옥타브 아래 사각파 몸통, 스퀠치 닫힘,
  ≈0.56 s — 임플란트의 높은 핑과 헷갈리지 않게 낮고 둥글다. 둘 다 **자동 구독**이다: `implant:ready` · `stratagem:ready` (둘 다 게임플레이
  페이즈에서만 나오는 이벤트라 여기서 페이즈를 다시 보지 않는다). implants/ 의 직접 `audio:play implant_ready` 두 줄은 이벤트로 바뀌었다 —
  중간 충전을 작고 낮게 내는 결정은 이제 audio/ 한 곳에 있다. 함선 호출 거절 환불(`refunded`)은 무음(거절음이 이미 났다).
  `RANGED_SOUNDS` 에 넣지 않았다 (위치 없는 로컬 알림). 검증: `smoke-tactical` · `smoke-phase3` 가 `AudioSystem.play` 를 감싸 요청을 센다.

- **2026-09-12 (헬스장 A-3a · 서재 매체 A-3e)** — `Synth.SOUNDS` 에 12종 추가. 전부 절차 합성이고 **housing/ · hub/ 가
  `audio:play {id}` 로만 부른다** (자동 구독 없음). 함선 안 UI 성격이라 `RANGED_SOUNDS` 에 넣지 않았다 — 위치 없이 오면 늘 같은
  크기, 위치와 오면 기본 패너(inverse, 가까이서만).
  `gym_start`(기구 잡는 딸깍 + 오르는 삼각파 두 음, ≈0.42 s) · `gym_perfect`(밝은 두 음 차임 + 고역 반짝임, ≈0.38 s) ·
  `gym_good`(가운데 높이 한 음, ≈0.22 s) · `gym_miss`(낮게 꺾이는 둔한 음 + 저역 쿵 — `ui_error` 버저보다 부드럽다, ≈0.28 s) ·
  `gym_finish`(원반 내려놓는 금속 쿵 + 오르는 네 음 아르페지오, ≈0.95 s) · `gym_breath`(부드러운 날숨 — 아래로 쓸리는 밴드패스
  노이즈, 느린 어택 · 선형 페이드 · 클릭 없음, ≈0.5 s) · `gym_pedal`(체인 딸깍 + 크랭크의 작은 몸, ≈0.06 s — 박자마다 불려도
  거슬리지 않게 작다) · `chair_creak`(나무 스틱-슬립: 점점 벌어지는 좁은 밴드패스 알갱이 16개 + 비브라토 낀 낮은 saw 몸통,
  ≈0.48 s) · `tv_on`(스위치 + 브라운관 퍽 + 잡음 + 가늘게 사라지는 고음) · `tv_off`(스위치 + 점으로 줄어드는 하강 블립) ·
  `record_on`(스위치 + 바늘 닿는 쿵 + 따뜻한 바닥 음 + 치직임) · `record_off`(스위치 + 플래터가 느려지며 내려가는 음).
  위 `Sound ids` 목록에는 이 줄로 대신한다: 헬스장 `gym_start` `gym_perfect` `gym_good` `gym_miss` `gym_finish` `gym_breath`
  `gym_pedal`, 서재 가구 `chair_creak` `tv_on` `tv_off` `record_on` `record_off`.

- **2026-09-12 (눈 발소리 재튜닝, 사용자 결정)** — `Synth.SOUNDS.footstep_snow` 한 줄기만 고쳤다 (사용자 불만
  "툰드라 지형에서의 발걸음 소리가 너무 거슬린다"). **모래로 바꾸지 않고** 편하다고 평가받은 `footstep_sand` 의
  성질 셋을 눈으로 옮겼다 — ① 크런치 알갱이의 필터를 `highpass` → `bandpass`(q 0.8, 중심이 아래로 쓸린다)로
  바꿔 **위를 닫았다**: 하이패스는 위가 열려 있어 흰 노이즈의 8–16 kHz 가 그대로 나가고, 그게 로컬 플레이어가
  매 걸음 듣는 소리에서 피로의 주범이었다. 중심도 1800–3200 → 1300–1900 Hz 로 내려 귀가 가장 예민한 3–5 kHz
  대를 비웠다. ② 알갱이 `attack` 0.003(기본) → 0.007 s, 몸통 0.01 → 0.012 s (모래와 같은 값) — 클릭 제거.
  ③ 알갱이 4 → 3겹 · 간격 0.018 → 0.016 s 라 밝은 성분이 ~0.09 → ~0.07 s 에서 끝난다(꼬리 단축). 알갱이 gain
  0.1 → 0.055, 대역이 좁아진 만큼 빠진 무게는 몸통에서 되돌렸다(0.1 → 0.12, lowpass 700 → 620 Hz). 저역 몸통 ·
  사인은 그대로라 여전히 "눈을 밟는" 소리다. **`data/tables.csv` 는 건드리지 않았다** — `FOOTSTEP_MATERIAL_GAIN.snow`
  는 0.95 그대로이고, 그래도 크게 들리면 모래와 같은 0.85 가 후보다. 적 발소리(`enemies/model.stepSound`)도 같은
  id 를 쓰므로 함께 부드러워진다.

- **2026-09-11 (C 배치 — C-21 · C-22 · C-23 · C-39, 에이전트 4)** — `Synth.SOUNDS` 에 15종 추가. `shield_charge`(실드 충전기
  완료 — 올라가는 saw 충전음 400 → 1600 Hz + 사인 2음 + 하이패스 반짝임 + 딸깍, ≈0.6 s, `player/` 가 부른다) ·
  `tram_call`(승강장 딩-동 차임, 부른 콘솔 자리) · `tram_deny`(낮은 역차임 두 음 — `keycard_deny` 버저와 다르다) ·
  `tram_hit`(전차 치임: 서브 쿵 + 로우패스 노이즈 + 차체 클렁크 · 울림 + 레일 쇳소리, 옛 `tram_dock` pitch 0.7 대용) —
  셋 다 `world/` 가 부른다. 재질별 발소리 11종 `footstep_<mat>`(dirt = 옛 `footstep` 별칭 · sand 사각 · snow 뽀드득 여러 겹 ·
  mud 철벅 · moss 먹힘 · ash 바삭 · rock 단단 + 자갈 · crystal 유리 울림 · organic 끈적 · metal 딸깍 + 판 울림 · concrete 건조).
  `AudioSystem`: `footstep()` 이 재질 id · `FOOTSTEP_MATERIAL_GAIN` · 허브 금속(갑판 피치 해킹 삭제), `RANGED_SOUNDS` 에 적
  발소리 곡선, `playRequested` 가 적 발소리에도 재질 배수, `play()` 에 `dedupe` · `rateLimit` 인자. 위 *발소리* 절.

- **2026-09-11 (드론 · 원격 지뢰 · 네임드 로그)** — `Synth.SOUNDS` 에 24종 추가, 기존 `scan_pulse` 를 길게(≈1.5 s,
  에코 둘 + 경고 저음 + 잔향) 다듬었다. 위 *드론 · 원격 지뢰 · 네임드 로그* 절의 표 참고. `Synth` 의 tone/noise 에
  `release` 옵션(어택 → 유지 → 선형 페이드)이 붙었다. 스핀업 · 험과 ★ 주기 호출형 소리가 쓴다.
  `AudioSystem` 은 `audio:play` 입구(`playRequested`)에서 `RANGED_SOUNDS` 의 id 에 원격 발소리와 같은 거리 곡선을
  걸고(`panOnly`) 사거리 밖은 재생하지 않는다. 저격 · 반짝임 · 스캔 음파는 `floor` 로 사거리 안 최소 크기를 보장한다.
  원격 지뢰 담당 요청으로 `gadget:deployed/removed {kind:'remoteMine'}` 의 자동 설치음 · 파괴음을, 드론 · 원격 지뢰의
  `gadget:used` 투척음을 뺐다.

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
