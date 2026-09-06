# src/meta — 기업 · 신뢰도 · 계약 · 퀘스트 · 크레딧 (`MetaSystem`)

**스켈레톤 (2026-09-06, Phase 5 계약 커밋).** `ctx.meta` (`MetaRef`, `src/shared/meta.ts`) 를 중립값으로 게시한다.
실제 구현(저장, 규칙, 상점, 기업 화면 DOM)은 `docs/PHASE5-PLAN.md` 8절의 브리프대로 이 폴더의 에이전트가 채운다.

| File | Purpose |
|---|---|
| `MetaSystem.ts` | `GameSystem` (`name: 'meta'`) + `MetaRef` 스텁. `main.ts` 에서 `InventorySystem` 다음에 등록. |
| `index.ts` | Barrel. |
