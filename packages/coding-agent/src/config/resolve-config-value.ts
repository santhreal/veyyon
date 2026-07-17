/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI.
 */

import { executeShell } from "@veyyon/pi-natives";

/** Cache for successful shell command results (persists for process lifetime). */
const commandResultCache = new Map<string, string>();

/** De-duplicates concurrent executions for the same command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export async function resolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return await executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

async function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(commandConfig);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runCommandCaptureStdout(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(commandConfig, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(commandConfig);
		});

	commandInFlight.set(commandConfig, promise);
	return await promise;
}

async function runCommandCaptureStdout(command: string, timeoutMs: number): Promise<string | undefined> {
	try {
		let output = "";
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut || result.exitCode !== 0) {
			return undefined;
		}
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}
