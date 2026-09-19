/**
 * 2026-09-11 — **moved to `@/shared`** (`src/shared/lightPool.ts`), because the planet's abandoned structures
 * (`world/Structures`) took the same light pool and the two folders then held the same code (CLAUDE.md: the same
 * formula in two folders moves to `shared`). This file only re-exports, so the ship interiors' import paths stay.
 */
export { LightPool, type LightFixture } from '@/shared';
