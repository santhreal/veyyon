import { logger, truncate } from "@veyyon/utils";

/** The `!command` / env-reference / literal grammar shared by both resolvers. A config value (an API key, a header) is one of four things: `!some command` */

/** True when a config value is a `!command`, narrowing it for the caller. */
export function isConfigValueCommand(config: string | undefined): config is string {
	return config?.startsWith("!") === true;
}

/** The command to run for a `!command` value, or `null` when the value is not a command. The leading `!` is removed and the remainder is trimmed, so */
export function parseConfigValueCommand(config: string): string | null {
	if (!config.startsWith("!")) return null;
	return config.slice(1).trim();
}

/** What a non-command config value names, before anything is looked up. `env` must be resolved from the environment and has no fallback: an unset or */
export type ConfigValueReference =
	| { kind: "literal"; value: string }
	| { kind: "env"; variable: string; explicit: boolean }
	| { kind: "env-or-literal"; value: string };

/** The escape prefix that makes the rest of a value verbatim text. */
export const CONFIG_VALUE_LITERAL_PREFIX = "literal:";

/** What `${...}` and `$...` accept as a variable name. */
const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The shape a bare value must have to be read as an environment reference. */
const ENV_NAME_CONVENTION = /^[A-Z][A-Z0-9_]*$/;

function parseExplicitEnvReference(config: string): string | null {
	if (!config.startsWith("$")) return null;
	const braced = config.startsWith("${") && config.endsWith("}");
	const name = braced ? config.slice(2, -1) : config.slice(1);
	return ENV_REFERENCE_NAME.test(name) ? name : null;
}

/** Parse a non-command value into what it names. Commands are the caller's job. */
export function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith(CONFIG_VALUE_LITERAL_PREFIX)) {
		return { kind: "literal", value: config.slice(CONFIG_VALUE_LITERAL_PREFIX.length) };
	}
	const explicit = parseExplicitEnvReference(config);
	if (explicit !== null) return { kind: "env", variable: explicit, explicit: true };
	if (ENV_NAME_CONVENTION.test(config)) return { kind: "env", variable: config, explicit: false };
	return { kind: "env-or-literal", value: config };
}

/** The variable a value refers to, or `null` when it refers to none. A caller that must not proceed without the value (an MCP connection, which */
export function describeConfigEnvReference(config: string): { variable: string; explicit: boolean } | null {
	const reference = parseConfigValueReference(config);
	return reference.kind === "env" ? { variable: reference.variable, explicit: reference.explicit } : null;
}

/** The result of resolving a non-command value: the value, or the variable that was missing. An empty variable counts as missing — an exported-but-empty */
export type ConfigValueOutcome =
	| { ok: true; value: string }
	| { ok: false; variable: string; explicit: boolean; empty: boolean };

/** Resolve a non-command value: an environment reference, the legacy bare form, or a literal. Never falls back to the variable's own name. */
export function resolveConfigEnvReference(config: string): ConfigValueOutcome {
	const reference = parseConfigValueReference(config);
	if (reference.kind === "literal") return { ok: true, value: reference.value };
	if (reference.kind === "env-or-literal") {
		const fromEnv = process.env[reference.value];
		return { ok: true, value: fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : reference.value };
	}
	const value = process.env[reference.variable];
	if (value !== undefined && value.length > 0) return { ok: true, value };
	return { ok: false, variable: reference.variable, explicit: reference.explicit, empty: value !== undefined };
}

/** The one vocabulary for why a `!command` produced no value. Both resolvers derive a reason from what happened (a timeout, a non-zero */
export const commandFailureReason = {
	timedOut: (timeoutMs: number): string => `it did not finish within ${timeoutMs}ms and was killed`,
	exited: (code: number | string): string => `it exited with code ${code}`,
	emptyOutput: "it succeeded but wrote nothing to stdout",
	spawnFailed: (message: string): string => `it could not be run: ${message}`,
} as const;

/** How long a failed `!command` is negative-cached before it is retried. A transient failure (a locked password manager, a network hiccup) must not */
const COMMAND_FAILURE_RETRY_MS = 30_000;

/** The caching, back-off and report-once policy for `!command` resolution, shared by the sync and async resolvers so both cache successes, back off */
export interface CommandResolutionPolicy {
	/** A previously cached successful result, or `undefined` if none. */
	getCached(command: string): string | undefined;
	/** True while the command is inside its failure back-off window. */
	isBackedOff(command: string): boolean;
	/** The command's current cache generation, which an asynchronous caller reads before it starts running and hands back to {@link recordSuccess}. An */
	generationOf(command: string): number;
	/** Record a success: cache it and clear any back-off. `atGeneration` is the value {@link generationOf} returned before the run started; a stale one is */
	recordSuccess(command: string, value: string, atGeneration?: number): void;
	/** Record a failure: start or extend the back-off, and report it once per streak (a later success resets the streak, so a fresh failure is reported */
	recordFailure(command: string, describedAs: string | undefined, reason: string, stderr?: string): void;
	/** Drop one command's cached value, so the next resolution runs it again. A password-manager read or a token-minting command returns a credential */
	invalidate(command: string): void;
	/** Drop all cached values and back-off timers. For process reuse in tests. */
	clear(): void;
}

export function createCommandResolutionPolicy(retryMs: number = COMMAND_FAILURE_RETRY_MS): CommandResolutionPolicy {
	const values = new Map<string, string>();
	const retryAt = new Map<string, number>();
	const generations = new Map<string, number>();
	return {
		getCached: command => values.get(command),
		isBackedOff: command => {
			const at = retryAt.get(command);
			return at !== undefined && Date.now() < at;
		},
		generationOf: command => generations.get(command) ?? 0,
		recordSuccess: (command, value, atGeneration) => {
			if (atGeneration !== undefined && atGeneration !== (generations.get(command) ?? 0)) return;
			retryAt.delete(command);
			values.set(command, value);
		},
		recordFailure: (command, describedAs, reason, stderr) => {
			// Report only when no back-off is currently active, which is once per
			// failing streak: a repeated failure updates the timer silently, and a
			// success clears it so the next failure counts as new.
			if (retryAt.get(command) === undefined) {
				reportUnresolvedConfigValue({ command, describedAs, reason, stderr });
			}
			retryAt.set(command, Date.now() + retryMs);
		},
		invalidate: command => {
			values.delete(command);
			generations.set(command, (generations.get(command) ?? 0) + 1);
		},
		clear: () => {
			values.clear();
			retryAt.clear();
			generations.clear();
		},
	};
}

/** The single policy instance both resolvers share, so a `!command` is executed at most once regardless of which path asks for it first, and a failure backs */
export const configCommandPolicy = createCommandResolutionPolicy();

/** Report a `!command` config value that resolved to nothing. A config value starting with `!` runs a shell command and uses its stdout, */
export function reportUnresolvedConfigValue(details: {
	/** The command as written, without the leading `!`. */
	command: string;
	/** What the value was for, when the caller knows, such as `header "X-Api-Key"`. */
	describedAs?: string;
	/** Why it produced no value, phrased to follow "the command ...". */
	reason: string;
	/** Whatever the command wrote to stderr. Never its stdout. */
	stderr?: string;
}): void {
	const stderr = details.stderr?.trim() ?? "";
	logger.warn("A configured command produced no value, so the setting it resolves is unset", {
		...(details.describedAs ? { setting: details.describedAs } : {}),
		command: details.command,
		reason: details.reason,
		...(stderr.length > 0 ? { stderr: truncate(stderr, 500) } : {}),
		fix: "Run the command yourself to see why it fails. Until it succeeds, anything using this value (an API key, an auth header) is missing, which usually shows up as an authentication error.",
	});
}

/** Every (variable, setting) pair already reported, so a value resolved on every request logs its missing variable once instead of once per request. */
const reportedEnvReferences = new Set<string>();

/** Report a config value whose environment variable is unset or empty. The value is not sent — that is the point of the report. The variable's NAME */
export function reportUnresolvedEnvReference(details: {
	/** The environment variable the config value named. */
	variable: string;
	/** True for `${NAME}` / `$NAME`, false for the bare environment-name form. */
	explicit: boolean;
	/** True when the variable exists and holds an empty string. */
	empty: boolean;
	/** What the value was for, when the caller knows, such as `header "X-Api-Key"`. */
	describedAs?: string;
}): void {
	const key = `${details.variable}\u0000${details.describedAs ?? ""}`;
	if (reportedEnvReferences.has(key)) return;
	reportedEnvReferences.add(key);
	logger.warn("A configured environment variable is unset, so the setting it resolves is unset", {
		...(details.describedAs ? { setting: details.describedAs } : {}),
		variable: details.variable,
		state: details.empty ? "set but empty" : "not set",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the config grammar's own spelling, not an interpolation
		form: details.explicit ? "${NAME} reference" : "bare environment name",
		fix: `Export ${details.variable} with the value, or write the value in the config as literal:<value>. Nothing was sent: the variable's own name is never used as the credential.`,
	});
}

/** Forget which unresolved variables were reported. For process reuse in tests. */
export function clearUnresolvedEnvReports(): void {
	reportedEnvReferences.clear();
}
