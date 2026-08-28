import { definePromptRegistry, type PromptEntry } from "@veyyon/utils/prompt-registry";
import dialectAnthropic from "./dialect/anthropic.md" with { type: "text" };
import dialectDeepseek from "./dialect/deepseek.md" with { type: "text" };
import dialectGemini from "./dialect/gemini.md" with { type: "text" };
import dialectGemma from "./dialect/gemma.md" with { type: "text" };
import dialectGlm from "./dialect/glm.md" with { type: "text" };
import dialectHarmony from "./dialect/harmony.md" with { type: "text" };
import dialectHermes from "./dialect/hermes.md" with { type: "text" };
import dialectKimi from "./dialect/kimi.md" with { type: "text" };
import dialectMinimax from "./dialect/minimax.md" with { type: "text" };
import dialectPiNative from "./dialect/pi-native.md" with { type: "text" };
import dialectPromptTemplate from "./dialect/prompt-template.md" with { type: "text" };
import dialectQwen3 from "./dialect/qwen3.md" with { type: "text" };
import dialectXml from "./dialect/xml.md" with { type: "text" };
import providerGitlabDuoWorkflowChatmlNote from "./provider/gitlab-duo-workflow-chatml-note.md" with { type: "text" };

export type { PromptEntry };

export const aiPrompts = definePromptRegistry("packages/ai/src/prompts", {
	"dialect/anthropic": {
		text: dialectAnthropic,
		purpose: "teaches the `<function_calls>`/`<invoke>` tool-call syntax",
	},
	"dialect/deepseek": {
		text: dialectDeepseek,
		purpose: "teaches DeepSeek's fixed-token tool-call syntax",
	},
	"dialect/gemini": {
		text: dialectGemini,
		purpose: "teaches tool calls written as Python in a ```tool_code fence",
	},
	"dialect/gemma": {
		text: dialectGemma,
		purpose: "teaches Gemma's `<|tool_call>` block syntax",
	},
	"dialect/glm": {
		text: dialectGlm,
		purpose: "teaches GLM's `<tool_call>` arg-key/arg-value syntax",
	},
	"dialect/harmony": {
		text: dialectHarmony,
		purpose: "teaches Harmony's commentary-channel call syntax",
	},
	"dialect/hermes": {
		text: dialectHermes,
		purpose: "teaches Hermes' `<tool_call>` JSON syntax",
	},
	"dialect/kimi": {
		text: dialectKimi,
		purpose: "teaches Kimi's one-section-per-turn call syntax",
	},
	"dialect/minimax": {
		text: dialectMinimax,
		purpose: "teaches MiniMax's `<minimax:tool_call>` block syntax",
	},
	"dialect/pi-native": {
		text: dialectPiNative,
		purpose: "teaches veyyon's own `<call:NAME>` block syntax and its three forms",
	},
	"dialect/prompt-template": {
		text: dialectPromptTemplate,
		purpose: "wraps the tool catalog and a dialect's format guide into one system-prompt block",
	},
	"dialect/qwen3": {
		text: dialectQwen3,
		purpose: "teaches Qwen3's `<tool_call>` JSON syntax",
	},
	"dialect/xml": {
		text: dialectXml,
		purpose: "teaches the bare `<invoke>`/`<parameter>` tool-call syntax",
	},
	"provider/gitlab-duo-workflow-chatml-note": {
		text: providerGitlabDuoWorkflowChatmlNote,
		purpose: "tells the model that ChatML markers in its flattened history are a record, not a syntax to emit",
	},
});

export const AI_PROMPTS = aiPrompts.prompts;
