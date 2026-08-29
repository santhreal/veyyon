export type ProviderResponseErrorKind =
	| "incomplete-stream"
	| "output"
	| "empty-body"
	| "envelope"
	| "content-blocked"
	| "runtime";

export interface ProviderResponseErrorOptions {
	provider?: string;
	kind?: ProviderResponseErrorKind;
	cause?: unknown;
}

export const PROVIDER_RESPONSE_RETRYABLE: Record<ProviderResponseErrorKind, boolean> = {
	"incomplete-stream": true,
	"empty-body": true,
	envelope: false,
	output: false,
	"content-blocked": false,
	runtime: false,
};

export function providerFinishErrorMessage(reason: string | undefined): string {
	return `Provider finish_reason: ${reason || "unknown"}`;
}

export const PROVIDER_FINISH_ERROR_PATTERN =
	/\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b|\bGeneration failed with (?:stop|finish) reason:\s*error\b/i;
