@echo off
setlocal
set "MNDE_ROOT=%~dp0.."
if not defined MNDE_LOCAL_DIR set "MNDE_LOCAL_DIR=%MNDE_ROOT%\sidecar-local"
"%~dp0node\node.exe" "%MNDE_ROOT%\app\sidecar\create-local-fixtures.js" "%MNDE_LOCAL_DIR%" > nul
if not defined MNDE_BIND_ADDR set "MNDE_BIND_ADDR=127.0.0.1:8787"
if not defined MNDE_POLICY_FILE set "MNDE_POLICY_FILE=%MNDE_LOCAL_DIR%\policy.v1.signed.json"
if not defined MNDE_CLIENT_KEYS set "MNDE_CLIENT_KEYS=%MNDE_LOCAL_DIR%\client_keys.json"
if not defined MNDE_CLIENT_PRIVATE_KEY set "MNDE_CLIENT_PRIVATE_KEY=%MNDE_LOCAL_DIR%\client_ed25519_private.pem"
if not defined MNDE_RECEIPT_LOG set "MNDE_RECEIPT_LOG=%MNDE_LOCAL_DIR%\receipts.jsonl"
if not defined MNDE_SIDECAR_LOG set "MNDE_SIDECAR_LOG=%MNDE_LOCAL_DIR%\sidecar.jsonl"
if not defined MNDE_PINNED_POLICY_VERSION set "MNDE_PINNED_POLICY_VERSION=policy.v1"
"%~dp0node\node.exe" "%MNDE_ROOT%\app\sidecar\server.js"
