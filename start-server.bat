@echo off
setlocal
cd /d "%~dp0"
title SCAVANGER - 서버

rem  인자 없음  : 릴레이 + 웹 (개발용, 브라우저로 http://localhost:5273 접속)
rem  relay      : 릴레이만  (데스크톱 앱 SCAVANGER.exe 배포용)
set "NPM_SCRIPT=dev:all"
set "MODE_LABEL=릴레이 + 웹 (개발용)"
set "WEB_LINE=  웹     : http://localhost:5273    (브라우저로 열기)"
if /i "%~1"=="relay" set "NPM_SCRIPT=server"
if /i "%~1"=="relay" set "MODE_LABEL=릴레이만 (데스크톱 앱 배포용)"
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
echo   친구들이 접속할 주소
echo     ws://%LANIP%:8787/ws
echo.
echo   SCAVANGER.exe 는 exe 옆의 server.txt 첫 줄을 읽습니다.
echo   빌드 기본값을 바꾸려면 electron\default-relay.txt 를 고친 뒤
echo   npm run app:build 를 다시 실행하세요.
echo.
echo %WEB_LINE%
echo   상태   : http://%LANIP%:8787/health
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
