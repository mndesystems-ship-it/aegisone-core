$ErrorActionPreference = "Stop"

$bundleDir = Join-Path $PSScriptRoot "..\audit-proof-bundle"
$proofBundleDir = Join-Path $bundleDir "proof_bundle"
$vectorPath = Join-Path $proofBundleDir "parity_vectors.json"
$rustOutputPath = Join-Path $proofBundleDir "rust_parity_output.json"
$cargoManifest = Join-Path $PSScriptRoot "..\rust\parity_runner\Cargo.toml"

$env:BUILD_TIMESTAMP_UTC = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$env:BUILD_NODE_VERSION = (node --version).Trim()
$env:BUILD_NPM_VERSION = (npm.cmd --version).Trim()
$env:BUILD_RUST_VERSION = (rustc --version).Trim()
$env:BUILD_OPERATING_SYSTEM = ((cmd /c ver) | Select-Object -Last 1).Trim()

node --experimental-strip-types (Join-Path $PSScriptRoot "emit_parity_vectors.ts")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

cargo run --quiet --release --manifest-path $cargoManifest -- $vectorPath | Set-Content -LiteralPath $rustOutputPath -NoNewline
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$env:RUST_PARITY_OUTPUT_PATH = $rustOutputPath
node --experimental-strip-types (Join-Path $PSScriptRoot "run.ts")
exit $LASTEXITCODE
