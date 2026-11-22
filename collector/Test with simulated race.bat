@echo off
title RaceStrategy - simulated race
rem Fake multi-class race at 30x speed, written exactly like a real LMU session (no game needed).
rem Start RaceStrategy, refresh the page and pick the LMU session. Close this window to stop.
set "HERE=%~dp0"
cd /d "%HERE%"
set "PY=%HERE%..\backend\env\Scripts\python.exe"
if not exist "%PY%" (
  echo Double-click "Start RaceStrategy.bat" once first: it prepares Python.
  pause
  exit /b 1
)
set PYTHONUNBUFFERED=1
"%PY%" lmu_collector.py --simulate --speed 30 %*
pause
