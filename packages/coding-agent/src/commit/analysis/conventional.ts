import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
import type { ConventionalAnalysis } from "../../commit/types";
import { commitPrompts } from "../../prompts/commit/rows";
import { toReasoningEffort } from "../../thinking";
import {
	completeCommitSimple,
	createConventionalAnalysisTool,
	type ResolveObfuscateProviderText,
	parseConventionalAnalysisResponse,
} from "../shared-llm";

const ConventionalAnalysisTool = createConventionalAnalysisTool(
	"Analyze a diff and return conventional commit classification.",
);

export interface ConventionalAnalysisInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	contextFiles?: Array<{ path: string; content: string }>;
	userContext?: string;
	typesDescription?: string;
	recentCommits?: string[];
	scopeCandidates: string;
	stat: string;
	diff: string;
	resolveObfuscateProviderText: ResolveObfuscateProviderText;
}

/**
 * Generate conventional analysis data from a diff and metadata.
 */
export async function generateConventionalAnalysis({
	model,
	apiKey,
	thinkingLevel,
	contextFiles,
	userContext,
	typesDescription,
	recentCommits,
	scopeCandidates,
	stat,
	diff,
	resolveObfuscateProviderText,
}: ConventionalAnalysisInput): Promise<ConventionalAnalysis> {
	const response = await completeCommitSimple(
		model,
		sanitize => {
			const sanitizedContextFiles = contextFiles?.map(file => ({
				path: sanitize(file.path),
				content: sanitize(file.content),
			}));
			const userContent = prompt.render(commitPrompts["commit/analysis-user"].text, {
				context_files:
					sanitizedContextFiles && sanitizedContextFiles.length > 0 ? sanitizedContextFiles : undefined,
				user_context: userContext === undefined ? undefined : sanitize(userContext),
				types_description: typesDescription === undefined ? undefined : sanitize(typesDescription),
				recent_commits: recentCommits?.map(subject => sanitize(subject)).join("\n"),
				scope_candidates: sanitize(scopeCandidates),
				stat: sanitize(stat),
				diff: sanitize(diff),
			});
			return {
				systemPrompt: [sanitize(prompt.render(commitPrompts["commit/analysis-system"].text))],
				messages: [{ role: "user", content: sanitize(userContent), timestamp: Date.now() }],
				tools: [ConventionalAnalysisTool],
			};
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
		resolveObfuscateProviderText,
	);

	return parseConventionalAnalysisResponse(response, ConventionalAnalysisTool);
}
