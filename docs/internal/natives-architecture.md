# Natives Architecture

`@veyyon/natives` is a two-layer package around an ESM loader:

1. **ESM loader/package entrypoint** exposes every generated class/function as a lazy named ESM export; on first use it resolves and loads the correct `.node` addon with `createRequire`, validates the release sentinel outside workspace-dev loads, and serves enum runtime objects as plain literal exports.
2. **Rust N-API module layer** implements the exported functions/classes and emits the generated TypeScript declarations.

This document is the foundation for deeper module-level docs.

## Implementation files

- `packages/natives/native/index.js`
- `packages/natives/native/index.d.ts`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/build-native.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/package.json`
- `crates/veyyon-natives/src/lib.rs`

## Package entrypoint and public surface

`packages/natives/package.json` points at generated native artifacts:

- `main`: `./native/index.js`
- `types`: `./native/index.d.ts`
- `exports["."].types`: `./native/index.d.ts`
- `exports["."].import`: `./native/index.js`

There is no current `packages/natives/src` TypeScript wrapper layer. Consumers import functions/classes/enums directly from `@veyyon/natives`; the type contract is the generated `native/index.d.ts` plus the explicit named exports generated into `native/index.js` by `packages/natives/scripts/gen-enums.ts`.

Current capability groups in the generated API include:

- **Search/text/code primitives**: `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `astGrep`, `astEdit`, `blockRangeAt`, `summarizeCode`, text width/slicing/wrapping/sanitization, syntax highlighting, token counting.
- **Execution/process/terminal primitives**: `executeShell`, `Shell`, `PtySession`, `Process`, key parsing, bash fixups.
- **System/media/isolation/conversion primitives**: clipboard, SIXEL encoding, HTML-to-Markdown, macOS appearance/power helpers, work profiling, workspace scanning, isolation backend helpers (`iso*`).

## Loader layer

`packages/natives/native/index.js` is the package entrypoint; its lazy exports route through `loadNative()` from `loader-state.js` on first use, and `loader-state.js` owns runtime addon selection and optional embedded extraction.

### Candidate resolution model

- Platform tag is `${process.platform}-${process.arch}`.
- Supported tags are currently:
  - `linux-x64`
  - `linux-arm64`
  - `darwin-x64`
  - `darwin-arm64`
  - `win32-x64`
- x64 can use CPU variants:
  - `modern` (AVX2-capable)
  - `baseline` (fallback)
- Non-x64 uses the default filename without a variant suffix.

Filename strategy:

- Default: `veyyon_natives.<platform>-<arch>.node`
- x64 variant: `veyyon_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- x64 runtime fallback includes the unsuffixed default filename after variant candidates.

### Platform-specific variant detection

For x64, variant selection uses:

- Linux: `/proc/cpuinfo`
- macOS: `sysctl -n machdep.cpu.leaf7_features`, then `machdep.cpu.features`
- Windows: PowerShell check for `System.Runtime.Intrinsics.X86.Avx2`

`VEYYON_NATIVE_VARIANT` can force `modern` or `baseline`; invalid values are ignored.

### Binary distribution and extraction model

The published `@veyyon/natives` package ships **only** the loader layer in `native/`: the ESM loader (`index.js`), generated declarations (`index.d.ts`), the `loader-state.js`/`.d.ts` helpers, and the embedded-addon manifest stub (`embedded-addon.js`). It carries no `.node` binaries.

The loader still knows how to resolve a per-platform optional-dependency leaf,
`@veyyon/natives-<platform>-<arch>`, and prefers it over the core package's
`native/` directory. That resolution order is real code and is covered by
`packages/natives/test/issue-823-repro.test.ts`, which builds the candidate list
from synthetic paths and needs no leaf package on disk.

Nothing generates those leaves. veyyon ships GitHub-only, so the npm publish
channel was removed, and the `gen-npm-packages.ts` script that once wrote the
leaves under `packages/natives/scripts/` went with it. It is not coming back:
`scripts/install-methods-coverage.test.ts` fails if that script, its test, or a
`gen:npm` manifest entry reappears. Adding a build
target therefore does **not** require adding a leaf package, and there is no
`LEAF_TARGETS` list to add it to. What a new target does need is a
`crates/veyyon-natives` build for the tag and a matching entry in the loader's
supported-platform set, which is what the failure modes below key off.

You may find a stale `packages/natives/npm/<platform>-<arch>/` directory in a
working tree that predates the removal. It is untracked, it is not built by
anything, and its `package.json` still carries whatever version was current when
it was generated. It is local leftover, not part of the layout.

The working-tree package keeps built `.node` files under `native/` for local dev,
and the shipped product bundles the matching `.node` into the compiled binary (the
extraction model below).

For compiled binaries, loader behavior is:

1. Check versioned user cache path: `<getNativesDir()>/<packageVersion>/...`.
2. Check legacy compiled-binary location:
   - Windows: `%LOCALAPPDATA%/veyyon` (fallback `%USERPROFILE%/AppData/Local/veyyon`)
   - non-Windows: `~/.local/bin`
3. Fall back to packaged `native/` and executable directory candidates.

`getNativesDir()` uses `$XDG_DATA_HOME/veyyon/natives` when `$XDG_DATA_HOME/veyyon` exists; otherwise it uses `~/.veyyon/natives`.

If a populated embedded addon manifest is present, it is also treated as a compiled-binary signal. Current embedded manifests point at a gzip-compressed tar archive (`embedded-addons.<tag>.tar.gz`) that contains one or more matching `.node` files. The loader extracts the archive into the versioned cache directory, validates the selected file by size, and prepends that cache path before normal candidate probing.

For npm/bun installs (non-compiled), `loader-state.js` resolves the platform leaf directory via `require.resolve("@veyyon/natives-<tag>/package.json")` and probes its `.node` **before** the core package's `native/` directory and the executable directory. The optional-dependency binary is therefore preferred over any `.node` left in the core (e.g. a stale local-dev build). On Windows `node_modules` installs, the loader first stages the selected leaf/core addon into `<getNativesDir()>/<packageVersion>/...` and prepends that staged path so running processes do not lock the `node_modules` copy during global updates.

### Failure modes

Loader failures are explicit:

- **Unsupported platform tag**: after failed probing, throws with supported platform list.
- **No loadable candidate**: throws with all attempted paths and remediation hints.
- **Embedded/staging errors**: directory/write/archive/staging failures are recorded and included in final load diagnostics if no candidate loads.
- **Release mismatch**: outside workspace-dev loads, a candidate that loads but lacks the version sentinel export for `package.json#version` is rejected with a reinstall hint.

## Rust N-API module layer

`crates/veyyon-natives/src/lib.rs` declares exported module ownership:

- `appearance`
- `ast`
- `block`
- `clipboard`
- `crash_handler`
- `fd`
- `glob`
- `glob_util` (the N-API error boundary for pattern validation; walking tools compile through `veyyon_walker::CompiledWalkGlob::compile` instead)
- `grep`
- `highlight`
- `html`
- `iofs` (JS-facing filesystem DTOs; traversal and cache policy live in `veyyon-walker`)
- `iso`
- `keys`
- `language` (re-exported from `veyyon_ast`)
- `power`
- `prof`
- `ps`
- `pty`
- `shell`
- `sixel`
- `summary`
- `task`
- `text`
- `tokens`
- `utils` (crate-private helpers)
- `workspace`

N-API exports are generated from Rust `#[napi]` functions/classes/objects/enums. Snake_case Rust names are exposed as camelCase JavaScript names unless explicitly configured by napi-rs.

## Ownership boundaries

- **Loader/package ownership (`packages/natives/native`, `packages/natives/scripts`)**
  - runtime binary selection
  - CPU variant selection and override handling
  - compiled-binary embedded archive extraction
  - Windows `node_modules` addon staging
  - generated TypeScript declarations and explicit ESM export/enum patching
- **Rust ownership (`crates/veyyon-natives/src`)**
  - algorithmic and system-level implementation
  - platform-native behavior and performance-sensitive logic
  - N-API symbol implementation consumed directly by package callers
- **Consumer ownership (`packages/coding-agent`, `packages/tui`)**
  - user-facing policy and fallbacks that are not built into the native API
  - higher-level rendering, artifact, shell-session, and command behavior

For the contributor-facing crate map covering `veyyon-natives`, `veyyon-shell`, `veyyon-ast`, `veyyon-iso`, `veyyon-walker`, `veyyon-uu-grep`, `veyyon-uu-diff`, `veyyon-uutils-ctx`, and the vendored `brush-*` crates, see [`native-crates.md`](./native-crates.md). The root-docs inclusion policy that keeps internal Rust crates under native architecture docs unless promoted as user-facing also lives in [`user-facing-packages.md`](./user-facing-packages.md).

## Runtime flow (high level)

1. Consumer imports from `@veyyon/natives`; `native/index.js` binds lazy accessors, so the import itself never loads a `.node`.
2. On the first native call or `new`, `loadNative()` computes platform/arch/variant and candidate paths.
3. Optional embedded archive extraction or Windows `node_modules` staging can prepend a versioned-cache candidate.
4. Each candidate is `require(...)`d; install/compiled loads must expose the package-version sentinel.
5. The memoized addon object backs every lazy named export; enum objects are plain literals that need no load.
6. Caller invokes generated N-API functions/classes directly.

## Glossary

- **Native addon**: A `.node` binary loaded via Node-API (N-API).
- **Platform tag**: Runtime tuple `platform-arch` (for example `darwin-arm64`).
- **Platform leaf package**: Per-platform npm package `@veyyon/natives-<tag>` that carries one platform's prebuilt `.node`. The core depends on every leaf via `optionalDependencies`; the package manager installs only the host-matching one (`os`/`cpu`).
- **Variant**: x64 CPU-specific build flavor (`modern` AVX2, `baseline` fallback).
- **Generated binding declaration**: `native/index.d.ts` emitted by napi-rs during `build-native.ts`.
- **Version sentinel**: Rust export named from the package version (for example `__veyyonNativesV16_0_3`) that lets the loader reject a `.node` from a different release.
- **Compiled binary mode**: Runtime mode where the CLI is bundled and native addons are resolved from embedded/cache paths before package-local paths.
- **Embedded addon**: Build artifact metadata and archive reference generated into `native/embedded-addon.js` so compiled binaries can extract matching `.node` payloads.

*Verified against `2be25bb55e8fdcdafdd98ab8fccb47a8f34c4bcc` on 2026-07-29.*
