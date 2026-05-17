# Verify

Run the required audit checks from the repository root:

```powershell
npm run test:local:replay
npm run test:release:integrity
npm run test:sidecar-browser-torture
npm run test:local:proof
npm run test:local:concurrency
```

Optional broader checks:

```powershell
npm run test:release:provenance
npm run test:custody
npm run test:external-audit-integration
npm run proof:full
```

Do not treat retained summaries as fresh PASS evidence. Fresh PASS requires rerunning the relevant command and reading the exit code.
