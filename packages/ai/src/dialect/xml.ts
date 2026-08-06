import { AI_PROMPTS } from "../prompts/registry";
import type { ToolCall } from "../types";
import { AnthropicInbandScanner } from "./anthropic";
import { DeepSeekInbandScanner } from "./deepseek";
import {
	legacyTextTranscriptRenderer,
	renderInvokes,
	renderInvokeToolCall,
	renderToolResponseResults,
	renderXmlThinkingTags,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

class XmlInbandScanner implements InbandScanner {
	readonly #inner: InbandScanner;

	constructor(options: InbandScannerOptions = {}) {
		this.#inner =
			options.xmlTagset === "dsml" ? new DeepSeekInbandScanner(options) : new AnthropicInbandScanner(options);
	}

	feed(text: string): InbandScanEvent[] {
		return this.#inner.feed(text);
	}

	flush(): InbandScanEvent[] {
		return this.#inner.flush();
	}
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return renderInvokes(calls, options.tools ?? []);
}

const definition: DialectDefinition = {
	dialect: "xml",
	prompt: AI_PROMPTS["dialect/xml"].text,
	createScanner: options => new XmlInbandScanner(options),
	// The `<invoke>` syntax, the `<tool_response>` results and the thinking tags all belong to
	// `./rendering`, which the `anthropic` and `minimax` dialects speak as well. This dialect
	// is the bare form of it: no wrapper tag around the invokes.
	renderToolCall: renderInvokeToolCall,
	renderAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderXmlThinkingTags,
	renderTranscript: legacyTextTranscriptRenderer({
		renderThinking: renderXmlThinkingTags,
		renderCalls: renderAssistantToolCalls,
		renderResults: renderToolResponseResults,
	}),
};

export default definition;
