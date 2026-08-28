import { logger, truncate } from "@veyyon/utils";

export function isConfigValueCommand(config: string | undefined): config is string {
	return config?.startsWith("!") === true;
}

export function parseConfigValueCommand(config: string): string | null {
	if (!config.startsWith("!")) return null;
	return config.slice(1).trim();
}

export type ConfigValueReference =
	| { kind: "literal"; value: string }
	| { kind: "env"; variable: string; explicit: boolean }
	| { kind: "env-or-literal"; value: string };

export const CONFIG_VALUE_LITERAL_PREFIX = "literal:";

const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ENV_NAME_CONVENTION = /^[A-Z][A-Z0-9_]*$/;

function parseExplicitEnvReference(config: string): string | null {
	if (!config.startsWith("$")) return null;
	const braced = config.startsWith("${") && config.endsWith("}");
	const name = braced ? config.slice(2, -1) : config.slice(1);
	return ENV_REFERENCE_NAME.test(name) ? name : null;
}

export function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith(CONFIG_VALUE_LITERAL_PREFIX)) {
		return { kind: "literal", value: config.slice(CONFIG_VALUE_LITERAL_PREFIX.length) };
	}
	const explicit = parseExplicitEnvReference(config);
	if (explicit !== null) return { kind: "env", variable: explicit, explicit: true };
	if (ENV_NAME_CONVENTION.test(config)) return { kind: "env", variable: config, explicit: false };
	return { kind: "env-or-literal", value: config };
}

export function describeConfigEnvReference(config: string): { variable: string; explicit: boolean } | null {
	const reference = parseConfigValueReference(config);
	return reference.kind === "env" ? { variable: reference.variable, explicit: reference.explicit } : null;
}

export type ConfigValueOutcome =
	| { ok: true; value: string }
	| { ok: false; variable: string; explicit: boolean; empty: boolean };

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

export const commandFailureReason = {
	timedOut: (timeoutMs: number): string => `it did not finish within ${timeoutMs}ms and was killed`,
	exited: (code: number | string): string => `it exited with code ${code}`,
	emptyOutput: "it succeeded but wrote nothing to stdout",
	spawnFailed: (message: string): string => `it could not be run: ${message}`,
} as const;

const COMMAND_FAILURE_RETRY_MS = 30_000;

export interface CommandResolutionPolicy {
	getCached(command: string): string | undefined;
	isBackedOff(command: string): boolean;
	generationOf(command: string): number;
	recordSuccess(command: string, value: string, atGeneration?: number): void;
	recordFailure(command: string, describedAs: string | undefined, reason: string, stderr?: string): void;
	invalidate(command: string): void;
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

export const configCommandPolicy = createCommandResolutionPolicy();

export function reportUnresolvedConfigValue(details: {
	command: string;
	describedAs?: string;
	reason: string;
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

const reportedEnvReferences = new Set<string>();

export function reportUnresolvedEnvReference(details: {
	variable: string;
	explicit: boolean;
	empty: boolean;
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

export function clearUnresolvedEnvReports(): void {
	reportedEnvReferences.clear();
}
