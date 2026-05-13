$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..\..")
$node = Join-Path $root "bin\node\node.exe"
$server = Join-Path $root "app\sidecar\server.js"

if (-not $env:MNDE_LOCAL_DIR) {
    $env:MNDE_LOCAL_DIR = Join-Path $root "sidecar-local"
}

& $node (Join-Path $root "app\sidecar\create-local-fixtures.js") $env:MNDE_LOCAL_DIR | Out-Null

if (-not $env:MNDE_BIND_ADDR) {
    $env:MNDE_BIND_ADDR = "127.0.0.1:8787"
}
if (-not $env:MNDE_POLICY_FILE) {
    $env:MNDE_POLICY_FILE = Join-Path $env:MNDE_LOCAL_DIR "policy.v1.signed.json"
}
if (-not $env:MNDE_CLIENT_KEYS) {
    $env:MNDE_CLIENT_KEYS = Join-Path $env:MNDE_LOCAL_DIR "client_keys.json"
}
if (-not $env:MNDE_CLIENT_PRIVATE_KEY) {
    $env:MNDE_CLIENT_PRIVATE_KEY = Join-Path $env:MNDE_LOCAL_DIR "client_ed25519_private.pem"
}
if (-not $env:MNDE_RECEIPT_LOG) {
    $env:MNDE_RECEIPT_LOG = Join-Path $env:MNDE_LOCAL_DIR "receipts.jsonl"
}
if (-not $env:MNDE_SIDECAR_LOG) {
    $env:MNDE_SIDECAR_LOG = Join-Path $env:MNDE_LOCAL_DIR "sidecar.jsonl"
}
if (-not $env:MNDE_PINNED_POLICY_VERSION) {
    $env:MNDE_PINNED_POLICY_VERSION = "policy.v1"
}

$process = Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $root -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 500
if ($process.HasExited) {
    throw "MNDe sidecar exited during startup with code $($process.ExitCode)"
}

Write-Output "MNDe sidecar started: pid=$($process.Id) bind=$env:MNDE_BIND_ADDR"

