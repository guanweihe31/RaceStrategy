@echo off
title RaceStrategy
rem Double-click to start RaceStrategy. The first time it sets everything up (a few minutes).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\start.ps1"
if errorlevel 1 pause
