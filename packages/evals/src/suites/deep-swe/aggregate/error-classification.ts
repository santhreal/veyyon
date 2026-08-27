/**
 * Error grouping, failure classification, and quota stop detection.
 */
import { isRecord } from "@veyyon/utils";

export function providerFinishReason(text: string): string | null {
	const m = text.match(/finish[ _]reason:?\s*([A-Z][A-Z_]{2,})/);
	return m?.[1] ?? null;
}

export interface ProviderQuotaStop {
	resetAt: string | null;
	model: string | null;
}

export function providerQuotaStop(text: string | null | undefined): ProviderQuotaStop | null {
	if (!text) return null;
	if (!/RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/.test(text)) return null;
	const resetAt = text.match(/"quotaResetTimeStamp":\s*"([^"]+)"/)?.[1] ?? text.match(/resets_at=(\S+)/)?.[1] ?? null;
	const model = text.match(/"model":\s*"([^"]+)"/)?.[1] ?? text.match(/quota_model=(\S+)/)?.[1] ?? null;
	return { resetAt, model };
}

export function quotaStopMarker(stop: ProviderQuotaStop): string {
	const parts = ["QUOTA_EXHAUSTED"];
	if (stop.resetAt) parts.push(`resets_at=${stop.resetAt}`);
	if (stop.model) parts.push(`quota_model=${stop.model}`);
	return parts.join(" ");
}

export const NO_REWARD_ERROR = "verifier produced no reward: missing verifier_result.rewards.reward";

export function noRewardError(reward: number | null): boolean {
	return !Number.isFinite(reward ?? Number.NaN);
}

export function isAgentTimeout(error: string | null): boolean {
	if (error === null) return false;
	return /trial timed out after \d+s/i.test(error) || error.includes("AgentTimeoutError");
}

/**
 * Whether the exception record pier attached to a trial is its own agent-phase timeout.
 *
 * Pier catches that timeout, downloads the logs, collects the artifacts and still runs the
 * verifier, so a trial carrying this exception can hold a grade. Every other exception
 * reached the verifier by accident or not at all.
 */
export function isAgentTimeoutException(info: unknown): boolean {
	if (typeof info === "string") return info.includes("AgentTimeoutError");
	if (!isRecord(info)) return false;
	if (info.exception_type === "AgentTimeoutError") return true;
	const message = info.exception_message;
	return typeof message === "string" && /agent execution timed out/i.test(message);
}

const NO_PATCH_IN_CONTAINER = "Could not find the file /logs/artifacts/model.patch in container";
const CANCELLATION_MARKERS = ["KeyboardInterrupt", "CancelledError", "AgentTimeoutError"] as const;

export function finishedWithoutPatch(traceback: string | null | undefined): boolean {
	if (!traceback) return false;
	if (!traceback.includes(NO_PATCH_IN_CONTAINER)) return false;
	return !CANCELLATION_MARKERS.some(marker => traceback.includes(marker));
}

export function isHardError(result: { error: string | null; outputTokens: number | null }): boolean {
	if (isAgentTimeout(result.error)) return false;
	return result.error !== null && result.outputTokens === null;
}

export function classifyError(error: string): string {
	if (error.includes(NO_REWARD_ERROR)) return "verifier-no-reward";
	const finish = providerFinishReason(error);
	let base = "other";
	const typeMatch = error.match(/"exception_type"\s*:\s*"([^"]+)"/);
	if (typeMatch?.[1]) {
		base = typeMatch[1];
	} else if (/timed out/i.test(error)) {
		base = "timeout";
	}
	return finish ? `${base} (${finish})` : base;
}
