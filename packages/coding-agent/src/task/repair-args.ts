/** Repair double-encoded JSON string arguments for the task tool. Models occasionally JSON-escape a string value twice when emitting a */
import type { TaskItem, TaskParams } from "./types";

/** A backslash that escapes a structural char — `\"`, `\\`, `\/`, or `\uXXXX`. */
const STRUCTURAL_ESCAPE = /\\(?:["\\/]|u[0-9a-fA-F]{4})/;

/** Whether `value` carries the signature of whole-string double-encoding rather than an incidental escape mention. A lone `\n`/`\t` in an instruction (e.g. */
function hasDoubleEncodeSignature(value: string): boolean {
	if (STRUCTURAL_ESCAPE.test(value)) return true;
	let count = 0;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 0x5c /* \ */) {
			count += 1;
			if (count >= 2) return true;
			i += 1; // skip the escaped char so `\\` counts once
		}
	}
	return false;
}

/** Return the once-unescaped string when `value` is uniformly double-encoded JSON (a well-formed JSON string body that decodes to a different string); */
export function repairDoubleEncodedJsonString(value: string): string {
	// Fast path: no backslash → nothing was escaped → the parse can never differ.
	if (!value.includes("\\")) return value;
	if (!hasDoubleEncodeSignature(value)) return value;
	let decoded: unknown;
	try {
		decoded = JSON.parse(`"${value}"`);
	} catch {
		return value;
	}
	return typeof decoded === "string" && decoded !== value ? decoded : value;
}

/** Repair a single (possibly partial) task item's prose field (`task`). */
function repairTaskItem(item: TaskItem): TaskItem {
	if (item === null || typeof item !== "object") return item;
	const task = typeof item.task === "string" ? repairDoubleEncodedJsonString(item.task) : item.task;
	if (task === item.task) return item;
	return { ...item, task };
}

/** Repair double-encoded prose in task-tool params (flat `task`, shared `context`, and each batch task item's `task`). Returns the same reference */
export function repairTaskParams(params: TaskParams): TaskParams {
	if (params === null || typeof params !== "object") return params;

	const task = typeof params.task === "string" ? repairDoubleEncodedJsonString(params.task) : params.task;
	const context = typeof params.context === "string" ? repairDoubleEncodedJsonString(params.context) : params.context;

	let tasks = params.tasks;
	if (Array.isArray(params.tasks)) {
		let changed = false;
		const repaired = params.tasks.map(item => {
			const next = repairTaskItem(item);
			if (next !== item) changed = true;
			return next;
		});
		if (changed) tasks = repaired;
	}

	if (task === params.task && context === params.context && tasks === params.tasks) {
		return params;
	}
	return { ...params, task, context, tasks };
}
