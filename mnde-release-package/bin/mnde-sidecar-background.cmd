@echo off
setlocal
set "MNDE_ROOT=%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%MNDE_ROOT%\app\sidecar\start-background.ps1"

