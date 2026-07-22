/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * This is the ASYNCHRONOUS entry point, used on the API-key path where command
 * execution must not block the TUI. Its synchronous sibling lives in
 * `model-registry.ts`, which must resolve eagerly in a sync constructor. The two
 * differ ONLY in how they run the command: the grammar (`!command` / env /
 * literal), the reason vocabulary, and the caching/back-off/report-once policy
 * all come from `config-value-resolution.ts`, so a value resolves the same way
 * whichever path reaches it.
 */

import { executeShell } from "@veyyon/natives";
import { errorMessage } from "@veyyon/utils";
import {
	commandFailureReason,
	configCommandPolicy,
	parseConfigValueCommand,
	resolveEnvOrLiteral,
} from "./config-value-resolution";

/** De-duplicates concurrent executions for the same command within this async path. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If it starts with "!", the rest runs as a shell command and its stdout is used (cached).
 * - Otherwise the environment is checked first, then the value is treated as a literal.
 */
export async function resolveConfigValue(config: string, describedAs?: string): Promise<string | undefined> {
	const command = parseConfigValueCommand(config);
	if (command === null) return resolveEnvOrLiteral(config);
	return await executeCommand(command, describedAs);
}

async function executeCommand(command: string, describedAs?: string): Promise<string | undefined> {
	const cached = configCommandPolicy.getCached(command);
	if (cached !== undefined) return cached;

	// A command that failed recently is not re-run until its back-off elapses; the
	// failure was already reported once, so returning undefined here stays quiet.
	if (configCommandPolicy.isBackedOff(command)) return undefined;

	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const promise = runShellCommand(command, 10_000, describedAs)
		.then(result => {
			if (result !== undefined) configCommandPolicy.recordSuccess(command, result);
			return result;
		})
		.finally(() => {
			commandInFlight.delete(command);
		});

	commandInFlight.set(command, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number, describedAs?: string): Promise<string | undefined> {
	// `executeShell` merges the command's stdout and stderr into one stream and
	// gives no way to tell them apart, so the captured output CANNOT be reported:
	// on this path it may contain the secret the command exists to fetch, and a
	// credential must never reach a log file. `recordFailure` is therefore called
	// with no stderr, and the report sends the reader to run the command
	// themselves, where they see the real stderr. The sibling resolver in
	// `model-registry.ts` runs commands through `execSync` with separate pipes, so
	// it CAN report stderr, and does.
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

/** Clear the shared config-value command cache and this path's in-flight map. Exported for testing. */
export function clearConfigValueCache(): void {
	configCommandPolicy.clear();
	commandInFlight.clear();
}
