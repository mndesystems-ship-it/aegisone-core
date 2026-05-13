$ErrorActionPreference = "Stop"

$bundleDir = Join-Path $PSScriptRoot "..\hyper-targeted-10m-bundle"
$vectorPath = Join-Path $bundleDir "parity_vectors_10m.json"
$rustOutputPath = Join-Path $bundleDir "rust_parity_output_10m.json"
$cargoManifest = Join-Path $PSScriptRoot "..\rust\parity_runner\Cargo.toml"

node --experimental-strip-types (Join-Path $PSScriptRoot "hyper_targeted_10m.ts") run
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

cargo run --quiet --release --manifest-path $cargoManifest -- $vectorPath | Set-Content -LiteralPath $rustOutputPath -NoNewline
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

node --experimental-strip-types (Join-Path $PSScriptRoot "hyper_targeted_10m.ts") finalize
exit $LASTEXITCODE
