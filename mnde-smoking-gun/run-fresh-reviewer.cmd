@echo off
setlocal
set "ROOT=%~dp0.."
set "OUT=%~dp0output"
set "FRESH=%OUT%\fresh-reviewer-unzip"
set "RELEASE=%FRESH%\mnde-custody-release"

if exist "%FRESH%" rmdir /s /q "%FRESH%"
mkdir "%FRESH%"
xcopy "%ROOT%\mnde-custody-release" "%RELEASE%\" /E /I /Q > "%OUT%\fresh-copy.txt"
if errorlevel 1 (
  echo REFUSE
  type "%OUT%\fresh-copy.txt"
  exit /b 1
)

set "NODE=%RELEASE%\bin\node\node.exe"
set "MNDE_SMOKING_GUN_RELEASE_ROOT=%RELEASE%"
if not exist "%NODE%" (
  echo REFUSE
  echo Missing packaged Node runtime in fresh copy: %NODE%
  exit /b 1
)

call "%RELEASE%\bin\verify-custody-release.cmd" > "%OUT%\verify-release.txt" 2>&1
if errorlevel 1 (
  echo REFUSE
  type "%OUT%\verify-release.txt"
  exit /b 1
)

"%NODE%" "%~dp0prove.mjs"
if errorlevel 1 exit /b %ERRORLEVEL%

call "%RELEASE%\bin\mnde-custody.cmd" verify-custody-receipt --registry "%OUT%\runaway-gpu-autoscale.registry.json" --receipt "%OUT%\runaway-gpu-autoscale.refusal.receipt.json" > "%OUT%\verify-receipt.txt" 2>&1
if errorlevel 1 (
  echo REFUSE
  type "%OUT%\verify-receipt.txt"
  exit /b 1
)

call "%RELEASE%\bin\mnde-custody.cmd" verify-custody-receipt --registry "%OUT%\runaway-gpu-autoscale.registry.json" --receipt "%OUT%\runaway-gpu-autoscale.tampered.receipt.json" > "%OUT%\verify-tampered-receipt.txt" 2>&1
if not errorlevel 1 (
  echo REFUSE
  echo Tampered receipt unexpectedly verified.
  type "%OUT%\verify-tampered-receipt.txt"
  exit /b 1
)

echo PASS
echo Fresh reviewer proof complete.
echo Release copy: %RELEASE%
echo Release integrity: PASS
echo Refusal receipt verification: PASS
echo Tampered receipt rejection: PASS
echo Artifacts: %OUT%
exit /b 0
