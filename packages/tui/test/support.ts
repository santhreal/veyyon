/**
 * Test support surface, published as `@veyyon/tui/test-support`.
 *
 * These fixtures and probes are shared by renderer suites in other packages.
 * They stay here rather than moving into `@veyyon/render-oracle` because this
 * package's own suites use them, and that package already depends on this one:
 * moving them would close a dependency cycle.
 *
 * Consumers import the specifier, never a path into this directory, so the
 * files behind it can be moved without touching a caller.
 */

export * from "./helpers/destructive-paints";
export * from "./test-themes";
