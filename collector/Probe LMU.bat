@echo off
title RaceStrategy - LMU probe
rem With LMU open and inside a session: saves what LMU sends to logs\lmu-probe-*.json
rem so the field names can be checked.
set "HERE=%~dp0"
cd /d "%HERE%"
set "PY=%HERE%..\backend\env\Scripts\python.exe"
if not exist "%PY%" (
  echo Double-click "Start RaceStrategy.bat" once first: it prepares Python.
  pause
  exit /b 1
)
set PYTHONUNBUFFERED=1
"%PY%" lmu_collector.py --probe %*
pause
