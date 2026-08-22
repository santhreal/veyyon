import { logger, truncate } from "@veyyon/utils";

/**
 * The `!command` / env-reference / literal grammar shared by both resolvers.
 *
 * A config value (an API key, a header) is one of four things: `!some command`
 * runs a shell command and uses its stdout, `${NAME}` or `$NAME` is an explicit
 * environment reference, `literal:<text>` is verbatim text, and a bare value is
 * the legacy spelling both of the other two once shared. Two resolvers exist
 * because one path must be synchronous (the model registry populates eagerly in
 * a sync constructor) and the other asynchronous (the API-key path must not
 * block the TUI). They used to disagree on the edges of this grammar: one
 * trimmed the command after the `!` and the other did not, so `!  op read x`
 * resolved differently depending on which path a value happened to reach. The
 * grammar now lives here, once, so the two resolvers differ ONLY in how they run
 * the command, never in what they consider a command, an env lookup, or a
 * literal.
 *
 * The bare form used to be `process.env[config] || config`, which fails OPEN: a
 * typo (`GITHUB_TOKN`) or an unset CI secret resolved to the NAME of the
 * variable, veyyon sent that identifier as the credential, and what came back
 * was a 401 from the provider with nothing connecting it to the missing
 * variable. Worse, the identifier itself travelled the wire. A value that names
 * a variable now fails closed: nothing is sent, and the diagnostic names the
 * variable and the setting it was for.
 *
 * Only the environment-name spelling (`^[A-Z][A-Z0-9_]*$`) is read as a bare
 * reference. Bare values outside it keep the legacy env-then-literal fallback,
 * because that is the shape a real key has (`sk_live_...`, `ghp_...`) and
 * failing those closed would break working configs to fix a typo they cannot
 * make. `${NAME}` says reference and `literal:` says verbatim, so anything
 * ambiguous has an unambiguous spelling available.
 */

/** True when a config value is a `!command`, narrowing it for the caller. */
export function isConfigValueCommand(config: string | undefined): config is string {
	return config?.startsWith("!") === true;
}

/**
 * The command to run for a `!command` value, or `null` when the value is not a
 * command. The leading `!` is removed and the remainder is trimmed, so
 * `!  op read x` and `!op read x` run the identical command.
 */
export function parseConfigValueCommand(config: string): string | null {
	if (!config.startsWith("!")) return null;
	return config.slice(1).trim();
}

/**
 * What a non-command config value names, before anything is looked up.
 *
 * `env` must be resolved from the environment and has no fallback: an unset or
 * empty variable is a failure, not a literal. `env-or-literal` is the legacy
 * bare form, which reads the environment when it holds a non-empty value and
 * otherwise IS the value. `literal` is verbatim text.
 */
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

/**
 * The variable a value refers to, or `null` when it refers to none.
 *
 * A caller that must not proceed without the value (an MCP connection, which
 * would otherwise dial the server with the variable's name as its credential)
 * uses this to tell an unresolved REFERENCE from a failed `!command`, which has
 * its own back-off and its own report. A command needs no test of its own here:
 * `!` is not part of any reference spelling, so a command text never parses as
 * one.
 */
export function describeConfigEnvReference(config: string): { variable: string; explicit: boolean } | null {
	const reference = parseConfigValueReference(config);
	return reference.kind === "env" ? { variable: reference.variable, explicit: reference.explicit } : null;
}

/**
 * The result of resolving a non-command value: the value, or the variable that
 * was missing. An empty variable counts as missing — an exported-but-empty
 * secret is the CI failure this exists to catch — and `empty` records which of
 * the two it was so the diagnostic can say so.
 */
export type ConfigValueOutcome =
	| { ok: true; value: string }
	| { ok: false; variable: string; explicit: boolean; empty: boolean };

/**
 * Resolve a non-command value: an environment reference, the legacy bare form,
 * or a literal. Never falls back to the variable's own name.
 */
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

/**
 * The one vocabulary for why a `!command` produced no value.
 *
 * Both resolvers derive a reason from what happened (a timeout, a non-zero
 * exit, empty output, a spawn error), and they used to phrase the same failure
 * in prose written twice. Wording them here once keeps the two paths from
 * describing an identical failure two different ways.
 */
export const commandFailureReason = {
	timedOut: (timeoutMs: number): string => `it did not finish within ${timeoutMs}ms and was killed`,
	exited: (code: number | string): string => `it exited with code ${code}`,
	emptyOutput: "it succeeded but wrote nothing to stdout",
	spawnFailed: (message: string): string => `it could not be run: ${message}`,
} as const;

/**
 * How long a failed `!command` is negative-cached before it is retried.
 *
 * A transient failure (a locked password manager, a network hiccup) must not
 * disable the value until the process restarts, but re-running the command on
 * every resolution would restore the execution storm the success cache exists
 * to prevent. One probe per window bounds both.
 */
const COMMAND_FAILURE_RETRY_MS = 30_000;

/**
 * The caching, back-off and report-once policy for `!command` resolution,
 * shared by the sync and async resolvers so both cache successes, back off
 * failures, and report each failing streak exactly once with identical timing.
 *
 * It holds state but does not run anything: the sync resolver drives it around
 * `execSync` and the async one around `executeShell`, which is the single
 * difference that cannot be shared.
 */
export interface CommandResolutionPolicy {
	/** A previously cached successful result, or `undefined` if none. */
	getCached(command: string): string | undefined;
	/** True while the command is inside its failure back-off window. */
	isBackedOff(command: string): boolean;
	/**
	 * The command's current cache generation, which an asynchronous caller reads
	 * before it starts running and hands back to {@link recordSuccess}. An
	 * {@link invalidate} that lands while the command is in flight bumps it, so
	 * the run already under way cannot re-cache the value that was just rejected.
	 */
	generationOf(command: string): number;
	/**
	 * Record a success: cache it and clear any back-off. `atGeneration` is the
	 * value {@link generationOf} returned before the run started; a stale one is
	 * returned to its own caller but not cached.
	 */
	recordSuccess(command: string, value: string, atGeneration?: number): void;
	/**
	 * Record a failure: start or extend the back-off, and report it once per
	 * streak (a later success resets the streak, so a fresh failure is reported
	 * again). `stderr` is included only when the caller could capture it apart
	 * from stdout; the async path cannot and passes nothing.
	 */
	recordFailure(command: string, describedAs: string | undefined, reason: string, stderr?: string): void;
	/**
	 * Drop one command's cached value, so the next resolution runs it again.
	 *
	 * A password-manager read or a token-minting command returns a credential
	 * that rotates, and the cache key is the command text, which does not change
	 * when the secret behind it does. Without this, a value rejected with a 401
	 * was re-sent from cache until the process restarted. The failure back-off is
	 * deliberately left alone: a cached value and an active back-off never
	 * coexist, so touching it here could only erase a back-off that is
	 * protecting a command which is genuinely failing.
	 */
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

/**
 * The single policy instance both resolvers share, so a `!command` is executed
 * at most once regardless of which path asks for it first, and a failure backs
 * off both paths together.
 */
export const configCommandPolicy = createCommandResolutionPolicy();

/**
 * Report a `!command` config value that resolved to nothing.
 *
 * A config value starting with `!` runs a shell command and uses its stdout,
 * which is how an API key or an auth header is fetched from a password manager
 * or a keychain (`!op read op://vault/key`). Two separate resolvers existed and
 * both discarded every failure: a non-zero exit, a timeout, a spawn error and
 * empty output all became a bare `undefined`.
 *
 * That silence is expensive. The value is missing, so the request goes out
 * unauthenticated and the operator sees an authentication error from the
 * provider, with nothing anywhere connecting it to the command that failed. The
 * command's stderr, which says `op: not signed in` or `command not found`, was
 * being discarded too, so the one thing that explains the failure never reached
 * anyone (Law 10).
 *
 * This is the single place that report is written, so the two resolvers cannot
 * describe the same failure differently or drift back into silence.
 *
 * The command's STDOUT is never reported. Stdout carries the secret, so it is
 * the one channel that must not reach a log file. Stderr is the diagnostic
 * channel, so that is what is reported, truncated because a failing command can
 * produce an unbounded amount of it.
 */
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

/**
 * Every (variable, setting) pair already reported, so a value resolved on every
 * request logs its missing variable once instead of once per request.
 */
const reportedEnvReferences = new Set<string>();

/**
 * Report a config value whose environment variable is unset or empty.
 *
 * The value is not sent — that is the point of the report. The variable's NAME
 * and the setting it belongs to are the whole diagnostic; no value is quoted,
 * because the only value in reach here is a credential from a neighbouring
 * variable and a report that prints what it protected is the leak it was
 * reporting.
 */
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
