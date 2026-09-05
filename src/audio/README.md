# src/audio — Procedural WebAudio (`AudioSystem`)

All sound is synthesized at runtime (oscillators, noise buffers, envelopes, biquad filters) — no audio files.
The `AudioContext` is created/resumed on the first pointer/key gesture. Graph: voice → optional `PannerNode`
→ sfx bus / ambient bus → `DynamicsCompressor` (limiter) → master gain → destination.

Import via `@/audio` → `AudioSystem`, `Synth`, `SOUNDS`, `SOUND_IDS`.

| File | Purpose |
|---|---|
| `AudioSystem.ts` | `GameSystem` (`name: 'audio'`). Plays `audio:play {id, position?, volume?, pitch?}` (positional → equal-power panner, inverse distance, listener follows `ctx.camera` each frame). Auto-hooks events whose owners do not send audio themselves (see below). Dedupe: the same id from an explicit `audio:play` and an auto-hook within 100 ms plays once. Rate limit: max 8 identical ids per 100 ms. Ambience: wind/planet drone (looped noise → LFO-swept lowpass + 42 Hz sub), tension pulse during `extracting`/`shipLanded` (tremolo rate rises as the countdown runs out), ship engine hum while the ship is present (fades 8 s after liftoff), **ship-interior hum + ventilation** while in the hub (see below). Master ducks to 25 % while paused. |
| `Synth.ts` | `Synth` primitives (`tone()`, `noise()`, `envelope()`, `click()` metallic transient, `tail()` staggered reverberant noise) and the `SOUNDS` library: `Record<id, (synth, dest, t0, pitch) => duration>`. |
| `index.ts` | Barrel. |

## Sound ids (`SOUNDS`)
Weapons: `shot_rifle` `shot_pistol` `shot_shotgun` `shot_energy` `shot_smg` `shot_sniper` `bolt_cycle` `dry_fire` `reload_start` `reload_end` `hit_flesh` `hit_terrain` `grenade_throw` `grenade_bounce` `explosion`
World/UI: `crate_open` `interact` `ui_pickup` `ui_drop` `ui_rotate` `ui_error` `ui_deny` `ui_equip` `ui_click` `ui_open` `ui_close` `ping` `map_open` `map_close` `scope_in` `scope_out` `mission_complete`
Player: `stim` `player_hurt` `player_death` `footstep` `player_land` `player_jump` `dive` `stamina_depleted` `stance_change` `hellpod_fall` `hellpod_impact` `hellpod_open`
Bugs: `bug_screech` `bug_attack` `bug_death` `bug_step` `bug_hit` `acid_splash` `wave_alarm`
Extraction: `extract_activate` `countdown_beep` `ship_approach` `ship_land` `ship_liftoff` `door_close`
Ship hub: `hub_dock_thrusters` `hub_dock_clamp` `pod_door` `launch_rumble`
Chat: `chat_blip` `chat_request` `chat_open` `chat_close`
Pings v2: `ping_attack` `ping_caution` `ping_item`
Pickups: `item_toss` `pickup_land` `pickup_chime` `pickup` (alias of `pickup_chime`, the id `pickups/` sends)
Net: `net_warning` `net_resumed` `net_matched`

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

## Ship hub (phases `hub` / `docking`)
The hub is **not gameplay**: while `hubActive` (set on `hub:entered`, cleared on `hub:left` / `game:newMission`) or the phase is
`hub`/`docking`, the planet wind target is 0, the extraction engine hum is muted, the tension pulse is 0, and `enemy:waveStarted` is ignored
(`ctx.isGameplayPhase()` gate). The interior loop (`amb.hub`: triangle 55 Hz + sine 110.7 Hz + sub saw 27.5 Hz → lowpass 260 Hz, plus looped
noise through a 0.09 Hz-swept bandpass for ventilation) fades to 0.15 in the hub and 0.22 with a brighter filter during `docking`.
`hub:entered` / phase `hub` also reset `shipPresent` / `engineTarget` / `liftoffTimer` so a mission's ship never hums into the hub.

## Auto-hooked events → id
`player:damaged`→player_hurt · `player:died`→player_death · `player:footstep`→footstep · `player:stimUsed`→stim ·
`player:landed`→hellpod_impact · `player:dived`→dive · `player:staminaDepleted`→stamina_depleted · `player:stanceChanged`→stance_change (pitch by stance) ·
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
  `hub:entered` / `hub:left` only switch the ambience (no one-shot).
- `chat:message`: remote `text`→chat_blip, remote `request`→chat_request, own (`local:true`) text/request→ui_click at 0.35, `system` and `ping` lines silent (the ping already sounded) · `ui:chatToggled`→chat_open|chat_close.
- `inventory:itemDropped`→item_toss (positional) · `pickup:spawned`→pickup_land (positional, volume 0.3) **except** within 0.15 s of our own drop (that spawn is the thrown item, not a landing) · `pickup:taken` is **not** auto-hooked: PickupSystem sends `audio:play {id:'pickup'}` itself on a local take (`pickup` = `pickup_chime` synth); remote takes are silent.
- `net:reconnecting`→net_warning, rate-limited to once per 5 s across attempts · `net:resumed`→net_resumed · `net:matched`→net_matched.
