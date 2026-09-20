# audio/ — Procedural WebAudio SFX and ambience (`AudioSystem`)

Every sound is synthesized at runtime — no audio files. `AudioSystem` plays `audio:play {id, position?, volume?, pitch?}`,
auto-hooks events whose owners send no sound, runs the ambience loops and publishes `ctx.audio`. Other folders never
build audio nodes. Import via `@/audio` → `AudioSystem`, `Synth`, `SOUNDS`, `SOUND_IDS`.

## Files

| File | Responsibility |
|---|---|
| `AudioSystem.ts` | `GameSystem` `audio`. Voice → optional panner → sfx / ambience bus → compressor → master; context created on the first gesture. Dedupe, rate limit, `VOICE_CAP`, `RANGED_SOUNDS`, footsteps, rogue-drop alerts, rover engine clips, ambience loops (wind, tension, dropship, hub hum, warp hum), volume settings. |
| `Synth.ts` | `Synth` primitives (`tone`, `noise`, `envelope`, `click`, `tail`, `release` option) and the `SOUNDS` library `Record<id, SoundFn>`; `SOUND_IDS`. |
| `index.ts` | Barrel. |

## Public API

- `ctx.audio` (`AudioRef`, `src/shared/types.ts`): `settings` (`{master, sfx, bgm}` 0…1, loaded from `localStorage[AUDIO_STORAGE_KEY]`
  before the graph is built; defaults `AUDIO_DEFAULT_MASTER` / `_SFX` / `_BGM`), `setVolume(channel, v)` (ramps, debounced save,
  emits `audio:volumeChanged`), `preview(channel)` (throttled blip; also unlocks the context).
- Consumes `audio:play` plus the auto-hooks below. Emits only `audio:volumeChanged`.

### Sound ids (`SOUNDS` in `Synth.ts`)

| Group | Ids |
|---|---|
| Weapons | `shot_rifle` `shot_pistol` `shot_shotgun` `shot_energy` `shot_smg` `shot_sniper` `bolt_cycle` `dry_fire` `reload_start` `reload_end` `hit_flesh` `hit_terrain` `grenade_throw` `grenade_bounce` `explosion` `melee_swing` `melee_hit` |
| UI / world | `crate_open` `interact` `ui_pickup` `ui_drop` `ui_rotate` `ui_error` `ui_deny` `ui_equip` `ui_click` `ui_open` `ui_close` `ping` `ping_attack` `ping_caution` `ping_item` `map_open` `map_close` `scope_in` `scope_out` `mission_complete` `chat_blip` `chat_request` `chat_open` `chat_close` `comms_wheel` `comms_send` `net_warning` `net_resumed` `net_matched` `item_toss` `pickup_land` `pickup_chime` `pickup` |
| Player | `stim` `player_hurt` `player_death` `player_land` `player_jump` `dive` `roll` `jumppad` `stamina_depleted` `stance_change` `ladder_step` `hellpod_fall` `hellpod_impact` `hellpod_open` `shield_charge` `downed` `revive` `grit_save` `cloak_on` `cloak_off` `fall_impact` `footstep` |
| Footsteps by `SurfaceMaterial` | `footstep_dirt` `_sand` `_snow` `_mud` `_moss` `_ash` `_rock` `_crystal` `_organic` `_metal` `_concrete` |
| Implants / ship calls | `grapple_fire` `grapple_attach` `grapple_release` `dash` `barrier_deploy` `barrier_hit` `barrier_break` `overcharge_beam` `scan_pulse` `implant_ready` `stratagem_ready` `rocket_fire` `rocket_explode` (defined, currently unused) |
| Gadgets / drones / C4 | `gadget_place` `dome_deploy` `smoke_hiss` `lure_beep` `mine_arm` `mine_explode` `fire_ignite` `fire_crackle` `turret_shot` `gadget_break` `defib` `drone_deploy` `drone_link_on` `drone_link_off` `drone_static` `drone_move` `drone_sprint` `drone_jump` `drone_land` `drone_rotor` `drone_hit` `drone_destroyed` `drone_recover` `c4_place` `c4_arm` `c4_beep` `c4_detonator_click` |
| Enemies | `bug_screech` `bug_attack` `bug_death` `bug_step` `bug_step_skitter` `bug_step_heavy` `bug_step_giant` `bug_hit` `acid_splash` `wave_alarm` `shell_launch` `shell_incoming` `android_hit` `android_death` `android_step` `android_glitch` `burrow_emerge` `sandworm_rumble` `sandworm_erupt` `sandworm_roar` `sandworm_spit` `sandworm_death` `rogue_drop_alarm` `rogue_pod_fall` `rogue_pod_impact` `scan_drone_hum` `sniper_glint` `sniper_shot` `hammer_swing` `hammer_impact` `minigun_spinup` `minigun_fire` `minigun_spindown` |
| World / vehicles | `glass_break` `keycard_use` `keycard_deny` `hazard_warn` `hazard_inside` `tram_start` `tram_dock` `tram_call` `tram_deny` `tram_hit` `rover_engine` `rover_depart` `rover_shot` `rover_hatch` `rover_brake` `rover_clang` `rover_explode` `rover_pay` |
| Extraction / hub | `extract_activate` `countdown_beep` `ship_approach` `ship_land` `ship_liftoff` `door_close` `hub_dock_thrusters` `hub_dock_clamp` `pod_door` `launch_rumble` |
| Crafting / progression | `gather` `craft_start` `craft_done` `repair_done` `durability_break` `level_up` `skill_up` `crypto_mined` |
| Ship facilities | `gym_start` `gym_perfect` `gym_good` `gym_miss` `gym_finish` `gym_breath` `gym_pedal` `chair_creak` `tv_on` `tv_off` `record_on` `record_off` `cook_start` `cook_chop` `cook_mince` `cook_sizzle` `cook_flip` `cook_remove` `cook_burn` `cook_toss` `cook_stir` `cook_pour` `cook_perfect` `cook_good` `cook_miss` `cook_step` `cook_auto` `cook_finish` |

### Auto-hooked events

The `b.on(...)` list in `AudioSystem.init` is the source of truth: player / remote-player events, weapon reload · dry fire ·
hits · grenades · melee, `rogueDrop:*`, `rover:*`, inventory / crafting / pickups, pings · chat · map, `hub:*` (incl. the
warp hum on `hub:warpProgress`), `net:*`, `extraction:*` (ambience targets), `implant:*`, `stratagem:ready` (silent when
`refunded`), `gadget:*`, `game:*`. Owners send their own `audio:play` for gunshots, `bug_*`, turret fire, pickups taken,
`level_up` (result screen), cooking / gym / TV / record, drone / C4 / named-rogue sounds.

## Rules

- **Distance falloff is computed once.** Ids in `RANGED_SOUNDS` (and footsteps, rogue-drop sounds) use
  `(1 − d/range)^exp` on the caller's volume and a `panOnly` panner (`rolloffFactor 0`); leaving the default inverse
  panner on would attenuate twice. Out of range = no voice at all. `floor` only for warnings that must be audible to be
  fair. Callers pass a base volume (e.g. `enemies/model.ts` `emitEnemyStep`). — `AudioSystem.ts` (`RANGED_SOUNDS`)
- Ranges are presentation; one tied to gameplay binds to its constant (`drone_sprint` > `DRONE_NOISE_RADIUS`,
  `fall_impact` = `FALL_REMOTE_SOUND_RANGE`).
- Footstep id = surface under the foot (`ctx.world.getSurfaceMaterial`, `dirt` fallback, hub/docking `metal`) ×
  `FOOTSTEP_MATERIAL_GAIN`. Local steps have no position; remote use `FOOTSTEP_AUDIBLE_RANGE`. Footsteps skip dedupe
  (enemies share the ids). — `AudioSystem.footstep`
- Rogue-drop alerts gate on `ROGUE_DROP_ALERT_RADIUS` (not perception) — the radius `ui/hud/DangerIndicators` also uses,
  so it is never heard but not shown. The fall roar plays `ROGUE_DROP_FALL_LEAD_S` before landing. — `AudioSystem.rogueDropIncoming`
- An explicit `audio:play` and an auto-hook of the same id within `DEDUPE_WINDOW` play once — route racing auto-hooks
  through `playRequested(…, auto)`. `RATE_MAX_SAME` limits frequency only; overlap is capped by `VOICE_CAP`, keyed by
  voice group (`VOICE_GROUP`, else the id): at the cap a new voice must be louder than the quietest live one, which is
  faded out. `play` returns the voice (`CappedVoice`: gain · panner · `stolen`). — `AudioSystem.play`
- **Bug footsteps are their own ids** (`bug_step_skitter` small · `bug_step_heavy` warrior/charger/artillery ·
  `bug_step_giant` behemoth), never `footstep_<mat>`, so a swarm cannot eat player / squad / humanoid steps. Range
  `BUG_STEP_RANGE_M` (behemoth `BUG_STEP_GIANT_RANGE_M`), one shared `VOICE_CAP.bug_steps` (`BUG_STEP_VOICE_CAP`);
  the emitter scales by 1/√n stepping bugs (`enemies/model.emitEnemyStep`).
- `burrow_emerge` plays once per bug (emitter normalises a batch by 1/√k, `BURROW_EMERGE_BATCH_S`) and is capped by
  `BURROW_EMERGE_VOICE_CAP`.
- Artillery shells: `enemy:shellFired` (host and replica) → `shell_launch` at the launcher (`SHELL_LAUNCH_RANGE_M`) and
  tracking; `SHELL_INCOMING_LEAD_S` before impact `shell_incoming` starts (its synth length equals the lead), gain by the
  listener's distance to the **impact point** (`SHELL_INCOMING_RANGE_M`, `SHELL_INCOMING_FLOOR`), panner riding
  `shellPositionAt`; `enemy:shellLanded` / `shellIntercepted` cut it. — `AudioSystem.updateShells`
- The hub is not gameplay: while in `hub` / `docking` wind, dropship engine and tension pulse are 0 and `enemy:waveStarted`
  is ignored. `crypto_mined` plays only in `hub` (mining also pays out during raids).
- **The `bgm` channel is storage/display only.** No GainNode exists for it and nothing plays music (no asset files, no
  procedural music yet); playback state belongs to `housing/parts/Music`, the volume is shown by `ui/hud/MusicPlayer`.
  Missing `bgm` in an old save means "unknown" → `AUDIO_DEFAULT_BGM`, not 0.
- Ambience bypasses the sfx slider (master only); master ducks while `game:paused`.
- **Intended** (2026-09-16): a shell whistle that was more than 55 m from the impact point when it started
  (`SHELL_INCOMING_LEAD_S` before impact) stays silent even if the listener runs in afterwards — a synth sound cannot be
  started from the middle. Bug footsteps do not follow the ground material, and a hunter's leap landing still plays the old
  `bug_step`.

## Recent changes

Last 5 only — older: `git log -- src/audio`.
- 2026-09-20 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels, named-rogue names and verbatim user decisions kept in backticks / 「」, no string literal touched.
- 2026-09-18 — Bug steps easier to hear: `bug_step_*` distance curve exponent 1.0 (was 1.4 / 1.3); ranges `BUG_STEP_RANGE_M` 32 · `BUG_STEP_GIANT_RANGE_M` 48; louder per-bug gains live in `enemies/model.STEP_VOICES`.
- 2026-09-16 — Bug audio: `bug_step_skitter` / `_heavy` / `_giant` (own ids, `VOICE_GROUP` `bug_steps` cap), per-bug `burrow_emerge` re-voiced + capped, artillery `shell_launch` + tracked `shell_incoming` whistle (`enemy:shellFired|shellLanded|shellIntercepted`); `play` returns the voice; `debugVoices` / `debugIncomingShells`.
- 2026-09-15 — Anti-tank launcher retired: `rocket_fire` / `rocket_explode` auto-hooks removed.
- 2026-09-15 — `fall_impact` (local `player:fell`, remote `player:remoteFell`), `fire_crackle`, re-voiced `fire_ignite`; `VOICE_CAP` added.
