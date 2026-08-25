/**
 * Shared infrastructure barrel for root-level modules that `src/` subsystems
 * depend on. These modules live at the package root for historical reasons
 * (the test-discovery rule enforces all `.test.ts` files at root, and the
 * source files grew beside them). This barrel gives `src/` a single clean
 * import path instead of every file reaching back up with `../../<module>`.
 *
 * New infrastructure modules should live directly under `src/` (e.g.
 * `src/runner/`, `src/aggregate/`, `src/systems/`). This barrel exists only
 * to bridge the root-level modules that predate the `src/` decomposition.
 */
export * from "../../arm-attachments";
export * from "../../arm-fingerprint";
export * from "../../arm-prediction";
export * from "../../arm-prompts";
export * from "../../auth-preflight";
export * from "../../auth-seed";
export * from "../../binary-pin";
export * from "../../cost-model";
export * from "../../pier-version";
export * from "../../prefix-composition";
export * from "../../replay-manifest";
export * from "../../treatment-guard";
export * from "../../trial-timeout";
