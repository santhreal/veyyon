import { isRetryableStatus } from "@veyyon/utils/fetch-retry";
import { classify, Flag, is, recover, status, vetoesRetry } from "./flags";

export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && isRetryableStatus(status);
}

export interface ProviderRetryableHooks {
	provider?: string;
	isProviderTransient?: (error: Error) => boolean;
}

export function isProviderRetryableError(error: unknown, hooks: ProviderRetryableHooks = {}): boolean {
	if (!(error instanceof Error)) return false;
	const id = classify(error);
	if (vetoesRetry(id)) return false;
	if (hooks.isProviderTransient?.(error)) return true;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && !isTransientStatus(httpStatus)) {
		return false;
	}
	if (!is(id, Flag.Class)) return isTransientStatus(httpStatus);
	return recover(id, "transport").action === "retry";
}
