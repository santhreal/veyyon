import { Effort } from "../effort";

/** How one Baseten route reasons, and which depths it accepts. */
export interface BasetenRouteReasoning {
	readonly reasons: boolean;
	readonly efforts?: readonly Effort[];
}

const BASETEN_FULL_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

const BASETEN_GLM_52_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];

const BASETEN_KIMI_K3_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High, Effort.Max];

const BASETEN_ROUTE_REASONING: Readonly<Record<string, BasetenRouteReasoning>> = {
	"deepseek-ai/deepseek-v4-flash-0731": { reasons: true },
	"deepseek-ai/deepseek-v4-pro": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"moonshotai/kimi-k2.6": { reasons: false },
	"moonshotai/kimi-k2.7-code": { reasons: false },
	"moonshotai/kimi-k3": { reasons: true, efforts: BASETEN_KIMI_K3_EFFORTS },
	"nvidia/nvidia-nemotron-3-ultra-550b-a55b": { reasons: false },
	"openai/gpt-oss-120b": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"thinkingmachines/inkling": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"thinkingmachines/inkling-small": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"zai-org/glm-4.7": { reasons: false },
	"zai-org/glm-5.2": { reasons: true, efforts: BASETEN_GLM_52_EFFORTS },
	"zai-org/glm-5.2-fast": { reasons: true, efforts: BASETEN_GLM_52_EFFORTS },
};

export function basetenRouteReasoning(modelId: string): BasetenRouteReasoning | undefined {
	return BASETEN_ROUTE_REASONING[modelId.toLowerCase()];
}
