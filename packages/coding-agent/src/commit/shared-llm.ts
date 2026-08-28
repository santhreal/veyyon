import type { Api, ApiKey, AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import { completeSimple } from "@veyyon/ai/stream";
import { validateToolCall } from "@veyyon/ai/utils/validation";
import { isRecord } from "@veyyon/utils/type-guards";
import { type as t } from "arktype";
import type { ChangelogCategory, ConventionalAnalysis } from "./types";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "./utils";

export type ObfuscateProviderText = (text: string) => string;
export type ResolveObfuscateProviderText = () => ObfuscateProviderText | Promise<ObfuscateProviderText>;

export type CommitContextBuilder = (obfuscateProviderText: ObfuscateProviderText) => Context;

export interface CompleteCommitOptions extends Omit<SimpleStreamOptions, "apiKey"> {
	apiKey: ApiKey;
}

export async function completeCommitSimple(
	model: Model<Api>,
	buildContext: CommitContextBuilder,
	options: CompleteCommitOptions,
	resolveObfuscateProviderText: ResolveObfuscateProviderText,
): Promise<AssistantMessage> {
	const context = buildContext(await resolveObfuscateProviderText());
	const refreshContext = async (): Promise<void> => {
		const current = buildContext(await resolveObfuscateProviderText());
		context.systemPrompt = current.systemPrompt;
		context.messages = current.messages;
		context.tools = current.tools;
	};
	const { apiKey, ...requestOptions } = options;
	const attemptApiKey: ApiKey =
		typeof apiKey === "function"
			? async resolveContext => {
					const resolved = await apiKey(resolveContext);
					await refreshContext();
					return resolved;
				}
			: apiKey;
	return completeSimple(model, context, { ...requestOptions, apiKey: attemptApiKey });
}

const changelogCategoryLiteral = t(
	"'Added' | 'Changed' | 'Fixed' | 'Deprecated' | 'Removed' | 'Security' | 'Breaking Changes'",
);

const detailItem = t({
	text: "string",
	"changelog_category?": changelogCategoryLiteral,
	"user_visible?": "boolean",
});

export const conventionalAnalysisParameters = t({
	type: "'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore' | 'style' | 'perf' | 'build' | 'ci' | 'revert'",
	scope: t("string").or("null"),
	details: detailItem.array(),
	issue_refs: "string[]",
});

export interface ConventionalAnalysisTool {
	name: "create_conventional_analysis";
	description: string;
	parameters: typeof conventionalAnalysisParameters;
}

export function createConventionalAnalysisTool(description: string): ConventionalAnalysisTool {
	return {
		name: "create_conventional_analysis",
		description,
		parameters: conventionalAnalysisParameters,
	};
}

interface ParsedConventionalAnalysis {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}

function isParsedConventionalAnalysis(value: unknown): value is ParsedConventionalAnalysis {
	if (!isRecord(value) || !Array.isArray(value.details)) return false;
	return value.details.every(detail => isRecord(detail) && typeof detail.text === "string");
}

export function parseConventionalAnalysisResponse(
	message: AssistantMessage,
	tool: ConventionalAnalysisTool,
): ConventionalAnalysis {
	const toolCall = extractToolCall(message, tool.name);
	if (toolCall) {
		const parsed = validateToolCall([tool], toolCall) as unknown as ParsedConventionalAnalysis;
		return normalizeAnalysis(parsed);
	}
	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text, isParsedConventionalAnalysis);
	return normalizeAnalysis(parsed);
}
