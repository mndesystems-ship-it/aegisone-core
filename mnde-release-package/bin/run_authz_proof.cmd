@echo off
setlocal
"%~dp0node\node.exe" "%~dp0..\app\authz\proof.js" %*
