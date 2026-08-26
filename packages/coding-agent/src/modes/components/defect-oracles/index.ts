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
 * Each registry declares what it judges and nothing about how a state is produced. The other half is
 * `packages/coding-agent/test/helpers/defect-oracles/`: one runner per registry that mounts or drives
 * the real subject and reads a state off it, and the corpus that records a state a run found.
 */

export * from "./composer-defect-oracle";
export * from "./defect-oracle-registry";
export * from "./dialog-render-defect-oracle";
export * from "./diff-render-defect-oracle";
export * from "./inline-markdown-defect-oracle";
export * from "./markdown-defect-oracle";
export * from "./overlay-defect-oracle";
export * from "./registries";
export * from "./text-primitive-defect-oracle";
export * from "./tool-render-defect-oracle";
