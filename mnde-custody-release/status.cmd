@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lifecycle\status.ps1" %*
