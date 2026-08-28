import { renderHelpParagraph, renderHelpTable } from "@veyyon/utils/cli";
import { APP_NAME, CONFIG_DIR_NAME } from "@veyyon/utils/dirs";
import { pluralize } from "@veyyon/utils/format";
import { nearestNames } from "@veyyon/utils/levenshtein";
import chalk from "chalk";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel, parseCliThinkingLevel } from "../thinking";
import { BUILTIN_TOOL_NAMES, type BuiltinToolName, normalizeToolNames } from "../tools/builtin-names";
import {
	BOOLEAN_FLAGS,
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	type ParseDeps,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_SETTERS,
	STRING_VALUE_FLAGS,
	VALUELESS_FLAGS,
} from "./flag-tables";
import { CliUsageError } from "./usage-error";

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;
	profile?: string;
	alias?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	config?: string[];
	smol?: string;
	slow?: string;
	plan?: string;
	subagentModel?: string;
	compactionModel?: string;
	prewalk?: boolean;
	noPrewalk?: boolean;
	prewalkInto?: string;
	planYolo?: boolean;
	planYoloInto?: string;
	maxTime?: number;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: ConfiguredThinkingLevel;
	hideThinking?: boolean;
	advisor?: boolean;
	continue?: boolean;
	resume?: string | true;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	fork?: string;
	join?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	hooks?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	printThoughts?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	noTitle?: boolean;
	autoApprove?: boolean;
	dangerouslySkipPermissions?: boolean;
	approvalMode?: "plan" | "ask" | "ask-command" | "auto" | "yolo" | "always-ask" | "write" | "auto-edit";
	messages: string[];
	fileArgs: string[];
	unknownFlags: Map<string, boolean | string>;
	unrecognizedFlags: string[];
}

const PARSE_DEPS: ParseDeps = {
	parseThinking: parseCliThinkingLevel,
	builtinToolNames: BUILTIN_TOOL_NAMES,
	normalizeToolNames,
	thinkingEfforts: CLI_THINKING_LEVELS,
};

const WINDOWS_PATH_VALUE_FLAGS: ReadonlySet<string> = new Set(["--extension", "-e", "--hook"]);
const WINDOWS_PATH_START_RE =
	/^(?:[A-Za-z]:[\\/]|\\\\[?]\\(?:[A-Za-z]:[\\/]|UNC[\\/])|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/\/[?]\/(?:[A-Za-z]:\/|UNC\/)|\/\/[^/]+\/[^/]+\/)/;
const WINDOWS_MODULE_PATH_SUFFIX_RE = /\.(?:[cm]?[jt]sx?)$/i;

function consumeBuiltInStringValue(flag: string, args: string[], valueIndex: number): { value: string; index: number } {
	const value = args[valueIndex];
	if (
		value === undefined ||
		!WINDOWS_PATH_VALUE_FLAGS.has(flag) ||
		!WINDOWS_PATH_START_RE.test(value) ||
		WINDOWS_MODULE_PATH_SUFFIX_RE.test(value)
	) {
		return { value: value ?? "", index: valueIndex };
	}

	let candidate = value;
	for (let index = valueIndex + 1; index < args.length; index++) {
		const next = args[index];
		if (next === PROFILE_BOOTSTRAP_BOUNDARY_ARG || next.startsWith("-")) break;
		candidate += ` ${next}`;
		if (WINDOWS_MODULE_PATH_SUFFIX_RE.test(candidate)) {
			return { value: candidate, index };
		}
	}

	return { value, index: valueIndex };
}

export function parseArgs(inputArgs: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	const args = inputArgs.slice();
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};

	let sawSeparator = false;
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		if (sawSeparator) {
			result.messages.push(arg);
			continue;
		}
		if (arg === PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
			continue;
		}
		const flagIndex = i;

		let equalsValueIndex = -1;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			args.splice(i + 1, 0, value);
			equalsValueIndex = i + 1;
		}

		const extFlag = arg.startsWith("--") ? extensionFlags?.get(arg.slice(2)) : undefined;
		if (extFlag) {
			const flagName = arg.slice(2);
			if (extFlag.type === "boolean") {
				result.unknownFlags.set(flagName, true);
			} else if (extFlag.type === "string" && i + 1 < args.length) {
				if (equalsValueIndex !== -1 || !args[i + 1].startsWith("-")) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
		} else if (STRING_VALUE_FLAGS.has(arg)) {
			const next = args[i + 1];
			if (next === undefined) {
				throw new CliUsageError(`${arg} needs a value. Write \`${arg} <value>\` or \`${arg}=<value>\`.`);
			}
			if (next === PROFILE_BOOTSTRAP_BOUNDARY_ARG) continue;
			const consumed = consumeBuiltInStringValue(arg, args, i + 1);
			i = consumed.index;
			STRING_SETTERS[arg](result, consumed.value, PARSE_DEPS);
		} else if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			const next = args[i + 1];
			const consume =
				next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0);
			config.set(result, consume ? args[++i] : undefined);
		} else if (arg === "--profile") {
			if (i + 1 >= args.length) throw new CliUsageError("--profile needs a value. Write `--profile <name>`.");
			result.profile = args[++i];
		} else if (arg === "--alias") {
			if (i + 1 >= args.length) throw new CliUsageError("--alias needs a value. Write `--alias <command>`.");
			result.alias = args[++i];
		} else {
			const booleanField = BOOLEAN_FLAGS[arg];
			if (booleanField !== undefined) {
				(result as unknown as Record<string, unknown>)[booleanField] = true;
			} else if (arg.startsWith("@")) {
				let filePath = arg.slice(1);
				if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length > 1) {
					filePath = filePath.slice(1, -1);
				} else if (filePath.startsWith("'") && filePath.endsWith("'") && filePath.length > 1) {
					filePath = filePath.slice(1, -1);
				}
				result.fileArgs.push(filePath);
			} else if (!arg.startsWith("-") || arg === "-") {
				result.messages.push(arg);
			} else if (arg === "--") {
				sawSeparator = true;
			} else {
				result.unrecognizedFlags.push(arg);
			}
		}
		if (equalsValueIndex !== -1 && i === flagIndex) {
			args.splice(equalsValueIndex, 1);
		}
	}

	return result;
}

function knownFlagNames(): string[] {
	return Array.from(new Set([...STRING_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...VALUELESS_FLAGS]));
}

export function reportUnrecognizedFlags(
	args: Pick<Args, "unrecognizedFlags">,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (args.unrecognizedFlags.length === 0) return false;
	const flags = args.unrecognizedFlags;
	write(`${chalk.red(`Error: unknown ${pluralize("flag", flags.length)}: ${flags.join(", ")}`)}\n`);
	const known = knownFlagNames();
	for (const flag of flags) {
		const suggestions = nearestNames(
			flag.replace(/^-+/, ""),
			known.map(name => name.replace(/^-+/, "")),
			3,
		);
		if (suggestions.length > 0) {
			write(`Did you mean ${suggestions.map(name => `\`--${name}\``).join(" or ")}?\n`);
		}
	}
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

export function reportCliUsageError(
	error: unknown,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (!(error instanceof CliUsageError)) return false;
	write(`${chalk.red(`Error: ${error.message}`)}\n`);
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

function envSection(title: string, rows: ReadonlyArray<readonly [string, string]>): string[] {
	return [`  ${chalk.dim(`# ${title}`)}`, ...renderHelpTable(rows, { indent: "  " }), ""];
}

const BUILTIN_TOOL_HELP: Record<BuiltinToolName, string> = {
	argot_load: "Load a folder's Argot shorthand so its paths can be written as short handles",
	argot_unload: "Stop being taught a folder's Argot shorthand",
	ask: "Ask the user a clarifying question",
	ast_edit: "Perform AST-aware code edits (structural refactoring)",
	ast_grep: "Search code with AST patterns (structural grep)",
	bash: "Run a shell command",
	browser: "Control a headless browser to navigate and interact with web pages",
	checkpoint: "Create a git-based checkpoint to save and restore session state",
	debug: "Debug a running process with DAP (debug adapter protocol)",
	edit: "Apply line-anchored patches to existing files",
	eval: `Run code in a persistent Python or JavaScript kernel (Python needs: ${APP_NAME} setup python)`,
	github: "Interact with GitHub issues, pull requests, and repositories",
	glob: "Find files by glob pattern",
	grep: "Grep file contents using ripgrep (fast regex search)",
	inspect_image: "Describe or analyze an image file",
	irc: "Send and receive messages between agents",
	job: "Manage long-running background jobs",
	launch: "Launch and control shared long-running project processes",
	learn: "Capture a reusable lesson to memory, and optionally a managed skill",
	lsp: "Query LSP (language server) for diagnostics, hover info, and references",
	manage_skill: "Create, update, or delete an isolated managed skill",
	memory_edit: "Update, forget, or invalidate Mnemopi memories",
	read: "Read files, directories (optionally bounded by depth/limit), archives, documents, images, and URLs",
	recall: "Search memory for relevant prior context",
	reflect: "Synthesize an answer from long-term memory",
	retain: "Store important facts in long-term memory",
	rewind: "Rewind to a previously created checkpoint",
	search_tool_bm25: "Search the descriptions of tools that have not been loaded yet",
	set_cwd: "Change the session's working directory for the rest of the session",
	ssh: "Execute a command on a remote host over SSH",
	task: "Spawn subagents to complete delegated tasks",
	todo: "Write a structured todo list to track progress within a session",
	web_search: "Search the web",
	write: "Write files (creates/overwrites)",
};

export function getExtraHelpText(): string {
	const lines: string[] = [chalk.bold("ENVIRONMENT VARIABLES")];

	lines.push(
		...envSection("Core Providers", [
			["ANTHROPIC_API_KEY", "Anthropic Claude models"],
			["ANTHROPIC_OAUTH_TOKEN", "Anthropic OAuth (takes precedence over API key)"],
			["CLAUDE_CODE_USE_FOUNDRY", "Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)"],
			["FOUNDRY_BASE_URL", "Anthropic Foundry base URL (e.g., https://<foundry-host>)"],
			["ANTHROPIC_FOUNDRY_API_KEY", "Anthropic token used as Authorization: Bearer <token> in Foundry mode"],
			[
				"ANTHROPIC_CUSTOM_HEADERS",
				'Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")',
			],
			["CLAUDE_CODE_CLIENT_CERT", "Client certificate (PEM path or inline PEM) for mTLS"],
			["CLAUDE_CODE_CLIENT_KEY", "Client private key (PEM path or inline PEM) for mTLS"],
			["NODE_EXTRA_CA_CERTS", "CA bundle path (or inline PEM) for server certificate validation"],
			["OPENAI_API_KEY", "OpenAI GPT models"],
			["GEMINI_API_KEY", "Google Gemini models"],
			["COPILOT_GITHUB_TOKEN", "GitHub Copilot"],
		]),
		...envSection("Additional LLM Providers", [
			["AZURE_OPENAI_API_KEY", "Azure OpenAI models"],
			["GROQ_API_KEY", "Groq models"],
			["CEREBRAS_API_KEY", "Cerebras models"],
			["XAI_API_KEY", "xAI Grok models"],
			["OPENROUTER_API_KEY", "OpenRouter aggregated models"],
			["KILO_API_KEY", "Kilo Gateway models"],
			["MISTRAL_API_KEY", "Mistral models"],
			["ZAI_API_KEY", "z.ai models (ZhipuAI/GLM)"],
			["UMANS_AI_CODING_PLAN_API_KEY", "Umans AI Coding Plan models"],
			["UMANS_WEBSEARCH_PROVIDER", "Umans gateway web search backend (native or exa)"],
			["MINIMAX_API_KEY", "MiniMax models"],
			["OPENCODE_API_KEY", "OpenCode Zen/OpenCode Go models"],
			["CURSOR_ACCESS_TOKEN", "Cursor AI models"],
			["AI_GATEWAY_API_KEY", "Vercel AI Gateway"],
			["WAFER_SERVERLESS_API_KEY", "Wafer Serverless (pay-as-you-go)"],
		]),
		...envSection("Cloud Providers", [
			["AWS_PROFILE", "AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)"],
			["GOOGLE_CLOUD_PROJECT", "Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)"],
			["GOOGLE_APPLICATION_CREDENTIALS", "Service account for Vertex AI"],
		]),
		...envSection("Search & Tools", [
			["EXA_API_KEY", "Exa web search"],
			["BRAVE_API_KEY", "Brave web search"],
			["PERPLEXITY_API_KEY", "Perplexity web search API key (optional; anonymous fallback)"],
			["PERPLEXITY_COOKIES", "Perplexity web search (session cookie)"],
			["TAVILY_API_KEY", "Tavily web search"],
			["TINYFISH_API_KEY", "TinyFish web search"],
			["FIRECRAWL_API_KEY", "Firecrawl web search"],
			["ANTHROPIC_SEARCH_API_KEY", "Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)"],
			["ANTHROPIC_SEARCH_BASE_URL", "Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)"],
		]),
	);

	lines.push(
		`  ${chalk.dim("# Configuration")}`,
		...renderHelpTable(
			[
				["VEYYON_PROFILE", "Named profile for isolated agent state (same as --profile)"],
				[
					"VEYYON_CODING_AGENT_DIR",
					`Agent directory, default profile only (default: ~/${CONFIG_DIR_NAME}/profiles/default/agent; a named profile derives ~/${CONFIG_DIR_NAME}/profiles/<name>/agent and ignores this)`,
				],
				["VEYYON_PACKAGE_DIR", "Override package directory (for Nix/Guix store paths)"],
				["VEYYON_SMOL_MODEL", "Override smol/fast model (see --smol)"],
				["VEYYON_SLOW_MODEL", "Override slow/reasoning model (see --slow)"],
				["VEYYON_PLAN_MODEL", "Override planning model (see --plan)"],
				["VEYYON_NO_PTY", "Disable PTY-based interactive bash execution"],
			],
			{ indent: "  " },
		),
		"",
		...renderHelpParagraph(
			`Without --profile or a profile env var, \`defaultProfile\` in the global ~/${CONFIG_DIR_NAME}/config.yml decides which profile launches (set it with \`veyyon profile default <name>\`); otherwise the default profile. Use \`veyyon --profile <name> --alias <command>\` to create a shell shortcut for a profile.`,
		),
		"",
		...renderHelpParagraph("For the complete environment variable reference, see:"),
		`  ${chalk.dim("https://veyyon.dev/docs/reference/environment.html")}`,
		"",
		chalk.bold("BUILT-IN TOOLS"),
		...renderHelpParagraph(
			"These are the names `--tools` and `--no-tools` accept. A tool that needs something this machine does not have (a language server, a GitHub token, a memory backend) is absent from the session rather than failing when called.",
			{ indent: "  " },
		),
		"",
		...renderHelpTable(
			BUILTIN_TOOL_NAMES.map(name => [name, BUILTIN_TOOL_HELP[name]] as const),
			{ indent: "  " },
		),
		"",
		chalk.bold("PLUGIN OPTIONS"),
		...renderHelpTable([["--plugin-dir <path>", "Load plugin from directory (repeatable)"]], { indent: "  " }),
		"",
		chalk.bold("USEFUL COMMANDS"),
		...renderHelpTable(
			[
				[
					"veyyon agents unpack",
					`Export bundled subagents to the active profile's agent dir, ~/${CONFIG_DIR_NAME}/profiles/<name>/agent/agents (default)`,
				],
				["veyyon agents unpack --project", "Export bundled subagents to ./.veyyon/agents"],
			],
			{ indent: "  " },
		),
	);

	return lines.join("\n");
}
