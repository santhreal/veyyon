/** Secret-use boundary. A tool call whose arguments carry a real credential requires explicit permission in every */

import { mapJsonStrings } from "../json-transform";
import { PLACEHOLDER_RE } from "../secrets/placeholder";

/** The part of the tool context this boundary needs: the session's live redactor. */
export interface SecretUseInspectionContext {
	obfuscateProviderText?: (text: string) => string;
}

/** Said when the bounded raw-JSON walk could not inspect every key and value. Fail closed, matching the cwd boundary's unresolvable-path rule. Provider tool calls arrive as */
const UNINSPECTABLE_REASON =
	"This call's arguments could not be inspected for stored secrets, so it needs explicit approval.";

/** Named entries by name, plus how many unnamed value placeholders were present. */
function describeSecrets(redactedStrings: readonly string[]): { names: string[]; unnamed: number } {
	const names = new Set<string>();
	let unnamed = 0;
	for (const redacted of redactedStrings) {
		for (const token of redacted.match(PLACEHOLDER_RE) ?? []) {
			const body = token.slice(1, -1);
			// A value placeholder's body starts with a digit and a vault name never can
			// (see placeholder.ts). Its body is an HMAC token, which means nothing to a
			// human, so it is counted rather than printed.
			if (/^[0-9]/.test(body)) unnamed += 1;
			else names.add(body);
		}
	}
	return { names: Array.from(names).sort(), unnamed };
}

/** One sentence naming what the call would spend, and what approving it means. */
function formatSecretUseReason(redactedStrings: readonly string[]): string {
	const { names, unnamed } = describeSecrets(redactedStrings);
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

/** Why this call needs approval for its secret use, or `undefined` when it carries none. @param args The tool arguments as they will be executed, with placeholders already expanded. @param context The tool context, for the session's live redactor. Without one there is no way to know what is secret, and no secrets are configured either, so the boundary does not apply. */
export function secretUseApprovalReason(args: unknown, context?: SecretUseInspectionContext): string | undefined {
	const redact = context?.obfuscateProviderText;
	if (!redact) return undefined;

	const redactedStrings: string[] = [];
	let changed = false;
	let transformThrew = false;
	let transformError: unknown;
	try {
		mapJsonStrings(args, raw => {
			let redacted: string;
			try {
				redacted = redact(raw);
			} catch (error) {
				transformThrew = true;
				transformError = error;
				throw error;
			}
			if (redacted !== raw) {
				changed = true;
				redactedStrings.push(redacted);
			}
			return redacted;
		});
	} catch {
		// The live confidentiality transform failing is not an inspection-limit result and must
		// remain a hard refusal. Only the bounded walk's own failures become an explicit prompt.
		if (transformThrew) throw transformError;
		return UNINSPECTABLE_REASON;
	}
	if (!changed) return undefined;
	return formatSecretUseReason(redactedStrings);
}
