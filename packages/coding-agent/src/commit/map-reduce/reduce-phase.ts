import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
import type { ConventionalAnalysis, FileObservation } from "../../commit/types";
import { commitPrompts } from "../../prompts/commit/rows";
import { toReasoningEffort } from "../../thinking";
import {
	completeCommitSimple,
	createConventionalAnalysisTool,
	type ResolveObfuscateProviderText,
	parseConventionalAnalysisResponse,
} from "../shared-llm";

const ReduceTool = createConventionalAnalysisTool("Synthesize file observations into a conventional commit analysis.");

export interface ReducePhaseInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	observations: FileObservation[];
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
	resolveObfuscateProviderText: ResolveObfuscateProviderText;
}

export async function runReducePhase({
	model,
	apiKey,
	thinkingLevel,
	observations,
	stat,
	scopeCandidates,
	typesDescription,
	resolveObfuscateProviderText,
}: ReducePhaseInput): Promise<ConventionalAnalysis> {
	const response = await completeCommitSimple(
		model,
		sanitize => {
			const sanitizedObservations = observations
				.flatMap(observation =>
					observation.observations.map(line => `- ${sanitize(observation.file)}: ${sanitize(line)}`),
				)
				.join("\n");
			const userContent = prompt.render(commitPrompts["commit/reduce-user"].text, {
				types_description: typesDescription === undefined ? undefined : sanitize(typesDescription),
				observations: sanitizedObservations,
				stat: sanitize(stat),
				scope_candidates: sanitize(scopeCandidates),
			});
			return {
				systemPrompt: [sanitize(prompt.render(commitPrompts["commit/reduce-system"].text))],
				messages: [{ role: "user", content: sanitize(userContent), timestamp: Date.now() }],
				tools: [ReduceTool],
			};
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
		resolveObfuscateProviderText,
	);

	return parseConventionalAnalysisResponse(response, ReduceTool);
}
