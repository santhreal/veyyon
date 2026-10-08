/**
 * Prints as JSON, from a process configured ArkType jitless as the CLI entry configures it, the
 * closure census of a schema build and what each lazily created member did when read.
 *
 * Run as its own process: ArkType reads the jitless setting when `arktype` first evaluates, so a
 * test process that already loaded it cannot observe the setting.
 */
import "./arktype-jitless";
import {
	censusNodeClosures,
	exerciseLazyMembers,
	type LazyMemberBehaviour,
	type NodeClosureCensus,
} from "./arktype-lazy-members";

export interface NodeClosureReport {
	census: NodeClosureCensus;
	behaviour: LazyMemberBehaviour;
}

const report: NodeClosureReport = { census: censusNodeClosures(), behaviour: exerciseLazyMembers() };
process.stdout.write(JSON.stringify(report));
