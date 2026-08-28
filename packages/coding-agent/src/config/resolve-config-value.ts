/** Resolve configuration values that may be shell commands, environment variables, or literals. This is the ASYNCHRONOUS entry point, used on the API-key path where command */

import { executeShell } from "@veyyon/natives";
import { errorMessage } from "@veyyon/utils";
import {
	clearUnresolvedEnvReports,
	commandFailureReason,
	configCommandPolicy,
	parseConfigValueCommand,
	reportUnresolvedEnvReference,
	resolveConfigEnvReference,
} from "./config-value-resolution";

/** The run currently executing a command, with the cache generation it started at. The generation is what lets an invalidation tell a run that predates it from one that is */
interface InFlightCommand {
	promise: Promise<string | undefined>;
	generation: number;
}

/** De-duplicates concurrent executions for the same command within this async path. */
const commandInFlight = new Map<string, InFlightCommand>();

/** Resolve a config value (API key, header value, etc.) to an actual value. - If it starts with "!", the rest runs as a shell command and its stdout is used (cached). */
export async function resolveConfigValue(config: string, describedAs?: string): Promise<string | undefined> {
	const command = parseConfigValueCommand(config);
	if (command !== null) return await executeCommand(command, describedAs);
	const outcome = resolveConfigEnvReference(config);
	if (outcome.ok) return outcome.value;
	reportUnresolvedEnvReference({
		variable: outcome.variable,
		explicit: outcome.explicit,
		empty: outcome.empty,
		describedAs,
	});
	return undefined;
}

async function executeCommand(command: string, describedAs?: string): Promise<string | undefined> {
	const cached = configCommandPolicy.getCached(command);
	if (cached !== undefined) return cached;

	// A command that failed recently is not re-run until its back-off elapses; the
	// failure was already reported once, so returning undefined here stays quiet.
	if (configCommandPolicy.isBackedOff(command)) return undefined;

	const existing = commandInFlight.get(command);
	if (existing) return await existing.promise;

	// Read before the run, handed back after it: an invalidation that lands while
	// the command is running must not be undone by the run it interrupted.
	const generation = configCommandPolicy.generationOf(command);
	const promise: Promise<string | undefined> = runShellCommand(command, 10_000, describedAs)
		.then(result => {
			if (result !== undefined) configCommandPolicy.recordSuccess(command, result, generation);
			return result;
		})
		.finally(() => {
			// Only if it is still ours. An invalidation drops the entry so the next
			// caller starts a fresh run, and this one must not delete that run.
			if (commandInFlight.get(command)?.promise === promise) commandInFlight.delete(command);
		});

	commandInFlight.set(command, { promise, generation });
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number, describedAs?: string): Promise<string | undefined> {
	// `executeShell` merges the command's stdout and stderr into one stream and gives no way to tell them apart, so the captured output CANNOT be reported:
	let output = "";
	try {
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut) {
			configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.timedOut(timeoutMs));
			return undefined;
		}
		if (result.exitCode !== 0) {
			configCommandPolicy.recordFailure(
				command,
				describedAs,
				commandFailureReason.exited(result.exitCode ?? "unknown"),
			);
			return undefined;
		}
		const trimmed = output.trim();
		if (trimmed.length === 0) {
			// Succeeded and printed nothing. Distinct from failing, and the more
			// confusing of the two, because the command looks fine when run by hand
			// if it writes its value somewhere other than stdout.
			configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.emptyOutput);
			return undefined;
		}
		return trimmed;
	} catch (error) {
		configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.spawnFailed(errorMessage(error)));
		return undefined;
	}
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value, `header "${key}"`);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Drop the cached result of one config value, so the next resolution runs it again. Returns whether the value was a `!command` at all: an environment reference or a */
export function invalidateConfigValue(config: string): boolean {
	const command = parseConfigValueCommand(config);
	if (command === null) return false;
	// A run may be joined instead of restarted only when it was itself started BY an invalidation, which is what tells "already reading the rotated secret" apart from "reading
	const generation = configCommandPolicy.generationOf(command);
	const inFlight = commandInFlight.get(command);
	if (generation > 0 && inFlight?.generation === generation) return true;
	configCommandPolicy.invalidate(command);
	commandInFlight.delete(command);
	return true;
}

/** Clear the shared config-value command cache, this path's in-flight map, and which unresolved variables have been reported. Exported for testing. */
export function clearConfigValueCache(): void {
	configCommandPolicy.clear();
	commandInFlight.clear();
	clearUnresolvedEnvReports();
}
