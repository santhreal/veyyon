import * as path from "node:path";
import { CONFIG_DIR_NAME, isEnoent, isRecord } from "@veyyon/utils";
import { errorMessage } from "@veyyon/utils/type-guards";
import { parse as parseYaml } from "yaml";
import bundledYaml from "./env-keywords.yml" with { type: "text" };

export const ENV_KEYWORDS_FILENAME = "secret-env-keywords.yml";

interface EnvKeywordsFile {
	keywords?: unknown;
}

const ENV_KEYWORDS_FILE_FIELDS: Readonly<Record<string, true>> = {
	keywords: true,
};

export const BUNDLED_ENV_KEYWORDS: readonly string[] = parseKeywords(bundledYaml, "the bundled keyword list");

export function buildEnvSecretPattern(keywords: readonly string[]): RegExp {
	const normalized = new Set<string>();
	for (const keyword of keywords) {
		const trimmed = keyword.trim();
		if (trimmed.length === 0) {
			throw new Error("Refusing an empty environment-secret keyword, which would match every variable name.");
		}
		normalized.add(trimmed.toUpperCase());
	}
	if (normalized.size === 0) {
		return /(?!)/;
	}
	const escaped = Array.from(normalized).map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`(?:${escaped.join("|")})(?:_|$)`, "i");
}

function parseKeywords(text: string, label: string): string[] {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new Error(`Refusing to start: ${label} is not valid YAML (${errorMessage(error).split("\n", 1)[0]}).`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Refusing to start: ${label} must be a mapping with a "keywords" list.`);
	}
	const unknownFields = Object.keys(parsed).filter(field => ENV_KEYWORDS_FILE_FIELDS[field] !== true);
	if (unknownFields.length > 0) {
		throw new Error(
			`Refusing to start: ${label} has unknown ${unknownFields.length === 1 ? "field" : "fields"} ` +
				`${unknownFields.map(field => JSON.stringify(field)).join(", ")}; only "keywords" is supported.`,
		);
	}
	const keywords = (parsed as EnvKeywordsFile).keywords;
	if (!Array.isArray(keywords)) {
		throw new Error(`Refusing to start: ${label} must have a "keywords" list.`);
	}

	const result: string[] = [];
	for (const keyword of keywords) {
		if (typeof keyword !== "string" || keyword.trim().length === 0) {
			throw new Error(`Refusing to start: ${label} has a keyword that is not a non-empty string.`);
		}
		result.push(keyword.trim().toUpperCase());
	}
	return result;
}

export async function loadEnvSecretKeywords(options: { cwd: string; agentDir: string }): Promise<string[]> {
	const keywords = new Set(BUNDLED_ENV_KEYWORDS);
	for (const filePath of [
		path.join(options.agentDir, ENV_KEYWORDS_FILENAME),
		path.join(options.cwd, CONFIG_DIR_NAME, ENV_KEYWORDS_FILENAME),
	]) {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw new Error(
				`Refusing to start: ${filePath} exists but could not be read (${errorMessage(error)}). ` +
					`Fix the file's permissions or remove it. Continuing without it would leave every variable ` +
					`its keywords cover undetected.`,
			);
		}
		for (const keyword of parseKeywords(text, filePath)) keywords.add(keyword);
	}
	return Array.from(keywords);
}
