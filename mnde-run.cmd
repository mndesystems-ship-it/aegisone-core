@echo off
setlocal
set SCRIPT_DIR=%~dp0
if "%MNDE_NODE%"=="" (
  set MNDE_NODE=node
)
"%MNDE_NODE%" "%SCRIPT_DIR%mnde-run.mjs" %*
exit /b %ERRORLEVEL%
