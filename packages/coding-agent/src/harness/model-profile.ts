import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@veyyon/ai/types";
import { errorMessage, getAgentDir, isMissingPath, isRecord, logger, once } from "@veyyon/utils";
import { YAML } from "bun";
import type { Settings } from "../config/settings";
import { type PromptSectionName, promptSectionNames } from "../system-prompt-builder/prompt-sections";
import { applyHarnessToolAllowlist } from "../tools/loading";

export interface HarnessModelProfile {
	repair?: boolean;
	tools?: readonly string[];
	promptSectionOrder?: readonly PromptSectionName[];
}

type HarnessProfilesRecord = Record<string, HarnessModelProfile>;

let cachedAgentDir: string | undefined;
let cachedFileProfiles: HarnessProfilesRecord | undefined;

export function resetHarnessProfileFileCache(): void {
	cachedAgentDir = undefined;
	cachedFileProfiles = undefined;
}

const knownPromptSectionNames: () => ReadonlySet<string> = once(() => new Set(promptSectionNames()));

function normalizePromptSectionOrder(value: unknown): readonly PromptSectionName[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const order: PromptSectionName[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !knownPromptSectionNames().has(entry)) {
			logger.warn(
				`harness profile promptSectionOrder has unknown section ${JSON.stringify(entry)} ` +
					`(valid: ${promptSectionNames().join(", ")}); ignoring the list`,
			);
			return undefined;
		}
		if (!order.includes(entry as PromptSectionName)) order.push(entry as PromptSectionName);
	}
	return order.length > 0 ? order : undefined;
}

function normalizeToolAllowlist(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) {
			logger.warn(
				`harness profile tools has an entry that is not a tool name (${JSON.stringify(entry)}); ignoring the list`,
			);
			return undefined;
		}
		names.push(entry);
	}
	return names.length > 0 ? names : undefined;
}

function normalizeProfileEntry(value: unknown): HarnessModelProfile | undefined {
	if (!isRecord(value)) return undefined;
	const repair = typeof value.repair === "boolean" ? value.repair : undefined;
	const tools = normalizeToolAllowlist(value.tools);
	const promptSectionOrder = normalizePromptSectionOrder(value.promptSectionOrder);
	if (repair === undefined && (!tools || tools.length === 0) && !promptSectionOrder) return undefined;
	return {
		...(repair !== undefined ? { repair } : {}),
		...(tools && tools.length > 0 ? { tools } : {}),
		...(promptSectionOrder ? { promptSectionOrder } : {}),
	};
}

function normalizeProfilesRecord(raw: unknown): HarnessProfilesRecord {
	if (!isRecord(raw)) return {};
	const profiles: HarnessProfilesRecord = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof key !== "string" || key.length === 0) continue;
		const entry = normalizeProfileEntry(value);
		if (entry) profiles[key] = entry;
	}
	return profiles;
}

function loadHarnessProfilesFile(agentDir: string): HarnessProfilesRecord {
	const filePath = path.join(agentDir, "harness-profiles.yml");
	try {
		const text = fs.readFileSync(filePath, "utf8");
		const parsed = YAML.parse(text) as unknown;
		if (isRecord(parsed) && isRecord(parsed.profiles)) {
			return normalizeProfilesRecord(parsed.profiles);
		}
		return normalizeProfilesRecord(parsed);
	} catch (error) {
		if (isMissingPath(error)) return {};
		logger.warn("harness-profiles.yml could not be read; no per-model harness profiles are in effect", {
			path: filePath,
			error: errorMessage(error),
		});
		return {};
	}
}

function mergedProfiles(settings: Settings): HarnessProfilesRecord {
	const fromSettings = normalizeProfilesRecord(settings.get("harness.profiles"));
	const agentDir = getAgentDir();
	if (cachedAgentDir !== agentDir) {
		cachedAgentDir = agentDir;
		cachedFileProfiles = loadHarnessProfilesFile(agentDir);
	}
	return { ...cachedFileProfiles, ...fromSettings };
}

function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function profileMatchesKey(key: string, modelKeyValue: string): boolean {
	if (key === modelKeyValue) return true;
	if (key.endsWith("/*")) {
		const prefix = key.slice(0, -1);
		return modelKeyValue.startsWith(prefix);
	}
	return false;
}

export function resolveHarnessProfileForModel(
	settings: Settings,
	model: Model | undefined,
): HarnessModelProfile | undefined {
	if (!model) return undefined;
	const profiles = mergedProfiles(settings);
	const key = modelKey(model);
	let match: HarnessModelProfile | undefined;
	for (const [profileKey, profile] of Object.entries(profiles)) {
		if (!profileMatchesKey(profileKey, key)) continue;
		match = match ? { ...match, ...profile } : { ...profile };
	}
	return match;
}

export function isRepairEnabledForModel(settings: Settings, model: Model | undefined): boolean {
	const profile = resolveHarnessProfileForModel(settings, model);
	if (profile?.repair === false) return false;
	return true;
}

export function resolvePromptSectionOrderForModel(
	settings: Settings,
	model: Model | undefined,
): readonly PromptSectionName[] | undefined {
	return resolveHarnessProfileForModel(settings, model)?.promptSectionOrder;
}

export function filterToolsByHarnessProfile(
	toolNames: readonly string[],
	settings: Settings,
	model: Model | undefined,
): string[] {
	return applyHarnessToolAllowlist(toolNames, resolveHarnessProfileForModel(settings, model)?.tools);
}
