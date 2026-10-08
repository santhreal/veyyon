import { errorMessage } from "@veyyon/utils/type-guards";
import type { GatewaySignal, GatewayVerdict } from "./domains/types";
import { classify, KIND_MASK } from "./flags";
import { answerGateway, classifyIdentity } from "./registry";

/** A gateway-facing classification of an arbitrary upstream/internal error. */
export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
}

/** The answer for a failure no gateway rule reads: the upstream failed in a way nothing here names. */
const UNANSWERED: GatewayVerdict = { status: 502, type: "upstream_error" };

/**
 * Classify an upstream or gateway-internal error into a status code and a format-neutral type.
 *
 * Every answer is a rule in the registry's `GATEWAY_RULES`, applied in its order: a status the
 * failure states, a cancellation, then the wording. `trace`, when given, receives the name of the
 * rule that answered, and stays empty for a failure no rule reads, which is answered 502
 * `upstream_error`.
 *
 * The registry's flags are computed only when a rule reads them, so a failure that states its own
 * status runs no classification at all.
 */
export function classifyGatewayError(err: unknown, trace?: string[]): GatewayErrorClassification {
	const message = errorMessage(err);
	let identity: number | undefined;
	let kinds: number | undefined;
	const signal: GatewaySignal = {
		text: message,
		statusField: statusField(err),
		get identity() {
			identity ??= classifyIdentity(err);
			return identity;
		},
		get kinds() {
			kinds ??= classify(message) & KIND_MASK;
			return kinds;
		},
	};
	const verdict = answerGateway(signal, trace) ?? UNANSWERED;
	return { status: verdict.status, type: verdict.type, message };
}

/** A numeric `status` field on the thrown value, truncated to an integer. */
function statusField(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
	return typeof err.status === "number" ? err.status | 0 : undefined;
}
