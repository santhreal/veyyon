import * as path from "node:path";
import { CONFIG_DIR_NAME, errorMessage, isEnoent, isRecord } from "@veyyon/utils";
import { parse as parseYaml } from "yaml";
import { BUNDLED_ENV_KEYWORDS, buildEnvSecretPattern } from "./env-keywords";
import type { SecretEntry } from "./obfuscator";
import {
	canObfuscatePlainValue,
	describeSecretRejection,
	MIN_AUTODETECTED_ENV_VALUE_LENGTH,
	secretCharacterLength,
} from "./policy";
import { compileSecretRegex } from "./regex";

const SECRET_FILE_FIELDS: Readonly<Record<string, true>> = {
	type: true,
	content: true,
	mode: true,
	replacement: true,
	flags: true,
	minLength: true,
};

const MAX_ECHOED_PATTERN_CHARS = 120;
const MAX_PROBLEM_CHARS = 400;
const MAX_REPORTED_PROBLEMS = 20;

function boundedQuote(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const end = maxChars - 1;
	const first = value.charCodeAt(end - 1);
	const cut = first >= 0xd800 && first <= 0xdbff ? end - 1 : end;
	return `${value.slice(0, cut)}…`;
}

function formatProblems(problems: readonly string[]): string {
	const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).map(line => `  - ${boundedQuote(line, MAX_PROBLEM_CHARS)}`);
	const withheld = problems.length - shown.length;
	if (withheld > 0) shown.push(`  …and ${withheld} more entries not listed here.`);
	return shown.join("\n");
}

export async function loadSecrets(cwd: string, agentDir: string): Promise<SecretEntry[]> {
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "secrets.yml");
	const profilePath = path.join(agentDir, "secrets.yml");

	const profileEntries = await loadSecretsFile(profilePath);
	const projectEntries = await loadSecretsFile(projectPath);

	const merged = mergeSecretEntries(profileEntries, projectEntries);
	refuseUnprotectableEntries(merged, { profilePath, projectPath });
	return merged;
}

function mergeSecretEntries(profileEntries: SecretEntry[], projectEntries: SecretEntry[]): SecretEntry[] {
	if (profileEntries.length === 0) return projectEntries;
	if (projectEntries.length === 0) return profileEntries;

	const projectContents = new Set(projectEntries.map(e => e.content));
	return profileEntries.filter(e => !projectContents.has(e.content)).concat(projectEntries);
}

function refuseUnprotectableEntries(entries: SecretEntry[], paths: { profilePath: string; projectPath: string }): void {
	const unprotectable = entries
		.map((entry, index) => ({ entry, index }))
		.filter(
			({ entry }) =>
				entry.type === "plain" &&
				(entry.mode ?? "obfuscate") === "obfuscate" &&
				!canObfuscatePlainValue(entry.content),
		);
	if (unprotectable.length === 0) return;

	const complaints = unprotectable.map(({ index, entry }) =>
		describeSecretRejection({
			reason: "too-short-to-obfuscate",
			index,
			length: secretCharacterLength(entry.content),
		}),
	);
	throw new Error(
		`Refusing to start: ${unprotectable.length} declared secret(s) cannot be obfuscated, and starting anyway ` +
			`would send them to the model provider in plain text.\n` +
			`Checked ${paths.projectPath} and ${paths.profilePath}.\n` +
			formatProblems(complaints),
	);
}

export function collectEnvSecrets(pattern: RegExp = BUNDLED_ENV_SECRET_PATTERN): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || secretCharacterLength(value) < MIN_AUTODETECTED_ENV_VALUE_LENGTH) continue;
		pattern.lastIndex = 0;
		const nameMatches = pattern.test(name);
		pattern.lastIndex = 0;
		if (!nameMatches) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ type: "plain", content: value, mode: "obfuscate", origin: "environment", source: name });
	}
	return entries;
}

const BUNDLED_ENV_SECRET_PATTERN = buildEnvSecretPattern(BUNDLED_ENV_KEYWORDS);

async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw new Error(
			`Refusing to start: ${filePath} exists but could not be read (${errorMessage(err)}). ` +
				`Fix the file's permissions or remove it. Continuing without it would leave every secret ` +
				`it declares unprotected.`,
		);
	}

	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (err) {
		throw new Error(
			`Refusing to start: ${filePath} is not valid YAML (${errorMessage(err).split("\n", 1)[0]}). ` +
				`Fix the syntax or remove the file. Its declarations cannot be honoured while it does not parse.`,
		);
	}
	if (!Array.isArray(raw)) {
		throw new Error(
			`Refusing to start: ${filePath} must be a YAML array of secret entries, ` +
				`and is ${raw === null ? "null" : typeof raw}. See docs/handbook/src/architecture/secrets.md for the schema.`,
		);
	}

	const entries: SecretEntry[] = [];
	const problems: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (!validateEntry(entry, i, problems)) continue;
		entries.push({
			type: entry.type,
			content: entry.content,
			mode: entry.mode ?? "obfuscate",
			replacement: entry.replacement,
			flags: entry.flags,
			minLength: entry.minLength,
			origin: "config",
			source: filePath,
		});
	}
	if (problems.length > 0) {
		throw new Error(
			`Refusing to start: ${problems.length} entr${problems.length === 1 ? "y" : "ies"} in ${filePath} ` +
				`${problems.length === 1 ? "is" : "are"} not a valid secret declaration, and skipping ` +
				`${problems.length === 1 ? "it" : "them"} would leave the value${problems.length === 1 ? "" : "s"} ` +
				`${problems.length === 1 ? "it declares" : "they declare"} unprotected.\n` +
				formatProblems(problems),
		);
	}
	return entries;
}

function validateEntry(entry: unknown, index: number, problems: string[]): entry is Omit<SecretEntry, "origin"> {
	const at = `entry ${index}`;
	if (!isRecord(entry)) {
		problems.push(
			`${at} is ${entry === null ? "null" : Array.isArray(entry) ? "an array" : typeof entry}, and must be a mapping with "type" and "content".`,
		);
		return false;
	}
	const e = entry as Record<string, unknown>;
	const unknownFields = Object.keys(e).filter(field => SECRET_FILE_FIELDS[field] !== true);
	if (unknownFields.length > 0) {
		problems.push(
			`${at} has unknown ${unknownFields.length === 1 ? "field" : "fields"} ` +
				`${unknownFields.map(field => JSON.stringify(field)).join(", ")}. Allowed fields are ` +
				`${Object.keys(SECRET_FILE_FIELDS)
					.map(field => JSON.stringify(field))
					.join(", ")}.`,
		);
		return false;
	}
	if (e.type !== "plain" && e.type !== "regex") {
		problems.push(
			`${at} has type ${JSON.stringify(e.type ?? null)}, which must be "plain" (an exact value) or ` +
				`"regex" (a pattern).`,
		);
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		problems.push(`${at} needs a non-empty "content", the value or pattern to protect.`);
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		problems.push(
			`${at} has mode ${JSON.stringify(e.mode)}, which must be "obfuscate" (reversible, the default) ` +
				`or "replace" (one-way).`,
		);
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		problems.push(`${at} has a non-string "replacement". It is the text that stands in for the value.`);
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		problems.push(`${at} has non-string "flags". Regex flags are a string such as "i".`);
		return false;
	}
	if (e.replacement !== undefined && e.mode !== "replace") {
		problems.push(`${at} sets "replacement", which applies only when "mode" is "replace".`);
		return false;
	}
	if (e.flags !== undefined && e.type !== "regex") {
		problems.push(`${at} sets "flags", which applies to regex entries only.`);
		return false;
	}
	if (e.minLength !== undefined) {
		if (typeof e.minLength !== "number" || !Number.isInteger(e.minLength) || e.minLength < 1) {
			problems.push(
				`${at} has minLength ${JSON.stringify(e.minLength)}, which must be a whole number of 1 or more.`,
			);
			return false;
		}
		if (e.type === "plain") {
			problems.push(
				`${at} sets minLength, which applies to regex entries only. A short plain secret needs ` +
					`"mode: replace", which is one-way and has no minimum.`,
			);
			return false;
		}
		if (e.mode === "replace") {
			problems.push(
				`${at} sets minLength in "replace" mode, where every regex match is replaced and no length floor applies.`,
			);
			return false;
		}
	}
	if (e.type === "regex") {
		try {
			compileSecretRegex(e.content, e.flags as string | undefined);
		} catch (error) {
			problems.push(
				`${at} is a regex that does not compile or cannot be scanned safely ` +
					`(${boundedQuote(errorMessage(error), MAX_ECHOED_PATTERN_CHARS)}). ` +
					`Pattern: ${boundedQuote(e.content, MAX_ECHOED_PATTERN_CHARS)}. ` +
					`Every secret it was meant to match is unprotected until it is fixed or removed.`,
			);
			return false;
		}
	}
	return true;
}
