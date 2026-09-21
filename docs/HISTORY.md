# SCAVANGER — Development history

> **Do not append work logs to this file.** What changed, when and why lives in **commit messages** —
> `git log --oneline` · `git log -- src/<folder>` · `git log --grep '<keyword>'`.
> The dated work log that accumulated here until 2026-09-15 (3,000 lines) is intact in the commit right before this
> file was cut: `git show 3949d37:docs/HISTORY.md`.

| Looking for | Where |
|---|---|
| How the code is structured now | [CLAUDE.md](../CLAUDE.md) → folder `README.md` |
| What breaks if violated (conventions · invariants) | The comment right above that code, and the conventions section of [CLAUDE.md](../CLAUDE.md) |
| Why an alternative was chosen (user decisions) | the owning folder's `README.md` `## Decisions` |
| When something changed | `git log` |
| Upcoming work | [TODO.md](TODO.md) |
| Known limits of a feature (intended, decision first to change) | that folder's `README.md` |

---

## Completed phases

Phases 0–12 are all implemented (2026-09-05 → 2026-09-08). Later work was committed in batches without phase numbers.

| Phase | Content | Done |
|---|---|---|
| 0 | Small fixes — stamina gauge position, ADS camera shoulder offset | 2026-09-05 |
| 1 | **Weapon package** — durability · grades I–V · 5 ammo types · 2 primaries + secondary · sockets/attachments · bags | 2026-09-05 |
| 2 | **Death/revive · wheel slots · grenade cooking** — downed/revive, 8-way quick use, pin-pull cooking | 2026-09-06 |
| 3 | **Ship calls (stratagems) · off-screen indicators** — orbital strike · air bomb · supply · structures | 2026-09-06 |
| 4 | **Humanoid enemies (rogues) · enemy gimmicks · corpse looting** — artillery · toxic bug · giant shell · boss rogue · faction hostility | 2026-09-06 |
| 5 | **Meta progression** — ship stash · loadout persistence · XP/level/stats · 4 corporations · trust · contracts · quests | 2026-09-06 |
| 6 | **Dev console · unique weapons · ship decoration** — cheat console, 6 uniques, 10 rooms + housing mode | 2026-09-06 |
| 7 | **Known follow-ups** — server profile/raid sessions, disconnect grace · ghosts · host migration, crate search | 2026-09-06 |
| 8 | **UI/UX pass** — unified Tab screen, greenhouse (smart farm), ship management, auto doors | 2026-09-06 |
| 9 | **Known follow-ups II** — profile timestamp merge, late-join sync, delta enemy snapshots, library · training-range target mode | 2026-09-07 |
| 10 | **UI improvements** — in-game cursor, hand-held barrier, corpse drop/loot chance, light pillars, launch-ready panel, carrying | 2026-09-07 |
| 11 | **Planet select · social** — 5-planet terminal + warp cutscene, player IDs · friends · invites · whispers · community | 2026-09-07 |
| 12 | **Implant items · barrier/recon rework · bullet tracking · UX cleanup** | 2026-09-08 |

**Two rollbacks** (both Phase 10, 2026-09-07): the chibi (3-heads-tall) character model was rejected on look and reverted,
and the synthetic-event soft cursor was reverted to the real OS cursor. Details: `src/ui/README.md` Decisions.
