param(
  [string]$InstallDir = $null,
  [switch]$ForceConfig
)
. "$PSScriptRoot\common.ps1"

$isWindowsPlatform = $env:OS -eq "Windows_NT" -or [Environment]::OSVersion.Platform -eq "Win32NT"
if (-not $isWindowsPlatform) { Write-TypedFailure "ERR_INSTALL_PATH_INVALID" "Windows installer can only run on Windows" }
if (-not (Test-IsAdmin)) { Write-TypedFailure "ERR_INSTALL_PERMISSION_DENIED" "Run install.cmd from an elevated prompt" }

$packageRoot = Get-PackageRoot
if (-not $InstallDir) { $InstallDir = $script:DefaultInstallDir }
try { $InstallDir = [IO.Path]::GetFullPath($InstallDir) } catch { Write-TypedFailure "ERR_INSTALL_PATH_INVALID" $_.Exception.Message }
if ([string]::IsNullOrWhiteSpace($InstallDir) -or $InstallDir -match '^[A-Za-z]:\\?$') {
  Write-TypedFailure "ERR_INSTALL_PATH_INVALID" "Install path is too broad" @{ path = $InstallDir }
}

$verify = & (Join-Path $packageRoot "bin\verify-custody-release.cmd") 2>&1
if ($LASTEXITCODE -ne 0) { Write-TypedFailure "ERR_UPDATE_PACKAGE_INVALID" "Package verification failed before install" @{ output = ($verify -join "`n") } }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $script:DefaultConfigPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $script:DefaultRuntimeLog) | Out-Null

$configTemplate = Join-Path $packageRoot "config\custody.config.template.json"
if ((-not (Test-Path -LiteralPath $script:DefaultConfigPath)) -or $ForceConfig) {
  Copy-Item -LiteralPath $configTemplate -Destination $script:DefaultConfigPath -Force
}

$preserve = @("config", "receipts", "logs")
Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue | Where-Object { $preserve -notcontains $_.Name } | Remove-Item -Recurse -Force
Copy-Item -LiteralPath (Join-Path $packageRoot "*") -Destination $InstallDir -Recurse -Force

$hostSource = Join-Path $InstallDir "lifecycle\MNDeServiceHost.cs"
$hostExe = Join-Path $InstallDir "bin\MNDeServiceHost.exe"
try {
  Add-Type -Path $hostSource -ReferencedAssemblies "System.ServiceProcess.dll" -OutputAssembly $hostExe -OutputType WindowsApplication
} catch {
  Write-TypedFailure "ERR_SERVICE_INSTALL_FAILED" "Service host compilation failed: $($_.Exception.Message)"
}

@(
  "node_path=$(Join-Path $InstallDir "bin\node\node.exe")"
  "cli_path=$(Join-Path $InstallDir "app\release\cli.js")"
  "config_path=$script:DefaultConfigPath"
  "working_directory=$InstallDir"
  "runtime_log=$script:DefaultRuntimeLog"
) | Set-Content -LiteralPath (Join-Path $InstallDir "bin\service-host.env") -Encoding UTF8

$existing = Get-ServiceOrNull
if ($existing) {
  if ($existing.Status -ne "Stopped") { Stop-Service -Name $script:ServiceName -Force -ErrorAction SilentlyContinue; $existing.WaitForStatus("Stopped", "00:00:20") }
  sc.exe delete $script:ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
try {
  New-Service -Name $script:ServiceName -DisplayName "MNDe Custody" -BinaryPathName "`"$hostExe`"" -StartupType Manual | Out-Null
  sc.exe failure $script:ServiceName reset= 0 actions= "" | Out-Null
} catch {
  Write-TypedFailure "ERR_SERVICE_INSTALL_FAILED" "Service registration failed: $($_.Exception.Message)"
}

Write-Pass @{ service_name = $script:ServiceName; install_dir = $InstallDir; config_path = $script:DefaultConfigPath }
