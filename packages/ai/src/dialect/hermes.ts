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
	dialect: "hermes",
	prompt: AI_PROMPTS["dialect/hermes"].text,
	createScanner: options => new JsonToolCallScanner(options?.parseThinking === true),
	renderToolCall: renderJsonToolCall,
	renderAssistantToolCalls: renderJsonAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "tool",
		renderThinking: renderThinkTags,
		renderCalls: renderJsonAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
