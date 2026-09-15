@echo off
setlocal
cd /d "%~dp0"
title SCAVANGER - 서버

rem  SCAVANGER 서버는 이 파일로만 켭니다. 게임 빌드(SCAVANGER.exe)에는 서버가 들어 있지 않습니다.
rem  인자 없음  : 서버 + 웹 (개발용, 브라우저로 http://localhost:5273 접속)
rem  relay      : 서버만  (데스크톱 앱 SCAVANGER.exe 로만 할 때)
set "NPM_SCRIPT=dev:all"
set "MODE_LABEL=서버 + 웹 (개발용)"
set "WEB_LINE=  웹     : http://localhost:5273    (브라우저로 열기)"
if /i "%~1"=="relay" set "NPM_SCRIPT=server"
if /i "%~1"=="relay" set "MODE_LABEL=서버만 (데스크톱 앱용)"
if /i "%~1"=="relay" set "WEB_LINE=  웹     : 없음 - 브라우저로 하려면 인자 없이 실행하세요"

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다. https://nodejs.org 에서 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [준비] 의존성 설치 중... npm install
  call npm install
  echo.
)

set "LANIP="
for /f "usebackq delims=" %%A in (`node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\lan-address.mjs 2^>nul`) do set "LANIP=%%A"
if not defined LANIP set "LANIP=이_PC_의_IP"

echo ==========================================================
echo   SCAVANGER 서버  -  %MODE_LABEL%
echo.
echo   친구들이 접속할 주소  (게임의 설정 - 서버 설정 에 적습니다)
echo     ws://%LANIP%:8787/ws
echo.
echo   이 PC 의 SCAVANGER.exe 는 주소가 없으면 ws://127.0.0.1:8787/ws 에 붙습니다.
echo   배포본은 exe 옆의 server.txt 첫 줄을 읽습니다. 빌드 기본값을 바꾸려면
echo   electron\default-relay.txt 를 고친 뒤 npm run app:dist 를 다시 실행하세요.
echo.
echo %WEB_LINE%
echo   상태   : http://%LANIP%:8787/health
echo   저장   : server\data\
echo.
echo   이 창에 서버 명령을 칠 수 있습니다 (입력 후 Enter):
echo     list     접속 중인 사람         lobbies  열린 함선과 대원
echo     kick ^<아이디^> [사유]  내보내기    max ^<인원^>  접속 인원 제한 (0 = 무제한)
echo     gc       프로필 정리            help     명령 목록
echo ==========================================================
echo.
echo [실행] npm run %NPM_SCRIPT%   -   종료하려면 이 창에서 Ctrl+C
echo        처음 실행하면 Windows 방화벽 허용 창이 뜹니다. 허용해야 다른 PC 가 붙습니다.
echo.
call npm run %NPM_SCRIPT%

echo.
echo 서버가 종료되었습니다.
pause
exit /b 0
