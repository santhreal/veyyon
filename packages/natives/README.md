# @veyyon/natives

Native Rust functionality via N-API.

## What's Inside

Highlights:

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Glob-based file/directory discovery with gitignore support (native `glob` binding)
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)

The addon also exports PTY/process/shell classes (`Process`, `PtySession`, `Shell`), clipboard and image helpers, AST tools (`astGrep`, `astEdit`, `astMatch`), syntax highlighting (`highlightCode`), Kitty key parsing, task isolation (`isoProbe`/`isoStart`/`isoDiff`/`isoResolve`), `htmlToMarkdown`, BPE `countTokens`, fuzzy find, workspace listing, code summarization, and terminal-width text utilities.

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { glob, grep, encodeSixel } from "@veyyon/natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files (glob: the same options, under the name the addon exports)
const files = await glob({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px)
const sequence = encodeSixel(pngBytes, widthPx, heightPx);
```

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

## Architecture

`@veyyon/natives` publishes a small core package plus generated
platform-specific optional dependency packages:

```
crates/veyyon-natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Core loader files and local/CI native build outputs
  index.js               # Public native export surface
  loader-state.js        # Platform, ISA variant, and addon resolution
  embedded-addon.js      # Standalone binary embed stub/generated metadata
  veyyon_natives.<platform>-<arch>-modern.node   # x64 modern ISA (local/CI artifact)
  veyyon_natives.<platform>-<arch>-baseline.node # x64 baseline ISA (local/CI artifact)
  veyyon_natives.<platform>-<arch>.node          # non-x64 build artifact
npm/<platform>-<arch>/   # Generated at publish time, not committed
  package.json           # @veyyon/natives-<platform>-<arch>
  *.node                 # Only that platform's addon binary or x64 ISA variants
src/                     # sha256-sidecar.ts, the only TypeScript source (./sha256-sidecar subpath export)
```

The published core package contains only the JS loader, declarations, the
sha256-sidecar source, README, CHANGELOG, and `package.json`. Release publishing generates one leaf package per supported
`os`/`cpu` pair and injects those leaves into the core manifest as pinned
`optionalDependencies`, so package managers install only the host platform's
native addon. x64 leaves include every built ISA variant, and the loader keeps
choosing between `baseline` and `modern` at runtime.

### Version sentinels

Each build stamps the addon with an exported symbol named for the package version (e.g. `__veyyonNativesV1_2_3`). The loader derives the expected symbol name with `versionSentinelExportFor`.

Staleness checks occur at two points:

- **Build time:** Before embedding a variant, `findStaleAddon` scans binary bytes for the expected sentinel. A missing sentinel fails the build with `staleAddonMessage`.
- **Load time:** `evaluateLoadedBindings` reads the sentinel from loaded bindings (`accept`, `warn`, or `throw`). An installed package throws if the version does not match `package.json`. Workspace source executions log a single warning.

### CPU ISA variant selection

On x64 platforms, the loader selects `modern` (AVX2) when supported by the host and `baseline` otherwise. Detection states are `supported`, `unsupported`, or `unknown`. If host detection fails, `unknown` selects `baseline` without caching the result.

The classifier is implemented in `native/loader-state.js` (runtime) and `scripts/host-detect.ts` (build). `native-avx2-classify.test.ts` validates parity between both implementations.
