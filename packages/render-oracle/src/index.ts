/**
 * Renderer defect oracle.
 *
 * One owner for the machinery that renders terminal frames in a test and decides
 * whether what was painted is a defect. Every renderer test in the workspace
 * reaches that machinery through this module and through no other path, so the
 * files behind it can be renamed or split without touching a consumer.
 *
 * - `terminal/` an in-memory terminal that records what was written to it
 * - `frames/`   driving a TUI to a settled frame, deterministically
 * - `detect/`   what a defect looks like, one module per class of defect
 * - `fuzz/`     generated scenarios and the model they are compared against
 * - `corpus/`   cases promoted from a failing sweep, replayed forever after
 *
 * A check that needs an application module belongs in that application. This
 * package stays agnostic of what is being rendered.
 */

export * from "./corpus/recorded-defects";
export * from "./detect/boundary-bleed";
export * from "./detect/card-pads";
export * from "./detect/caret-bounds";
export * from "./detect/composer-placement";
export * from "./detect/footer-placement";
export * from "./detect/frame-inspection";
export * from "./detect/hairline-span";
export * from "./detect/horizontal-overflow";
export * from "./detect/mouse-routing";
export * from "./detect/prompt-rows";
export * from "./detect/segment-ledger";
export * from "./detect/types";
export * from "./detect/virtual-scroll-stability";
export * from "./frames/scheduler";
export * from "./frames/settle";
export * from "./fuzz/constants";
export * from "./fuzz/doubles";
export * from "./fuzz/driver";
export * from "./fuzz/driver-assertions";
export * from "./fuzz/driver-content-ops";
export * from "./fuzz/driver-operations";
export * from "./fuzz/driver-scrollback-assertions";
export * from "./fuzz/driver-shadow";
export * from "./fuzz/driver-state";
export * from "./fuzz/driver-view-ops";
export * from "./fuzz/env";
export * from "./fuzz/expected-frame";
export * from "./fuzz/model";
export * from "./fuzz/operations";
export * from "./fuzz/overlay-model";
export * from "./fuzz/random";
export * from "./fuzz/run";
export * from "./fuzz/scenarios";
export * from "./fuzz/snapshot";
export * from "./fuzz/templates";
export * from "./fuzz/text";
export * from "./fuzz/traits";
export * from "./fuzz/types";
export * from "./terminal/constants";
export * from "./terminal/engine-recovery";
export * from "./terminal/ghostty-engine";
export * from "./terminal/grid-reader";
export * from "./terminal/virtual-terminal";
