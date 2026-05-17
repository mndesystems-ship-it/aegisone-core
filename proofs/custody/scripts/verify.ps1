Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
Set-Location $repoRoot
npm run test:custody
node --experimental-strip-types .\scripts\test_custody_audit_hardening.mjs
