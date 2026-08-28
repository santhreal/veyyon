import { once } from "@veyyon/utils/abortable";
import { type } from "arktype";

export const usageWireSchemas = once(() => {
	const unit = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
	const status = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

	const window = type({
		id: "string",
		label: "string",
		"durationMs?": "number",
		"resetsAt?": "number",
	});

	const amount = type({
		"used?": "number",
		"limit?": "number",
		"remaining?": "number",
		"usedFraction?": "number",
		"remainingFraction?": "number",
		unit,
	});

	const scope = type({
		provider: "string",
		"accountId?": "string",
		"projectId?": "string",
		"orgId?": "string",
		"modelId?": "string",
		"tier?": "string",
		"windowId?": "string",
		"shared?": "boolean",
	});

	const limit = type({
		id: "string",
		label: "string",
		scope,
		"window?": window,
		amount,
		"status?": status,
		"notes?": "string[]",
	});

	const resetCreditDetail = type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	});

	const resetCredits = type({
		availableCount: "number",
		"credits?": resetCreditDetail.array(),
	});

	const report = type({
		provider: "string",
		fetchedAt: "number",
		limits: limit.array(),
		"resetCredits?": resetCredits,
		"notes?": "string[]",
		"metadata?": { "[string]": "unknown" },
		"raw?": "unknown",
	});

	return { unit, status, window, amount, scope, limit, resetCreditDetail, resetCredits, report };
});
