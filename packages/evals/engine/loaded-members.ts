/**
 * Every member this package has, loaded once.
 *
 * This is the module a caller reaches for when it wants "the suites" or "the
 * harnesses". Nothing here names a member: the sets come from `discover.ts`
 * reading the directories, so this module is unchanged when a member is added.
 *
 * It replaces three registry modules that each carried a module-level singleton, a
 * pair of error classes and eleven free functions delegating to it. The delegation
 * is gone: a caller says `harnesses.require(id)` rather than `requireHarness(id)`,
 * because a bare `requireSuite` in a file that also touches harnesses and backends
 * read as though there were one registry, and there were three.
 *
 * Loading happens at module evaluation. A member whose module throws on import
 * fails the process here rather than at the first trial, which is the point: a
 * broken member is a broken package, not a run that dies twenty minutes in.
 */

import type { ExecutionBackend, EvalSuite, HarnessAdapter } from "./contracts";
import { loadMembers } from "./member-discovery";
import type { Registry } from "./member-registry";

export const suites: Registry<EvalSuite> = await loadMembers<EvalSuite>("suite");
export const harnesses: Registry<HarnessAdapter> = await loadMembers<HarnessAdapter>("harness");
export const backends: Registry<ExecutionBackend> = await loadMembers<ExecutionBackend>("backend");

/**
 * Every flag the loaded harnesses read, sorted and deduplicated.
 *
 * The entrypoint unions this into its flag grammar, so a flag an adapter reads is
 * accepted exactly where that adapter exists rather than restated in a table
 * beside it.
 */
export function harnessFlags(): readonly string[] {
	return [...new Set(harnesses.list().flatMap(harness => harness.flags))].sort();
}

/** What a selection of harness ids was found to be. */
export interface SelectionVerdict {
	readonly valid: boolean;
	readonly selected: readonly string[];
	readonly unknown: readonly string[];
	readonly errors: readonly string[];
}

/**
 * Checks a harness selection before a run is planned.
 *
 * A comparison of one harness is not a comparison, so it is rejected here rather
 * than producing a run whose report has a single column and no baseline.
 */
export function validateHarnessSelection(selection: readonly string[]): SelectionVerdict {
	const known = new Set(harnesses.ids());
	const selected = selection.filter(id => known.has(id));
	const unknown = selection.filter(id => !known.has(id));
	const errors: string[] = [];
	if (unknown.length > 0) {
		errors.push(`unknown harness(es): ${unknown.join(", ")}. Available: ${[...known].sort().join(", ")}`);
	}
	if (selected.length < 2 && errors.length === 0) {
		errors.push(
			`a harness comparison needs at least 2 harnesses; got ${selected.length} (${selected.join(", ") || "none"})`,
		);
	}
	return { valid: errors.length === 0, selected, unknown, errors };
}
