---
name: verify
description: Build-and-drive recipe for verifying @electron/osx-sign changes end-to-end on macOS.
---

# Verifying @electron/osx-sign

## Build

```bash
yarn build        # tsc → dist/ (the bin/ CLIs import from dist/)
```

## Surfaces

- **CLI**: `node bin/electron-osx-flat.mjs <App.app> [--implementation=js] [--platform=darwin|mas] [--pkg=out.pkg]`
  and `node bin/electron-osx-sign.mjs <App.app> [...]`. Both read from `dist/`, so build first.
- **Library**: `flat()` / `sign()` from the package root export.

## Getting a real app to package

Download a real Electron.app (cached by @electron/get after first run):

```bash
node -e '
const { downloadArtifact } = require("@electron/get");
const { extract } = require("@electron-internal/extract-zip");
downloadArtifact({ version: "35.0.3", platform: "darwin", arch: process.arch, artifactName: "electron" })
  .then((zip) => extract(zip, { dir: process.argv[1] }))' /tmp/electron-dist
```

## Observing the output pkg

- `pkgutil --expand-full out.pkg expanded-dir` then `diff -r App.app expanded-dir/*.pkg/Payload/App.app`
  is the strongest check — it runs Apple's real extraction path. "Directory loop detected"
  warnings from diff on framework symlinks are benign when they appear on both sides.
- `lsbom <extracted Bom>` validates the Bill-of-Materials.
- `installer -pkg out.pkg -volinfo` exercises Installer's package parsing without installing.
- Actually installing requires sudo — don't.

## Gotchas

- **Native Apple tools (pkgbuild/productbuild/pkgutil/installer/lsbom) hang or crash under
  the Bash-tool seatbelt sandbox.** Run them with the sandbox disabled.
- **Files created by this session's processes get `com.apple.provenance` xattrs**, which
  make native pkgbuild emit AppleDouble (`._*`) entries. When byte-comparing against
  native output, filter `._*` entries and renumber cpio inodes (see
  `spec/pkg-utils/helpers.ts` `normalizeCpio`).
- Signing verification needs the self-signed identity from `spec/ci/generate-identity.sh`;
  without it, `sign.spec.ts` fails with "No identity found" (pre-existing on dev machines).
- `yarn bench` benchmarks the JS packager against the native tools;
  `OSX_SIGN_BENCH_APP=path` points it at an existing .app.
