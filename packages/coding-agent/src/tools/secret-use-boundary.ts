import { mapJsonStrings } from "../json-transform";
import { PLACEHOLDER_RE } from "../secrets/placeholder";

export interface SecretUseInspectionContext {
	obfuscateProviderText?: (text: string) => string;
}

const UNINSPECTABLE_REASON =
	"This call's arguments could not be inspected for stored secrets, so it needs explicit approval.";

function describeSecrets(redactedStrings: readonly string[]): { names: string[]; unnamed: number } {
	const names = new Set<string>();
	let unnamed = 0;
	for (const redacted of redactedStrings) {
		for (const token of redacted.match(PLACEHOLDER_RE) ?? []) {
			const body = token.slice(1, -1);
			if (/^[0-9]/.test(body)) unnamed += 1;
			else names.add(body);
		}
	}
	return { names: Array.from(names).sort(), unnamed };
}

function formatSecretUseReason(redactedStrings: readonly string[]): string {
	const { names, unnamed } = describeSecrets(redactedStrings);
	const parts: string[] = [];
	if (names.length > 0) parts.push(names.join(", "));
	if (unnamed > 0) parts.push(unnamed === 1 ? "one unnamed secret" : `${unnamed} unnamed secrets`);
	if (parts.length === 0) {
		return "This call carries a stored secret value. Approving it runs the call with the real credential.";
	}
	return `This call uses stored secret${names.length + unnamed > 1 ? "s" : ""}: ${parts.join(" and ")}. Approving it runs the call with the real credential.`;
}

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
		if (transformThrew) throw transformError;
		return UNINSPECTABLE_REASON;
	}
	if (!changed) return undefined;
	return formatSecretUseReason(redactedStrings);
}
