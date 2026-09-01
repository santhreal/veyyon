export const STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

export interface ProviderHttpErrorOptions {
	headers?: Headers;
	code?: string;
	cause?: unknown;
}
