/**
 * Secret-use boundary.
 *
 * A tool call whose arguments carry a real credential requires explicit permission in every
 * non-yolo approval mode. This closes the same class of gap the cwd boundary closes, one layer
 * further in: the approval *tier* looks at what kind of tool this is and never at what the
 * arguments contain, so in `ask` / `auto-edit` / `plan` mode a `bash` call that spends a stored
 * credential was indistinguishable from one that lists a directory. Expansion was audited and
 * never gated, so `secrets.auditLog` could tell you afterwards which credential an agent had
 * already spent, and nothing could ask you first.
 *
 * yolo (the `yolo` autonomy level and the `/yolo` bypass) opts out of all permission, so it opts
 * out of this too. That is the intended "yolo bypasses everything" posture, and it is why this
 * boundary costs nothing at the shipped default. A hard user `deny` and a plan-mode mutation block
 * remain hard denials; this only ever ADDS a prompt and never downgrades a denial.
 *
 * DETECTION HOLDS NO SECOND COPY OF WHAT A SECRET LOOKS LIKE. Placeholders are already expanded by
 * the time a tool executes, so the question "does this call carry a credential" is answered by
 * re-redacting the serialized arguments through the session's own obfuscator and checking whether
 * anything changed. The obfuscator stays the only thing in the process that knows which values are
 * secret, which is what keeps this module from drifting away from it.
 *
 * THE REASON NEVER CONTAINS A VALUE. Names are read out of the REDACTED text, never the raw
 * arguments, so the string this module returns cannot carry a credential into a prompt, a log, or
 * a headless error message even if the caller mishandles it.
 */

import { PLACEHOLDER_RE } from "../secrets/placeholder";

/** The part of the tool context this boundary needs: the session's live redactor. */
export interface SecretUseInspectionContext {
	obfuscateProviderText?: (text: string) => string;
}

/**
 * Said when the arguments could not be serialized for inspection.
 *
 * Fail closed, matching the cwd boundary's unresolvable-path rule. Provider tool calls arrive as
 * JSON so this is not reachable from a well-behaved model, but the alternative to prompting is
 * auto-approving a call we were unable to look at, and that is the wrong direction for a control
 * whose whole job is to notice a credential.
 */
const UNINSPECTABLE_REASON =
	"This call's arguments could not be inspected for stored secrets, so it needs explicit approval.";

/** Named entries by name, plus how many unnamed value placeholders were present. */
function describeSecrets(redacted: string): { names: string[]; unnamed: number } {
	const names = new Set<string>();
	let unnamed = 0;
	for (const token of redacted.match(PLACEHOLDER_RE) ?? []) {
		const body = token.slice(1, -1);
		// A value placeholder's body starts with a digit and a vault name never can
		// (see placeholder.ts). Its body is an HMAC token, which means nothing to a
		// human, so it is counted rather than printed.
		if (/^[0-9]/.test(body)) unnamed += 1;
		else names.add(body);
	}
	return { names: [...names].sort(), unnamed };
}

/** One sentence naming what the call would spend, and what approving it means. */
function formatSecretUseReason(redacted: string): string {
	const { names, unnamed } = describeSecrets(redacted);
	const parts: string[] = [];
	if (names.length > 0) parts.push(names.join(", "));
	if (unnamed > 0) parts.push(unnamed === 1 ? "one unnamed secret" : `${unnamed} unnamed secrets`);
	if (parts.length === 0) {
		// Reachable when a secret is configured with `mode: replace`, which rewrites
		// the value one-way and leaves no placeholder to name. The call still spends
		// a credential, so it still needs approval; only the name is unavailable.
		return "This call carries a stored secret value. Approving it runs the call with the real credential.";
	}
	return `This call uses stored secret${names.length + unnamed > 1 ? "s" : ""}: ${parts.join(" and ")}. Approving it runs the call with the real credential.`;
}

/**
 * Why this call needs approval for its secret use, or `undefined` when it carries none.
 *
 * @param args The tool arguments as they will be executed, with placeholders already expanded.
 * @param context The tool context, for the session's live redactor. Without one there is no way to
 *   know what is secret, and no secrets are configured either, so the boundary does not apply.
 */
export function secretUseApprovalReason(args: unknown, context?: SecretUseInspectionContext): string | undefined {
	const redact = context?.obfuscateProviderText;
	if (!redact) return undefined;

	let serialized: string;
	try {
		serialized = JSON.stringify(args) ?? "";
	} catch {
		return UNINSPECTABLE_REASON;
	}
	if (serialized.length === 0) return undefined;

	const redacted = redact(serialized);
	if (redacted === serialized) return undefined;
	return formatSecretUseReason(redacted);
}
