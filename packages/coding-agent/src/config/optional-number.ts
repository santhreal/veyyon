export const UNSET_NUMBER = -1;

export const UNSET_NUMBER_OPTION_VALUE = "default";

export const UNSET_NUMBER_OPTION_LABEL = "Default";

export function unsetNumberOption(description = "Use the provider default"): {
	value: string;
	label: string;
	description: string;
} {
	return { value: UNSET_NUMBER_OPTION_VALUE, label: UNSET_NUMBER_OPTION_LABEL, description };
}

export function optionalNumber(value: number | undefined | null): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isFinite(value)) return undefined;
	return value;
}

export function optionalPositiveNumber(value: number | undefined | null): number | undefined {
	const configured = optionalNumber(value);
	return configured !== undefined && configured > 0 ? configured : undefined;
}

export interface SamplingKnobs {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}

export type SamplingKnob = keyof SamplingKnobs;

const SAMPLING_KNOB_SETTERS: { [K in SamplingKnob]-?: (agent: SamplingKnobs, value: number | undefined) => void } = {
	temperature: (agent, value) => {
		agent.temperature = value;
	},
	topP: (agent, value) => {
		agent.topP = value;
	},
	topK: (agent, value) => {
		agent.topK = value;
	},
	minP: (agent, value) => {
		agent.minP = value;
	},
	presencePenalty: (agent, value) => {
		agent.presencePenalty = value;
	},
	repetitionPenalty: (agent, value) => {
		agent.repetitionPenalty = value;
	},
};

export function isSamplingKnob(id: string): id is SamplingKnob {
	return id in SAMPLING_KNOB_SETTERS;
}

export function applySamplingKnob(agent: SamplingKnobs, id: SamplingKnob, value: number | undefined): void {
	SAMPLING_KNOB_SETTERS[id](agent, value);
}

export function toNumberOrUndefined(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
