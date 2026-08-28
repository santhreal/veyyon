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

interface InFlightCommand {
	promise: Promise<string | undefined>;
	generation: number;
}

const commandInFlight = new Map<string, InFlightCommand>();

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

	if (configCommandPolicy.isBackedOff(command)) return undefined;

	const existing = commandInFlight.get(command);
	if (existing) return await existing.promise;

	const generation = configCommandPolicy.generationOf(command);
	const promise: Promise<string | undefined> = runShellCommand(command, 10_000, describedAs)
		.then(result => {
			if (result !== undefined) configCommandPolicy.recordSuccess(command, result, generation);
			return result;
		})
		.finally(() => {
			if (commandInFlight.get(command)?.promise === promise) commandInFlight.delete(command);
		});

	commandInFlight.set(command, { promise, generation });
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number, describedAs?: string): Promise<string | undefined> {
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
			configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.emptyOutput);
			return undefined;
		}
		return trimmed;
	} catch (error) {
		configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.spawnFailed(errorMessage(error)));
		return undefined;
	}
}

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

export function invalidateConfigValue(config: string): boolean {
	const command = parseConfigValueCommand(config);
	if (command === null) return false;
	const generation = configCommandPolicy.generationOf(command);
	const inFlight = commandInFlight.get(command);
	if (generation > 0 && inFlight?.generation === generation) return true;
	configCommandPolicy.invalidate(command);
	commandInFlight.delete(command);
	return true;
}

export function clearConfigValueCache(): void {
	configCommandPolicy.clear();
	commandInFlight.clear();
	clearUnresolvedEnvReports();
}
