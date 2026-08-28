/** Which environment variable NAMES are treated as holding a credential. TIER B DATA, NOT A LITERAL. The keyword list used to be a regex written inline in */
import * as path from "node:path";
import { CONFIG_DIR_NAME, isEnoent, isRecord } from "@veyyon/utils";
import { errorMessage } from "@veyyon/utils/type-guards";
import { parse as parseYaml } from "yaml";
import bundledYaml from "./env-keywords.yml" with { type: "text" };

/** Filename a user drops to extend the list. */
export const ENV_KEYWORDS_FILENAME = "secret-env-keywords.yml";

/** The shape of the data file: one key, a list of uppercase words. */
interface EnvKeywordsFile {
	keywords?: unknown;
}

const ENV_KEYWORDS_FILE_FIELDS: Readonly<Record<string, true>> = {
	keywords: true,
};

/** Keywords shipped with veyyon. Parsed once at module load from the embedded file. Embedded with `with { type: "text" }` rather */
export const BUNDLED_ENV_KEYWORDS: readonly string[] = parseKeywords(bundledYaml, "the bundled keyword list");

/** Turn a keyword list into the matcher. ONE OWNER FOR THE BOUNDARY RULE. Every caller gets its pattern from here, so there is no second */
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
		// Matches nothing, rather than an empty alternation that matches everything. An empty
		// keyword list means "detect nothing", and the catastrophic reading of it is "detect every
		// variable", which would send every environment value through the obfuscator.
		return /(?!)/;
	}
	const escaped = Array.from(normalized).map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`(?:${escaped.join("|")})(?:_|$)`, "i");
}

/** Parse one data file, refusing anything that is not a list of usable keywords. */
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

/** Load the keyword list: the bundled one, plus anything the operator added. A MISSING USER FILE IS EMPTY; AN UNREADABLE ONE IS AN ERROR, the same asymmetry the `secrets.yml` */
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
