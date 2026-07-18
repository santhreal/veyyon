import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../../tiny/dtype";
import {
	AUTO_THINKING_MODEL_OPTIONS,
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../../tiny/models";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_OPTIONS,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
} from "../../tts/models";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_PREFERENCES, type SearchProviderId } from "../../web/search/types";

/** Providers domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const PROVIDERS_SETTINGS = {
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Privacy",
			label: "Hide Secrets",
			description: "Obfuscate secrets before sending to AI providers",
		},
	},

	// Foreign-tool config discovery
	"discovery.importForeignConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: "Discovery",
			label: "Import Other Tools' Config",
			description:
				"Auto-discover skills, context files (CLAUDE.md/AGENTS.md), rules, and MCP servers authored for other AI tools (Claude, Codex, Gemini, Cursor, opencode, and more) found on disk. On by default so global CLAUDE.md and external skills load as the base layer; disable to run on veyyon-native config only.",
		},
	},

	// Provider selection
	"providers.ollama-cloud.maxConcurrency": {
		type: "number",
		default: 3,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Ollama Cloud Max Concurrency",
			description:
				"Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit",
		},
	},
	"providers.webSearch": {
		type: "enum",
		values: SEARCH_PROVIDER_PREFERENCES,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Web Search Provider",
			description: "Preferred provider for the web_search tool",
			options: SEARCH_PROVIDER_OPTIONS,
		},
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "Excluded Web Search Providers",
			description: "Providers that web_search should never use, even as fallbacks",
		},
	},
	"providers.webSearchGeminiModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Gemini web_search model",
			description: "Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash.",
		},
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Antigravity Endpoint Mode",
			description: "Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Try production endpoint, fail over to sandbox on 5xx/429",
				},
				{
					value: "production",
					label: "Production Only",
					description: "Force production endpoint only",
				},
				{
					value: "sandbox",
					label: "Sandbox Only",
					description: "Force sandbox endpoint only",
				},
			],
		},
	},
	"providers.image": {
		type: "enum",
		values: ["auto", "openai", "antigravity", "xai", "gemini", "openrouter"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Image Provider",
			description: "Preferred provider for image generation",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: GPT model image tool > Antigravity > xAI > OpenRouter > Gemini",
				},
				{ value: "openai", label: "OpenAI", description: "Uses the active GPT Responses/Codex model" },
				{
					value: "antigravity",
					label: "Antigravity",
					description: "Requires google-antigravity OAuth",
				},
				{
					value: "xai",
					label: "xAI Grok Imagine",
					description: "Requires xAI Grok OAuth or XAI_API_KEY",
				},
				{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
				{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
			],
		},
	},
	"providers.fireworksTier": {
		type: "enum",
		values: ["standard", "priority"] as const,
		default: "standard",
		ui: {
			tab: "providers",
			group: "Fireworks",
			label: "Fireworks Tier",
			description:
				'Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.',
			options: [
				{ value: "standard", label: "Standard", description: "Default serving path (no service_tier)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority serving path: higher reliability, premium per-token pricing",
				},
			],
		},
	},
	"providers.tts": {
		type: "enum",
		values: ["auto", "local", "xai"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Text-to-Speech Provider",
			description: "Backend for the tts tool: local on-device neural TTS (Kokoro-82M) or xAI Grok Voice",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Prefer local on-device TTS; route .mp3 output to xAI when credentials exist",
				},
				{ value: "local", label: "Local", description: "On-device neural TTS (Kokoro-82M); output is WAV/PCM16" },
				{
					value: "xai",
					label: "xAI Grok Voice",
					description: "Requires xAI Grok OAuth or XAI_API_KEY; MP3 or WAV",
				},
			],
		},
	},
	"tts.localModel": {
		type: "enum",
		values: TTS_LOCAL_MODEL_VALUES,
		default: DEFAULT_TTS_LOCAL_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Local TTS Model",
			description: "On-device neural TTS model (Kokoro-82M) used by the local TTS backend",
			options: TTS_LOCAL_MODEL_OPTIONS,
		},
	},
	"tts.localVoice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Local TTS Voice",
			description: "Kokoro voice used by the local TTS backend (American/British, female/male)",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"speech.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization",
			description: "Speak the assistant's output aloud through the speakers as it streams",
		},
	},
	"speech.mode": {
		type: "enum",
		values: ["all", "assistant", "yield"] as const,
		default: "assistant",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization Mode",
			description:
				"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end",
			options: [
				{ value: "all", label: "All (messages + thinking)" },
				{ value: "assistant", label: "Assistant messages" },
				{ value: "yield", label: "Final message only" },
			],
		},
	},
	"speech.enhanced": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Enhanced Speech Rewriting",
			description:
				"Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure",
		},
	},
	"speech.voice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization Voice",
			description: "Kokoro voice used when speaking the assistant's output aloud",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model",
			description:
				"Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model",
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Device",
			description:
				"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The VEYYON_TINY_DEVICE env var overrides this.",
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Precision",
			description:
				"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The VEYYON_TINY_DTYPE env var overrides this.",
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "memory",
			group: "General",
			label: "Memory Model",
			description:
				"Mnemopi LLM for fact extraction + consolidation: online (the TINY role from /models, else smol/remote) by default, or a local on-device model",
			condition: "mnemopiActive",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Auto Thinking Model",
			description:
				"Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model",
			condition: "autoThinkingActive",
			options: AUTO_THINKING_MODEL_OPTIONS,
		},
	},
	"features.unexpectedStopDetection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Agent",
			label: "Detect unexpected stops",
			description:
				"Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue.",
		},
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Unexpected Stop Model",
			description:
				"Classifier for unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.",
			condition: "unexpectedStopDetection",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["openai", "anthropic"] as const,
		default: "anthropic",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Kimi API Format",
			description: "API format for Kimi Code provider",
			options: [
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenAI WebSockets",
			description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			options: [
				{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
				{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
				{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
			],
		},
	},

	"providers.streamFirstEventTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "Stream First Event Timeout",
			description:
				"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
			options: [
				{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
				{ value: "0", label: "Off", description: "Disable first-event timeout" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
			],
		},
	},

	"providers.streamIdleTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "Stream Idle Timeout",
			description:
				"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
			options: [
				{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
				{ value: "0", label: "Off", description: "Disable idle timeout" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenRouter Routing",
			description:
				"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
			options: [
				{ value: "default", label: "Default", description: "No suffix; use OpenRouter's default routing" },
				{ value: "nitro", label: ":nitro", description: "Prioritize throughput / lowest latency" },
				{ value: "floor", label: ":floor", description: "Prioritize cheapest available provider" },
				{ value: "online", label: ":online", description: "Enable OpenRouter's web-search plugin" },
				{
					value: "exacto",
					label: ":exacto",
					description: "Cherry-picked high-quality providers (only defined for select models)",
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Fetch Provider",
			description: "Reader backend priority for the fetch/read URL tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: native > trafilatura > lynx > parallel > jina",
				},
				{ value: "native", label: "Native", description: "In-process HTML→Markdown converter (always available)" },
				{ value: "trafilatura", label: "Trafilatura", description: "Auto-installs via uv/pip" },
				{ value: "lynx", label: "Lynx", description: "Requires lynx system package" },
				{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
				{ value: "jina", label: "Jina", description: "Uses r.jina.ai reader (JINA_API_KEY optional)" },
			],
		},
	},
	// Codex saved rate-limit resets (auto-redeem)
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Saved Resets",
			description:
				"When a turn is blocked by the Codex weekly limit on the active account and no other account is available, run the conservative saved-reset check. unset asks before spending the first eligible reset, yes spends eligible resets without prompting, and no disables the check entirely. Requires retries enabled.",
			options: [
				{
					value: "unset",
					label: "Unset",
					description: "Check eligibility, then ask before spending the first saved reset.",
				},
				{ value: "yes", label: "Yes", description: "Spend eligible saved resets without prompting." },
				{ value: "no", label: "No", description: "Do not run the saved-reset auto-redeem check." },
			],
		},
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Min Block",
			description:
				"Only auto-redeem when the natural weekly reset is at least this many minutes away (don't spend a ~30-day credit to save a short wait).",
		},
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Reserve",
			description: "Never auto-spend below this many saved resets (0 = the last credit may be spent automatically).",
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Append-Only Context",
			description:
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
			options: [
				{ value: "auto", label: "Auto", description: "Enable for known prefix-cache providers (recommended)" },
				{ value: "on", label: "On", description: "Always enable append-only context" },
				{ value: "off", label: "Off", description: "Disable append-only context" },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", group: "Services", label: "Exa", description: "Master toggle for all Exa search tools" },
	},

	"exa.enableSearch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Search",
			description: "Enable Exa basic search, deep search, code search, and crawl tools",
		},
	},

	"exa.searchDelayMs": {
		type: "number",
		default: 1_000,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Search Delay",
			description: "Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
		},
	},

	"exa.enableResearcher": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Researcher",
			description: "Enable the Exa researcher tool for AI-powered deep research",
		},
	},

	"exa.enableWebsets": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Websets",
			description: "Enable Exa webset management and enrichment tools",
		},
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "SearXNG Endpoint",
			description: "Base URL of a self-hosted SearXNG instance used for web search",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"dev.autoqa": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA",
			description: "Enable automated tool issue reporting (report_tool_issue) for all agents",
		},
	},

	// No bundled Veyyon QA-push endpoint exists yet. Default is unset so the
	// feature fails closed (see report-tool-issue.ts's `resolvePushConfig` —
	// an empty/missing endpoint short-circuits to no-op) instead of guessing
	// an upstream `qa.omp.sh`-style URL or an unowned Veyyon domain. Set this
	// or `VEYYON_AUTO_QA_PUSH_URL` explicitly to opt in.
	"dev.autoqaPush.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA Push Endpoint",
			description: "Full URL receiving Auto QA JSON reports (unset by default; no bundled endpoint)",
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
	 * process-global consent handler registered by `InteractiveMode`.
	 */
	"dev.autoqa.consent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"gc.blobs": { type: "boolean", default: true },

	"gc.archive": { type: "boolean", default: true },

	"gc.wal": { type: "boolean", default: true },

	"gc.coldArchiveAfterDays": { type: "number", default: 30 },

	"gc.retainNewestGlobal": { type: "number", default: 20 },

	"gc.retainNewestPerCwd": { type: "number", default: 10 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 32768 },
} as const;
