import { AI_PROMPTS } from "../prompts/registry";
import { JsonToolCallScanner } from "./json-tool-call-scanner";
import {
	chatMlTranscriptRenderer,
	renderJsonAssistantToolCalls,
	renderJsonToolCall,
	renderThinkTags,
	renderToolResponseResults,
} from "./rendering";
import type { DialectDefinition } from "./types";

const definition: DialectDefinition = {
	dialect: "qwen3",
	prompt: AI_PROMPTS["dialect/qwen3"].text,
	createScanner: options => new JsonToolCallScanner(options?.parseThinking !== false),
	renderToolCall: renderJsonToolCall,
	renderAssistantToolCalls: renderJsonAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "user",
		renderThinking: renderThinkTags,
		renderCalls: renderJsonAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
