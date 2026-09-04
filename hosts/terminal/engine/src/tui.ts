/**
 * The engine's public surface. `TUI` and its contracts live in `core/`; this
 * module is where every consumer has always imported them from, so it states
 * them once here rather than making each one learn the new paths.
 */
export * from "./core/component-types";
export * from "./core/container";
export * from "./core/image-budget";
export * from "./core/overlay";
// The SGR coalescer and the resync law are asserted directly by the render-stress harness.
export { coalesceAdjacentSgr, findCommittedPrefixResync } from "./core/renderer";
export type { ScrollTransport } from "./core/scroll";
export * from "./core/tui";
