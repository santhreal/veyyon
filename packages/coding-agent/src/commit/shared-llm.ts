import type { Api, ApiKey, AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import { completeSimple } from "@veyyon/ai/stream";
import { validateToolCall } from "@veyyon/ai/utils/validation";
// The owners, not the barrel. `type` is `@veyyon/ai`'s re-export of arktype, so
// naming arktype is naming the same module; `validateToolCall` is one function
// over a tool list. Together they were costing the whole streaming stack.
import { type as t } from "arktype";
import type { ChangelogCategory, ConventionalAnalysis } from "./types";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "./utils";

/** Live transform for repository text immediately before an external model request. */
export type ObfuscateProviderText = (text: string) => string;
export type ResolveObfuscateProviderText = () => ObfuscateProviderText | Promise<ObfuscateProviderText>;

export type CommitContextBuilder = (obfuscateProviderText: ObfuscateProviderText) => Context;

export interface CompleteCommitOptions extends Omit<SimpleStreamOptions, "apiKey"> {
	apiKey: ApiKey;
}

/**
 * Build a fresh sanitized context for every physical provider attempt.
 *
 * The API-key resolver is the one-shot transport's retry boundary. Rebuilding
 * after it resolves is deliberate: credential refresh can also refresh the
 * session's live secret runtime, so a context sanitized before that await is
 * stale by the time the retry leaves the process.
 */
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

/**
 * Shared arktype schema for the `create_conventional_analysis` tool used by
 * both the single-pass analysis call and the map-reduce reduce phase. Schemas
 * are identical across phases — only the surrounding tool `description`
 * differs to reflect the input the phase is summarizing.
 */
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

/**
 * Build a `create_conventional_analysis` tool descriptor. Phase-specific
 * `description` text is the only thing that varies between callers.
 */
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

/**
 * Extract a {@link ConventionalAnalysis} from an assistant response, preferring
 * a structured tool call and falling back to JSON embedded in text content.
 */
export function parseConventionalAnalysisResponse(
	message: AssistantMessage,
	tool: ConventionalAnalysisTool,
): ConventionalAnalysis {
	const toolCall = extractToolCall(message, tool.name);
	if (toolCall) {
		// Schema-validated against conventionalAnalysisParameters just above.
		const parsed = validateToolCall([tool], toolCall) as unknown as ParsedConventionalAnalysis;
		return normalizeAnalysis(parsed);
	}
	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as ParsedConventionalAnalysis;
	return normalizeAnalysis(parsed);
}
