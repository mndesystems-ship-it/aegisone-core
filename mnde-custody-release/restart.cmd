@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lifecycle\restart.ps1" %*
