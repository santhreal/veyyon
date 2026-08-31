/**
 * The operator-visible half of a spend.
 *
 * THE GAP THIS CLOSES. Expansion is audited and, outside yolo, gated — and neither of those puts
 * anything on the operator's screen. `secrets.auditLog` is a file read after the fact, and the
 * secret-use boundary is deliberately skipped when `approvalMode === "yolo"` or the `/yolo` bypass
 * is on. yolo is the mode most likely to be running unattended, so it was exactly the configuration
 * in which a credential could leave the vault into a live command with no signal at all. The
 * transcript showed the placeholder only when the tool's renderer happened to print the field it
 * sat in, and even then a `#GITHUB_TOKEN#` that WAS expanded looked identical to one that was
 * merely mentioned and passed through as text.
 *
 * WHY IT IS COMPUTED HERE AND NOT IN THE RENDERER. The renderer holds the arguments as the model
 * wrote them, so it could find placeholders — but only the obfuscator can say which of them it
 * would actually substitute a value for, and by the time a renderer asks, the answer is a
 * prediction. This module is called at the one expansion call site
 * (`transformToolCallArguments` in `sdk.ts`), immediately before `deobfuscateToolArguments` runs,
 * with the same `knowsPlaceholder` predicate the audit log uses. The line an operator reads and the
 * line the log records therefore describe the same event and cannot drift apart.
 *
 * A VALUE CANNOT REACH THE LINE. Names are read out of placeholder BODIES, never out of any string
 * that has been through expansion. A named placeholder's body is the vault name; an unnamed one's
 * body is an HMAC token that means nothing to a human, so it is counted rather than printed, the
 * same rule the approval prompt follows.
 *
 * IT IS NOT A KNOB. A signal that a credential was spent unattended is the kind of thing whose off
 * position is the bug, so there is nothing to turn off — the same reasoning that kept the
 * secret-use boundary from becoming a fourth `secrets.*` setting. It costs nothing when no secret
 * is spent, because it returns `undefined` and the caller emits nothing.
 */

import { escapeTerminalText } from "@veyyon/utils";
import { placeholdersIn } from "./audit";

/**
 * Longest tool name kept in a spend line.
 *
 * The name arrives on the provider's tool call, so it is model-controlled text on its way to a
 * terminal. `escapeTerminalText` handles the control bytes; this handles the length, so a
 * pathological name cannot push the credential name off the operator's screen.
 */
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
	return { names: [...names].sort(), unnamed };
}

/** `one unnamed secret` / `3 unnamed secrets`, matching the approval prompt's wording. */
function describeUnnamed(unnamed: number): string {
	return unnamed === 1 ? "one unnamed secret" : `${unnamed} unnamed secrets`;
}

/**
 * One transcript line naming what this call spent, or `undefined` when it spent nothing.
 *
 * @param args The tool arguments as the model wrote them, BEFORE expansion. Called after expansion
 *   there would be nothing left to name.
 * @param tool The tool receiving them, so the line says which call spent the credential.
 * @param known Whether the session's obfuscator would substitute a value for a placeholder. This is
 *   what separates a real spend from a `#GITHUB_TOKEN#` somebody typed: an unknown placeholder is
 *   passed through as text and is not a spend.
 */
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
		// The bounded walk refused these arguments (too large, too many placeholders). Expansion
		// itself does not stop for that, so the call may still spend a credential and staying quiet
		// would be the silence this module exists to remove. Say so instead of naming nothing, and
		// never fail the call over a display line.
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
