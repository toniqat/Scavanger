@echo off
setlocal
cd /d "%~dp0"
title SCAVANGER - 서버

echo ==========================================================
echo   SCAVANGER 서버
echo   릴레이 : ws://localhost:8787/ws   (멀티플레이)
echo   웹     : http://localhost:5273    (게임 페이지)
echo ==========================================================
echo.

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

echo [실행] npm run dev:all   -   종료하려면 이 창에서 Ctrl+C
echo        서버가 뜨면 start-game.bat 으로 게임을 여세요.
echo.
call npm run dev:all

echo.
echo 서버가 종료되었습니다.
pause
exit /b 0
