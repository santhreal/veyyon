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

/** Fields the human-authored `secrets.yml` schema understands. */
const SECRET_FILE_FIELDS: Readonly<Record<string, true>> = {
	type: true,
	content: true,
	mode: true,
	replacement: true,
	flags: true,
	minLength: true,
};

/** The ceiling on a refusal about this file, and the reason there is one. Every refusal below collects EVERY problem before throwing, which is deliberate: an operator with */
const MAX_ECHOED_PATTERN_CHARS = 120;
const MAX_PROBLEM_CHARS = 400;
const MAX_REPORTED_PROBLEMS = 20;

/** Quote at most `maxChars` of `value`, marking the cut so a truncated pattern cannot be mistaken for the whole one. Never splits a surrogate pair, so the result is always well-formed UTF-16. */
function boundedQuote(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const end = maxChars - 1;
	const first = value.charCodeAt(end - 1);
	const cut = first >= 0xd800 && first <= 0xdbff ? end - 1 : end;
	return `${value.slice(0, cut)}…`;
}

/** The indented complaint block, bounded in both directions, with the withheld count STATED. Printing the first twenty silently would tell an operator with 5,000 malformed entries that they */
function formatProblems(problems: readonly string[]): string {
	const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).map(line => `  - ${boundedQuote(line, MAX_PROBLEM_CHARS)}`);
	const withheld = problems.length - shown.length;
	// NOT the `  - ` complaint prefix: this line is a count of what was withheld, and reading as a
	// twenty-first complaint would put a fabricated entry in a list of the operator's real ones.
	if (withheld > 0) shown.push(`  …and ${withheld} more entries not listed here.`);
	return shown.join("\n");
}

export {
	buildExpansionRecord,
	decodeLog,
	encodeRecord,
	MAX_RECORD_BYTES,
	placeholdersIn,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	type SecretExpansionRecord,
	secretAuditPath,
} from "./audit";

export {
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./obfuscator";
export {
	canObfuscatePlainValue,
	describeSecretRejection,
	MIN_AUTODETECTED_ENV_VALUE_LENGTH,
	MIN_OBFUSCATABLE_LENGTH,
	type SecretRejection,
	type SecretRejectionReason,
	secretCharacterLength,
} from "./policy";

/** Load secrets from the project's and the active profile's secrets.yml files. Project entries override profile entries with matching content. */
export async function loadSecrets(cwd: string, agentDir: string): Promise<SecretEntry[]> {
	const projectPath = path.join(cwd, CONFIG_DIR_NAME, "secrets.yml");
	const profilePath = path.join(agentDir, "secrets.yml");

	const profileEntries = await loadSecretsFile(profilePath);
	const projectEntries = await loadSecretsFile(projectPath);

	const merged = mergeSecretEntries(profileEntries, projectEntries);
	refuseUnprotectableEntries(merged, { profilePath, projectPath });
	return merged;
}

/** Project entries override profile ones with matching content. */
function mergeSecretEntries(profileEntries: SecretEntry[], projectEntries: SecretEntry[]): SecretEntry[] {
	if (profileEntries.length === 0) return projectEntries;
	if (projectEntries.length === 0) return profileEntries;

	const projectContents = new Set(projectEntries.map(e => e.content));
	return profileEntries.filter(e => !projectContents.has(e.content)).concat(projectEntries);
}

/** Refuse to start with a declared secret that cannot be obfuscated. Fail closed, because the alternative is worse than not having the feature: the */
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

/** Collect environment variable values that look like secrets. Nothing here is declared, so nothing here can be refused: the length floor is part of */
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
		// NO `name`, and that is deliberate: nothing declared this value, so nothing may spend it as
		// `#NAME#`. `source` is the label a person needs to find it, which is the half that was
		// missing — the footer counted these and no command could say what they were.
		entries.push({ type: "plain", content: value, mode: "obfuscate", origin: "environment", source: name });
	}
	return entries;
}

const BUNDLED_ENV_SECRET_PATTERN = buildEnvSecretPattern(BUNDLED_ENV_KEYWORDS);

/** Read one `secrets.yml`. A MISSING FILE IS EMPTY; AN UNREADABLE ONE IS AN ERROR. Nothing was declared when the */
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
			// Supplied here, never read from the file. See `validateEntry`.
			origin: "config",
			// The file it was declared in, so a masked value with no name is still findable. A
			// declared entry carries no name either (the schema has no such field), so without this
			// the only report a person could get was a count.
			source: filePath,
		});
	}
	if (problems.length > 0) {
		// EVERY problem in the file, not the first one. An operator with three typos should fix
		// three typos and restart once, rather than discovering them one restart at a time.
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

/** Check one declared entry, collecting what is wrong with it rather than deciding what to do. REFUSES, AND DOES NOT SKIP. Every branch here used to be `logger.warn` followed by */
function validateEntry(entry: unknown, index: number, problems: string[]): entry is Omit<SecretEntry, "origin"> {
	const at = `entry ${index}`;
	// `isRecord` from the shared owner rather than the same three clauses written out again. Its definition rejects null, non-objects and arrays alike, so this is a rename and not a behaviour
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
		// The offending content is NOT quoted back: on a plain entry it is the credential, and an
		// error message is the one place a secret must never appear even when it is malformed.
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
		// A floor on a plain entry would be read as "protect this even though it is short", which is not what it does: plain entries are matched literally, so the only rule
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
			// A pattern that cannot be scanned safely protects nothing, so the operator declared a
			// class of secret and got no coverage for it. Patterns are not secret, so the message
			// quotes it; plain secret values still never reach this branch.
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
