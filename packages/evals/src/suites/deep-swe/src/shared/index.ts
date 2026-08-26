/**
 * Shared infrastructure barrel for root-level modules that `src/` subsystems
 * depend on. These modules sit at the suite root because they predate the
 * `src/` decomposition. This barrel gives `src/` a single clean import path
 * instead of every file reaching back up with `../../<module>`.
 *
 * New infrastructure modules live directly under `src/` (e.g. `src/runner/`,
 * `src/aggregate/`), and the harness adapters are now shared across suites in
 * `packages/evals/src/harnesses/`. This barrel exists only to bridge the
 * root-level modules that predate the `src/` decomposition.
 */

export * from "../../../../paths";
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
