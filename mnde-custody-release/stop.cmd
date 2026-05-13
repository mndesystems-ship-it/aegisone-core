@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lifecycle\stop.ps1" %*
