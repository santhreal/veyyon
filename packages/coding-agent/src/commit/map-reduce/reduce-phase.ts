import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import { completeSimple } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
import type { ConventionalAnalysis, FileObservation } from "../../commit/types";
import { PROMPTS } from "../../prompts/registry";
import { toReasoningEffort } from "../../thinking";
import { createConventionalAnalysisTool, parseConventionalAnalysisResponse } from "../shared-llm";

const ReduceTool = createConventionalAnalysisTool("Synthesize file observations into a conventional commit analysis.");

export interface ReducePhaseInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	observations: FileObservation[];
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
}

export async function runReducePhase({
	model,
	apiKey,
	thinkingLevel,
	observations,
	stat,
	scopeCandidates,
	typesDescription,
}: ReducePhaseInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(PROMPTS["commit/reduce-user"].text, {
		types_description: typesDescription,
		observations: observations.flatMap(obs => obs.observations.map(line => `- ${obs.file}: ${line}`)).join("\n"),
		stat,
		scope_candidates: scopeCandidates,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(PROMPTS["commit/reduce-system"].text)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ReduceTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseConventionalAnalysisResponse(response, ReduceTool);
}
