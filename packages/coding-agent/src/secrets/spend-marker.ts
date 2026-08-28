import { escapeTerminalText } from "@veyyon/utils";
import { placeholdersIn } from "./audit";

const MAX_TOOL_NAME_CHARS = 64;

function safeToolName(tool: string): string {
	const bounded = tool.length > MAX_TOOL_NAME_CHARS ? `${tool.slice(0, MAX_TOOL_NAME_CHARS - 1)}…` : tool;
	return escapeTerminalText(bounded);
}

function describeSpend(placeholders: readonly string[]): { names: string[]; unnamed: number } {
	const names = new Set<string>();
	let unnamed = 0;
	for (const placeholder of placeholders) {
		const body = placeholder.slice(1, -1);
		if (/^[0-9]/.test(body)) unnamed += 1;
		else names.add(body);
	}
	return { names: Array.from(names).sort(), unnamed };
}

function describeUnnamed(unnamed: number): string {
	return unnamed === 1 ? "one unnamed secret" : `${unnamed} unnamed secrets`;
}

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
		return `This ${label} call may have spent a stored secret: its arguments could not be inspected, so no name is available.`;
	}
	if (placeholders.length === 0) return undefined;

	const { names, unnamed } = describeSpend(placeholders);
	const parts: string[] = [];
	if (names.length > 0) parts.push(`stored secret${names.length > 1 ? "s" : ""} ${names.join(", ")}`);
	if (unnamed > 0) parts.push(describeUnnamed(unnamed));
	return `This ${label} call spent ${parts.join(" and ")}.`;
}
