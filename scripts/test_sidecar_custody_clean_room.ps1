param(
  [string]$ZipPath = "C:\Users\Shadow\Downloads\INsol\INsol\mnde-sidecar-custody-release-v1.0.0-win32-x64.zip",
  [string]$CleanRoot = "C:\mnde-clean-test",
  [string]$RuntimeDir = "C:\mnde-clean-runtime",
  [switch]$SkipTaskkill
)

$ErrorActionPreference = "Stop"

function Set-Result($name, $value) {
  $script:report[$name] = $value
}

function Invoke-Step($name, [scriptblock]$body) {
  try {
    & $body
  } catch {
    $script:errors += [pscustomobject]@{ step = $name; error = $_.Exception.Message }
    throw
  }
}

function Write-Utf8NoBom($Path, $Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Stop-CleanRootNode {
  foreach ($file in @($script:sidecarPidFile, $script:mockSignerPidFile)) {
    if ($file -and (Test-Path -LiteralPath $file)) {
      Stop-Process -Id ([int](Get-Content -LiteralPath $file)) -Force -ErrorAction SilentlyContinue
    }
  }
  Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$CleanRoot*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

function Wait-HttpJson($Uri, [int]$Seconds = 8) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      return Invoke-RestMethod $Uri
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $deadline)
  throw "timed out waiting for $Uri"
}

function Start-Sidecar($ReleaseDir, $RuntimeDir, $SignerConfig, $OutName) {
  $args = @("--runtime-dir", $RuntimeDir, "--signer-config", $SignerConfig)
  $process = Start-Process -FilePath (Join-Path $ReleaseDir "bin\mnde-sidecar-custody.cmd") `
    -ArgumentList $args `
    -WorkingDirectory $ReleaseDir `
    -RedirectStandardOutput (Join-Path $RuntimeDir "$OutName.out.log") `
    -RedirectStandardError (Join-Path $RuntimeDir "$OutName.err.log") `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $script:sidecarPidFile -Value $process.Id -Encoding ASCII
  Start-Sleep -Milliseconds 800
  return $process
}

function Write-MockSignerTool($Path) {
  Write-Utf8NoBom $Path @'
import http from "node:http";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
}

function rawPublicKeyHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeSigner(id, endpoint, timeoutMs = 1000) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    signer: {
      id,
      mode: "external_http",
      endpoint,
      public_key: rawPublicKeyHex(publicKey),
      timeout_ms: timeoutMs,
      latency_target_ms: 5,
      latency_slo_ms: 15,
      enabled: true
    },
    key: privateKey.export({ format: "jwk" })
  };
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (process.argv.includes("--init")) {
  const runtimeDir = arg("--runtime-dir");
  const port = Number(arg("--port", "9797"));
  const keyringFile = path.join(runtimeDir, "mock-signer-keyring.json");
  const configFile = path.join(runtimeDir, "custody.signers.json");
  const normal = makeSigner("customer-prod-signer-1", `http://127.0.0.1:${port}/sign`);
  const timeout = makeSigner("timeout-signer", `http://127.0.0.1:${port}/timeout`, 50);
  const invalid = makeSigner("invalid-signer", `http://127.0.0.1:${port}/invalid`);
  writeJson(configFile, {
    key_set_version: "ksv_2026_01",
    signers: [normal.signer, timeout.signer, invalid.signer],
    threshold: 1
  });
  writeJson(keyringFile, {
    [normal.signer.id]: normal.key,
    [timeout.signer.id]: timeout.key,
    [invalid.signer.id]: invalid.key
  });
  process.stdout.write(JSON.stringify({ configFile, keyringFile, port }) + "\n");
  process.exit(0);
}

const runtimeDir = arg("--runtime-dir");
const port = Number(arg("--port", "9797"));
const keyring = readJson(path.join(runtimeDir, "mock-signer-keyring.json"));

function signedResponse(body, signerId, keySignerId = signerId) {
  const key = keyring[keySignerId];
  if (!key) return { status: 404, value: { error: "unknown signer" } };
  const signature = sign(null, Buffer.from(body.canonical_payload, "utf8"), createPrivateKey({ key, format: "jwk" })).toString("hex");
  return {
    status: 200,
    value: {
      signer_id: signerId,
      key_set_version: body.key_set_version,
      signature_algorithm: "ED25519",
      signature
    }
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await bodyJson(req);
    const finish = (result) => {
      const bytes = Buffer.from(JSON.stringify(result.value));
      res.writeHead(result.status, { "content-type": "application/json", "content-length": bytes.length });
      res.end(bytes);
    };
    if (url.pathname === "/timeout") {
      setTimeout(() => finish(signedResponse(body, body.signer_id)), 500);
      return;
    }
    if (url.pathname === "/invalid") {
      finish(signedResponse(body, body.signer_id, "customer-prod-signer-1"));
      return;
    }
    finish(signedResponse(body, body.signer_id));
  } catch (error) {
    const bytes = Buffer.from(JSON.stringify({ error: error.message }));
    res.writeHead(500, { "content-type": "application/json", "content-length": bytes.length });
    res.end(bytes);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
});
'@
}

$report = [ordered]@{
  verdict = "FAIL"
  release_verify = "FAIL"
  forbidden_artifacts = -1
  startup_without_signer_config = "FAIL"
  startup_with_external_signer = "FAIL"
  custody_config_hash_present = "FAIL"
  safe_decision = "FAIL"
  safe_signature_mode = "FAIL"
  risky_decision = "FAIL"
  risky_signature_mode = "FAIL"
  good_receipt_verify = "FAIL"
  tampered_receipt_refusal = "FAIL"
  unknown_signer_refusal = "FAIL"
  unknown_key_set_refusal = "FAIL"
  signer_timeout_refusal = "FAIL"
  invalid_signature_refusal = "FAIL"
  restart_ready = "FAIL"
  post_runtime_release_verify = "FAIL"
  release_mutation_changed_count = -1
  release_mutation_missing_count = -1
}
$errors = @()

$inputDir = Join-Path $CleanRoot "input"
$releaseDir = Join-Path $CleanRoot "release"
$zipName = Split-Path $ZipPath -Leaf
$cleanZip = Join-Path $inputDir $zipName
$script:sidecarPidFile = Join-Path $RuntimeDir "sidecar.pid"
$script:mockSignerPidFile = Join-Path $RuntimeDir "mock-signer.pid"
$signerConfig = Join-Path $RuntimeDir "custody.signers.json"
$mockSignerTool = Join-Path $RuntimeDir "mock-external-signer.mjs"

try {
  Stop-CleanRootNode
  if (-not $SkipTaskkill) {
    try {
      cmd /c "taskkill /IM node.exe /F >NUL 2>NUL"
    } catch {
      $null = $_
    }
  }

  foreach ($path in @($CleanRoot, $RuntimeDir)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -Recurse -Force -LiteralPath $path
    }
  }
  New-Item -ItemType Directory -Force -Path $inputDir, $releaseDir, $RuntimeDir | Out-Null
  Copy-Item -LiteralPath $ZipPath -Destination $cleanZip
  Expand-Archive -LiteralPath $cleanZip -DestinationPath $releaseDir -Force
  $node = Join-Path $releaseDir "bin\node\node.exe"

  Invoke-Step "verify-release" {
    $verify = & (Join-Path $releaseDir "bin\verify-release.cmd")
    if ($LASTEXITCODE -ne 0 -or $verify[0] -ne "PASS") { throw "verify-release failed" }
    Set-Result "release_verify" "PASS"
  }

  Invoke-Step "forbidden-scan" {
    Push-Location $releaseDir
    try {
      $scan = & $node --input-type=module -e "import { scanForbiddenContent } from './app/shared/forbidden_content.js'; console.log(JSON.stringify(scanForbiddenContent('.')));"
      if ($LASTEXITCODE -ne 0) { throw "forbidden scan helper failed" }
    } finally {
      Pop-Location
    }
    $forbidden = $scan | ConvertFrom-Json
    $count = @($forbidden).Count
    if ($scan -eq "[]") { $count = 0 }
    Set-Result "forbidden_artifacts" $count
    if ($count -ne 0) { throw "forbidden artifacts present: $count" }
  }

  Invoke-Step "startup-without-signer-config" {
    $failRuntime = Join-Path $RuntimeDir "missing-config-runtime"
    New-Item -ItemType Directory -Force -Path $failRuntime | Out-Null
    $process = Start-Process -FilePath (Join-Path $releaseDir "bin\mnde-sidecar-custody.cmd") `
      -ArgumentList @("--runtime-dir", $failRuntime) `
      -WorkingDirectory $releaseDir `
      -RedirectStandardOutput (Join-Path $RuntimeDir "no-config.out.log") `
      -RedirectStandardError (Join-Path $RuntimeDir "no-config.err.log") `
      -WindowStyle Hidden `
      -PassThru
    Wait-Process -Id $process.Id -Timeout 8
    $stderr = Get-Content -LiteralPath (Join-Path $RuntimeDir "no-config.err.log") -Raw
    if ($process.ExitCode -eq 0 -or $stderr -notmatch "ERR_CUSTODY_SIGNER_CONFIG_MISSING") {
      throw "startup did not fail closed without signer config"
    }
    Set-Result "startup_without_signer_config" "FAIL_CLOSED"
  }

  Write-MockSignerTool $mockSignerTool
  Invoke-Step "start-mock-external-signer" {
    & $node $mockSignerTool --init --runtime-dir $RuntimeDir --port 9797 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $signerConfig)) { throw "mock signer init failed" }
    $process = Start-Process -FilePath $node `
      -ArgumentList @($mockSignerTool, "--serve", "--runtime-dir", $RuntimeDir, "--port", "9797") `
      -WorkingDirectory $RuntimeDir `
      -RedirectStandardOutput (Join-Path $RuntimeDir "mock-signer.out.log") `
      -RedirectStandardError (Join-Path $RuntimeDir "mock-signer.err.log") `
      -WindowStyle Hidden `
      -PassThru
    Set-Content -LiteralPath $script:mockSignerPidFile -Value $process.Id -Encoding ASCII
    Start-Sleep -Milliseconds 800
  }

  $before = Get-FileHash -Algorithm SHA256 -Path (Get-ChildItem -Path $releaseDir -Recurse -File | Select-Object -ExpandProperty FullName) | Sort-Object Path
  $beforeMap = @{}
  foreach ($item in $before) { $beforeMap[$item.Path] = $item.Hash }

  Invoke-Step "startup-with-external-signer" {
    Start-Sidecar $releaseDir $RuntimeDir $signerConfig "sidecar" | Out-Null
    $ready = Wait-HttpJson "http://127.0.0.1:8787/readyz"
    if ($ready.ok -ne $true -or $ready.ready -ne $true) { throw "sidecar was not ready" }
    Set-Result "startup_with_external_signer" "READY"
    if ($ready.custody_config_hash -match "^[0-9a-f]{64}$") { Set-Result "custody_config_hash_present" "PASS" }
  }

  $script:safeResponse = $null
  $script:riskyResponse = $null
  Invoke-Step "safe-decision" {
    $safe = @{ resources = @{ gpu_count = 1; hours = 1 }; execution = @{ max_retries = 0 }; pricing_data = @{ gpu_hour_cents = 500 } } | ConvertTo-Json -Depth 8
    $script:safeResponse = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $safe -ContentType "application/json"
    if ($script:safeResponse.decision -ne "ALLOW") { throw "safe decision was $($script:safeResponse.decision)" }
    if ($script:safeResponse.receipt.signer_mode -ne "external_http") { throw "safe signature mode was $($script:safeResponse.receipt.signer_mode)" }
    Set-Result "safe_decision" "ALLOW"
    Set-Result "safe_signature_mode" "external_http"
  }

  Invoke-Step "risky-decision" {
    $risky = @{ resources = @{ gpu_count = 99; hours = 4 }; execution = @{ max_retries = 0 }; pricing_data = @{ gpu_hour_cents = 500 } } | ConvertTo-Json -Depth 8
    $script:riskyResponse = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $risky -ContentType "application/json"
    if ($script:riskyResponse.decision -ne "REFUSE") { throw "risky decision was $($script:riskyResponse.decision)" }
    if ($script:riskyResponse.receipt.signer_mode -ne "external_http") { throw "risky signature mode was $($script:riskyResponse.receipt.signer_mode)" }
    Set-Result "risky_decision" "REFUSE"
    Set-Result "risky_signature_mode" "external_http"
  }

  $receiptPath = Join-Path $RuntimeDir "receipt-good.json"
  $tamperedPath = Join-Path $RuntimeDir "receipt-tampered.json"
  $unknownKeySetPath = Join-Path $RuntimeDir "receipt-unknown-keyset.json"
  Invoke-Step "good-receipt-verify" {
    Write-Utf8NoBom $receiptPath (($script:riskyResponse.receipt | ConvertTo-Json -Depth 20) + "`n")
    $receiptVerify = & (Join-Path $releaseDir "bin\verify-custody-receipt.cmd") --config $signerConfig --receipt $receiptPath
    if ($LASTEXITCODE -ne 0 -or $receiptVerify[0] -ne "PASS") { throw "receipt verification failed: $($receiptVerify -join ' ')" }
    Set-Result "good_receipt_verify" "PASS"
  }

  Invoke-Step "tampered-receipt-refusal" {
    $tampered = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $tampered.decision = "ALLOW"
    Write-Utf8NoBom $tamperedPath (($tampered | ConvertTo-Json -Depth 20) + "`n")
    $tamperVerify = & (Join-Path $releaseDir "bin\verify-custody-receipt.cmd") --config $signerConfig --receipt $tamperedPath
    if ($LASTEXITCODE -eq 0 -or ($tamperVerify -join "`n") -notmatch "REFUSE") { throw "tampered receipt did not refuse" }
    Set-Result "tampered_receipt_refusal" "PASS"
  }

  Invoke-Step "unknown-key-set-refusal" {
    $unknown = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $unknown.key_set_version = "ksv_unknown"
    Write-Utf8NoBom $unknownKeySetPath (($unknown | ConvertTo-Json -Depth 20) + "`n")
    $unknownVerify = & (Join-Path $releaseDir "bin\verify-custody-receipt.cmd") --config $signerConfig --receipt $unknownKeySetPath
    if ($LASTEXITCODE -eq 0 -or ($unknownVerify -join "`n") -notmatch "ERR_UNKNOWN_KEY_SET_VERSION") { throw "unknown key set was not refused" }
    Set-Result "unknown_key_set_refusal" "PASS"
  }

  Invoke-Step "unknown-signer-refusal" {
    $body = @{ signer_id = "missing-signer"; resources = @{ gpu_count = 1; hours = 1 } } | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $body -ContentType "application/json"
    if ($response.decision -ne "REFUSE" -or $response.reason -ne "ERR_UNKNOWN_SIGNER") { throw "unknown signer response was $($response.decision)/$($response.reason)" }
    Set-Result "unknown_signer_refusal" "PASS"
  }

  Invoke-Step "signer-timeout-refusal" {
    $body = @{ signer_id = "timeout-signer"; resources = @{ gpu_count = 1; hours = 1 } } | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $body -ContentType "application/json"
    if ($response.decision -ne "REFUSE" -or $response.reason -ne "ERR_CUSTODY_SIGNER_TIMEOUT") { throw "timeout response was $($response.decision)/$($response.reason)" }
    Set-Result "signer_timeout_refusal" "PASS"
  }

  Invoke-Step "invalid-signature-refusal" {
    $body = @{ signer_id = "invalid-signer"; resources = @{ gpu_count = 1; hours = 1 } } | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $body -ContentType "application/json"
    if ($response.decision -ne "REFUSE" -or $response.reason -ne "ERR_CUSTODY_SIGNATURE_VERIFY_FAILED") { throw "invalid signature response was $($response.decision)/$($response.reason)" }
    Set-Result "invalid_signature_refusal" "PASS"
  }

  Invoke-Step "restart" {
    if (Test-Path -LiteralPath $script:sidecarPidFile) {
      Stop-Process -Id ([int](Get-Content -LiteralPath $script:sidecarPidFile)) -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800
    Start-Sidecar $releaseDir $RuntimeDir $signerConfig "sidecar-restart" | Out-Null
    $ready = Wait-HttpJson "http://127.0.0.1:8787/readyz"
    if ($ready.ok -ne $true -or $ready.ready -ne $true) { throw "restart readiness failed" }
    Set-Result "restart_ready" "PASS"
  }

  Invoke-Step "post-restart-receipt" {
    $safe = @{ resources = @{ gpu_count = 1; hours = 1 }; execution = @{ max_retries = 0 }; pricing_data = @{ gpu_hour_cents = 500 } } | ConvertTo-Json -Depth 8
    $post = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/decisions -Body $safe -ContentType "application/json"
    $postReceipt = Join-Path $RuntimeDir "receipt-post-restart.json"
    Write-Utf8NoBom $postReceipt (($post.receipt | ConvertTo-Json -Depth 20) + "`n")
    $verifyPost = & (Join-Path $releaseDir "bin\verify-custody-receipt.cmd") --config $signerConfig --receipt $postReceipt
    if ($LASTEXITCODE -ne 0 -or $verifyPost[0] -ne "PASS") { throw "post-restart receipt verification failed" }
  }

  Invoke-Step "post-runtime-release-verify" {
    $verify = & (Join-Path $releaseDir "bin\verify-release.cmd")
    if ($LASTEXITCODE -ne 0 -or $verify[0] -ne "PASS") { throw "post-runtime verify-release failed" }
    Set-Result "post_runtime_release_verify" "PASS"
  }

  Invoke-Step "mutation-check" {
    $after = Get-FileHash -Algorithm SHA256 -Path (Get-ChildItem -Path $releaseDir -Recurse -File | Select-Object -ExpandProperty FullName) | Sort-Object Path
    $afterMap = @{}
    foreach ($item in $after) { $afterMap[$item.Path] = $item.Hash }
    $changed = @()
    foreach ($path in $afterMap.Keys) {
      if (-not $beforeMap.ContainsKey($path) -or $beforeMap[$path] -ne $afterMap[$path]) { $changed += $path }
    }
    $missing = @()
    foreach ($path in $beforeMap.Keys) {
      if (-not $afterMap.ContainsKey($path)) { $missing += $path }
    }
    Set-Result "release_mutation_changed_count" $changed.Count
    Set-Result "release_mutation_missing_count" $missing.Count
    if ($changed.Count -ne 0 -or $missing.Count -ne 0) { throw "release mutation detected" }
  }

  $pass = (
    $report.release_verify -eq "PASS" -and
    $report.forbidden_artifacts -eq 0 -and
    $report.startup_without_signer_config -eq "FAIL_CLOSED" -and
    $report.startup_with_external_signer -eq "READY" -and
    $report.custody_config_hash_present -eq "PASS" -and
    $report.safe_decision -eq "ALLOW" -and
    $report.safe_signature_mode -eq "external_http" -and
    $report.risky_decision -eq "REFUSE" -and
    $report.risky_signature_mode -eq "external_http" -and
    $report.good_receipt_verify -eq "PASS" -and
    $report.tampered_receipt_refusal -eq "PASS" -and
    $report.unknown_signer_refusal -eq "PASS" -and
    $report.unknown_key_set_refusal -eq "PASS" -and
    $report.signer_timeout_refusal -eq "PASS" -and
    $report.invalid_signature_refusal -eq "PASS" -and
    $report.restart_ready -eq "PASS" -and
    $report.post_runtime_release_verify -eq "PASS" -and
    $report.release_mutation_changed_count -eq 0 -and
    $report.release_mutation_missing_count -eq 0
  )
  if ($pass) { Set-Result "verdict" "PASS" }
} catch {
  $errors += [pscustomobject]@{ step = "top-level"; error = $_.Exception.Message }
} finally {
  Stop-CleanRootNode
  "MNDE_CUSTOMER_CUSTODY_CLEAN_ROOM_REPORT"
  foreach ($key in $report.Keys) {
    "${key}: $($report[$key])"
  }
  if ($errors.Count -gt 0) {
    "errors: $($errors | ConvertTo-Json -Compress)"
  }
  if ($report.verdict -ne "PASS") { exit 1 }
}
