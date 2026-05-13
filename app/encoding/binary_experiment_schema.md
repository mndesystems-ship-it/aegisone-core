# mnde_binary_experiment

Experimental, internal-only binary encoding for a copy of the decision core.

Feature flag: `MNDE_BINARY_EXPERIMENT=1`.
Default: off.

The JSON receipt remains authoritative. Binary bytes are never written to production receipts and are emitted only as measurement metadata in `results/binary_experiment.jsonl`.

## Field Order

1. magic: ASCII `MNDEB1`
2. version: uint8, currently `1`
3. flags: uint8, bit 0 = `cost_usd_micro`, bit 1 = `timestamp_ms`
4. `request_hash`: raw 32 bytes from valid 64-character hex
5. `decision`: uint8, `REFUSE=0`, `ALLOW=1`
6. `reason`: uint16 stable table ID
7. `policy_hash`: raw 32 bytes from valid 64-character hex
8. `decision_hash`: raw 32 bytes from valid 64-character hex
9. `key_set_version`: uint16 byte length, followed by UTF-8 bytes
10. `cost_usd_micro`: optional uint64 big-endian
11. `timestamp_ms`: optional uint64 big-endian

Unknown fields, invalid hashes, unknown decisions, unknown reasons, floats, and negative integers are rejected.
