$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "node"
$SidecarUrl = "http://127.0.0.1:8787/healthz"
$UiUrl = "http://127.0.0.1:8080/"

function Test-Endpoint($Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    } catch {
        return $false
    }
}

if (-not (Test-Endpoint $SidecarUrl)) {
    Start-Process -FilePath $Node `
        -ArgumentList @("--experimental-strip-types", ".\mnde-local-sidecar.mjs") `
        -WorkingDirectory $Root `
        -WindowStyle Hidden | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Endpoint $SidecarUrl) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "MNDe endpoint did not become ready at $SidecarUrl"
    }
}

if (-not (Test-Endpoint $UiUrl)) {
    Start-Process -FilePath $Node `
        -ArgumentList @(".\mnde-ui-static-server.mjs") `
        -WorkingDirectory $Root `
        -WindowStyle Hidden | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Endpoint $UiUrl) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "MNDe UI did not become ready at $UiUrl"
    }
}

Write-Host ""
Write-Host "MNDe UI is ready:"
Write-Host $UiUrl
Write-Host ""
Write-Host "Health:"
Invoke-WebRequest -Uri $SidecarUrl -Method Get -TimeoutSec 2 | Select-Object -ExpandProperty Content
