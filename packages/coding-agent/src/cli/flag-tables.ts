import type { ConfiguredThinkingLevel } from "../thinking";
import { APPROVAL_MODE_VALUES, isKnownApprovalMode } from "../tools/approval-modes";
import type { Args, Mode } from "./args";
import { CliUsageError } from "./usage-error";

export interface ParseDeps {
	parseThinking: (value: string | null | undefined) => ConfiguredThinkingLevel | undefined;
	builtinToolNames: readonly string[];
	normalizeToolNames: (values: Iterable<string>) => string[];
	thinkingEfforts: readonly string[];
}

export type StringSetter = (result: Args, value: string, deps: ParseDeps) => void;

export type OptionalSetter = (result: Args, value: string | undefined) => void;

export interface OptionalFlagConfig {
	set: OptionalSetter;
	rejectEmpty?: boolean;
}

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

const MODE_ACCEPTED: Record<Mode, true> = { text: true, json: true, rpc: true, acp: true, "rpc-ui": true };

export const MODE_VALUES: readonly Mode[] = Object.keys(MODE_ACCEPTED) as Mode[];

function isKnownMode(value: string): value is Mode {
	return Object.hasOwn(MODE_ACCEPTED, value);
}

function invalidFlagValue(flag: string, value: string, accepted: readonly string[]): CliUsageError {
	return new CliUsageError(
		`Invalid ${flag} value: ${JSON.stringify(value)}. Expected one of: ${accepted.join(", ")}.`,
	);
}

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
		if (!isKnownApprovalMode(value)) throw invalidFlagValue("--approval-mode", value, APPROVAL_MODE_VALUES);
		result.approvalMode = value;
	},
};

export const OPTIONAL_FLAGS: Record<string, OptionalFlagConfig> = {
	"--resume": { set: setResume, rejectEmpty: true },
	"-r": { set: setResume, rejectEmpty: true },
	"--session": { set: setResume, rejectEmpty: true },
};

export const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(STRING_SETTERS));

export const EXTENSION_SHADOWABLE_STRING_FLAGS: ReadonlySet<string> = new Set(["--plan"]);

export const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(OPTIONAL_FLAGS));

export const PROFILE_BOOTSTRAP_BOUNDARY_ARG = "--veyyon-profile-boundary";

// Maps each valueless flag (and its short alias) to the field it sets on Args.
// Replaces ~20 else-if branches in the arg parser with one map lookup.
export const BOOLEAN_FLAGS: Record<string, keyof Args> = {
	"--help": "help",
	"-h": "help",
	"--version": "version",
	"-v": "version",
	"--allow-home": "allowHome",
	"--continue": "continue",
	"-c": "continue",
	"--no-session": "noSession",
	"--no-tools": "noTools",
	"--no-lsp": "noLsp",
	"--no-pty": "noPty",
	"--hide-thinking": "hideThinking",
	"--advisor": "advisor",
	"--prewalk": "prewalk",
	"--no-prewalk": "noPrewalk",
	"--plan-yolo": "planYolo",
	"--print": "print",
	"-p": "print",
	"--print-thoughts": "printThoughts",
	"--no-extensions": "noExtensions",
	"--no-skills": "noSkills",
	"--no-rules": "noRules",
	"--no-title": "noTitle",
	"--auto-approve": "autoApprove",
	"--yolo": "autoApprove",
	"--dangerously-skip-permissions": "dangerouslySkipPermissions",
};

export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
	"--help",
	"--version",
	"--allow-home",
	"--continue",
	"--no-session",
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

export function isUnknownLongValueCandidate(arg: string): boolean {
	return (
		arg.startsWith("--") &&
		!arg.includes("=") &&
		!STRING_VALUE_FLAGS.has(arg) &&
		!OPTIONAL_VALUE_FLAGS.has(arg) &&
		!VALUELESS_FLAGS.has(arg)
	);
}

export function flagConsumesValue(flag: string, next: string | undefined): boolean {
	if (flag.startsWith("--") && flag.includes("=")) return false;
	if (next === undefined) return false;
	const valueLike = !next.startsWith("-");
	if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(flag)) return valueLike;
	if (STRING_VALUE_FLAGS.has(flag)) return true;
	if (OPTIONAL_VALUE_FLAGS.has(flag)) {
		const config = OPTIONAL_FLAGS[flag];
		return valueLike && !(config.rejectEmpty === true && next.length === 0);
	}
	if (isUnknownLongValueCandidate(flag)) return valueLike;
	return false;
}
