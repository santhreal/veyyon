import { getSupportedLanguages } from "@veyyon/natives";

// Load the native addon under the REAL host platform, once, at import time.
//
// The addon loader picks its `.node` file by `${process.platform}-${process.arch}`
// (packages/natives/native/loader-state.js) and caches the module on first use.
// Several TUI tests override `process.platform` (to "win32"/"darwin") inside their
// `it()` bodies to exercise platform-specific rendering branches. If the FIRST
// native call in the test process happens under that mock, the loader tries to
// load a cross-platform addon (e.g. `veyyon_natives.win32-x64-baseline.node`) that
// is never shipped to this runner — CI's `test_ts_native` downloads only the
// linux-x64 artifact — and the test dies with "Failed to load veyyon_natives
// native addon for win32-x64".
//
// Importing this module first forces the load under the real platform (module
// imports evaluate before the importing file's body and before any `it()`), so
// the cached addon is the host's. The later platform mocks then affect only the
// rendering logic that reads `process.platform`, reusing this already-loaded
// addon for width/parse work. `getSupportedLanguages` is a pure, argument-free,
// version-independent native call chosen only to trigger the load.
getSupportedLanguages();
