import { ToolAbortError } from "./tool-errors";

export interface AbortedPartway {
	operation: string;
	unit: { one: string; many: string };
	done: readonly string[];
	pending: readonly string[];
	doneLabel: string;
	pendingLabel: string;
	advice?: string;
	adviceWhenDone?: string;
}

export function abortedPartway(parts: AbortedPartway, cause: unknown): ToolAbortError {
	const total = parts.done.length + parts.pending.length;
	const unit = total === 1 ? parts.unit.one : parts.unit.many;
	const clauses = [`${parts.operation} cancelled after ${parts.done.length} of ${total} ${unit}`];
	if (parts.done.length > 0) clauses.push(`${parts.doneLabel}: ${parts.done.join(", ")}`);
	if (parts.pending.length > 0) clauses.push(`${parts.pendingLabel}: ${parts.pending.join(", ")}`);
	if (parts.done.length > 0 && parts.adviceWhenDone) clauses.push(parts.adviceWhenDone);
	if (parts.advice) clauses.push(parts.advice);
	return new ToolAbortError(clauses.join("; "), { cause });
}
