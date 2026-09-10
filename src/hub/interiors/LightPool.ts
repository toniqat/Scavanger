/**
 * 2026-09-11 — **`@/shared` 로 옮겼다** (`src/shared/lightPool.ts`). 행성의 버려진 구조물(`world/Structures`)이 같은
 * 광원 풀을 쓰게 되면서 두 폴더가 같은 코드를 갖게 됐기 때문이다 (CLAUDE.md: 같은 것을 두 폴더가 쓰면 shared 로 뽑는다).
 * 함선 인테리어의 import 경로를 바꾸지 않으려고 이 파일은 다시 내보내기만 한다.
 */
export { LightPool, type LightFixture } from '@/shared';
