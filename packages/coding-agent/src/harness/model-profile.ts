/**
 * Per-model harness profile overrides (A3 MVP).
 *
 * Profiles live in `harness.profiles` (config.yml) or `harness-profiles.yml` in the
 * active agent dir. Keys match `provider/model-id` or `provider/*` wildcards.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@veyyon/ai/types";
import { getAgentDir, isRecord, logger } from "@veyyon/utils";
import { YAML } from "bun";
import type { Settings } from "../config/settings";
import { PROMPT_SECTION_NAMES, type PromptSectionName } from "../prompt-sections";

export interface HarnessModelProfile {
	/** When false, schema repair is skipped for this model. Default: true. */
	repair?: boolean;
	/** When set, only these tool names are exposed to the model (MVP hint / filter). */
	tools?: readonly string[];
	/**
	 * Reorder the default system-prompt template's banner sections for this model.
	 * Names come from PROMPT_SECTION_NAMES; listed sections lead, the rest follow
	 * in template order. Unknown names are rejected at load time with a warning.
	 */
	promptSectionOrder?: readonly PromptSectionName[];
}

type HarnessProfilesRecord = Record<string, HarnessModelProfile>;

let cachedAgentDir: string | undefined;
let cachedFileProfiles: HarnessProfilesRecord | undefined;

/** Test-only: clear cached harness-profiles.yml load. */
export function resetHarnessProfileFileCache(): void {
	cachedAgentDir = undefined;
	cachedFileProfiles = undefined;
}

const PROMPT_SECTION_NAME_SET: ReadonlySet<string> = new Set(PROMPT_SECTION_NAMES);

function normalizePromptSectionOrder(value: unknown): readonly PromptSectionName[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const order: PromptSectionName[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		if (!PROMPT_SECTION_NAME_SET.has(entry)) {
			// Reject the whole list: a typo'd section silently dropped would apply a
			// different order than the operator wrote.
			logger.warn(
				`harness profile promptSectionOrder has unknown section "${entry}" (valid: ${PROMPT_SECTION_NAMES.join(", ")}); ignoring the list`,
			);
			return undefined;
		}
		if (!order.includes(entry as PromptSectionName)) order.push(entry as PromptSectionName);
	}
	return order.length > 0 ? order : undefined;
}

function normalizeProfileEntry(value: unknown): HarnessModelProfile | undefined {
	if (!isRecord(value)) return undefined;
	const repair = typeof value.repair === "boolean" ? value.repair : undefined;
	const tools = Array.isArray(value.tools)
		? value.tools.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: undefined;
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
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
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

/** Resolve the harness profile for a model, if any. */
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

/** Whether schema repair should run for this model (harness profile + env). */
export function isRepairEnabledForModel(settings: Settings, model: Model | undefined): boolean {
	const profile = resolveHarnessProfileForModel(settings, model);
	if (profile?.repair === false) return false;
	return true;
}

/** Resolve the per-model system-prompt section order, if configured. */
export function resolvePromptSectionOrderForModel(
	settings: Settings,
	model: Model | undefined,
): readonly PromptSectionName[] | undefined {
	return resolveHarnessProfileForModel(settings, model)?.promptSectionOrder;
}

/** Apply optional per-model tool allowlist from harness profile. */
export function filterToolsByHarnessProfile(
	toolNames: readonly string[],
	settings: Settings,
	model: Model | undefined,
): string[] {
	const allowlist = resolveHarnessProfileForModel(settings, model)?.tools;
	if (!allowlist || allowlist.length === 0) return [...toolNames];
	const allowed = new Set(allowlist);
	return toolNames.filter(name => allowed.has(name));
}
