import type { Api } from "../types";
import { readProviderErrorBody } from "./error-body";
import { create } from "./flag";
import { classifySignal, recover } from "./registry";
import { isTransientStatus } from "./retryable";

const SHOULD_RETRY_HEADER = "x-should-retry";

export interface ResponseRetryPolicy {
	api?: Api;
	alsoRetry?: readonly number[];
	neverRetry?: readonly number[];
	refusesReplay?: (body: string) => boolean;
}

export function retryResponse(response: Response, body: string | undefined, policy: ResponseRetryPolicy = {}): boolean {
	const header = response.headers.get(SHOULD_RETRY_HEADER);
	if (header === "true") return true;
	if (header === "false") return false;
	const status = response.status;
	if (policy.neverRetry?.includes(status)) return false;
	if (body !== undefined && policy.refusesReplay?.(body)) return false;
	if (policy.alsoRetry?.includes(status)) return true;
	const kinds = classifySignal({
		text: body ?? "",
		status,
		api: policy.api,
		http2: undefined,
		code: undefined,
	});
	if (kinds === 0) return isTransientStatus(status);
	return recover(create(kinds), "transport").action === "retry";
}

export async function retryResponseAfterReading(
	response: Response,
	policy: ResponseRetryPolicy = {},
): Promise<boolean> {
	let body: string | undefined;
	try {
		body = (await readProviderErrorBody(response.clone())).text;
	} catch {}
	return retryResponse(response, body, policy);
}
