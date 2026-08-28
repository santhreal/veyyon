/** Encode-side gating and policy checks for argot shorthand. */

/** Gate configuration defining permitted models and context cutoff. */
export interface ArgotGate {
	/** Model identifiers permitted to encode. */
	readonly models: readonly string[];
	/** Context token threshold above which encoding is disabled. */
	readonly disableAboveTokens: number;
}

/** The live inputs a harness measures each turn and feeds to {@link shouldEncode}. */
export interface ArgotGateInput {
	/** The active model id, compared against {@link ArgotGate.models}. */
	readonly model: string;
	/** Current prompt token context size. */
	readonly contextTokens: number;
}

/** The inert gate: no model listed, no cutoff. {@link shouldEncode} is always `false`. */
export const EMPTY_GATE: ArgotGate = { models: [], disableAboveTokens: 0 };

/** The settings a harness maps onto a gate: its allowlist and optional cutoff. */
export interface MakeGateOptions {
	/** Models permitted to encode; see {@link ArgotGate.models}. Omitted or empty means none. */
	readonly models?: readonly string[];
	/** Context-token cutoff; see {@link ArgotGate.disableAboveTokens}. Omitted means no cutoff. */
	readonly disableAboveTokens?: number;
}

/** Build an ArgotGate from enabled state and options. */
export function makeGate(enabled: boolean, options: MakeGateOptions = {}): ArgotGate {
	if (!enabled) {
		return EMPTY_GATE;
	}
	return {
		models: options.models ?? [],
		disableAboveTokens: options.disableAboveTokens ?? 0,
	};
}

/** Determine whether model output should be encoded based on gate policy. */
export function shouldEncode(gate: ArgotGate, input: ArgotGateInput): boolean {
	if (gate.models.length === 0) {
		return false;
	}
	if (!gate.models.some(entry => modelAllowed(entry, input.model))) {
		return false;
	}
	if (gate.disableAboveTokens > 0 && input.contextTokens >= gate.disableAboveTokens) {
		return false;
	}
	return true;
}

/** Test if allowlist entry matches active model identifier. */
export function modelAllowed(entry: string, activeModel: string): boolean {
	if (entry.includes("/")) {
		return entry === activeModel;
	}
	return entry === modelIdSegment(activeModel);
}

/** The model-id segment of a possibly provider-qualified id: the part after the last `/`. */
export function modelIdSegment(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}
