import { execSync } from "node:child_process";
import type { Api, Model, ModelSpec } from "@veyyon/ai/types";
import { errorMessage, isRecord } from "@veyyon/utils";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import { isAuthenticated } from "./auth-state";
import {
	commandFailureReason,
	configCommandPolicy,
	parseConfigValueCommand,
	reportUnresolvedEnvReference,
	resolveConfigEnvReference,
} from "./config-value-resolution";

const COMMAND_TIMEOUT_MS = 10_000;

export type HeaderSource = Record<string, string> | undefined;

export interface HeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

export interface CommandApiKeyResolution {
	configured: boolean;
	value?: string;
}

export function resolveCommandConfig(command: string): string | undefined {
	const cached = configCommandPolicy.getCached(command);
	if (cached !== undefined) return cached;
	if (configCommandPolicy.isBackedOff(command)) return undefined;
	try {
		const stdout = execSync(command, {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			configCommandPolicy.recordFailure(command, undefined, commandFailureReason.emptyOutput);
			return undefined;
		}
		configCommandPolicy.recordSuccess(command, trimmed);
		return trimmed;
	} catch (error) {
		const failure = error as { status?: number; signal?: string; stderr?: Buffer | string };
		const reason =
			failure.signal === "SIGTERM"
				? commandFailureReason.timedOut(COMMAND_TIMEOUT_MS)
				: typeof failure.status === "number"
					? commandFailureReason.exited(failure.status)
					: commandFailureReason.spawnFailed(errorMessage(error));
		configCommandPolicy.recordFailure(command, undefined, reason, failure.stderr?.toString());
		return undefined;
	}
}

export function resolveConfigValue(valueConfig: string, describedAs?: string): string | undefined {
	const command = parseConfigValueCommand(valueConfig);
	if (command !== null) return resolveCommandConfig(command);
	const outcome = resolveConfigEnvReference(valueConfig);
	if (outcome.ok) return outcome.value;
	reportUnresolvedEnvReference({
		variable: outcome.variable,
		explicit: outcome.explicit,
		empty: outcome.empty,
		describedAs,
	});
	return undefined;
}

export function materializeConfigHeaderSources(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const resolved: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			const next = resolveConfigValue(value, `header "${key}"`);
			if (next) resolved[key] = next;
		}
	}
	if (options?.authHeader && options.apiKeyConfig) {
		const resolvedKey = resolveConfigValue(options.apiKeyConfig, "provider API key");
		if (resolvedKey) resolved.Authorization = `Bearer ${resolvedKey}`;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function createLiveConfigHeaders(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const liveSources = sources.filter((source): source is Record<string, string> => source !== undefined);
	if (liveSources.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;

	const localHeaders: Record<string, string> = {};
	const allSources = liveSources.concat([localHeaders]);
	const current = () => materializeConfigHeaderSources(allSources, options) ?? {};
	return new Proxy(localHeaders, {
		get(target, property, receiver) {
			if (typeof property !== "string") return Reflect.get(target, property, receiver);
			return current()[property];
		},
		set(target, property, value) {
			if (typeof property !== "string" || typeof value !== "string") return false;
			target[property] = value;
			return true;
		},
		deleteProperty(target, property) {
			if (typeof property !== "string") return false;
			delete target[property];
			return true;
		},
		has(_target, property) {
			if (typeof property !== "string") return false;
			return Object.hasOwn(current(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(current());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property !== "string") return undefined;
			const headers = current();
			if (!Object.hasOwn(headers, property)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				value: headers[property],
				writable: true,
			};
		},
	});
}

export function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	return materializeConfigHeaderSources([headers]);
}

export function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {}
	return value;
}

export function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

export function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
): string | undefined {
	const oauthCredentials = getOAuthCredentialsForProvider(authStorage, provider);
	const matchingCredential = oauthCredentials.find(credential => credential.access === accessToken);
	if (matchingCredential) {
		return matchingCredential.accountId;
	}
	if (oauthCredentials.length === 1) {
		return oauthCredentials[0].accountId;
	}
	return undefined;
}

export function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

export function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	return { ...model, compat: model.compatConfig } as ModelSpec<TApi>;
}
