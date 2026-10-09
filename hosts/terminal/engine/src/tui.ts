/**
 * The engine's public surface. `TUI` and its contracts live in `core/`; this
 * module is where every consumer has always imported them from, so it states
 * them once here rather than making each one learn the new paths.
 */
export * from "./core/component-types";
export * from "./core/container";
export * from "./core/image-budget";
export * from "./core/overlay";
// The scheduler contract a host implements; the default scheduler is not public.
export type { RenderScheduler, RenderTimer } from "./core/render-scheduler";
// The resync law is asserted directly by the render-stress harness.
export { findCommittedPrefixResync } from "./core/renderer";
export type { ScrollTransport } from "./core/scroll";
// The SGR coalescer is asserted directly by the render-stress harness.
export * from "./core/sgr-coalesce";
export * from "./core/tui";
