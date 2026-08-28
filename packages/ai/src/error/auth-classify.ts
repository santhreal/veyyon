import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { isUsageLimit } from "./flags";

export function isAuthRetryableError(error: unknown): boolean {
	if (isLocalEvidence(error)) return false;
	if (isUsageLimit(error)) return true;
	if (extractHttpStatusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && extractHttpStatusFromError({ message }) === 401;
}

export const AUTH_EVIDENCE_LOCAL = "authEvidenceIsLocal";

function isLocalEvidence(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const marked = error as { [AUTH_EVIDENCE_LOCAL]?: unknown };
	return marked[AUTH_EVIDENCE_LOCAL] === true;
}
