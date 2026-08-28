import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";

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

export class ProviderResponseError extends Error {
	readonly provider: string | undefined;
	readonly kind: ProviderResponseErrorKind;

	constructor(message: string, options: ProviderResponseErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "output";
		if (this.kind === "content-blocked") attach(this, create(Flag.ContentBlocked));
		else if (PROVIDER_RESPONSE_RETRYABLE[this.kind]) attach(this, create(Flag.Transient));
	}
}

export class DevinApiError extends ProviderHttpError {
	override readonly name = "DevinApiError";
}

export class CursorApiError extends ProviderHttpError {
	override readonly name = "CursorApiError";
}

export class GitLabDuoApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoApiError";
}

export class GitLabDuoWorkflowApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoWorkflowApiError";
}
