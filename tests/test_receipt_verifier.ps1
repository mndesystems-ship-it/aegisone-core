$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Cases = @(
  @{ File = "valid-receipt.json"; Code = 0; Text = "FINAL VERDICT: VERIFIED" },
  @{ File = "invalid-signature.json"; Code = 1; Text = "Signature: FAIL" },
  @{ File = "invalid-request-hash.json"; Code = 1; Text = "Request Hash: FAIL" },
  @{ File = "invalid-decision-hash.json"; Code = 1; Text = "Decision Hash: FAIL" },
  @{ File = "invalid-policy-hash.json"; Code = 1; Text = "Policy Hash: FAIL" },
  @{ File = "corrupted-json.json"; Code = 1; Text = "Schema: FAIL" },
  @{ File = "missing-field.json"; Code = 1; Text = "Schema: FAIL" }
)

function Fail([string]$Message) {
  Write-Host "[FAIL] $Message"
  exit 1
}

foreach ($case in $Cases) {
  $receipt = Join-Path "tests\receipts" $case.File
  $output = & node .\tools\verify-receipt.mjs $receipt 2>&1
  $exitCode = $LASTEXITCODE
  $text = $output -join "`n"
  if ($exitCode -ne $case.Code) {
    Fail "$($case.File) expected exit $($case.Code), got $exitCode`n$text"
  }
  if ($text -notmatch [regex]::Escape($case.Text)) {
    Fail "$($case.File) missing expected text '$($case.Text)'`n$text"
  }
  if ($case.Code -eq 0) {
    foreach ($line in @(
      "Schema: PASS",
      "Canonicalization: PASS",
      "Request Hash: PASS",
      "Decision Hash: PASS",
      "Policy Hash: PASS",
      "Signature: PASS",
      "Replay Determinism: PASS"
    )) {
      if ($text -notmatch [regex]::Escape($line)) {
        Fail "$($case.File) missing expected text '$line'`n$text"
      }
    }
  } elseif ($text -notmatch "FINAL VERDICT: FAILED") {
    Fail "$($case.File) did not fail closed`n$text"
  }
}

Write-Host "PASS receipt verifier tests"
