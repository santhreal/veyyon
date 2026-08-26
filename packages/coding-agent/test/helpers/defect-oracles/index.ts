/**
 * The reproduction surface for the defect oracle registries.
 *
 * A registry in `packages/coding-agent/src/modes/components/defect-oracles/` states what has to hold
 * about a surface and nothing about how a state of it is produced. This directory is the other half:
 * one runner per registry that mounts or drives the real subject, reads a state off it, and hands that
 * state to the registry, plus the corpus that records a state a run found and replays it.
 *
 * One directory rather than six files loose beside two dozen unrelated helpers. A reader looking for
 * how a family is driven had to know its module name, and a family whose runner was missing looked the
 * same as a family that had one.
 *
 * The barrel is what a suite imports. A runner that imports a sibling imports the module directly,
 * because the corpus depends on every runner and a suite importing the barrel would otherwise pull the
 * whole surface into a run that needs one primitive.
 */

export * from "./composer-oracle-runner";
export * from "./dialog-render-oracle-runner";
export * from "./diff-render-oracle-runner";
export * from "./inline-markdown-oracle-runner";
export * from "./markdown-oracle-runner";
export * from "./overlay-oracle-runner";
export * from "./renderer-defect-corpus";
export * from "./text-primitive-oracle-runner";
export * from "./tool-render-oracle-runner";
