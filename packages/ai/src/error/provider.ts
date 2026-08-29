import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";
import type { ProviderResponseErrorKind, ProviderResponseErrorOptions } from "./provider-helpers";

export * from "./provider-helpers";

import { PROVIDER_RESPONSE_RETRYABLE } from "./provider-helpers";

export { PROVIDER_FINISH_ERROR_PATTERN, providerFinishErrorMessage } from "./provider-helpers";

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
