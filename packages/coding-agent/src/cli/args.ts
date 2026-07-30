/**
 * CLI argument parsing and help display
 */
// Subpath imports, never the `@veyyon/utils` barrel: the barrel re-exports `env.ts`, which parses the agent
// `.env` AT IMPORT TIME. This module is in `cli.ts`'s static graph, so pulling the barrel here would load the
// DEFAULT profile's `.env` before `--profile` has even been parsed (pinned by profile-cli.test.ts).
import { renderHelpParagraph, renderHelpTable } from "@veyyon/utils/cli";
import { APP_NAME, CONFIG_DIR_NAME } from "@veyyon/utils/dirs";
import { pluralize } from "@veyyon/utils/format";
import { nearestNames } from "@veyyon/utils/levenshtein";
import chalk from "chalk";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel, parseCliThinkingLevel } from "../thinking";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import {
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
	/** Collab link to join at startup (set by the `join` subcommand; no CLI flag). */
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
	/** `--dangerously-skip-permissions`: start with the full `/yolo` bypass on. */
	dangerouslySkipPermissions?: boolean;
	approvalMode?: "plan" | "ask" | "auto-edit" | "yolo" | "always-ask" | "write";
	messages: string[];
	fileArgs: string[];
	/** Extension-registered flags this parse recognized — name to value. */
	unknownFlags: Map<string, boolean | string>;
	/**
	 * `--`/`-` prefixed tokens this parse could not match against any built-in
	 * or {@link extensionFlags} entry. The startup parse runs *before*
	 * extensions load, so it always lists every extension-registered flag here;
	 * the post-extension reparse in {@link applyExtensionFlags} clears those
	 * once the real flag set is known. Anything still present after that
	 * reparse is a genuine typo or stale flag and {@link reportUnrecognizedFlags}
	 * surfaces it as a hard error so the agent does not silently start a
	 * session with the misparsed positionals as a prompt (issue #2459).
	 */
	unrecognizedFlags: string[];
}

/**
 * Runtime dependencies the data-driven setters need. Constructed once at
 * module load and passed to every {@link STRING_SETTERS} call so the
 * setter table itself can stay free of `@veyyon/utils` runtime imports
 * (which would otherwise trip the profile bootstrap's env-init ordering).
 */
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
	// Work on a copy: the `--option=value` handling below splices the value
	// into the array, and callers reuse the same argv (the post-extension
	// reparse in `runRootCommand` parses it a second time). Mutating the input
	// would corrupt that later parse, so never touch the caller's array.
	const args = [...inputArgs];
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};

	// `--` ends option parsing (POSIX end-of-options). Everything after it is
	// literal positional text, so flag-shaped messages are not parsed or rejected.
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

		// Support --flag=value syntax (e.g. --tools=ask,read). The value is
		// spliced in as the next token so value-consuming flags pick it up via
		// `args[++i]`; a non-consuming flag (e.g. a boolean) leaves it behind and
		// the post-loop guard drops it so it is not mistaken for a message.
		let equalsValueIndex = -1;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			args.splice(i + 1, 0, value);
			equalsValueIndex = i + 1;
		}

		// Extension-registered flags take precedence over built-ins: a flag an
		// extension owns (e.g. plan-mode's boolean `--plan`) is parsed with the
		// extension's semantics rather than falling into a built-in branch. For a
		// value-taking built-in (`--plan`, `--model`, …) that branch would consume
		// the following token — eating the user's message and setting the wrong
		// built-in field — so registered flags shadow same-named built-ins here.
		const extFlag = arg.startsWith("--") ? extensionFlags?.get(arg.slice(2)) : undefined;
		if (extFlag) {
			const flagName = arg.slice(2);
			if (extFlag.type === "boolean") {
				result.unknownFlags.set(flagName, true);
			} else if (extFlag.type === "string" && i + 1 < args.length) {
				// Consume the value in `--flag=value` form or when the next token is not
				// flag-looking. A standalone `--` remains the end-of-options marker; use
				// `--flag=--` when an extension needs a literal "--" string value.
				if (equalsValueIndex !== -1 || !args[i + 1].startsWith("-")) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
		} else if (STRING_VALUE_FLAGS.has(arg)) {
			// A VALUE-TAKING FLAG WITH NO VALUE IS REFUSED, never dropped. This branch used to be
			// guarded by `i + 1 < args.length`, so a flag in the last position fell through every
			// branch and vanished: `veyyon -p "..." --approval-mode` exited 0, answered normally, and
			// ran on the DEFAULT approval mode. Nothing was printed, and there is no typo to notice,
			// so the operator's evidence that a safety-relevant flag took effect was that they typed
			// it. The `=` form splices its value in above, so an empty `--model=` still arrives with a
			// value here and is a different question; this is only the case where none was given.
			const next = args[i + 1];
			if (next === undefined) {
				throw new CliUsageError(`${arg} needs a value. Write \`${arg} <value>\` or \`${arg}=<value>\`.`);
			}
			// The boundary sentinel is NOT folded into that refusal, deliberately. It means the user
			// wrote `--plan --profile work "message"` without the plan-mode extension loaded, where
			// `--plan` is the built-in string flag; the bootstrap stripped `--profile work` and left
			// the marker. Skipping the flag there is pinned behaviour whose whole point is that the
			// trailing message survives, so refusing would drop the message to report the flag.
			if (next === PROFILE_BOOTSTRAP_BOUNDARY_ARG) continue;
			// Built-in string flags consume the next token even when it is flag-looking
			// (`--system-prompt --profile foo` ⇒ the prompt is the literal "--profile").
			// The one token they must never absorb is the profile bootstrap's internal
			// boundary sentinel: an extension-shadowable built-in like `--plan` (parsed
			// here only when its boolean extension is NOT loaded) would otherwise swallow
			// the marker as its value and drop the user's trailing message.
			const consumed = consumeBuiltInStringValue(arg, args, i + 1);
			i = consumed.index;
			STRING_SETTERS[arg](result, consumed.value, PARSE_DEPS);
		} else if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			const next = args[i + 1];
			const consume =
				next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0);
			config.set(result, consume ? args[++i] : undefined);
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--profile") {
			// Normally stripped by `extractProfileFlags` before parseArgs sees it;
			// kept here as a fallback for direct parseArgs callers.
			// The `--profile=work` spelling never reaches here as one token: the `=` splice above
			// rewrites it to `--profile` plus a spliced value, which is why there is no second
			// `startsWith("--profile=")` branch. There used to be one, and it was unreachable.
			if (i + 1 >= args.length) throw new CliUsageError("--profile needs a value. Write `--profile <name>`.");
			result.profile = args[++i];
		} else if (arg === "--alias") {
			if (i + 1 >= args.length) throw new CliUsageError("--alias needs a value. Write `--alias <command>`.");
			result.alias = args[++i];
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--hide-thinking") {
			result.hideThinking = true;
		} else if (arg === "--advisor") {
			result.advisor = true;
		} else if (arg === "--prewalk") {
			result.prewalk = true;
		} else if (arg === "--no-prewalk") {
			result.noPrewalk = true;
		} else if (arg === "--plan-yolo") {
			result.planYolo = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--print-thoughts") {
			result.printThoughts = true;
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
		} else if (arg === "--no-skills") {
			result.noSkills = true;
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg === "--auto-approve" || arg === "--yolo") {
			result.autoApprove = true;
		} else if (arg === "--dangerously-skip-permissions") {
			// Stronger than --yolo: start with the full permission bypass on
			// (removes per-tool prompt overrides too). Explicit deny and plan mode
			// still block. Runtime-toggleable with /yolo.
			result.dangerouslySkipPermissions = true;
		} else if (arg.startsWith("@")) {
			let filePath = arg.slice(1);
			if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			} else if (filePath.startsWith("'") && filePath.endsWith("'") && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			}
			result.fileArgs.push(filePath);
		} else if (!arg.startsWith("-") || arg === "-") {
			// Plain positional or lone `-` (stdin marker) — pass through as a
			// message rather than flagging it.
			result.messages.push(arg);
		} else if (arg === "--") {
			// POSIX positional separator: drop the token and switch the loop
			// into "everything from here is a positional" mode. The guard at
			// the top of the loop body handles the remaining tokens.
			sawSeparator = true;
		} else {
			// Flag-shaped (`-x`, `--name`) but unrecognized at this parse. Record
			// it so the post-extension reparse can decide whether to surface it
			// as a hard error. `--flag=value` already split `value` into the next
			// slot; the standard "drop unconsumed equals value" guard below
			// removes it so it does not leak into messages (issue #2459).
			result.unrecognizedFlags.push(arg);
		}
		// Drop an unconsumed `--flag=value` value (e.g. a boolean flag): when no
		// branch advanced past the spliced token, remove it so it does not fall
		// through to a later iteration and become a positional message.
		if (equalsValueIndex !== -1 && i === flagIndex) {
			args.splice(equalsValueIndex, 1);
		}
	}

	return result;
}

/**
 * Every flag name the launch parser knows, for typo suggestion.
 *
 * The three tables are the parser's own source of truth, so a suggestion can never name a flag that
 * does not exist. A flag handled inline in the parse loop and absent from all three simply is not
 * offered, which degrades to the previous behaviour rather than to a confident wrong answer.
 */
function knownFlagNames(): string[] {
	return [...new Set([...STRING_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...VALUELESS_FLAGS])];
}

/**
 * Emit a stderr error listing the unrecognized flags and return `true` when
 * there were any. Caller is expected to exit with a non-zero status. Splitting
 * the print from the exit keeps the helper unit-testable without forking a
 * process (issue #2459).
 *
 * A MISTYPED FLAG GETS THE SAME HELP A MISTYPED SUBCOMMAND ALREADY GOT. `veyyon confg` answered
 * "Did you mean `veyyon config`?" while `veyyon --modle=x` answered "unknown flag: --modle" and left
 * the reader to find the difference between what they typed and what exists, in a list of 57. The
 * two surfaces reject the same kind of mistake one keystroke apart, so they should answer alike.
 * `nearestNames` is the repo's one owner of "what did they probably mean", which is what keeps the
 * threshold here from disagreeing with the subcommand one for no reason anybody chose.
 */
export function reportUnrecognizedFlags(
	args: Pick<Args, "unrecognizedFlags">,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (args.unrecognizedFlags.length === 0) return false;
	const flags = args.unrecognizedFlags;
	write(`${chalk.red(`Error: unknown ${pluralize("flag", flags.length)}: ${flags.join(", ")}`)}\n`);
	const known = knownFlagNames();
	for (const flag of flags) {
		// Compared without the dashes: every candidate starts with them, so leaving them on adds a
		// constant two characters to every distance and pushes a real typo outside the budget.
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

/** Emit a clean CLI usage error without an internal stack trace. */
export function reportCliUsageError(
	error: unknown,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (!(error instanceof CliUsageError)) return false;
	write(`${chalk.red(`Error: ${error.message}`)}\n`);
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

/**
 * The extra help block: environment variables, tools, and a few commands.
 *
 * ROWS, NOT A PADDED STRING. This was eighty-five lines of literal text whose gutter was typed into
 * every row as spaces, with three different gutters across its sections and no wrapping, so its
 * widest row ran to 129 columns and any terminal narrower than that re-broke it at an arbitrary
 * point with no indent. Rows can be laid out for the terminal in front of the user; a padded string
 * can only be laid out for the terminal the author happened to have.
 *
 * Prose is a paragraph rather than a row, which is the other half of the same defect: three
 * sentences about profile resolution were sitting between two variable rows, indented like rows, so
 * they read as a variable with an absurdly long name.
 */
function envSection(title: string, rows: ReadonlyArray<readonly [string, string]>): string[] {
	return [`  ${chalk.dim(`# ${title}`)}`, ...renderHelpTable(rows, { indent: "  " }), ""];
}

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
					`Session storage directory (default: ~/${CONFIG_DIR_NAME}/profiles/default/agent)`,
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
		chalk.bold("AVAILABLE TOOLS (default-enabled unless noted)"),
		...renderHelpTable(
			[
				["read", "Read file contents"],
				["bash", "Execute bash commands"],
				["edit", "Edit files with find/replace"],
				["write", "Write files (creates/overwrites)"],
				["grep", "Search file contents"],
				["glob", "Find files by glob pattern"],
				["lsp", "Language server protocol (code intelligence)"],
				["python", `Execute Python code (requires: ${APP_NAME} setup python)`],
				["notebook", "Edit Jupyter notebooks"],
				["inspect_image", "Analyze images with a vision model"],
				["browser", "Browser automation (Puppeteer)"],
				["task", "Launch sub-agents for parallel tasks"],
				["todo", "Manage todo/task lists"],
				["web_search", "Search the web"],
				["ask", "Ask user questions (interactive mode only)"],
			],
			{ indent: "  " },
		),
		"",
		chalk.bold("PLUGIN OPTIONS"),
		...renderHelpTable([["--plugin-dir <path>", "Load plugin from directory (repeatable)"]], { indent: "  " }),
		"",
		chalk.bold("USEFUL COMMANDS"),
		...renderHelpTable(
			[
				["veyyon agents unpack", "Export bundled subagents to ~/.veyyon/agent/agents (default)"],
				["veyyon agents unpack --project", "Export bundled subagents to ./.veyyon/agents"],
			],
			{ indent: "  " },
		),
	);

	return lines.join("\n");
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(APP_NAME)} - AI coding assistant\n\n` +
			`Run ${APP_NAME} --help for full command and option details.\n` +
			`Run ${APP_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
