import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getProjectDir, isEnoent, logger } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";

export const NONE_PERSONALITY = "none";

export const DEFAULT_PERSONALITY_NAME = "default";

export const BUILTIN_PERSONALITIES: Readonly<Record<string, string>> = {
	default: sessionPrompts["session/personalities/default"].text.trim(),
	friendly: sessionPrompts["session/personalities/friendly"].text.trim(),
	pragmatic: sessionPrompts["session/personalities/pragmatic"].text.trim(),
};

export const BUILTIN_PERSONALITY_DESCRIPTIONS: Readonly<Record<string, string>> = {
	default: "Terse, evidence-first engineer; dense, action-oriented replies",
	friendly: "Warm, encouraging collaborator focused on momentum and morale",
	pragmatic: "Direct, efficient engineer focused on clarity and rigor",
};

function resolveHomeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getUserPersonalitiesDir(): string {
	return path.join(resolveHomeDir(), CONFIG_DIR_NAME, "personalities");
}

export function getProjectPersonalitiesDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME, "personalities");
}

async function readPersonalityDir(dir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Could not read personalities directory", { dir, error: String(error) });
		}
		return result;
	}

	for (const entry of entries) {
		if (!entry.toLowerCase().endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		if (name.toLowerCase() === NONE_PERSONALITY) continue;

		const filePath = path.join(dir, entry);
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf-8");
		} catch (error) {
			logger.warn("Could not read personality file", { path: filePath, error: String(error) });
			continue;
		}

		const trimmed = content.trim();
		if (!trimmed) {
			logger.warn("Ignoring empty personality file", { path: filePath });
			continue;
		}
		result.set(name, trimmed);
	}

	return result;
}

export interface PersonalityCatalogOptions {
	cwd?: string;
}

interface PersonalityTiers {
	project: Map<string, string>;
	user: Map<string, string>;
}

async function loadTiers(options: PersonalityCatalogOptions): Promise<PersonalityTiers> {
	const cwd = options.cwd ?? getProjectDir();
	const [project, user] = await Promise.all([
		readPersonalityDir(getProjectPersonalitiesDir(cwd)),
		readPersonalityDir(getUserPersonalitiesDir()),
	]);
	return { project, user };
}

function resolveFromTiers(name: string, tiers: PersonalityTiers): string | undefined {
	if (tiers.project.has(name)) return tiers.project.get(name);
	if (tiers.user.has(name)) return tiers.user.get(name);
	return Object.hasOwn(BUILTIN_PERSONALITIES, name) ? BUILTIN_PERSONALITIES[name] : undefined;
}

function availableNames(tiers: PersonalityTiers): string[] {
	const names = new Set<string>(Object.keys(BUILTIN_PERSONALITIES));
	for (const name of tiers.user.keys()) names.add(name);
	for (const name of tiers.project.keys()) names.add(name);
	return Array.from(names).sort((a, b) => a.localeCompare(b));
}

const STRUCTURAL_TAG_RE = /<\/?[a-zA-Z][\w.:-]*(?:\s[^<>]*)?>/g;

const PERSONALITY_TAG_RE = /<\s*\/?\s*personality\s*>/gi;

function escapeAngleBrackets(tag: string): string {
	return tag.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeStructuralTags(text: string): string {
	return text.replace(STRUCTURAL_TAG_RE, escapeAngleBrackets).replace(PERSONALITY_TAG_RE, escapeAngleBrackets);
}

export const MAX_PERSONALITY_CHARS = 4000;

interface BoundedPersonalityText {
	text: string;
	warning?: string;
}

function boundPersonalityText(name: string, rawText: string): BoundedPersonalityText {
	const sanitized = escapeStructuralTags(rawText);
	if (sanitized.length <= MAX_PERSONALITY_CHARS) return { text: sanitized };

	const warning = `Personality "${name}" spec is ${sanitized.length} chars, exceeding the ${MAX_PERSONALITY_CHARS}-char budget; truncated to avoid inflating every request's prompt.`;
	logger.warn("Personality spec exceeded size budget; truncated", {
		name,
		chars: sanitized.length,
		limit: MAX_PERSONALITY_CHARS,
	});
	return { text: `${sanitized.slice(0, MAX_PERSONALITY_CHARS).trimEnd()}\n[...truncated]`, warning };
}

export async function resolveAvailablePersonalities(options: PersonalityCatalogOptions = {}): Promise<string[]> {
	return availableNames(await loadTiers(options));
}

export interface ResolvedPersonality {
	name: string;
	text: string;
	warning?: string;
}

export async function resolvePersonality(
	requestedName: string,
	options: PersonalityCatalogOptions = {},
): Promise<ResolvedPersonality> {
	if (requestedName === NONE_PERSONALITY) {
		return { name: NONE_PERSONALITY, text: "" };
	}

	const tiers = await loadTiers(options);
	const resolved = resolveFromTiers(requestedName, tiers);
	if (resolved !== undefined) {
		const bounded = boundPersonalityText(requestedName, resolved);
		return { name: requestedName, text: bounded.text, warning: bounded.warning };
	}

	const available = availableNames(tiers);
	const warning = `Unknown personality "${requestedName}"; falling back to "${DEFAULT_PERSONALITY_NAME}". Available: ${available.join(", ")}, ${NONE_PERSONALITY}.`;
	logger.warn("Unknown personality; falling back to default", { requested: requestedName, available });
	const fallbackRaw =
		resolveFromTiers(DEFAULT_PERSONALITY_NAME, tiers) ?? BUILTIN_PERSONALITIES[DEFAULT_PERSONALITY_NAME];
	const bounded = boundPersonalityText(DEFAULT_PERSONALITY_NAME, fallbackRaw);
	const combinedWarning = bounded.warning ? `${warning} ${bounded.warning}` : warning;
	return { name: DEFAULT_PERSONALITY_NAME, text: bounded.text, warning: combinedWarning };
}
