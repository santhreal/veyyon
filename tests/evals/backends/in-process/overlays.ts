/**
 * Overlay files for the config and prompt-variant axes, loaded and checked before a
 * trial starts.
 *
 * Prompt variants are applied per session/trial directly through session construction
 * (e.g. systemPrompt block rewriting) without mutating the process-global environment
 * or leaking across concurrent trials.
 * The id space is read from the registries at call time, and the refusal is worded by
 * the same owner the DeepSWE arm check and the agent's assembly-time refusal use, so a
 * typo is refused in the second before a run starts rather than inside a container once
 * per trial.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { PROMPT_REGISTRIES } from "@veyyon/coding-agent/prompts/all-registries";
import { describeUnknownPromptIds, errorMessage, isRecord, PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";
import YAML from "yaml";
import { knownPromptIds } from "../../engine/prompt-overrides";

/**
 * Resolves an overlay file path against workDir if relative, falling back to process cwd.
 */
export async function resolveOverlayPath(filePath: string, workDir?: string): Promise<string> {
	if (path.isAbsolute(filePath)) {
		return filePath;
	}
	if (workDir) {
		const inWorkDir = path.resolve(workDir, filePath);
		try {
			await fs.stat(inWorkDir);
			return inWorkDir;
		} catch {
			// Fall back to cwd resolution
		}
	}
	return path.resolve(filePath);
}

/**
 * Traverses a parsed config overlay and collects every unknown setting path.
 */
export function findUnknownConfigKeys(
	config: unknown,
	isKnownPath: (path: string) => boolean = isSettingPath,
): string[] {
	const unknown: string[] = [];
	const walk = (node: unknown, prefix: string): void => {
		if (!isRecord(node)) {
			if (prefix !== "" && !isKnownPath(prefix)) {
				unknown.push(prefix);
			}
			return;
		}
		const entries = Object.entries(node);
		if (entries.length === 0) {
			if (prefix !== "" && !isKnownPath(prefix)) {
				unknown.push(prefix);
			}
			return;
		}
		for (const [key, value] of entries) {
			const currentPath = prefix === "" ? key : `${prefix}.${key}`;
			if (isKnownPath(currentPath)) {
				continue;
			}
			walk(value, currentPath);
		}
	};
	walk(config, "");
	return unknown.sort();
}

export interface LoadedConfigOverlay {
	readonly resolvedPath: string;
	readonly parsed: Record<string, unknown>;
}

/**
 * Loads, parses, and validates a config overlay file.
 * Fails loud if the file is missing, malformed, or contains unknown setting keys.
 */
export async function loadAndValidateConfigOverlay(configPath: string, workDir?: string): Promise<LoadedConfigOverlay> {
	const resolvedPath = await resolveOverlayPath(configPath, workDir);
	let content: string;
	try {
		content = await fs.readFile(resolvedPath, "utf-8");
	} catch {
		throw new Error(`Config overlay file not found: ${resolvedPath}`);
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse config overlay ${resolvedPath}: ${errorMessage(error)}`);
	}

	if (parsed === null || parsed === undefined) {
		return { resolvedPath, parsed: {} };
	}

	if (!isRecord(parsed)) {
		throw new Error(`Config overlay file "${resolvedPath}" must be a YAML mapping of setting -> value`);
	}

	const unknownKeys = findUnknownConfigKeys(parsed, isSettingPath);
	if (unknownKeys.length > 0) {
		throw new Error(`Config overlay file "${resolvedPath}" names unknown setting key(s): ${unknownKeys.join(", ")}`);
	}

	return { resolvedPath, parsed };
}

export interface LoadedPromptOverlay {
	readonly resolvedPath: string;
	readonly overrides: Record<string, string>;
}

/**
 * Loads, parses, and validates a prompt variant overlay file.
 * Fails loud if the file is missing, malformed, non-string, or names unknown prompt IDs.
 */
export async function loadAndValidatePromptOverlay(
	promptVariantPath: string,
	workDir?: string,
): Promise<LoadedPromptOverlay> {
	const resolvedPath = await resolveOverlayPath(promptVariantPath, workDir);
	let content: string;
	try {
		content = await fs.readFile(resolvedPath, "utf-8");
	} catch {
		throw new Error(`Prompt overlay file not found: ${resolvedPath}`);
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse prompt overlay ${resolvedPath}: ${errorMessage(error)}`);
	}

	if (parsed === null || parsed === undefined) {
		return { resolvedPath, overrides: {} };
	}

	if (!isRecord(parsed)) {
		throw new Error(`Prompt overlay file "${resolvedPath}" must be a YAML mapping of prompt id -> replacement text`);
	}
	const validatedOverrides: Record<string, string> = {};
	for (const [id, val] of Object.entries(parsed)) {
		if (typeof val !== "string") {
			throw new Error(`Prompt overlay file "${resolvedPath}" value for "${id}" must be a string, got ${typeof val}`);
		}
		validatedOverrides[id] = val;
	}

	const known = knownPromptIds();
	const unknownIds = Object.keys(validatedOverrides).filter(id => !known.includes(id));
	if (unknownIds.length > 0) {
		// The words come from the owner of this refusal (`@veyyon/utils`), which the
		// DeepSWE arm check and the agent's own assembly-time refusal also use: one
		// operator mistake must not produce three differently worded answers. Only the
		// subject differs, because the subject IS different — an overlay file on the
		// prompt-variant axis, named in full so it can be opened.
		throw new Error(
			`Prompt overlay file "${resolvedPath}" names ${unknownIds.length} prompt id(s) that no registry holds:\n` +
				`${describeUnknownPromptIds(unknownIds, known)}\n` +
				`${PROMPT_ID_SHAPE_HINT}\n` +
				`Fix: run \`veyyon prompt --prompts\` to list all ${known.length} ids, or drop the key.`,
		);
	}

	return { resolvedPath, overrides: validatedOverrides };
}

/**
 * Applies prompt overrides to system prompt blocks by replacing the base text of overridden prompt IDs
 * with their replacement text, without mutating global process environment variables.
 */
export function applyPromptOverridesToSystemPrompt(
	promptBlocks: readonly string[],
	overrides: Readonly<Record<string, string>>,
): string[] {
	if (Object.keys(overrides).length === 0) {
		return [...promptBlocks];
	}

	return promptBlocks.map(block => {
		let updated = block;
		for (const [id, replacement] of Object.entries(overrides)) {
			const registry = PROMPT_REGISTRIES.find(r => r.has(id));
			const originalText = registry?.prompts[id]?.text;
			if (originalText) {
				const trimmedOriginal = originalText.trim();
				const trimmedReplacement = replacement.trim();
				if (trimmedOriginal.length > 0 && updated.includes(trimmedOriginal)) {
					updated = updated.replaceAll(trimmedOriginal, trimmedReplacement);
				} else if (updated.includes(originalText)) {
					updated = updated.replaceAll(originalText, replacement);
				}
			}
		}
		return updated;
	});
}
