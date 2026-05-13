# Clean Room Test

Run from the repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test_sidecar_custody_clean_room.ps1
```

The script copies only mnde-sidecar-custody-release-v1.0.0-win32-x64.zip into C:\mnde-clean-test\input,
extracts it into C:\mnde-clean-test\release, uses C:\mnde-clean-runtime for runtime state, and prints
MNDE_CUSTOMER_CUSTODY_CLEAN_ROOM_REPORT.
