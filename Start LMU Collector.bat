@echo off
title RaceStrategy - LMU live collector
rem Records Le Mans Ultimate timing live into backend\data\raw\LMU\ (open LMU first).
rem Leave this window open during the session. Every lap is saved as soon as it is completed.
set "HERE=%~dp0"
cd /d "%HERE%"
set "PY=%HERE%backend\env\Scripts\python.exe"
if not exist "%PY%" (
  echo Double-click "Start RaceStrategy.bat" once first: it prepares Python.
  pause
  exit /b 1
)
set PYTHONUNBUFFERED=1
"%PY%" collector\lmu_collector.py --record %*
pause
