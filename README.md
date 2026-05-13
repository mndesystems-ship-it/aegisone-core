# AegisOne Safety Check UI

No-code local UI for checking deterministic execution decisions against a local sidecar at `127.0.0.1:8787`.

## Product Surface

Public launch API:

- `POST /v1/decisions` - submit an execution request and receive an `ALLOW` or `REFUSE` decision with a signed receipt.
- `GET /healthz` - process health.
- `GET /readyz` - readiness, active policy version, and policy hash.
- `GET /metrics` - runtime counters or local demo metrics.

Local UI helper routes:

- `POST /verify` - demo-only receipt signature check used by this UI.
- `POST /replay` - demo-only receipt replay/drift check used by this UI.
- `POST /decide` - legacy alias for `POST /v1/decisions`; retained only for older local demos.

Launch docs and customer integrations should point to `POST /v1/decisions`, not `/decide`.

## Files

- `index.html` - single page layout
- `main.js` - no-code controls, strict JSON parsing, canonicalization, fetch calls, receipt actions
- `request-builder.js` - maps UI controls to the strict decision request JSON
- `styles.css` - local styles
- `mnde-local-sidecar.mjs` - local endpoint adapter for the public decision route and demo receipt helpers; retained as a compatibility filename
- `mnde-ui-static-server.mjs` - static local UI server; retained as a compatibility filename
- `start-mnde-ui.cmd` - one-command Windows launcher
- `requests/allow-request.json` - valid request payload
- `requests/refuse-request.json` - refusal request payload

## Run

Run one command:

```powershell
cd C:\Users\Shadow\Downloads\INsol\INsol
.\start-mnde-ui.cmd
```

Open:

```text
http://127.0.0.1:8080/
```

The launcher starts the local decision endpoint on `127.0.0.1:8787` if it is not already running, then starts the UI server on `127.0.0.1:8080`.

## Routes

The local decision endpoint provides:

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `POST /v1/decisions`
- `POST /verify` for local receipt checks
- `POST /replay` for local receipt replay

Manual endpoint start:

```powershell
cd C:\Users\Shadow\Downloads\INsol\INsol
node --experimental-strip-types .\mnde-local-sidecar.mjs
```

Manual UI server start:

```powershell
cd C:\Users\Shadow\Downloads\INsol\INsol
node .\mnde-ui-static-server.mjs
```

## If The UI Says `ERR_MNDE_UNREACHABLE_OR_CORS`

Check that the local decision endpoint is listening:

```powershell
Invoke-WebRequest http://127.0.0.1:8787/healthz
```

If that cannot connect, start `mnde-local-sidecar.mjs`. If it connects in PowerShell but the browser still fails, use `python -m http.server 8080` and open `http://127.0.0.1:8080/` instead of opening `index.html` through `file://`.

## Behavior

- Use the form controls or presets to generate a strict decision request.
- Advanced JSON can be inspected or imported, but it is not the main workflow.
- Upload or drop a receipt JSON file to load it for replay or signature verification.
- Drag the receipt viewer content to another app to transfer the canonical receipt JSON as text.
- The UI rejects invalid JSON before sending.
- JSON is canonicalized with sorted object keys and safe-integer-only numbers.
- Any parse, network, response, replay, verify, copy, or export error sets the visible decision to `REFUSE`.
- Protocol `reason_code`, `request_hash`, and `decision_hash` are displayed without remapping.
- Receipt views include raw canonical JSON, pretty JSON, and hash input fields.
- Replay and verify send the current receipt as `{ "receipt": ... }`.
