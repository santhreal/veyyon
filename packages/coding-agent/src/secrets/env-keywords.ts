/**
 * Which environment variable NAMES are treated as holding a credential.
 *
 * TIER B DATA, NOT A LITERAL. The keyword list used to be a regex written inline in
 * `secrets/index.ts`, which meant a user whose credential variable was not detected had no way to
 * say so short of editing the source. It lives in `env-keywords.yml` now, bundled and embedded, and
 * a user file adds to it.
 *
 * THE BOUNDARY RULE IS THE WHOLE DESIGN, and it is why this list can stay short. A keyword matches
 * only where it ENDS the name or is followed by an underscore:
 *
 *     DEPLOY_TOKEN   detected        TOKENIZER         not detected
 *     API_KEY        detected        SECRETIVE_THING   not detected
 *     KEY_FILE       detected        AUTHORIZED_USER   not detected
 *
 * The exclusions are correct, not collateral damage: a substring match would obfuscate the value of
 * `AUTHORIZED_USER` and blank out fragments of ordinary prose wherever that value appeared. The
 * trailing-position half of the rule also means `APIKEY`, `PRIVKEY` and `SECRETKEY` need no entry of
 * their own, because `KEY` at the end of a name already matches them. That was worth measuring
 * rather than assuming: three of the five candidates originally filed for this list were already
 * covered, one (`PASSPHRASE`) was a real gap, and one (`PWD`) had to be refused.
 *
 * ADD-ONLY FOR USERS. A user file contributes keywords and cannot remove one. Letting a project
 * file switch off detection of `TOKEN` would let a repository quietly turn off protection for
 * everyone who opens it, which is the wrong direction for a security control to be configurable in.
 */
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

/**
 * Keywords shipped with veyyon.
 *
 * Parsed once at module load from the embedded file. Embedded with `with { type: "text" }` rather
 * than read from disk so it survives `bun build --compile`, matching how `builtin-rules` ships its
 * data.
 */
export const BUNDLED_ENV_KEYWORDS: readonly string[] = parseKeywords(bundledYaml, "the bundled keyword list");

/**
 * Turn a keyword list into the matcher.
 *
 * ONE OWNER FOR THE BOUNDARY RULE. Every caller gets its pattern from here, so there is no second
 * place where a keyword could be matched as a substring. Keywords are escaped even though the
 * bundled ones need no escaping, because a user file is arbitrary text and a keyword of `A.B` must
 * match `A.B` rather than acting as a pattern.
 */
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
	const escaped = [...normalized].map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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

/**
 * Load the keyword list: the bundled one, plus anything the operator added.
 *
 * A MISSING USER FILE IS EMPTY; AN UNREADABLE ONE IS AN ERROR, the same asymmetry the `secrets.yml`
 * loader uses and for the same reason. Nothing was declared when the file does not exist. Every
 * other failure means the operator wrote keywords this process could not read, and carrying on would
 * detect fewer variables than they believe are covered, silently.
 */
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
				`Refusing to start: ${filePath} exists but could not be read (${String(error)}). ` +
					`Fix the file's permissions or remove it. Continuing without it would leave every variable ` +
					`its keywords cover undetected.`,
			);
		}
		for (const keyword of parseKeywords(text, filePath)) keywords.add(keyword);
	}
	return [...keywords];
}
