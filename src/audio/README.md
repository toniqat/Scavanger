# src/audio — Procedural WebAudio (`AudioSystem`)

All sound is synthesized at runtime (oscillators, noise buffers, envelopes, biquad filters) — no audio files.
The `AudioContext` is created/resumed on the first pointer/key gesture. Graph: voice → optional `PannerNode`
→ sfx bus / ambient bus → `DynamicsCompressor` (limiter) → master gain → destination.

Import via `@/audio` → `AudioSystem`, `Synth`, `SOUNDS`, `SOUND_IDS`.

| File | Purpose |
|---|---|
| `AudioSystem.ts` | `GameSystem` (`name: 'audio'`). Plays `audio:play {id, position?, volume?, pitch?}` (positional → equal-power panner, inverse distance, listener follows `ctx.camera` each frame). Auto-hooks events whose owners do not send audio themselves (see below). Dedupe: the same id from an explicit `audio:play` and an auto-hook within 100 ms plays once. Rate limit: max 8 identical ids per 100 ms. Ambience: wind/planet drone (looped noise → LFO-swept lowpass + 42 Hz sub), tension pulse during `extracting`/`shipLanded` (tremolo rate rises as the countdown runs out), ship engine hum while the ship is present (fades 8 s after liftoff). Master ducks to 25 % while paused. |
| `Synth.ts` | `Synth` primitives (`tone()`, `noise()`, `envelope()`) and the `SOUNDS` library: `Record<id, (synth, dest, t0, pitch) => duration>`. |
| `index.ts` | Barrel. |

## Sound ids (`SOUNDS`)
Weapons: `shot_rifle` `shot_pistol` `shot_shotgun` `shot_energy` `dry_fire` `reload_start` `reload_end` `hit_flesh` `hit_terrain` `grenade_throw` `grenade_bounce` `explosion`
World/UI: `crate_open` `interact` `ui_pickup` `ui_drop` `ui_rotate` `ui_error` `ui_deny` `ui_equip` `ui_click` `ui_open` `ui_close` `mission_complete`
Player: `stim` `player_hurt` `player_death` `footstep` `player_land` `player_jump` `hellpod_fall` `hellpod_impact` `hellpod_open`
Bugs: `bug_screech` `bug_attack` `bug_death` `bug_step` `bug_hit` `acid_splash` `wave_alarm`
Extraction: `extract_activate` `countdown_beep` `ship_approach` `ship_land` `ship_liftoff` `door_close`

## Auto-hooked events → id
`player:damaged`→player_hurt · `player:died`→player_death · `player:footstep`→footstep · `player:stimUsed`→stim ·
`player:landed`→hellpod_impact · `weapon:reloadStarted/Finished`→reload_start/end · `weapon:dryFire`→dry_fire ·
`weapon:hit`→hit_flesh|hit_terrain · `grenade:thrown/exploded`→grenade_throw/explosion · `enemy:waveStarted`→wave_alarm ·
`inventory:opened/closed`→ui_open/close · `inventory:itemAdded`→ui_pickup · `inventory:full`→ui_error · `inventory:itemRotated`→ui_rotate ·
`crate:open`→crate_open · `extraction:boarded`→ui_equip · `extraction:doorsClosed`→door_close ·
`game:phaseChanged` deploying→hellpod_fall, complete→mission_complete, menu→ui_close.
Gunshots are **not** auto-hooked — WeaponSystem sends `audio:play shot_*` itself. EnemySystem sends its own `bug_*`.
