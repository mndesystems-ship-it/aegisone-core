@echo off
setlocal
set "MNDE_ROOT=%~dp0.."
if not defined MNDE_CLIENT_PRIVATE_KEY set "MNDE_CLIENT_PRIVATE_KEY=%MNDE_ROOT%\sidecar-local\client_ed25519_private.pem"
if not defined MNDE_CLIENT_KEY_ID set "MNDE_CLIENT_KEY_ID=local-client-1"
"%~dp0node\node.exe" "%MNDE_ROOT%\app\sidecar\example-client.js" %*

