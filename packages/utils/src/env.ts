import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";
import { homeDotenvInjectedKeys } from "./dotenv-home";
import {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	parseEnvFile as parseEnvFileWithReporter,
	type UnreadableEnvFileReporter,
} from "./dotenv-parse";
import * as logger from "./logger";
import { errorMessage } from "./type-guards";

export {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	isValidEnvName,
} from "./dotenv-parse";
export * from "./worker-host";

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
): Record<string, string> {
	const result = filterProcessEnv(env);
	const launchLocalEnv = parseEnvFile(path.join(cwd, ".env.local"));
	for (const key in launchLocalEnv) {
		if (result[key] === launchLocalEnv[key]) delete result[key];
	}
	return result;
}

const reportUnreadableEnvFile: UnreadableEnvFileReporter = (filePath, error) => {
	logger.warn("Environment file exists but could not be read; none of its variables were applied.", {
		path: filePath,
		error: errorMessage(error),
	});
};

export function parseEnvFile(filePath: string): Record<string, string> {
	return parseEnvFileWithReporter(filePath, reportUnreadableEnvFile);
}

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const configRootEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

for (const file of [projectEnv, agentEnv, configRootEnv, homeEnv]) {
	for (const key in file) {
		if (isMacosMallocStackLoggingEnvName(key)) continue;
		if (Bun.env[key] && !homeDotenvInjectedKeys.has(key)) continue;
		Bun.env[key] = file[key];
		homeDotenvInjectedKeys.delete(key);
	}
}

refreshDirsFromEnv();

export const $env: Record<string, string> = Bun.env as Record<string, string>;

export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

const POSITIVE_INTEGER_RE = /^\d+$/;

export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name]?.trim();
	if (!raw) return defaultValue;
	const parsed = POSITIVE_INTEGER_RE.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(parsed) || parsed <= 0) {
		logger.warn("Environment variable is not a positive integer; using the default instead.", {
			name,
			value: raw,
			default: defaultValue,
		});
		return defaultValue;
	}
	return parsed;
}

export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

let terminalHeadless = isBunTestRuntime();

export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

export function isCompiledBinary(): boolean {
	if (process.env.VEYYON_COMPILED || Bun.env.VEYYON_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
export function $flag(name: string, def: boolean = false): boolean {
	const value = $env[name];
	if (!value) return def;
	return TRUTHY[value] === true;
}
