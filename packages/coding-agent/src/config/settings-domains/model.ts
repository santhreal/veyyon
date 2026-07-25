import { THINKING_EFFORTS } from "@veyyon/ai";
import { AUTO_THINKING } from "../../thinking";
import { unsetNumberOption } from "../optional-number";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "../service-tier";
import { DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS } from "./shared";

/** Model domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const MODEL_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	/**
	 * Default effort per model, the ONE persisted store the user edits.
	 *
	 * Rows map a model selector (`provider/id`) or `*` (any model) to an effort,
	 * including `auto`. Effort used to be spread across this list's predecessor
	 * (`defaultThinkingLevel`, a single profile-wide enum) and a `:level` suffix
	 * on each role's selector, with the precedence written inline at the call
	 * site, which is why nobody could tell which one applied. `config/effort-resolver.ts`
	 * owns the ordering; `defaultThinkingLevel` below is now read only to migrate
	 * into the `*` row.
	 */
	defaultEffort: {
		type: "record",
		default: {} as Record<string, string>,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Default Effort",
			description:
				'Effort per model, applied when a run does not ask for one. Add a model and pick its effort; the "any model" row covers every model without its own. Per profile.',
			keywords: ["thinking", "reasoning", "effort", "depth", "budget"],
		},
	},

	/**
	 * Retired in favour of {@link defaultEffort}'s `*` row, and still read so an
	 * existing settings file keeps its behaviour (see `withLegacyDefaultEffort`).
	 * No UI row: two surfaces writing one axis is the muddle this replaced.
	 */
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING],
		default: "high",
		retiredBy: "defaultEffort",
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Hide Thinking Blocks",
			description: "Hide thinking blocks in assistant responses",
			keywords: ["reasoning", "thoughts", "hide"],
		},
	},
	proseOnlyThinking: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Prose Only Thinking",
			description: "Omit code blocks from thinking summaries and replace them with an ellipsis",
		},
	},

	omitThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Omit Thinking summaries",
			description:
				"Instruct upstream providers to completely omit thinking summaries from responses (where supported)",
		},
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard",
			description: "Enable automatic stream loop detection for model reasoning and prose",
		},
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard Scan Prose",
			description: "Apply loop guard to assistant prose messages in addition to thinking logs",
		},
	},

	"model.loopGuard.toolCallReminder": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard Tool-Call Reminder",
			description:
				"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)",
		},
	},

	"model.toolCallLoopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Guard",
			description: "Detect consecutive identical tool calls across turns and inject a corrective steer",
		},
	},

	"model.toolCallLoopGuard.threshold": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Threshold",
			description: "Consecutive identical tool calls required before the corrective steer is injected",
		},
	},

	"model.toolCallLoopGuard.exemptTools": {
		type: "array",
		default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Tool-Call Loop Exempt Tools",
			description: "Tool names that may repeat consecutively without triggering the cross-turn loop guard",
		},
	},

	inlineToolDescriptors: {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Inline Tool Descriptors",
			description:
				"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Inline descriptors for Gemini models; keep them in tool schemas otherwise",
				},
				{ value: "on", label: "On", description: "Always inline descriptors in the system prompt" },
				{ value: "off", label: "Off", description: "Keep descriptors in provider tool schemas only" },
			],
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Include Model in Prompt",
			description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
		},
	},

	includeWorkspaceTree: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Include Workspace Tree",
			description:
				"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.",
		},
	},

	// Value is a personality name resolved at runtime against built-ins plus
	// Tier-B `~/.veyyon/personalities/*.md` and `.veyyon/personalities/*.md`
	// data files (project > user > built-in). "none" is a reserved sentinel
	// that omits the block. See packages/coding-agent/src/personality/resolver.ts.
	personality: {
		type: "string",
		default: "default",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Personality",
			description:
				"Communication style rendered into the system prompt's personality block. Extend via ~/.veyyon/personalities/<name>.md or project .veyyon/personalities/<name>.md",
			options: "runtime",
		},
	},

	// Sampling
	temperature: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Temperature",
			description: "Sampling temperature. 0 is deterministic, 1 is creative. Unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "0", label: "0", description: "Deterministic" },
				{ value: "0.2", label: "0.2", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.7", label: "0.7", description: "Creative" },
				{ value: "1", label: "1", description: "Maximum variety" },
			],
			keywords: ["sampling", "randomness", "creativity"],
		},
	},

	topP: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top P",
			description: "Nucleus sampling cutoff, 0 to 1. Unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "0.1", label: "0.1", description: "Very focused" },
				{ value: "0.3", label: "0.3", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.9", label: "0.9", description: "Broad" },
				{ value: "1", label: "1", description: "No nucleus filtering" },
			],
			keywords: ["sampling", "nucleus"],
		},
	},

	topK: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top K",
			description: "Sample from the top K tokens. Unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "1", label: "1", description: "Greedy top token" },
				{ value: "20", label: "20", description: "Focused" },
				{ value: "40", label: "40", description: "Balanced" },
				{ value: "100", label: "100", description: "Broad" },
			],
		},
	},

	minP: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Min P",
			description: "Minimum probability threshold, 0 to 1. Unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "0.01", label: "0.01", description: "Very permissive" },
				{ value: "0.05", label: "0.05", description: "Balanced" },
				{ value: "0.1", label: "0.1", description: "Strict" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Presence Penalty",
			description:
				"Penalty for introducing tokens already present. Negative values encourage repetition; unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "0", label: "0", description: "No penalty" },
				{ value: "0.5", label: "0.5", description: "Mild novelty" },
				{ value: "1", label: "1", description: "Encourage novelty" },
				{ value: "2", label: "2", description: "Strong novelty" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		// Unset is an ABSENT key, not a sentinel: `-1` is a value the provider takes
		// for the penalties, so it cannot also mean "no value".
		default: undefined,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Repetition Penalty",
			description:
				"Penalty for repeated tokens. Values below 1 encourage repetition; unset lets the provider choose.",
			options: [
				unsetNumberOption("Use provider default"),
				{ value: "0.8", label: "0.8", description: "Allow repetition" },
				{ value: "1", label: "1", description: "No penalty" },
				{ value: "1.1", label: "1.1", description: "Mild penalty" },
				{ value: "1.2", label: "1.2", description: "Balanced" },
				{ value: "1.5", label: "1.5", description: "Strong penalty" },
			],
		},
	},

	textVerbosity: {
		type: "enum",
		values: ["low", "medium", "high"] as const,
		default: "medium",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Text Verbosity",
			description: "OpenAI Responses and Codex response verbosity (low, medium, or high)",
			options: [
				{ value: "low", label: "Low", description: "Prefer concise responses" },
				{ value: "medium", label: "Medium", description: "Balance brevity and detail (default)" },
				{ value: "high", label: "High", description: "Prefer detailed responses" },
			],
		},
	},

	"tier.openai": {
		type: "enum",
		values: SERVICE_TIER_OPENAI_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — OpenAI",
			description:
				"How your OpenAI / OpenAI-Codex requests are queued and served, including OpenAI-family models routed via OpenRouter (none = omit the field). Sent as `service_tier`. This is serving speed and cost, not reasoning depth; depth is Default Effort.",
			keywords: ["fast", "priority", "queue", "latency", "serving"],
			options: SERVICE_TIER_OPENAI_OPTIONS,
		},
	},

	"tier.anthropic": {
		type: "enum",
		values: SERVICE_TIER_ANTHROPIC_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Anthropic",
			description:
				'How your Claude requests are queued and served. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models, and is ignored on Bedrock/Vertex Claude and via OpenRouter. This is serving speed and cost, not reasoning depth; depth is Default Effort.',
			keywords: ["fast", "priority", "queue", "latency", "serving"],
			options: SERVICE_TIER_ANTHROPIC_OPTIONS,
		},
	},

	"tier.google": {
		type: "enum",
		values: SERVICE_TIER_GOOGLE_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Google",
			description:
				"How your Gemini (Google AI Studio + Vertex) requests are queued and served, including Google-family models routed via OpenRouter (none = omit the field). Sent as the top-level `serviceTier` field. This is serving speed and cost, not reasoning depth; depth is Default Effort.",
			keywords: ["fast", "priority", "queue", "latency", "serving"],
			options: SERVICE_TIER_GOOGLE_OPTIONS,
		},
	},

	"tier.subagent": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "inherit",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Subagent",
			description:
				"How spawned task/eval subagent requests are queued and served. Inherit matches the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.",
			keywords: ["fast", "priority", "queue", "latency", "serving"],
			options: SERVICE_TIER_INHERIT_OPTIONS,
		},
	},

	"tier.advisor": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier — Advisor",
			description:
				"How advisor-model requests are queued and served. None is standard processing, Inherit matches the main agent's live per-family tiers, and picking a value applies it to the advisor model's family.",
			keywords: ["fast", "priority", "queue", "latency", "serving"],
			options: SERVICE_TIER_INHERIT_OPTIONS,
			condition: "advisorEnabled",
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			options: [
				{ value: "1", label: "1 retry" },
				{ value: "2", label: "2 retries" },
				{ value: "3", label: "3 retries" },
				{ value: "5", label: "5 retries" },
				{ value: "10", label: "10 retries" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Max Retry Delay",
			description:
				"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).",
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Model Fallback",
			description: "Allow retry recovery to switch to configured fallback models",
		},
	},
	"retry.fallbackChains": {
		type: "record",
		default: {} as Record<string, string[]>,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
			description:
				'JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model\'s id and swaps the provider.',
		},
	},
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			options: [
				{
					value: "cooldown-expiry",
					label: "Cooldown expiry",
					description: "Return to the primary model after its suppression window ends",
				},
				{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
			],
		},
	},

	"providers.anthropic.serverSideFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Anthropic Server-Side Fallback (Fable 5)",
			description:
				"When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.",
		},
	},
} as const;
