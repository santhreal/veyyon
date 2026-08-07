// The owner of the trigger sentinel, not the `@veyyon/agent-core` barrel: one string against 406 modules.
// This is a settings DOMAIN, reached from `config/settings-schema.ts`, so the barrel arrived on the graph of
// the most imported module in this package.
import { AUTO_COMPACTION_THRESHOLD } from "@veyyon/agent-core/compaction/threshold";
import { INSTRUMENTATION_LEVELS } from "@veyyon/ai/instrumentation";
import { DEFAULT_TOKEN_BUDGET } from "argot";
import { unsetNumberOption } from "../optional-number";
import { EMPTY_STRING_ARRAY, HINDSIGHT_RECALL_TYPES_DEFAULT } from "./shared";

/** Context domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const CONTEXT_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Auto-Promote Context",
			description: "Promote to a larger-context model on context overflow instead of compacting",
		},
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
	},

	// Server-side (remote) compaction: OpenAI compacting the history on its own
	// side. Unrelated to `compaction.remoteEndpoint`, which is an
	// operator-configured external summarizer and shares nothing but the word.
	//
	// It applies when the SESSION model is on the OpenAI Responses API family
	// (`openai-responses` or `azure-openai-responses`, so Azure OpenAI
	// Responses deployments are included) AND that model's row reports
	// `compat.supportsServerCompaction`. Both halves are DATA, resolved per
	// host at model build time and flippable per row by config or discovery;
	// nothing here checks a provider name. OpenAI Codex is on a different api
	// and is therefore excluded. On any other model the toggle is inert and
	// compaction stays local; with the toggle off, compaction is local on every
	// model. Local means the ordinary LLM summary path, unchanged.
	//
	// When it applies, veyyon calls the compaction endpoint and stores the
	// window it returns. That window IS the compacted context, so the entry's
	// `summary` is empty and `compaction.model` does not apply. The empty
	// summary is correct: not a bug, not a placeholder, not an unfinished
	// dual-write. Writing a local summary beside the window was rejected, and
	// stays rejected, because it would pay a model to re-summarize a span the
	// provider already compacted and leave two versions of one range that can
	// disagree. Nothing is lost with one artifact: the entries the window
	// stands in for stay on disk, so a fork or a resume onto a model that
	// cannot replay the window re-expands them and compacts them locally on the
	// next pass.
	"compaction.remote": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Remote Compaction",
			description:
				"Applies only when the session model is a supported OpenAI Responses model, which includes Azure OpenAI Responses deployments; every other model, OpenAI Codex included, ignores this setting and compacts locally. On, veyyon calls the OpenAI compaction endpoint and keeps the window it returns, which preserves reasoning state across the cut. That window is the whole compacted context, so the entry stores no summary text and the compaction model chain does not apply. There is no second local summary on purpose: it would pay a model to re-summarize a span the provider already compacted and leave two versions of one range that can disagree. Off, compaction runs locally on the usual summary path and stores readable summary text.",
			keywords: ["compaction", "remote", "server", "provider", "openai", "context"],
		},
	},

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
	},

	"compaction.strategy": {
		type: "enum",
		values: ["summary"] as const,
		default: "summary",
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Type",
			description: "Summary condenses history in place and continues the same session.",
			options: [
				{
					value: "summary",
					label: "Summary",
					description: "Summarize history in place and keep working in the same session",
				},
			],
		},
	},

	// The ONE compaction-trigger setting. Its unit is part of its value, so there
	// is a single row to read and a single row to change:
	//   auto     the model's window minus the reserve (the historical default)
	//   85%      a percent of whatever window the current model has
	//   170000   an absolute amount, the same trigger on every model
	// It replaced two same-named rows (thresholdTokens + thresholdPercent) whose
	// precedence was invisible in the UI. Both are retained below as schema-only
	// keys and folded in on read by withLegacyCompactionThreshold; nothing else
	// reads them. An absolute amount larger than the current model's window is
	// honored up to `contextWindow - 1` and reported loudly, never silently
	// reinterpreted (see isThresholdTokensClampedForWindow).
	"compaction.threshold": {
		type: "string",
		default: AUTO_COMPACTION_THRESHOLD,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Auto-Compaction Threshold",
			description:
				"When auto-compaction triggers. Auto uses the model's window minus the reserve; a percent scales with each model's window; a token amount is the same trigger on every model.",
			keywords: ["compact", "compaction", "threshold", "trigger", "percent", "tokens", "window"],
			options: [
				{
					value: AUTO_COMPACTION_THRESHOLD,
					label: "Auto",
					description: "The model's context window minus the reserve",
				},
				{ value: "50%", label: "50%", description: "Halfway through the model's window" },
				{ value: "60%", label: "60%", description: "Moderate context usage" },
				{ value: "70%", label: "70%", description: "Balanced" },
				{ value: "75%", label: "75%", description: "Slightly aggressive" },
				{ value: "80%", label: "80%", description: "Typical threshold" },
				{ value: "85%", label: "85%", description: "Aggressive context usage" },
				{ value: "90%", label: "90%", description: "Very aggressive" },
				{ value: "95%", label: "95%", description: "Near the context limit" },
				{ value: "32000", label: "32k tokens", description: "Compact past 32,000 tokens on every model" },
				{ value: "64000", label: "64k tokens", description: "Compact past 64,000 tokens on every model" },
				{ value: "100000", label: "100k tokens", description: "Compact past 100,000 tokens on every model" },
				{ value: "128000", label: "128k tokens", description: "Compact past 128,000 tokens on every model" },
				{ value: "150000", label: "150k tokens", description: "Compact past 150,000 tokens on every model" },
				{ value: "200000", label: "200k tokens", description: "Compact past 200,000 tokens on every model" },
				{ value: "256000", label: "256k tokens", description: "Compact past 256,000 tokens on every model" },
				{ value: "400000", label: "400k tokens", description: "Compact past 400,000 tokens on every model" },
				{ value: "500000", label: "500k tokens", description: "Compact past 500,000 tokens on every model" },
				{ value: "1000000", label: "1M tokens", description: "Compact past 1,000,000 tokens on every model" },
			],
		},
	},

	// Retired: superseded by `compaction.threshold` (an absolute amount is now
	// written there as a bare token count). Kept valid so an existing config keeps
	// compacting at the same point, read ONLY by withLegacyCompactionThreshold.
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		retiredBy: "compaction.threshold",
	},

	// Retired: superseded by `compaction.threshold` (a percent is now written
	// there as `85%`). Read ONLY by withLegacyCompactionThreshold.
	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		retiredBy: "compaction.threshold",
	},

	// An ORDERED CHAIN, not one model: the value goes through
	// normalizeModelPatternList, so a comma-separated string and a string array
	// mean the same thing and both have always worked. The settings picker writes
	// an array. Compaction tries each in turn and moves on when a candidate is
	// unauthenticated or its window cannot hold the summarization payload.
	"compaction.model": {
		type: "modelChain",
		default: undefined,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Model",
			description:
				"Models used for in-place summary compaction, tried in order. Default: inherit — follows the main model live. Add fallbacks for when the first is unauthenticated or its window is too small.",
		},
	},

	// What happens once the configured chain is exhausted. `auto` keeps the
	// historical tail (the main model, then each model role, then the
	// largest-window model available), which is why compaction almost never
	// fails. `configured-only` stops at the models you named: compaction fails
	// with the reason instead of quietly summarizing on a model you did not pick.
	"compaction.modelFallbackStrategy": {
		type: "enum",
		values: ["auto", "configured-only"] as const,
		default: "auto",
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Fallback",
			description:
				"What to try after the compaction models you configured. Auto also tries the main model, your model roles, and the largest-window model available. Configured only stops there and fails loudly.",
			keywords: ["compaction", "fallback", "chain", "model", "candidates"],
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Fall back to the main model, your roles, then the largest window available",
				},
				{
					value: "configured-only",
					label: "Configured only",
					description: "Try only the models you configured, then fail with the reason",
				},
			],
		},
	},

	"compaction.modelContextWindow": {
		type: "number",
		// Unset is an ABSENT key: see `unset` in config/settings.ts. A sentinel
		// value here would be indistinguishable from a configured window.
		default: undefined,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Model Context",
			description:
				"Context window in tokens to assume for the compaction model. Unset uses the compaction model's own reported window. Candidates whose window cannot fit the summarization payload are skipped loudly.",
			options: [
				unsetNumberOption("Use the compaction model's own context window"),
				{ value: "32000", label: "32k", description: "32,000 tokens" },
				{ value: "64000", label: "64k", description: "64,000 tokens" },
				{ value: "128000", label: "128k", description: "128,000 tokens" },
				{ value: "200000", label: "200k", description: "200,000 tokens" },
				{ value: "400000", label: "400k", description: "400,000 tokens" },
				{ value: "1000000", label: "1M", description: "1,000,000 tokens" },
				{ value: "2000000", label: "2M", description: "2,000,000 tokens" },
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
	},

	// No default: an unset reserve tells the compaction layer the user never
	// chose one, so small-window recovery may swap in the proportional reserve
	// (see resolveBudgetReserveTokens). A materialized 16384 here would make
	// every session look explicitly configured.
	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	// Optional summarizer endpoint for the `summary` strategy. Whatever it points
	// at must return summary TEXT, which is stored exactly like a locally
	// generated summary. It is a transport, not a third strategy, and it grants
	// no provider a private history format — see remote-summarizer.ts.
	"compaction.remoteEndpoint": { type: "string", default: undefined },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
	},

	// Argot: per-project shorthand codec. The dictionary is generated from the
	// repository and kept in a local cache (never committed), regenerated as the
	// project moves. The model writes short handles like `§dbconn`; the harness
	// expands them to their full text before anything runs or is shown, so tools
	// and the display always see real values while the cheap handle stays in the
	// model's history. Off by default.
	"argot.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "experimental",
			group: "Argot",
			label: "Argot Shorthand",
			description:
				"Let the agent load token-saving shorthand for the projects it works in, kept in a local cache (nothing is written to the repository). The project you launch in is loaded for you, and the model loads any further project with the argot_load tool; it then writes short handles that the harness expands to full text before any tool runs or the display shows them.",
		},
	},

	// Whether the launch project is loaded for the session, or every load is left
	// to the agent. On (the default) the folder the session started in is armed in
	// the background as the session comes up, so shorthand works out of the box
	// without spending a model turn on it; the completed load refreshes the system
	// prompt to teach the handles, exactly as argot_load does. Off, a session
	// starts with no dictionary and stays that way until the model calls
	// argot_load. This decides WHEN a dictionary is built, never whether a handle
	// expands: expansion is unconditional once a dictionary loads, and a handle
	// already written expands whatever this holds.
	"argot.autoload": {
		type: "boolean",
		default: true,
		ui: {
			tab: "experimental",
			group: "Argot",
			condition: "argotEnabled",
			label: "Argot Startup Load",
			description:
				"Load the project you started the session in, in the background, so shorthand works without the model spending a turn on it. Off, a session starts with no dictionary until the model calls argot_load itself. Either way a handle already written still expands.",
		},
	},

	// Which models may WRITE shorthand. Expansion (decode) is unconditional once a
	// dictionary loads and stays lossless whatever this list holds; this gates only
	// the encode side — whether the notation preamble is taught. Empty means no
	// model encodes, so enabling Argot alone stays inert until a model is added.
	//
	// UNDER `encode.` WITH ITS SIBLING, because these two are the only Argot settings
	// that decide whether the model is taught to write shorthand, and the grouping is
	// what says so. `enabled`, `autoload`, `tokenBudget` and `subagents` decide whether
	// the feature runs, when a dictionary is built, how big it is, and what a child
	// agent starts with. The flat spelling migrates on load (settings.ts), so an
	// existing `argot.models` keeps working and moves itself into place.
	"argot.encode.models": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "experimental",
			group: "Argot",
			condition: "argotEnabled",
			label: "Argot Models",
			description:
				"Models allowed to write Argot shorthand, by model id. Empty (the default) means no model does, so turning Argot on alone stays inert until you add one here. A model left off this list is never taught the shorthand; handles already in history still expand.",
		},
	},

	// How many tokens the generated dictionary itself may spend. A larger budget
	// teaches more handles (more chances to save tokens in the transcript) at the
	// cost of a longer notation preamble every turn; a smaller budget keeps the
	// preamble cheap but teaches only the most central strings. This shapes what
	// the generator produces, so changing it keys a fresh cache entry (the old
	// entry, generated under the previous budget, is left intact and untouched).
	"argot.tokenBudget": {
		type: "number",
		default: DEFAULT_TOKEN_BUDGET,
		ui: {
			tab: "experimental",
			group: "Argot",
			condition: "argotEnabled",
			label: "Argot Dictionary Budget",
			description:
				"How many tokens the generated Argot dictionary may spend on its handle table. A larger budget teaches more handles (more transcript savings) but adds a longer preamble each turn; a smaller budget teaches only the most central strings. Changing it regenerates the dictionary.",
			options: [
				{ value: "500", label: "500", description: "Small dictionary; only the most central strings" },
				{ value: "1000", label: "1000 (default)", description: "The default budget" },
				{ value: "2000", label: "2000", description: "Larger dictionary; more handles, longer preamble" },
				{ value: "4000", label: "4000", description: "Large dictionary for big projects" },
			],
		},
	},

	// Stop teaching shorthand once context passes this many tokens, so a large,
	// recall-degraded context writes in full and cannot garble a handle. Handles
	// already in history still expand losslessly. -1 disables the cutoff.
	//
	// The second encode gate, so it sits beside the first. See the note above.
	"argot.encode.disableAboveTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "experimental",
			group: "Argot",
			condition: "argotEnabled",
			label: "Argot Context Cutoff",
			description:
				"Stop teaching Argot shorthand once context passes this many tokens (the model then writes in full). Handles already written still expand losslessly. -1 disables the cutoff.",
			options: [
				{ value: "-1", label: "Off", description: "Never stop encoding on context size" },
				{ value: "100000", label: "100k", description: "Stop teaching shorthand past 100,000 tokens" },
				{ value: "200000", label: "200k", description: "Stop teaching shorthand past 200,000 tokens" },
				{ value: "400000", label: "400k", description: "Stop teaching shorthand past 400,000 tokens" },
				{ value: "600000", label: "600k", description: "Stop teaching shorthand past 600,000 tokens" },
				{ value: "800000", label: "800k", description: "Stop teaching shorthand past 800,000 tokens" },
			],
		},
	},

	// How a subagent starts out with Argot shorthand. Correctness never depends on
	// this: every agent expands its own output at every boundary (a spawned child's
	// prompt, a returned result), so a handle never crosses the parent/child wire
	// and a subagent that starts empty is already correct. This only trades tokens.
	//   off     — the subagent gets no shorthand (cheapest; the parent's prompt to
	//             it is already expanded, so it reads and writes full text).
	//   fresh   — the subagent gets its own empty session and loads the project of
	//             its task itself through argot_load, independent of the parent
	//             (use when the child works a different project than the parent).
	//   inherit — the subagent starts from a copy of the parent's loaded shorthand
	//             (ArgotSession.fork), so it writes the same handles from turn one.
	"argot.subagents": {
		type: "enum",
		values: ["off", "fresh", "inherit"] as const,
		default: "off",
		ui: {
			tab: "experimental",
			group: "Argot",
			condition: "argotEnabled",
			label: "Argot in Subagents",
			description:
				"How a subagent starts with Argot shorthand. Correctness never depends on this (handles never cross the parent/child wire); it only trades tokens. off: no shorthand in subagents. fresh: the subagent loads its task's project itself through argot_load. inherit: the subagent starts from a copy of the parent's loaded shorthand.",
			options: [
				{ value: "off", label: "Off", description: "Subagents get no Argot shorthand" },
				{
					value: "fresh",
					label: "Fresh",
					description: "Subagent loads its task's project itself through argot_load",
				},
				{
					value: "inherit",
					label: "Inherit",
					description: "Subagent starts from a copy of the parent's loaded shorthand",
				},
			],
		},
	},

	"tools.format": {
		type: "enum",
		values: [
			"auto",
			"native",
			"glm",
			"hermes",
			"kimi",
			"xml",
			"anthropic",
			"deepseek",
			"harmony",
			"qwen3",
			"gemini",
			"gemma",
			"minimax",
			"pi-native",
		] as const,
		default: "auto",
		ui: {
			tab: "experimental",
			group: "Tool Calling",
			label: "Tool Calling Mode",
			description:
				"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Use native tool calls unless the model is known not to support them.",
				},
				{ value: "native", label: "Native", description: "Use provider-native tool calls." },
				{ value: "glm", label: "GLM", description: "Use GLM-style in-band tool calls." },
				{ value: "hermes", label: "Hermes", description: "Use Hermes-style in-band tool calls." },
				{ value: "kimi", label: "Kimi", description: "Use Kimi-style in-band tool calls." },
				{ value: "xml", label: "XML", description: "Use generic XML in-band tool calls." },
				{ value: "anthropic", label: "Anthropic", description: "Use Anthropic-style in-band tool calls." },
				{ value: "deepseek", label: "DeepSeek", description: "Use DeepSeek-style in-band tool calls." },
				{ value: "harmony", label: "Harmony", description: "Use Harmony-style in-band tool calls." },
				{ value: "qwen3", label: "Qwen3", description: "Use the Qwen3 owned dialect." },
				{ value: "gemini", label: "Gemini", description: "Use the Gemini owned dialect." },
				{ value: "gemma", label: "Gemma", description: "Use the Gemma owned dialect." },
				{ value: "minimax", label: "MiniMax", description: "Use the MiniMax owned dialect." },
				{ value: "pi-native", label: "pi-native", description: "Use the pi-native <call:NAME> owned dialect." },
			],
		},
	},

	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Branch Summaries",
			description: "Prompt to summarize when leaving a branch",
		},
	},

	// Prompt-cache enforcement. The check itself always runs and always records
	// its verdict; these two decide how loudly a failure is treated. Blocking is a
	// separate toggle rather than a third value of one dropdown because the two
	// questions are different: "do I want to hear about it" is a preference, and
	// "should a rejection stop the run" is a risk decision.
	//
	// BOTH ARE ANTHROPIC-ONLY, and the descriptions say so because an unqualified
	// toggle is worse than a missing one: an operator on Bedrock or OpenAI turns
	// Report on, never sees a rejection, and concludes their cache is healthy.
	// `packages/ai/src/cache` has exactly one production importer,
	// `providers/anthropic.ts`, verified across the module path, the class, the
	// state field and the resolver. Bedrock, OpenAI Responses, Azure and the
	// chat-completions path have no cache tracking at all. Widen the wording when a
	// second provider actually reports a verdict, not when one gains a cache.
	"cache.reportRejection": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Prompt cache",
			label: "Report Cache Rejections",
			description:
				"Warn when a turn asked the provider to cache a prefix and the provider cached nothing. Anthropic only; other providers do not report cache rejection",
		},
	},

	"cache.blockOnRejection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Prompt cache",
			label: "Block On Cache Rejection",
			description:
				"Anthropic only. Fail the next request after a rejected cache instead of continuing to pay full input rate. Off by default: the verdict is proven against provider usage reporting, so a provider that changes what it reports would stop the session rather than cost money",
			condition: "cacheRejectionReported",
		},
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. Legacy
	// `memories.enabled` keeps gating the local backend; see config/settings.ts
	// migration for details.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
		ui: {
			tab: "memory",
			group: "General",
			label: "Memory Backend",
			description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory",
			options: [
				{ value: "off", label: "Off", description: "No memory subsystem runs" },
				{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
				{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
				{
					value: "mnemopi",
					label: "Mnemopi",
					description: "Local SQLite recall/retain backend with optional embeddings",
				},
			],
		},
	},

	// Session telemetry uses the closed category policy in @veyyon/ai/instrumentation.
	// `off` preserves the historical record unchanged; higher levels permit
	// progressively richer structured, redacted records. Raw secrets and
	// unredacted tool arguments are forbidden at every level.
	"session.instrumentation": {
		type: "enum",
		values: INSTRUMENTATION_LEVELS,
		default: "off",
		ui: {
			tab: "context",
			group: "Session instrumentation",
			label: "Session instrumentation",
			description:
				"Record structured, redacted study data in the session file. Higher levels add lifecycle, task-state, tool, model-turn, context, and agent-communication detail for `veyyon session stats`. Off still stores the normal resumable conversation and tool history, but adds no study fields.",
			options: [
				{
					value: "off",
					label: "Off",
					description: "Store normal resumable session history without extra study data (default).",
				},
				{
					value: "basic",
					label: "Basic",
					description:
						"Adds session lifecycle and checkpoints, task-state transitions, tool wall-clock/status, and model request timing.",
				},
				{
					value: "rich",
					label: "Rich",
					description:
						"Adds context attribution, agent-message delivery facts, tool scheduling/result weight, model token throughput, and richer session-stat rollups.",
				},
				{
					value: "ultra",
					label: "Ultra",
					description:
						"Adds full provenance: tool argument fingerprints, abort state, context-to-compaction links, directional agent routes, per-task transitions, cache/reasoning detail, and upstream provider.",
				},
			],
		},
	},

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under the active profile's
	// agent/managed-skills directory.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "experimental",
			group: "Auto-Learn",
			label: "Auto-Learn",
			description:
				"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "experimental",
			group: "Auto-Learn",
			label: "Auto-run capture at stop",
			description:
				"When on, auto-run one capture turn at stop (uses extra tokens). Off = passive reminder on your next turn.",
			condition: "autolearnActive",
		},
	},
	// Config-file-only knob (numbers without `options` are hidden from the UI).
	"autolearn.minToolCalls": { type: "number", default: 5 },

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi DB Path",
			description: "Optional SQLite DB path. Defaults to the agent memories directory.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Bank",
			description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared Mnemopi bank for every project",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Project-local Mnemopi bank per cwd basename",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description: "Write to a project-local bank but merge project + shared recall results",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingVariant": {
		type: "enum",
		values: ["en", "multilingual"] as const,
		default: "en",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Embedding variant",
			description:
				"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
			options: [
				{
					value: "en",
					label: "English (bge-base-en-v1.5)",
					description: "BAAI/bge-base-en-v1.5 (768d), English-only",
				},
				{
					value: "multilingual",
					label: "Multilingual (multilingual-e5-large)",
					description: "intfloat/multilingual-e5-large (1024d), cross-language recall",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Recall",
			description: "Recall local memories into the first turn of each session",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Retain",
			description: "Retain completed conversation turns into local Mnemopi memory",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.polyphonicRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Polyphonic Recall",
			description: "Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.enhancedRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Enhanced Recall",
			description: "Enable the tiered query result cache for repeated and similar recall queries",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.proactiveLinking": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Proactive Linking",
			description:
				"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Disable Embeddings",
			description: "Force deterministic FTS-only recall instead of vector embeddings",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding Model",
			description:
				"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API URL",
			description: "Optional OpenAI-compatible embedding endpoint passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API Key",
			description: "Optional embedding API key passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Mode",
			description:
				"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint",
			condition: "mnemopiActive",
			options: [
				{ value: "none", label: "None", description: "Disable Mnemopi LLM-backed extraction" },
				{
					value: "smol",
					label: "Online (tiny)",
					description: "Use the online tiny model (the TINY role from /models, else @smol)",
				},
				{ value: "remote", label: "Remote", description: "Use the Mnemopi remote LLM settings below" },
			],
		},
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Base URL",
			description: "Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM API Key",
			description: "Optional LLM API key for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Model",
			description: "Optional LLM model name for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 8 },
	"mnemopi.recallContextTurns": { type: "number", default: 3 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 4000 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 5000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API URL",
			description: "Hindsight server URL (Cloud or self-hosted)",
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": { type: "string", default: undefined },

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Bank ID",
			description:
				"Base memory bank name. Unset uses `veyyon`. Hindsight Bank Prefix is prepended when set, and Hindsight Scoping decides whether the project name is appended (per-project) or carried as a `project:` tag instead (per-project-tagged).",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared bank — every project sees the same memories",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Isolated bank per cwd basename — projects cannot see each other's memories",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description:
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Recall",
			description: "Recall memories on the first turn of each session",
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Retain",
			description: "Retain transcript every N turns and at session boundaries",
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Retain Mode",
			description: "full-session = upsert one document per session, last-turn = chunked",
			options: [
				{
					value: "full-session",
					label: "Full session",
					description: "Upsert one document per session (recommended)",
				},
				{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "veyyon" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },
	"hindsight.requestTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.reflectTimeoutMs": { type: "number", default: 120_000 },
	"hindsight.recallTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.retainTimeoutMs": { type: "number", default: 60_000 },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Models",
			description:
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Model Auto-Seed",
			description:
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "rules",
			group: "Stream interrupts (TTSR)",
			label: "TTSR",
			description: "Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "rules",
			group: "Stream interrupts (TTSR)",
			label: "Context Mode",
			description: "What to do with partial output when TTSR triggers",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "rules",
			group: "Stream interrupts (TTSR)",
			label: "Interrupt Mode",
			description: "When to interrupt mid-stream vs inject warning after completion",
			options: [
				{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
				{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
				{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
				{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "rules",
			group: "Stream interrupts (TTSR)",
			label: "Repeat Mode",
			description:
				"How rules can repeat: once per session or after a message gap. A rule may override this in its frontmatter",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "rules",
			group: "Stream interrupts (TTSR)",
			label: "Repeat Gap",
			description: "Messages before a rule can trigger again. A rule may override this in its frontmatter",
			options: [
				{ value: "5", label: "5 messages" },
				{ value: "10", label: "10 messages" },
				{ value: "15", label: "15 messages" },
				{ value: "20", label: "20 messages" },
				{ value: "30", label: "30 messages" },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "rules",
			group: "Rules",
			label: "Built-in Rules",
			description: "Load the default rules shipped with the agent. Turn individual rules off under All Rules",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "rules",
			group: "Rules",
			label: "All Rules",
			description:
				"Every rule this project loads, each on or off. Stores only the ones you turn off, so a rule added in a later release arrives on.",
		},
	},

	// Named by the rule list, never by a row of its own: the operator turns an
	// experimental rule on where every other rule is turned on and off, and a
	// second control holding the same names would be a way for the two to
	// disagree. Its inverse `ttsr.disabledRules` is the visible row because it is
	// also the label under which the whole list is reached.
	"ttsr.experimentalRules": {
		type: "array",
		default: [] as string[],
	},

	// Google only. Gemini attaches an opaque `thoughtSignature` to every function
	// call, and until this setting existed every historical one was re-uploaded on
	// every request for the rest of the session. Measured over nine live sessions
	// they were 40.2% of the whole conversation body, more than the tool results,
	// the arguments, the thinking, and the model's own text put together: 1,295
	// signatures averaging 2,239 characters, the largest 71,636 on its own.
	// Older calls send Google's `skip_thought_signature_validator` sentinel
	// instead, which is 33 characters. See firstRetainedAssistantIndex.
	// Google only, and a SEPARATE variable from the signature window above. Gemini
	// attaches its thought signature to the function call, never to the thought
	// summary, so every one of the 1,023 thinking blocks measured across nine live
	// sessions was unsigned: 1,292,300 characters (10.8% of the conversation body)
	// of the model's own prior reasoning, re-uploaded as plain text on every
	// request with nothing the provider can replay from it. A SIGNED thinking
	// block is never dropped, whatever this is set to.
	"context.thinkingRetention": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "General",
			label: "Thinking Retention",
			description:
				"How many of the most recent assistant turns keep their unsigned thinking when the conversation is sent back. Gemini summarises its reasoning for you to read but replays the real reasoning from the signature on the tool call, so an old summary is transcript text the model re-reads and the provider ignores. Keep All resends every summary ever produced. Thinking that does carry a signature is always kept. Other providers ignore this.",
			advanced: true,
			options: [
				{ value: "-1", label: "Keep All", description: "Resend every thinking block (default)." },
				{ value: "8", label: "Last 8 turns" },
				{ value: "4", label: "Last 4 turns" },
				{ value: "1", label: "Last turn only" },
				{ value: "0", label: "None", description: "Drop every unsigned thinking block." },
			],
		},
	},

	"context.thoughtSignatureRetention": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "General",
			label: "Thought Signature Retention",
			description:
				"How many of the most recent assistant turns keep their Gemini thought signature when the conversation is sent back. Signatures let the model replay its own reasoning, and they are large, so the recent ones are the ones worth paying to resend. Keep All resends every signature ever produced, which on a long session is the single biggest thing in the context. Other providers ignore this.",
			advanced: true,
			options: [
				{ value: "-1", label: "Keep All", description: "Resend every signature (default)." },
				{ value: "8", label: "Last 8 turns" },
				{ value: "4", label: "Last 4 turns" },
				{ value: "1", label: "Last turn only" },
				{ value: "0", label: "None", description: "Send the skip sentinel for every call." },
			],
		},
	},

	"context.thoughtSignatureMaxLength": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "General",
			label: "Thought Signature Size Limit",
			description:
				"Longest Gemini thought signature still worth resending, in characters. Anything longer sends the skip sentinel instead, however recent it is. Signature sizes are lopsided: the largest tenth of them carry roughly two thirds of all signature bytes, so a limit sheds most of the weight while keeping the great majority of the reasoning chain. Use this instead of Thought Signature Retention when you want a gentler trade, or alongside it, in which case a signature is resent only if it is both recent enough and small enough. Other providers ignore this.",
			advanced: true,
			options: [
				{ value: "-1", label: "No Limit", description: "Resend a signature of any size (default)." },
				{ value: "8000", label: "8,000 characters", description: "Affects about 8% of tool calls." },
				{ value: "4000", label: "4,000 characters", description: "Affects about 15% of tool calls." },
				{ value: "2000", label: "2,000 characters", description: "Affects about 24% of tool calls." },
				{ value: "1000", label: "1,000 characters", description: "Affects about 38% of tool calls." },
			],
		},
	},
} as const;
