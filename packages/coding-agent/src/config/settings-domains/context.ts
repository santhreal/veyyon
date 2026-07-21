import { SHAPE_VARIANT_NAMES } from "@veyyon/snapcompact";
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

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
	},

	"compaction.strategy": {
		type: "enum",
		values: ["handoff", "snap"] as const,
		default: "snap",
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Type",
			description:
				"Handoff generates a session transfer; Snap archives history as dense images (snapcompact engine).",
			options: [
				{ value: "handoff", label: "Handoff", description: "Generate handoff and continue in a new session" },
				{
					value: "snap",
					label: "Snap",
					description: "Archive history onto dense bitmap images the model reads back; no LLM call",
				},
			],
		},
	},

	// The visible compaction knob is an ABSOLUTE token amount, model-independent:
	// compaction triggers when context exceeds this many tokens, whatever the
	// current model's window is. It takes priority over the legacy percent knob
	// below (see resolveThresholdTokens). When the amount exceeds the current
	// model's window it is honored up to `contextWindow - 1` and the operator is
	// notified loudly (never silently reinterpreted) — see
	// isThresholdTokensClampedForWindow.
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Threshold",
			description:
				"Auto-compact when context exceeds this many tokens (model-independent). Default = the legacy percent/reserve behavior below. Wins over the percent knob when set.",
			options: [
				{ value: "default", label: "Default", description: "Use the percent/reserve threshold below" },
				{ value: "32000", label: "32k", description: "Compact past 32,000 tokens" },
				{ value: "64000", label: "64k", description: "Compact past 64,000 tokens" },
				{ value: "100000", label: "100k", description: "Compact past 100,000 tokens" },
				{ value: "128000", label: "128k", description: "Compact past 128,000 tokens" },
				{ value: "150000", label: "150k", description: "Compact past 150,000 tokens" },
				{ value: "200000", label: "200k", description: "Compact past 200,000 tokens" },
				{ value: "256000", label: "256k", description: "Compact past 256,000 tokens" },
				{ value: "300000", label: "300k", description: "Compact past 300,000 tokens" },
				{ value: "400000", label: "400k", description: "Compact past 400,000 tokens" },
				{ value: "500000", label: "500k", description: "Compact past 500,000 tokens" },
				{ value: "750000", label: "750k", description: "Compact past 750,000 tokens" },
				{ value: "1000000", label: "1M", description: "Compact past 1,000,000 tokens" },
			],
		},
	},

	// Legacy percent-of-window threshold. Kept valid and honored only when
	// `compaction.thresholdTokens` is Default (-1). Model-relative, so the same
	// percent means a different absolute trigger on every model — prefer the
	// absolute token amount above.
	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Threshold (percent, legacy)",
			description:
				"Legacy: auto-compact when context exceeds this percent of the model's window (-1 = provider default). Ignored when the token amount above is set.",
			options: [
				{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
				{ value: "10", label: "10%", description: "Extremely early maintenance" },
				{ value: "20", label: "20%", description: "Very early maintenance" },
				{ value: "30", label: "30%", description: "Early maintenance" },
				{ value: "40", label: "40%", description: "Moderately early maintenance" },
				{ value: "50", label: "50%", description: "Halfway point" },
				{ value: "60", label: "60%", description: "Moderate context usage" },
				{ value: "70", label: "70%", description: "Balanced" },
				{ value: "75", label: "75%", description: "Slightly aggressive" },
				{ value: "80", label: "80%", description: "Typical threshold" },
				{ value: "85", label: "85%", description: "Aggressive context usage" },
				{ value: "90", label: "90%", description: "Very aggressive" },
				{ value: "95", label: "95%", description: "Near context limit" },
			],
		},
	},

	"compaction.model": {
		type: "string",
		default: undefined,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Model",
			description:
				"Model used for LLM compaction / handoff. Default: inherit — follows the main model live. Searchable picker with auth status.",
		},
	},

	"compaction.modelContextWindow": {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Compaction Model Context",
			description:
				"Context window (tokens) assumed for the compaction model (-1 = the compaction model's own context size). Candidates whose window cannot fit the summarization payload are skipped loudly.",
			options: [
				{ value: "default", label: "Default", description: "Use the compaction model's own context window" },
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

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
	},

	"compaction.remoteStreamingV2Enabled": {
		type: "boolean",
		default: true,
	},

	// No default: an unset reserve tells the compaction layer the user never
	// chose one, so small-window recovery may swap in the proportional reserve
	// (see resolveBudgetReserveTokens). A materialized 16384 here would make
	// every session look explicitly configured.
	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	"compaction.v2RetainedMessageBudget": { type: "number", default: 64000 },

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

	// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
	"snapcompact.systemPrompt": {
		type: "enum",
		values: ["none", "agents-md", "all"] as const,
		default: "none",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact System Prompt",
			description:
				"Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.",
			options: [
				{ value: "none", label: "None", description: "Keep the system prompt as text." },
				{
					value: "agents-md",
					label: "AGENTS.md",
					description: "Only move loaded context-file instructions to images, when that saves tokens.",
				},
				{
					value: "all",
					label: "All",
					description: "Move the full system prompt to images, when that saves tokens.",
				},
			],
		},
	},

	"snapcompact.toolResults": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact Tool Results",
			description:
				"Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output.",
		},
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
			tab: "context",
			group: "Experimental",
			label: "Argot Shorthand",
			description:
				"Experimental: generate token-saving shorthand for the current project and keep it in a local cache (nothing is written to the repository). The model writes short handles; the harness expands them to full text before any tool runs or the display shows them.",
		},
	},

	// Which models may WRITE shorthand. Expansion (decode) is unconditional once a
	// dictionary loads and stays lossless whatever this list holds; this gates only
	// the encode side — whether the notation preamble is taught. Empty means no
	// model encodes, so enabling Argot alone stays inert until a model is added.
	"argot.models": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Argot Models",
			description:
				"Models allowed to write Argot shorthand, by model id. Empty (the default) means no model does, so turning Argot on alone stays inert until you add one here. A model left off this list is never taught the shorthand; handles already in history still expand.",
		},
	},

	// Stop teaching shorthand once context passes this many tokens, so a large,
	// recall-degraded context writes in full and cannot garble a handle. Handles
	// already in history still expand losslessly. -1 disables the cutoff.
	"argot.disableAboveTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Experimental",
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
			tab: "context",
			group: "Experimental",
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

	"snapcompact.shape": {
		type: "enum",
		values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact Shape",
			description:
				"Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Picks a shape tuned for the current model, falling back to its provider family.",
				},
				{
					value: "8x8r-bw",
					label: "8x8 repeated, black",
					description:
						"unscii square cell, black ink, every line printed twice with the copy on a pale highlight band.",
				},
				{
					value: "8x8r-sent",
					label: "8x8 repeated, sentence hues",
					description: "Repeated grid with ink cycling six hues at sentence boundaries.",
				},
				{
					value: "8x8u-bw",
					label: "8x8, black",
					description: "Plain unscii square cell, single-printed lines, black ink.",
				},
				{
					value: "8x8u-sent",
					label: "8x8, sentence hues",
					description: "Plain unscii square cell with sentence-hue ink.",
				},
				{
					value: "6x6u-bw",
					label: "6x6 dense, black",
					description: "unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink.",
				},
				{
					value: "6x6u-sent",
					label: "6x6 dense, sentence hues",
					description: "Densest cell with sentence-hue ink.",
				},
				{
					value: "5x8-bw",
					label: "5x8 legacy, black",
					description: "Original X.org 5x8 glyphs on the 2576px frame, black ink.",
				},
				{
					value: "5x8-sent",
					label: "5x8 legacy, sentence hues",
					description: "The original snapcompact shape (pre-shape-table sessions rendered this).",
				},
				{
					value: "6x12-dim",
					label: "6x12, dimmed stopwords",
					description: "X.org 6x12 glyphs, black ink, function words dimmed gray.",
				},
				{
					value: "8x13-bw",
					label: "8x13, black",
					description: "X.org 8x13 glyphs, black ink.",
				},
				{
					value: "8on16-bw",
					label: "8x13 on 16px pitch, black",
					description: "8x13 glyphs on an 8x16 cell (extra leading), black ink.",
				},
				{
					value: "8on22-bw",
					label: "8x13 on 22px pitch (leading), black",
					description:
						"8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google.",
				},
				{
					value: "11on16-bw",
					label: "8x13 on 11px advance (tracking), black",
					description:
						"8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic.",
				},
				{
					value: "silver16-bw",
					label: "Silver 16, CJK",
					description: "Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.",
				},
				{
					value: "doc-8on16-bw",
					label: "Doc 8on16, black",
					description: "Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink.",
				},
				{
					value: "doc-8on16-sent",
					label: "Doc 8on16, sentence hues",
					description: "Two-column doc layout with sentence-hue ink.",
				},
				{
					value: "doc-8on16-sent-dim",
					label: "Doc 8on16, sentence hues + dimmed stopwords",
					description: "Two-column doc layout, sentence-hue ink, function words dimmed gray.",
				},
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

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under ~/.veyyon/profiles/default/agent/managed-skills.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Auto-Learn",
			label: "Auto-Learn (experimental)",
			description:
				"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
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
			description: "Memory bank identifier (default: project name)",
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
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR",
			description: "Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Context Mode",
			description: "What to do with partial output when TTSR triggers",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Interrupt Mode",
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
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Mode",
			description: "How rules can repeat: once per session or after a message gap",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Gap",
			description: "Messages before a rule can trigger again",
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
			tab: "context",
			group: "Rules (TTSR)",
			label: "Built-in Rules",
			description: "Load the default rules shipped with the agent (override individually with ttsr.disabledRules)",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "Disabled Rules",
			description: "Rule names to ignore entirely (applies to bundled defaults and your own rules)",
		},
	},
} as const;
