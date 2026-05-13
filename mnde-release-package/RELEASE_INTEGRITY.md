# Release Integrity

MNDe release artifacts are immutable after publication. Any rebuild or byte-level change requires a new version, a new signed manifest, and a new published SHA256.

Release packages include:

- `manifest.json`: signed release manifest listing every shipped file except the manifest control file itself.
- `provenance.json`: signed build provenance with builder identity, build environment, UTC build time, source commit, build command, and toolchain versions.
- `bin/verify-release.cmd`: verifier that returns `PASS` only when signatures and every manifest-to-disk hash match exactly; otherwise it returns `REFUSE` with a full diff.

To expose a published file hash:

```cmd
bin\mnde.cmd artifact-hash --file bin/mnde.cmd
```

To verify the custody execution boundary before use:

```cmd
bin\verify-release.cmd
```

Runtime commands verify integrity before execution. If any file is missing, extra, or mismatched, execution is refused before action.

For immutable distribution storage, set `MNDE_RELEASE_DISTRIBUTION_DIR` during `npm run release:build`. The build copies the release into a versioned directory, refuses to overwrite an existing version, and marks stored files read-only.
