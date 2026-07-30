import type { TaskItem } from "./types";

const TRIAGE_WORD = /\b(?:triage|triaging)\b/i;

function taskLabel(item: Pick<TaskItem, "name">): string {
	return (item.name ?? "")
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Homogeneous triage is one retrieval and classification operation, not one
 * agent per row. Several substantial reviews may still run independently; this
 * rejects only batches whose every item explicitly labels itself as triage.
 */
export function isHomogeneousTriageFanout(items: readonly Pick<TaskItem, "name" | "task">[]): boolean {
	return items.length > 1 && items.every(item => TRIAGE_WORD.test(`${taskLabel(item)}\n${item.task ?? ""}`));
}

export function homogeneousTriageRefusal(count: number): string {
	return (
		`Refused ${count} parallel triage agents. Homogeneous triage is a batched lookup/classification task: ` +
		`retrieve all records with one API or search call, then classify them locally or send the complete set to one reviewer. ` +
		`Parallel agents are for independent analysis or implementation that cannot share one retrieval.`
	);
}
