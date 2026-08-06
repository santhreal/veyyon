# Natives Addon Loader Runtime

This document covers the runtime loader shipped by `@veyyon/natives`: how `native/index.js` decides which `.node` file to require, how compiled-binary embedded payloads are extracted, and what startup failures report.

## Implementation files

- `packages/natives/native/index.js`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/package.json`

## Scope and responsibility

The loader is intentionally narrow:

- Build a platform/CPU-aware candidate list for addon filenames and directories.
- Treat an embedded-addon manifest as a compiled-binary signal when present.
- Optionally materialize embedded addon archive contents into a versioned per-user cache directory.
- On Windows `node_modules` installs, stage addon files into the versioned cache to avoid locked-DLL update failures.
- Attempt candidates in deterministic order and return the first addon that `require(...)` loads and validates.

For install and compiled-binary paths, the loader verifies a release sentinel export named from `package.json#version` (at version 1.0.46, `__veyyonNativesV1_0_46`; `scripts/release.ts` bumps the name in lock-step with the version). Workspace-dev loads downgrade a sentinel mismatch to a loud one-time warning, so a local checkout keeps booting until the next rebuild after a pull. The loader does not validate the full export surface; stale same-version or incomplete binaries still surface as missing members or native errors at use sites.

## Runtime inputs and derived state

`native/index.js` binds lazy accessors and does no probing at import time. When the first native class or function is touched, `loadNative()` runs `initLoaderContext()`, which computes:

- **Platform tag**: `${process.platform}-${process.arch}` (for example `darwin-arm64`).
- **Package version**: from `packages/natives/package.json`.
- **Core directories**:
  - `leafPackageDir`: directory of the platform leaf package, resolved via `require.resolve("@veyyon/natives-<tag>/package.json")`; `null` when no leaf is installed (e.g. local dev) and forced to `null` in compiled-binary mode.
  - `nativeDir`: package-local `packages/natives/native`.
  - `execDir`: directory containing `process.execPath`.
  - `versionedDir`: `<getNativesDir()>/<packageVersion>`.
  - `userDataDir` fallback:
    - Windows: `%LOCALAPPDATA%/veyyon` or `%USERPROFILE%/AppData/Local/veyyon`.
    - Non-Windows: `~/.local/bin`.
- **Natives cache root** (`getNativesDir()`):
  - if `$XDG_DATA_HOME/veyyon` exists, `$XDG_DATA_HOME/veyyon/natives`;
  - otherwise `~/.veyyon/natives`.
- **Compiled-binary mode** (`detectCompiledBinary`): true if any of:
  - embedded-addon manifest is non-null,
  - `VEYYON_COMPILED` env var is set,
  - `import.meta.url` contains Bun embedded markers (`$bunfs`, `~BUN`, `%7EBUN`).
- **Windows staging mode** (`shouldStageNodeModulesAddon`): true only on Windows, in non-compiled mode, when `nativeDir` is inside `node_modules`.
- **Variant override**: `VEYYON_NATIVE_VARIANT` (`modern`/`baseline` only; invalid values ignored).
- **Selected variant**: explicit override, otherwise runtime AVX2 detection on x64 (`modern` if AVX2, else `baseline`).

## Platform support and tag resolution

`SUPPORTED_PLATFORMS` is fixed to:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

Unsupported platforms are not rejected before probing. The loader first tries the computed candidate paths. If all fail and `platformTag` is unsupported, it throws an unsupported-platform error listing supported tags.

## Variant selection (`modern` / `baseline` / default)

### x64 behavior

1. `VEYYON_NATIVE_VARIANT=modern|baseline` wins when valid.
2. Otherwise AVX2 support is detected:
   - Linux: scan `/proc/cpuinfo` for `avx2`.
   - macOS: `sysctl -n machdep.cpu.leaf7_features`, then `machdep.cpu.features`.
   - Windows: PowerShell `[System.Runtime.Intrinsics.X86.Avx2]::IsSupported`.
3. AVX2 selects `modern`; unavailable or undetectable AVX2 selects `baseline`.

### Non-x64 behavior

No variant suffix is used; the filename is `veyyon_natives.<platform>-<arch>.node`.

### Filename construction

`loader-state.js#getAddonFilenames` returns:

- Non-x64 or no variant: `veyyon_natives.<tag>.node`
- x64 + `modern`:
  1. `veyyon_natives.<tag>-modern.node`
  2. `veyyon_natives.<tag>-baseline.node`
  3. `veyyon_natives.<tag>.node`
- x64 + `baseline`:
  1. `veyyon_natives.<tag>-baseline.node`
  2. `veyyon_natives.<tag>.node`

The default unsuffixed fallback remains part of the x64 candidate list.

## Candidate path construction and fallback ordering

`resolveLoaderCandidates(...)` expands every filename across directories, then de-duplicates while preserving first occurrence order.

### Non-compiled runtime

Candidates are grouped by directory class, in order:

1. `<leafPackageDir>/<filename>` for every filename (omitted when `leafPackageDir` is `null`)
2. `<nativeDir>/<filename>` then `<execDir>/<filename>`, per filename
3. `<versionedDir>/<filename>` for every filename, as a trailing fallback

The leaf package dir comes first so the optional-dependency binary published with the release is preferred over any `.node` left in the core package's `native/` (e.g. a stale local-dev build). The trailing versioned-cache fallback lets a source checkout whose gitignored `native/*.node` is missing still boot from an addon a prior standalone install staged into the per-version cache; the version-sentinel check rejects a stale copy.

On Windows, when `nativeDir` falls inside a `node_modules` segment (`shouldStageNodeModulesAddon`), `<versionedDir>/<filename>` staging candidates are prepended ahead of the leaf candidates, and the staged file is copied from `leafPackageDir ?? nativeDir` before probing. The trigger is those two conditions and nothing else: Windows, and an addon reached through `node_modules`. It exists because Windows holds an open `.node` locked, so a package manager updating a `node_modules` tree while a veyyon process runs can leave an old binary beside a newer `index.js`, which fails at the first missing symbol rather than at load. Staging into the version-pinned cache gives each version its own path and lets the running process keep its handle on the copy it loaded. A compiled binary never takes this path (`maybeExtractEmbeddedAddon` handles it), and neither does a workspace checkout, whose `nativeDir` is not under `node_modules`.

### Compiled runtime

Candidates are grouped, in order:

1. every `<versionedDir>/<filename>`, then every `<userDataDir>/<filename>`
2. `<nativeDir>/<filename>` then `<execDir>/<filename>`, per filename

At load time, an extracted embedded candidate, or a staged Windows candidate when no embedded candidate exists, is prepended ahead of these de-duplicated candidates.

## Embedded addon extraction lifecycle

`embedded-addon.js` is generated by `packages/natives/scripts/embed-native.ts`. The reset stub exports `embeddedAddon = null`. A populated manifest has:

- `platformTag`
- `version`
- `archive`: `{ format: "tar.gz", filename, filePath }`
- `files[]` entries with `variant`, `filename`, and `size`

Extraction (`maybeExtractEmbeddedAddon`) runs only when:

1. compiled-binary mode is true,
2. `embeddedAddon` is non-null,
3. manifest `platformTag` equals the runtime platform tag,
4. manifest `version` equals the package version,
5. a variant-appropriate embedded file exists.

Variant file selection:

- Non-x64: prefer `default`, then first available file.
- x64 + `modern`: prefer `modern`, fallback to `baseline`.
- x64 + `baseline`: require `baseline`.

Materialization, with the archive branch first because that is what a release manifest carries:

1. Ensure `<versionedDir>` exists. A failure here is recorded and extraction gives up.
2. With an `archive`, extract `embeddedAddon.archive.filePath` into `<versionedDir>`, admitting only the paths in the manifest `files[]` allowlist. There is no reuse check first: extraction runs, and then `<versionedDir>/<selected filename>` has to exist with the size the manifest recorded, or the attempt is recorded as an error and returns nothing.
3. Without an `archive`, the cached file is checked first and reused when its size matches, and only otherwise is the single embedded file copied from its `filePath`.
4. Either way the returned path becomes the first candidate the loader tries.

Archive, directory, or write failures are appended to the loader error list; probing continues through normal candidates.

## Lifecycle and state transitions

```text
Init
  -> Load package metadata and embedded-addon manifest
  -> Compute platform/version/variant/filenames/candidate paths
  -> (compiled + embedded manifest matches?)
       yes -> extract archive to versionedDir when needed (record errors, continue)
       no  -> skip extraction
  -> (Windows non-compiled node_modules install and no embedded candidate?)
       yes -> stage leaf/core addon to versionedDir (record errors, continue)
       no  -> skip staging
  -> loadFirstUsableAddon: for each runtime candidate in order:
       require(candidate)
       -> require threw, path absent (MODULE_NOT_FOUND/ENOENT): record error, continue quietly
       -> require threw, file present: record error, WARN on stderr, continue
       -> loaded: validate the sentinel OUTSIDE the try
            -> passes or is workspace-dev: return addon exports (READY)
            -> rejects: the throw propagates, no further candidate is tried
  -> none loaded:
       if unsupported platform tag -> throw Unsupported platform
       else -> throw Failed to load (tried-path diagnostics + hints)
```

### Why validation runs outside the try

`loadFirstUsableAddon` calls `validateLoadedBindings` after the `try` that wraps `require`, and that
placement is the contract. The sentinel gate is written to fail closed: for an installed user it throws
rather than boot a `.node` built for a different release. When the call sat inside the loop's single
`try`, the `catch` recorded the message and moved to the next candidate, which turned a deliberate
refusal into a fallback. Because the candidate list ends with the extracted cache copy under
`~/.veyyon/natives/<version>/`, there was always somewhere to fall through to, so a developer who had
just rebuilt kept running the old addon with nothing but a startup marker to say so.

The tests live in `packages/natives/test/addon-candidate-loop.test.ts`, which drives the loop with a
fake `requireAddon` and `validate` so the decision is checked without a real `dlopen`.

### Absent candidates are quiet, present ones are not

The loader probes several install layouts and only one of them exists on any given host, so a
`MODULE_NOT_FOUND` or `ENOENT` is the expected answer for most candidates and passes without comment.
A candidate that exists and will not load is different: a truncated download, a build for the wrong
architecture, a missing `libstdc++`. `classifyCandidateFailure` splits the two, and a `broken` result
writes one warning to stderr naming the file, the reason, and the fact that a different copy is now
running. The loader still continues, because a corrupt copy must not brick a boot when a good one
exists, but it can never do so silently.

## Failure behavior and diagnostics

### Finding out which addon loaded

Set `VEYYON_DEBUG_STARTUP=1` and read the `native:require:` marker. It prints the RESOLVED ABSOLUTE
PATH of each candidate as the loader tries it, so the last one before `native:loadNative:done` is the
addon in use.

The absolute path is the point. A copy extracted into `~/.veyyon/natives/<version>/` and a fresh
in-tree build carry the same file name, and the marker used to print only that name, so the two were
indistinguishable in the one place a developer looks. The version sentinel does not separate them
either: both are the same release. `bun --cwd=packages/natives run build` now refreshes the embedded
archive so the pair cannot drift, but when you are debugging a load, read the path.

### Unsupported platform

If all candidates fail and `platformTag` is not supported, the loader throws:

- `Unsupported platform: <tag>`
- supported platform list
- issue-reporting guidance

### No loadable candidate

If the platform is supported but no candidate can be loaded, the final error includes:

- `Failed to load veyyon_natives native addon for <platformTag>` or `<platformTag> (<variant>)`
- every attempted path with the corresponding `require(...)` error, plus the pre-loop staging errors
  from embedded extraction or Windows staging ahead of them
- mode-specific remediation hints

### Compiled-binary startup failures

Compiled mode diagnostics include:

- expected versioned cache target paths (`<versionedDir>/<filename>`),
- remediation to delete the versioned cache and rerun,
- direct release download `curl` commands for each expected filename.
- release sentinel mismatch details when a loadable `.node` belongs to another `@veyyon/natives` version.

### Non-compiled startup failures

Source-install/runtime diagnostics include:

- provisioning hint (`bun --cwd=packages/natives run ensure`, which downloads the addon from this checkout's own release or builds it locally),
- local rebuild command (`bun --cwd=packages/natives run build`) with the optional x64 variant hint (`TARGET_VARIANT=baseline|modern`),
- standalone-binary reinstall hint (`curl -fsSL https://get.veyyon.dev | sh`).

*Verified against `03f0da34` on 2026-08-05.*
