# @veyyon/natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Glob-based file/directory discovery with gitignore support (pure TypeScript via `globPaths`)
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { grep, find, encodeSixel } from "@veyyon/natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
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
src/                     # TypeScript wrappers and generated declarations source
  native.ts
  index.ts
```

The published core package contains only the JS loader, declarations, README,
and `package.json`. Release publishing generates one leaf package per supported
`os`/`cpu` pair and injects those leaves into the core manifest as pinned
`optionalDependencies`, so package managers install only the host platform's
native addon. x64 leaves include every built ISA variant, and the loader keeps
choosing between `baseline` and `modern` at runtime.

### Version sentinels: how a stale `.node` is caught

Each build stamps the addon with an exported symbol named for the package
version. Version `1.2.3` emits `__veyyonNativesV1_2_3`. The loader knows the
version it expects (its own `package.json`) and derives the same symbol name
with `versionSentinelExportFor`, so a loaded addon is either fresh (the symbol
is present) or stale (it is missing, meaning the `.node` on disk was built for a
different version).

Staleness is caught at two points, so a mismatched addon never reaches a user:

- **Build time (fails closed).** Before a variant is embedded, `findStaleAddon`
  scans its raw bytes for the expected sentinel. If it is absent, the build
  refuses with `staleAddonMessage` rather than shipping an addon that will crash
  on load. This is why `.node` files are gitignored build artifacts, never
  committed: a committed binary would drift out of lock-step with the version
  and defeat this check.
- **Load time.** `evaluateLoadedBindings` reads the sentinel back from the
  loaded bindings and returns `accept`, `warn`, or `throw`. An installed package
  that loads a stale addon throws with a message naming both the version it was
  built for and the version this loader expects. A workspace load (running from
  source, before you rebuild) only warns once, because rebuilding is the fix and
  a hard throw would block iteration.

If you change how the Rust addon emits its sentinel, change
`versionSentinelExportFor` in the same commit and keep
`native-loader-validation.test.ts` green. The two must agree byte for byte or
every load fails.

### CPU ISA variant selection: tri-state, never a silent downgrade

On x64 the loader picks `modern` (AVX2) when the host supports it and
`baseline` otherwise. Detection is deliberately tri-state, not a boolean:
`supported`, `unsupported`, or `unknown`. The `unknown` case matters. If probing
the host fails (an unreadable `/proc/cpuinfo`, a `sysctl` that could not spawn),
the loader must not silently assume `baseline` and cache that guess, because a
guess cached as fact would pin an AVX2-capable machine to the slow path for the
life of the process. Instead `unknown` selects `baseline` for ABI safety, warns
once that detection failed, and does not cache, so a later attempt can still
resolve correctly.

The same classification runs on both sides of the build/runtime boundary and
cannot share code, so it is implemented twice: `classifyAvx2Support` in
`native/loader-state.js` (runtime) and `classifyHostAvx2Support` in
`scripts/host-detect.ts` (build). They must agree. `native-avx2-classify.test.ts`
runs one probe matrix through both and fails if their verdicts ever diverge. If
you touch either classifier, run that parity suite before you commit.
