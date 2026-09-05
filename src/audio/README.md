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
- Progression: `progress:levelUp`→level_up · `progress:skillUp`→skill_up.
`turret_shot` is provided for `gadgets/` to send via `audio:play` (turret fire is not auto-hooked — there is no per-shot event).
