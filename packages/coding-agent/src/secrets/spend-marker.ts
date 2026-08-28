/** The operator-visible half of a spend. THE GAP THIS CLOSES. Expansion is audited and, outside yolo, gated — and neither of those puts */

import { escapeTerminalText } from "@veyyon/utils";
import { placeholdersIn } from "./audit";

/** Longest tool name kept in a spend line. The name arrives on the provider's tool call, so it is model-controlled text on its way to a */
const MAX_TOOL_NAME_CHARS = 64;

/** Bound and neutralise a model-supplied tool name before it reaches a rendered line. */
function safeToolName(tool: string): string {
	const bounded = tool.length > MAX_TOOL_NAME_CHARS ? `${tool.slice(0, MAX_TOOL_NAME_CHARS - 1)}…` : tool;
	return escapeTerminalText(bounded);
}

/** Named entries by name, plus how many unnamed value placeholders were present. */
function describeSpend(placeholders: readonly string[]): { names: string[]; unnamed: number } {
	const names = new Set<string>();
	let unnamed = 0;
	for (const placeholder of placeholders) {
		const body = placeholder.slice(1, -1);
		// A value placeholder's body starts with a digit and a vault name never can (see
		// placeholder.ts). Its body is an HMAC token, so it is counted rather than printed.
		if (/^[0-9]/.test(body)) unnamed += 1;
		else names.add(body);
	}
	return { names: Array.from(names).sort(), unnamed };
}

/** `one unnamed secret` / `3 unnamed secrets`, matching the approval prompt's wording. */
function describeUnnamed(unnamed: number): string {
	return unnamed === 1 ? "one unnamed secret" : `${unnamed} unnamed secrets`;
}

/** One transcript line naming what this call spent, or `undefined` when it spent nothing. @param args The tool arguments as the model wrote them, BEFORE expansion. Called after expansion there would be nothing left to name. */
export function secretSpendMarker(
	args: unknown,
	tool: string,
	known: (placeholder: string) => boolean,
): string | undefined {
	const label = safeToolName(tool);
	let placeholders: string[];
	try {
		placeholders = placeholdersIn(args, known);
	} catch {
		// The bounded walk refused these arguments (too large, too many placeholders). Expansion itself does not stop for that, so the call may still spend a credential and staying quiet
		return `This ${label} call may have spent a stored secret: its arguments could not be inspected, so no name is available.`;
	}
	if (placeholders.length === 0) return undefined;

	const { names, unnamed } = describeSpend(placeholders);
	const parts: string[] = [];
	if (names.length > 0) parts.push(`stored secret${names.length > 1 ? "s" : ""} ${names.join(", ")}`);
	if (unnamed > 0) parts.push(describeUnnamed(unnamed));
	// `placeholders` was non-empty, so at least one part exists: every placeholder body is either a
	// vault name or a digit-led value token, and both branches above push.
	return `This ${label} call spent ${parts.join(" and ")}.`;
}
