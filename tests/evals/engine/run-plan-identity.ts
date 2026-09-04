/**
 * The identity of the plan a journal belongs to.
 *
 * A settled trial is keyed by `cellKey`: suite, task, variant name and repeat. The variant
 * name carries the model only when a run varies more than one model, and it carries an
 * overlay by basename rather than by path. So two different runs produce identical keys:
 * `--model a --run-id r` then `--resume --model b --run-id r` matched every trial run
 * against model a as already settled for model b, and the record reported b's arm with a's
 * numbers. Two overlays with the same basename in different directories collided the same
 * way, and a rerun that did not pass `--resume` at all appended to the journal already on
 * disk, so one run id held trials from two plans.
 *
 * The digest states what the key cannot: the suite version and dataset sha, the backend,
 * and every variant's harness, overlay paths, model and attachments. Task selection and
 * repeat count are deliberately absent — resuming a narrowed task list, or a run with more
 * repeats, is the same plan reaching fewer or more cells.
 */

import { createHash } from "node:crypto";
import type { Variant } from "./contracts";
import type { RunPlan } from "./run-plan";

/** A journal whose plan is not the plan this invocation would run. */
export class PlanChangedError extends Error {
	readonly journalPath: string;
	readonly recorded: string | null;
	readonly current: string;

	constructor(journalPath: string, recorded: string | null, current: string) {
		super(
			`Journal '${journalPath}' belongs to ${recorded === null ? "an unstated plan" : `plan ${recorded}`}, ` +
				`and this invocation plans ${current}. ` +
				`A run id names one plan: its suite version, backend, models and overlays. Start a new run id.`,
		);
		this.name = "PlanChangedError";
		this.journalPath = journalPath;
		this.recorded = recorded;
		this.current = current;
	}
}

/** The fields of a variant that a cell key does not distinguish. */
function variantIdentity(variant: Variant): string {
	return [
		variant.name,
		variant.harness,
		variant.configPath ?? "",
		variant.promptVariantPath ?? "",
		variant.model,
		[...variant.attachments].sort().join(","),
	].join("\u0000");
}

/**
 * A stable 16-character digest of everything a run id commits to. Sorted by variant name,
 * so the order the matrix expanded in does not change the answer.
 */
export function planIdentity(plan: RunPlan): string {
	const hash = createHash("sha256");
	hash.update(plan.suite.id);
	hash.update("\u0000");
	hash.update(plan.suite.version);
	hash.update("\u0000");
	hash.update(plan.provenance.sha ?? "");
	hash.update("\u0000");
	hash.update(plan.suite.backend);
	for (const identity of plan.variants.map(variantIdentity).sort()) {
		hash.update("\u0001");
		hash.update(identity);
	}
	return hash.digest("hex").slice(0, 16);
}
