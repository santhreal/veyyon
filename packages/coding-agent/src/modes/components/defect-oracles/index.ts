/**
 * The defect oracle registries.
 *
 * A registry is a list of guarantee ids plus a `Record` from id to a check that reads a state and
 * either returns a failure or does not. Every one of them sorts a run through `evaluateOracleRegistry`
 * into the same four outcomes, so a registry cannot report an outcome the corpus has no way to record.
 *
 * One directory rather than four files spread through `components/`: the modules were named for what
 * they judge, which is the only thing they have in common with the components beside them, and a
 * reader looking for "which surfaces have an oracle" had to know the four names.
 *
 * Each registry declares what it judges and nothing about how a state is produced. The runners that
 * mount a surface and read a frame live in `packages/coding-agent/test/helpers/`, and the corpus that
 * records a reproduction of one is `test/helpers/renderer-defect-corpus.ts`.
 */

export * from "./composer-defect-oracle";
export * from "./defect-oracle-registry";
export * from "./markdown-defect-oracle";
export * from "./overlay-defect-oracle";
export * from "./registries";
export * from "./text-primitive-defect-oracle";
export * from "./tool-render-defect-oracle";
