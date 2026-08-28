export interface ArgotGate {
	readonly models: readonly string[];
	readonly disableAboveTokens: number;
}

export interface ArgotGateInput {
	readonly model: string;
	readonly contextTokens: number;
}

export const EMPTY_GATE: ArgotGate = { models: [], disableAboveTokens: 0 };

export interface MakeGateOptions {
	readonly models?: readonly string[];
	readonly disableAboveTokens?: number;
}

export function makeGate(enabled: boolean, options: MakeGateOptions = {}): ArgotGate {
	if (!enabled) {
		return EMPTY_GATE;
	}
	return {
		models: options.models ?? [],
		disableAboveTokens: options.disableAboveTokens ?? 0,
	};
}

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

export function modelAllowed(entry: string, activeModel: string): boolean {
	if (entry.includes("/")) {
		return entry === activeModel;
	}
	return entry === modelIdSegment(activeModel);
}

export function modelIdSegment(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}
