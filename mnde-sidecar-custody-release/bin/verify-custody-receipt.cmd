@echo off
setlocal
"%~dp0node\node.exe" "%~dp0..\app\release\verify-custody-receipt.js" %*
