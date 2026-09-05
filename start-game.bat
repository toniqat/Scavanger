@echo off
setlocal
cd /d "%~dp0"
title SCAVANGER - 게임 시작

rem 사용법: start-game.bat [URL]   기본값 http://localhost:5273
set "URL=http://localhost:5273"
if not "%~1"=="" set "URL=%~1"

echo [확인] 서버 응답을 기다리는 중: %URL%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%URL%'; for($i=0;$i -lt 30;$i++){ try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Seconds 1 } }; exit 1"

if errorlevel 1 (
  echo.
  echo [경고] %URL% 에 연결하지 못했습니다. start-server.bat 을 먼저 실행하세요.
  echo.
  pause
  exit /b 1
)

echo [실행] 브라우저 새 탭으로 여는 중: %URL%
start "" "%URL%"
exit /b 0
