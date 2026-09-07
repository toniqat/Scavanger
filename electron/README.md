# `electron/` — 데스크톱(스탠드얼론) 셸

브라우저 없이 실행되는 SCAVANGER 데스크톱 앱. **게임 코드(`src/`)와 릴레이(`server/`)는 한 줄도 고치지 않는다** —
Electron 은 이미 있는 두 조각을 한 프로세스에 담는 껍데기다.

```
Electron main process
├─ startRelayServer()          server/RelayServer.ts (임베디드 릴레이, 127.0.0.1)
├─ attachStatic(relay.http)    dist/ (vite 빌드) 를 같은 http 서버에서 서빙
└─ BrowserWindow → http://127.0.0.1:<port>/
                     └─ 렌더러는 same-origin `/ws` 로 릴레이에 붙는다 (NetSystem.defaultUrl() 그대로)
```

## 왜 `file://` 이 아니라 로컬 http 인가
`NetSystem.defaultUrl()` 은 `VITE_WS_URL` 이 없으면 `ws://${location.host}/ws` 를 쓴다. `file://` 로 띄우면
`location.host` 가 비어 릴레이 주소가 만들어지지 않으므로, 빌드 타임 `VITE_WS_URL` 이나 preload 주입 같은
클라이언트 변경이 필요해진다. 릴레이가 이미 http 서버를 갖고 있으니 **그 위에서 정적 파일까지 서빙**하면
vite 프록시와 완전히 같은 그림이 되고, `src/` 는 손대지 않아도 된다. 프로필 · 레이드 세션 · 소셜 저장소가
오프라인에서도 그대로 동작하는 것도 같은 이유다.

## 파일

| 파일 | 역할 |
|---|---|
| `main.ts` | 앱 수명주기. 옵션 파싱 → 릴레이(또는 프록시) 기동 → `BrowserWindow`. 단일 인스턴스 락, 메뉴 제거, **F11 전체화면**, 창 상태 추적, `pointerLock` / `fullscreen` 만 허용하는 권한 핸들러, 외부 링크는 기본 브라우저로, `dist/` 가 없으면 안내 다이얼로그. |
| `static.ts` | `attachStatic(server, root)` — 기존 http 서버의 `request` 리스너를 가로채 정적 파일을 먼저 서빙하고, 못 찾으면 원래 핸들러(릴레이의 `/health` + 404)로 넘긴다. 경로 이탈(`..`) 차단, `cache-control: no-cache`. |
| `wsProxy.ts` | `--relay=<url>` 전용. `/ws` 업그레이드를 원격 릴레이로 **raw 소켓 파이프**. 세션 쿼리(`?t=&n=`)까지 그대로 통과. |
| `windowState.ts` | `<userData>/window-state.json` 에 크기 · 위치 · 최대화 · 전체화면 저장/복원. 저장된 모니터가 사라졌으면 위치를 버린다. |
| `build.mjs` | `main.ts` + 임베디드 릴레이를 `dist-electron/main.js` 로 번들. **rolldown**(vite 의존성이라 새 패키지가 필요 없다)을 쓰고 `electron` / `ws` 는 external. |
| `tsconfig.json` | `electron/` + `server/` 를 함께 타입 체크 (`npm run typecheck:app`). |

`server/` 는 `--experimental-strip-types` 로 도는 erasable TypeScript 인데 Electron 메인 프로세스에는 그 로더가
없다. 그래서 배포 빌드는 번들해서 넣는다(`build.mjs`).

## 명령
```
npm run app:build    # vite 빌드(dist/) + 메인 프로세스 번들(dist-electron/)
npm run app          # 빌드된 결과로 데스크톱 앱 실행
npm run app:dist     # app:build + electron-builder → release/SCAVANGER-<version>-portable.exe (무설치)
npm run typecheck:app
```
`npm run dev` / `npm run dev:all` 브라우저 흐름은 그대로다 — 스모크 · e2e 는 전부 vite 를 본다.

## 실행 옵션 (플래그 = 환경변수, 플래그 우선)

| 옵션 | 환경변수 | 뜻 |
|---|---|---|
| `--port=<n>` | `SCAV_PORT` | 릴레이 + http 포트 (기본 `NET_DEFAULT_PORT` 8787, 사용 중이면 빈 포트로 폴백) |
| `--lan` | `SCAV_LAN=1` | `0.0.0.0` 바인딩 — 같은 네트워크의 다른 PC 가 이 릴레이를 쓸 수 있다(방화벽 허용 창이 뜬다) |
| `--relay=<ws url>` | `SCAV_RELAY` | 자체 릴레이를 띄우지 않고 `/ws` 를 원격 릴레이로 프록시 (`--relay=ws://192.168.0.5:8787/ws`) |
| `--devtools` | `SCAV_DEVTOOLS=1` | DevTools 활성화 (기본 비활성) |

같이 하려면: 호스트가 `SCAVANGER.exe --lan`, 나머지가 `SCAVANGER.exe --relay=ws://<호스트IP>:8787/ws`.

## 알아둘 것
- 렌더러가 `127.0.0.1` 에서 로드되므로 `isDevHost()` 가 **true** 다 → 백틱(`` ` ``) 개발자 콘솔과 치트가 패키징된
  앱에서도 열린다. 끄려면 `src/shared/console.ts` 의 `DEV_HOSTS` 판정을 바꿔야 한다(현재는 브라우저 로컬 플레이와
  동일한 동작을 유지).
- 프로필 · 레이드 세션은 `%APPDATA%/SCAVANGER/relay-data/profiles.json`, 창 상태는 같은 폴더의
  `window-state.json`. localStorage(스태시 · 로드아웃 · 함선 · 키설정)는 Electron 세션 저장소에 들어간다 —
  **브라우저에서 하던 세이브와 공유되지 않는다.**
- 아이콘은 Electron 기본값이다. 프로젝트 규칙상 에셋 파일을 두지 않으므로 `.ico` 를 추가하지 않았다
  (`build.directories.buildResources = electron/resources` 에 `icon.ico` 를 넣으면 그때부터 잡힌다).
- 두 번째 실행은 단일 인스턴스 락에 막혀 기존 창을 포커스한다. 그래서 한 PC 에서 2인 테스트를 하려면
  브라우저 탭 쪽(`npm run dev:all`)을 쓰는 편이 낫다.
- `--relay` 프록시는 바이트 파이프라서 릴레이가 죽으면 소켓만 끊긴다(클라이언트의 자동 재접속이 처리한다).

## 검증 (2026-09-07)
- `npm run typecheck` / `typecheck:server` / `typecheck:app` 0 errors, `npm run net:selftest` 278/278.
- 개발 실행(`npm run app`)과 **패키징된 portable exe** 양쪽을 CDP 로 붙어 확인: `http://127.0.0.1:<port>/` 로드,
  WebGL 이 실제 GPU(ANGLE D3D11, RTX 4070 SUPER), `window.__game.ctx` 존재, 타이틀 → `함선 탑승` → phase `hub`,
  릴레이 `/health` 의 `clients: 1` · `profiles: 1`, 페이지/콘솔 에러 0.
