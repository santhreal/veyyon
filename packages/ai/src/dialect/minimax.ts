import { AI_PROMPTS } from "../prompts/registry";
import type { ToolCall } from "../types";
import {
	ANTHROPIC_THINKING_TAG_PREFIXES,
	AnthropicInbandScanner,
	type AnthropicInbandScannerConfig,
} from "./anthropic";
import {
	legacyTextTranscriptRenderer,
	renderFunctionResults,
	renderInvokes,
	renderInvokeToolCall,
	renderXmlThinkingTags,
} from "./rendering";
import type { DialectDefinition, DialectRenderOptions } from "./types";

const MINIMAX_WRAPPER_TAGS: Readonly<Record<string, true>> = { tool_call: true };
const MINIMAX_BASE_TAG_PREFIXES = [
	"<minimax:tool_call",
	"</minimax:tool_call",
	"<tool_call",
	"</tool_call",
	"<invoke",
	"</invoke",
	"<parameter",
	"</parameter",
] as const;
const MINIMAX_ALL_TAG_PREFIXES = [...MINIMAX_BASE_TAG_PREFIXES, ...ANTHROPIC_THINKING_TAG_PREFIXES] as const;
const MINIMAX_SCANNER_CONFIG: AnthropicInbandScannerConfig = {
	wrapperTags: MINIMAX_WRAPPER_TAGS,
	baseTagPrefixes: MINIMAX_BASE_TAG_PREFIXES,
	allTagPrefixes: MINIMAX_ALL_TAG_PREFIXES,
};

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	if (calls.length === 0) return "";
	return `<minimax:tool_call>\n${renderInvokes(calls, options.tools ?? [])}\n</minimax:tool_call>`;
}

const definition: DialectDefinition = {
	dialect: "minimax",
	prompt: AI_PROMPTS["dialect/minimax"].text,
	createScanner: options => new AnthropicInbandScanner(options, MINIMAX_SCANNER_CONFIG),
	renderToolCall: renderInvokeToolCall,
	renderAssistantToolCalls,
	renderToolResults: renderFunctionResults,
	renderThinking: renderXmlThinkingTags,
	renderTranscript: legacyTextTranscriptRenderer({
		renderThinking: renderXmlThinkingTags,
		renderCalls: renderAssistantToolCalls,
		renderResults: renderFunctionResults,
	}),
};

export default definition;
