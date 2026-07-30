# Natives media + system utilities

This document covers the media/system/conversion exports currently present in `@veyyon/natives`: terminal SIXEL image encoding, HTML conversion, clipboard access, token counting, macOS appearance/power helpers, and work profiling.

## Implementation files

- `crates/veyyon-natives/src/sixel.rs`
- `crates/veyyon-natives/src/html.rs`
- `crates/veyyon-natives/src/clipboard.rs`
- `crates/veyyon-natives/src/tokens.rs`
- `crates/veyyon-natives/src/appearance.rs`
- `crates/veyyon-natives/src/power.rs`
- `crates/veyyon-natives/src/prof.rs`
- `crates/veyyon-natives/src/task.rs`
- `packages/natives/native/index.js`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/index.d.ts`
- `packages/natives/scripts/build-native.ts`
- `packages/natives/scripts/gen-enums.ts`

The package resolves `@veyyon/natives` through `native/index.js`, while `index.d.ts` supplies its generated declarations. Function and class exports in `index.js` are lazy facades: importing or merely referencing an export does not load the addon. The first invocation, construction, or static class access asks `loader-state.js` to load the addon and either returns the native export or throws; this is deferral, not a functional fallback. During the build, `napi build` generates `index.d.ts`, then `gen-enums.ts` rewrites the generated JS export registry in `index.js`.

There is no native `PhotonImage` class, `image.rs`, or ProjFS overlay helper module in the current `veyyon-natives` addon. General-purpose image decode/resize/encode is expected to live outside this native surface; the native image export here is only terminal SIXEL encoding.

## JS API ↔ Rust export/module mapping

| JS export                             | Rust N-API export              | Rust module     |
| ------------------------------------- | ------------------------------ | --------------- |
| `encodeSixel(bytes, width, height)`   | `encode_sixel`                 | `sixel.rs`      |
| `htmlToMarkdown(html, options?)`      | `html_to_markdown`             | `html.rs`       |
| `copyToClipboard(text)`               | `copy_to_clipboard`            | `clipboard.rs`  |
| `readImageFromClipboard()`            | `read_image_from_clipboard`    | `clipboard.rs`  |
| `countTokens(input, encoding?)`       | `count_tokens`                 | `tokens.rs`     |
| `detectMacOSAppearance()`             | `detect_macos_appearance`      | `appearance.rs` |
| `MacAppearanceObserver.start(cb)`     | `MacAppearanceObserver::start` | `appearance.rs` |
| `MacOSPowerAssertion.start(options?)` | `MacOSPowerAssertion::start`   | `power.rs`      |
| `getWorkProfile(lastSeconds)`         | `get_work_profile`             | `prof.rs`       |

## Data format boundaries and conversions

### SIXEL image encoding (`sixel`)

- **JS input boundary**: `Uint8Array` containing encoded image bytes.
- **Rust decode boundary**: format is guessed with `ImageReader::with_guessed_format()`, then decoded to `DynamicImage`.
- **Resize boundary**: image is resized with `resize_exact(..., FilterType::Lanczos3)` only when source dimensions differ from `targetWidthPx`/`targetHeightPx`.
- **Output boundary**: `encodeSixel(...)` returns a SIXEL escape string synchronously.

Supported decode formats are whatever the compiled `image` crate supports for `ImageReader` in this build (commonly PNG/JPEG/WebP/GIF). Invalid target dimensions (`0` width or height) fail with `Target SIXEL dimensions must be greater than zero`.

### HTML conversion (`html`)

- **JS input boundary**: HTML `string` + optional `{ cleanContent?: boolean; skipImages?: boolean }`.
- **Rust conversion boundary**: conversion is scheduled through `task::blocking("html_to_markdown", (), ...)`; there is no timeout/abort option on this export.
- **Output boundary**: Markdown `string` promise.

Conversion behavior:

- `cleanContent` defaults to `false`.
- When `cleanContent=true`, preprocessing is enabled with `PreprocessingPreset::Aggressive`, `remove_navigation=true`, and `remove_forms=true`.
- `skipImages` defaults to `false` and is passed to `html_to_markdown_rs::ConversionOptions`.

### Clipboard (`clipboard`)

- `copyToClipboard(text)` is a synchronous native call using `arboard::Clipboard::set_text`. On Linux a single process-lifetime `Clipboard` instance is kept alive (X11/Wayland selection ownership); macOS/Windows use a transient instance per call.
- `readImageFromClipboard()` runs in `task::blocking("clipboard.read_image", (), ...)`.
- Image read returns `null`/`undefined` when `arboard` reports `ContentNotAvailable`.
- Successful image read converts clipboard RGBA data into PNG bytes and returns `{ data: Uint8Array, mimeType: "image/png" }`.
- On Windows, an `arboard` image-read error other than `ContentNotAvailable` triggers a best-effort native fallback: `clipboard-win` reads raw `CF_DIB`, the module wraps and decodes it as BMP, and a successful decode returns PNG. If raw DIB retrieval or decoding fails, the original `arboard` error is preserved and rejected.
- Clipboard access or image encoding failures outside that Windows recovery path reject/throw as native errors.

There is no current `packages/natives` TS wrapper that emits OSC52, handles Termux, or suppresses native text-copy failures. Consumers own those fallback and suppression policies; the native module itself owns the Windows best-effort image recovery described above.

### Tokens (`tokens`)

- `countTokens(input, encoding?)` accepts a single string or an array of strings.
- Arrays return one aggregate token count; elements are encoded with Rayon when the global pool is available and sequentially otherwise.
- Default encoding is `O200kBase`; `Cl100kBase` is also exported.
- The implementation uses `encode_ordinary`, not special-token handling.
- BPE tables are initialized once through `LazyLock` and reused.

### macOS appearance and power helpers

- `detectMacOSAppearance()` returns `"dark"`, `"light"`, or `null` on non-macOS.
- `MacAppearanceObserver.start(callback)` returns a handle with `stop()`; on macOS it uses distributed notifications plus a 2-second polling fallback, and on non-macOS it is a no-op observer.
- `MacOSPowerAssertion.start(options?)` returns a handle with `stop()`; on macOS it acquires one or more IOKit assertions, and on other platforms it is a no-op handle.
- Power assertion options are `{ reason?, idle?, system?, user?, display? }`. Idle precedence is exactly `effectiveIdle = idle === true || !(system === true || user === true || display === true)`. Thus explicit `idle: false` still selects idle behavior when none of `system`, `user`, or `display` is true.

### Work profiling (`prof`)

- **Collection boundary**: profiling samples are produced by `profile_region(tag)` guards in `task::blocking` and `task::future`.
- **Storage format**: fixed-size circular buffer (`MAX_SAMPLES = 10_000`) storing stack path, duration, and timestamp.
- **Output boundary**: `getWorkProfile(lastSeconds)` returns:
  - `folded`: folded-stack text (flamegraph input)
  - `summary`: markdown table summary
  - `svg`: optional flamegraph SVG
  - `totalMs`, `sampleCount`

## Lifecycle and state transitions

### SIXEL lifecycle

1. `encodeSixel(bytes, targetWidthPx, targetHeightPx)` validates target dimensions.
2. Rust guesses and decodes the encoded image.
3. Image is resized exactly to the target dimensions when needed.
4. Pixels are converted to RGBA8 and encoded with `icy_sixel::sixel_encode`.
5. The SIXEL escape string is returned synchronously.

Failure transitions:

- Format detection/decode failure throws.
- Invalid target dimensions throw.
- SIXEL encoding failure throws with `Failed to encode SIXEL: ...`.

There is one failure this function CANNOT report, and the caller has to prevent it. Step 3 resizes
to exactly the requested dimensions and step 4 allocates an RGBA buffer for the result, so a large
enough target asks Rust for an allocation it cannot make, and an allocation failure aborts the
process instead of throwing. No `try/catch` on the JavaScript side sees it. Bound the input before
you call: `packages/tui/src/terminal-capabilities.ts` refuses a target or a source over
`MAX_SIXEL_PIXELS` (16777216, roughly twice a 3840x2160 UHD/4K frame), checking the pixel
PRODUCT rather than only each axis. For example, `4096x8192` fits below a per-axis cap of
16777216 on both axes but contains 33554432 pixels. The source is checked as well as the target,
since step 2 decodes before step 3 can shrink anything.

### HTML lifecycle

1. `htmlToMarkdown(html, options)` schedules a blocking conversion task.
2. Conversion runs with defaulted options (`cleanContent=false`, `skipImages=false`) unless specified.
3. Returns markdown on success. Errors from `html_to_markdown_rs::convert` reject as `Conversion error: ...`; blocking-task infrastructure failures reject independently, and a panic is reported as ``native task `html_to_markdown` panicked: ...``.

### Clipboard lifecycle

- Text copy calls `set_text` synchronously; macOS/Windows construct a transient `arboard::Clipboard` per call, while Linux initializes one process-lifetime instance on first copy and reuses it.
- Image read constructs an `arboard::Clipboard`, calls `get_image`, encodes PNG on success, and maps `ContentNotAvailable` to `None`. Other errors normally reject. On Windows they first attempt raw `CF_DIB` retrieval and BMP-to-PNG decoding; successful recovery returns the PNG, while absent or invalid fallback data preserves and rejects with the original `arboard` error.

### Work profiling lifecycle

1. No explicit start: profiling is active when task helpers execute.
2. Every instrumented task scope records one sample on guard drop.
3. Samples overwrite oldest entries after buffer capacity is reached.
4. `getWorkProfile(lastSeconds)` reads a time window and derives folded/summary/svg artifacts.

Failure transitions:

- SVG generation failure is soft (`svg` omitted/undefined), while folded and summary still return.
- Empty sample windows return empty folded data and no SVG, not an error.

## Unsupported operations and error propagation

### SIXEL

- Unsupported or corrupted image input is a strict failure.
- Invalid SIXEL target dimensions are a strict failure.
- No JS fallback path is exposed by the natives package.

### HTML

- Conversion-library errors and native blocking-task failures are strict failures, but only conversion-library errors use the `Conversion error: ...` prefix.
- Option omission is defaulting, not failure.

### Clipboard

- Text copy is strict at the native API surface.
- Image read distinguishes "no image" (`null`/`undefined`) from operational failure. On Windows, a non-absence `arboard` error rejects only after the native raw `CF_DIB` recovery attempt fails.

### Work profiling

- Retrieval is strict for the function call itself.
- Flamegraph SVG generation is nullable/optional.
- Buffer truncation is expected ring-buffer behavior.

## Platform caveats

- Clipboard access depends on OS/session support exposed through `arboard`.
- macOS appearance and power helpers intentionally return no-op/null behavior on unsupported platforms.
- ProjFS is not exposed by this media/system native utility surface. Isolation backend selection, including any ProjFS support, lives in the separate `iso` subsystem.

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
