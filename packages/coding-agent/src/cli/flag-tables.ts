/** Single source of truth for argv flag classification, shared by: - `parseArgs` in `./args.ts` (the launch-time CLI parser) */

import type { ConfiguredThinkingLevel } from "../thinking";
// approval-modes.ts is intentionally free of runtime deps (no @veyyon/utils), so
// importing it here does not violate the bootstrap-race IMPORT RULE above.
import { APPROVAL_MODE_VALUES, isKnownApprovalMode } from "../tools/approval-modes";
import type { Args, Mode } from "./args";
import { CliUsageError } from "./usage-error";

/** Runtime dependencies injected into setters that need to validate input. `args.ts` constructs one object at module load and passes it to each */
export interface ParseDeps {
	parseThinking: (value: string | null | undefined) => ConfiguredThinkingLevel | undefined;
	builtinToolNames: readonly string[];
	normalizeToolNames: (values: Iterable<string>) => string[];
	thinkingEfforts: readonly string[];
}

export type StringSetter = (result: Args, value: string, deps: ParseDeps) => void;

/** Setter for a flag that may or may not consume the next argv token. Receives `undefined` for the bare form (`--resume` with no value, etc.). */
export type OptionalSetter = (result: Args, value: string | undefined) => void;

/** Per-flag optional-value consumption policy. Every optional flag always rejects tokens that start with `-` — that shared */
export interface OptionalFlagConfig {
	set: OptionalSetter;
	rejectEmpty?: boolean;
}

// Shared setters for flags that alias the same field.
const setExtension: StringSetter = (result, value) => {
	result.extensions = result.extensions ?? [];
	result.extensions.push(value);
};

const setResume: OptionalSetter = (result, value) => {
	result.resume = value !== undefined ? value : true;
};

const MAX_TIME_DURATION_RE = /^(\d+(?:\.\d+)?)([smh])$/;

function maxTimeMultiplier(unit: string | undefined): number {
	if (unit === "h") return 3600;
	if (unit === "m") return 60;
	return 1;
}

function parseMaxTimeSeconds(value: string): number {
	const trimmed = value.trim();
	const duration = MAX_TIME_DURATION_RE.exec(trimmed);
	const seconds = duration ? Number(duration[1]) * maxTimeMultiplier(duration[2]) : Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) return seconds;
	throw new CliUsageError(
		`Invalid --max-time value: ${JSON.stringify(value)}. Expected a positive number of seconds or duration like "5s", "10m", "1h".`,
	);
}

/** Accepted `--mode` values, with the guard that gates them. Mirrors the `isKnownApprovalMode` shape in `../tools/approval-modes` so both enum-valued */
const MODE_ACCEPTED: Record<Mode, true> = { text: true, json: true, rpc: true, acp: true, "rpc-ui": true };

export const MODE_VALUES: readonly Mode[] = Object.keys(MODE_ACCEPTED) as Mode[];

function isKnownMode(value: string): value is Mode {
	return Object.hasOwn(MODE_ACCEPTED, value);
}

/** A rejected flag value, phrased so the terminal output names the fix. Every enum-valued flag routes its failure through here for one reason: a */
function invalidFlagValue(flag: string, value: string, accepted: readonly string[]): CliUsageError {
	return new CliUsageError(
		`Invalid ${flag} value: ${JSON.stringify(value)}. Expected one of: ${accepted.join(", ")}.`,
	);
}

/** Setters for flags with string values. Most built-ins consume the next argv token even when it starts with `-`; flags listed in */
export const STRING_SETTERS: Record<string, StringSetter> = {
	"--cwd": (result, value) => {
		result.cwd = value;
	},
	"--config": (result, value) => {
		result.config = [...(result.config ?? []), value];
	},
	"--mode": (result, value) => {
		if (!isKnownMode(value)) throw invalidFlagValue("--mode", value, MODE_VALUES);
		result.mode = value;
	},
	"--fork": (result, value) => {
		result.fork = value;
	},
	"--provider": (result, value) => {
		result.provider = value;
	},
	"--model": (result, value) => {
		result.model = value;
	},
	"--smol": (result, value) => {
		result.smol = value;
	},
	"--slow": (result, value) => {
		result.slow = value;
	},
	"--plan": (result, value) => {
		result.plan = value;
	},
	"--subagent-model": (result, value) => {
		result.subagentModel = value;
	},
	"--compaction-model": (result, value) => {
		result.compactionModel = value;
	},
	"--prewalk-into": (result, value) => {
		result.prewalkInto = value;
	},
	"--plan-yolo-into": (result, value) => {
		result.planYoloInto = value;
	},
	"--max-time": (result, value) => {
		result.maxTime = parseMaxTimeSeconds(value);
	},
	"--api-key": (result, value) => {
		result.apiKey = value;
	},
	"--system-prompt": (result, value) => {
		result.systemPrompt = value;
	},
	"--append-system-prompt": (result, value) => {
		result.appendSystemPrompt = value;
	},
	"--provider-session-id": (result, value) => {
		result.providerSessionId = value;
	},
	"--prompt-cache-key": (result, value) => {
		result.providerPromptCacheKey = value;
	},
	"--session-dir": (result, value) => {
		result.sessionDir = value;
	},
	"--models": (result, value) => {
		result.models = value.split(",").map(s => s.trim());
	},
	"--tools": (result, value, deps) => {
		const names = deps.normalizeToolNames(
			value
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		const unknown = names.filter(name => !deps.builtinToolNames.includes(name));
		if (unknown.length > 0) {
			throw new CliUsageError(
				`Unknown ${unknown.length === 1 ? "tool" : "tools"} passed to --tools: ${unknown.map(name => JSON.stringify(name)).join(", ")}. Expected one of: ${deps.builtinToolNames.join(", ")}.`,
			);
		}
		result.tools = names;
	},
	"--thinking": (result, value, deps) => {
		const thinking = deps.parseThinking(value);
		if (thinking === undefined) throw invalidFlagValue("--thinking", value, deps.thinkingEfforts);
		result.thinking = thinking;
	},
	"--export": (result, value) => {
		result.export = value;
	},
	"--hook": (result, value) => {
		result.hooks = result.hooks ?? [];
		result.hooks.push(value);
	},
	"--extension": setExtension,
	"-e": setExtension,
	"--plugin-dir": (result, value) => {
		result.pluginDirs = result.pluginDirs ?? [];
		result.pluginDirs.push(value);
	},
	"--skills": (result, value) => {
		result.skills = value.split(",").map(s => s.trim());
	},
	"--approval-mode": (result, value) => {
		// Never fall back to the configured default: the whole point of writing
		// `--approval-mode=ask` is to constrain THIS run, so honouring a typo as
		// "whatever the config said" hands the user more autonomy than requested.
		if (!isKnownApprovalMode(value)) throw invalidFlagValue("--approval-mode", value, APPROVAL_MODE_VALUES);
		result.approvalMode = value;
	},
};

/** Optional-value flags. Setters receive `undefined` for the bare form. The dispatch in `args.ts` applies the shared "doesn't start with `-`" */
export const OPTIONAL_FLAGS: Record<string, OptionalFlagConfig> = {
	"--resume": { set: setResume, rejectEmpty: true },
	"-r": { set: setResume, rejectEmpty: true },
	"--session": { set: setResume, rejectEmpty: true },
};

/** Derived from {@link STRING_SETTERS}. A flag is in this set if and only if it has a setter — by construction, drift between "the bootstrap thinks */
export const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(STRING_SETTERS));

/** Built-in string flags known to be shadowed by bundled/common boolean extensions before extension metadata is available. They still accept a */
export const EXTENSION_SHADOWABLE_STRING_FLAGS: ReadonlySet<string> = new Set(["--plan"]);

/** Derived from {@link OPTIONAL_FLAGS}. Same single-source contract as {@link STRING_VALUE_FLAGS}. */
export const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(OPTIONAL_FLAGS));

/** Internal marker inserted by the profile bootstrap when removing `--profile` or `--alias` would otherwise make the following value-like token become the */
export const PROFILE_BOOTSTRAP_BOUNDARY_ARG = "--veyyon-profile-boundary";

/** Long-form launch flags that take NO value (booleans). The bootstrap pre-parser needs this to tell a known value-less flag (whose successor is a fresh */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
	"--help",
	"--version",
	"--allow-home",
	"--continue",
	"--no-session",
	// The short forms of `--continue` and `--print`. `parseArgs` accepted these from an inline `arg === "-c"` check while the table did not list them, so
	"-c",
	"-p",
	"--no-tools",
	"--no-lsp",
	"--no-pty",
	"--hide-thinking",
	"--advisor",
	"--prewalk",
	"--no-prewalk",
	"--plan-yolo",
	"--print",
	"--print-thoughts",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--auto-approve",
	"--yolo",
	"--dangerously-skip-permissions",
]);

/** Whether a bare long option (`--xxx`, no `=`) is unclassified — not a known string-, optional-, or value-less flag. The bootstrap and subcommand */
export function isUnknownLongValueCandidate(arg: string): boolean {
	return (
		arg.startsWith("--") &&
		!arg.includes("=") &&
		!STRING_VALUE_FLAGS.has(arg) &&
		!OPTIONAL_VALUE_FLAGS.has(arg) &&
		!VALUELESS_FLAGS.has(arg)
	);
}

/** Whether a leading option `flag` consumes the following argv token `next` as its value, applying the same contract as `extractProfileFlags` / `parseArgs`. */
export function flagConsumesValue(flag: string, next: string | undefined): boolean {
	// `--flag=value` carries its own value inline.
	if (flag.startsWith("--") && flag.includes("=")) return false;
	if (next === undefined) return false;
	const valueLike = !next.startsWith("-");
	// Extension-shadowable string flags (`--plan`) accept only a value-like successor: a flag-looking successor stays a fresh flag (`--plan --profile
	if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(flag)) return valueLike;
	// Other known string flags consume any successor, even a flag-looking one
	// (`--system-prompt --foo` ⇒ the system prompt is literally `--foo`).
	if (STRING_VALUE_FLAGS.has(flag)) return true;
	if (OPTIONAL_VALUE_FLAGS.has(flag)) {
		const config = OPTIONAL_FLAGS[flag];
		return valueLike && !(config.rejectEmpty === true && next.length === 0);
	}
	if (isUnknownLongValueCandidate(flag)) return valueLike;
	return false;
}
