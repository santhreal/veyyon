import { logger, truncate } from "@veyyon/utils";

/**
 * The `!command` / env-var / literal grammar shared by both resolvers.
 *
 * A config value (an API key, a header) is one of three things: `!some command`
 * runs a shell command and uses its stdout, a bare name is looked up in the
 * environment, and anything else is the literal value. Two resolvers exist
 * because one path must be synchronous (the model registry populates eagerly in
 * a sync constructor) and the other asynchronous (the API-key path must not
 * block the TUI). They used to disagree on the edges of this grammar: one
 * trimmed the command after the `!` and the other did not, so `!  op read x`
 * resolved differently depending on which path a value happened to reach. The
 * grammar now lives here, once, so the two resolvers differ ONLY in how they run
 * the command, never in what they consider a command, an env lookup, or a
 * literal.
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
 * Resolve a non-command value: the environment variable of that name, or the
 * value itself when there is no such variable. An empty environment variable is
 * treated as absent, so it falls through to the literal.
 */
export function resolveEnvOrLiteral(config: string): string {
	return process.env[config] || config;
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
	/** Record a success: cache it and clear any back-off. */
	recordSuccess(command: string, value: string): void;
	/**
	 * Record a failure: start or extend the back-off, and report it once per
	 * streak (a later success resets the streak, so a fresh failure is reported
	 * again). `stderr` is included only when the caller could capture it apart
	 * from stdout; the async path cannot and passes nothing.
	 */
	recordFailure(command: string, describedAs: string | undefined, reason: string, stderr?: string): void;
	/** Drop all cached values and back-off timers. For process reuse in tests. */
	clear(): void;
}

export function createCommandResolutionPolicy(retryMs: number = COMMAND_FAILURE_RETRY_MS): CommandResolutionPolicy {
	const values = new Map<string, string>();
	const retryAt = new Map<string, number>();
	return {
		getCached: command => values.get(command),
		isBackedOff: command => {
			const at = retryAt.get(command);
			return at !== undefined && Date.now() < at;
		},
		recordSuccess: (command, value) => {
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
		clear: () => {
			values.clear();
			retryAt.clear();
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
