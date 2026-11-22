@echo off
title Stop RaceStrategy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\start.ps1" -Stop
ping -n 4 127.0.0.1 >nul
