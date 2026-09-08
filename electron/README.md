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

릴레이 주소가 **설정되어 있으면** 자체 릴레이를 띄우는 대신 그 주소로 `/ws` 를 프록시한다(아래 "릴레이 주소").
배포본은 보통 이쪽이다 — 한 사람이 `start-server.bat` 으로 서버를 켜고 나머지는 exe 만 실행한다.

```
Electron main process (프록시 모드)
├─ createServer()              빈 포트 (릴레이 포트를 뺏지 않는다)
├─ attachStatic(server)        dist/
├─ attachWsProxy(server, 목적지)  /ws 업그레이드를 원격 릴레이로 파이프
└─ BrowserWindow → http://127.0.0.1:<free port>/
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
| `main.ts` | 앱 수명주기. 옵션 파싱 → 릴레이(또는 프록시) 기동 → `BrowserWindow`. 단일 인스턴스 락, 메뉴 제거, **F11 전체화면**, **Escape 가로채기 + 재잠금**(아래 "Escape"), 창 상태 추적, `pointerLock` / `fullscreen` 만 허용하는 권한 핸들러, 외부 링크는 기본 브라우저로, `dist/` 가 없으면 안내 다이얼로그. |
| `static.ts` | `attachStatic(server, root)` — 기존 http 서버의 `request` 리스너를 가로채 정적 파일을 먼저 서빙하고, 못 찾으면 원래 핸들러(릴레이의 `/health` + 404)로 넘긴다. 경로 이탈(`..`) 차단, `cache-control: no-cache`. |
| `wsProxy.ts` | `--relay=<url>` 전용. `/ws` 업그레이드를 원격 릴레이로 **raw 소켓 파이프**. 세션 쿼리(`?t=&n=`)까지 그대로 통과. |
| `windowState.ts` | `<userData>/window-state.json` 에 크기 · 위치 · 최대화 · 전체화면 저장/복원. 저장된 모니터가 사라졌으면 위치를 버린다. |
| `build.mjs` | `main.ts` + 임베디드 릴레이를 `dist-electron/main.js` 로 번들. **rolldown**(vite 의존성이라 새 패키지가 필요 없다)을 쓰고 `electron` / `ws` 는 external. `default-relay.txt` 의 주소를 `transform.define` 으로 `__SCAV_DEFAULT_RELAY__` 에 굽는다(`define` 은 최상위가 아니라 `transform` 아래다 — 최상위에 두면 경고만 내고 조용히 무시된다). |
| `default-relay.txt` | 배포본이 기본으로 접속할 릴레이 주소 **한 줄**. 빌드 타임에 구워지고, electron-builder `extraFiles` 로 exe 옆에 `relay.txt` 라는 이름으로도 복사된다 — 그래서 받은 사람이 재빌드 없이 주소를 고칠 수 있다. |
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

### `electronDist` 는 지우지 않는다

`package.json` 의 `build.electronDist = "node_modules/electron/dist"` 는 **필수 설정이다.**
없으면 electron-builder 가 electron 을 새로 내려받아 `release/win-unpacked.tmp` 에 320 MB 를 푼 직후
`win-unpacked` 로 폴더 이름을 바꾸는데, 이 rename 이 EDR(SentinelOne) 의 정적 스캐너가 갓 풀린
246 MB `electron.exe` 를 붙잡고 있는 사이에 걸려 **매번** 터진다:

```
⨯ EPERM: operation not permitted, rename '…\release\win-unpacked.tmp' -> '…\release\win-unpacked'
```

권한 문제가 아니다 — 같은 자리의 다른 폴더도, 그 폴더 **안의** 파일도 전부 이름이 바뀐다.
잠기는 것은 최상위 `.tmp` 폴더 하나뿐이고, 몇 분 뒤 스캔이 끝나면 풀린다(재시도로는 못 넘긴다).

`electronDist` 를 주면 electron-builder 가 다운로드 · 압축 해제 · rename 경로를 통째로 건너뛰고
`node_modules/electron/dist`(npm 이 이미 풀어둔, 이미 스캔이 끝난 것과 같은 버전)를 **복사만** 한다
(`app-builder-lib` 의 `ElectronFramework` → `unpack()` 의 "custom unpacked Electron distribution" 분기).
경합할 창이 사라지고 빌드도 빨라진다.

대가는 그 분기가 `shouldCleanup = false` 라서 정리 단계를 건너뛴다는 것 — 산출물에
`resources/default_app.asar`(111 KB)과 `version`(6 바이트)이 남는다. `app.asar` 이 우선하므로 동작에는
영향이 없고 exe 는 +115 KB 다. `LICENSE → LICENSE.electron.txt` 이름 변경은 그대로 수행된다.

## 릴레이 주소

**어느 릴레이에 붙을지**는 아래 순서로 정해진다. 먼저 걸리는 것이 이긴다.

| # | 출처 | 쓰는 곳 |
|---|---|---|
| 1 | `--relay=<주소>` | 일회성 실행 · 테스트 |
| 2 | `SCAV_RELAY` 환경변수 | 스크립트 · 바로가기 |
| 3 | exe 옆의 `relay.txt` 첫 줄 | **받은 사람이 재빌드 없이** 주소를 고칠 때 |
| 4 | 빌드에 구워진 값 (`electron/default-relay.txt`) | 배포본의 기본값 |
| 5 | 아무것도 없음 | 자체 릴레이를 띄운다 (오프라인 · 단독 실행) |

`relay.txt` 는 주석(`#`)과 빈 줄을 뺀 첫 줄을 읽고, `ws://주소:포트/ws` · `주소:포트` · `주소` 를 모두 받는다
(포트와 `/ws` 는 채워 준다). BOM 은 벗겨 낸다 — 메모장이 UTF-8 로 저장하면 첫 줄이 주석으로 안 보이기 때문이다.
찾는 위치는 `PORTABLE_EXECUTABLE_DIR`(portable exe 를 **둔** 폴더) → `process.execPath` 의 폴더 → `cwd` 순이다.

주소를 바꾸려면 `electron/default-relay.txt` 한 줄을 고치고 `npm run app:build`. 환경변수를 쓰고 싶으면
`SCAV_DEFAULT_RELAY=ws://… npm run app:dist` 가 그 파일을 덮어쓴다.

## 실행 옵션 (플래그 = 환경변수, 플래그 우선)

| 옵션 | 환경변수 | 뜻 |
|---|---|---|
| `--port=<n>` | `SCAV_PORT` | 릴레이 + http 포트 (기본 `NET_DEFAULT_PORT` 8787, 사용 중이면 빈 포트로 폴백). **프록시 모드에서는 지정하지 않으면 빈 포트를 쓴다** — 로컬 http 서버가 릴레이 포트를 뺏으면 자기 자신에게 프록시하게 된다 |
| `--lan` | `SCAV_LAN=1` | 자체 릴레이를 `0.0.0.0` 에 바인딩 — 같은 네트워크의 다른 PC 가 이 릴레이를 쓸 수 있다(방화벽 허용 창이 뜬다) |
| `--relay=<ws url>` | `SCAV_RELAY` | 자체 릴레이를 띄우지 않고 `/ws` 를 원격 릴레이로 프록시 (`--relay=ws://192.168.0.5:8787/ws`) |
| `--local` | `SCAV_LOCAL=1` | 설정된 주소를 **전부 무시**하고 자체 릴레이로 실행 (혼자 플레이 · 서버가 꺼져 있을 때) |
| `--devtools` | `SCAV_DEVTOOLS=1` | DevTools 활성화 (기본 비활성) |

같이 하려면 — 서버를 켜는 사람이 저장소 루트의 `start-server.bat` (릴레이만 원하면 `start-server.bat relay`),
나머지는 그냥 `SCAVANGER.exe`. (게임을 여는 `start-game.bat` 은 **2026-09-08 에 삭제**했다: 배포본은 exe 로,
개발은 `npm run dev` 로 연다. `start-server.bat` 은 서버 전용으로 남는다.) 배너에 찍힌 `ws://<IP>:8787/ws` 가 `default-relay.txt` / `relay.txt` 에 적을 값이다.
저장소가 없는 PC 라면 `SCAVANGER.exe --lan` 이 그 자리를 대신한다.

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
- **서버를 먼저 켜고 게임을 켜는 편이 좋다.** 릴레이가 없는 상태로 들어가면 개인 함선에 오프라인으로 서고,
  다시 붙으려면 터미널의 `신호 찾기`(`ensureConnected` 재시도)를 누르거나 앱을 다시 켜야 한다.
- 프로필 · 크레딧 · 소셜 아이디는 **접속한 릴레이**에 저장된다. 남의 서버에서 놀다가 `--local` 로 혼자 켜면
  그 PC 의 임베디드 릴레이가 가진 별개의 프로필을 보게 된다(스태시 · 로드아웃은 localStorage 에도 있어 대개 이어진다).

## 검증 (2026-09-07, 릴레이 주소 설정 추가)
- `typecheck` / `typecheck:server` / `typecheck:app` 0 errors, `app:build` 가 `ws://…/ws` 를 번들에 구운 것을 확인.
- 빌드된 앱을 CDP 로 4가지 경로 확인: 플래그 없이 → `(build default)` 로 LAN 릴레이 접속, `relay.txt` 가
  구운 값을 이김(로그에 파일 경로), `--local` 이 둘 다 무시하고 임베디드 릴레이 기동, 프록시 모드가 8787 대신
  빈 포트를 잡는다(같은 PC 의 릴레이를 8787 로 가리켜도 정상 접속 — 고치기 전에는 자기 자신으로 프록시됐다).
- 패키징된 `win-unpacked` 두 벌을 실제 LAN IP 로 붙여 15/15: 각자 다른 PeerId → 신호 찾기 → 같은 분대 →
  목표 행성 전파 → 같은 시드 · 같은 행성으로 발사 → 양쪽 스냅샷 수신.

## 검증 (2026-09-07)
- `npm run typecheck` / `typecheck:server` / `typecheck:app` 0 errors, `npm run net:selftest` 278/278.
- 개발 실행(`npm run app`)과 **패키징된 portable exe** 양쪽을 CDP 로 붙어 확인: `http://127.0.0.1:<port>/` 로드,
  WebGL 이 실제 GPU(ANGLE D3D11, RTX 4070 SUPER), `window.__game.ctx` 존재, 타이틀 → `함선 탑승` → phase `hub`,
  릴레이 `/health` 의 `clients: 1` · `profiles: 1`, 페이지/콘솔 에러 0.


## Escape (Phase 12, 2026-09-08)

브라우저에서는 Escape 로 화면을 닫으면 포인터 락이 **바로 돌아오지 않는다** — Chrome 이 Escape 에 사용자 활성화를
주지 않아 재잠금 요청이 거부되고, 게임은 `src/game/ResumeGate.ts` 의 `좌측 클릭으로 게임 재개` 게이트로 답한다.
셸은 **메인 프로세스가 페이지에 활성화를 줄 수 있으므로** 더 잘할 수 있다. `main.ts` 의 `handleEscape` 가
`before-input-event` 에서 Escape **key-up** 을 보면 `executeJavaScript(SHELL_RELOCK, true)` 를 실행한다 — 두 번째
인자가 "사용자 제스처로 실행"이고, 그것이 `requestPointerLock()` 이 요구하는 활성화다. 페이지 쪽 훅
(`window.__scavShellRelock`, `src/game/ResumeGate.ts`)은 두 프레임 기다렸다가(그 Escape 로 닫힌 화면이 커서 모드를
놓을 시간) 커서 소유자가 없을 때만 락을 요청한다.

**키 자체는 건드리지 않는다** — `preventDefault` 도, 합성 Escape 전달도 없다. 처음에는 둘 다 넣었다가 측정 후
뺐다(아래). `--raw-escape` / `SCAV_RAW_ESCAPE=1` 이면 훅까지 끈다(진단용, Phase 12 이전 동작).

### 실측 (2026-09-08) — 무엇이 확인됐고 무엇이 확인 안 됐는지

`npm run app:build` 결과물을 `--remote-debugging-port=9333` 으로 띄우고 CDP 로 구동해
`--raw-escape` 와 기본값을 같은 시나리오(아무 것도 안 열린 상태의 Escape / 페이지가 Escape 를 삼키는 경우 /
Tab → Escape / Tab → Tab)로 비교했다.

**확인된 것**
- **합성 Escape 전달은 해롭다**: 처음 구현(`preventDefault` + 페이지에 합성 Escape 던지기)에서는 한 번 누를 때마다
  페이지가 Escape 를 **두 번** 받았다(`keydown` 카운터 2). Electron 의 `before-input-event` `preventDefault` 가
  CDP 로 주입된 키의 페이지 전달을 막지 못했기 때문이다. 화면 두 개가 한 번에 닫힐 수 있으므로 전달을 걷어냈고,
  지금은 두 변종 모두 한 번 누르면 정확히 한 번 도착한다.
- **커서 규칙**은 실제 셸에서 그대로 동작한다: 함선에서 락 보유 → `body.desktop-nocursor` 있음, Escape 로 일시정지가
  뜨면 없음, 닫으면 다시 있음, Tab 인벤토리에서 없음, 닫으면 있음. **재개 게이트는 한 번도 뜨지 않았다.**
- 훅 자체(`window.__scavShellRelock`)는 설치되어 있고 커서 소유자가 없을 때만 락을 다시 잡는다 —
  `scripts/smoke-resume-gate.mjs` §8 이 브라우저에서 이 함수를 직접 호출해 검증한다.

**확인 안 된 것 (자동화의 한계)**
- CDP 로 주입한 Escape 는 Chromium 의 exclusive-access 경로를 **타지 않는다**: 락을 유지한 채 페이지에 그대로
  전달되고, 재잠금도 활성화가 있는 것처럼 곧바로 성공한다(그래서 `--raw-escape` 와 기본값의 결과가 같다).
- 반대로 진짜 키(PowerShell `SendKeys '{ESC}'`)는 이 환경에서 앱 창에 들어가지 않았다(페이지의 Escape 카운터가
  두 변종 모두 0). 따라서 **"진짜 Escape 를 눌렀을 때 셸이 브라우저보다 빨리 락을 되찾는다"는 것은 자동화로
  증명하지 못했다.** 훅은 활성화가 필요한 정확한 자리에 있고 부작용이 없다는 것까지가 측정된 범위다.

셸에서는 또 **커서가 필요 없을 때 항상 숨는다**: 게임플레이 / 함선 페이즈이고 커서 소유자가 없으면
`<body class="desktop-nocursor">` → `cursor: none !important` (락 보유 여부와 무관). Alt 커서도 소유자이므로 그때는
보인다. 재개 게이트는 셸에서 **절대** 뜨지 않는다(`isDesktopShell()`).

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../docs/HISTORY.md) 에 있다.

- **2026-09-08** — `package.json` 에 `build.electronDist = "node_modules/electron/dist"` 추가.
  electron-builder 의 다운로드 → 압축 해제 → `win-unpacked.tmp` rename 경로가 EDR 파일 잠금과 경합해
  `npm run app:dist` 가 매번 `EPERM … rename` 으로 죽던 것을 복사 경로로 우회한다 (위 `electronDist` 절).
- **Phase 12 (2026-09-08)** — `handleEscape` 가 Escape **key-up** 에서 `executeJavaScript(SHELL_RELOCK, true)`(사용자 제스처 실행)로 페이지의 `__scavShellRelock` 을 불러 셸에서 재잠금을 시도한다 — 키 자체는 건드리지 않는다(`preventDefault` + 합성 Escape 전달은 페이지가 키를 **두 번** 받게 만드는 것이 측정으로 확인되어 걷어냈다), `--raw-escape` / `SCAV_RAW_ESCAPE` 로 끌 수 있다; `start-game.bat` 삭제(실행은 `SCAVANGER.exe` 또는 `npm run dev`)
