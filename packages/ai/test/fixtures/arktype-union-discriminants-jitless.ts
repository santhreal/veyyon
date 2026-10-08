/**
 * Prints as JSON, from a process configured ArkType jitless as the CLI entry configures it, the
 * union discriminant report of `arktype-union-discriminants.ts`.
 *
 * Run as its own process: ArkType reads the jitless setting when `arktype` first evaluates, so a
 * test process that already loaded it cannot observe the setting.
 */
import "./arktype-jitless";
import { reportUnionDiscriminants } from "./arktype-union-discriminants";

process.stdout.write(JSON.stringify(reportUnionDiscriminants(`j${Date.now().toString(36)}`)));
