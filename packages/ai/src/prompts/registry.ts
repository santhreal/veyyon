/**
 * Every prompt `@veyyon/ai` sends a model, owned in ONE place.
 *
 * WHAT THESE PROMPTS ARE. A dialect's format guide is the text that teaches a model
 * how to write a tool call when the provider has no native tool-calling channel, so
 * it is the difference between a call the scanner can read and prose the scanner
 * drops. Fourteen of them shipped as `.md` files sitting next to the fourteen dialect
 * modules that imported them by relative path, which meant this package had no answer
 * to "what does veyyon put in a model's system prompt from here" other than a glob,
 * and `veyyon prompt --prompts` listed none of them.
 *
 * This file states the same contract `@veyyon/coding-agent`'s registry states, at
 * this package's boundary: the import IS the registration, the id is the path under
 * `src/prompts/` without its extension, and nothing outside this file imports a `.md`
 * from that tree. `prompt-registry-coverage` pins both directions, so a new format
 * guide is unreachable until it is registered rather than quietly unlisted.
 *
 * DIRECTORIES. `dialect/` is one guide per tool-call syntax, plus the catalog
 * template that carries them; `provider/` is text a single provider needs for a
 * reason that is not about syntax.
 */
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

/**
 * Every prompt this package sends, by id. The id is the file's path under
 * `src/prompts/` without its extension, so a row and its file are found from each other
 * by reading.
 */
export const AI_PROMPTS = aiPrompts.prompts;

/**
 * NOTHING ELSE IS EXPORTED, and that is the point of the descriptor.
 *
 * A registry used to export five things beside its rows: an id union, an id list, a text
 * lookup, and a refusing lookup, each hand-written per package. `aiPrompts` carries all of
 * them (`ids`, `text`, `require`, `has`, `fileFor`, `dir`), so re-exporting them under
 * package-specific names would be the same value under two spellings, with nothing keeping
 * the pair in step. Consumers index `AI_PROMPTS` where the id is a literal, because that is
 * checked at compile time, and go through `aiPrompts.require` where it is not, because that
 * throws instead of yielding a prompt with no text.
 */
